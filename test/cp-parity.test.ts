import { expect, test } from 'bun:test'
import {
  chmod,
  link,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  symlink,
} from 'node:fs/promises'
import { join } from 'node:path'
import { userInfo } from 'node:os'
import { text } from 'node:stream/consumers'
import { runCommand } from '../src/utils/run-command'
import { createWorld, nodePath, projectRoot, put, useFixtures } from './helpers'

useFixtures()

// PowerShell aliases cp to Copy-Item. Invoke Git for Windows' actual GNU binary for the reference run.
const referenceCp =
  process.platform === 'win32'
    ? join(
        (await runCommand('git', ['--exec-path'])).stdout.trimEnd(),
        '../../../usr/bin/cp.exe',
      )
    : '/bin/cp'
const referenceEnv =
  process.platform === 'win32'
    ? { ...process.env, MSYS: 'winsymlinks:nativestrict' }
    : process.env

/** Records observable copy results for comparing a clone's payload with the native cp reference.
 * @example await snapshot(reference)
 */
async function snapshot(
  root: string,
  parent = '',
): Promise<Record<string, unknown>> {
  const entries: Record<string, unknown> = Object.create(null)
  for (const name of await readdir(join(root, parent))) {
    // Only the test clone's own repository metadata is outside its payload.
    if (!parent && name === '.git') continue
    const key = parent ? `${parent}/${name}` : name
    const path = join(root, key)
    const stats = await lstat(path)
    const mode = stats.mode & 0o7777
    if (stats.isDirectory()) {
      entries[key] = { directory: true, mode }
      Object.assign(entries, await snapshot(root, key))
    } else if (stats.isSymbolicLink()) {
      entries[key] = { link: await readlink(path) }
    } else if (stats.isSocket()) {
      entries[key] = { socket: true, mode }
    } else if (stats.isFIFO()) {
      entries[key] = { fifo: true, mode }
    } else {
      entries[key] = { bytes: (await readFile(path)).toString('hex'), mode }
    }
  }
  return entries
}

test('merges a tree exactly like cp, including destination-only entries, permissions, hidden files, and empty directories', async () => {
  // Arrange
  const world = await createWorld()
  const reference = join(world.root, 'reference')
  for (const destination of [reference, world.repo]) {
    await put(join(destination, 'notes', 'keep'), 'destination only\n')
    await put(join(destination, 'notes', 'edit'), 'previous\n')
    await chmod(join(destination, 'notes', 'edit'), 0o640)
  }
  await world.commit()
  await put(join(world.source, 'notes', 'edit'), 'replacement\n')
  await chmod(join(world.source, 'notes', 'edit'), 0o755)
  await put(
    join(world.source, 'notes', '.hidden'),
    new Uint8Array([0, 255, 13, 10]),
  )
  await mkdir(join(world.source, 'notes', 'empty'), { mode: 0o700 })

  // Act
  await runCommand(referenceCp, ['-R', '--', 'notes', reference], {
    cwd: world.source,
    env: referenceEnv,
  })
  await world.cli(['--repo', world.repo, 'notes'])

  // Assert
  expect(await snapshot(world.repo)).toEqual(await snapshot(reference))
  expect(
    (await world.git(['show', 'main:notes/keep'], world.remote)).stdout,
  ).toBe('destination only\n')
  expect(
    (await world.git(['show', 'main:notes/edit'], world.remote)).stdout,
  ).toBe('replacement\n')
})

test.each([
  'nested/tree',
  'nested/tree/',
  'nested/tree/.',
  'nested/tree/document',
  '.',
  '../source/nested/tree/document',
])(
  'places the operand %j in the same location as cp on this system',
  async (operand) => {
    // Arrange
    const world = await createWorld()
    const reference = join(world.root, 'reference')
    await mkdir(reference)
    await put(join(world.source, 'nested', 'tree', 'document'), 'payload')
    await symlink('document', join(world.source, 'nested', 'tree', 'link'))

    // Act
    await runCommand(referenceCp, ['-R', '--', operand, reference], {
      cwd: world.source,
      env: referenceEnv,
    })
    await world.cli(['--repo', world.repo, operand])

    // Assert
    expect(await snapshot(world.repo)).toEqual(await snapshot(reference))
  },
)

/** Runs identical operands through the host cp and the installed-style CLI, including their partial trees on failure.
 * @example const status = await compareCopy(world, reference, ['a', 'b'])
 */
