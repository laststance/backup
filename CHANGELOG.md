# Changelog

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
