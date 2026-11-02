import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

// Preloaded once per `bun test` run via bunfig.toml. Tests spawn dist/cli.js, so rebuild it
// from src first; a stale bundle silently tests old code. useFixtures() sets each file's timeout.
const build = spawnSync(process.execPath, ['run', 'build'], {
  cwd: resolve(import.meta.dir, '..'),
  encoding: 'utf8',
})
if (build.status !== 0)
  throw new Error(
    `bun run build failed before tests:\n${build.stderr}${build.stdout}`,
  )
