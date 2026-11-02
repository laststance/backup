import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readlink,
  realpath,
  unlink,
} from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
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
import { readNulRecords } from './utils/read-nul-records'
import { metadataAlias } from './utils/metadata-alias'
import { parseStageRecord } from './utils/parse-stage-record'
import type { StageRecord } from './utils/parse-stage-record'
import { resolveBackupPath } from './utils/resolve-backup-path'

export type Entry = {
  kind: 'directory' | 'file' | 'symlink'
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

/** Captures metadata for {@link scanSource} to detect replacement or writes while bytes are read.
 * @param stats - Non-following, nanosecond-resolution entry metadata.
 * @returns A stable identity/change marker for this scan.
 * @example signature(await lstat(path, { bigint: true }))
 */
function signature(stats: BigIntStats): string {
  return [
    stats.dev,
    stats.ino,
    stats.size,
    stats.mode,
    stats.mtimeNs,
    stats.ctimeNs,
  ].join(':')
}

/** Hashes raw entries for {@link scanSource} and {@link copySource}, independently of Git filters.
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
  if (!stats.isFile() && !stats.isSymbolicLink())
    throw new Error(`Unsupported filesystem entry: ${JSON.stringify(path)}`)
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
): Promise<Source> {
  // A pre-approved mapping keeps its location as given; canonical parent aliases are not fresh CLI input.
  const mapping =
    destinationName === undefined
      ? resolveBackupPath(input)
      : { path: input, name: destinationName }
  const resolved = mapping.path
  const name = mapping.name
  // A pre-approved mapping is kept as given, while still rejecting invalid internal keys.
  if (
    name
      .split('/')
      .some(
        (part) => !part || part === '.' || part === '..' || metadataAlias(part),
      )
  )
    throw new Error(`Invalid destination path: ${JSON.stringify(name)}`)
  const path = join(await realpath(dirname(resolved)), basename(resolved))
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
  const entries = await walkSource(path, name, repository, signal, knownBlobs)
  return { path, name, entries, scannedAtNs }
}

/** Walks one source tree for {@link scanSource} and the {@link copySource} stability rescan, excluding exact .git components.
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
): Promise<Map<string, Entry>> {
  const entries = new Map<string, Entry>()
  const visit = async (
    absolutePath: string,
    relativePath: string,
  ): Promise<void> => {
    signal.throwIfAborted()
    const stats = await lstat(absolutePath, { bigint: true })
    entries.set(
      relativePath,
      await readEntry(
        absolutePath,
        stats,
        repository,
        signal,
        knownBlobs.get(relativePath),
      ),
    )
    if (!stats.isDirectory()) return
    for (const child of await readdir(absolutePath, {
      encoding: 'buffer',
      withFileTypes: true,
    })) {
      const childName = new TextDecoder('utf-8', {
        fatal: true,
        ignoreBOM: true,
      }).decode(child.name)
      // Ordinary .git is excluded; aliases reject the entire operation before any copy.
      if (childName === '.git') continue
      if (metadataAlias(childName))
        throw new Error(
          `Git metadata alias in source: ${JSON.stringify(childName)}`,
        )
      await visit(join(absolutePath, childName), `${relativePath}/${childName}`)
    }
  }
  await visit(path, name)
  return entries
}

/** Lists the ordered parents needed by {@link validateDestination} and {@link copySource} without selecting siblings.
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

/** Checks an existing directory without following a link for destination preflight and copy-time parent rechecks.
 * @param path - Repository-relative directory key.
 * @param repository - Destination root and protected metadata locations.
 * @returns Whether the directory already exists.
 * @throws When the directory aliases metadata, escapes the clone, or is a file or symlink.
 * @example await checkDestinationDirectory('cooking', repository)
 */
async function checkDestinationDirectory(
  path: string,
  repository: Repository,
): Promise<boolean> {
  const destination = join(repository.directory, ...path.split('/'))
  const stats = await maybeLstat(destination)
  if (!stats) return false
  // lstat rejects links even when they point back into the clone.
  if (!stats.isDirectory())
    throw new Error(
      `Destination entry type conflicts or parent changed: ${JSON.stringify(path)}`,
    )
  const canonical = await realpath(destination)
  if (
    !isWithin(repository.directory, canonical) ||
    [repository.gitDirectory, repository.commonDirectory].some((metadata) =>
      isWithin(metadata, canonical),
    )
  )
    throw new Error(
      `Destination aliases protected metadata or escapes the repository: ${JSON.stringify(path)}`,
    )
  return true
}

/** Validates the whole destination after fetch and before {@link copySource}, preventing partial conflict writes.
 * @param source - Complete source manifest.
 * @param repository - Locked destination working tree.
 * @param signal - CLI cancellation signal.
 * @returns Resolves only when all selected paths and their required parents can be merged safely.
 * @example await validateDestination(source, repository, signal)
 */
export async function validateDestination(
  source: Source,
  repository: Repository,
  signal: AbortSignal,
): Promise<void> {
  const upperMetadata = await maybeLstat(join(repository.directory, '.GIT'))
  const lowerMetadata = await lstat(join(repository.directory, '.git'), {
    bigint: true,
  })
  const caseInsensitive =
    upperMetadata?.ino === lowerMetadata.ino &&
    upperMetadata?.dev === lowerMetadata.dev
  const canonicalKey = (path: string) =>
    caseInsensitive ? path.normalize('NFC').toLowerCase() : path
  const selected = new Map<string, string>()
  const required = new Map<string, { path: string; kind: Entry['kind'] }>()
  const paths = [
    ...destinationAncestors(source.name).map(
      (path) => [path, { kind: 'directory' as const }] as const,
    ),
    ...source.entries,
  ]
  for (const [path, entry] of paths) {
    signal.throwIfAborted()
    const key = canonicalKey(path)
    const collision = required.get(key)
    if (collision && collision.path !== path)
      throw new Error(
        `Source paths collide on this filesystem: ${JSON.stringify(collision.path)}, ${JSON.stringify(path)}`,
      )
    required.set(key, { path, kind: entry.kind })
    if (source.entries.has(path)) selected.set(key, path)
    // Parent directories are checked before descendants, so lstat never traverses an unchecked ancestor.
    if (entry.kind === 'directory') {
      await checkDestinationDirectory(path, repository)
      continue
    }
    const destination = join(repository.directory, ...path.split('/'))
    const stats = await maybeLstat(destination)
    if (!stats) continue
    if (entry.kind === 'symlink' ? !stats.isSymbolicLink() : !stats.isFile())
      throw new Error(
        `Destination entry type conflicts: ${JSON.stringify(path)}. No files were copied.`,
      )
    // Selected leaf symlinks remain valid; copying preserves the link itself.
    if (!stats.isSymbolicLink()) {
      const canonical = await realpath(destination)
      if (
        !isWithin(repository.directory, canonical) ||
        [repository.gitDirectory, repository.commonDirectory].some((metadata) =>
          isWithin(metadata, canonical),
        )
      )
        throw new Error(
          `Destination aliases protected metadata or escapes the repository: ${JSON.stringify(path)}`,
        )
    }
  }
  await git(repository.directory, ['ls-files', '--stage', '-z'], signal, {
    consume: async (output) => {
      for await (const record of readNulRecords(output)) {
        const { mode, path } = parseStageRecord(record)
        // Every tracked prefix participates, including parents of unrelated tracked siblings.
        for (const prefix of [...destinationAncestors(path), path]) {
          const target = required.get(canonicalKey(prefix))
          if (!target) continue
          if (
            target.path !== prefix ||
            (prefix !== path && target.kind !== 'directory') ||
            (prefix === path &&
              (mode === '160000' || target.kind === 'directory'))
          )
            throw new Error(
              `Tracked path collision or submodule: ${JSON.stringify(path)}`,
            )
        }
      }
    },
  })
  await git(repository.directory, ['ls-files', '-v', '-z'], signal, {
    consume: async (output) => {
      for await (const record of readNulRecords(output)) {
        // Flags on unselected siblings do not prevent creating their shared parent.
        if (
          selected.has(canonicalKey(record.slice(2))) &&
          (record[0] === 'S' || record[0] !== record[0]?.toUpperCase())
        )
          throw new Error(
            `Selected path has skip-worktree or assume-unchanged set: ${JSON.stringify(record.slice(2))}. Clear the flag and retry.`,
          )
      }
    },
  })
}

/** Creates and rechecks each destination parent for {@link copySource} without traversing symlinks.
 * @param path - Selected repository-relative destination key.
 * @param repository - Preflighted destination clone.
 * @param signal - CLI cancellation signal.
 * @example await prepareDestinationParents('cooking/recipes/a.txt', repository, signal)
 */
async function prepareDestinationParents(
  path: string,
  repository: Repository,
  signal: AbortSignal,
): Promise<void> {
  for (const ancestor of destinationAncestors(path)) {
    signal.throwIfAborted()
    if (await checkDestinationDirectory(ancestor, repository)) continue
    // Create one component at a time; recursive mkdir could follow a substituted link.
    try {
      await mkdir(join(repository.directory, ...ancestor.split('/')))
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'EEXIST'
      ))
        throw error
    }
    await checkDestinationDirectory(ancestor, repository)
  }
}

