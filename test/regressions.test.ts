import { expect, test } from 'bun:test'
import {
  chmod,
  lstat,
  readFile,
  readlink,
  rm,
  symlink,
  truncate,
} from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createWorld, nodePath, projectRoot, put, useFixtures } from './helpers'
import { runCommand } from '../src/utils/run-command'
import { readRepository } from '../src/git'
import { scanSource } from '../src/filetree'

useFixtures()

test('preserves tracked executable modes and adds normal files when Git ignores filesystem modes', async () => {
  // Arrange
  const world = await createWorld()
  await world.git(['config', 'core.fileMode', 'false'])
  await put(join(world.repo, 'run.sh'), 'old script\n')
  await world.git(['add', 'run.sh'])
  await world.git(['update-index', '--chmod=+x', 'run.sh'])
  await world.git(['commit', '-m', 'track executable script'])
  await put(join(world.source, 'run.sh'), 'updated script\n')
  await put(join(world.source, 'new.sh'), 'new script\n')
  await chmod(join(world.source, 'new.sh'), 0o755)
  // Act
  await world.cli(['--repo', world.repo, 'run.sh'])
  const unchanged = await world.cli(['run.sh'])
  await world.cli(['new.sh'])
  // Assert
  expect(
    (await world.git(['ls-tree', 'main', 'run.sh'], world.remote)).stdout,
  ).toStartWith('100755 blob ')
  expect((await world.git(['show', 'main:run.sh'], world.remote)).stdout).toBe(
    'updated script\n',
  )
  expect(
    (await world.git(['ls-tree', 'main', 'new.sh'], world.remote)).stdout,
  ).toStartWith('100644 blob ')
  expect(unchanged.stdout).toContain('Unchanged')
  expect((await world.git(['status', '--porcelain'])).stdout).toBe('')
})

test('repeats and updates dangling symlink backups without following targets', async () => {
  // Arrange
  const world = await createWorld()
  const link = join(world.source, 'dangling')
  await symlink('../missing', link)
  await world.cli(['--repo', world.repo, 'dangling'])
  // Act
  const unchanged = await world.cli(['dangling'])
  await rm(link)
  await symlink('../different-missing', link)
  await world.cli(['dangling'])
  // Assert
  expect(unchanged.stdout).toContain('Unchanged')
  expect(await readlink(join(world.repo, 'dangling'))).toBe(
    process.platform === 'win32'
      ? '..\\different-missing'
      : '../different-missing',
  )
  expect(
    (await world.git(['show', 'main:dangling'], world.remote)).stdout,
  ).toBe('../different-missing')
})

test.skipIf(process.platform === 'win32')(
  'preserves literal backslashes in Unix symlink targets',
  async () => {
    // Arrange
    const world = await createWorld()
    await symlink('literal\\target', join(world.source, 'link'))
    // Act
    await world.cli(['--repo', world.repo, 'link'])
    // Assert
    expect((await world.git(['show', 'main:link'], world.remote)).stdout).toBe(
      'literal\\target',
    )
    expect(await readlink(join(world.repo, 'link'))).toBe('literal\\target')
  },
)

test('retains unrelated ignored files when an incoming fast-forward would overwrite them', async () => {
  // Arrange
  const world = await createWorld()
  await put(join(world.repo, '.gitignore'), 'private.txt\n')
  await world.commit()
  await put(join(world.source, 'foo.md'), 'selected\n')
  await world.cli(['--repo', world.repo, 'foo.md'])
  const initial = (await world.git(['rev-parse', 'HEAD'])).stdout.trim()
  await put(join(world.repo, 'private.txt'), 'remote content\n')
  await world.git(['add', '--force', 'private.txt'])
  await world.git(['commit', '-m', 'remote tracks ignored path'])
  await world.git(['push', 'origin', 'main'])
  await world.git(['reset', '--hard', initial])
  await put(join(world.repo, 'private.txt'), 'irreplaceable local content\n')
  // Act / Assert
  await expect(world.cli(['foo.md'])).rejects.toThrow(
    'failed during synchronization',
  )
  expect(await readFile(join(world.repo, 'private.txt'), 'utf8')).toBe(
    'irreplaceable local content\n',
  )
  expect((await world.git(['rev-parse', 'HEAD'])).stdout.trim()).toBe(initial)
})

