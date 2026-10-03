/** Maximum GitHub `owner/repo` length: 39-char owner + '/' + 100-char repository. */
const MAX_GITHUB_NAME_LENGTH = 140

const GITHUB_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*\/[A-Za-z0-9_.-]+$/

/** Whether a string is a well-formed GitHub `owner/repo` name.
 * Shared grammar for remote URLs, API metadata, and stored configuration so
 * every trust boundary rejects dot-only segments and overlong names the same
 * way. The owner charset allows `_` for Enterprise Managed User accounts,
 * which can only create private repositories.
 * @param value - Candidate `owner/repo` string.
 * @returns True when the value names a GitHub repository.
 * @example isGitHubName("owner/repo") // => true
 */
export function isGitHubName(value: string): boolean {
  return (
    value.length <= MAX_GITHUB_NAME_LENGTH &&
    GITHUB_NAME_PATTERN.test(value) &&
    !value.endsWith('/.') &&
    !value.endsWith('/..')
  )
}
