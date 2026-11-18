import { lstat, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { maybeLstat } from './maybe-lstat'

/** Detects which path spellings identify one entry where the worktree or private operands reside.
 * @param directory - Probe parent. A temporary directory isolates the spelling probes from existing names.
 * @param writableGitDirectory - Writable Git metadata to probe if a read-only worktree shares its filesystem.
 * @returns A comparison key that preserves case and Unicode normalization independently when the volume does.
 * @example const fold = await copyPathFold(repository.directory)
 */
export async function copyPathFold(
  directory: string,
  writableGitDirectory?: string,
): Promise<(path: string) => string> {
  const probe = await mkdtemp(join(directory, '.backup-names-')).catch(
    async (error: NodeJS.ErrnoException) => {
      if (
        !writableGitDirectory ||
        !['EACCES', 'EPERM', 'EROFS'].includes(error.code ?? '')
      )
        throw error
      // cp can overwrite existing files even when their parent is read-only. Use writable Git metadata on that volume.
      const [worktree, metadata] = await Promise.all([
        lstat(directory, { bigint: true }),
        lstat(writableGitDirectory, { bigint: true }),
      ])
      if (worktree.dev !== metadata.dev) throw error
      return mkdtemp(join(writableGitDirectory, '.backup-names-'))
    },
  )
  try {
    // An empty private parent proves alternate spellings alias this entry even when a FUSE driver synthesizes inodes.
    await mkdir(join(probe, 'café'))
    const [alternateCase, decomposed] = await Promise.all([
      maybeLstat(join(probe, 'CAFé')),
      maybeLstat(join(probe, 'cafe\u0301')),
    ])
    let foldsCase = alternateCase !== undefined
    if (dirname(probe) !== directory) {
      // A read-only root can have a different per-directory case policy from writable Git metadata.
      const upper = await maybeLstat(join(directory, '.GIT'))
      const names = upper ? await readdir(directory) : []
      foldsCase = !!upper && !(names.includes('.git') && names.includes('.GIT'))
    }
    const foldsNormalization = decomposed !== undefined
    return (path) => {
      const normalized = foldsNormalization ? path.normalize('NFC') : path
      if (!foldsCase) return normalized
      if (foldsNormalization) return normalized.toUpperCase().toLowerCase()
      // NTFS and exFAT compare individual UTF-16 units without expanding one letter into several.
      return normalized.replace(/[^/\\]/g, (unit) => {
        const upper = unit.toUpperCase()
        return upper.length === 1 ? upper : unit
      })
    }
  } finally {
    await rm(probe, { recursive: true, force: true })
  }
}
