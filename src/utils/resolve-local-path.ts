import { homedir } from 'node:os'
import { resolve } from 'node:path'

/** Expands prompted home paths before configuration or source resolution by {@link backup}.
 * @param input - Local path, optionally starting with a literal tilde.
 * @returns An absolute local path.
 * @example resolveLocalPath("~/notes") // => "/home/user/notes"
 */
export function resolveLocalPath(input: string): string {
  // Interactive prompts do not receive the shell's tilde expansion.
  if (input === '~') return homedir()
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return resolve(homedir(), input.slice(2))
  }
  return resolve(input)
}
