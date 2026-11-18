import { createHash } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import {
  chmod,
  open,
  lstat,
  mkdtemp,
  readdir,
  readlink,
  realpath,
} from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { prepareOperands, removePayload } from './copy-payload'
import { recursiveCopy } from './utils/recursive-copy'
import type { BigIntStats } from 'node:fs'
import type { Repository } from './git'
import { git } from './git'
import {
  EXECUTABLE_MODE_MASK,
  MAX_FILE_SIZE_BYTES,
  NANOSECONDS_PER_MILLISECOND,
} from './constants'
import { readManifest, settledBlobs } from './manifest'
import type { KnownBlob } from './manifest'
import { isWithin } from './utils/is-within'
import { maybeLstat } from './utils/maybe-lstat'
import {
  recordRestoredCopy,
  restoredIndexEntry,
  signature,
} from './utils/restored-copy'
import { readNulRecords } from './utils/read-nul-records'
import { metadataAlias } from './utils/metadata-alias'
import { parseStageRecord } from './utils/parse-stage-record'
import type { StageRecord } from './utils/parse-stage-record'
import {
  resolveBackupPath,
  resolveSourcePath,
} from './utils/resolve-backup-path'
import { copyPathKeys } from './utils/fold-copy-path'

export type Entry = {
  kind: 'directory' | 'file' | 'symlink' | 'special'
  /** The private copy needed owner-read to be inspected, while the original mode lacked it. */
  privateRead?: boolean
  mode: string
  oid: string
  signature: string
  /** Latest of mtime and ctime; decides whether equal metadata may later stand in for rereading the bytes. */
  changedAtNs: bigint
}
export type Source = {
  /** Source location with a canonical parent, retaining a selected leaf symlink. */
  path: string
  /** Preserved repository-relative destination root, shared by all manifest keys. */
  name: string
  entries: Map<string, Entry>
  /** Wall-clock start of the scan, the reference point for {@link settledBlobs}. */
  scannedAtNs: bigint
}

/** Hashes raw entries for {@link scanSource} and {@link copySources}, independently of Git filters.
 * @param path - Regular file or symlink, never a followed link.
 * @param stats - Entry metadata observed before reading.
 * @param repository - Supplies Git's object hash algorithm.
 * @param signal - CLI cancellation signal.
 * @param knownBlob - Settled ID from {@link readManifest} or the pre-copy scan; trusted only for an identical signature.
 * @returns The exact Git blob ID and entry mode expected in the index.
 * @example await readEntry(path, stats, repository, signal, knownBlobs.get('notes/a.md'))
 */
async function readEntry(
  path: string,
  stats: BigIntStats,
  repository: Repository,
  signal: AbortSignal,
  knownBlob?: KnownBlob,
): Promise<Entry> {
  signal.throwIfAborted()
  const marker = signature(stats)
  const changedAtNs =
    stats.mtimeNs > stats.ctimeNs ? stats.mtimeNs : stats.ctimeNs
  if (stats.isDirectory())
    return {
      kind: 'directory',
      mode: '040000',
      oid: '',
      signature: marker,
      changedAtNs,
    }
  // Never open a FIFO, socket, or device to hash it. Native cp handles the filesystem entry.
  if (!stats.isFile() && !stats.isSymbolicLink())
    return {
      kind: 'special',
      mode: (stats.mode & 0o170000n).toString(8),
      oid: '',
      signature: marker,
      changedAtNs,
    }
  if (stats.size > MAX_FILE_SIZE_BYTES)
    throw new Error(`File exceeds 100 MiB: ${JSON.stringify(path)}`)
  const kind: Entry['kind'] = stats.isSymbolicLink() ? 'symlink' : 'file'
  const mode =
    kind === 'symlink'
      ? '120000'
      : Number(stats.mode) & EXECUTABLE_MODE_MASK
        ? '100755'
        : '100644'
  // Settled entries with identical inode, size, mode, mtime, and ctime reuse the recorded ID without rereading.
  if (knownBlob?.signature === marker)
    return { kind, mode, oid: knownBlob.oid, signature: marker, changedAtNs }
  const hash = createHash(repository.objectFormat)
  if (kind === 'symlink') {
    const target = await readlink(path, { encoding: 'buffer' })
    // Reject undecodable link text instead of silently changing its bytes during copy.
    const targetText = new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: true,
    }).decode(target)
    // Git for Windows stores native link separators as '/', then restores native separators on checkout.
    const gitTarget =
      process.platform === 'win32'
        ? Buffer.from(targetText.replaceAll('\\', '/'))
        : target
    hash.update(`blob ${gitTarget.length}\0`).update(gitTarget)
  } else {
    hash.update(`blob ${stats.size}\0`)
    for await (const chunk of createReadStream(path, { signal }))
      hash.update(chunk)
  }
  if (signature(await lstat(path, { bigint: true })) !== marker)
    throw new Error(`Source changed while being read: ${JSON.stringify(path)}`)
  return { kind, mode, oid: hash.digest('hex'), signature: marker, changedAtNs }
}

