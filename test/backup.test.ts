import { expect, test } from 'bun:test'
import {
  chmod,
  lstat,
  readFile,
  readlink,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { version } from '../package.json'
import { createWorld, put, recover, useFixtures } from './helpers'

useFixtures()

test('registers one private clone and restores original binary bytes and retained directory entries', async () => {
  // Arrange
  const world = await createWorld()
  await put(
    join(world.source, 'notes', 'binary.dat'),
    new Uint8Array([0, 255, 13, 10, 128]),
  )
  await put(join(world.source, 'notes', 'removed.md'), 'retain me\n')
  await put(join(world.source, 'notes', '.git', 'config'), 'excluded')

  // Act
  await world.cli(['--repo', world.repo, 'notes'])
  await rm(join(world.source, 'notes', 'removed.md'))
  const again = await world.cli(['notes'])
  const restored = await recover(world)

  // Assert
  expect(again.stdout).toContain('Unchanged')
  expect([...(await readFile(join(restored, 'notes', 'binary.dat')))]).toEqual([
    0, 255, 13, 10, 128,
  ])
  expect(await readFile(join(restored, 'notes', 'removed.md'), 'utf8')).toBe(
    'retain me\n',
  )
  expect(
    await lstat(join(world.repo, 'notes', '.git')).catch(() => undefined),
  ).toBeUndefined()
  expect(
    JSON.parse(
      await readFile(
        join(world.home, '.config', 'laststance-backup', 'config.json'),
        'utf8',
      ),
    ),
  ).toEqual({
    version: 1,
    directory: world.repo,
    branch: 'main',
    repositoryId: 123456,
    githubRepository: 'test-owner/private-backup',
  })
})

test('pushes all manual pending commits even when the selected source is unchanged', async () => {
  // Arrange
  const world = await createWorld()
  await put(join(world.source, 'foo.md'), 'same\n')
  await world.cli(['--repo', world.repo, 'foo.md'])
  await put(join(world.repo, 'manual.md'), 'manual history\n')
  await world.commit('manual commit')
  const localHead = (await world.git(['rev-parse', 'HEAD'])).stdout

  // Act
  await world.cli(['foo.md'])

  // Assert
  expect((await world.git(['rev-parse', 'main'], world.remote)).stdout).toBe(
    localHead,
  )
  expect(
    (
      await world.git(['rev-list', '--count', 'main'], world.remote)
    ).stdout.trim(),
  ).toBe('2')
})

test('retains the backup commit after rejected push and retries without a duplicate commit', async () => {
  // Arrange
  const world = await createWorld()
  await put(join(world.source, 'foo.md'), 'retry\n')
  const hook = join(world.remote, 'hooks', 'pre-receive')
  await put(hook, "#!/bin/sh\necho 'fixture rejects push' >&2\nexit 1\n")
  await chmod(hook, 0o755)

  // Act
  await expect(world.cli(['--repo', world.repo, 'foo.md'])).rejects.toThrow(
    'Local commits are retained',
  )
  const localHead = (await world.git(['rev-parse', 'HEAD'])).stdout
  await rm(hook)
  await world.cli(['foo.md'])

  // Assert
  expect((await world.git(['rev-parse', 'main'], world.remote)).stdout).toBe(
    localHead,
  )
  expect((await world.git(['rev-list', '--count', 'HEAD'])).stdout.trim()).toBe(
    '1',
  )
})

test('reconciles an accepted push with a lost transport response on the next invocation', async () => {
  // Arrange
  const world = await createWorld()
  await put(join(world.source, 'foo.md'), 'accepted\n')

  // Act
  await expect(
    world.cli(['--repo', world.repo, 'foo.md'], {
      BACKUP_TEST_LOST_RESPONSE: '1',
    }),
  ).rejects.toThrow('Push completion is unconfirmed')
  const again = await world.cli(['foo.md'])

  // Assert
  expect(again.stdout).toContain('Unchanged')
  expect(
    (
      await world.git(['rev-list', '--count', 'main'], world.remote)
    ).stdout.trim(),
  ).toBe('1')
})

test.each([
  ['public repository', { BACKUP_TEST_PUBLIC: '1' }, 'verified private'],
  [
    'enabled Actions',
    { BACKUP_TEST_ACTIONS: 'enabled' },
    'Actions must be disabled',
  ],
  ['unverifiable API', { BACKUP_TEST_GH_ERROR: '1' }, 'GitHub API denied'],
])('rejects %s before copying', async (_label, environment, message) => {
  // Arrange
  const world = await createWorld()
  await put(join(world.source, 'foo.md'), 'private\n')

  // Act / Assert
  await expect(
    world.cli(['--repo', world.repo, 'foo.md'], environment),
  ).rejects.toThrow(message)
  expect(
    await lstat(join(world.repo, 'foo.md')).catch(() => undefined),
  ).toBeUndefined()
})

test('stops before push when Actions become enabled after copying', async () => {
  // Arrange
  const world = await createWorld()
  await put(join(world.source, 'foo.md'), 'private\n')

  // Act / Assert
  await expect(
    world.cli(['--repo', world.repo, 'foo.md'], {
      BACKUP_TEST_ACTIONS_AFTER: '3',
    }),
  ).rejects.toThrow('Actions must be disabled')
  expect(
    (await world.git(['show-ref'], world.remote).catch(() => ({ stdout: '' })))
      .stdout,
  ).toBe('')
  expect((await world.git(['rev-list', '--count', 'HEAD'])).stdout.trim()).toBe(
    '1',
  )
})

test('refuses Git attributes that normalize selected bytes', async () => {
  // Arrange
  const world = await createWorld()
  await put(join(world.repo, '.gitattributes'), '*.txt text eol=lf\n')
  await world.commit()
  await put(join(world.source, 'windows.txt'), 'one\r\ntwo\r\n')

  // Act / Assert
  await expect(
    world.cli(['--repo', world.repo, 'windows.txt']),
  ).rejects.toThrow('Git changed the selected bytes')
  expect((await world.git(['rev-list', '--count', 'HEAD'])).stdout.trim()).toBe(
    '1',
  )
  expect(await readFile(join(world.repo, 'windows.txt'), 'utf8')).toBe(
    'one\r\ntwo\r\n',
  )
})

test.each(['--assume-unchanged', '--skip-worktree'])(
  'rejects a selected path hidden by %s before copying',
  async (flag) => {
    // Arrange
    const world = await createWorld()
    await put(join(world.repo, 'foo.md'), 'original\n')
    await world.commit()
    await world.git(['update-index', flag, 'foo.md'])
    await put(join(world.source, 'foo.md'), 'changed\n')

    // Act / Assert
    await expect(world.cli(['--repo', world.repo, 'foo.md'])).rejects.toThrow(
      'skip-worktree or assume-unchanged',
    )
    expect(await readFile(join(world.repo, 'foo.md'), 'utf8')).toBe(
      'original\n',
    )
  },
)

test('rejects every selected write when a later destination entry has a different type', async () => {
  // Arrange
  const world = await createWorld()
  await put(join(world.repo, 'notes', 'a.md'), 'keep\n')
  await put(join(world.repo, 'notes', 'z'), 'file\n')
  await world.commit()
  await put(join(world.source, 'notes', 'a.md'), 'would overwrite\n')
  await put(join(world.source, 'notes', 'z', 'child.md'), 'directory\n')

  // Act / Assert
  await expect(world.cli(['--repo', world.repo, 'notes'])).rejects.toThrow(
    'entry type conflicts',
  )
  expect(await readFile(join(world.repo, 'notes', 'a.md'), 'utf8')).toBe(
    'keep\n',
  )
  expect(await readFile(join(world.repo, 'notes', 'z'), 'utf8')).toBe('file\n')
})

test('rejects metadata aliases before writing any selected content', async () => {
  // Arrange
  const world = await createWorld()
  await put(join(world.source, 'notes', 'a.md'), 'would copy\n')
  await put(join(world.source, 'notes', '.GIT', 'config'), 'danger\n')
  const before = await readFile(join(world.repo, '.git', 'config'), 'utf8')

  // Act / Assert
  await expect(world.cli(['--repo', world.repo, 'notes'])).rejects.toThrow(
    'Git metadata alias',
  )
  expect(
    await lstat(join(world.repo, 'notes')).catch(() => undefined),
  ).toBeUndefined()
  expect(await readFile(join(world.repo, '.git', 'config'), 'utf8')).toBe(
    before,
  )
})

test('rejects oversized files before copying their smaller siblings', async () => {
  // Arrange
  const world = await createWorld()
  await put(join(world.source, 'notes', 'a.md'), 'small\n')
  await put(join(world.source, 'notes', 'large.bin'), '')
  await truncate(
    join(world.source, 'notes', 'large.bin'),
    100 * 1024 * 1024 + 1,
  )

  // Act / Assert
  await expect(world.cli(['--repo', world.repo, 'notes'])).rejects.toThrow(
    'exceeds 100 MiB',
  )
  expect(
    await lstat(join(world.repo, 'notes')).catch(() => undefined),
  ).toBeUndefined()
})

test('stages only literal selected filenames and leaves ignored unrelated content alone', async () => {
  // Arrange
  const world = await createWorld()
  await put(join(world.repo, '.gitignore'), '*\n')
  await world.git(['add', '--force', '.gitignore'])
  await world.git(['commit', '-m', 'ignore fixture'])
  await put(join(world.repo, 'unrelated-secret'), 'must remain untracked')
  const names =
    process.platform === 'win32'
      ? ['[bracket].md', '-draft.md', '日本語 space.md']
      : [
          '*',
          '[bracket].md',
          '-draft.md',
          '日本語 space.md',
          'line\nbreak.md',
          ':(glob)*',
        ]
  for (const name of names) await put(join(world.source, name), 'literal\n')

  // Act
  await world.cli(['--repo', world.repo])
  for (const name of names) await world.cli(['--', name])

  // Assert
  const paths = (
    await world.git(['ls-tree', '-rz', '--name-only', 'HEAD'])
  ).stdout
    .split('\0')
    .filter(Boolean)
    .sort()
  expect(paths).toEqual(['.gitignore', ...names].sort())
  expect(await readFile(join(world.repo, 'unrelated-secret'), 'utf8')).toBe(
    'must remain untracked',
  )
})

test('restores symlink target text without following relative or dangling links', async () => {
  // Arrange
  const world = await createWorld()
  await put(join(world.source, 'notes', 'file.md'), 'target\n')
  await symlink('../missing.md', join(world.source, 'notes', 'dangling'))
  await symlink('file.md', join(world.source, 'notes', 'relative'))

  // Act
  await world.cli(['--repo', world.repo, 'notes'])
  const restored = await recover(world)

  // Assert
  expect(
    (await lstat(join(restored, 'notes', 'dangling'))).isSymbolicLink(),
  ).toBe(true)
  expect(await readlink(join(restored, 'notes', 'dangling'))).toBe(
    process.platform === 'win32' ? '..\\missing.md' : '../missing.md',
  )
  expect(
    (await world.git(['show', 'main:notes/dangling'], world.remote)).stdout,
  ).toBe('../missing.md')
  expect(await readlink(join(restored, 'notes', 'relative'))).toBe('file.md')
})

test('rejects a changed branch, dirty worktree, and changed repository identity', async () => {
  // Arrange
  const world = await createWorld()
  await put(join(world.source, 'foo.md'), 'original\n')
  await world.cli(['--repo', world.repo, 'foo.md'])

  // Act / Assert
  await world.git(['switch', '-c', 'other'])
  await expect(world.cli(['foo.md'])).rejects.toThrow('branch changed')
  await world.git(['switch', 'main'])
  await writeFile(join(world.repo, 'foo.md'), 'dirty\n')
  await expect(world.cli(['foo.md'])).rejects.toThrow('uncommitted changes')
  await world.git(['restore', 'foo.md'])
  await expect(
    world.cli(['foo.md'], { BACKUP_TEST_REPOSITORY_ID: '987654' }),
  ).rejects.toThrow('identity changed')
})

test('rejects non-GitHub effective URL rewrites before invoking transport', async () => {
  // Arrange
  const world = await createWorld()
  await put(join(world.source, 'foo.md'), 'private\n')
  await world.git([
    'config',
    'url.https://example.invalid/.insteadOf',
    'git@github.com:',
  ])

  // Act / Assert
  await expect(world.cli(['--repo', world.repo, 'foo.md'])).rejects.toThrow(
    'GitHub.com',
  )
  expect(
    await lstat(join(world.repo, 'foo.md')).catch(() => undefined),
  ).toBeUndefined()
})

test('does not remove a pre-existing lock even when its owner record looks stale', async () => {
  // Arrange
  const world = await createWorld()
  await put(join(world.source, 'foo.md'), 'private\n')
  const owner = join(world.repo, '.git', 'laststance-backup.lock', 'owner.json')
  await put(owner, '{"pid":999999,"hostname":"old-host"}')

  // Act / Assert
  await expect(world.cli(['--repo', world.repo, 'foo.md'])).rejects.toThrow(
    'Locks never expire automatically',
  )
  expect(await readFile(owner, 'utf8')).toBe(
    '{"pid":999999,"hostname":"old-host"}',
  )
})

test('reports failed commit recovery and leaves copied content available for manual repair', async () => {
  // Arrange
  const world = await createWorld()
  await put(join(world.source, 'foo.md'), 'keep after failure\n')
  const hook = join(world.repo, '.git', 'hooks', 'pre-commit')
  await put(hook, '#!/bin/sh\nexit 1\n')
  await chmod(hook, 0o755)

  // Act / Assert
  await expect(world.cli(['--repo', world.repo, 'foo.md'])).rejects.toThrow(
    'repair or commit the changes manually',
  )
  expect(await readFile(join(world.repo, 'foo.md'), 'utf8')).toBe(
    'keep after failure\n',
  )
  expect(
    await lstat(join(world.repo, '.git', 'laststance-backup.lock')).catch(
      () => undefined,
    ),
  ).toBeUndefined()
})

test('requires explicit registration without a terminal and reports corrupt config', async () => {
  // Arrange
  const world = await createWorld()
  await put(join(world.source, 'foo.md'), 'private\n')

  // Act / Assert
  await expect(world.cli(['foo.md'])).rejects.toThrow('non-interactive')
  await put(
    join(world.home, '.config', 'laststance-backup', 'config.json'),
    '{broken',
  )
  await expect(world.cli(['foo.md'])).rejects.toThrow(
    'Cannot read configuration',
  )
  expect((await world.cli(['--help'])).stdout).toContain('Usage: backup')
  expect((await world.cli(['--version'])).stdout.trim()).toBe(version)
})
