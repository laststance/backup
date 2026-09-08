#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { createInterface } from 'node:readline/promises'
import { backup } from './backup'
import { loadConfig } from './config'
import { INTERRUPTED_EXIT_CODE, TERMINATED_EXIT_CODE } from './constants'
import { version } from '../package.json'

const HELP = `Usage: backup [--repo <directory>] <file-or-directory>

Copy one source into an existing private GitHub clone, commit, and push.
The source basename becomes its path at the repository root.

Options:
  --repo <directory>  Register an existing private clone (alone: setup only)
  -h, --help          Show help
  -v, --version       Show version

Examples:
  backup --repo ~/private-backup
  backup foo.md
  backup ./notes
  backup -- -draft.md

Requires Node >=24, Git >=2.31, and authenticated GitHub CLI (gh).
GitHub Actions must be disabled on the destination repository.
All pending commits on the registered branch are included in the push.
`

const controller = new AbortController()
const interrupt = () => {
  process.exitCode = INTERRUPTED_EXIT_CODE
  controller.abort()
}
const terminate = () => {
  process.exitCode = TERMINATED_EXIT_CODE
  controller.abort()
}
process.once('SIGINT', interrupt)
process.once('SIGTERM', terminate)

try {
  const { values, positionals } = parseArgs({
    options: {
      repo: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
    allowPositionals: true,
    strict: true,
  })
  if (
    values.help ||
    (positionals.length === 0 && !values.repo && !values.version)
  ) {
    process.stdout.write(HELP)
  } else if (values.version) {
    console.log(version)
  } else {
    if (positionals.length > 1)
      throw new Error('Pass exactly one file or directory per invocation.')
    let directory = values.repo
    const config = directory ? undefined : await loadConfig()
    if (!directory && !config) {
      if (!process.stdin.isTTY || !process.stdout.isTTY)
        throw new Error(
          'No destination registered in this non-interactive session. Use backup --repo <existing-private-clone> <source>.',
        )
      const prompt = createInterface({
        input: process.stdin,
        output: process.stdout,
      })
      try {
        directory = await prompt.question(
          'Existing private GitHub clone directory: ',
          { signal: controller.signal },
        )
        if (!directory.trim())
          throw new Error('Registration cancelled: no directory entered.')
      } finally {
        prompt.close()
      }
    }
    const source = positionals[0]
    console.log(
      await backup(
        {
          ...(directory ? { directory } : {}),
          ...(config ? { config } : {}),
          ...(source ? { source } : {}),
        },
        controller.signal,
      ),
    )
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode ||= 1
} finally {
  process.removeListener('SIGINT', interrupt)
  process.removeListener('SIGTERM', terminate)
}
