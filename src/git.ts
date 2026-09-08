import { realpath } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { MIN_GIT_MAJOR_VERSION, MIN_GIT_MINOR_VERSION } from './constants'
import type { BackupConfig } from './config'
import { resolveLocalPath } from './utils/resolve-local-path'
import { readNulRecords } from './utils/read-nul-records'
import { runCommand } from './utils/run-command'
import type { CommandOptions } from './utils/run-command'

export type Repository = {
  directory: string
  gitDirectory: string
  commonDirectory: string
  objectFormat: 'sha1' | 'sha256'
}

/** Runs repository-scoped Git for backup operations while excluding inherited repository redirections.
 * @param directory - Validated working-tree root.
 * @param argumentsList - Git arguments, using literal pathspec semantics.
 * @param signal - Cancellation from the CLI.
 * @param options - Optional streamed I/O or expected nonzero status.
 * @returns The command result; large listings go through a streaming consumer.
 * @example await git(directory, ["status", "--porcelain"], signal)
 */
export function git(
  directory: string,
  argumentsList: string[],
  signal: AbortSignal,
  options: Omit<CommandOptions, 'cwd' | 'env' | 'signal'> = {},
) {
  const environment = { ...process.env }
  for (const key of Object.keys(environment)) {
    // Keep authentication/transport settings, but never let ambient variables redirect the index or repository.
    if (
      /^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+|NAMESPACE|SHALLOW_FILE|REPLACE_REF_BASE|LITERAL_PATHSPECS|GLOB_PATHSPECS|NOGLOB_PATHSPECS|ICASE_PATHSPECS)$/.test(
        key,
      )
    )
      delete environment[key]
  }
  environment.GIT_TERMINAL_PROMPT = '0'
  environment.GCM_INTERACTIVE = 'never'
  return runCommand(
    'git',
    [
      '-C',
      directory,
      '--literal-pathspecs',
      '-c',
      'core.autocrlf=false',
      '-c',
      'core.fsmonitor=false',
      ...argumentsList,
    ],
    { ...options, signal, env: environment },
  )
}

/** Removes only Git's output terminator so {@link readRepository} preserves whitespace in filesystem paths.
 * @param output - One Git output line.
 * @returns The line without its final line ending.
 * @example gitLine("/vault/with space \n") // => "/vault/with space "
 */
export function gitLine(output: string): string {
  return output.replace(/\r?\n$/, '')
}

/** Resolves a real working-tree root and Git metadata before {@link backup} acquires its lock.
 * @param input - Existing local clone directory.
 * @param signal - CLI cancellation signal.
 * @returns Canonical paths and Git's object-hash format.
 * @example await readRepository("~/private-backup", signal)
 */
export async function readRepository(
  input: string,
  signal: AbortSignal,
): Promise<Repository> {
  const directory = await realpath(resolveLocalPath(input))
  const version = await git(directory, ['--version'], signal)
  const numbers = /git version (\d+)\.(\d+)/.exec(version.stdout)
  const major = Number(numbers?.[1])
  const minor = Number(numbers?.[2])
  if (
    !Number.isFinite(major) ||
    major < MIN_GIT_MAJOR_VERSION ||
    (major === MIN_GIT_MAJOR_VERSION && minor < MIN_GIT_MINOR_VERSION)
  ) {
    throw new Error('Git 2.31 or newer is required.')
  }
  const root = await git(directory, ['rev-parse', '--show-toplevel'], signal)
  if ((await realpath(gitLine(root.stdout))) !== directory)
    throw new Error('Register the repository root, not a subdirectory.')
  const [gitPath, commonPath, format] = await Promise.all([
    git(directory, ['rev-parse', '--absolute-git-dir'], signal),
    git(
      directory,
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      signal,
    ),
    git(directory, ['rev-parse', '--show-object-format'], signal),
  ])
  const objectFormat = gitLine(format.stdout)
  if (objectFormat !== 'sha1' && objectFormat !== 'sha256')
    throw new Error('Unsupported Git object format.')
  return {
    directory,
    gitDirectory: await realpath(gitLine(gitPath.stdout)),
    commonDirectory: await realpath(gitLine(commonPath.stdout)),
    objectFormat,
  }
}

/** Reads an attached branch for registration and rejects branch switching during {@link backup}.
 * @param repository - Current working tree.
 * @param signal - CLI cancellation signal.
 * @returns The attached branch name, including an unborn initial branch.
 * @example await currentBranch(repository, signal) // => "main"
 */
