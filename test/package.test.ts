import { expect, test } from 'bun:test'
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  symlink,
} from 'node:fs/promises'
import { join } from 'node:path'
import { version } from '../package.json'
import {
  createWorld,
  npm,
  projectRoot,
  put,
  recover,
  useFixtures,
} from './helpers'

useFixtures()

test('installs the npm tarball and recovers exact files and links using Node without Bun', async () => {
  // Arrange
  const world = await createWorld()
  const packed = join(world.root, 'packed')
  const consumer = join(world.root, 'consumer')
  await Promise.all([mkdir(packed), mkdir(consumer)])
  await npm(['pack', '--pack-destination', packed], projectRoot, {
    ...world.env,
    PATH: process.env.PATH,
  })
  await npm(
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      join(packed, `laststance-backup-${version}.tgz`),
    ],
    consumer,
    world.env,
  )
  const installed = join(consumer, 'node_modules', '@laststance', 'backup')
  const entry = join(installed, 'dist', 'cli.js')
  await put(
    join(world.source, 'notes', 'binary.dat'),
    new Uint8Array([0, 255, 13, 10, 128]),
  )
  await put(join(world.source, 'notes', 'crlf.txt'), 'one\r\ntwo\r\n')
  await put(join(world.source, 'notes', '.gitattributes'), '*.txt -text\n')
  await put(
    join(world.source, 'notes', 'run.sh'),
    '#!/bin/sh\necho backed-up\n',
  )
  if (process.platform !== 'win32')
    await chmod(join(world.source, 'notes', 'run.sh'), 0o755)
  await symlink('../missing.md', join(world.source, 'notes', 'link'))

  // Act
  await npm(
    [
      'exec',
      '--offline',
      '--',
      'backup',
      '--repo',
      world.repo,
      join(world.source, 'notes'),
    ],
    consumer,
    world.env,
  )
  const help = await npm(
    ['exec', '--offline', '--', 'backup', '--help'],
    consumer,
    world.env,
  )
  const reportedVersion = await npm(
    ['exec', '--offline', '--', 'backup', '--version'],
    consumer,
    world.env,
  )
  const restored = await recover(world)

  // Assert
  expect(help.stdout).toContain('Usage: backup')
  expect(reportedVersion.stdout.trim()).toBe(version)
  expect(
    await lstat(join(world.root, 'bun-called')).catch(() => undefined),
  ).toBeUndefined()
  expect([...(await readFile(join(restored, 'notes', 'binary.dat')))]).toEqual([
    0, 255, 13, 10, 128,
  ])
  expect(await readFile(join(restored, 'notes', 'crlf.txt'), 'utf8')).toBe(
    'one\r\ntwo\r\n',
  )
  expect((await lstat(join(restored, 'notes', 'link'))).isSymbolicLink()).toBe(
    true,
  )
  expect(await readlink(join(restored, 'notes', 'link'))).toBe('../missing.md')
  if (process.platform !== 'win32')
    expect((await lstat(join(restored, 'notes', 'run.sh'))).mode & 0o111).toBe(
      0o111,
    )
  expect(
    await lstat(join(installed, 'src')).catch(() => undefined),
  ).toBeUndefined()
  expect(
    await lstat(join(installed, 'test')).catch(() => undefined),
  ).toBeUndefined()
  expect(
    (await readFile(entry, 'utf8')).startsWith('#!/usr/bin/env node\n'),
  ).toBe(true)
  expect(
    JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'))
      .dependencies,
  ).toBeUndefined()
}, 120_000)
