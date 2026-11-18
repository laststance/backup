/** Compares names on case-insensitive copy volumes when matching approved, copied and indexed paths.
 * NTFS preserves composed and decomposed names and folds individual UTF-16 code units.
 * @example foldCopyPath('Notes') === foldCopyPath('notes')
 */
export function foldCopyPath(path: string): string {
  if (process.platform !== 'win32')
    return path.normalize('NFC').toUpperCase().toLowerCase()
  return path.replace(/[^/\\]/g, (unit) => {
    const upper = unit.toUpperCase()
    return upper.length === 1 ? upper : unit
  })
}
