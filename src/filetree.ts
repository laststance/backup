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
import { resolveLocalPath } from './utils/resolve-local-path'

export type Entry = {
  kind: 'directory' | 'file' | 'symlink'
  mode: string
  oid: string
  signature: string
}
export type Source = { path: string; name: string; entries: Map<string, Entry> }

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

/** Rejects Git metadata aliases during {@link scanSource}, including common case/NTFS/HFS spellings.
 * @param name - One filesystem component.
 * @returns Whether the component could address Git metadata.
 * @example metadataAlias(".GIT") // => true
 */
function metadataAlias(name: string): boolean {
  const normalized = name
    .replace(/[\u200c\u200d\ufeff]/g, '')
    .replace(/[ .]+$/, '')
    .toLowerCase()
  return (
    normalized === '.git' ||
    normalized.startsWith('.git:') ||
    /^git~\d+(?:\.|:|$)/.test(normalized)
  )
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
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(target)
    hash.update(`blob ${target.length}\0`).update(target)
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
 * @returns Canonical source parent, root basename, and byte/type manifest.
 * @example await scanSource("./notes", repository, signal)
 */
export async function scanSource(
  input: string,
  repository: Repository,
  signal: AbortSignal,
): Promise<Source> {
  const resolved = resolveLocalPath(input)
  const name = basename(resolved)
  if (!name || metadataAlias(name))
    throw new Error(
      'The source root cannot be a filesystem root or Git metadata.',
    )
  const path = join(await realpath(dirname(resolved)), name)
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

/** Validates the whole destination after fetch and before {@link copySource}, preventing partial conflict writes.
 * @param source - Complete source manifest.
 * @param repository - Locked destination working tree.
 * @param signal - CLI cancellation signal.
 * @returns Resolves only when all selected paths can be merged safely.
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
  for (const [path, entry] of source.entries) {
    signal.throwIfAborted()
    const key = canonicalKey(path)
    const collision = selected.get(key)
    if (collision && collision !== path)
      throw new Error(
        `Source paths collide on this filesystem: ${JSON.stringify(collision)}, ${JSON.stringify(path)}`,
      )
    selected.set(key, path)
    const destination = join(repository.directory, ...path.split('/'))
    const stats = await maybeLstat(destination)
    if (!stats) continue
    const sameKind =
      entry.kind === 'directory'
        ? stats.isDirectory()
        : entry.kind === 'symlink'
          ? stats.isSymbolicLink()
          : stats.isFile()
    if (!sameKind)
      throw new Error(
        `Destination entry type conflicts: ${JSON.stringify(path)}. No files were copied.`,
      )
    // Leaves may be symlinks because copy never follows them; directory parents may not be links.
    if (!stats.isSymbolicLink()) {
      const canonical = await realpath(destination)
      if (
        !isWithin(repository.directory, canonical) ||
        [repository.gitDirectory, repository.commonDirectory].some((metadata) =>
          isWithin(metadata, canonical),
        )
      ) {
        throw new Error(
          `Destination aliases protected metadata or escapes the repository: ${JSON.stringify(path)}`,
        )
      }
    }
  }
  await git(repository.directory, ['ls-files', '--stage', '-z'], signal, {
    consume: async (output) => {
      for await (const record of readNulRecords(output)) {
        const separator = record.indexOf('\t')
        const path = record.slice(separator + 1)
        const selectedPath = selected.get(canonicalKey(path))
        if (!selectedPath) continue
        if (selectedPath !== path || record.startsWith('160000 '))
          throw new Error(
            `Tracked path collision or submodule: ${JSON.stringify(path)}`,
          )
      }
    },
  })
  await git(repository.directory, ['ls-files', '-v', '-z'], signal, {
    consume: async (output) => {
      for await (const record of readNulRecords(output)) {
        if (
          selected.has(canonicalKey(record.slice(2))) &&
          (record[0] === 'S' || record[0] !== record[0]?.toUpperCase())
        ) {
          throw new Error(
            `Selected path has skip-worktree or assume-unchanged set: ${JSON.stringify(record.slice(2))}. Clear the flag and retry.`,
          )
        }
      }
    },
  })
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
    const origin = join(dirname(source.path), ...path.split('/'))
    const destination = join(repository.directory, ...path.split('/'))
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
    ) {
      throw new Error(
        `Destination entry type changed before copying: ${JSON.stringify(path)}`,
      )
    }
    if (entry.kind === 'directory') {
      await mkdir(destination, { recursive: true })
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
  const after = await scanSource(source.path, repository, signal)
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
    ) {
      throw new Error(
        `Source changed during copying: ${JSON.stringify(path)}. Nothing was pushed.`,
      )
    }
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
