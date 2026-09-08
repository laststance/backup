import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import {
  CONFIG_VERSION,
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
} from './constants'
import { saveConfig } from './config'
import type { BackupConfig } from './config'
import {
  assertClean,
  currentBranch,
  git,
  gitLine,
  headCommit,
  readRepository,
  synchronize,
  verifyGitHub,
} from './git'
import type { Repository } from './git'
import {
  copySource,
  scanSource,
  stageSource,
  validateDestination,
} from './filetree'

/** Serializes CLI calls across linked worktrees for {@link backup}, leaving stale locks for explicit recovery.
 * @param repository - Resolved common Git directory shared by worktrees.
 * @returns A release callback that removes only this invocation's lock.
 * @example const release = await acquireLock(repository); try { await work(); } finally { await release(); }
 */
async function acquireLock(
  repository: Repository,
): Promise<() => Promise<void>> {
  const directory = join(repository.commonDirectory, 'laststance-backup.lock')
  const ownerPath = join(directory, 'owner.json')
  const token = randomUUID()
  try {
    await mkdir(directory, { mode: PRIVATE_DIRECTORY_MODE })
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      throw new Error(
        `Backup lock exists: ${JSON.stringify(directory)}. Inspect owner.json and confirm its process has stopped before removing this lock directory manually. Locks never expire automatically.`,
      )
    }
    throw error
  }
  try {
    await writeFile(
      ownerPath,
      JSON.stringify({ token, pid: process.pid, hostname: hostname() }),
      { flag: 'wx', mode: PRIVATE_FILE_MODE },
    )
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
  return async () => {
    const owner: unknown = JSON.parse(await readFile(ownerPath, 'utf8'))
    if (
      typeof owner !== 'object' ||
      owner === null ||
      !('token' in owner) ||
      owner.token !== token
    ) {
      throw new Error(
        `Lock ownership changed; inspect ${JSON.stringify(directory)} manually.`,
      )
    }
    await rm(directory, { recursive: true })
  }
}

/** Ensures the registered branch and working tree remain safe at mutable boundaries in {@link backup}.
 * @param repository - Current working tree.
 * @param config - Immutable destination identity and registered branch.
 * @param signal - CLI cancellation signal.
 * @returns Resolves only when branch, worktree, and GitHub checks pass.
 * @example await validateRegistration(repository, config, signal)
 */
async function validateRegistration(
  repository: Repository,
  config: BackupConfig,
  signal: AbortSignal,
): Promise<void> {
  if ((await currentBranch(repository, signal)) !== config.branch)
    throw new Error(
      `The checked-out branch changed. Check out ${JSON.stringify(config.branch)} or register again.`,
    )
  await assertClean(repository, signal)
  await verifyGitHub(repository, signal, config.repositoryId)
}

/** Registers or backs up one source for the CLI, publishing only a verified commit of exact selected content.
 * @param options - Explicit destination overrides registration; a missing source registers only.
 * @param signal - Cancellation shared with all filesystem and child-process work.
 * @returns A concise, truthful operation result for CLI output.
 * @example await backup({ source: "foo.md", config }, signal)
 */
