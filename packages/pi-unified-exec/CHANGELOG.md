# Changelog

## [Unreleased]

### Changed

- Commands started without `tty: true` now run with stdin closed, matching Codex: programs that read stdin see EOF instead of hanging, and `write_stdin` rejects non-empty input (other than Ctrl-C) with an error that tells the model to rerun with `tty=true`.

### Fixed

- Run commands with `PAGER`, `GIT_PAGER`, and `GH_PAGER` set to `cat`, `NO_COLOR=1`, `TERM=dumb`, and an empty `COLORTERM`, so `git log` and similar tools no longer open a pager and wait forever in a PTY session.
- Reclaim the least recently used session (exited sessions first, never the eight most recent) when 64 sessions are open, instead of rejecting every new command once enough sessions had exited without being polled again.

## [0.1.6] - 2026-09-11

### Fixed

- Sanitize terminal control sequences in tool output and call previews before TUI rendering, without changing raw tool results.

## [0.1.5] - 2026-09-08

### Breaking Changes

- The pi extension is now published as `@chensl/pi-unified-exec` instead of `pi-persistent-exec`. Existing users must remove the old package and install the new scoped package.

### Added

- A reproducible release workflow that validates packages before publishing and creates GitHub Releases from this changelog.
