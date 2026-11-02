import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { CONFIG_VERSION, MAX_COMMAND_OUTPUT_BYTES } from './constants'
import { isGitHubName } from './utils/github-name'
import { maybeLstat } from './utils/maybe-lstat'
import { writePrivateFileAtomically } from './utils/write-private-file-atomically'

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
      !isGitHubName(value.githubRepository)
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
  await writePrivateFileAtomically(
    configPath(),
    `${JSON.stringify(config, null, 2)}\n`,
  )
}
