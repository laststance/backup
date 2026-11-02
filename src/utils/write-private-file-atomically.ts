import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { PRIVATE_DIRECTORY_MODE, PRIVATE_FILE_MODE } from '../constants'

/** Replaces a user-private file in one step for {@link saveConfig} and {@link writeManifest}, so readers never see partial JSON.
 * @param path - Final file location; missing parent directories are created as private directories.
 * @param content - Complete replacement text.
 * @returns Resolves after the rename has replaced any previous file.
 * @example await writePrivateFileAtomically("/home/user/.config/laststance-backup/config.json", "{}\n")
 */
export async function writePrivateFileAtomically(
  path: string,
  content: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
  const temporaryPath = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, content, {
      flag: 'wx',
      mode: PRIVATE_FILE_MODE,
    })
    await rename(temporaryPath, path)
  } finally {
    // Remove only the temporary file belonging to this attempted write.
    await rm(temporaryPath, { force: true })
  }
}