export async function currentBranch(
  repository: Repository,
  signal: AbortSignal,
): Promise<string> {
  const result = await git(
    repository.directory,
    ['symbolic-ref', '--quiet', '--short', 'HEAD'],
    signal,
    { allowFailure: true },
  )
  if (result.exitCode !== 0)
    throw new Error(
      'Detached HEAD is not supported. Check out the registered branch.',
    )
  const branch = gitLine(result.stdout)
  await git(
    repository.directory,
    ['check-ref-format', `refs/heads/${branch}`],
    signal,
  )
  return branch
}

/** Rejects dirty or sparse working trees before {@link backup} changes any payload files.
 * @param repository - Validated repository.
 * @param signal - CLI cancellation signal.
 * @returns Resolves only for a clean, ordinary working tree.
 * @example await assertClean(repository, signal)
 */
export async function assertClean(
  repository: Repository,
  signal: AbortSignal,
): Promise<void> {
  let dirty = false
  await git(
    repository.directory,
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    signal,
    {
      consume: async (output) => {
        for await (const record of readNulRecords(output)) {
          if (record) dirty = true
        }
      },
    },
  )
  if (dirty)
    throw new Error(
      'The destination has uncommitted changes. Commit or repair them before running backup.',
    )
  const sparse = await git(
    repository.directory,
    ['config', '--bool', 'core.sparseCheckout'],
    signal,
    { allowFailure: true },
  )
  if (sparse.stdout.trim() === 'true')
    throw new Error(
      'Sparse checkouts are not supported. Register a full working tree.',
    )
}

/** Extracts a GitHub.com repository from each effective URL used by {@link verifyGitHub}.
 * @param remote - Effective Git transport URL after Git's URL rewriting.
 * @returns The owner/repository identifier without credentials.
 * @example githubName("git@github.com:owner/vault.git") // => "owner/vault"
 */
