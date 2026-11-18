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
import { scanSource, validateDestination } from '../src/filetree'
import { readRepository } from '../src/git'
import { runCommand } from '../src/utils/run-command'
import { createWorld, put, useFixtures } from './helpers'

useFixtures()

test('publishes a replaced hardlink as a symlink after another operand updates the original inode', async () => {
  // Arrange
  const world = await createWorld()
  await put(join(world.repo, 'first'), 'original')
  await link(join(world.repo, 'first'), join(world.repo, 'second'))
  await world.commit()
  await symlink('second', join(world.source, 'first'))
  await put(join(world.source, 'second'), 'replacement')

  // Act
  await world.cli(['--repo', world.repo, 'first', 'second'])

  // Assert
  expect(await readlink(join(world.repo, 'first'))).toBe('second')
  expect(
    (await world.git(['ls-tree', 'main', 'first'], world.remote)).stdout,
  ).toStartWith('120000 blob ')
  expect((await world.git(['show', 'main:first'], world.remote)).stdout).toBe(
    'second',
  )
  expect((await world.git(['show', 'main:second'], world.remote)).stdout).toBe(
    'replacement',
  )
})

test('publishes both Unicode normalization forms when the copy volume stores them separately', async () => {
  // Arrange
  const world = await createWorld()
  await world.git(['config', 'core.precomposeUnicode', 'false'])
  const source = join(world.source, 'names')
  await put(join(source, 'Café'), 'composed')
  await put(join(source, 'Cafe\u0301'), 'decomposed')
  const sourceNames = await readdir(source)

  // Act
  await world.cli(['--repo', world.repo, 'names'])

  // Assert
  const names = (
    await world.git(['ls-tree', '-rz', '--name-only', 'main'], world.remote)
  ).stdout
    .split('\0')
    .filter(Boolean)
  if (sourceNames.length === 1) {
    // Some volumes preserve the first spelling, others return decomposed names from readdir.
    expect(names.map((name) => name.normalize('NFC'))).toEqual(['names/Café'])
    expect(
      (await world.git(['show', 'main:' + names[0]], world.remote)).stdout,
    ).toBe('decomposed')
  } else {
    expect(names).toEqual(['names/Cafe\u0301', 'names/Café'])
    expect(
      (await world.git(['show', 'main:names/Café'], world.remote)).stdout,
    ).toBe('composed')
    expect(
      (await world.git(['show', 'main:names/Cafe\u0301'], world.remote)).stdout,
    ).toBe('decomposed')
  }
})