async function compareCopy(
  world: Awaited<ReturnType<typeof createWorld>>,
  reference: string,
  operands: string[],
) {
  const options = {
    cwd: world.source,
    env: { ...referenceEnv, ...world.env },
    allowFailure: true,
  }
  const expected = await runCommand(
    referenceCp,
    ['-R', '--', ...operands, reference],
    options,
  )
  const actual = await runCommand(
    nodePath,
    [
      join(projectRoot, 'dist', 'cli.js'),
      '--repo',
      world.repo,
      '--',
      ...operands,
    ],
    options,
  )
  expect(
    actual.exitCode === 0,
    `backup: ${actual.stderr}\ncp: ${expected.stderr}`,
  ).toBe(expected.exitCode === 0)
  expect(await snapshot(world.repo)).toEqual(await snapshot(reference))
  return expected.exitCode
}

test.skipIf(process.platform === 'win32').each([
  ['file', 'directory'],
  ['file', 'symlink'],
  ['file', 'dangling'],
  ['directory', 'file'],
  ['directory', 'symlink'],
  ['directory', 'dangling'],
  ['symlink', 'file'],
  ['symlink', 'directory'],
  ['symlink', 'symlink'],
  ['symlink', 'dangling'],
])(
  'matches native cp when a source %s meets a destination %s, including partial writes',
  async (sourceKind, destinationKind) => {
    // Arrange
    const world = await createWorld()
    const reference = join(world.root, 'reference')
    for (const destination of [reference, world.repo]) {
      await put(join(destination, 'notes', 'before'), 'old\n')
      await put(join(destination, 'notes', 'referent'), 'retained\n')
      const leaf = join(destination, 'notes', 'leaf')
      if (destinationKind === 'file') await put(leaf, 'old leaf\n')
      else if (destinationKind === 'directory')
        await put(join(leaf, 'resident'), 'resident\n')
      else
        await symlink(
          destinationKind === 'dangling' ? 'absent' : 'referent',
          leaf,
        )
    }
    await world.commit()
    await put(join(world.source, 'notes', 'before'), 'new\n')
    await put(join(world.source, 'notes', 'after'), 'new sibling\n')
    const leaf = join(world.source, 'notes', 'leaf')
    if (sourceKind === 'file') await put(leaf, 'replacement\n')
    else if (sourceKind === 'directory')
      await put(join(leaf, 'child'), 'child\n')
    else await symlink('../dangling', leaf)

    // Act
    const status = await compareCopy(world, reference, ['notes'])

    // Assert
    const remote = await world
      .git(['rev-parse', '--verify', 'main'], world.remote)
      .catch(() => undefined)
    expect(Boolean(remote)).toBe(status === 0)
    if (
      sourceKind === 'file' &&
      destinationKind === 'symlink' &&
      status === 0
    ) {
      expect(
        (await world.git(['show', 'main:notes/referent'], world.remote)).stdout,
      ).toBe('replacement\n')
      expect(
        (await world.git(['show', 'main:notes/leaf'], world.remote)).stdout,
      ).toBe('referent')
    }
  },
)

test.each(
  [
    ['nested/a', '-draft', 'notes'],
    ['nested/a', 'missing', '-draft'],
    ['nested/a', 'other/a'],
    ['nested/box', 'other/box'],
    ['link', 'dangling'],
    ['linked-directory/'],
    ['linked-directory/../choice'],
    ['nested/a/'],
    ['-draft', 'nested/a/', 'notes'],
  ].map((operands) => ({ operands })),
)(
  'copies multiple, missing, or link-qualified operands with native cp results ($operands)',
  async ({ operands }) => {
    // Arrange
    const world = await createWorld()
    const reference = join(world.root, 'reference')
    await mkdir(reference)
    await put(join(world.source, 'nested', 'a'), 'first\n')
    await put(join(world.source, 'other', 'a'), 'second\n')
    await put(join(world.source, 'nested', 'box', 'left'), 'left\n')
    await put(join(world.source, 'other', 'box', 'right'), 'right\n')
    await put(join(world.source, '-draft'), 'leading dash\n')
    await put(
      join(
        world.source,
        'notes',
        process.platform === 'win32' ? '中文' : '中\n文',
      ),
      'newline\n',
    )
    await put(join(world.source, 'other', 'choice'), 'physical parent\n')
    await symlink('nested/a', join(world.source, 'link'))
    await symlink('absent', join(world.source, 'dangling'))
    await symlink('other/box', join(world.source, 'linked-directory'), 'dir')

    // Act
    const status = await compareCopy(world, reference, operands)

    // Assert
    const commits = await world
      .git(['rev-list', '--count', 'main'], world.remote)
      .catch(() => undefined)
    expect(commits?.stdout.trim()).toBe(status === 0 ? '1' : undefined)
  },
)

