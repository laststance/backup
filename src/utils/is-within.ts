import { isAbsolute, relative, sep } from 'node:path'

/** Checks canonical path containment for {@link scanSource} and destination metadata protection.
 * @param parent - Canonical directory boundary.
 * @param candidate - Canonical entry to check.
 * @returns Whether the candidate equals or lies within the boundary.
 * @example isWithin("/vault", "/vault/a") // => true
 */
export function isWithin(parent: string, candidate: string): boolean {
  const difference = relative(parent, candidate)
  return (
    difference === '' ||
    (!isAbsolute(difference) &&
      difference !== '..' &&
      !difference.startsWith(`..${sep}`))
  )
}
