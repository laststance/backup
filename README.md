# @laststance/backup

Copy files and directories into an existing private GitHub clone with `cp -R`, then commit and push the result.

```sh
backup foo.md
```

## Install and register

Requires Node.js 24+, Git 2.31+, and the [GitHub CLI](https://cli.github.com/). Development uses Bun 1.4.0.

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

Show usage with `backup --help` (`-h`) or the installed version with `backup --version` (`-v`).

## Copy and push behavior

The registered clone is the destination directory. For example, `backup cooking/too.txt notes` performs the copy corresponding to `cp -R -- cooking/too.txt notes <clone>/` before making one backup commit.

| Input | Local copy result |
| --- | --- |
| `backup cooking/too.txt` | `<clone>/too.txt` |
| `backup ~/cooking/too.txt` | `<clone>/too.txt` |
| `backup cooking/recipes` | `<clone>/recipes/…` |
| `backup cooking/recipes/.` | The contents of `recipes` merge into `<clone>/` |
| `backup .` | The current directory's contents merge into `<clone>/` |
| `backup -- -draft.md a.txt` | `<clone>/-draft.md` and `<clone>/a.txt` |

**Upgrading from 0.4.0.** Selecting a nested file now writes to its basename in the clone. Review existing files with the same basename before the first run. Older copies stored under their original hierarchy remain there. Shells expand an unquoted `~` before invoking the CLI. A quoted `~/file` selects the literal `~` directory in the working directory. Directory backups now retain destination-only entries, including files you have removed from the source.

- macOS and Linux use the system `/bin/cp -R`. Windows uses GNU `cp.exe` from Git for Windows. Multiple operands are processed together. The host determines the handling of repeated basenames, type conflicts, permissions, timestamps and links. If copying fails, the working tree may contain partial results. The backup stops before staging, committing or pushing.
- Use `directory/.` to copy its contents on every platform. A trailing slash alone merges contents on macOS. GNU cp keeps the directory name. A plain symlink operand is copied as a link, including a dangling link. A trailing slash on a link to a directory selects the directory.
- On repeated copies, native cp writes existing files in place with their destination permissions. Committing depends on the resulting bytes, Git executable modes and link targets. An unchanged Git tree produces no duplicate commit.
- Git tracks regular files, the owner's execute bit where supported, and symlink targets. Empty directories, special files such as FIFOs, other permission bits, extended attributes, timestamps, and hardlink relationships are local filesystem state. On Windows, symlinks require Developer Mode or suitable privileges. Git records Windows link separators as `/`. With `core.fileMode=false`, existing indexed modes are retained and new regular files use `100644`.
- Selected ignored files are included. Exact `.git` entries are excluded at every depth and metadata aliases are rejected. Other Git-specific checks protect the registered clone, linked worktrees, submodules and hidden index changes. Writes through links must stay in the backup payload. A regular file cannot overwrite a named pipe because opening the pipe could leave the backup waiting indefinitely for a reader. Files over 100 MiB, filenames that cannot be decoded as UTF-8, filesystem roots and overlapping source/clone paths are rejected. The CLI prepares the scanned entries in a private temporary directory, verifies their names, types and contents, then runs the native copy into the clone. Allow space for a temporary copy of the selected data. On macOS, the system bsdtar preserves directory metadata, including extended attributes.
- Git attributes/filters that change bytes, index flags that hide changes to selected paths, and modifying commit hooks cause a visible failure. The CLI does not rewrite attributes or your Git configuration. Automatic CRLF conversion is disabled for its Git commands.
- Git configuration, hooks, and configured transports are trusted and run with your user privileges. Global/system configuration locations (including `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM`) are honored; repository/index/object redirection variables are removed from backup's Git commands.
- The remote must resolve to one GitHub.com private repository for both fetch and push. Privacy, identity, and **Actions disabled** are checked before copying and again before push. An unverifiable check fails closed.
- The registered branch is fetched and fast-forwarded before copying. Divergent histories, dirty working trees, detached HEAD, and branch changes stop the operation. No force push is used.
- **All pending commits on the registered branch are pushed, including manual commits.** An unchanged source still pushes pending history. With no changes and no pending commits, the command reports `Unchanged`.
- The source scan caches settled Git blob IDs in `<git-common-dir>/laststance-backup-manifests/`. A matching inode, size, mode, mtime and ctime allows the scan to reuse a recorded ID. Recent entries are reread. Copied payloads are checked against the source IDs, and Git's staged bytes and modes are verified before committing.
- A changed backup uses a commit message such as `chore(backup): update too.txt, notes`. A repository lock serializes invocations, including linked worktrees. Avoid editing source or destination files or running other Git commands during a backup.

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

If copying, staging, or committing fails, copied files/index changes may remain. The error identifies the affected destination. In the clone, run `git status --short --ignored` to list untracked and ignored paths. Inspect the selected destinations directly to check their contents. Use `git diff` and `git diff --cached` to review tracked and staged changes, then repair or commit deliberately before retrying. Nothing is rolled back.

If push fails or its response is lost, local commits remain. Fix authentication, network, branch, or GitHub settings and rerun the same command. It fetches first, recognizes history already accepted by the remote, and pushes remaining commits without creating a duplicate backup commit for unchanged content.

Ctrl-C releases this invocation's lock after cancellation on Unix. A hard kill/crash can leave `<git-common-dir>/laststance-backup.lock`. Inspect its `owner.json` (hostname and PID), confirm that process has stopped, inspect the working tree, then remove only that lock directory manually. Locks are never deleted based on their age. Windows forced termination may also require this recovery.

## Development

```sh
bun install --frozen-lockfile
bun run check
bun run dev -- --help
bun run bench -- --files 2000
npm pack
```

Bun builds TypeScript into one Node ESM CLI with no npm runtime dependencies. `prepack` builds the distributable. `bun run check` runs type checking, build, real-Git behavior tests, and an isolated npm tarball installation/Node/recovery test. Tests run the built `dist/cli.js`; `bunfig.toml` preloads `test/setup.ts`, which rebuilds it, and `useFixtures()` sets each CLI test file's 30-second timeout, so a bare `bun test` or a single-file run matches `bun run check`. `bun run bench` measures initial, unchanged, and five-file-changed backups of a generated tree on macOS or Linux (`--files`, `--bytes`, and `--cli <bundle>` to compare builds; defaults are the 20,000 × 16 KiB tree behind the 0.3.0 figures). CI is configured to run the same suite on macOS, Linux, and Windows; POSIX signal, permission, and terminal tests are Unix-only. Terminal tests use Python 3's standard-library PTY module on Unix. The large-tree test covers 10,000 paths totaling over 2 MiB, and streamed output is tested with a slow consumer.

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

Subsequent releases use `.github/workflows/release.yml`: update the package version and [changelog](CHANGELOG.md), merge verified changes, configure npm's trusted publisher for GitHub owner `laststance`, repository `backup`, workflow `release.yml`, and allowed action **publish**, then push a matching `v<package-version>` tag. The workflow verifies the tag, tests on all three operating systems, and publishes using OIDC. A manual workflow run only validates the current version unless it runs on its matching tag.

GitHub merge, npm trusted-publisher setup, tagging, and registry publication are separate steps. The workflow cannot create the initial npm package or configure npm account access. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) for the current account setup and CLI requirements.

## License

MIT
