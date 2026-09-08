import { lstat } from 'node:fs/promises'

/** Distinguishes absent entries from filesystem failures during {@link scanSource} and destination validation.
 * @param path - Entry to inspect without following a symlink.
 * @returns Entry metadata, or undefined only for a missing path.
 * @example await maybeLstat("/missing") // => undefined
 */
export async function maybeLstat(path: string) {
  try {
    return await lstat(path, { bigint: true })
  } catch (error) {
    // Permission and I/O failures must not masquerade as missing files.
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return
    throw error
  }
}