test.skipIf(process.platform === 'win32')(
  'updates both existing hardlinks in place and recreates a named pipe like cp',
  async () => {
    // Arrange
    const world = await createWorld()
    const reference = join(world.root, 'reference')
    for (const destination of [reference, world.repo]) {
      await put(join(destination, 'document'), 'old')
      await link(join(destination, 'document'), join(destination, 'alias'))
    }
    await world.commit()
    await put(join(world.source, 'document'), 'new')
    await runCommand('mkfifo', [join(world.source, 'pipe')])

    // Act
    const status = await compareCopy(world, reference, ['document', 'pipe'])

    // Assert
    expect(status).toBe(0)
    expect((await lstat(join(world.repo, 'document'))).ino).toBe(
      (await lstat(join(world.repo, 'alias'))).ino,
    )
    expect((await world.git(['show', 'main:alias'], world.remote)).stdout).toBe(
      'new',
    )
  },
)

test.skipIf(process.platform === 'win32')(
  'rejects a write through a destination symlink redirected outside the clone by an earlier operand',
  async () => {
    // Arrange
    const world = await createWorld()
    const outside = join(world.root, 'outside')
    await put(outside, 'keep\n')
    await symlink('redirect', join(world.repo, 'document'))
    await world.commit()
    await symlink(outside, join(world.source, 'redirect'))
    await put(join(world.source, 'document'), 'replacement\n')

    // Act / Assert
    await expect(
      world.cli(['--repo', world.repo, 'redirect', 'document']),
    ).rejects.toThrow('escapes the backup')
    expect(await readFile(outside, 'utf8')).toBe('keep\n')
    expect((await world.git(['status', '--porcelain'])).stdout).toBe('')
  },
)

test.skipIf(process.platform !== 'darwin')(
  'preserves macOS extended attributes on the local copy just like cp -R',
  async () => {
    // Arrange
    const world = await createWorld()
    const reference = join(world.root, 'reference')
    await mkdir(reference)
    await put(join(world.source, 'document'), 'payload\n')
    await runCommand('xattr', [
      '-w',
      'io.laststance.backup-test',
      'metadata',
      join(world.source, 'document'),
    ])

    // Act
    const status = await compareCopy(world, reference, ['document'])

    // Assert
    expect(status).toBe(0)
    for (const directory of [reference, world.repo]) {
      expect(
        (
          await runCommand('xattr', [
            '-p',
            'io.laststance.backup-test',
            join(directory, 'document'),
          ])
        ).stdout.trimEnd(),
      ).toBe('metadata')
    }
  },
)

test.skipIf(process.platform === 'win32')(
  'handles a filesystem socket like native cp and publishes its regular sibling',
  async () => {
    // Arrange
    const world = await createWorld()
    const reference = join(world.root, 'reference')
    await mkdir(reference)
    await put(join(world.source, 'document'), 'regular\n')
    await runCommand(
      'python3',
      [
        '-c',
        "import socket; sock = socket.socket(socket.AF_UNIX); sock.bind('socket')",
      ],
      { cwd: world.source },
    )

    // Act
    const status = await compareCopy(world, reference, ['socket', 'document'])

    // Assert
    expect(status).toBe(0)
    expect(
      (await world.git(['ls-tree', '-r', '--name-only', 'main'], world.remote))
        .stdout,
    ).toBe('document\n')
  },
)

test.skipIf(process.platform === 'win32')(
  'excludes source Git metadata while preserving a FIFO and a read-only directory',
  async () => {
    // Arrange
    const world = await createWorld()
    const tree = join(world.source, 'project')
    await put(join(tree, '.git', 'config'), 'excluded')
    await put(join(tree, 'locked', 'note'), 'published')
    await runCommand('mkfifo', [join(tree, 'pipe')])
    await chmod(join(tree, 'locked'), 0o555)
    try {
      // Act
      await world.cli(['--repo', world.repo, 'project'])

      // Assert
      expect((await lstat(join(world.repo, 'project', 'pipe'))).isFIFO()).toBe(
        true,
      )
      expect(
        (await lstat(join(world.repo, 'project', 'locked'))).mode & 0o777,
      ).toBe(0o555)
      expect(await readdir(join(world.repo, 'project'))).not.toContain('.git')
      expect(
        (
          await world.git(
            ['ls-tree', '-r', '--name-only', 'main'],
            world.remote,
          )
        ).stdout,
      ).toBe('project/locked/note\n')
      expect(
        (await readdir(join(world.repo, '.git'))).filter((name) =>
          name.startsWith('laststance-backup-payload-'),
        ),
      ).toEqual([])
    } finally {
      await chmod(join(tree, 'locked'), 0o755)
      await chmod(join(world.repo, 'project', 'locked'), 0o755).catch(() => {})
    }
  },
)

