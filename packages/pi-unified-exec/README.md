# @chensl/pi-unified-exec

Codex-style `unified_exec` for [pi](https://github.com/badlogic/pi-mono): long-running shell sessions that the model starts, polls, and drives with `write_stdin`, instead of one blocking `bash` call per command.

```bash
pi install npm:@chensl/pi-unified-exec
```

## What the model can do

pi's built-in `bash` runs a command to completion. With this extension the model can also:

- run a dev server, test watcher, or long build, get its session ID back after the first few seconds, and poll for new output while it keeps working
- drive a REPL, `ssh`, a debugger, or any prompt-driven program with `tty: true`, writing input and keystrokes such as Ctrl-C (`\u0003`) to the running process
- stop waiting on a slow command (cancel `write_stdin`) while it keeps running in its session

The extension replaces pi's built-in `bash` and `powershell` tools with:

- `exec_command`, which starts a command and returns its result or a session ID if it is still running
- `write_stdin`, which sends input to a running session or checks it for more output

A typical exchange:

```text
exec_command  {cmd: "npm run dev", yield_time_ms: 5000}
  -> Process running with session ID 3 ...        (server is up, output so far)
write_stdin   {session_id: 3}                       (poll for new output later)
write_stdin   {session_id: 3, chars: "\u0003"}      (Ctrl-C; needs tty: true)
  -> Process exited ...                            (the server stopped)
```

Tool names, parameters, and result text follow Codex, so prompts written for Codex's `unified_exec` carry over. The runtime is native Rust and runs on Linux, macOS, and Windows. It keeps output and session counts bounded, and terminates the process group (Unix) or Job Object (Windows) of its sessions when pi shuts down.

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