/** Rejects a clone root replaced after preflight, before {@link copySource} reads its index or writes beneath it.
 * @param path - Selected destination key named in the error.
 * @param repository - Clone whose canonical root was resolved at startup.
 * @returns Resolves only while the root path still resolves to itself.
 * @throws When the root became a symlink or now resolves elsewhere.
 * @example await assertCloneRoot('cooking/too.txt', repository)
 */
async function assertCloneRoot(
  path: string,
  repository: Repository,
): Promise<void> {
  if ((await realpath(repository.directory)) !== repository.directory)
    throw new Error(
      `Destination parent changed or escaped the repository: ${JSON.stringify(path)}`,
    )
}

/** Reads the index entries under the selected root so {@link copySource} and {@link stageSource} leave already-backed-up files untouched.
 * @param source - Manifest whose destination root limits the listing.
 * @param repository - Clean, locked destination clone.
 * @param signal - CLI cancellation signal.
 * @returns Unconflicted (stage 0) index records of selected paths, keyed by path.
 * @example (await readIndexedBlobs(source, repository, signal)).get('notes/a.md') // => { mode: '100644', oid: '...', stage: '0', path: 'notes/a.md' }
 */
async function readIndexedBlobs(
  source: Source,
  repository: Repository,
  signal: AbortSignal,
): Promise<Map<string, StageRecord>> {
  const indexedBlobs = new Map<string, StageRecord>()
  await git(
    repository.directory,
    ['ls-files', '--stage', '-z', '--', source.name],
    signal,
    {
      consume: async (output) => {
        for await (const record of readNulRecords(output)) {
          const indexed = parseStageRecord(record)
          if (indexed.stage === '0' && source.entries.has(indexed.path))
            indexedBlobs.set(indexed.path, indexed)
        }
      },
    },
  )
  return indexedBlobs
}