test('publishes the native result when two new basenames differ only in case', async () => {
  // Arrange
  const world = await createWorld()
  const reference = join(world.root, 'reference')
  await mkdir(reference)
  await put(join(world.source, 'one', 'Note.txt'), 'first')
  await put(join(world.source, 'two', 'note.txt'), 'second')

  // Act
  const status = await compareCopy(world, reference, [
    'one/Note.txt',
    'two/note.txt',
  ])

  // Assert
  const branches = await world.git(
    ['for-each-ref', '--format=%(refname)'],
    world.remote,
  )
  expect(branches.stdout).toBe(status === 0 ? 'refs/heads/main\n' : '')
  if (status === 0) {
    for (const name of await readdir(reference)) {
      expect(
        (await world.git(['show', `main:${name}`], world.remote)).stdout,
      ).toBe(await readFile(join(reference, name), 'utf8'))
    }
  }
})

test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'keeps readable siblings before and after an unreadable input without publishing a partial backup',
  async () => {
    // Arrange
    const world = await createWorld()
    const reference = join(world.root, 'reference')
    await mkdir(reference)
    await put(join(world.source, 'before'), 'first')
    await put(join(world.source, 'blocked'), 'unreadable')
    await put(join(world.source, 'after'), 'last')
    await chmod(join(world.source, 'blocked'), 0)
    try {
      // Act
      const status = await compareCopy(world, reference, [
        'before',
        'blocked',
        'after',
      ])

      // Assert
      expect(status).toBe(1)
      expect(await readdir(world.repo)).toContain('after')
      expect((await world.git(['for-each-ref'], world.remote)).stdout).toBe('')
    } finally {
      await chmod(join(world.source, 'blocked'), 0o600)
    }
  },
)

test.skipIf(process.platform !== 'darwin')(
  'preserves a directory extended attribute when its Git metadata is excluded',
  async () => {
    // Arrange
    const world = await createWorld()
    const reference = join(world.root, 'reference')
    await mkdir(reference)
    await put(join(world.source, 'notes', '.git', 'description'), 'excluded')
    await put(join(world.source, 'notes', 'entry'), 'published')
    const attr = 'io.laststance.backup-test'
    await runCommand('xattr', [
      '-w',
      attr,
      'hello',
      join(world.source, 'notes'),
    ])

    // Act
    await runCommand(referenceCp, ['-R', 'notes', reference], {
      cwd: world.source,
    })
    await world.cli(['--repo', world.repo, 'notes'])

    // Assert
    for (const directory of [reference, world.repo]) {
      expect(
        (
          await runCommand('xattr', ['-p', attr, join(directory, 'notes')])
        ).stdout.trim(),
      ).toBe('hello')
    }
    expect(await readdir(join(world.repo, 'notes'))).toEqual(['entry'])
  },
)

test('publishes a large list of short relative operands from a deep directory with the full commit message', async () => {
  // Arrange
  const world = await createWorld()
  const windows = process.platform === 'win32'
  const cwd = windows
    ? world.source
    : join(world.source, ...Array<string>(4).fill('d'.repeat(135)))
  const reference = join(world.root, 'reference')
  // Darwin caps the entire argv, while Linux also caps each individual argument.
  const count = process.platform === 'darwin' ? 1_500 : 600
  const names = Array.from(
    { length: count },
    (_, i) => `${String(i).padStart(4, '0')}-${'f'.repeat(windows ? 8 : 220)}`,
  )
  await mkdir(reference)
  for (const name of names) await put(join(cwd, name), 'payload')

  // Act
  await runCommand(referenceCp, ['-R', '--', ...names, reference], {
    cwd,
    env: referenceEnv,
  })
  await runCommand(
    nodePath,
    [join(projectRoot, 'dist', 'cli.js'), '--repo', world.repo, '--', ...names],
    {
      cwd,
      env: world.env,
      timeoutMs: 120_000,
      consume: async (output) => {
        await text(output)
      },
    },
  )

  // Assert
  expect(await readdir(reference)).toHaveLength(count)
  expect(
    (await readdir(world.repo)).filter((name) => name !== '.git').sort(),
  ).toEqual(names)
  let message = ''
  await runCommand(
    'git',
    ['-C', world.remote, 'log', '-1', '--format=%s', 'main'],
    {
      env: world.env,
      consume: async (output) => {
        message = await text(output)
      },
    },
  )
  expect(message.trimEnd()).toBe('chore(backup): update ' + names.join(', '))
}, 120_000)

