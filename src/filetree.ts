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
import { EXECUTABLE_MODE_MASK, MAX_FILE_SIZE_BYTES } from './constants'
import { isWithin } from './utils/is-within'
import { maybeLstat } from './utils/maybe-lstat'
import { readNulRecords } from './utils/read-nul-records'
import { metadataAlias } from './utils/metadata-alias'
import { resolveBackupPath } from './utils/resolve-backup-path'

export type Entry = {
  kind: 'directory' | 'file' | 'symlink'
  mode: string
  oid: string
  signature: string
}
export type Source = {
  /** Source location with a canonical parent, retaining a selected leaf symlink. */
  path: string
  /** Preserved repository-relative destination root, shared by all manifest keys. */
  name: string
  entries: Map<string, Entry>
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
 * @returns The exact Git blob ID and entry mode expected in the index.
 * @example await readEntry(path, stats, repository, signal)
 */
async function readEntry(
  path: string,
  stats: BigIntStats,
  repository: Repository,
  signal: AbortSignal,
): Promise<Entry> {
  signal.throwIfAborted()
  const marker = signature(stats)
  if (stats.isDirectory())
    return { kind: 'directory', mode: '040000', oid: '', signature: marker }
  if (!stats.isFile() && !stats.isSymbolicLink())
    throw new Error(`Unsupported filesystem entry: ${JSON.stringify(path)}`)
  if (stats.size > MAX_FILE_SIZE_BYTES)
    throw new Error(`File exceeds 100 MiB: ${JSON.stringify(path)}`)
  const hash = createHash(repository.objectFormat)
  let mode: string
  let kind: Entry['kind']
  if (stats.isSymbolicLink()) {
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
    mode = '120000'
    kind = 'symlink'
  } else {
    hash.update(`blob ${stats.size}\0`)
    for await (const chunk of createReadStream(path, { signal }))
      hash.update(chunk)
    mode = Number(stats.mode) & EXECUTABLE_MODE_MASK ? '100755' : '100644'
    kind = 'file'
  }
  if (signature(await lstat(path, { bigint: true })) !== marker)
    throw new Error(`Source changed while being read: ${JSON.stringify(path)}`)
  return { kind, mode, oid: hash.digest('hex'), signature: marker }
}

/** Builds the complete source manifest before {@link backup} writes anything, excluding exact .git components.
 * @param input - One source file, directory, or symlink.
 * @param repository - Destination root and protected metadata directories.
 * @param signal - CLI cancellation signal.
 * @param destinationName - Previously validated mapping reused by {@link copySource} during its stability rescan.
 * @returns Canonical source parent, mapped destination root, and byte/type manifest.
 * @example await scanSource("./notes", repository, signal)
 */
export async function scanSource(
  input: string,
  repository: Repository,
  signal: AbortSignal,
  destinationName?: string,
): Promise<Source> {
  // Internal rescans reuse the approved location and mapping; canonical parent aliases are not fresh CLI input.
  const mapping =
    destinationName === undefined
      ? resolveBackupPath(input)
      : { path: input, name: destinationName }
  const resolved = mapping.path
  const name = mapping.name
  // A rescan preserves its original mapping, while still rejecting invalid internal keys.
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
  const entries = new Map<string, Entry>()
  const visit = async (
    absolutePath: string,
    relativePath: string,
  ): Promise<void> => {
    signal.throwIfAborted()
    const stats = await lstat(absolutePath, { bigint: true })
    entries.set(
      relativePath,
      await readEntry(absolutePath, stats, repository, signal),
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
  return { path, name, entries }
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
        const separator = record.indexOf('\t')
        const path = record.slice(separator + 1)
        // Every tracked prefix participates, including parents of unrelated tracked siblings.
        for (const prefix of [...destinationAncestors(path), path]) {
          const target = required.get(canonicalKey(prefix))
          if (!target) continue
          if (
            target.path !== prefix ||
            (prefix !== path && target.kind !== 'directory') ||
            (prefix === path &&
              (record.startsWith('160000 ') || target.kind === 'directory'))
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

/** Merge-copies preflighted entries for {@link backup} and proves both source stability and copied bytes.
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
  for (const [path, entry] of source.entries) {
    signal.throwIfAborted()
    // Manifest destinations are not source paths: only the suffix below the selected root belongs to the origin.
    if (path !== source.name && !path.startsWith(`${source.name}/`))
      throw new Error(
        `Source manifest entry is outside its destination root: ${JSON.stringify(path)}`,
      )
    const suffix =
      path === source.name ? '' : path.slice(source.name.length + 1)
    const origin = suffix
      ? join(source.path, ...suffix.split('/'))
      : source.path
    const destination = join(repository.directory, ...path.split('/'))
    // Validate the clone root before creating missing parents, including when the root itself was replaced.
    if ((await realpath(repository.directory)) !== repository.directory)
      throw new Error(
        `Destination parent changed or escaped the repository: ${JSON.stringify(path)}`,
      )
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
  const after = await scanSource(source.path, repository, signal, source.name)
  if (after.entries.size !== source.entries.size)
    throw new Error(
      'Source entries changed during copying. Nothing was pushed.',
    )
  for (const [path, before] of source.entries) {
    const current = after.entries.get(path)
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
    const fileMode = await git(
      repository.directory,
      ['config', '--bool', '--default', 'true', 'core.fileMode'],
      signal,
    )
    // Git retains tracked modes and gives new files 100644 when filesystem executable bits are ignored.
    if (fileMode.stdout.trim() === 'false') {
      for (const [path, entry] of files) {
        if (entry.kind === 'file') files.set(path, { ...entry, mode: '100644' })
      }
      await git(repository.directory, ['ls-files', '--stage', '-z'], signal, {
        consume: async (output) => {
          for await (const record of readNulRecords(output)) {
            const separator = record.indexOf('\t')
            const path = record.slice(separator + 1)
            const entry = files.get(path)
            const [mode, , stage] = record.slice(0, separator).split(' ')
            if (
              entry?.kind === 'file' &&
              stage === '0' &&
              (mode === '100644' || mode === '100755')
            )
              files.set(path, { ...entry, mode })
          }
        },
      })
    }
    await git(
      repository.directory,
      ['add', '--force', '--pathspec-from-file=-', '--pathspec-file-nul'],
      signal,
      {
        input: (function* () {
          for (const path of files.keys()) yield `${path}\0`
        })(),
      },
    )
  }
  let matched = 0
  await git(repository.directory, ['ls-files', '--stage', '-z'], signal, {
    consume: async (output) => {
      for await (const record of readNulRecords(output)) {
        const separator = record.indexOf('\t')
        const path = record.slice(separator + 1)
        const entry = files.get(path)
        if (!entry) continue
        const [mode, oid, stage] = record.slice(0, separator).split(' ')
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