export async function backup(
  options: { source?: string; directory?: string; config?: BackupConfig },
  signal: AbortSignal,
): Promise<string> {
  const directory = options.directory ?? options.config?.directory
  if (!directory)
    throw new Error(
      'No destination registered. Run backup --repo <existing-private-clone> <source>.',
    )
  const repository = await readRepository(directory, signal)
  const release = await acquireLock(repository)
  let phase = 'validation'
  let affectedPath = ''
  let failure: Error | undefined
  try {
    let config = options.directory ? undefined : options.config
    if (!config) {
      const branch = await currentBranch(repository, signal)
      await assertClean(repository, signal)
      const identity = await verifyGitHub(repository, signal)
      config = {
        version: CONFIG_VERSION,
        directory: repository.directory,
        branch,
        ...identity,
      }
      await saveConfig(config)
    } else {
      if (config.directory !== repository.directory)
        throw new Error(
          'The registered local path changed. Register the intended clone again.',
        )
      await validateRegistration(repository, config, signal)
    }
    if (!options.source)
      return `Registered ${config.githubRepository} (${config.branch}) at ${JSON.stringify(config.directory)}.`

    // lock -> validate -> fetch/ff -> revalidate -> preflight -> copy -> stage/verify -> commit/verify -> push
    phase = 'synchronization'
    const remoteCommit = await synchronize(repository, config, signal)
    await validateRegistration(repository, config, signal)
    const originalHead = await headCommit(repository, signal)
    phase = 'preflight'
    const source = await scanSource(options.source, repository, signal)
    await validateDestination(source, repository, signal)
    affectedPath = join(repository.directory, source.name)
    if ((await headCommit(repository, signal)) !== originalHead)
      throw new Error(
        'HEAD changed during preflight. Retry when other Git operations have finished.',
      )
    await assertClean(repository, signal)

    phase = 'copying'
    await copySource(source, repository, signal)
    phase = 'staging'
    const changed = await stageSource(source, repository, signal)
    if (
      (await headCommit(repository, signal)) !== originalHead ||
      (await currentBranch(repository, signal)) !== config.branch
    ) {
      throw new Error(
        'HEAD or branch changed while copying. Nothing was pushed.',
      )
    }
    const expectedTree = gitLine(
      (await git(repository.directory, ['write-tree'], signal)).stdout,
    )
    let commit = originalHead
    if (changed) {
      phase = 'committing'
      await git(
        repository.directory,
        ['commit', '--quiet', '-m', `chore(backup): update ${source.name}`],
        signal,
      )
      commit = await headCommit(repository, signal)
      if (!commit) throw new Error('Commit did not produce a valid HEAD.')
      const [tree, ancestry] = await Promise.all([
        git(repository.directory, ['rev-parse', `${commit}^{tree}`], signal),
        git(
          repository.directory,
          ['rev-list', '--parents', '-n', '1', commit],
          signal,
        ),
      ])
      const expectedAncestry = originalHead
        ? `${commit} ${originalHead}`
        : commit
      if (
        gitLine(tree.stdout) !== expectedTree ||
        gitLine(ancestry.stdout) !== expectedAncestry
      ) {
        throw new Error(
          'Commit hooks or another process changed the verified commit. Inspect it manually; nothing was pushed.',
        )
      }
    }
    phase = 'push validation'
    await validateRegistration(repository, config, signal)
    if ((await headCommit(repository, signal)) !== commit)
      throw new Error('HEAD changed before push. Inspect the branch and retry.')
    if (!commit || commit === remoteCommit)
      return `Unchanged: ${JSON.stringify(source.name)}. Remote is up to date.`
    phase = 'pushing'
    // Explicit SHA/refspec publishes all pending branch history without inherited mirror/tag/submodule pushes.
    await git(
      repository.directory,
      [
        '-c',
        'remote.origin.mirror=false',
        '-c',
        'push.followTags=false',
        'push',
        '--porcelain',
        '--recurse-submodules=no',
        'origin',
        `${commit}:refs/heads/${config.branch}`,
      ],
      signal,
    )
    return `Backed up ${JSON.stringify(source.name)} to ${config.githubRepository} (${config.branch}, ${commit.slice(0, 12)}). All pending branch commits were pushed.`
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const recovery = ['copying', 'staging', 'committing'].includes(phase)
      ? `\nAffected destination: ${JSON.stringify(affectedPath)}. No push was attempted. Inspect git status/diff in ${JSON.stringify(repository.directory)}; repair or commit the changes manually, then retry. No files were rolled back.`
      : ['push validation', 'pushing'].includes(phase)
        ? `\nLocal commits are retained in ${JSON.stringify(repository.directory)}. Push completion is unconfirmed. Fix the reported issue and rerun the same command; it fetches first and pushes all remaining commits without duplicating the backup commit.`
        : ''
    failure = new Error(`Backup failed during ${phase}: ${detail}${recovery}`, {
      cause: error,
    })
    throw failure
  } finally {
    try {
      await release()
    } catch (error) {
      // Preserve phase/recovery details on failure; a cleanup-only failure still makes a successful run fail.
      if (!failure) throw error
      const detail = error instanceof Error ? error.message : String(error)
      failure.message += `\nLock cleanup failed: ${detail}`
    }
  }
}