export function githubName(remote: string): string {
  let pathname: string
  const scp = /^git@github\.com:([^\r\n]+)$/i.exec(remote)
  if (scp?.[1]) {
    pathname = scp[1]
  } else {
    let url: URL
    try {
      url = new URL(remote)
    } catch {
      throw new Error(
        'The effective remote must be a GitHub.com HTTPS or SSH URL.',
      )
    }
    const normalHost = url.hostname.toLowerCase() === 'github.com'
    const alternateSSH =
      url.protocol === 'ssh:' &&
      url.hostname.toLowerCase() === 'ssh.github.com' &&
      url.port === '443'
    if (
      (!normalHost && !alternateSSH) ||
      !['https:', 'ssh:'].includes(url.protocol) ||
      url.search ||
      url.hash ||
      (url.protocol === 'https:' && url.port && url.port !== '443') ||
      (url.protocol === 'ssh:' &&
        !alternateSSH &&
        url.port &&
        url.port !== '22')
    ) {
      throw new Error(
        'The effective remote must use a supported GitHub.com HTTPS or SSH endpoint.',
      )
    }
    pathname = url.pathname.replace(/^\//, '')
  }
  const name = pathname.replace(/\.git\/?$/, '').replace(/\/$/, '')
  if (
    !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(name) ||
    name.endsWith('/.') ||
    name.endsWith('/..')
  ) {
    throw new Error(
      'The effective remote does not identify a GitHub repository.',
    )
  }
  return name
}

/** Verifies private identity and disabled Actions at registration, before copy, and immediately before push.
 * @param repository - Validated local repository.
 * @param signal - CLI cancellation signal.
 * @param expectedId - Previously registered immutable GitHub repository ID.
 * @returns Public metadata fields needed for the local destination registry.
 * @example await verifyGitHub(repository, signal, 123456)
 */
export async function verifyGitHub(
  repository: Repository,
  signal: AbortSignal,
  expectedId?: number,
) {
  const [fetchURL, pushURL] = await Promise.all([
    git(repository.directory, ['remote', 'get-url', '--all', 'origin'], signal),
    git(
      repository.directory,
      ['remote', 'get-url', '--push', '--all', 'origin'],
      signal,
    ),
  ])
  const fetchURLs = gitLine(fetchURL.stdout).split(/\r?\n/)
  const pushURLs = gitLine(pushURL.stdout).split(/\r?\n/)
  if (
    fetchURLs.length !== 1 ||
    pushURLs.length !== 1 ||
    !fetchURLs[0] ||
    !pushURLs[0]
  )
    throw new Error(
      'Exactly one fetch URL and one push URL are required for origin.',
    )
  const name = githubName(fetchURLs[0])
  if (githubName(pushURLs[0]).toLowerCase() !== name.toLowerCase())
    throw new Error('The effective fetch and push repositories differ.')
  const environment = { ...process.env, GH_PROMPT_DISABLED: '1' }
  const [metadataOutput, actionsOutput] = await Promise.all([
    runCommand('gh', ['api', '--hostname', 'github.com', `repos/${name}`], {
      signal,
      env: environment,
    }),
    runCommand(
      'gh',
      ['api', '--hostname', 'github.com', `repos/${name}/actions/permissions`],
      { signal, env: environment },
    ),
  ])
  const metadata: unknown = JSON.parse(metadataOutput.stdout)
  const actions: unknown = JSON.parse(actionsOutput.stdout)
  if (
    typeof metadata !== 'object' ||
    metadata === null ||
    !('private' in metadata) ||
    metadata.private !== true
  ) {
    throw new Error(
      'The destination must be a verified private GitHub repository.',
    )
  }
  if (
    !('id' in metadata) ||
    typeof metadata.id !== 'number' ||
    !Number.isSafeInteger(metadata.id) ||
    metadata.id <= 0 ||
    !('full_name' in metadata) ||
    typeof metadata.full_name !== 'string' ||
    !/^[\w.-]+\/[\w.-]+$/.test(metadata.full_name)
  ) {
    throw new Error('GitHub returned invalid repository identity metadata.')
  }
  if (expectedId !== undefined && metadata.id !== expectedId)
    throw new Error(
      'The GitHub repository identity changed. Register the intended destination again.',
    )
  if ('archived' in metadata && metadata.archived === true)
    throw new Error('The destination repository is archived.')
  if (
    typeof actions !== 'object' ||
    actions === null ||
    !('enabled' in actions) ||
    actions.enabled !== false
  ) {
    throw new Error(
      'GitHub Actions must be disabled on the destination. Disable it in repository Settings > Actions > General; backup does not change this setting.',
    )
  }
  return { repositoryId: metadata.id, githubRepository: metadata.full_name }
}

/** Reads the current commit for {@link synchronize} and concurrent-change checks in {@link backup}.
 * @param repository - Current working tree.
 * @param signal - CLI cancellation signal.
 * @returns Commit ID, or undefined for an unborn branch.
 * @example await headCommit(repository, signal) // => undefined in an empty clone
 */
export async function headCommit(
  repository: Repository,
  signal: AbortSignal,
): Promise<string | undefined> {
  const result = await git(
    repository.directory,
    ['rev-parse', '--verify', '--quiet', 'HEAD'],
    signal,
    { allowFailure: true },
  )
  if (result.exitCode !== 0) return
  return gitLine(result.stdout)
}

/** Fetches only the registered branch and fast-forwards before {@link backup} revalidates its destination paths.
 * @param repository - Clean, locked working tree.
 * @param config - Registered branch and destination identity.
 * @param signal - CLI cancellation signal.
 * @returns The fetched remote commit, or undefined for an empty remote.
 * @example await synchronize(repository, config, signal)
 */
export async function synchronize(
  repository: Repository,
  config: BackupConfig,
  signal: AbortSignal,
): Promise<string | undefined> {
  let remoteHasRefs = false
  let branchExists = false
  await git(repository.directory, ['ls-remote', 'origin'], signal, {
    consume: async (output) => {
      for await (const line of createInterface({
        input: output,
        crlfDelay: Infinity,
      })) {
        remoteHasRefs = true
        if (line.split('\t')[1] === `refs/heads/${config.branch}`)
          branchExists = true
      }
    },
  })
  if (!branchExists) {
    if (remoteHasRefs)
      throw new Error(
        'The registered branch is missing from the nonempty remote. Repair the branch before backing up.',
      )
    return
  }
  const trackingRef = `refs/remotes/origin/${config.branch}`
  await git(
    repository.directory,
    [
      'fetch',
      '--quiet',
      '--no-tags',
      '--recurse-submodules=no',
      'origin',
      `+refs/heads/${config.branch}:${trackingRef}`,
    ],
    signal,
  )
  const remoteCommit = gitLine(
    (
      await git(
        repository.directory,
        ['rev-parse', '--verify', trackingRef],
        signal,
      )
    ).stdout,
  )
  const localCommit = await headCommit(repository, signal)
  if (localCommit === remoteCommit) return remoteCommit
  if (localCommit) {
    const ahead = await git(
      repository.directory,
      ['merge-base', '--is-ancestor', remoteCommit, localCommit],
      signal,
      { allowFailure: true },
    )
    if (ahead.exitCode === 0) return remoteCommit
    const behind = await git(
      repository.directory,
      ['merge-base', '--is-ancestor', localCommit, remoteCommit],
      signal,
      { allowFailure: true },
    )
    if (ahead.exitCode !== 1 || behind.exitCode !== 0)
      throw new Error(
        'Local and remote history diverged. Reconcile it manually; backup never force-pushes.',
      )
  }
  await git(
    repository.directory,
    [
      '-c',
      'merge.autoStash=false',
      'merge',
      '--quiet',
      '--ff-only',
      '--no-edit',
      trackingRef,
    ],
    signal,
  )
  return remoteCommit
}