/** Merge-copies preflighted entries for {@link backup} and proves both source stability and copied bytes.
 * Files and symlinks already staged with the same blob ID and mode are skipped; {@link stageSource} still verifies them.
 * @param source - Manifest checked before the first write.
 * @param repository - Clean, locked repository with validated destination paths.
 * @param signal - CLI cancellation signal.
 * @returns Resolves after the source and copied payload still match the original manifest.
 * @example await copySource(source, repository, signal)
 */
export async function copySource(
  source: Source,
  repository: Repository,
  signal: AbortSignal,
): Promise<void> {
  // Read the index only from the validated clone, never from a directory substituted at its path.
  await assertCloneRoot(source.name, repository)
  const indexedBlobs = await readIndexedBlobs(source, repository, signal)
  for (const [path, entry] of source.entries) {
    signal.throwIfAborted()
    // Manifest destinations are not source paths: only the suffix below the selected root belongs to the origin.
    if (path !== source.name && !path.startsWith(`${source.name}/`))
      throw new Error(
        `Source manifest entry is outside its destination root: ${JSON.stringify(path)}`,
      )
    const indexed = indexedBlobs.get(path)
    // The clean worktree already holds these exact bytes; skipping writes nothing through a possibly swapped parent.
    if (indexed?.oid === entry.oid && indexed.mode === entry.mode) continue
    const suffix =
      path === source.name ? '' : path.slice(source.name.length + 1)
    const origin = suffix
      ? join(source.path, ...suffix.split('/'))
      : source.path
    const destination = join(repository.directory, ...path.split('/'))
    // Validate the clone root before creating missing parents, including when the root itself was replaced.
    await assertCloneRoot(path, repository)
    await prepareDestinationParents(path, repository, signal)
    // Root-level selections have no relative ancestors, so always recheck their canonical parent too.
    const parent = await realpath(dirname(destination))
    if (
      !isWithin(repository.directory, parent) ||
      [repository.gitDirectory, repository.commonDirectory].some((metadata) =>
        isWithin(metadata, parent),
      )
    ) {
      throw new Error(
        `Destination parent changed or escaped the repository: ${JSON.stringify(path)}`,
      )
    }
    const existing = await maybeLstat(destination)
    if (
      existing &&
      (entry.kind === 'directory'
        ? !existing.isDirectory()
        : entry.kind === 'symlink'
          ? !existing.isSymbolicLink()
          : !existing.isFile())
    )
      throw new Error(
        `Destination entry type changed before copying: ${JSON.stringify(path)}`,
      )
    if (entry.kind === 'directory') {
      if (!existing) await mkdir(destination)
      await checkDestinationDirectory(path, repository)
    } else {
      // Remove an existing link first: fs.cp otherwise stats dangling link targets on repeated copies.
      if (entry.kind === 'symlink' && existing) await unlink(destination)
      // fs.cp unlinks replaced files, preserving external hardlinks; verbatim links retain their target text.
      await cp(origin, destination, {
        dereference: false,
        verbatimSymlinks: true,
        force: true,
      })
      const copied = await readEntry(
        destination,
        await lstat(destination, { bigint: true }),
        repository,
        signal,
      )
      if (
        copied.oid !== entry.oid ||
        copied.kind !== entry.kind ||
        copied.mode !== entry.mode
      )
        throw new Error(`Copied content changed: ${JSON.stringify(path)}`)
    }
  }
  // Settled entries with unchanged metadata keep their scanned IDs; recently changed ones are reread.
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
      current.oid !== before.oid ||
      current.kind !== before.kind
    )
      throw new Error(
        `Source changed during copying: ${JSON.stringify(path)}. Nothing was pushed.`,
      )
  }
}

/** Streams exact selected paths into Git and checks staged blob IDs/types for {@link backup} before commit.
 * Paths already staged with the expected blob ID and mode are not re-added, but every selected path is still verified.
 * @param source - Original source byte/type manifest.
 * @param repository - Destination working tree after copying.
 * @param signal - CLI cancellation signal.
 * @returns Whether selected content differs from HEAD.
 * @example await stageSource(source, repository, signal)
 */
export async function stageSource(
  source: Source,
  repository: Repository,
  signal: AbortSignal,
): Promise<boolean> {
  const files = new Map(
    [...source.entries].filter(([, entry]) => entry.kind !== 'directory'),
  )
  if (files.size) {
    const indexedBlobs = await readIndexedBlobs(source, repository, signal)
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
    if (unstagedPaths.length)
      await git(
        repository.directory,
        ['add', '--force', '--pathspec-from-file=-', '--pathspec-file-nul'],
        signal,
        {
          input: (function* () {
            for (const path of unstagedPaths) yield `${path}\0`
          })(),
        },
      )
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
          if (!files.has(path))
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