/** Identifies source I/O failures for which native cp continues visiting the remaining operands.
 * @example if (isSourceReadError(error)) readErrors.push(error)
 */
export function isSourceReadError(
  error: unknown,
): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    'code' in error &&
    ['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'ELOOP', 'EIO', 'ESTALE'].includes(
      String(error.code),
    )
  )
}

/** Builds the complete source manifest before {@link backup} writes anything, excluding exact .git components.
 * Entries whose metadata matches the persisted manifest from {@link readManifest} reuse its blob IDs instead of rereading bytes.
 * @param input - One source file, directory, or symlink.
 * @param repository - Destination root and protected metadata directories.
 * @param signal - CLI cancellation signal.
 * @param destinationName - Pre-approved destination root that bypasses {@link resolveBackupPath}; callers pass it to pin the mapping.
 * @returns Canonical source parent, mapped destination root, and byte/type manifest.
 * @example await scanSource("./notes", repository, signal)
 */
export async function scanSource(
  input: string,
  repository: Repository,
  signal: AbortSignal,
  destinationName?: string,
  readErrors?: Error[],
): Promise<Source> {
  // A pre-approved mapping keeps its location as given; canonical parent aliases are not fresh CLI input.
  const mapping =
    destinationName === undefined
      ? resolveBackupPath(input)
      : { path: input, name: destinationName }
  const resolved = mapping.path
  const name = mapping.name
  if (
    name !== '.' &&
    name
      .split('/')
      .some(
        (part) => !part || part === '.' || part === '..' || metadataAlias(part),
      )
  )
    throw new Error(`Invalid destination path: ${JSON.stringify(name)}`)
  const path = await resolveSourcePath(resolved)
  if (
    isWithin(repository.directory, path) ||
    isWithin(path, repository.directory) ||
    [repository.gitDirectory, repository.commonDirectory].some(
      (metadata) => isWithin(metadata, path) || isWithin(path, metadata),
    )
  ) {
    throw new Error(
      'Source and destination/metadata directories must not overlap.',
    )
  }
  const scannedAtNs = BigInt(Date.now()) * NANOSECONDS_PER_MILLISECOND
  const knownBlobs = await readManifest(repository, path, name)
  const entries = await walkSource(
    path,
    name,
    repository,
    signal,
    knownBlobs,
    readErrors,
  )
  return {
    path,
    name,
    entries,
    scannedAtNs,
  }
}

/** Walks one source tree for {@link scanSource} and the {@link copySources} stability rescan, excluding exact .git components.
 * @param path - Canonical source location.
 * @param name - Repository-relative destination root used as the key prefix.
 * @param repository - Supplies Git's object hash algorithm.
 * @param signal - CLI cancellation signal.
 * @param knownBlobs - Settled IDs reused for entries whose signature is unchanged; others are reread.
 * @returns Every entry keyed by destination path, parents before their children.
 * @example await walkSource('/home/me/notes', 'notes', repository, signal, new Map()) // => Map { 'notes' => {...}, 'notes/a.md' => {...} }
 */
