import { homedir } from 'node:os'
import { basename, isAbsolute, parse, relative, resolve, sep } from 'node:path'
import { isWithin } from './is-within'
import { metadataAlias } from './metadata-alias'

/** Maps the selected source to a repository-relative destination before {@link scanSource} canonicalizes its parent.
 * Relative selections retain their invocation-directory hierarchy; absolute selections beneath home retain their home hierarchy.
 * @param input - Source spelling supplied to the CLI, including an optional literal home prefix.
 * @param options - Explicit lexical bases for deterministic callers and tests.
 * @returns Absolute source location and a slash-separated destination root, without resolving symlinks.
 * @throws When input is empty, a filesystem root, metadata, drive-relative, or escapes its relative base.
 * @example resolveBackupPath('cooking/too.txt', { cwd: '/home/user', home: '/home/user' })
 */
export function resolveBackupPath(
  input: string,
  options: { cwd?: string; home?: string } = {},
): { path: string; name: string } {
  if (!input) throw new Error('The source path cannot be empty.')
  // A drive-relative Windows path depends on hidden per-drive working directories.
  if (sep === '\\' && /^[a-z]:($|[^\\/])/i.test(input))
    throw new Error(
      `Drive-relative source paths are unsupported: ${JSON.stringify(input)}`,
    )
  const homeRelative =
    input === '~' ||
    input.startsWith('~/') ||
    (sep === '\\' && input.startsWith('~\\'))
  const absolute = homeRelative || isAbsolute(input)
  // Only relative inputs and Windows drive-less rooted paths need a usable invocation directory.
  const needsWorkingDirectory =
    !absolute ||
    (sep === '\\' && !homeRelative && !/^(?:[a-z]:|[\\/]{2})/i.test(input))
  const cwdInput = needsWorkingDirectory ? (options.cwd ?? process.cwd()) : ''
  const cwd = needsWorkingDirectory ? resolve(cwdInput) : ''
  const homeInput = options.home ?? homedir()
  const home = resolve(homeInput)
  // Expand the prefix textually so redundant separators cannot replace home with a new absolute root.
  const expanded = homeRelative ? `${homeInput}${sep}${input.slice(2)}` : input
  const raw = homeRelative
    ? expanded
    : isAbsolute(input)
      ? input
      : `${cwdInput}${sep}${input}`
  // Inspect original components so normalization cannot hide a metadata traversal.
  for (const component of raw.split(sep === '\\' ? /[\\/]/ : '/')) {
    if (metadataAlias(component))
      throw new Error(`Git metadata alias in source: ${JSON.stringify(input)}`)
  }
  const path = resolve(cwd, expanded)
  if (path === parse(path).root)
    throw new Error(
      `The source cannot be a filesystem root: ${JSON.stringify(input)}`,
    )
  if (!absolute && !isWithin(cwd, path))
    throw new Error(
      `Relative source escapes the working directory: ${JSON.stringify(input)}. Use an absolute or home-relative path instead.`,
    )
  const name = absolute
    ? isWithin(home, path)
      ? relative(home, path) || basename(path)
      : basename(path)
    : relative(cwd, path) || basename(path)
  return { path, name: name.split(sep).join('/') }
}
