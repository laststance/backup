import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  COMMAND_KILL_GRACE_MS,
  COMMAND_TIMEOUT_MS,
  MAX_COMMAND_OUTPUT_BYTES,
} from '../constants'

export type CommandOptions = {
  cwd?: string
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  input?: Iterable<string | Uint8Array> | AsyncIterable<string | Uint8Array>
  consume?: (output: Readable) => Promise<void>
  allowFailure?: boolean
  timeoutMs?: number
}

/** Executes Git/gh for {@link git} and {@link verifyGitHub}, with bounded diagnostics and streamed input/output.
 * @param command - Executable name, never a shell expression.
 * @param argumentsList - Literal argument vector.
 * @param options - Cancellation, streaming, and expected-failure settings.
 * @returns Exit code and small captured output; streamed output is not accumulated.
 * @example await runCommand("git", ["--version"]) // => { exitCode: 0, stdout: "git version ...\n" }
 */
export async function runCommand(
  command: string,
  argumentsList: string[],
  options: CommandOptions = {},
) {
  options.signal?.throwIfAborted()
  const child = spawn(command, argumentsList, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32',
  })
  let failure: Error | undefined
  let output = ''
  let diagnostic = Buffer.alloc(0)
  let killTimer: ReturnType<typeof setTimeout> | undefined

  // Stop the process group on Unix so Git's transport children cannot hold pipes open.
  const stop = () => {
    if (child.pid && process.platform !== 'win32') {
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {
        /* The process may already have exited. */
      }
    } else {
      child.kill('SIGTERM')
    }
    killTimer ??= setTimeout(() => {
      if (child.pid && process.platform !== 'win32') {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          /* Already exited. */
        }
      } else {
        child.kill('SIGKILL')
      }
      child.stdout.destroy()
      child.stderr.destroy()
      child.stdin.destroy()
    }, COMMAND_KILL_GRACE_MS)
    killTimer.unref()
  }
  const abort = () => {
    failure = new Error('Backup cancelled.')
    stop()
  }
  options.signal?.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(() => {
    failure = new Error(
      `${command} timed out. Check authentication/network access and retry.`,
    )
    stop()
  }, options.timeoutMs ?? COMMAND_TIMEOUT_MS)
  timeout.unref()

  const completion = new Promise<number>((resolve) => {
    child.once('error', (error) => {
      failure = error
    })
    child.once('close', (code) => resolve(code ?? 1))
  })
  const outputTask = (async () => {
    if (options.consume) {
      await options.consume(child.stdout)
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of child.stdout) {
      const bytes = Buffer.from(chunk)
      size += bytes.length
      // Commands producing large listings must use the streaming consumer.
      if (size > MAX_COMMAND_OUTPUT_BYTES)
        throw new Error(`${command} output exceeded the capture limit.`)
      chunks.push(bytes)
    }
    output = Buffer.concat(chunks).toString('utf8')
  })().catch((error: unknown) => {
    failure ??= error instanceof Error ? error : new Error(String(error))
    stop()
  })
  const errorTask = (async () => {
    for await (const chunk of child.stderr) {
      diagnostic = Buffer.concat([diagnostic, Buffer.from(chunk)]).subarray(
        -MAX_COMMAND_OUTPUT_BYTES,
      )
    }
  })()
  const inputTask = options.input
    ? pipeline(Readable.from(options.input), child.stdin).catch(
        (error: unknown) => error,
      )
    : Promise.resolve(child.stdin.end())

  try {
    const [exitCode, , , inputResult] = await Promise.all([
      completion,
      outputTask,
      errorTask,
      inputTask,
    ])
    if (failure) throw failure
    if (exitCode !== 0 && !options.allowFailure) {
      throw new Error(
        `${command} failed (${exitCode}): ${diagnostic.toString('utf8').trim() || 'no diagnostic output'}`,
      )
    }
    if (exitCode === 0 && inputResult instanceof Error) throw inputResult
    return { exitCode, stdout: output }
  } finally {
    clearTimeout(timeout)
    if (killTimer) clearTimeout(killTimer)
    options.signal?.removeEventListener('abort', abort)
  }
}
