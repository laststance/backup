import { rmdirSync } from 'node:fs'

import { resolveBackupPath } from '../../src/utils/resolve-backup-path.ts'
process.chdir(process.argv[4])
rmdirSync(process.argv[4])
console.log(
  JSON.stringify([
    resolveBackupPath(process.argv[2], { home: process.argv[3] }),
    resolveBackupPath('~/cooking/too.txt', { home: process.argv[3] }),
  ]),
)
