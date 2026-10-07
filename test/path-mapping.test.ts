import { expect, test } from 'bun:test'
import { resolveBackupPath } from '../src/utils/resolve-backup-path'

const windows = process.platform === 'win32'
const home = windows ? 'C:\\Users\\example' : '/home/example'
const cwd = windows
  ? 'C:\\Users\\example\\workspace'
  : '/home/example/workspace'

test.each([
  ['cooking/too.txt', 'cooking/too.txt'],
  ['./cooking/too.txt', 'cooking/too.txt'],
  ['cooking/recipes/', 'cooking/recipes'],
  ['cooking//./recipes/../too.txt', 'cooking/too.txt'],
  ['cooking/ お茶 .txt ', 'cooking/ お茶 .txt '],
  ['-drafts/-recipe.txt', '-drafts/-recipe.txt'],
  ['~other/too.txt', '~other/too.txt'],
  ['.', 'workspace'],
  ['cooking/..', 'workspace'],
])('preserves the selected relative hierarchy for %j', (input, expected) => {
  // Arrange / Act
  const result = resolveBackupPath(input, { cwd, home })
  // Assert
  expect(result.name).toBe(expected)
})

test.each([
  '~/cooking/too.txt',
  '~//cooking/too.txt',
  ...(windows ? ['~\\cooking/too.txt', '~\\\\cooking/too.txt'] : []),
  windows
    ? 'C:\\Users\\example\\cooking\\too.txt'
    : '/home/example/cooking/too.txt',
])(
  'places a home-contained source beneath cooking independently of the working directory (%j)',
  (input) => {
    // Arrange / Act
    const result = resolveBackupPath(input, { cwd, home })
    // Assert
    expect(result).toEqual({
      path: windows
        ? 'C:\\Users\\example\\cooking\\too.txt'
        : '/home/example/cooking/too.txt',
      name: 'cooking/too.txt',
    })
  },
)

test.each(['~', '~/', home])(
  'preserves the selected home root basename for %j',
  (input) => {
    // Arrange / Act
    const result = resolveBackupPath(input, { cwd, home })
    // Assert
    expect(result).toEqual({ path: home, name: 'example' })
  },
)

test.each([
  windows ? 'C:\\temp\\cooking\\too.txt' : '/var/tmp/cooking/too.txt',
  windows
    ? 'C:\\Users\\example-other\\cooking\\too.txt'
    : '/home/example-other/cooking/too.txt',
  '~/../example-other/cooking/too.txt',
])(
  'uses the basename for absolute sources outside the home boundary (%j)',
  (input) => {
    // Arrange / Act
    const result = resolveBackupPath(input, { cwd, home })
    // Assert
    expect(result.name).toBe('too.txt')
  },
)

test.each(['../too.txt', 'cooking/../../too.txt'])(
  'rejects a relative escape before choosing a backup path (%j)',
  (input) => {
    // Arrange / Act / Assert
    expect(() => resolveBackupPath(input, { cwd, home })).toThrow(
      'Use an absolute or home-relative path instead',
    )
  },
)

test.each([
  '.git/../too.txt',
  'cooking/.GIT/../too.txt',
  'cooking/git~1/../too.txt',
])(
  'rejects a metadata component even when normalization removes it (%j)',
  (input) => {
    // Arrange / Act / Assert
    expect(() => resolveBackupPath(input, { cwd, home })).toThrow(
      'Git metadata alias',
    )
  },
)

test('rejects a metadata component in the invocation prefix before normalization', () => {
  // Arrange / Act / Assert
  expect(() =>
    resolveBackupPath('too.txt', { cwd: `${cwd}/.git/..`, home }),
  ).toThrow('Git metadata alias')
})

test.each([
  ['', 'cannot be empty'],
  [windows ? 'C:\\' : '/', 'filesystem root'],
])('rejects an invalid source %j before copying', (input, message) => {
  // Arrange / Act / Assert
  expect(() => resolveBackupPath(input, { cwd, home })).toThrow(message)
})

test.skipIf(windows)('retains literal backslashes in POSIX filenames', () => {
  // Arrange / Act
  const result = resolveBackupPath('cooking/a\\b.txt', { cwd, home })
  // Assert
  expect(result).toEqual({
    path: '/home/example/workspace/cooking/a\\b.txt',
    name: 'cooking/a\\b.txt',
  })
})

test.skipIf(!windows).each(['C:foo', 'C:', 'D:folder\\foo'])(
  'rejects ambiguous Windows drive-relative source %j',
  (input) => {
    // Arrange / Act / Assert
    expect(() => resolveBackupPath(input, { cwd, home })).toThrow(
      'Drive-relative',
    )
  },
)

test.skipIf(!windows)(
  'parses native drive paths and UNC shares using their home boundary',
  () => {
    // Arrange / Act / Assert
    expect(
      resolveBackupPath('C:\\Users\\example\\cooking\\too.txt', { cwd, home }),
    ).toEqual({
      path: 'C:\\Users\\example\\cooking\\too.txt',
      name: 'cooking/too.txt',
    })
    expect(
      resolveBackupPath('\\\\server\\share\\cooking\\too.txt', {
        cwd,
        home: '\\\\server\\share',
      }),
    ).toEqual({
      path: '\\\\server\\share\\cooking\\too.txt',
      name: 'cooking/too.txt',
    })
    expect(() =>
      resolveBackupPath('\\\\server\\share\\', { cwd, home }),
    ).toThrow('filesystem root')
    expect(
      resolveBackupPath('\\Users\\example\\cooking\\too.txt', { cwd, home }),
    ).toEqual({
      path: 'C:\\Users\\example\\cooking\\too.txt',
      name: 'cooking/too.txt',
    })
  },
)

test.skipIf(windows)(
  'preserves a literal POSIX filename beginning with tilde and backslash',
  () => {
    // Arrange / Act
    const result = resolveBackupPath('~\\notes.txt', { cwd, home })
    // Assert
    expect(result).toEqual({
      path: '/home/example/workspace/~\\notes.txt',
      name: '~\\notes.txt',
    })
  },
)
