import { afterAll, beforeAll } from 'bun:test'
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCommand } from '../src/utils/run-command'

export const projectRoot = resolve(import.meta.dir, '..')
export const nodePath = (
  await runCommand(Bun.which('node') ?? 'node', ['-p', 'process.execPath'])
).stdout.trim()
const fixtureRoot = await mkdtemp(join(tmpdir(), 'backup-test-tools-'))
const roots: string[] = []

/** Installs and cleans shared executable fixtures per test file because Bun scopes lifecycle hooks to that file.
 * @example useFixtures(); test("backs up a file", async () => { const world = await createWorld(); });
 */
export function useFixtures(): void {
  beforeAll(async () => {
    await mkdir(fixtureRoot, { recursive: true })
    const fixture = fileURLToPath(new URL('./fixtures/gh.mjs', import.meta.url))
    if (process.platform === 'win32') {
      await runCommand(process.execPath, [
        'build',
        fixture,
        '--compile',
        `--outfile=${join(fixtureRoot, 'gh.exe')}`,
      ])
    } else {
      await cp(fixture, join(fixtureRoot, 'gh'))
      await chmod(join(fixtureRoot, 'gh'), 0o755)
    }
  })

  afterAll(async () => {
    for (const root of [...roots.splice(0), fixtureRoot])
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      })
  })
}

/** Creates real isolated local/bare repositories for CLI integration tests, stubbing only GitHub transport/API.
 * @returns Paths, isolated process environment, and literal Git/CLI command helpers.
 * @example const world = await createWorld(); await world.cli(["--repo", world.repo, world.source]);
 */
export async function createWorld() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'laststance-backup-test-')),
  )
  roots.push(root)
  const repo = join(root, 'vault')
  const remote = join(root, 'remote.git')
  const source = join(root, 'source')
  const home = join(root, 'home')
  await Promise.all([mkdir(repo), mkdir(source), mkdir(home)])
  const ssh = fileURLToPath(new URL('./fixtures/ssh.mjs', import.meta.url))
  const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    PATH: [
      fixtureRoot,
      ...String(process.env.PATH)
        .split(delimiter)
        .filter((path) => !path.includes('.bun')),
    ].join(delimiter),
    GIT_CONFIG_GLOBAL: join(home, 'empty-gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_SSH_COMMAND: `${shellQuote(nodePath.replaceAll('\\', '/'))} ${shellQuote(ssh.replaceAll('\\', '/'))}`,
    GIT_SSH_VARIANT: 'ssh',
    GIT_TERMINAL_PROMPT: '0',
    BACKUP_TEST_REMOTE: remote,
    BACKUP_TEST_GH_COUNTER: join(root, 'gh-count'),
  }
  // Isolate tests from repository and authentication variables inherited from the developer's shell.
  for (const key of Object.keys(env)) {
    if (
      /^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)$/.test(
        key,
      ) ||
      /^(GH|GITHUB)_TOKEN$/.test(key)
    )
      delete env[key]
  }
  const git = (args: string[], directory = repo) =>
    runCommand('git', ['-C', directory, ...args], { env })
  await git(['init', '-b', 'main'])
  await git(['init', '--bare', '-b', 'main', remote])
  await git(['config', 'user.name', 'Backup Test'])
  await git(['config', 'user.email', 'backup-test@example.invalid'])
  await git(['config', 'core.autocrlf', 'false'])
  await git(['config', 'core.symlinks', 'true'])
  await git([
    'remote',
    'add',
    'origin',
    'git@github.com:test-owner/private-backup.git',
  ])
  const cli = (
    args: string[],
    extra: NodeJS.ProcessEnv = {},
    entry = join(projectRoot, 'dist', 'cli.js'),
  ) =>
    runCommand(nodePath, [entry, ...args], {
      cwd: source,
      env: { ...env, ...extra },
      timeoutMs: 120_000,
    })
  const commit = async (message = 'fixture setup') => {
    await git(['add', '--all'])
    await git(['commit', '-m', message])
  }
  return { root, repo, remote, source, home, env, git, cli, commit }
}

/** Writes nested fixtures for behavior tests without obscuring each test's expected content.
 * @param path - Destination file path.
 * @param content - Literal bytes or text.
 * @example await put(join(world.source, "notes", "hello.md"), "hello\n")
 */
export async function put(
  path: string,
  content: string | Uint8Array,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

/** Runs npm with Node for tarball tests, avoiding Windows shell shims and any installed Bun requirement.
 * @param argumentsList - npm arguments.
 * @param cwd - Isolated install/pack directory.
 * @param env - Test environment.
 * @returns Captured npm output.
 * @example await npm(["install", "--ignore-scripts", tarball], consumer, world.env)
 */
export async function npm(
  argumentsList: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
) {
  const script =
    process.platform === 'win32'
      ? join(dirname(nodePath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
      : join(
          dirname(nodePath),
          '..',
          'lib',
          'node_modules',
          'npm',
          'bin',
          'npm-cli.js',
        )
  return runCommand(nodePath, [script, ...argumentsList], {
    cwd,
    env,
    timeoutMs: 120_000,
  })
}

/** Follows the README recovery procedure against the real remote for installed-package acceptance tests.
 * @param world - Isolated repositories and Git helper.
 * @returns A fresh recovery directory with checkout conversions disabled by local override attributes.
 * @example const recovered = await recover(world); expect(await readFile(join(recovered, "foo.md"), "utf8")).toBe("hello\n")
 */
export async function recover(
  world: Awaited<ReturnType<typeof createWorld>>,
): Promise<string> {
  const directory = join(world.root, 'recovered')
  await world.git(['clone', '--no-checkout', world.remote, directory])
  await put(
    join(directory, '.git', 'info', 'attributes'),
    '* -text -filter -ident -working-tree-encoding\n',
  )
  await world.git(
    [
      '-c',
      'core.autocrlf=false',
      '-c',
      'core.symlinks=true',
      'checkout',
      '--force',
      'main',
    ],
    directory,
  )
  return directory
}
