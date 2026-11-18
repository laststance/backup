import { expect, test } from 'bun:test'
import { chmod, lstat, readdir, writeFile } from 'node:fs/promises'
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
