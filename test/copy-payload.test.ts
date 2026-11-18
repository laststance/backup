import { expect, test } from 'bun:test'
import { readdir } from 'node:fs/promises'
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