async function walkSource(
  path: string,
  name: string,
  repository: Repository,
  signal: AbortSignal,
  knownBlobs: ReadonlyMap<string, KnownBlob>,
  readErrors?: Error[],
  allowed?: (key: string) => Promise<boolean>,
): Promise<Map<string, Entry>> {
  const entries = new Map<string, Entry>()
  const visit = async (
    absolutePath: string,
    relativePath: string,
  ): Promise<void> => {
    signal.throwIfAborted()
    if (allowed && !(await allowed(relativePath)))
      throw new Error(
        `Unexpected entry in private copy: ${JSON.stringify(relativePath)}`,
      )
    let stats = await lstat(absolutePath, { bigint: true })
    // A group-readable source can become an owner-unreadable private copy after ownership changes.
    const privateRead = Boolean(
      allowed &&
      process.platform !== 'win32' &&
      stats.isFile() &&
      !(stats.mode & 0o400n),
    )
    if (privateRead) {
      await chmod(absolutePath, Number(stats.mode & 0o7777n) | 0o400)
      stats = await lstat(absolutePath, { bigint: true })
    }
    const entry = await readEntry(
      absolutePath,
      stats,
      repository,
      signal,
      knownBlobs.get(relativePath),
    )
    if (privateRead) entry.privateRead = true
    entries.set(relativePath, entry)
    if (!stats.isDirectory()) return
    // Plain buffer names: each child is lstat-ed by visit, and Bun's buffer Dirents carry no name.
    for (const childBytes of await readdir(absolutePath, {
      encoding: 'buffer',
    })) {
      const childName = new TextDecoder('utf-8', {
        fatal: true,
        ignoreBOM: true,
      }).decode(childBytes)
      // Ordinary .git is excluded; aliases reject the entire operation before any copy.
      if (childName === '.git' && !allowed) continue
      if (metadataAlias(childName))
        throw new Error(
          `Git metadata alias in source: ${JSON.stringify(childName)}`,
        )
      await visitReadable(
        join(absolutePath, childName),
        relativePath === '.' ? childName : `${relativePath}/${childName}`,
      )
    }
  }
  // Keep successfully visited siblings in input order when a native read would fail locally.
  const visitReadable = async (
    absolute: string,
    key: string,
  ): Promise<void> => {
    try {
      await visit(absolute, key)
    } catch (error) {
      if (!readErrors || !isSourceReadError(error)) throw error
      readErrors.push(error)
    }
  }
  await visitReadable(path, name)
  return entries
}

/** Lists the ordered parents needed by {@link validateDestination} and {@link copySources} without selecting siblings.
 * @param path - Slash-separated destination key.
 * @returns Ancestors from the clone root toward the selected entry.
 * @example destinationAncestors('cooking/recipes/a.txt') // => ['cooking', 'cooking/recipes']
 */
function destinationAncestors(path: string): string[] {
  const components = path.split('/')
  return components
    .slice(0, -1)
    .map((_, index) => components.slice(0, index + 1).join('/'))
}

/** Checks actual protected directory spellings before destination traversal or inode enumeration.
 * @example await isAdministrativePath(destination, repository, fold)
 */
async function isAdministrativePath(
  path: string,
  repository: Repository,
  fold: (path: string) => Promise<string>,
): Promise<boolean> {
  const payload = relative(repository.directory, path).split(sep).join('/')
  for (const root of [repository.commonDirectory, repository.gitDirectory]) {
    if (isWithin(root, repository.directory)) return true
    if (!isWithin(repository.directory, root)) continue
    const admin = relative(repository.directory, root).split(sep).join('/')
    const depth = admin.split('/').length
    // Compare only through the protected root. Never open naming probes within Git's administrative tree.
    if (
      (await fold(payload.split('/').slice(0, depth).join('/'))) ===
      (await fold(admin))
    )
      return true
  }
  return false
}

/** Resolves the referent of a destination link, including a missing leaf, before cp may write through it.
 * @example await destinationReferent('shortcut', repository, incomingLinks, linksInOperand, fold)
 */