test.skipIf(process.platform !== 'darwin')(
  'publishes under the tracked Unicode spelling on case-sensitive APFS while preserving distinct ASCII case',
  async () => {
    // Arrange
    const world = await createWorld()
    const mount = join(world.root, 'mounted')
    const checkout = join(mount, 'checkout')
    const image = join(world.root, 'volume.sparseimage')
    await mkdir(mount)
    await world.git(['config', 'core.precomposeUnicode', 'false'])
    await world.git(['config', 'core.ignoreCase', 'false'])
    await put(join(world.repo, 'Cafe\u0301', 'keep'), 'original')
    await world.commit()
    await put(join(world.source, 'Café', 'note'), 'selected')
    await put(join(world.source, 'one', 'Note'), 'uppercase')
    await put(join(world.source, 'two', 'note'), 'lowercase')
    await runCommand('hdiutil', [
      'create',
      '-size',
      '64m',
      '-fs',
      'Case-sensitive APFS',
      '-volname',
      'BackupNames',
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
      // The Git directory on the original volume gives the private operands different name rules.
      await world.git(['worktree', 'add', '-b', 'folding', checkout])

      // Act
      await world.cli(['--repo', checkout, 'Café', 'one/Note', 'two/note'])

      // Assert
      expect(
        (
          await world.git(
            ['ls-tree', '-rz', '--name-only', 'folding'],
            world.remote,
          )
        ).stdout.split('\0'),
      ).toEqual(['Cafe\u0301/keep', 'Cafe\u0301/note', 'Note', 'note', ''])
      expect(
        (await world.git(['show', 'folding:Note'], world.remote)).stdout,
      ).toBe('uppercase')
      expect(
        (await world.git(['show', 'folding:note'], world.remote)).stdout,
      ).toBe('lowercase')
    } finally {
      await runCommand('hdiutil', ['detach', mount])
    }
  },
  60_000,
)

test.skipIf(process.platform === 'win32').each(['existing', 'earlier operand'])(
  'rejects a regular-file write to a FIFO from %s during preflight',
  async (origin) => {
    // Arrange
    const world = await createWorld()
    const signal = new AbortController().signal
    const repository = await readRepository(world.repo, signal)
    const pipe = join(
      origin === 'existing' ? world.repo : world.source,
      'channel',
    )
    await runCommand('mkfifo', [pipe])
    const file = join(world.source, 'regular', 'channel')
    await put(file, 'backup bytes')
    const sources =
      origin === 'existing' ? [] : [await scanSource(pipe, repository, signal)]
    sources.push(await scanSource(file, repository, signal))

    // Act / Assert
    await expect(
      validateDestination(sources, repository, signal),
    ).rejects.toThrow(
      'Cannot copy a regular file into a destination FIFO: "channel"',
    )
    expect((await lstat(pipe)).isFIFO()).toBe(true)
  },
)

test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'updates an existing writable file in a read-only clone root',
  async () => {
    // Arrange
    const world = await createWorld()
    await put(join(world.repo, 'note'), 'original')
    await world.commit()
    await put(join(world.source, 'note'), 'updated')
    await chmod(world.repo, 0o555)

    try {
      // Act
      await world.cli(['--repo', world.repo, 'note'])

      // Assert
      expect(
        (await world.git(['show', 'main:note'], world.remote)).stdout,
      ).toBe('updated')
    } finally {
      await chmod(world.repo, 0o755)
    }
  },
)

test.skipIf(process.platform !== 'darwin')(
  'uses HFS+ lookup for sharp-s and overwrites a tracked file with a read-only worktree on a separate device',
  async () => {
    // Arrange
    const world = await createWorld()
    const mount = join(world.root, 'hfs')
    const checkout = join(mount, 'checkout')
    const reference = join(mount, 'reference')
    const image = join(world.root, 'hfs.sparseimage')
    await mkdir(mount)
    await put(join(world.repo, 'report.txt'), 'initial')
    await world.commit()
    await put(join(world.source, 'one', 'straße.txt'), 'sharp-s')
    await put(join(world.source, 'two', 'strasse.txt'), 'double-s')
    await put(join(world.source, 'report.txt'), 'updated')
    await runCommand('hdiutil', [
      'create',
      '-size',
      '64m',
      '-fs',
      'HFS+',
      '-volname',
      'BackupHFS',
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
      await world.git(['worktree', 'add', '-b', 'hfs', checkout])
      await mkdir(reference)
      await runCommand(
        '/bin/cp',
        ['-R', '--', 'one/straße.txt', 'two/strasse.txt', reference],
        { cwd: world.source },
      )

      // Act
      await world.cli(['--repo', checkout, 'one/straße.txt', 'two/strasse.txt'])
      await chmod(checkout, 0o555)
      try {
        await world.cli(['--repo', checkout, 'report.txt'])
      } finally {
        await chmod(checkout, 0o755)
      }

      // Assert
      const expected = await readdir(reference)
      expect(expected.sort()).toEqual(['strasse.txt', 'straße.txt'])
      expect(
        (
          await world.git(
            ['ls-tree', '-rz', '--name-only', 'hfs'],
            world.remote,
          )
        ).stdout.split('\0'),
      ).toEqual(['report.txt', ...expected, ''])
      for (const name of expected) {
        expect(
          (await world.git(['show', 'hfs:' + name], world.remote)).stdout,
        ).toBe(await readFile(join(reference, name), 'utf8'))
      }
      expect(
        (await world.git(['show', 'hfs:report.txt'], world.remote)).stdout,
      ).toBe('updated')
    } finally {
      await runCommand('hdiutil', ['detach', mount])
    }
  },
  60_000,
)
