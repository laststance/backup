import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
} from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import type { Source } from './filetree'
import { recursiveCopy } from './utils/recursive-copy'
import { maybeLstat } from './utils/maybe-lstat'
import { runCommand } from './utils/run-command'

/** Copies leaves into an empty private directory in bounded batches before the final native copy.
 * @example await copyLeaves(names, sourceDirectory, privateDirectory, scratch, signal)
 */
async function copyLeaves(
  names: string[],
  from: string,
  to: string,
  scratch: string,
  signal: AbortSignal,
): Promise<void> {
  const incoming = await mkdtemp(join(scratch, 'leaves-'))
  let batch: string[] = []
  let size = 0
  const spellings = new Set<string>()
  const flush = async (): Promise<void> => {
    // A native recursive read always lands in an empty directory, never through a previously copied link.
    await recursiveCopy(batch, incoming, signal, from, true)
    for (const name of batch) {
      const staged = join(incoming, name)
      const captured = await maybeLstat(staged)
      if (!captured) continue // BSD cp skips sockets.
      if (captured.isDirectory())
        throw new Error(
          `Source entry became a directory: ${JSON.stringify(name)}`,
        )
      let target = join(to, name)
      const previous = await maybeLstat(target)
      if (captured.isFile() && previous?.isSymbolicLink())
        throw new Error(
          `Copy would write through a link replaced within the same source: ${JSON.stringify(name)}`,
        )
      if (captured.isFile() && previous?.isFile()) {
        // Native cp overwrites the prior inode in place, retaining its spelling and permission bits.
        target = await realpath(target)
        await chmod(staged, Number(previous.mode & 0o7777n))
      }
      await rename(staged, target)
    }
    batch = []
    size = 0
    spellings.clear()
  }
  for (const name of names) {
    const key = name.normalize('NFC').toUpperCase()
    const bytes = Buffer.byteLength(name) + 3
    // Do not let same-name inputs interact in the acquisition directory, or exceed the Windows argv limit.
    if (batch.length && (size + bytes > 12_000 || spellings.has(key)))
      await flush()
    batch.push(name)
    spellings.add(key)
    size += bytes
  }
  if (batch.length) await flush()
  await rm(incoming, { recursive: true })
}

/** Materializes exactly the scanned names so native cp can recurse over a private tree.
 * macOS bsdtar preserves directory ACLs and binary extended attributes, including on filtered directories.
 * @example await prepareDirectory(source, payload, scratch, signal)
 */
async function prepareDirectory(
  source: Source,
  payload: string,
  scratch: string,
  signal: AbortSignal,
): Promise<void> {
  await mkdir(payload, { mode: 0o700 })
  const children = new Map<string, string[]>()
  const directories: string[] = []
  for (const [key, entry] of source.entries) {
    const name = relative(source.name, key) || '.'
    if (entry.kind === 'directory') {
      if (name !== '.')
        await mkdir(join(payload, name), { recursive: true, mode: 0o700 })
      directories.push(name)
    } else {
      const parent = dirname(name)
      const group = children.get(parent) ?? []
      group.push(basename(name))
      children.set(parent, group)
    }
  }
  // GNU cp, including Git for Windows, handles native links and special nodes in the private tree.
  for (const [parent, leaves] of children)
    await copyLeaves(
      leaves,
      join(source.path, parent),
      join(payload, parent),
      scratch,
      signal,
    )
  if (process.platform === 'darwin') {
    // Only directory headers travel through bsdtar. Native cp handles every file, link and special node.
    await runCommand(
      '/usr/bin/tar',
      ['-cf', '-', '--no-recursion', '--null', '-T', '-'],
      {
        cwd: source.path,
        input: directories.map((name) => `./${name}\0`),
        signal,
        timeoutMs: null,
        consume: async (archive) => {
          await runCommand('/usr/bin/tar', ['-xpf', '-', '--no-fflags'], {
            cwd: payload,
            input: archive,
            signal,
            timeoutMs: null,
          })
        },
      },
    )
    return
  }
  // Populate descendants before restoring a parent's read-only mode.
  for (const name of directories.reverse()) {
    const stats = await lstat(join(source.path, name))
    await chmod(join(payload, name), stats.mode & 0o7777)
  }
}

/** Prepares private operands for one final cp invocation, retaining operand order and duplicate basenames.
 * @example const prepared = await prepareOperands(sources, scratch, signal)
 */
export async function prepareOperands(
  sources: readonly Source[],
  scratch: string,
  signal: AbortSignal,
) {
  const cwd = join(scratch, 'payload')
  await mkdir(cwd)
  const claimed = new Set<string>()
  const locations = new Map<string, string>()
  const batches = new Map<
    string,
    { from: string; to: string; names: string[] }
  >()
  const prepared: Source[] = []
  const operands: string[] = []
  for (const source of sources) {
    const root = source.entries.get(source.name)
    // An unreadable or absent operand has no payload. Its diagnostic survives until after copying.
    if (!root) continue
    const identity = JSON.stringify([source.path, source.name])
    let path = locations.get(identity)
    if (!path) {
      let parent = cwd
      const key = source.name.normalize('NFC').toUpperCase()
      if (claimed.has(key) || source.name === '.') {
        parent = join(scratch, String(locations.size))
        await mkdir(parent)
      }
      claimed.add(key)
      path = join(parent, source.name === '.' ? 'contents' : source.name)
      if (root.kind === 'directory') {
        await prepareDirectory(source, path, scratch, signal)
      } else {
        const from = dirname(source.path)
        const id = JSON.stringify([from, parent])
        const batch = batches.get(id) ?? { from, to: parent, names: [] }
        batch.names.push(basename(source.path))
        batches.set(id, batch)
      }
      locations.set(identity, path)
    }
    prepared.push({ ...source, path })
    // Relative argv avoids repeating an absolute working-directory prefix for every source.
    operands.push(relative(cwd, path) + (source.name === '.' ? '/.' : ''))
  }
  for (const { from, to, names } of batches.values())
    await copyLeaves(names, from, to, scratch, signal)
  return { cwd, sources: prepared, operands }
}

/** Removes private operands after success, failure or cancellation, including read-only directory trees.
 * @example await removePayload(scratch)
 */
export async function removePayload(directory: string): Promise<void> {
  try {
    await rm(directory, { recursive: true, force: true })
  } catch (error) {
    if (!(
      error instanceof Error &&
      'code' in error &&
      (error.code === 'EACCES' || error.code === 'EPERM')
    ))
      throw error
    const unlock = async (path: string): Promise<void> => {
      await chmod(path, 0o700)
      for (const child of await readdir(path, { withFileTypes: true })) {
        if (child.isDirectory()) await unlock(join(path, child.name))
      }
    }
    await unlock(directory)
    await rm(directory, { recursive: true, force: true })
  }
}