test.skipIf(process.platform !== 'darwin')(
  'merges case-distinct children of a single source tree as native cp does on the destination volume',
  async () => {
    // Arrange
    const world = await createWorld()
    const mount = join(world.source, 'mounted')
    const reference = join(world.root, 'reference')
    const image = join(world.root, 'source.sparseimage')
    await mkdir(mount)
    await mkdir(reference)
    await runCommand('hdiutil', [
      'create',
      '-size',
      '64m',
      '-fs',
      'Case-sensitive APFS',
      '-volname',
      'BackupParity',
      '-type',
      'SPARSE',
      '-o',
      image,
    ])
    await runCommand('hdiutil', [
      'attach',
      image,
      '-mountpoint',
      mount,
      '-nobrowse',
    ])
    try {
      const tree = join(mount, 'tree')
      await put(join(tree, 'Docs', 'left'), 'left')
      await put(join(tree, 'docs', 'right'), 'right')
      await put(join(tree, 'Aa'), 'first')
      await put(join(tree, 'aa'), 'second')

      // Act
      const status = await compareCopy(world, reference, ['mounted/tree'])

      // Assert
      expect(status).toBe(0)
      const entries = (
        await world.git(['ls-tree', '-r', '--name-only', 'main'], world.remote)
      ).stdout
        .trimEnd()
        .split('\n')
      for (const path of entries) {
        expect(
          (await world.git(['show', 'main:' + path], world.remote)).stdout,
        ).toBe(await readFile(join(reference, path), 'utf8'))
      }
      expect(
        await readFile(join(world.repo, 'tree', 'Docs', 'left'), 'utf8'),
      ).toBe('left')
      expect(
        await readFile(join(world.repo, 'tree', 'docs', 'right'), 'utf8'),
      ).toBe('right')
    } finally {
      await runCommand('hdiutil', ['detach', mount])
    }
  },
  60_000,
)

test.skipIf(process.platform !== 'darwin')(
  'overwrites a tracked file when an ACL grants read access to a source without owner-read',
  async () => {
    // Arrange
    const world = await createWorld()
    const file = join(world.source, 'note')
    await put(file, 'updated')
    await chmod(file, 0o040)
    await runCommand('chmod', [
      '+a',
      `user:${userInfo().username} allow read,readattr,readextattr,readsecurity`,
      file,
    ])
    await put(join(world.repo, 'note'), 'original')
    await chmod(join(world.repo, 'note'), 0o640)
    await world.commit()

    // Act
    await world.cli(['--repo', world.repo, 'note'])

    // Assert
    expect((await world.git(['show', 'main:note'], world.remote)).stdout).toBe(
      'updated',
    )
    expect((await lstat(join(world.repo, 'note'))).mode & 0o777).toBe(0o640)
  },
)

test.skipIf(process.platform !== 'darwin')(
  'publishes Finder-locked files and cleans up the private copy',
  async () => {
    // Arrange
    const world = await createWorld()
    const reference = join(world.root, 'reference')
    await mkdir(reference)
    const note = join(world.source, 'notes', 'note')
    await put(note, 'locked')
    await runCommand('chflags', ['uchg', note])
    try {
      // Act
      const status = await compareCopy(world, reference, ['notes'])

      // Assert
      expect(status).toBe(0)
      expect(
        (await world.git(['show', 'main:notes/note'], world.remote)).stdout,
      ).toBe('locked')
      expect(
        (await readdir(join(world.repo, '.git'))).filter((name) =>
          name.startsWith('laststance-backup-payload-'),
        ),
      ).toEqual([])
    } finally {
      await runCommand('chflags', ['-R', 'nouchg', world.root])
    }
  },
)
