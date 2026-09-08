# @laststance/backup

Copy a file or directory into an existing private GitHub clone, commit the change, and push it.

```sh
backup foo.md
```

## Install and register

Requires Node.js 24+, Git 2.31+, and the [GitHub CLI](https://cli.github.com/). Bun is needed only for development.

```sh
npm install --global @laststance/backup
gh auth login

# Create/clone your private destination yourself, then disable its Actions.
# GitHub: repository Settings → Actions → General → Disable actions.
backup --repo ~/private-backup
backup foo.md
backup ./notes
```

The destination must be a clean, existing clone, checked out on the branch you want to back up to. Git commit identity and push authentication must already work. `gh` needs permission to read the repository and its Actions settings (the latter requires administration read access). The CLI never creates a repository or changes GitHub settings.

If no destination is registered, an interactive invocation asks for its directory. In scripts, provide `--repo <directory>`. Registration alone does not copy or push. To register and back up in one command:

```sh
backup --repo ~/private-backup ./notes
backup -- -draft.md
```

One destination is saved in `~/.config/laststance-backup/config.json`: its canonical local path, branch, GitHub repository ID, and name. No credentials are stored. Register again with `--repo` to change it. Source paths are supplied on each invocation.

## Copy and push behavior

| Input                    | Destination       |
| ------------------------ | ----------------- |
| `backup ./drafts/foo.md` | `<clone>/foo.md`  |
| `backup ./notes`         | `<clone>/notes/…` |

- One source per command. Same-type files are overwritten; files absent from the source are retained. Sources sharing a basename share their destination.
- Files hidden by `.gitignore` are included when selected. Exact `.git` entries at every source depth are excluded; metadata aliases such as `.GIT` reject the operation.
- Regular file bytes, executable bits where Git tracks filesystem modes, and symlink target text/types are checked against the staged Git blobs before committing. With `core.fileMode=false` (usual on Windows), existing Git executable modes are preserved and new regular files use `100644`. Symlinks are copied without following them. On Windows, creating/restoring symlinks requires Developer Mode or suitable privileges.
- Files over 100 MiB, special files, overlapping source/destination paths, sparse checkouts, selected submodules, and file/directory/symlink type conflicts are rejected. Empty directories, timestamps, ownership, extended attributes, and hardlink relationships are not preserved by Git.
- Git attributes/filters that change bytes, index flags that hide selected changes, and modifying commit hooks cause a visible failure. The CLI does not rewrite attributes or your Git configuration. Automatic CRLF conversion is disabled for its Git commands.
- The remote must resolve to one GitHub.com private repository for both fetch and push. Privacy, identity, and **Actions disabled** are checked before copying and again before push. An unverifiable check fails closed.
- The registered branch is fetched and fast-forwarded before copying. Divergent histories, dirty working trees, detached HEAD, and branch changes stop the operation. No force push is used.
- **All pending commits on the registered branch are pushed, including manual commits.** An unchanged source still pushes pending history. With no changes and no pending commits, the command reports `Unchanged`.
- A changed backup uses `chore(backup): update <basename>`. A repository lock serializes CLI invocations, including linked worktrees. Avoid running other Git commands or changing source/destination files during a backup; the lock does not control other programs.

## Recover your files

Recover into a new directory. Local override attributes prevent committed `.gitattributes` from applying checkout conversions or smudge filters. These commands work in a POSIX shell or Git Bash:

```sh
git clone --no-checkout git@github.com:OWNER/PRIVATE-REPO.git recovered-backup
cd recovered-backup
printf '* -text -filter -ident -working-tree-encoding\n' > .git/info/attributes
git -c core.autocrlf=false -c core.symlinks=true checkout --force main
```

Replace `main` with the registered branch or a specific backup commit. On Windows, use a filesystem and account that can create symlinks if the backup includes them. Copy the recovered files to their intended location after inspecting them. The test suite runs this procedure against a real bare remote and compares binary bytes, CRLF text, executable bits, and symlink targets.

For a single regular file, Git can emit its stored bytes directly:

```sh
git show 'COMMIT:notes/foo.md' > /absolute/recovery/foo.md
```

This last command recovers bytes only; use the checkout procedure for symlinks and executable modes. There is no restore subcommand.

## Failures and retries

Errors identify the failed phase and exit nonzero. Git/gh commands time out after two minutes. The CLI never reports an unconfirmed push as successful.

If copying, staging, or committing fails, copied files/index changes may remain. The error identifies the affected destination. Inspect `git status` and `git diff`/`git diff --cached` there, then repair or commit deliberately before retrying. Nothing is automatically rolled back or deleted.

If push fails or its response is lost, local commits remain. Fix authentication, network, branch, or GitHub settings and rerun the same command. It fetches first, recognizes history already accepted by the remote, and pushes remaining commits without creating a duplicate backup commit for unchanged content.

Ctrl-C releases this invocation's lock after cancellation on Unix. A hard kill/crash can leave `<git-common-dir>/laststance-backup.lock`. Inspect its `owner.json` (hostname and PID), confirm that process has stopped, inspect the working tree, then remove only that lock directory manually. Locks are never deleted based on their age. Windows forced termination may also require this recovery.

## Development

```sh
bun install --frozen-lockfile
bun run check
bun run dev -- --help
npm pack
```

Bun builds TypeScript into one Node ESM CLI with no npm runtime dependencies. `prepack` builds the distributable. `bun run check` runs type checking, build, real-Git behavior tests, and an isolated npm tarball installation/Node/recovery test. macOS, Linux, and Windows run the same suite in CI; POSIX signal, permission, and terminal tests are Unix-only. Terminal tests use Python 3's standard-library PTY module on Unix. The large-tree test covers 10,000 paths totaling over 2 MiB, and streamed output is tested with a slow consumer.

## Release

The initial release requires a maintainer with publish access to the `@laststance` npm scope:

```sh
bun install --frozen-lockfile
bun run check
npm pack
npm publish ./laststance-backup-0.1.0.tgz --access public
npm view @laststance/backup version
```

Use the tarball matching the package version. `npm publish` can require interactive authentication/2FA; a successful login alone does not prove publication.

Subsequent releases use `.github/workflows/release.yml`: update the package version and changelog, merge verified changes, configure npm's trusted publisher for GitHub owner `laststance`, repository `backup`, workflow `release.yml`, and allowed action **publish**, then push a matching `v<package-version>` tag. The workflow verifies the tag, tests on all three operating systems, and publishes using OIDC. A manual workflow run only validates the current version unless it runs on its matching tag.

GitHub merge, npm trusted-publisher setup, tagging, and registry publication are separate steps. The workflow cannot create the initial npm package or configure npm account access. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) for the current account setup and CLI requirements.

## License

MIT
