import { expect, test } from 'bun:test'
import { chmod, lstat, mkdir, readFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createWorld, nodePath, projectRoot, put, useFixtures } from './helpers'
import { runCommand } from '../src/utils/run-command'
import { readNulRecords } from '../src/utils/read-nul-records'

useFixtures()

test.each([
  ['file', 'directory'],
  ['file', 'symlink'],
  ['directory', 'file'],
  ['directory', 'symlink'],
  ['symlink', 'file'],
  ['symlink', 'directory'],
])(
  'rejects source %s over destination %s before changing any sibling',
  async (sourceKind, destinationKind) => {
    // Arrange
    const world = await createWorld()
    await put(join(world.repo, 'notes', 'a.md'), 'preserved\n')
    await put(join(world.source, 'notes', 'a.md'), 'must not overwrite\n')
    for (const [root, kind] of [
      [world.source, sourceKind],
      [world.repo, destinationKind],
    ]) {
      if (!root) throw new Error('Missing fixture root')
      const path = join(root, 'notes', 'z')
      if (kind === 'directory') await put(join(path, 'file.md'), 'nested\n')
      else if (kind === 'symlink') await symlink('../missing', path)
      else await put(path, 'regular\n')
    }
    await world.commit()

    // Act / Assert
    await expect(world.cli(['--repo', world.repo, 'notes'])).rejects.toThrow(
      'entry type conflicts',
    )
    expect(await readFile(join(world.repo, 'notes', 'a.md'), 'utf8')).toBe(
      'preserved\n',
    )
    expect((await world.git(['status', '--porcelain'])).stdout).toBe('')
  },
)

test.skipIf(process.platform === 'win32')(
  'reports partial copy failure and succeeds after deliberate repair',
  async () => {
    // Arrange
    const world = await createWorld()
    await put(join(world.repo, 'notes', 'a.md'), 'old\n')
    await put(join(world.repo, 'notes', 'locked', 'keep.md'), 'retained\n')
    await world.commit()
    await put(join(world.source, 'notes', 'a.md'), 'new\n')
    await put(
      join(world.source, 'notes', 'locked', 'new.md'),
      'copy after repair\n',
    )
    const locked = join(world.repo, 'notes', 'locked')
    await chmod(locked, 0o500)
    try {
      // Act / Assert
      await expect(world.cli(['--repo', world.repo, 'notes'])).rejects.toThrow(
        'failed during copying',
      )
      expect(await readFile(join(world.repo, 'notes', 'a.md'), 'utf8')).toBe(
        'new\n',
      )
      expect(
        (
          await world
            .git(['show-ref'], world.remote)
            .catch(() => ({ stdout: '' }))
        ).stdout,
      ).toBe('')
    } finally {
      await chmod(locked, 0o755)
    }
    await world.git(['restore', 'notes/a.md'])
    await world.cli(['notes'])
    expect(
      (await world.git(['show', 'main:notes/locked/new.md'], world.remote))
        .stdout,
    ).toBe('copy after repair\n')
  },
)

test.skipIf(process.platform === 'win32')(
  'preserves the previous registration when saving a new destination fails',
  async () => {
    // Arrange
    const world = await createWorld()
    const other = await createWorld()
    await world.cli(['--repo', world.repo])
    const directory = join(world.home, '.config', 'laststance-backup')
    const before = await readFile(join(directory, 'config.json'), 'utf8')
    await chmod(directory, 0o500)
    try {
      // Act / Assert
      await expect(world.cli(['--repo', other.repo])).rejects.toThrow('EACCES')
      expect(await readFile(join(directory, 'config.json'), 'utf8')).toBe(
        before,
      )
    } finally {
      await chmod(directory, 0o700)
    }
    await world.cli(['--repo', other.repo])
    expect(
      JSON.parse(await readFile(join(directory, 'config.json'), 'utf8'))
        .directory,
    ).toBe(other.repo)
  },
)

test.each([
  'null',
  '[]',
  '{"version":2}',
  '{"version":1,"directory":"relative","branch":"main","repositoryId":1,"githubRepository":"owner/repo"}',
])('rejects schema-invalid configuration %s', async (json) => {
  // Arrange
  const world = await createWorld()
  await put(
    join(world.home, '.config', 'laststance-backup', 'config.json'),
    json,
  )
  // Act / Assert
  await expect(world.cli(['foo.md'])).rejects.toThrow(
    'Cannot read configuration',
  )
})

test.each([
  [
    'multiple fetch URLs',
    [
      'remote',
      'set-url',
      '--add',
      'origin',
      'git@github.com:test-owner/extra.git',
    ],
    'Exactly one',
  ],
  [
    'different push URL',
    [
      'remote',
      'set-url',
      '--push',
      'origin',
      'git@github.com:test-owner/extra.git',
    ],
    'fetch and push repositories differ',
  ],
])('rejects %s before copying', async (_label, args, message) => {
  // Arrange
  const world = await createWorld()
  await put(join(world.source, 'foo.md'), 'private\n')
  await world.git(args)
  // Act / Assert
  await expect(world.cli(['--repo', world.repo, 'foo.md'])).rejects.toThrow(
    message,
  )
  expect(
    await lstat(join(world.repo, 'foo.md')).catch(() => undefined),
  ).toBeUndefined()
})