async function destinationReferent(
  path: string,
  repository: Repository,
  incomingLinks: ReadonlyMap<string, string>,
  linksInOperand: ReadonlySet<string>,
  fold: (path: string) => Promise<string>,
): Promise<string> {
  const pending = path.split('/')
  const components: string[] = []
  let followed = 0
  const escape = () =>
    new Error(
      `Destination entry type conflicts: link escapes the backup or aliases Git metadata: ${JSON.stringify(path)}`,
    )
  // Resolve component by component: normalizing '..' before expanding a symlink can select a different file.
  while (pending.length) {
    const part = pending.shift()!
    if (!part || part === '.') continue
    if (part === '..') {
      if (!components.pop()) throw escape()
      continue
    }
    if (metadataAlias(part)) throw escape()
    const key = [...components, part].join('/')
    const target = join(repository.directory, key)
    if (await isAdministrativePath(target, repository, fold)) throw escape()
    // cp and readdir can visit siblings in different orders. Both possible link targets must stay isolated.
    if (linksInOperand.has(await fold(key)))
      throw new Error(
        `Copy would write through a link replaced within the same source: ${JSON.stringify(key)}`,
      )
    let link = incomingLinks.get(await fold(key))
    if (link === undefined && (await maybeLstat(target))?.isSymbolicLink())
      link = await readlink(target)
    if (link === undefined) {
      components.push(part)
      continue
    }
    if (++followed > 40)
      throw new Error(`Destination symlink cycle: ${JSON.stringify(path)}`)
    if (isAbsolute(link)) {
      const parts = link.split(sep === '\\' ? /[\\/]/ : '/')
      const depth = repository.directory.split(sep).length
      const prefix = parts.slice(0, depth).join(sep)
      if (prefix !== repository.directory) {
        // Alternate spellings of the root must identify the real repository directory before dropping the prefix.
        const [original, candidate] = await Promise.all([
          lstat(repository.directory, { bigint: true }),
          maybeLstat(prefix),
        ])
        if (
          !candidate?.isDirectory() ||
          original.dev !== candidate.dev ||
          original.ino !== candidate.ino
        )
          throw escape()
      }
      link = parts.slice(depth).join(sep)
      components.length = 0
    }
    pending.unshift(...link.split(sep === '\\' ? /[\\/]/ : '/'))
  }
  return components.join('/')
}

/** Finds every alias which cp will modify in place, rejecting an inode with links outside the writable payload.
 * @example await hardlinkNames(stats, repository, signal)
 */
async function hardlinkNames(
  target: BigIntStats,
  repository: Repository,
  signal: AbortSignal,
  fold: (path: string) => Promise<string>,
): Promise<string[]> {
  const aliases: string[] = []
  const visit = async (directory: string): Promise<void> => {
    for (const child of await readdir(directory, { withFileTypes: true })) {
      signal.throwIfAborted()
      if (metadataAlias(child.name)) continue
      const absolute = join(directory, child.name)
      // Excluding administrative roots makes an alias into metadata fail the link-count check.
      if (await isAdministrativePath(absolute, repository, fold)) continue
      if (child.isDirectory()) await visit(absolute)
      else if (child.isFile()) {
        const stats = await lstat(absolute, { bigint: true })
        if (stats.dev === target.dev && stats.ino === target.ino)
          aliases.push(
            relative(repository.directory, absolute).split(sep).join('/'),
          )
      }
    }
  }
  await visit(repository.directory)
  if (BigInt(aliases.length) !== target.nlink)
    throw new Error(
      `Destination hardlink also points outside the backup payload: ${JSON.stringify(aliases[0])}`,
    )
  return aliases
}

/** Checks Git-specific boundaries for {@link copySources} and identifies the files cp can actually change.
 * @example const files = await validateDestination([source], repository, signal)
 */
export async function validateDestination(
  sources: readonly Source[],
  repository: Repository,
  signal: AbortSignal,
  addedRead = new Set<string>(),
): Promise<Map<string, Entry>> {
  if ((await realpath(repository.directory)) !== repository.directory)
    throw new Error('Destination parent changed or escaped the repository.')
  const names = copyPathKeys(repository.directory)
  try {
    return await planDestination(
      sources,
      repository,
      signal,
      addedRead,
      names.key,
    )
  } finally {
    await names.close()
  }
}

