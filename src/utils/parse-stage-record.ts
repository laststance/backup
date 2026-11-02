/** One `git ls-files --stage` index record. */
export type StageRecord = {
  /** Git entry mode, such as `100644`, `120000`, or `160000` for a submodule. */
  mode: string
  /** Staged blob or commit ID. */
  oid: string
  /** Merge stage; `0` is the only stage of an unconflicted entry. */
  stage: string
  /** Repository-relative, slash-separated path. */
  path: string
}

/** Splits one NUL-delimited `git ls-files --stage -z` record for destination validation, copy skipping, and staging checks.
 * @param record - `<mode> <oid> <stage>\t<path>` without its NUL terminator.
 * @returns The record fields; the path keeps any tabs or spaces it contains.
 * @example
 * parseStageRecord('100644 e69de29bb2d1d6434b8b29ae775ad8c2e48c5391 0\tnotes/a b.md')
 * // => { mode: '100644', oid: 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391', stage: '0', path: 'notes/a b.md' }
 */
export function parseStageRecord(record: string): StageRecord {
  const separator = record.indexOf('\t')
  const [mode = '', oid = '', stage = ''] = record
    .slice(0, separator)
    .split(' ')
  return { mode, oid, stage, path: record.slice(separator + 1) }
}
