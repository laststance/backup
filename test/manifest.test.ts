import { afterEach, expect, setSystemTime, test } from 'bun:test'
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import {
  createWorld,
  nodePath,
  projectRoot,
  put,
  useFixtures,
} from './helpers'
import { copySource, scanSource, validateDestination } from '../src/filetree'
import { readManifest, writeManifest } from '../src/manifest'
import { readRepository } from '../src/git'
import { writePrivateFileAtomically } from '../src/utils/write-private-file-atomically'

useFixtures()

afterEach(() => {
  setSystemTime()
})

/** Moves the scan clock a minute ahead so fixtures written moments ago count as settled, not racy. */
const settleFixtureTimestamps = () => {
  setSystemTime(new Date(Date.now() + 60_000))
}

test('lists every nested entry when a source directory is scanned in-process', async () => {
  // Value: protects=directory scans finish under Bun as well as Node; fails_when=walkSource reads names from Bun's nameless buffer Dirents and revisits the same directory forever; why_new=earlier direct scans selected single files to dodge the hang; seam=none; no_claim=readdir ordering
  // Arrange
  const world = await createWorld()
  const signal = new AbortController().signal
  const repository = await readRepository(world.repo, signal)
  await put(join(world.source, 'notes', 'a.md'), 'a\n')
  await put(join(world.source, 'notes', 'deep', 'b.md'), 'b\n')

  // Act
  const source = await scanSource(
    join(world.source, 'notes'),
    repository,
    signal,
    'notes',
  )

  // Assert
  expect([...source.entries.keys()].sort()).toEqual([
    'notes',
    'notes/a.md',
    'notes/deep',
    'notes/deep/b.md',
  ])
})

test('rewrites only changed files when a directory is backed up again', async () => {
  // Arrange
  const world = await createWorld()
  await put(join(world.source, 'notes', 'kept.md'), 'kept\n')
  await put(join(world.source, 'notes', 'edited.md'), 'before\n')
  await world.cli(['--repo', world.repo, 'notes'])
  const keptBefore = await lstat(join(world.repo, 'notes', 'kept.md'), {
    bigint: true,
  })
  await put(join(world.source, 'notes', 'edited.md'), 'after\n')

  // Act
  await world.cli(['notes'])

  // Assert
  const keptAfter = await lstat(join(world.repo, 'notes', 'kept.md'), {
    bigint: true,
  })
  expect(keptAfter.ino).toBe(keptBefore.ino)
  expect(keptAfter.mtimeNs).toBe(keptBefore.mtimeNs)
  expect(
    (await world.git(['show', 'main:notes/edited.md'], world.remote)).stdout,
  ).toBe('after\n')
  expect(
    (await world.git(['show', 'main:notes/kept.md'], world.remote)).stdout,
  ).toBe('kept\n')
})

test('backs up a same-size edit made right after the previous backup', async () => {
  // Arrange
  const world = await createWorld()
  await put(join(world.source, 'foo.md'), 'aaaa\n')
  await world.cli(['--repo', world.repo, 'foo.md'])
  await put(join(world.source, 'foo.md'), 'bbbb\n')

  // Act
  const result = await world.cli(['foo.md'])

  // Assert
  expect(result.stdout).toContain('Backed up "foo.md"')
  expect((await world.git(['show', 'main:foo.md'], world.remote)).stdout).toBe(
    'bbbb\n',
  )
})

test('ignores a corrupt manifest cache and still backs up the current bytes', async () => {
  // Arrange
  const world = await createWorld()
  await put(join(world.source, 'foo.md'), 'first\n')
  await world.cli(['--repo', world.repo, 'foo.md'])
  const manifestDirectory = join(
    world.repo,
    '.git',
    'laststance-backup-manifests',
  )
  for (const file of await readdir(manifestDirectory))
    await writeFile(join(manifestDirectory, file), '{"version": 1, "entries"')
  await put(join(world.source, 'foo.md'), 'second\n')

  // Act
  const result = await world.cli(['foo.md'])

  // Assert
  expect(result.stdout).toContain('Backed up "foo.md"')
  expect((await world.git(['show', 'main:foo.md'], world.remote)).stdout).toBe(
    'second\n',
  )
})

test('still backs up and warns when the manifest cannot be written', async () => {
  // Value: protects=a cache write failure never aborts a backup; fails_when=writeManifest errors propagate out of preflight; why_new=only manifest reads were tested as best-effort; seam=none; no_claim=Windows rename contention itself
  // Arrange
  const world = await createWorld()
  await put(join(world.source, 'foo.md'), 'cached or not\n')
  // A regular file where the manifest directory belongs makes every manifest write fail.
  await put(
    join(world.repo, '.git', 'laststance-backup-manifests'),
    'not a directory\n',
  )

  // Act
  const result = spawnSync(
    nodePath,
    [join(projectRoot, 'dist', 'cli.js'), '--repo', world.repo, 'foo.md'],
    { cwd: world.source, env: world.env, encoding: 'utf8' },
  )

  // Assert
  expect(result.status).toBe(0)
  expect(result.stdout).toContain('Backed up "foo.md"')
  expect(result.stderr).toContain(
    'Warning: could not update the backup manifest; the next run rereads every file.',
  )
  expect((await world.git(['show', 'main:foo.md'], world.remote)).stdout).toBe(
    'cached or not\n',
  )
})

