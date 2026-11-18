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
  let args = [
    '-R',
    ...(preserveMode && process.platform !== 'win32' ? ['-p'] : []),
    // Darwin's immutable flags would prevent the private file from being renamed or removed.
    ...(preserveMode && process.platform === 'darwin' ? ['-N'] : []),
    '--',
    ...operands,
    directory,
  ]
  let env = process.env
  let input: string[] | undefined
  if (process.platform === 'win32') {
    const { stdout } = await runCommand('git', ['--exec-path'], { signal })
    const bin = join(stdout.trimEnd(), '../../../usr/bin')
    executable = join(bin, 'cp.exe')
    const msys = `${process.env.MSYS ?? ''} winsymlinks:nativestrict`.trim()
    env = { ...env, MSYS: msys }
    // Allow for a separator, quotes and doubled escape characters in each UTF-16 argument.
    const commandLineBound = args.reduce(
      (length, arg) => length + 2 * arg.length + 3,
      2 * executable.length + 3,
    )
    if (commandLineBound > 32_767) {
      // MSYS passes argv directly between its executables. Keep every operand in the same cp invocation.
      input = args.map((arg) => `${arg}\0`)
      executable = join(bin, 'bash.exe')
      args = [
        '--noprofile',
        '--norc',
        '-p',
        '-c',
        'mapfile -d "" -t args && exec /usr/bin/cp "${args[@]}"',
      ]
      // Disable the optional native command-line mirror even when the parent shell requested it.
      env.MSYS = msys + ' nowincmdln'
    }
  }
  const { stderr } = await runCommand(executable, args, {
    signal,
    env,
    ...(input && { input }),
    ...(cwd && { cwd }),
    timeoutMs: null,
  })
  if (stderr) process.stderr.write(stderr)
}
