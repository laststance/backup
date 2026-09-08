import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const directory = process.argv.at(-1)
if (process.argv[2] === 'child') {
  process.on('SIGTERM', () => {})
  setTimeout(() => writeFileSync(join(directory, 'survived'), 'alive'), 2000)
  setInterval(() => {}, 1000)
} else {
  writeFileSync(join(directory, 'process-group'), String(process.pid))
  spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), 'child', directory],
    { stdio: 'ignore' },
  )
  setInterval(() => {}, 1000)
}