test('trusts the recorded blob ID while a settled file keeps identical metadata', async () => {
  // Arrange
  const world = await createWorld()
  const signal = new AbortController().signal
  const repository = await readRepository(world.repo, signal)
  const file = join(world.source, 'notes', 'a.md')
  await put(file, 'recorded\n')
  settleFixtureTimestamps()
  await writeManifest(
    await scanSource(file, repository, signal, 'notes/a.md'),
    repository,
  )
  const manifestDirectory = join(
    world.repo,
    '.git',
    'laststance-backup-manifests',
  )
  const [manifestFile = ''] = await readdir(manifestDirectory)
  const manifest = JSON.parse(
    await readFile(join(manifestDirectory, manifestFile), 'utf8'),
  )
  manifest.entries = [
    ['notes/a.md', manifest.entries[0][1], 'f'.repeat(40)],
  ]
  await writeFile(
    join(manifestDirectory, manifestFile),
    JSON.stringify(manifest),
  )

  // Act
  const rescanned = await scanSource(file, repository, signal, 'notes/a.md')

  // Assert
  expect(rescanned.entries.get('notes/a.md')?.oid).toBe(
    'ffffffffffffffffffffffffffffffffffffffff',
  )
})

test('rereads a recorded file after an edit that keeps its size', async () => {
  // Arrange
  const world = await createWorld()
  const signal = new AbortController().signal
  const repository = await readRepository(world.repo, signal)
  const file = join(world.source, 'notes', 'a.md')
  await put(file, 'recorded\n')
  settleFixtureTimestamps()
  await writeManifest(
    await scanSource(file, repository, signal, 'notes/a.md'),
    repository,
  )
  setSystemTime()
  const recorded = await lstat(file, { bigint: true })
  // Linux stamps files from a coarse clock; rewrite until the edit gets a new mtime, like a real later edit.
  do await put(file, 'replaced\n')
  while ((await lstat(file, { bigint: true })).mtimeNs === recorded.mtimeNs)

  // Act
  const rescanned = await scanSource(file, repository, signal, 'notes/a.md')

  // Assert
  expect(rescanned.entries.get('notes/a.md')?.oid).toBe(
    'feae347d8510cfba5eb8c8ac80056777b07c2528',
  )
})

test('leaves files changed within the last 10 seconds out of the manifest', async () => {
  // Arrange
  const world = await createWorld()
  const signal = new AbortController().signal
  const repository = await readRepository(world.repo, signal)
  const file = join(world.source, 'notes', 'a.md')
  await put(file, 'just written\n')
  const source = await scanSource(file, repository, signal, 'notes/a.md')

  // Act
  await writeManifest(source, repository)

  // Assert
  expect(
    (await readManifest(repository, source.path, 'notes/a.md')).size,
  ).toBe(0)
})

test('stops when an already backed-up file changes during copying', async () => {
  // Arrange
  const world = await createWorld()
  const file = join(world.source, 'notes', 'a.md')
  await put(file, 'stable\n')
  await world.cli(['--repo', world.repo, 'notes/a.md'])
  const signal = new AbortController().signal
  const repository = await readRepository(world.repo, signal)
  settleFixtureTimestamps()
  const source = await scanSource(file, repository, signal, 'notes/a.md')
  await validateDestination(source, repository, signal)
  setSystemTime()
  await put(file, 'edited\n')

  // Act / Assert
  await expect(copySource(source, repository, signal)).rejects.toThrow(
    'Source changed during copying: "notes/a.md"',
  )
  expect(await readFile(join(world.repo, 'notes', 'a.md'), 'utf8')).toBe(
    'stable\n',
  )
})

// Windows reports no executable bits and Git ignores filesystem modes there (core.fileMode=false).
test.skipIf(process.platform === 'win32')(
  'backs up a permission-only change as an executable file',
  async () => {
    // Value: protects=chmod +x on unchanged bytes reaches the remote as mode 100755; fails_when=copy/stage skip compares only blob IDs; why_new=no test changes mode alone after a backup; seam=none; no_claim=core.fileMode=false handling
    // Arrange
    const world = await createWorld()
    const file = join(world.source, 'run.sh')
    await put(file, 'echo hi\n')
    await world.cli(['--repo', world.repo, 'run.sh'])
    await chmod(file, 0o755)

    // Act
    const result = await world.cli(['run.sh'])

    // Assert
    expect(result.stdout).toContain('Backed up "run.sh"')
    expect(
      (await world.git(['ls-tree', 'main', 'run.sh'], world.remote)).stdout,
    ).toStartWith('100755 blob ')
  },
)