/** Models ordered native writes and maps each selected entry onto its Git index spelling. */
async function planDestination(
  sources: readonly Source[],
  repository: Repository,
  signal: AbortSignal,
  addedRead: Set<string>,
  fold: (path: string) => Promise<string>,
): Promise<Map<string, Entry>> {
  const files = new Map<string, Entry>()
  const restrictedTargets = new Map<string, BigIntStats>()
  const spellings = new Map<string, string>()
  // New aliases share a physical leaf on folding volumes, even before Git has indexed a spelling.
  const setFile = async (path: string, entry: Entry) => {
    let physical = ''
    for (const component of path.split('/')) {
      const prefix = physical ? physical + '/' + component : component
      const key = await fold(prefix)
      physical = spellings.get(key) ?? prefix
      spellings.set(key, physical)
    }
    const firstWrite = !files.has(physical)
    files.set(physical, entry)
    if (entry.kind !== 'file') addedRead.delete(physical)
    return firstWrite ? physical : undefined
  }
  const plannedEntry = async (path: string) =>
    files.get(spellings.get(await fold(path)) ?? path)
  const directories = new Set<string>()
  const incomingLinks = new Map<string, string>()
  const hardlinks = new Map<string, string[]>()
  const detachedAliases = new Set<string>()
  for (const source of sources) {
    const linksInOperand = new Set<string>()
    for (const [key, entry] of source.entries) {
      if (entry.kind !== 'symlink') continue
      const destination = join(repository.directory, key)
      if (await isAdministrativePath(destination, repository, fold))
        throw new Error(
          `Destination escapes the backup or aliases Git metadata: ${JSON.stringify(destination)}`,
        )
      linksInOperand.add(await fold(key))
    }
    for (const [key, entry] of source.entries) {
      signal.throwIfAborted()
      if (key === '.') continue
      // BSD cp emits a diagnostic and skips sockets. GNU cp recreates their filesystem nodes.
      if (
        process.platform === 'darwin' &&
        entry.kind === 'special' &&
        entry.mode === '140000'
      )
        continue
      let path = key
      for (const parent of destinationAncestors(key)) {
        if (
          linksInOperand.has(await fold(parent)) ||
          incomingLinks.has(await fold(parent)) ||
          (
            await maybeLstat(join(repository.directory, parent))
          )?.isSymbolicLink()
        ) {
          const physical = await destinationReferent(
            parent,
            repository,
            incomingLinks,
            linksInOperand,
            fold,
          )
          path = [physical, key.slice(parent.length + 1)]
            .filter(Boolean)
            .join('/')
        }
      }
      const destination = join(repository.directory, path)
      if (await isAdministrativePath(destination, repository, fold))
        throw new Error(
          `Destination escapes the backup or aliases Git metadata: ${JSON.stringify(destination)}`,
        )
      if (entry.kind === 'directory') {
        directories.add(path)
        // Even an empty directory operand must not operate on metadata through a destination alias.
        if (
          (await maybeLstat(destination))?.isSymbolicLink() ||
          incomingLinks.has(await fold(path))
        )
          await destinationReferent(
            path,
            repository,
            incomingLinks,
            linksInOperand,
            fold,
          )
        continue
      }
      const existing = await maybeLstat(destination)
      // A regular source writes through a destination link. A source symlink replaces the leaf itself.
      if (entry.kind === 'symlink') {
        const suffix = source.name === '.' ? key : relative(source.name, key)
        incomingLinks.set(
          await fold(path),
          await readlink(join(source.path, suffix)),
        )
      }
      if (
        entry.kind === 'file' &&
        (await plannedEntry(path))?.mode !== '10000' &&
        (linksInOperand.has(await fold(path)) ||
          incomingLinks.has(await fold(path)) ||
          existing?.isSymbolicLink())
      )
        path = await destinationReferent(
          path,
          repository,
          incomingLinks,
          linksInOperand,
          fold,
        )
      const target =
        path === key
          ? existing
          : await maybeLstat(join(repository.directory, path))
      // Opening a destination FIFO for writing would block the clone lock until an unrelated reader connects.
      const previous = await plannedEntry(path)
      if (
        entry.kind === 'file' &&
        (previous ? previous.mode === '10000' : target?.isFIFO())
      )
        throw new Error(
          `Cannot copy a regular file into a destination FIFO: ${JSON.stringify(path)}`,
        )
      const firstWrite = await setFile(path, entry)
      if (firstWrite && entry.privateRead && !target) addedRead.add(firstWrite)
      if (firstWrite && target?.isFile() && !(target.mode & 0o400n))
        restrictedTargets.set(firstWrite, target)
      // Replacing a leaf removes that name from its original inode before later operands run.
      if (entry.kind !== 'file' && target?.isFile() && target.nlink > 1n)
        detachedAliases.add(await fold(path))
      if (entry.kind === 'file' && target?.isFile() && target.nlink > 1n) {
        // Writing this inode also writes every other hardlink. Prove all its names are inside the clone.
        const id = `${target.dev}:${target.ino}`
        let aliases = hardlinks.get(id)
        if (!aliases) {
          aliases = await hardlinkNames(target, repository, signal, fold)
          hardlinks.set(id, aliases)
        }
        for (const alias of aliases) {
          if (!detachedAliases.has(await fold(alias)))
            await setFile(alias, entry)
        }
      }
    }
  }
  const selected = new Set<string>()
  const trackedSpellings = new Map<string, string>()
  for (const path of [...directories, ...files.keys()]) {
    for (const required of [...destinationAncestors(path), path])
      selected.add(await fold(required))
  }
  await git(repository.directory, ['ls-files', '-v', '--stage', '-z'], signal, {
    consume: async (output) => {
      for await (const record of readNulRecords(output)) {
        const { path, mode } = parseStageRecord(record.slice(2))
        let selectedPath = false
        // A submodule or a hidden index change must never be overwritten by a payload copy.
        for (const prefix of [...destinationAncestors(path), path]) {
          const key = await fold(prefix)
          // Every selected ancestor is present, so deeper unrelated names never need a filesystem lookup.
          if (!selected.has(key)) break
          if (path === prefix) selectedPath = true
          const known = trackedSpellings.get(key)
          if (
            (known && known !== prefix) ||
            (mode === '160000' && path === prefix)
          )
            throw new Error(
              `Tracked path collision or submodule: ${JSON.stringify(path)}`,
            )
          trackedSpellings.set(key, prefix)
        }
        if (
          selectedPath &&
          (record[0] === 'S' || record[0] !== record[0]?.toUpperCase())
        )
          throw new Error(
            `Selected path has skip-worktree or assume-unchanged set: ${JSON.stringify(path)}`,
          )
      }
    },
  })
  // Reuse Git's existing spelling for a directory or file that the destination volume folds.
  const mapped = new Map<string, Entry>()
  for (const [path, entry] of files) {
    let key = path
    for (const prefix of [...destinationAncestors(path), path]) {
      const tracked = trackedSpellings.get(await fold(prefix))
      if (tracked) key = tracked + path.slice(prefix.length)
    }
    if (key !== path && addedRead.delete(path)) addedRead.add(key)
    const restricted = restrictedTargets.get(path)
    if (
      entry.kind === 'file' &&
      restricted &&
      (await restoredIndexEntry(repository, key, restricted))
    )
      addedRead.add(key)
    mapped.set(key, entry)
  }
  return mapped
}

