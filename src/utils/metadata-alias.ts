/** Recognizes Git metadata spellings for {@link resolveBackupPath} and {@link scanSource} before normalization or copying.
 * @param name - One unnormalized filesystem component.
 * @returns Whether the component could address Git metadata on a supported filesystem.
 * @example metadataAlias('.GIT') // => true
 */
export function metadataAlias(name: string): boolean {
  const normalized = name
    .replace(/[\u200c\u200d\ufeff]/g, '')
    .replace(/[ .]+$/, '')
    .toLowerCase()
  return (
    normalized === '.git' ||
    normalized.startsWith('.git:') ||
    /^git~\d+(?:\.|:|$)/.test(normalized)
  )
}