test('discards a manifest whose version, identity, or entries are invalid', async () => {
  // Value: protects=untrusted cache JSON falls back to a full rehash; fails_when=readManifest accepts wrong version/source/name/format, short oid or malformed entry; why_new=only truncated JSON was tested; seam=none; no_claim=sha256 acceptance
  // Arrange
  const world = await createWorld()
  const signal = new AbortController().signal
  const repository = await readRepository(world.repo, signal)
  const file = join(world.source, 'notes', 'a.md')
  await put(file, 'recorded\n')
  settleFixtureTimestamps()
  const source = await scanSource(file, repository, signal, 'notes/a.md')
  await writeManifest(source, repository)
  const manifestDirectory = join(
    world.repo,
    '.git',
    'laststance-backup-manifests',
  )
  const [manifestFile = ''] = await readdir(manifestDirectory)
  const manifestPath = join(manifestDirectory, manifestFile)
  const valid = JSON.parse(await readFile(manifestPath, 'utf8'))
  const signature = valid.entries[0][1]
  const oid = valid.entries[0][2]
  const validSize = (await readManifest(repository, source.path, 'notes/a.md'))
    .size
  const invalidManifests: Record<string, unknown> = {
    'wrong version': { ...valid, version: 999 },
    'short oid': { ...valid, entries: [['notes/a.md', signature, 'abc123']] },
    'other source': { ...valid, source: '/somewhere/else' },
    'other name': { ...valid, name: 'other' },
    'other object format': { ...valid, objectFormat: 'sha256' },
    'two-element entry': { ...valid, entries: [['notes/a.md', signature]] },
    'non-string signature': { ...valid, entries: [['notes/a.md', 7, oid]] },
  }

  // Act
  const sizes: Record<string, number> = {}
  for (const [label, manifest] of Object.entries(invalidManifests)) {
    await writeFile(manifestPath, JSON.stringify(manifest))
    sizes[label] = (
      await readManifest(repository, source.path, 'notes/a.md')
    ).size
  }

  // Assert
  expect(validSize).toBe(1)
  expect(sizes).toEqual({
    'wrong version': 0,
    'short oid': 0,
    'other source': 0,
    'other name': 0,
    'other object format': 0,
    'two-element entry': 0,
    'non-string signature': 0,
  })
})

test('records 64-character blob IDs for a sha256 repository', async () => {
  // Value: protects=sha256 clones keep their manifest cache; fails_when=blob ID pattern is fixed at 40 hex chars; why_new=all manifest tests use sha1; seam=none; no_claim=sha256 push to a remote
  // Arrange
  const world = await createWorld()
  const signal = new AbortController().signal
  const sha256Repo = join(world.root, 'sha256-repo')
  await world.git(['init', '--object-format=sha256', '-b', 'main', sha256Repo])
  const repository = await readRepository(sha256Repo, signal)
  const file = join(world.source, 'notes', 'a.md')
  await put(file, 'recorded\n')
  settleFixtureTimestamps()
  const source = await scanSource(file, repository, signal, 'notes/a.md')

  // Act
  await writeManifest(source, repository)
  const known = await readManifest(repository, source.path, 'notes/a.md')

  // Assert
  expect(known.size).toBe(1)
  expect(known.get('notes/a.md')?.oid).toMatch(/^[0-9a-f]{64}$/)
})

// Renaming a file over a non-empty directory fails differently on Windows.
test.skipIf(process.platform === 'win32')(
  'leaves no temporary file behind when the atomic replace fails',
  async () => {
    // Value: protects=failed private writes clean up their .tmp sibling; fails_when=the finally cleanup is removed; why_new=no test exercises a failing write; seam=none; no_claim=previous-content preservation
    // Arrange
    const world = await createWorld()
    const directory = join(world.root, 'private')
    const destination = join(directory, 'config.json')
    await mkdir(destination, { recursive: true })
    await writeFile(join(destination, 'keep'), 'x')

    // Act
    const write = writePrivateFileAtomically(destination, '{}\n')

    // Assert
    await expect(write).rejects.toThrow()
    expect(await readdir(directory)).toEqual(['config.json'])
  },
)

// Tabs in filenames are POSIX-only; Windows forbids them.
test.skipIf(process.platform === 'win32')(
  'backs up a filename containing a tab and keeps it on a repeat run',
  async () => {
    // Value: protects=stage records split at the first tab so tabbed names survive validation; fails_when=parseStageRecord splits at the last tab; why_new=existing names cover spaces/newline, not tabs; seam=none; no_claim=rename handling
    // Arrange
    const world = await createWorld()
    await put(join(world.source, 'a\tb.md'), 'tabbed\n')
    await world.cli(['--repo', world.repo, '--', 'a\tb.md'])
    await put(join(world.source, 'a\tb.md'), 'tabbed again\n')

    // Act
    await world.cli(['--', 'a\tb.md'])

    // Assert
    expect(
      (await world.git(['show', 'main:a\tb.md'], world.remote)).stdout,
    ).toBe('tabbed again\n')
  },
)
