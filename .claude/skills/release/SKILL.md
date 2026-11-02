---
name: release
description: Release @laststance/backup to npm — version bump, PR, merge, v* tag, registry verification. Use for any release or npm publish of this repo, in place of /ship and /land-and-deploy.
---

# Release @laststance/backup

Publishing is **tag-driven**: pushing `v<package.json version>` runs `.github/workflows/release.yml`, which re-runs the 3-OS test matrix and then `npm publish` through npm trusted publishing (OIDC, signed provenance). This machine never runs `npm publish`.

## Steps

1. **Green.** On a feature branch, run `bun run check`. Done when it reports `0 fail`.
2. **Review.** Run `/review` on the branch diff and fix each finding that would fail a test, break a backup, or lose data. Done when a re-review reports none.
3. **Version.** Bump in one commit (minor for features, patch for fixes):
   - `VERSION`: four parts, `X.Y.Z.0`
   - `package.json` `version`: three parts, `X.Y.Z`
   - `CHANGELOG.md`: new top heading `## [X.Y.Z.0] - YYYY-MM-DD` with user-facing bullets
   Done when `bun run check` is still green.
4. **PR.** Push, `gh pr create` with title `vX.Y.Z.0 <type>: <summary>`, then `gh pr checks <n> --watch`. Done when every `Test (*)` check passes (see _Cancelled checks_).
5. **Merge.** `gh pr merge <n> --squash --delete-branch` once the user has approved landing; a request to release counts. Record the merge SHA.
6. **Tag.** `git fetch origin main && git tag v<X.Y.Z> <merge-sha> && git push origin v<X.Y.Z>`. The publish job rejects a tag that differs from `v` + `package.json` version.
7. **Watch.** `gh run list --repo laststance/backup --workflow release.yml --limit 1`, then `gh run watch <run-id>`. Done when the `publish` job succeeds and its log shows `+ @laststance/backup@<X.Y.Z>`.
8. **Verify.** Done when both hold:
   - `curl -s https://registry.npmjs.org/@laststance%2fbackup | jq '{latest: .["dist-tags"].latest, gitHead: .versions["<X.Y.Z>"].gitHead}'` shows `latest` = `<X.Y.Z>` and `gitHead` = the merge SHA.
   - A temp-dir install (`npm install --prefix "$(mktemp -d)" --ignore-scripts @laststance/backup@<X.Y.Z>`) prints `<X.Y.Z>` from `node_modules/.bin/backup --version`.

The global install (`npm i -g`) stays with the user.

## Cancelled checks

A cancelled `Test (macos-latest)` is usually GitHub's macOS arm64 runner shortage, not the code. Confirm through the job's annotations: `gh api repos/laststance/backup/check-runs/<job-id>/annotations` reports `The job was not acquired by Runner of type hosted even after multiple attempts`. Then `gh run rerun <run-id> --failed` and watch again, repeating until a runner picks it up (v0.3.0 took three attempts). Any other cancellation or failure is real: read `gh run view <run-id> --log-failed`.

On the PR, merging with macOS cancelled needs the user's approval; the release workflow re-runs macOS before it publishes.

## Registry lag

The registry trails the publish log by up to ~5 minutes, and `npm view` caches. Poll the curl in step 8; the publish has already happened, so the tag and version stay as they are.