/** Restores native owner-read permissions after Git has finished reading newly created payload files.
 * {@link backup} also calls this on failure, before releasing the repository lock.
 * @example await restoreCopiedModes(repository, addedRead)
 */
export async function restoreCopiedModes(
  repository: Repository,
  addedRead: Set<string>,
  verified?: ReadonlyMap<string, Entry>,
): Promise<void> {
  for (const key of addedRead) {
    const path = join(repository.directory, key)
    const stats = await maybeLstat(path)
    if (stats?.isFile() && stats.mode & 0o400n) {
      const handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      )
      try {
        const current = await handle.stat({ bigint: true })
        if (
          current.ino !== stats.ino ||
          current.dev !== stats.dev ||
          !current.isFile()
        )
          throw new Error(
            `Copied entry changed before restoring permissions: ${JSON.stringify(key)}`,
          )
        await handle.chmod(Number(current.mode & 0o7377n))
        const entry = verified?.get(key)
        if (entry) {
          // The descriptor remains readable after chmod. Bind the final stat to the exact staged bytes.
          const restored = await handle.stat({ bigint: true })
          const hash = createHash(repository.objectFormat).update(
            `blob ${restored.size}\0`,
          )
          for await (const chunk of handle.createReadStream({
            autoClose: false,
          }))
            hash.update(chunk)
          if (
            entry.signature !== signature(current) ||
            entry.oid !== hash.digest('hex') ||
            signature(restored) !==
              signature(await handle.stat({ bigint: true }))
          )
            throw new Error(
              `Copied entry changed before recording permissions: ${JSON.stringify(key)}`,
            )
          await recordRestoredCopy(
            repository,
            key,
            restored,
            entry.mode,
            entry.oid,
          )
        }
      } finally {
        await handle.close()
      }
    }
    addedRead.delete(key)
  }
}

/** Copies verified private operands with native cp, then checks the resulting files before staging.
 * @param readErrors - Ordinary source failures reported after the readable parts have been copied.
 * @example const files = await copySources([source], repository, signal)
 */
