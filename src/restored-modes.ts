import { createHash, randomUUID } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import {
  open,
  readFile,
  realpath,
  rm,
  unlink,
  type FileHandle,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { git, type Repository } from './git'
import { MANIFEST_RACY_WINDOW_MS } from './constants'
import { isWithin } from './utils/is-within'
import { maybeLstat } from './utils/maybe-lstat'
import { metadataAlias } from './utils/metadata-alias'
import { parseStageRecord } from './utils/parse-stage-record'
import { readNulRecords } from './utils/read-nul-records'
import {
  recordRestoredCopy,
  restoredIndexEntry,
  signature,
} from './utils/restored-copy'
import { writePrivateFileAtomically } from './utils/write-private-file-atomically'

type VerifiedCopy = { mode: string; oid: string; signature: string }
const journalName = 'laststance-backup-pending-modes.json'

/** Persists the intended permission changes before commit so a failed receipt write can be retried.
 * The journal uses path hashes. Only real paths from the live Git index can participate in recovery.
 * @example await savePendingModes(repository, addedRead, files)
 */
export async function savePendingModes(
  repository: Repository,
  keys: Set<string>,
  verified: ReadonlyMap<string, VerifiedCopy>,
): Promise<void> {
  if (!keys.size) return
  const intents: Record<string, string> = {}
  for (const key of keys) {
    const entry = verified.get(key)
    if (!entry)
      throw new Error(
        `Missing verified file before permission restoration: ${JSON.stringify(key)}`,
      )
    // chmod changes ctime, including a rollback to owner-readable after a failed write.
    const identity = entry.signature.slice(0, entry.signature.lastIndexOf(':'))
    intents[createHash('sha256').update(key).digest('hex')] =
      `${identity} ${entry.mode} ${entry.oid}`
  }
  await writePrivateFileAtomically(
    join(repository.gitDirectory, journalName),
    JSON.stringify(intents),
  )
}

/** Hashes the pinned inode so permission changes never interfere with verifying its bytes.
 * @example const oid = await openBlobId(file, stats, repository)
 */
async function openBlobId(
  handle: FileHandle,
  stats: BigIntStats,
  repository: Repository,
): Promise<string> {
  const hash = createHash(repository.objectFormat).update(
    `blob ${stats.size}\0`,
  )
  for await (const chunk of handle.createReadStream({
    start: 0,
    autoClose: false,
  }))
    hash.update(chunk)
  return hash.digest('hex')
}

type RestoringFile = {
  key: string
  path: string
  handle: FileHandle
  stats: BigIntStats
  entry: VerifiedCopy
}

/** Waits for a later timestamp on the actual target filesystem before hashing a group of restricted inodes.
 * An unlinked probe shares the destination clock even when the Git directory lives on another mount.
 * @example await afterRestoreTick(files, signal)
 */
async function afterRestoreTick(
  files: RestoringFile[],
  repository: Repository,
  signal?: AbortSignal,
): Promise<void> {
  const newest = new Map<bigint, RestoringFile>()
  for (const file of files) {
    if ((newest.get(file.stats.dev)?.stats.ctimeNs ?? -1n) < file.stats.ctimeNs)
      newest.set(file.stats.dev, file)
  }
  for (const file of newest.values()) {
    // Most clones share the Git directory's device, including files in read-only worktree directories.
    const privateStats = await maybeLstat(repository.gitDirectory)
    const directory =
      file.stats.dev === privateStats?.dev
        ? repository.gitDirectory
        : dirname(file.path)
    const name = join(directory, `.laststance-backup-clock-${randomUUID()}`)
    let probe: FileHandle
    try {
      probe = await open(name, 'wx+', 0o600)
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        ['EROFS', 'EPERM', 'EACCES'].includes(String(error.code))
      ))
        throw error
      // A separately mounted, unwritable parent cannot host a probe. Use the same conservative interval as the manifest.
      await delay(MANIFEST_RACY_WINDOW_MS, undefined, { signal })
      continue
    }
    try {
      await unlink(name)
      const start = performance.now()
      for (;;) {
        signal?.throwIfAborted()
        await probe.write(Buffer.of(1), 0, 1, 0)
        if ((await probe.stat({ bigint: true })).ctimeNs > file.stats.ctimeNs)
          break
        if (performance.now() - start > 10_000)
          throw new Error(
            'The destination filesystem clock did not advance; retry the backup.',
          )
        await delay(25, undefined, { signal })
      }
    } finally {
      await probe.close()
    }
  }
}

/** Restores native modes and verifies receipts in bounded batches while original descriptors remain readable.
 * On a verified-copy failure the pending journal retains the intent, and unsaved files remain readable by Git.
 * @example await restoreCopiedModes(repository, addedRead, files, signal)
 */
