import { lstat, realpath } from 'node:fs/promises'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  resolve,
  sep,
} from 'node:path'
import { metadataAlias } from './metadata-alias'

/** Preserves the operand spelling consumed by native cp and identifies its worktree destination for {@link scanSource}.
 * @param options - Explicit working directory for resolving a relative operand.
 * @example resolveBackupPath('recipes/cake.txt', { cwd: '/work' }) // { path: '/work/recipes/cake.txt', name: 'cake.txt' }
 */
export function resolveBackupPath(
  input: string,
  options: { cwd?: string } = {},
): { path: string; name: string } {
  if (!input) throw new Error('The source path cannot be empty.')
  if (sep === '\\' && /^[a-z]:($|[^\\/])/i.test(input))
    throw new Error(
      `Drive-relative source paths are unsupported: ${JSON.stringify(input)}`,
    )

  const separators = sep === '\\' ? /[\\/]/ : /\//
  // Keep intermediate symlinks, '..', a final '.', and trailing separators for the OS to interpret.
  let path = input
  if (!isAbsolute(path)) path = (options.cwd ?? process.cwd()) + sep + path
  else if (sep === '\\' && !/^(?:[a-z]:|[\\/]{2})/i.test(path))
    path =
      parse(options.cwd ?? process.cwd()).root.replace(/[\\/]+$/, '') + path

  if (path.split(separators).some(metadataAlias))
    throw new Error(`Git metadata alias in source: ${JSON.stringify(input)}`)
  if (resolve(path) === parse(path).root)
    throw new Error(
      `The source cannot be a filesystem root: ${JSON.stringify(input)}`,
    )

  // BSD cp merges directory contents for a trailing slash. GNU cp requires an explicit '/.'.
  const name =
    process.platform === 'darwin' && path.endsWith('/') ? '.' : basename(path)
  if (name === '..')
    throw new Error(
      'The destination cannot be the parent of the registered clone.',
    )
  return { path, name }
}

/** Resolves a directory required by a source operand before {@link resolveSourcePath} traverses it.
 * @throws An ENOTDIR source error when a file is used as a directory.
 * @example await sourceDirectory('/work/notes')
 */
async function sourceDirectory(path: string): Promise<string> {
  const physical = await realpath(path)
  if (!(await lstat(physical)).isDirectory())
    throw Object.assign(new Error(`Not a directory: ${JSON.stringify(path)}`), {
      code: 'ENOTDIR',
    })
  return physical
}

/** Resolves the parent for the source scan while preserving a plain leaf symlink for recursive copy.
 * @param operand - An absolute operand with its original dot components and separators.
 * @example await resolveSourcePath('/work/linked-directory/../choice')
 */
export async function resolveSourcePath(operand: string): Promise<string> {
  const leaf = basename(operand)
  const directoryOperand =
    operand.endsWith('/') ||
    operand.endsWith(sep) ||
    leaf === '.' ||
    leaf === '..'
  let path = operand
  if (process.platform === 'win32') {
    // Win32 collapses '..' lexically. Git for Windows' cp traverses the physical link target first.
    const root = parse(operand).root
    path = root
    for (const component of operand.slice(root.length).split(/[\\/]+/)) {
      if (component === '..') path = dirname(await sourceDirectory(path))
      else if (component === '.') path = await sourceDirectory(path)
      else if (component) path = join(path, component)
    }
  }
  // Node on Windows also accepts a trailing separator on a regular file, which GNU cp rejects.
  return directoryOperand
    ? sourceDirectory(path)
    : join(await realpath(dirname(path)), basename(path))
}
