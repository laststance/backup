# Changelog

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
