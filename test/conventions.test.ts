import { expect, test } from 'bun:test'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Loads every test file so the convention checks cover files added later without edits here.
 * @returns File name → source text for each `*.test.ts` beside this file.
 * @example await readTestSources() // => Map { 'core.test.ts' => "import { expect, test } from 'bun:test'..." }
 */
async function readTestSources(): Promise<Map<string, string>> {
  const sources = new Map<string, string>()
  for (const name of await readdir(import.meta.dir)) {
    // Only test files carry cases; helpers and fixtures follow ordinary code rules.
    if (!name.endsWith('.test.ts')) continue
    sources.set(name, await readFile(join(import.meta.dir, name), 'utf8'))
  }
  return sources
}

test('declares every test case with test(), not the it alias', async () => {
  // Arrange
  const sources = await readTestSources()

  // Act
  const filesUsingIt = [...sources]
    .filter(([, text]) => /\bit(\.\w+)?\(/.test(text))
    .map(([name]) => name)

  // Assert
  expect(filesUsingIt).toEqual([])
})

test('keeps focused tests out of the suite so CI runs every case', async () => {
  // Arrange
  const sources = await readTestSources()

  // Act
  const filesWithFocus = [...sources]
    .filter(([, text]) => /\b(test|describe)\.only\(/.test(text))
    .map(([name]) => name)

  // Assert
  expect(filesWithFocus).toEqual([])
})
