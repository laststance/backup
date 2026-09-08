#!/usr/bin/env node
import { writeFileSync } from 'node:fs'

if (process.env.BACKUP_TEST_BUN_CALLED)
  writeFileSync(process.env.BACKUP_TEST_BUN_CALLED, 'called')
console.error('Bun is unavailable in this consumer fixture')
process.exit(99)
