#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const endpoint = process.argv.at(-1)
if (process.env.BACKUP_TEST_GH_ERROR) {
  console.error('GitHub API denied (fixture)')
  process.exit(1)
}
if (endpoint?.endsWith('/actions/permissions')) {
  const counter = process.env.BACKUP_TEST_GH_COUNTER
  const count =
    counter && existsSync(counter)
      ? Number(readFileSync(counter, 'utf8')) + 1
      : 1
  if (counter) writeFileSync(counter, String(count))
  console.log(
    JSON.stringify({
      enabled:
        process.env.BACKUP_TEST_ACTIONS === 'enabled' ||
        count >= Number(process.env.BACKUP_TEST_ACTIONS_AFTER ?? Infinity),
    }),
  )
} else {
  console.log(
    JSON.stringify({
      id: Number(process.env.BACKUP_TEST_REPOSITORY_ID ?? 123456),
      private: process.env.BACKUP_TEST_PUBLIC !== '1',
      full_name: 'test-owner/private-backup',
      archived: false,
    }),
  )
}
