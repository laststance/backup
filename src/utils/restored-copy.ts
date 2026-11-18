import { createHash } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Repository } from '../git'
import { maybeLstat } from './maybe-lstat'
import { writePrivateFileAtomically } from './write-private-file-atomically'

/** Identifies a file version for copy verification and permission restoration.
 * @example signature(await lstat(path, { bigint: true }))
 */
export function signature(stats: BigIntStats): string {
  return [
    stats.dev,
    stats.ino,
    stats.size,
    stats.mode,
    stats.mtimeNs,
    stats.ctimeNs,
  ].join(':')
}

/** Keeps each permission-restoration record private to the worktree containing its inode.
 * @example recordPath(repository, 'notes/report')
 */
function recordPath(repository: Repository, path: string): string {
  const name = createHash('sha256').update(path).digest('hex')
  return join(repository.gitDirectory, 'laststance-backup-restored-modes', name)
}

/** Saves the exact stat and indexed bytes verified through an open descriptor after removing owner-read.
 * @example await recordRestoredCopy(repository, 'report', stats, mode, oid)
 */
export async function recordRestoredCopy(
  repository: Repository,
  path: string,
  stats: BigIntStats,
  mode: string,
  oid: string,
): Promise<void> {
  await writePrivateFileAtomically(
    recordPath(repository, path),
    `2 ${signature(stats)} ${mode} ${oid}`,
  )
}

/** Retrieves the staged mode and blob for a file still in its exact post-restoration state.
 * {@link assertClean} compares them to the live index. A later copy can also identify its own restricted file.
 * @example await restoredIndexEntry(repository, 'report') // => '100644 <blob id>'
 */
export async function restoredIndexEntry(
  repository: Repository,
  key: string,
  stats?: BigIntStats,
): Promise<string | undefined> {
  const current = stats ?? (await maybeLstat(join(repository.directory, key)))
  if (!current?.isFile() || (current.mode & 0o400n) !== 0n) return
  const path = recordPath(repository, key)
  const prefix = `2 ${signature(current)} `
  const record = await maybeLstat(path)
  // Each record ends with a six-digit Git mode, a space and the repository's hex blob ID.
  const oidLength = repository.objectFormat === 'sha256' ? 64 : 40
  if (
    !record?.isFile() ||
    record.size !== BigInt(Buffer.byteLength(prefix) + 7 + oidLength)
  )
    return
  const content = await readFile(path, 'utf8')
  const after = await maybeLstat(join(repository.directory, key))
  if (
    content.startsWith(prefix) &&
    after?.isFile() &&
    signature(after) === signature(current)
  )
    return content.slice(prefix.length)
}