export async function copySources(
  sources: readonly Source[],
  repository: Repository,
  signal: AbortSignal,
  readErrors: Error[] = [],
  readableUntilStaged?: Set<string>,
): Promise<Map<string, Entry>> {
  if ((await realpath(repository.directory)) !== repository.directory)
    throw new Error('Destination parent changed or escaped the repository.')
  const scratch = await mkdtemp(
    join(repository.gitDirectory, 'laststance-backup-payload-'),
  )
  const addedRead = readableUntilStaged ?? new Set<string>()
  try {
    // The scratch tree, including any spelling probes, is removed by the existing outer finally.
    const fold = copyPathKeys(scratch, true).key
    const prepared = await prepareOperands(sources, scratch, signal, fold)
    const operands: string[] = []
    const verified: Source[] = []
    for (const [index, source] of prepared.sources.entries()) {
      // Case-sensitive sources can contribute more than one name to a single physical output.
      const expected = new Map<string, Entry[]>()
      for (const [key, entry] of source.entries) {
        if (process.platform === 'darwin' && entry.mode === '140000') continue
        const identity = await fold(key)
        const candidates = expected.get(identity) ?? []
        candidates.push(entry)
        expected.set(identity, candidates)
      }
      if (!expected.size) continue
      const copied = await walkSource(
        source.path,
        source.name,
        repository,
        signal,
        new Map(),
        readErrors.length ? readErrors : undefined,
        async (key) => expected.has(await fold(key)),
      )
      const seen = new Set<string>()
      for (const [key, entry] of copied) {
        const identity = await fold(key)
        if (
          !expected
            .get(identity)
            ?.some(
              (item) =>
                item.kind === entry.kind &&
                item.oid === entry.oid &&
                (entry.kind !== 'special' || item.mode === entry.mode),
            )
        )
          throw new Error(`Copied content changed: ${JSON.stringify(key)}`)
        seen.add(identity)
      }
      if (seen.size !== expected.size)
        throw new Error(
          'Source entries changed during copying. Nothing was pushed.',
        )
      verified.push({ ...source, entries: copied })
      operands.push(prepared.operands[index]!)
    }
    // All paths and link texts consumed by destination validation now come from the private tree.
    const files = await validateDestination(
      verified,
      repository,
      signal,
      addedRead,
    )
    if (operands.length)
      await recursiveCopy(operands, repository.directory, signal, prepared.cwd)
    if (readErrors.length)
      throw new Error(readErrors.map((error) => error.message).join('\n'))

    for (const [key, entry] of files) {
      const path = join(repository.directory, key)
      let stats = await lstat(path, { bigint: true })
      // A repeat copy may overwrite an owner-writable file whose native mode still prevents verification.
      if (
        addedRead.has(key) &&
        entry.kind === 'file' &&
        stats.isFile() &&
        !(stats.mode & 0o400n)
      ) {
        const handle = await open(
          path,
          constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        )
        try {
          const current = await handle.stat({ bigint: true })
          if (signature(current) !== signature(stats))
            throw new Error(`Copied entry changed: ${JSON.stringify(key)}`)
          await handle.chmod(Number(current.mode & 0o7777n) | 0o400)
          stats = await handle.stat({ bigint: true })
        } finally {
          await handle.close()
        }
      }
      const copied = await readEntry(path, stats, repository, signal)
      if (
        copied.oid !== entry.oid ||
        copied.kind !== entry.kind ||
        (entry.kind === 'special' && entry.mode !== copied.mode)
      )
        throw new Error(`Copied content changed: ${JSON.stringify(key)}`)
      // cp preserves an existing file's permissions. Stage the resulting mode, including the process umask.
      files.set(key, copied)
    }
    for (const source of sources) {
      const after = await walkSource(
        source.path,
        source.name,
        repository,
        signal,
        settledBlobs(source),
      )
      if (after.size !== source.entries.size)
        throw new Error(
          'Source entries changed during copying. Nothing was pushed.',
        )
      for (const [path, before] of source.entries) {
        const current = after.get(path)
        if (
          !current ||
          current.signature !== before.signature ||
          current.oid !== before.oid
        )
          throw new Error(
            `Source changed during copying: ${JSON.stringify(path)}. Nothing was pushed.`,
          )
      }
    }
    return files
  } finally {
    try {
      if (!readableUntilStaged) await restoreCopiedModes(repository, addedRead)
    } finally {
      await removePayload(scratch)
    }
  }
}

