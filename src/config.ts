import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  CONFIG_VERSION,
  MAX_COMMAND_OUTPUT_BYTES,
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
} from './constants'
import { maybeLstat } from './utils/maybe-lstat'

export type BackupConfig = {
  version: typeof CONFIG_VERSION
  directory: string
  branch: string
  repositoryId: number
  githubRepository: string
}

/** Locates the single destination registry for the CLI's {@link loadConfig} and {@link saveConfig}.
 * @returns The user-owned configuration filename.
 * @example configPath() // => "/home/user/.config/laststance-backup/config.json"
 */
export function configPath(): string {
  return join(homedir(), '.config', 'laststance-backup', 'config.json')
}

/** Loads validated destination data at CLI startup, failing visibly on corrupt configuration.
 * @returns Registered destination, or undefined when no configuration exists.
 * @example await loadConfig() // => undefined on first use
 */
export async function loadConfig(): Promise<BackupConfig | undefined> {
  const path = configPath()
  const metadata = await maybeLstat(path)
  if (!metadata) return
  try {
    if (!metadata.isFile() || metadata.size > BigInt(MAX_COMMAND_OUTPUT_BYTES))
      throw new Error('Unsupported configuration file.')
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    // Persisted JSON is a trust boundary, not an unchecked TypeScript assertion.
    if (
      typeof value !== 'object' ||
      value === null ||
      !('version' in value) ||
      value.version !== CONFIG_VERSION ||
      !('directory' in value) ||
      typeof value.directory !== 'string' ||
      !isAbsolute(value.directory) ||
      !('branch' in value) ||
      typeof value.branch !== 'string' ||
      !value.branch ||
      !('repositoryId' in value) ||
      typeof value.repositoryId !== 'number' ||
      !Number.isSafeInteger(value.repositoryId) ||
      value.repositoryId <= 0 ||
      !('githubRepository' in value) ||
      typeof value.githubRepository !== 'string' ||
      !/^[\w.-]+\/[\w.-]+$/.test(value.githubRepository)
    ) {
      throw new Error('Invalid configuration fields.')
    }
    return {
      version: CONFIG_VERSION,
      directory: value.directory,
      branch: value.branch,
      repositoryId: value.repositoryId,
      githubRepository: value.githubRepository,
    }
  } catch (error) {
    throw new Error(
      `Cannot read configuration ${JSON.stringify(path)}. Register again with backup --repo <directory>.`,
      { cause: error },
    )
  }
}

/** Atomically replaces destination configuration after successful validation by {@link registerRepository}.
 * @param config - Validated repository identity and branch; never credentials.
 * @returns Resolves after the replacement is durable to subsequent readers.
 * @example await saveConfig(validatedDestination)
 */
export async function saveConfig(config: BackupConfig): Promise<void> {
  const path = configPath()
  await mkdir(dirname(path), { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
  const temporaryPath = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
      flag: 'wx',
      mode: PRIVATE_FILE_MODE,
    })
    await rename(temporaryPath, path)
  } finally {
    // Remove only the temporary file belonging to this attempted write.
    await rm(temporaryPath, { force: true })
  }
}
