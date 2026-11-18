import {
  lstat,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { maybeLstat } from './maybe-lstat'

/** Records exact spelling aliases for a single directory using native lookup when two names might collide.
 * @example const keys = new DirectoryNames(parent); await keys.key('report.txt')
 */
class DirectoryNames {
  private readonly keys = new Map<string, string>()
  private readonly ascii = new Set<string>()
  private probe?: string
  private readOnlyNames?: Set<string>
  private readonly existingKeys = new Map<string, string>()
  private unicode = false

  constructor(private readonly directory: string) {}

  /** Assigns the first spelling of a native entry as its stable key for one copy operation. */
  async key(name: string): Promise<string> {
    const known = this.keys.get(name)
    if (known !== undefined) return known
    // ASCII case can narrow the search. Non-ASCII, DOS short names and trailing dots/spaces need native comparison.
    const simple = /^[\x20-\x7e]+$/.test(name) && !/[. ]$|~\d/.test(name)
    const bucket = name.toLowerCase()
    if (!simple) this.unicode = true
    if (
      !this.probe &&
      !this.readOnlyNames &&
      this.keys.size &&
      (this.unicode || this.ascii.has(bucket))
    ) {
      try {
        this.probe = await mkdtemp(join(this.directory, '.backup-names-'))
      } catch (error) {
        if (!(
          error instanceof Error &&
          'code' in error &&
          ['EACCES', 'EPERM', 'EROFS'].includes(String(error.code))
        ))
          throw error
        this.readOnlyNames = new Set(await readdir(this.directory))
        for (const [prior, key] of this.keys) {
          const actual = await this.existingName(prior)
          if (actual !== undefined) this.existingKeys.set(actual, key)
        }
      }
      // Previously issued keys remain stable when this directory needs its first native comparison.
      if (this.probe) {
        for (const [prior, key] of this.keys)
          await writeFile(join(this.probe, prior), key, { flag: 'wx' })
      }
    }

    let key = name
    if (this.probe) {
      const candidate = join(this.probe, name)
      try {
        await writeFile(candidate, name, { flag: 'wx' })
      } catch (error) {
        if (!(
          error instanceof Error &&
          'code' in error &&
          error.code === 'EEXIST'
        ))
          throw error
        // The marker contains the first spelling, including on FUSE filesystems that synthesize inode numbers.
        key = await readFile(candidate, 'utf8')
      }
    } else if (this.readOnlyNames) {
      const actual = await this.existingName(name)
      if (actual !== undefined) {
        key = this.existingKeys.get(actual) ?? name
        this.existingKeys.set(actual, key)
      }
    }
    this.keys.set(name, key)
    this.ascii.add(bucket)
    return key
  }

  /** Identifies existing entries in a read-only parent, where native cp can still overwrite writable leaves. */
  private async existingName(name: string): Promise<string | undefined> {
    const names = this.readOnlyNames!
    if (names.has(name)) return name
    const target = await maybeLstat(join(this.directory, name))
    if (!target) return
    // Listing both names separately distinguishes hardlinks from alternate spellings of one entry.
    const simple = /^[A-Za-z0-9_.-]+$/.test(name)
    const possible = [...names].filter(
      (other) =>
        !simple ||
        !/^[A-Za-z0-9_.-]+$/.test(other) ||
        other.toLowerCase() === name.toLowerCase(),
    )
    if (possible.length === 1) return possible[0]
    const matches: string[] = []
    for (const other of possible) {
      const stats = await lstat(join(this.directory, other), { bigint: true })
      if (target.dev === stats.dev && target.ino === stats.ino)
        matches.push(other)
    }
    if (matches.length === 1) return matches[0]
    throw new Error(
      `Cannot identify the existing spelling in a read-only directory: ${JSON.stringify(join(this.directory, name))}`,
    )
  }

  /** Removes the private comparison markers before the caller invokes native copy on the worktree. */
  async close(): Promise<void> {
    if (this.probe) await rm(this.probe, { recursive: true, force: true })
  }
}

/** Maps relative copy paths to stable comparison keys, using each existing parent's own filesystem rules.
 * @param uniform - Private operand directories inherit their naming rules from one scratch directory.
 * @example const names = copyPathKeys(worktree); try { await names.key('Notes/file') } finally { await names.close() }
 */
export function copyPathKeys(root: string, uniform = false) {
  const directories = new Map<string, DirectoryNames>()
  const located = new Map<string, string | undefined>([['', root]])
  const keys = new Map<string, string>()

  const key = async (path: string): Promise<string> => {
    const known = keys.get(path)
    if (known !== undefined) return known
    let physical = root
    let parent = ''
    let exists = true
    const parts = path.split('/')
    for (const [i, name] of parts.entries()) {
      if (!name || name === '.') continue
      if (name === '..' || (process.platform === 'win32' && /[\\:]/.test(name)))
        throw new Error(`Invalid relative copy path: ${JSON.stringify(path)}`)
      let names = directories.get(physical)
      if (!names) {
        names = new DirectoryNames(physical)
        directories.set(physical, names)
      }
      const canonical = await names.key(name)
      parent = parent ? parent + '/' + canonical : canonical
      if (!uniform && exists && i < parts.length - 1) {
        if (!located.has(parent)) {
          const child = join(physical, name)
          // A new directory inherits its nearest existing parent's policy. Never probe through a destination link.
          located.set(
            parent,
            (await maybeLstat(child))?.isDirectory() ? child : undefined,
          )
        }
        const child = located.get(parent)
        if (child) physical = child
        else exists = false
      }
    }
    keys.set(path, parent)
    return parent
  }
  return {
    key,
    async close() {
      await Promise.all(
        Array.from(directories.values(), (names) => names.close()),
      )
    },
  }
}
