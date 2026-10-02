# Changelog

## [Unreleased]

### Changed

- Commands started without `tty: true` now run with stdin closed, matching Codex: programs that read stdin see EOF instead of hanging, and `write_stdin` rejects non-empty input (other than Ctrl-C) with an error that tells the model to rerun with `tty=true`.

- Tool results sent to the model now use the Codex text format (`Wall time`, `Process exited with code N` or `Process running with session ID N`, `Original token count`, `Output`) instead of a JSON dump. The same data is exposed as `structuredContent` with a declared `outputSchema`, and failed or cancelled commands are flagged with `isError` so pi renders them as errors.
- Replace pi's built-in `powershell` tool together with `bash` while the extension is active, so the model is not offered two competing shell tools on Windows.

### Fixed

- Throttle streaming output updates to 100 ms, format durations like pi's built-in bash tool (`2m 5s`), honor carriage-return overwrites such as progress bars in the preview, and report truncation from the runtime's metadata instead of re-deriving it from the displayed text.
- Keep pi's built-in shell tools and show an error notification when the native runtime fails to load, instead of leaving `exec_command` active without a runtime.
- Create the native runtime on first use when the host never emits `session_start` (for example pi embedded through the SDK), and retry on the next call after a failed load instead of staying unusable.
- Destroy the previous native runtime when a session starts without a preceding shutdown, so a repeated `session_start` no longer leaks one.
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
