import { expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { chmod, lstat, mkdir, readFile, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createWorld, nodePath, projectRoot, put, useFixtures } from './helpers'
import { runCommand } from '../src/utils/run-command'
import { readNulRecords } from '../src/utils/read-nul-records'
import { copySource, scanSource, validateDestination } from '../src/filetree'
import { readRepository } from '../src/git'

useFixtures()

test('fast-forwards remote updates before merging the selected source', async () => {
  // Arrange
  const world = await createWorld()
  await put(join(world.source, 'foo.md'), 'selected\n')
  await world.cli(['--repo', world.repo, 'foo.md'])
  const initial = (await world.git(['rev-parse', 'HEAD'])).stdout.trim()
  await put(join(world.repo, 'remote-only.md'), 'remote change\n')
  await world.commit()
  await world.git(['push', 'origin', 'main'])
  await world.git(['reset', '--hard', initial])

  // Act
  await world.cli(['foo.md'])

  // Assert
  expect(await readFile(join(world.repo, 'remote-only.md'), 'utf8')).toBe(
    'remote change\n',
  )
  expect((await world.git(['rev-list', '--count', 'HEAD'])).stdout.trim()).toBe(
    '2',
  )
})

test('rejects divergent remote history without overwriting local files or force pushing', async () => {
  // Arrange
  const world = await createWorld()
  await put(join(world.source, 'foo.md'), 'initial\n')
  await world.cli(['--repo', world.repo, 'foo.md'])
  const initial = (await world.git(['rev-parse', 'HEAD'])).stdout.trim()
  await put(join(world.repo, 'remote.md'), 'remote\n')
  await world.commit('remote')
  await world.git(['push', 'origin', 'main'])
  const remoteHead = (await world.git(['rev-parse', 'main'], world.remote))
    .stdout
  await world.git(['reset', '--hard', initial])
  await put(join(world.repo, 'manual.md'), 'local\n')
  await world.commit('local')
  await put(join(world.source, 'foo.md'), 'must not copy\n')

  // Act / Assert
  await expect(world.cli(['foo.md'])).rejects.toThrow('history diverged')
  expect(await readFile(join(world.repo, 'foo.md'), 'utf8')).toBe('initial\n')
  expect((await world.git(['rev-parse', 'main'], world.remote)).stdout).toBe(
    remoteHead,
  )
})

test('rechecks a destination directory replaced by a symlink during fast-forward', async () => {
  // Arrange
  const world = await createWorld()
  await put(join(world.source, 'notes', 'file.md'), 'initial\n')
  await world.cli(['--repo', world.repo, 'notes'])
  const initial = (await world.git(['rev-parse', 'HEAD'])).stdout.trim()
  await mkdir(join(world.root, 'outside'))
  await rm(join(world.repo, 'notes'), { recursive: true })
  await symlink(join(world.root, 'outside'), join(world.repo, 'notes'), 'dir')
  await world.commit('remote replaces directory with link')
  await world.git(['push', 'origin', 'main'])
  await world.git(['reset', '--hard', initial])
  await put(join(world.source, 'notes', 'file.md'), 'must not escape\n')

  // Act / Assert
  await expect(world.cli(['notes'])).rejects.toThrow('entry type conflicts')
  expect(
    await lstat(join(world.root, 'outside', 'file.md')).catch(() => undefined),
  ).toBeUndefined()
})

test('detects source bytes changed after preflight and reports a copy failure without pushing', async () => {
  // Arrange
  const world = await createWorld()
  const signal = new AbortController().signal
  const repository = await readRepository(world.repo, signal)
  await put(join(world.source, 'foo.md'), 'before\n')
  const source = await scanSource(
    join(world.source, 'foo.md'),
    repository,
    signal,
  )
  await validateDestination(source, repository, signal)
  await put(join(world.source, 'foo.md'), 'after\n')

  // Act / Assert
  await expect(copySource(source, repository, signal)).rejects.toThrow(
    'Copied content changed',
  )
  expect(
    (await world.git(['show-ref'], world.remote).catch(() => ({ stdout: '' })))
      .stdout,
  ).toBe('')
})

test('detects commit hooks that add unselected content and prevents the push', async () => {
  // Arrange
  const world = await createWorld()
  await put(join(world.source, 'foo.md'), 'selected\n')
  const hook = join(world.repo, '.git', 'hooks', 'pre-commit')
  await put(
    hook,
    "#!/bin/sh\nprintf 'unexpected' > extra.md\ngit add extra.md\n",
  )
  await chmod(hook, 0o755)

  // Act / Assert
  await expect(world.cli(['--repo', world.repo, 'foo.md'])).rejects.toThrow(
    'changed the verified commit',
  )
  expect(
    (await world.git(['show-ref'], world.remote).catch(() => ({ stdout: '' })))
      .stdout,
  ).toBe('')
})

test('streams path lists exceeding argv and one-megabyte output limits', async () => {
  // Arrange
  const world = await createWorld()
  const nameTail = 'x'.repeat(220)
  for (let index = 0; index < 10_000; index++)
    await put(
      join(
        world.source,
        'many',
        `${String(index).padStart(4, '0')}-${nameTail}`,
      ),
      'tiny\n',
    )

  // Act
  await world.cli(['--repo', world.repo, 'many'])
  let count = 0
  let outputBytes = 0
  await runCommand(
    'git',
    ['-C', world.remote, 'ls-tree', '-rz', '--name-only', 'main'],
    {
      env: world.env,
      consume: async (output) => {
        for await (const path of readNulRecords(output)) {
          count++
          outputBytes += Buffer.byteLength(path) + 1
        }
      },
    },
  )

  // Assert
  expect(count).toBe(10_000)
  expect(outputBytes).toBe(2_310_000)
}, 120_000)

test('terminates a timed-out subprocess and reports its failure', async () => {
  // Arrange / Act / Assert
  await expect(
    runCommand(nodePath, ['-e', 'setInterval(() => {}, 1000)'], {
      timeoutMs: 50,
    }),
  ).rejects.toThrow('timed out')
})

test('preserves UTF-8 filenames and newlines split across streamed NUL record chunks', async () => {
  // Arrange
  const bytes = Buffer.from('日本語\n.md\0two\0')
  const records: string[] = []

  // Act
  for await (const path of readNulRecords(
    (async function* () {
      for (const byte of bytes) yield new Uint8Array([byte])
    })(),
  ))
    records.push(path)

  // Assert
  expect(records).toEqual(['日本語\n.md', 'two'])
})

test.skipIf(process.platform === 'win32')(
  'rejects concurrent calls and releases its own lock after SIGINT during transport',
  async () => {
    // Arrange
    const world = await createWorld()
    await put(join(world.source, 'foo.md'), 'cancel\n')
    const marker = join(world.root, 'ssh-waiting')
    const child = spawn(
      nodePath,
      [join(projectRoot, 'dist', 'cli.js'), '--repo', world.repo, 'foo.md'],
      {
        cwd: world.source,
        env: { ...world.env, BACKUP_TEST_SSH_WAIT: marker },
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    )
    const completion = new Promise<number | null>((resolve) =>
      child.once('exit', resolve),
    )
    let diagnostic = ''
    child.stderr.on('data', (chunk) => {
      diagnostic += String(chunk)
    })
    try {
      for (
        let attempt = 0;
        attempt < 100 && !(await lstat(marker).catch(() => undefined));
        attempt++
      )
        await delay(50)
      expect(await lstat(marker).catch(() => undefined)).toBeDefined()

      // Act
      await expect(world.cli(['foo.md'])).rejects.toThrow('Backup lock exists')
      child.kill('SIGINT')
      const exitCode = await completion

      // Assert
      expect(exitCode).toBe(130)
      expect(diagnostic).toContain('cancelled')
      expect(
        await lstat(join(world.repo, '.git', 'laststance-backup.lock')).catch(
          () => undefined,
        ),
      ).toBeUndefined()
      expect(
        await lstat(join(world.repo, 'foo.md')).catch(() => undefined),
      ).toBeUndefined()
    } finally {
      child.kill('SIGKILL')
    }
  },
)
