import { rmdirSync } from 'node:fs'

import { resolveBackupPath } from '../../src/utils/resolve-backup-path.ts'
process.chdir(process.argv[3])
rmdirSync(process.argv[3])
console.log(JSON.stringify(resolveBackupPath(process.argv[2])))