export async function restoreCopiedModes(
  repository: Repository,
  addedRead: Set<string>,
  verified?: ReadonlyMap<string, VerifiedCopy>,
  signal?: AbortSignal,
): Promise<void> {
  const keys = [...addedRead]
  const batchSize = 64
  for (let start = 0; start < keys.length; start += batchSize) {
    const pending: RestoringFile[] = []
    try {
      for (const key of keys.slice(start, start + batchSize)) {
        const path = join(repository.directory, key)
        const before = await maybeLstat(path)
        if (!before?.isFile() || !(before.mode & 0o400n)) {
          addedRead.delete(key)
          continue
        }
        const handle = await open(
          path,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        )
        let retained = false
        try {
          const stats = await handle.stat({ bigint: true })
          const entry = verified?.get(key)
          if (
            signature(stats) !== signature(before) ||
            (entry && entry.signature !== signature(stats))
          )
            throw new Error(
              `Copied entry changed before restoring permissions: ${JSON.stringify(key)}`,
            )
          if (entry) {
            // Add the descriptor before chmod so a later I/O failure can restore owner-read on this exact inode.
            const file = { key, path, handle, stats, entry }
            pending.push(file)
            retained = true
            await handle.chmod(Number(stats.mode & 0o7377n))
            file.stats = await handle.stat({ bigint: true })
          } else {
            await handle.chmod(Number(stats.mode & 0o7377n))
            addedRead.delete(key)
          }
        } finally {
          if (!retained) await handle.close()
        }
      }
      await afterRestoreTick(pending, repository, signal)
      for (const file of pending) {
        const oid = await openBlobId(file.handle, file.stats, repository)
        const named = await maybeLstat(file.path)
        if (
          oid !== file.entry.oid ||
          !named ||
          signature(named) !== signature(file.stats) ||
          signature(await file.handle.stat({ bigint: true })) !==
            signature(file.stats)
        )
          throw new Error(
            `Copied entry changed before recording permissions: ${JSON.stringify(file.key)}`,
          )
        await recordRestoredCopy(
          repository,
          file.key,
          file.stats,
          file.entry.mode,
          oid,
        )
        addedRead.delete(file.key)
      }
    } catch (error) {
      if (verified) {
        // The outer cleanup must preserve owner-read for the unrecorded files, including later batches.
        const restore = pending.filter((file) => addedRead.has(file.key))
        addedRead.clear()
        for (const file of restore) {
          const current = await file.handle.stat({ bigint: true })
          await file.handle.chmod(Number(current.mode & 0o7777n) | 0o400)
        }
      }
      throw error
    } finally {
      await Promise.all(pending.map((file) => file.handle.close()))
    }
  }
}

/** Finishes a saved restoration after rechecking Git's staged blob, the named inode and its actual bytes.
 * Only paths obtained from stage zero can be opened. Changed, replaced and aliased files stay untouched.
 * @example await recoverPendingModes(repository, signal)
 */
export async function recoverPendingModes(
  repository: Repository,
  signal: AbortSignal,
): Promise<void> {
  const journal = join(repository.gitDirectory, journalName)
  if (!(await maybeLstat(journal))?.isFile()) return
  const intents: unknown = JSON.parse(await readFile(journal, 'utf8'))
  if (!intents || typeof intents !== 'object' || Array.isArray(intents))
    throw new Error('Invalid pending permission journal.')
  const verified = new Map<string, VerifiedCopy>()
  await git(repository.directory, ['ls-files', '--stage', '-z'], signal, {
    consume: async (output) => {
      for await (const row of readNulRecords(output)) {
        const { path: key, stage, mode, oid } = parseStageRecord(row)
        const id = createHash('sha256').update(key).digest('hex')
        if (
          stage !== '0' ||
          !(mode === '100644' || mode === '100755') ||
          !Object.hasOwn(intents, id) ||
          key
            .split('/')
            .some(
              (part) =>
                !part || part === '.' || part === '..' || metadataAlias(part),
            )
        )
          continue
        const path = join(repository.directory, key)
        const stats = await maybeLstat(path)
        if (!stats?.isFile() || stats.nlink !== 1n) continue
        const mark = signature(stats)
        const temporaryIdentity = [
          stats.dev,
          stats.ino,
          stats.size,
          stats.mode | 0o400n,
          stats.mtimeNs,
        ].join(':')
        if (Reflect.get(intents, id) !== `${temporaryIdentity} ${mode} ${oid}`)
          continue
        if (!(stats.mode & 0o400n)) {
          if (
            (await restoredIndexEntry(repository, key, stats)) ===
            `${mode} ${oid}`
          )
            continue
          // An interrupted process may have lost its only readable descriptor. Keep the journal for a verified retry.
          throw new Error(
            `Permission restoration was interrupted for ${JSON.stringify(path)}. Restore owner-read on this file and retry the backup.`,
          )
        }
        const parent = await realpath(dirname(path))
        if (
          parent !== dirname(path) ||
          !isWithin(repository.directory, parent) ||
          isWithin(repository.gitDirectory, path) ||
          isWithin(repository.commonDirectory, path)
        )
          continue
        const handle = await open(
          path,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        )
        try {
          if (
            signature(await handle.stat({ bigint: true })) !== mark ||
            (await openBlobId(handle, stats, repository)) !== oid ||
            signature(await handle.stat({ bigint: true })) !== mark
          )
            continue
          verified.set(key, { mode, oid, signature: mark })
        } finally {
          await handle.close()
        }
      }
    },
  })
  await restoreCopiedModes(
    repository,
    new Set(verified.keys()),
    verified,
    signal,
  )
  await rm(journal, { force: true })
}

/** Removes the completed write-ahead record after all restricted permissions have durable receipts.
 * @example await clearPendingModes(repository)
 */
export async function clearPendingModes(repository: Repository): Promise<void> {
  await rm(join(repository.gitDirectory, journalName), { force: true })
}
