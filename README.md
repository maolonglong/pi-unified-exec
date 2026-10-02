# pi-unified-exec

Codex-style `unified_exec` for [pi](https://github.com/earendil-works/pi): long-running shell sessions that the model starts, polls, and drives with `write_stdin` (PTY, REPLs, ssh, dev servers, Ctrl-C).

The `@chensl/pi-unified-exec` extension replaces pi's built-in `bash` and `powershell` tools with two tools:

- `exec_command` starts a command and returns its result. If the command is still running, it returns a session ID instead.
- `write_stdin` sends input to a running session or checks it for more output.

This lets pi run interactive commands and keep long-running processes alive between tool calls. Commands use `$SHELL` on Unix and PowerShell on Windows.

## Installation

```bash
pi install npm:@chensl/pi-unified-exec
```

The extension works without additional configuration.

Starting a new session, reloading extensions, or exiting pi terminates processes started by the extension. It runs with the same permissions as pi and does not add a sandbox or approval prompts.

## Development

Run the formatter, linter, and test suite from the repository root:

```bash
make fmt
make lint
make test
```

## License

Apache-2.0. See `NOTICE` for attribution for the process-management code adapted from Codex.
