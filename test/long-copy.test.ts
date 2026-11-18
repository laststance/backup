import { expect, test } from 'bun:test'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recursiveCopy } from '../src/utils/recursive-copy'

test.each([
  { description: 'copies every literal name', collision: false },
  {
    description: 'handles a late basename collision in the same invocation',
    collision: true,
  },
])(
  'preserves native cp behavior past the Windows command-line limit: $description',
  async ({ collision }) => {
    // Arrange
    const root = await mkdtemp(join(tmpdir(), 'backup-long-copy-'))
    try {
      const longParent = 'expanded-'.repeat(10)
      const source = join(root, longParent)
      const destination = join(root, 'destination')
      await mkdir(destination)
      for (const directory of ['first', 'last', 'contents'])
        await mkdir(join(source, directory), { recursive: true })
      const files = Array.from({ length: 360 }, (_, i) => `item-${i}`)
      const first = join('first', '-shared $ & é')
      const last = collision
        ? join('last', '-shared $ & é')
        : "last name's [end]"
      const names = [first, ...files, last, 'after collision']
      for (const name of names) await writeFile(join(source, name), name)
      await writeFile(join(source, 'contents', 'inside'), 'directory contents')
      const operands = names.map((name) => join(longParent, name))
      // Keep the final dot literal to copy the directory contents into the destination.
      operands.push(join(longParent, 'contents') + '/.')
      expect(operands.join(' ').length).toBeGreaterThan(32_767)

      // Act
      const copy = recursiveCopy(
        operands,
        destination,
        new AbortController().signal,
        root,
      )
      const gnuConflict = collision && process.platform !== 'darwin'
      // GNU cp refuses to overwrite a destination it just created, then continues with later operands.
      if (gnuConflict) await expect(copy).rejects.toThrow()
      else await copy

      // Assert
      const expectedNames = [
        ...files,
        '-shared $ & é',
        'after collision',
        'inside',
      ]
      if (!collision) expectedNames.push(last)
      expect((await readdir(destination)).sort()).toEqual(expectedNames.sort())
      expect(await readFile(join(destination, '-shared $ & é'), 'utf8')).toBe(
        collision && !gnuConflict ? last : first,
      )
      expect(await readFile(join(destination, 'after collision'), 'utf8')).toBe(
        'after collision',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  60_000,
)
