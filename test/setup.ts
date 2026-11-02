import { setDefaultTimeout } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

/** Real-Git CLI tests spawn many processes; Bun's 5 s default times out their hooks on loaded or Windows runners. */
const TEST_TIMEOUT_MS = 30_000

// Preloaded once per `bun test` run via bunfig.toml, so every caller gets the same settings without CLI flags.
setDefaultTimeout(TEST_TIMEOUT_MS)

// Tests spawn dist/cli.js, so rebuild it from src first; a stale bundle silently tests old code.
const build = spawnSync(process.execPath, ['run', 'build'], {
  cwd: resolve(import.meta.dir, '..'),
  encoding: 'utf8',
})
if (build.status !== 0)
  throw new Error(
    `bun run build failed before tests:\n${build.stderr}${build.stdout}`,
  )
