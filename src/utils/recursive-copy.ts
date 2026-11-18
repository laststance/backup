import { join } from 'node:path'
import { runCommand } from './run-command'

/** Runs native cp once for all operands so the host determines merge order, overwrites, permissions and link behavior.
 * Git for Windows ships GNU cp beside its other MSYS utilities.
 * @example await recursiveCopy(['./first', './second'], repository.directory, signal)
 */
export async function recursiveCopy(
  operands: string[],
  directory: string,
  signal: AbortSignal,
  cwd?: string,
  preserveMode = false,
): Promise<void> {
  let executable = '/bin/cp'
  if (process.platform === 'win32') {
    const { stdout } = await runCommand('git', ['--exec-path'], { signal })
    executable = join(
      stdout.trimEnd(),
      '..',
      '..',
      '..',
      'usr',
      'bin',
      'cp.exe',
    )
  }
  const env =
    process.platform === 'win32'
      ? {
          ...process.env,
          MSYS: `${process.env.MSYS ?? ''} winsymlinks:nativestrict`.trim(),
        }
      : process.env
  const { stderr } = await runCommand(
    executable,
    [
      '-R',
      ...(preserveMode && process.platform !== 'win32' ? ['-p'] : []),
      // Darwin's immutable flags would prevent the private file from being renamed or removed.
      ...(preserveMode && process.platform === 'darwin' ? ['-N'] : []),
      '--',
      ...operands,
      directory,
    ],
    {
      signal,
      env,
      ...(cwd && { cwd }),
      timeoutMs: null,
    },
  )
  if (stderr) process.stderr.write(stderr)
}
