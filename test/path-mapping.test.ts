import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, parse, relative, resolve, sep } from 'node:path'
import {
  resolveBackupPath,
  resolveSourcePath,
} from '../src/utils/resolve-backup-path'

const windows = process.platform === 'win32'
const home = windows ? 'C:\\Users\\example' : '/home/example'
const cwd = windows
  ? 'C:\\Users\\example\\workspace'
  : '/home/example/workspace'

test.each([
  ['cooking/too.txt', 'too.txt'],
  ['./cooking/too.txt', 'too.txt'],
  ['cooking/recipes/', process.platform === 'darwin' ? '.' : 'recipes'],
  ['cooking//./recipes/../too.txt', 'too.txt'],
  ['cooking/ お茶 .txt ', ' お茶 .txt '],
  ['-drafts/-recipe.txt', '-recipe.txt'],
  ['~other/too.txt', 'too.txt'],
  ['.', '.'],
  ['../too.txt', 'too.txt'],
])(
  'maps the operand %j into the registered directory as cp does',
  (input, expected) => {
    // Arrange / Act
    const result = resolveBackupPath(input, { cwd })
    // Assert
    expect(result.name).toBe(expected)
  },
)

test.each(['~', '~/cooking/too.txt', '~//cooking/too.txt'])(
  'passes a quoted tilde to the filesystem literally (%j)',
  (input) => {
    // Arrange / Act
    const result = resolveBackupPath(input, { cwd })
    // Assert
    expect(result.path).toBe(cwd + sep + input)
    expect(result.name).toBe(input === '~' ? '~' : 'too.txt')
  },
)

test.each([
  home + sep + 'too.txt',
  windows ? 'C:\\temp\\too.txt' : '/var/tmp/too.txt',
])('places an absolute file in the clone by basename (%j)', (input) => {
  // Arrange / Act
  const result = resolveBackupPath(input, { cwd })
  // Assert
  expect(result).toEqual({ path: input, name: 'too.txt' })
})

test.each([
  '.git/../too.txt',
  'cooking/.GIT/../too.txt',
  'cooking/git~1/../too.txt',
])(
  'rejects a metadata component even when normalization removes it (%j)',
  (input) => {
    // Arrange / Act / Assert
    expect(() => resolveBackupPath(input, { cwd })).toThrow(
      'Git metadata alias',
    )
  },
)

test('rejects a metadata component in the invocation prefix before normalization', () => {
  // Arrange / Act / Assert
  expect(() => resolveBackupPath('too.txt', { cwd: `${cwd}/.git/..` })).toThrow(
    'Git metadata alias',
  )
})

test.each([
  ['', 'cannot be empty'],
  [windows ? 'C:\\' : '/', 'filesystem root'],
])('rejects an invalid source %j before copying', (input, message) => {
  // Arrange / Act / Assert
  expect(() => resolveBackupPath(input, { cwd })).toThrow(message)
})

test.skipIf(windows)('retains literal backslashes in POSIX filenames', () => {
  // Arrange / Act
  const result = resolveBackupPath('cooking/a\\b.txt', { cwd })
  // Assert
  expect(result).toEqual({
    path: '/home/example/workspace/cooking/a\\b.txt',
    name: 'a\\b.txt',
  })
})

test.skipIf(!windows).each(['C:foo', 'C:', 'D:folder\\foo'])(
  'rejects ambiguous Windows drive-relative source %j',
  (input) => {
    // Arrange / Act / Assert
    expect(() => resolveBackupPath(input, { cwd })).toThrow('Drive-relative')
  },
)

test
  .skipIf(!windows)
  .each([
    '//server/share',
    '//server/share/',
    '\\\\server\\share',
    '\\\\server\\share\\',
    'C:/',
  ])('rejects Windows filesystem roots before scanning (%j)', (input) => {
  // Arrange / Act / Assert
  expect(() => resolveBackupPath(input, { cwd })).toThrow('filesystem root')
})

test.skipIf(!windows)(
  'parses native drive paths and UNC shares by basename',
  () => {
    // Arrange / Act / Assert
    expect(
      resolveBackupPath('C:\\Users\\example\\cooking\\too.txt', { cwd }),
    ).toEqual({
      path: 'C:\\Users\\example\\cooking\\too.txt',
      name: 'too.txt',
    })
    expect(
      resolveBackupPath('\\\\server\\share\\cooking\\too.txt', {
        cwd,
      }),
    ).toEqual({
      path: '\\\\server\\share\\cooking\\too.txt',
      name: 'too.txt',
    })
    expect(
      resolveBackupPath('\\Users\\example\\cooking\\too.txt', { cwd }),
    ).toEqual({
      path: 'C:\\Users\\example\\cooking\\too.txt',
      name: 'too.txt',
    })
  },
)

test.skipIf(windows)(
  'preserves a literal POSIX filename beginning with tilde and backslash',
  () => {
    // Arrange / Act
    const result = resolveBackupPath('~\\notes.txt', { cwd })
    // Assert
    expect(result).toEqual({
      path: '/home/example/workspace/~\\notes.txt',
      name: '~\\notes.txt',
    })
  },
)

test('checks the physical directory after symlink and parent traversal select a different root', async () => {
  // Arrange
  const fixture = await realpath(
    await mkdtemp(join(tmpdir(), 'backup-root-test-')),
  )
  try {
    const root = parse(fixture).root
    const alias = join(fixture, 'alias')
    const selected = join(fixture, 'selected')
    const depth = relative(root, alias).split(sep).length
    const nested = join(selected, ...Array<string>(depth).fill('child'))
    await mkdir(nested, { recursive: true })
    await symlink(nested, alias, 'junction')
    const operand = alias + sep + ('..' + sep).repeat(depth) + '.'
    const rootLink = join(fixture, 'root-link')
    await symlink(root, rootLink, 'junction')

    // Act / Assert
    expect(resolve(operand)).toBe(root)
    const mapped = resolveBackupPath(operand)
    expect(mapped.name).toBe('.')
    expect(await resolveSourcePath(mapped.path)).toBe(selected)
    await expect(resolveSourcePath(rootLink + sep + '.')).rejects.toThrow(
      'filesystem root',
    )
    expect(await resolveSourcePath(rootLink)).toBe(rootLink)
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})
