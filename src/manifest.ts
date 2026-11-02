import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  MANIFEST_RACY_WINDOW_MS,
  MANIFEST_VERSION,
  NANOSECONDS_PER_MILLISECOND,
} from './constants'
import type { Entry, Source } from './filetree'
import type { Repository } from './git'
import { maybeLstat } from './utils/maybe-lstat'
import { writePrivateFileAtomically } from './utils/write-private-file-atomically'

/** A blob ID proven for one exact non-following source metadata signature. */
export type KnownBlob = Pick<Entry, 'signature' | 'oid'>

/** Hex digit count of each object format's blob IDs. */
const OBJECT_ID_LENGTH: Record<Repository['objectFormat'], number> = {
  sha1: 40,
  sha256: 64,
}

/** Locates the per-source cache for {@link readManifest} and {@link writeManifest} inside Git metadata, never in the payload tree.
 * @param repository - Destination whose common Git directory also holds the backup lock.
 * @param sourcePath - Canonical source location from {@link scanSource}.
 * @param name - Repository-relative destination root.
 * @returns One file per source/destination pair, shared by linked worktrees.
 * @example manifestPath(repository, '/home/me/notes', 'notes') // => '<common-git-dir>/laststance-backup-manifests/<sha256>.json'
 */
function manifestPath(
  repository: Repository,
  sourcePath: string,
  name: string,
): string {
  const key = createHash('sha256')
    .update(`${sourcePath}\0${name}`)
    .digest('hex')
  return join(
    repository.commonDirectory,
    'laststance-backup-manifests',
    `${key}.json`,
  )
}

/** Loads blob IDs recorded by an earlier {@link writeManifest} so {@link scanSource} can skip rereading unchanged entries.
 * The manifest is only a cache: a missing, unreadable, corrupt, or mismatched file yields an empty map and a full rehash.
 * @param repository - Destination clone; its object format must match the recorded IDs.
 * @param sourcePath - Canonical source location.
 * @param name - Repository-relative destination root.
 * @returns
 * - A path → {@link KnownBlob} map for the recorded settled entries
 * - An empty map when nothing trustworthy is recorded
 * @example await readManifest(repository, '/home/me/notes', 'notes') // => Map { 'notes/a.md' => { signature, oid } }
 */
export async function readManifest(
  repository: Repository,
  sourcePath: string,
  name: string,
): Promise<Map<string, KnownBlob>> {
  const knownBlobs = new Map<string, KnownBlob>()
  const path = manifestPath(repository, sourcePath, name)
  try {
    const stats = await maybeLstat(path)
    if (!stats?.isFile()) return knownBlobs
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    // Persisted JSON is a trust boundary: any unexpected field discards the whole cache.
    if (
      typeof value !== 'object' ||
      value === null ||
      !('version' in value) ||
      value.version !== MANIFEST_VERSION ||
      !('objectFormat' in value) ||
      value.objectFormat !== repository.objectFormat ||
      !('source' in value) ||
      value.source !== sourcePath ||
      !('name' in value) ||
      value.name !== name ||
      !('entries' in value) ||
      !Array.isArray(value.entries)
    )
      return knownBlobs
    const objectIdPattern = new RegExp(
      `^[0-9a-f]{${OBJECT_ID_LENGTH[repository.objectFormat]}}$`,
    )
    for (const record of value.entries) {
      if (
        !Array.isArray(record) ||
        record.length !== 3 ||
        typeof record[0] !== 'string' ||
        typeof record[1] !== 'string' ||
        typeof record[2] !== 'string' ||
        !objectIdPattern.test(record[2])
      )
        return new Map()
      knownBlobs.set(record[0], { signature: record[1], oid: record[2] })
    }
    return knownBlobs
  } catch {
    // An unreadable cache only costs a full rehash; the next write replaces it.
    return new Map()
  }
}

/** Selects scanned blob IDs that later metadata comparisons may trust, for {@link writeManifest} and the post-copy stability rescan.
 * Entries changed within {@link MANIFEST_RACY_WINDOW_MS} of the scan are excluded: a rewrite in the same timestamp tick
 * could keep size, mtime, and ctime identical, so only rereading proves their bytes.
 * @param source - Completed scan with its start time.
 * @returns A path → {@link KnownBlob} map of settled files and symlinks; directories carry no blob.
 * @example settledBlobs(source).get('notes/a.md') // => { signature: '...', oid: '...' } unless edited in the last 10 s
 */
export function settledBlobs(source: Source): Map<string, KnownBlob> {
  const settledBeforeNs =
    source.scannedAtNs -
    BigInt(MANIFEST_RACY_WINDOW_MS) * NANOSECONDS_PER_MILLISECOND
  const knownBlobs = new Map<string, KnownBlob>()
  for (const [path, entry] of source.entries) {
    if (entry.kind === 'directory' || entry.changedAtNs >= settledBeforeNs)
      continue
    knownBlobs.set(path, { signature: entry.signature, oid: entry.oid })
  }
  return knownBlobs
}

/** Persists settled blob IDs after {@link scanSource} in {@link backup}, so the next run hashes only changed entries.
 * The trade-off matches rsync's quick check plus ctime and inode: equal metadata is trusted as equal content.
 * @param source - Completed scan; entries absent from it are dropped from the manifest.
 * @param repository - Destination whose common Git directory stores the manifest.
 * @returns Resolves after the manifest has been atomically replaced.
 * @example await writeManifest(source, repository)
 */
export async function writeManifest(
  source: Source,
  repository: Repository,
): Promise<void> {
  const entries = [...settledBlobs(source)].map(([path, blob]) => [
    path,
    blob.signature,
    blob.oid,
  ])
  await writePrivateFileAtomically(
    manifestPath(repository, source.path, source.name),
    JSON.stringify({
      version: MANIFEST_VERSION,
      objectFormat: repository.objectFormat,
      source: source.path,
      name: source.name,
      entries,
    }),
  )
}
