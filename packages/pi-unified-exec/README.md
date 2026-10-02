# @chensl/pi-unified-exec

Persistent shell sessions for [pi](https://github.com/badlogic/pi-mono).

```bash
pi install npm:@chensl/pi-unified-exec
```

The extension replaces pi's built-in `bash` tool with:

- `exec_command`, which starts a command and returns its result or a session ID if it is still running
- `write_stdin`, which sends input to a running session or checks it for more output

Commands use `$SHELL` on Unix and PowerShell on Windows. No additional configuration is needed.

Starting a new session, reloading extensions, or exiting pi terminates processes started by the extension. It runs with the same permissions as pi and does not add a sandbox or approval prompts.

## Output and cancellation

- Output is incremental: each call returns only the output consumed during that call.
- Native buffering retains at most 1 MiB per session between polls, keeping the beginning and end. Tool results and live previews also keep bounded head/tail output (up to 50,000 bytes and approximately 2,000 lines, plus omission/status notices).
- Truncation reports the original size, including bytes omitted by the native runtime. Omitted output is not saved to disk and cannot be recovered by expanding the tool. Redirect a command's output to a file when you need a complete log.
- Cancelling `exec_command` terminates its process and returns captured output, including the bounded termination drain. Cancelling `write_stdin` stops waiting but leaves the session available. Both return `cancelled: true` when cancellation interrupts an active wait; a surviving session is identified by `session_id`.
- Cancelling a queued call or passing invalid parameters does not send input. Interactions with the same session are serialized.
- With `tty: true`, Ctrl-C is sent through the terminal to its foreground job. Without a PTY, Ctrl-C interrupts the process group on Unix and terminates the process/job on Windows. Like Codex, commands without a PTY run with stdin closed; use `tty: true` for interactive input.

Collapsed tools show a short command preview and the last five visual output lines. Expanding reveals the full command and all retained output, not omitted output. Nonzero exits and cancellations use pi's error result status without dropping structured output.
