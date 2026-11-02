import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { MANIFEST_RACY_WINDOW_MS } from '../src/constants'

/** Tree behind the CHANGELOG 0.3.0 figures: 20,000 files of 16 KiB. */
const DEFAULT_FILE_COUNT = 20_000
const DEFAULT_FILE_BYTES = 16_384
/** Generated files per directory, so one huge directory does not dominate readdir cost. */
const FILES_PER_DIRECTORY = 100
/** Files rewritten before the incremental measurement. */
const CHANGED_FILE_COUNT = 5
/** Wait beyond the racy window so fresh fixtures are trusted like a long-lived tree's files. */
const SETTLE_MARGIN_MS = 1_000

/** Reads one size flag for the generated tree.
 * @param text - Raw flag value, or undefined when the flag was omitted.
 * @param fallback - Value used when the flag was omitted.
 * @returns The positive integer to use.
 * @throws When the value is not a positive integer.
 * @example positiveInteger('2000', 20_000) // => 2000
 */
function positiveInteger(text: string | undefined, fallback: number): number {
  const value = text === undefined ? fallback : Number(text)
  if (!Number.isInteger(value) || value <= 0)
    throw new Error(`Expected a positive integer, got ${JSON.stringify(text)}`)
  return value
}

const projectRoot = resolve(import.meta.dir, '..')
const { values: flags } = parseArgs({
  options: {
    cli: { type: 'string' },
    files: { type: 'string' },
    bytes: { type: 'string' },
  },
})
const cli = resolve(flags.cli ?? join(projectRoot, 'dist', 'cli.js'))
const fileCount = positiveInteger(flags.files, DEFAULT_FILE_COUNT)
const fileBytes = positiveInteger(flags.bytes, DEFAULT_FILE_BYTES)
const nodePath = Bun.which('node')

// The gh/ssh fixtures are POSIX scripts; Windows would need the compiled stubs test/helpers.ts builds.
if (process.platform === 'win32')
  throw new Error('bench/incremental.ts runs on macOS and Linux only')
if (!nodePath) throw new Error('node is required: the CLI is measured on Node')
if (fileCount < CHANGED_FILE_COUNT)
  throw new Error(`--files must be at least ${CHANGED_FILE_COUNT}`)

const root = await realpath(await mkdtemp(join(tmpdir(), 'backup-bench-')))
const tools = join(root, 'tools')
const repo = join(root, 'vault')
const remote = join(root, 'remote.git')
const work = join(root, 'work')
const home = join(root, 'home')
/** Locates generated file number index; files are grouped {@link FILES_PER_DIRECTORY} to a directory. */
const generatedFilePath = (index: number): string =>
  join(
    work,
    'data',
    `d${Math.floor(index / FILES_PER_DIRECTORY)}`,
    `f${index}.bin`,
  )
const env: NodeJS.ProcessEnv = { ...process.env }
// Drop the developer's Git and token variables so only the stubs below are reachable.
for (const key of Object.keys(env))
  if (/^GIT_/.test(key) || /^(GH|GITHUB)_TOKEN$/.test(key)) delete env[key]
Object.assign(env, {
  HOME: home,
  XDG_CONFIG_HOME: join(home, '.config'),
  PATH: [tools, env.PATH].join(delimiter),
  GIT_CONFIG_GLOBAL: join(home, 'gitconfig'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_SSH_COMMAND: `${nodePath} ${join(projectRoot, 'test', 'fixtures', 'ssh.mjs')}`,
  GIT_SSH_VARIANT: 'ssh',
  GIT_TERMINAL_PROMPT: '0',
  BACKUP_TEST_REMOTE: remote,
})

/** Runs one setup or CLI command inside the isolated bench environment.
 * @param command - Executable name or path.
 * @param args - Literal arguments.
 * @param cwd - Working directory.
 * @returns The command's stdout.
 * @throws When the command exits non-zero, with its stderr.
 * @example run('git', ['init', '-q', repo], root) // => ''
 */
function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8' })
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr}`)
  return result.stdout
}

/** Times one backup invocation and prints the seconds with the CLI's first output line.
 * @param label - Scenario name printed in the report.
 * @param args - CLI arguments, run from the work directory.
 * @example measure('unchanged', ['data']) // prints "unchanged  2.04s  Unchanged ..."
 */
const measure = (label: string, args: string[]): void => {
  const startedAt = performance.now()
  const output = run(nodePath, [cli, ...args], work)
  const seconds = ((performance.now() - startedAt) / 1000).toFixed(2)
  console.log(`${label.padEnd(10)} ${seconds}s  ${output.trim().slice(0, 80)}`)
}

try {
  await Promise.all([tools, repo, work, home].map((path) => mkdir(path)))
  await copyFile(
    join(projectRoot, 'test', 'fixtures', 'gh.mjs'),
    join(tools, 'gh'),
  )
  await chmod(join(tools, 'gh'), 0o755)
  await writeFile(join(home, 'gitconfig'), '[core]\n')
  run('git', ['init', '-q', '-b', 'main', repo], root)
  run('git', ['init', '-q', '--bare', '-b', 'main', remote], root)
  run('git', ['-C', repo, 'config', 'user.name', 'Bench'], root)
  run(
    'git',
    ['-C', repo, 'config', 'user.email', 'bench@example.invalid'],
    root,
  )
  run(
    'git',
    [
      '-C',
      repo,
      'remote',
      'add',
      'origin',
      'git@github.com:test-owner/private-backup.git',
    ],
    root,
  )
  for (let index = 0; index < fileCount; index++) {
    // Create each directory once, when its first file is written.
    if (index % FILES_PER_DIRECTORY === 0)
      await mkdir(dirname(generatedFilePath(index)), { recursive: true })
    await writeFile(generatedFilePath(index), randomBytes(fileBytes))
  }
  console.log(`cli: ${cli}\ntree: ${fileCount} files x ${fileBytes} B`)
  await Bun.sleep(MANIFEST_RACY_WINDOW_MS + SETTLE_MARGIN_MS)
  measure('initial', ['--repo', repo, 'data'])
  measure('unchanged', ['data'])
  // Spread the rewrites across the tree so each lands in an existing directory.
  const changeStride = Math.floor(fileCount / CHANGED_FILE_COUNT)
  for (let index = 0; index < CHANGED_FILE_COUNT; index++)
    await writeFile(
      generatedFilePath(index * changeStride),
      randomBytes(fileBytes),
    )
  measure(`${CHANGED_FILE_COUNT} changed`, ['data'])
} finally {
  await rm(root, { recursive: true, force: true })
}