test.skipIf(process.platform === 'win32')(
  'kills descendants with detached stdio before completing timeout cleanup',
  async () => {
    // Arrange
    const world = await createWorld()
    try {
      // Act
      await expect(
        runCommand(
          nodePath,
          [
            join(projectRoot, 'test', 'fixtures', 'stubborn-process.mjs'),
            world.root,
          ],
          { timeoutMs: 500 },
        ),
      ).rejects.toThrow('timed out')
      await delay(1000)
      // Assert
      expect(
        await lstat(join(world.root, 'survived')).catch(() => undefined),
      ).toBeUndefined()
    } finally {
      const group = Number(
        await readFile(join(world.root, 'process-group'), 'utf8'),
      )
      try {
        process.kill(-group, 'SIGKILL')
      } catch {
        /* The tested cleanup already reaped the group. */
      }
    }
  },
)

test('uses the common repository lock for linked worktrees and rejects their metadata as source', async () => {
  // Arrange
  const world = await createWorld()
  await put(join(world.source, 'foo.md'), 'selected\n')
  await world.cli(['--repo', world.repo, 'foo.md'])
  const linked = join(world.root, 'linked')
  await world.git(['worktree', 'add', '-b', 'linked-backup', linked])
  await world.git(['push', 'origin', 'linked-backup'])
  await world.cli(['--repo', linked])
  const lock = join(world.repo, '.git', 'laststance-backup.lock')
  await put(join(lock, 'owner.json'), '{"pid":999999}')
  // Act / Assert
  await expect(world.cli(['foo.md'])).rejects.toThrow('Backup lock exists')
  await rm(lock, { recursive: true })
  await expect(world.cli([join(world.repo, '.git', 'config')])).rejects.toThrow(
    'must not overlap',
  )
  expect(
    (await world.git(['rev-parse', '--git-common-dir'], linked)).stdout.trim(),
  ).toBe(join(world.repo, '.git').replaceAll('\\', '/'))
})

test('accepts the exact 100 MiB boundary during whole-source preflight', async () => {
  // Arrange
  const world = await createWorld()
  const signal = new AbortController().signal
  const file = join(world.source, 'limit.bin')
  await put(file, '')
  await truncate(file, 100 * 1024 * 1024)
  // Act
  const source = await scanSource(
    file,
    await readRepository(world.repo, signal),
    signal,
  )
  // Assert
  expect([...source.entries.keys()]).toEqual(['limit.bin'])
  expect(source.entries.get('limit.bin')?.kind).toBe('file')
})

test.skipIf(process.platform === 'win32')(
  'rejects a FIFO without blocking or copying earlier entries',
  async () => {
    // Arrange
    const world = await createWorld()
    await put(join(world.source, 'notes', 'a.md'), 'selected\n')
    await runCommand('mkfifo', [join(world.source, 'notes', 'pipe')])
    // Act / Assert
    await expect(world.cli(['--repo', world.repo, 'notes'])).rejects.toThrow(
      'Unsupported filesystem entry',
    )
    expect(
      await lstat(join(world.repo, 'notes')).catch(() => undefined),
    ).toBeUndefined()
  },
)

test('overwrites the same basename on later backups and preserves other committed paths', async () => {
  // Arrange
  const world = await createWorld()
  await put(join(world.source, 'one', 'foo.md'), 'first\n')
  await put(join(world.source, 'two', 'foo.md'), 'second\n')
  await world.cli(['--repo', world.repo, 'one/foo.md'])
  // Act
  await world.cli(['two/foo.md'])
  // Assert
  expect((await world.git(['show', 'main:foo.md'], world.remote)).stdout).toBe(
    'second\n',
  )
  expect(
    (
      await world.git(['rev-list', '--count', 'main'], world.remote)
    ).stdout.trim(),
  ).toBe('2')
})

test.skipIf(process.platform === 'win32').each(['', '\x03'])(
  'cancels first-use registration on empty input or Ctrl-C (%j)',
  async (answer) => {
    // Arrange
    const world = await createWorld()
    const args = [
      join(projectRoot, 'test', 'fixtures', 'terminal.py'),
      nodePath,
      join(projectRoot, 'dist', 'cli.js'),
      'foo.md',
      answer,
    ]
    // Act / Assert
    await expect(
      runCommand('python3', args, {
        cwd: world.source,
        env: world.env,
        timeoutMs: 20_000,
      }),
    ).rejects.toThrow('failed')
    expect(
      await lstat(
        join(world.home, '.config', 'laststance-backup', 'config.json'),
      ).catch(() => undefined),
    ).toBeUndefined()
  },
)
