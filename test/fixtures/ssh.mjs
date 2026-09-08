import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const operation = process.argv.at(-1)
const environment = { ...process.env }
delete environment.GIT_DIR
delete environment.GIT_WORK_TREE
if (process.env.BACKUP_TEST_SSH_WAIT) {
  writeFileSync(process.env.BACKUP_TEST_SSH_WAIT, String(process.pid))
  await new Promise((resolve) => setTimeout(resolve, 60_000))
}
const receive = operation?.includes('git-receive-pack')
const result = spawnSync(
  'git',
  [receive ? 'receive-pack' : 'upload-pack', process.env.BACKUP_TEST_REMOTE],
  { stdio: 'inherit', env: environment },
)
if (
  receive &&
  process.env.BACKUP_TEST_LOST_RESPONSE === '1' &&
  result.status === 0
)
  process.exit(1)
process.exit(result.status ?? 1)