/** Streams exact selected paths into Git and checks staged blob IDs/types for {@link backup} before commit.
 * Paths already staged with the expected blob ID and mode are not re-added, but every selected path is still verified.
 * @param selected - Verified destination bytes and modes returned by {@link copySources}.
 * @param repository - Destination working tree after copying.
 * @param signal - CLI cancellation signal.
 * @returns Whether selected content differs from HEAD.
 * @example await stageSource(files, repository, signal)
 */
export async function stageSource(
  selected: Map<string, Entry>,
  repository: Repository,
  signal: AbortSignal,
): Promise<boolean> {
  const files = new Map(
    [...selected].filter(([, entry]) => entry.kind !== 'special'),
  )
  const special = [...selected].filter(([, entry]) => entry.kind === 'special')
  if (special.length) {
    // If cp replaced a tracked file with a special node, remove only the obsolete Git blob.
    await git(
      repository.directory,
      ['update-index', '--force-remove', '-z', '--stdin'],
      signal,
      {
        input: special.map(([path]) => path + '\0'),
      },
    )
  }
  if (files.size) {
    const indexedBlobs = new Map<string, StageRecord>()
    await git(repository.directory, ['ls-files', '--stage', '-z'], signal, {
      consume: async (output) => {
        for await (const record of readNulRecords(output)) {
          const indexed = parseStageRecord(record)
          if (files.has(indexed.path)) indexedBlobs.set(indexed.path, indexed)
        }
      },
    })
    const fileMode = await git(
      repository.directory,
      ['config', '--bool', '--default', 'true', 'core.fileMode'],
      signal,
    )
    // Git retains tracked modes and gives new files 100644 when filesystem executable bits are ignored.
    if (fileMode.stdout.trim() === 'false') {
      for (const [path, entry] of files) {
        if (entry.kind !== 'file') continue
        const indexedMode = indexedBlobs.get(path)?.mode
        files.set(path, {
          ...entry,
          mode:
            indexedMode === '100644' || indexedMode === '100755'
              ? indexedMode
              : '100644',
        })
      }
    }
    // Add only paths whose staged blob or mode differs: Git's pathspec matching grows with the path count.
    const unstagedPaths = [...files]
      .filter(([path, entry]) => {
        const indexed = indexedBlobs.get(path)
        return indexed?.oid !== entry.oid || indexed.mode !== entry.mode
      })
      .map(([path]) => path)
    // --renormalize forces Git to reread tracked bytes even on a coarse Windows stat tick.
    for (const tracked of [false, true]) {
      const paths = unstagedPaths.filter(
        (path) => indexedBlobs.has(path) === tracked,
      )
      if (!paths.length) continue
      await git(
        repository.directory,
        [
          'add',
          '--force',
          ...(tracked ? ['--renormalize'] : []),
          '--pathspec-from-file=-',
          '--pathspec-file-nul',
        ],
        signal,
        {
          input: (function* () {
            for (const path of paths) yield `${path}\0`
          })(),
        },
      )
    }
  }
  let matched = 0
  await git(repository.directory, ['ls-files', '--stage', '-z'], signal, {
    consume: async (output) => {
      for await (const record of readNulRecords(output)) {
        const { mode, oid, stage, path } = parseStageRecord(record)
        const entry = files.get(path)
        if (!entry) continue
        if (mode !== entry.mode || oid !== entry.oid || stage !== '0') {
          throw new Error(
            `Git changed the selected bytes or entry type: ${JSON.stringify(path)}. Inspect .gitattributes, filters, and index flags; nothing was pushed.`,
          )
        }
        selected.set(path, entry)
        matched++
      }
    },
  })
  if (matched !== files.size)
    throw new Error(
      'Git did not stage every selected file. Nothing was pushed.',
    )
  let changed = false
  await git(
    repository.directory,
    ['diff', '--cached', '--name-only', '--no-renames', '-z'],
    signal,
    {
      consume: async (output) => {
        for await (const path of readNulRecords(output)) {
          if (!selected.has(path))
            throw new Error(
              `Unselected staged change detected: ${JSON.stringify(path)}. Nothing was pushed.`,
            )
          changed = true
        }
      },
    },
  )
  return changed
}
