import { basename, isAbsolute, parse, resolve, sep } from 'node:path'
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
