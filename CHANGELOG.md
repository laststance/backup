# Changelog

## [0.4.0.0] - 2026-11-10

### Changed

- Delete tracked files and symlinks under a backed-up directory when the source no longer contains them, so the clone and the pushed commit match the source. This is a breaking change. Earlier versions kept those files. A file or symlink backup still changes only that path.
- Keep every path outside the selection, including previously flattened backups and siblings such as `cooking/recipes2` next to `cooking/recipes`. Ignored files that Git does not track also stay.
- Report `Removed N paths missing from the source.` after a backup that deletes files.

### Security

- Reject a backup before copying when it would delete a submodule or a path with assume-unchanged or skip-worktree set. `git status` does not show edits hidden by those flags, and deleting the file would discard them.

## [0.3.0.0] - 2026-11-03

### Changed

- Repeat a backup of a large directory in seconds. Unchanged files are recognized from their recorded inode, size, mode, mtime, and ctime, so they are neither reread nor recopied: 20,000 files (320 MB) that took 25–146 s to recheck now finish in about 2 s.
- Leave files already committed with the same bytes and mode untouched in the clone instead of rewriting them on every run.
- Keep those records in `<git-common-dir>/laststance-backup-manifests/`, never in the backed-up content. A missing or corrupt record triggers a full recheck, a record that cannot be written prints a warning without stopping the backup, and deleting the directory forces a full recheck.
- Like rsync's quick check, a content change that keeps all of that metadata identical is not detected. Files changed within 10 seconds of a scan are always reread.

## [0.2.0.0] - 2026-10-07

### Changed

- Preserve the hierarchy of relative sources: `backup cooking/too.txt` now saves only that file at `cooking/too.txt`, creating missing parent directories. Directory sources continue to copy recursively at their selected path.
- Preserve home-relative paths for `~/…` and absolute sources inside the user's home. Absolute sources outside home retain basename-only copying.
- Keep previously flattened backups in place when a later backup creates the new nested path. No automatic moves or deletions occur.

### Fixed

- Treat redundant separators after `~/` as home-relative and preserve literal backslashes in POSIX filenames.
- Accept fully absolute and home-relative sources even if the invocation directory has been removed.

### Security

- Validate all destination ancestors before creating directories or copying selected files, including symlink, submodule, metadata, and tracked-path conflicts.
- Reject relative paths that escape the invocation directory and ambiguous Windows drive-relative paths. Use an absolute or home-relative source when selecting files outside the invocation directory.

## [0.1.1.0] - 2026-10-03

### Fixed

- Include the repository's GitHub Actions settings URL and disable steps in the rejection shown when destination Actions are enabled.
- Accept underscore owner names so Enterprise Managed User accounts can register their private repositories.

### Security

- Reject enterprise-internal repositories, which report `private: true` yet remain readable by every enterprise member.
- Apply one strict `owner/repo` grammar to remote URLs, API metadata, and stored configuration, rejecting dot-segment and overlong names.

## [0.1.0.0] - 2026-09-09

### Added

- Back up one file or directory to a registered existing private GitHub clone with `backup <path>`.
- Preserve selected file bytes and symlinks, retain destination-only files, and reject unsafe paths or type conflicts before copying.
- Verify private repository identity and disabled Actions, then commit and push all pending registered-branch history.
- Recover after failed pushes without duplicate commits, with explicit manual recovery guidance for interrupted copies and commits.
- Install as a Node.js CLI from npm and recover saved files using the documented Git procedure.
