import { expect, test } from 'bun:test'
import { chmod, lstat, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { restoreCopiedModes } from '../src/restored-modes'
import { restoredIndexEntry, signature } from '../src/utils/restored-copy'
import { readRepository } from '../src/git'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { runCommand } from '../src/utils/run-command'
import { createWorld, put, useFixtures } from './helpers'

useFixtures()

test('publishes each nested file under its original parent even when basenames repeat', async () => {
  // Arrange
  const world = await createWorld()
  await put(join(world.source, 'collection', 'first', 'notes'), 'one')
  await put(join(world.source, 'collection', 'middle', 'draft'), 'two')
  await put(join(world.source, 'collection', 'last', 'notes'), 'three')

  // Act
  await world.cli(['--repo', world.repo, 'collection'])

  // Assert
  const readRemote = async (name: string) =>
    (await world.git(['show', `main:collection/${name}`], world.remote)).stdout
  expect(await readRemote('first/notes')).toBe('one')
  expect(await readRemote('middle/draft')).toBe('two')
  expect(await readRemote('last/notes')).toBe('three')
})

test.skipIf(process.platform !== 'darwin')(
  'publishes a deny-delete directory and removes its private copy while preserving the source ACL',
  async () => {
    // Arrange
    const world = await createWorld()
    const documents = join(world.source, 'Documents')
    await put(join(documents, 'note'), 'saved')
    await runCommand('/bin/chmod', [
      '+a',
      'group:everyone deny delete',
      documents,
      join(documents, 'note'),
    ])
    try {
      // Act
      await world.cli(['--repo', world.repo, 'Documents'])

      // Assert
      expect(
        (await world.git(['show', 'main:Documents/note'], world.remote)).stdout,
      ).toBe('saved')
      expect(
        (await readdir(join(world.repo, '.git'))).filter((name) =>
          name.startsWith('laststance-backup-payload-'),
        ),
      ).toEqual([])
      expect(
        (await runCommand('/bin/ls', ['-lde', documents])).stdout,
      ).toContain('group:everyone deny delete')
    } finally {
      // macOS can also retain ACLs on the destination of the final native copy.
      await runCommand('/bin/chmod', ['-R', '-P', '-N', world.root])
    }
  },
)

test.skipIf(process.platform !== 'darwin')(
  'repeats a backup with native write-only permissions and rejects a later local edit or different staged blob',
  async () => {
    // Arrange
    const world = await createWorld()
    const source = join(world.source, 'report')
    const copy = join(world.repo, 'report')
    await put(source, 'first')
    await chmod(source, 0o240)
    await runCommand('/bin/chmod', [
      '+a',
      `user:${userInfo().username} allow read,readattr,readextattr,readsecurity`,
      source,
    ])
    await world.cli(['--repo', world.repo, 'report'])

    // Act
    const repeat = await world.cli(['report'])

    // Assert
    expect(repeat.stdout).toContain('Unchanged')
    expect((await lstat(copy)).mode & 0o777).toBe(0o240)
    expect(
      (
        await world.git(['rev-list', '--count', 'main'], world.remote)
      ).stdout.trim(),
    ).toBe('1')

    // Arrange / Act: a clean index with a different committed blob must invalidate the saved proof.
    const alternate = join(world.root, 'alternate')
    await put(alternate, 'other')
    const { stdout: oid } = await world.git(['hash-object', '-w', alternate])
    await world.git([
      'update-index',
      '--cacheinfo',
      `100644,${oid.trim()},report`,
    ])
    await world.git(['commit', '-qm', 'Different index content'])

    // Assert
    await expect(world.cli(['report'])).rejects.toThrow('uncommitted changes')

    // Arrange / Act: same-length worktree edits must also invalidate the proof for the original blob.
    await world.git(['reset', '--mixed', 'HEAD^'])
    await writeFile(copy, 'local')

    // Assert
    await expect(world.cli(['report'])).rejects.toThrow('uncommitted changes')
    expect(
      (await world.git(['show', 'main:report'], world.remote)).stdout,
    ).toBe('first')
  },
)

test.skipIf(process.platform !== 'darwin')(
  'retries a retained commit and restores both restricted files after the first receipt write fails',
  async () => {
    // Arrange
    const world = await createWorld()
    for (const name of ['one', 'two']) {
      const file = join(world.source, name)
      await put(file, name)
      await chmod(file, 0o240)
      await runCommand('/bin/chmod', [
        '+a',
        `user:${userInfo().username} allow read,readattr,readextattr,readsecurity`,
        file,
      ])
    }
    const blocked = join(
      world.repo,
      '.git',
      'laststance-backup-restored-modes',
      createHash('sha256').update('one').digest('hex'),
    )
    await mkdir(blocked, { recursive: true })

    // Act
    await expect(
      world.cli(['--repo', world.repo, 'one', 'two']),
    ).rejects.toThrow('push validation')
    const retained = (await world.git(['rev-parse', 'HEAD'])).stdout
    for (const name of ['one', 'two'])
      expect((await lstat(join(world.repo, name))).mode & 0o777).toBe(0o640)
    await rm(blocked, { recursive: true })
    // An interrupted restoration may have closed the last readable descriptor before the receipt existed.
    await chmod(join(world.repo, 'one'), 0o240)
    await expect(world.cli(['one', 'two'])).rejects.toThrow(
      'Restore owner-read on this file',
    )
    expect(await readdir(join(world.repo, '.git'))).toContain(
      'laststance-backup-pending-modes.json',
    )
    await chmod(join(world.repo, 'one'), 0o640)
    await world.cli(['one', 'two'])

    // Assert
    expect((await world.git(['rev-parse', 'main'], world.remote)).stdout).toBe(
      retained,
    )
    expect(
      (
        await world.git(['rev-list', '--count', 'main'], world.remote)
      ).stdout.trim(),
    ).toBe('1')
    for (const name of ['one', 'two'])
      expect((await lstat(join(world.repo, name))).mode & 0o777).toBe(0o240)
    expect(await readdir(join(world.repo, '.git'))).not.toContain(
      'laststance-backup-pending-modes.json',
    )

    // An earlier planner sample cannot authorize a subsequently edited file.
    const one = join(world.repo, 'one')
    const before = await lstat(one, { bigint: true })
    await writeFile(one, 'new')
    const repository = await readRepository(
      world.repo,
      new AbortController().signal,
    )
    expect(await restoredIndexEntry(repository, 'one', before)).toBeUndefined()
  },
)

test.skipIf(process.platform !== 'darwin')(
  'records restricted HFS+ files only after their shared one-second timestamp tick has ended',
  async () => {
    // Arrange
    const world = await createWorld()
    const mount = join(world.root, 'coarse'),
      image = join(world.root, 'hfs.sparseimage')
    await mkdir(mount)
    await runCommand('hdiutil', [
      'create',
      '-size',
      '32m',
      '-fs',
      'HFS+',
      '-volname',
      'BackupReceipts',
      '-type',
      'SPARSE',
      '-o',
      image,
    ])
    await runCommand('hdiutil', [
      'attach',
      image,
      '-owners',
      'on',
      '-mountpoint',
      mount,
      '-nobrowse',
    ])
    try {
      const gitDirectory = join(mount, '.git')
      await mkdir(gitDirectory)
      const repository = {
        directory: mount,
        gitDirectory,
        commonDirectory: gitDirectory,
        objectFormat: 'sha1' as const,
      }
      const files = new Map<
        string,
        { mode: string; oid: string; signature: string }
      >()
      for (const key of ['one', 'two']) {
        const path = join(mount, key)
        await put(path, 'data')
        await chmod(path, 0o640)
        files.set(key, {
          mode: '100644',
          oid: createHash('sha1').update('blob 4\0data').digest('hex'),
          signature: signature(await lstat(path, { bigint: true })),
        })
      }

      // Act
      await restoreCopiedModes(repository, new Set(files.keys()), files)

      // Assert
      for (const key of files.keys()) {
        const restricted = await lstat(join(mount, key), { bigint: true })
        const receipt = await lstat(
          join(
            gitDirectory,
            'laststance-backup-restored-modes',
            createHash('sha256').update(key).digest('hex'),
          ),
          { bigint: true },
        )
        expect(restricted.ctimeNs % 1_000_000_000n).toBe(0n)
        expect(receipt.ctimeNs).toBeGreaterThan(restricted.ctimeNs)
      }
    } finally {
      await runCommand('hdiutil', ['detach', mount])
    }
  },
  60_000,
)