test.each([
  [
    'archived',
    '{"private":true,"id":123456,"full_name":"test-owner/private-backup","archived":true}',
    'archived',
  ],
  [
    'invalid identity',
    '{"private":true,"id":"123456","full_name":"test-owner/private-backup"}',
    'invalid repository identity',
  ],
])('rejects %s GitHub metadata', async (_label, metadata, message) => {
  // Arrange
  const world = await createWorld()
  // Act / Assert
  await expect(
    world.cli(['--repo', world.repo], { BACKUP_TEST_METADATA: metadata }),
  ).rejects.toThrow(message)
})

test('rejects a registered branch missing from a nonempty remote', async () => {
  // Arrange
  const world = await createWorld()
  await put(join(world.source, 'foo.md'), 'private\n')
  await world.cli(['--repo', world.repo, 'foo.md'])
  await world.git(['branch', 'other', 'main'], world.remote)
  await world.git(['update-ref', '-d', 'refs/heads/main'], world.remote)
  // Act / Assert
  await expect(world.cli(['foo.md'])).rejects.toThrow(
    'missing from the nonempty remote',
  )
})

test('rejects detached HEAD, sparse checkout, and overlapping sources before copying', async () => {
  // Arrange
  const world = await createWorld()
  await put(join(world.source, 'foo.md'), 'private\n')
  await world.cli(['--repo', world.repo, 'foo.md'])
  // Act / Assert
  await world.git(['checkout', '--detach', 'HEAD'])
  await expect(world.cli(['foo.md'])).rejects.toThrow('Detached HEAD')
  await world.git(['checkout', 'main'])
  await world.git(['config', 'core.sparseCheckout', 'true'])
  await expect(world.cli(['foo.md'])).rejects.toThrow('Sparse checkouts')
  await world.git(['config', 'core.sparseCheckout', 'false'])
  await expect(world.cli([join(world.repo, 'foo.md')])).rejects.toThrow(
    'must not overlap',
  )
  await expect(world.cli([world.root])).rejects.toThrow('must not overlap')
})

test('preserves a BOM character in filenames through scanning and NUL records', async () => {
  // Arrange
  const world = await createWorld()
  await put(join(world.source, 'notes', '\ufeffname.md'), 'selected\n')
  const records: string[] = []
  // Act
  await world.cli(['--repo', world.repo, 'notes'])
  for await (const record of readNulRecords(
    (async function* () {
      yield Buffer.from('\ufeffname.md\0')
    })(),
  ))
    records.push(record)
  // Assert
  expect(records).toEqual(['\ufeffname.md'])
  expect(
    (await world.git(['show', 'main:notes/\ufeffname.md'], world.remote))
      .stdout,
  ).toBe('selected\n')
})

test('streams multi-megabyte output to a slow consumer without truncation or deadlock', async () => {
  // Arrange
  let bytes = 0
  // Act
  await runCommand(
    nodePath,
    ['-e', 'process.stdout.write(Buffer.alloc(4 * 1024 * 1024, 120))'],
    {
      consume: async (output) => {
        for await (const chunk of output) {
          bytes += chunk.length
          await delay(1)
        }
      },
    },
  )
  // Assert
  expect(bytes).toBe(4_194_304)
})

test('reports a missing Git executable without registering or copying', async () => {
  // Arrange
  const world = await createWorld()
  const emptyPath = join(world.root, 'empty-path')
  await mkdir(emptyPath)
  // Act / Assert
  await expect(
    world.cli(['--repo', world.repo, 'foo.md'], { PATH: emptyPath }),
  ).rejects.toThrow('ENOENT')
  expect(
    await lstat(
      join(world.home, '.config', 'laststance-backup', 'config.json'),
    ).catch(() => undefined),
  ).toBeUndefined()
})

test.skipIf(process.platform === 'win32')(
  'prompts for a private clone on first use in a terminal',
  async () => {
    // Arrange
    const world = await createWorld()
    await put(join(world.source, 'foo.md'), 'interactive\n')
    const entry = join(projectRoot, 'dist', 'cli.js')
    const args = [
      join(projectRoot, 'test', 'fixtures', 'terminal.py'),
      nodePath,
      entry,
      'foo.md',
      world.repo,
    ]
    // Act
    const result = await runCommand('python3', args, {
      cwd: world.source,
      env: world.env,
      timeoutMs: 15_000,
    })
    // Assert
    expect(result.stdout).toContain('Existing private GitHub clone directory:')
    expect(
      (await world.git(['show', 'main:foo.md'], world.remote)).stdout,
    ).toBe('interactive\n')
  },
)
