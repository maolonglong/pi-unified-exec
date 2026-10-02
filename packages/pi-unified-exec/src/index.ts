import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  previewInput,
  type RenderState,
  sanitizeDisplayText,
  startRenderTimer,
  ToolCallRenderComponent,
  ToolResultRenderComponent,
  updateRenderTimer,
} from "./render";
import { approxTokens, buildOutput, outputSchema, type ToolOutput, toolResult } from "./result";
import { loadSdk, type RuntimeApi } from "./sdk";
import {
  drainTerminatedSession,
  type OutputSnapshot,
  waitForSession,
  withSessionLock,
} from "./session";

const EXEC_TOOL = "exec_command";
const STDIN_TOOL = "write_stdin";
/** Built-in shell tools this extension supersedes while it is active. */
const REPLACED_TOOLS = new Set(["bash", "powershell"]);
const DEFAULT_EXEC_YIELD_MS = 10_000;
const DEFAULT_WRITE_YIELD_MS = 250;
const DEFAULT_POLL_YIELD_MS = 5_000;
const MIN_YIELD_MS = 250;
const MIN_WINDOWS_EXEC_YIELD_MS = 10_000;
const MIN_POLL_YIELD_MS = 5_000;
const MAX_WRITE_YIELD_MS = 30_000;
const MAX_POLL_YIELD_MS = 300_000;
const DEFAULT_OUTPUT_TOKENS = 10_000;
const MAX_OUTPUT_TOKENS = 12_500;
const BYTES_PER_TOKEN = 4;

const execParameters = Type.Object(
  {
    cmd: Type.String({ description: "Shell command to execute." }),
    workdir: Type.Optional(
      Type.String({ description: "Working directory for the command. Defaults to the turn cwd." }),
    ),
    tty: Type.Optional(
      Type.Boolean({
        description: "True allocates a PTY for the command; false or omitted uses plain pipes.",
      }),
    ),
    yield_time_ms: Type.Optional(
      Type.Number({
        description:
          process.platform === "win32"
            ? "Maximum time to wait before returning a session ID for a still-running command. Commands that finish sooner return immediately. For ordinary commands, omit this parameter to use the 10000 ms default. Effective range on Windows is 10000-30000 ms."
            : "Wait before yielding output. Defaults to 10000 ms; effective range is 250-30000 ms.",
      }),
    ),
    max_output_tokens: Type.Optional(
      Type.Number({
        description:
          "Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy.",
      }),
    ),
  },
  { additionalProperties: false },
);

const stdinParameters = Type.Object(
  {
    session_id: Type.Number({
      description: "Identifier of the running unified exec session.",
    }),
    chars: Type.Optional(
      Type.String({
        description: "Bytes to write to stdin. Defaults to empty, which polls without writing.",
      }),
    ),
    yield_time_ms: Type.Optional(
      Type.Number({
        description:
          "Wait before yielding output. Non-empty writes default to 250 ms and cap at 30000 ms; empty polls wait 5000-300000 ms by default.",
      }),
    ),
    max_output_tokens: Type.Optional(
      Type.Number({
        description:
          "Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy.",
      }),
    ),
  },
  { additionalProperties: false },
);

export default function persistentExecExtension(pi: ExtensionAPI): void {
  let runtime: RuntimeApi | null = null;
  let creating: Promise<RuntimeApi> | null = null;
  // Bumped whenever the runtime is torn down so a creation still in flight cannot install itself.
  let generation = 0;
  let prepared = false;
  const sessionInteractions = new Map<number, Promise<void>>();

  function destroyRuntime(): void {
    generation += 1;
    creating = null;
    prepared = false;
    runtime?.destroy();
    runtime = null;
    sessionInteractions.clear();
  }

  /** One native runtime per pi session, created on first use and shared by concurrent callers. */
  function ensureRuntime(): Promise<RuntimeApi> {
    if (runtime) return Promise.resolve(runtime);
    if (!creating) {
      const owner = generation;
      const attempt = createRuntime(owner);
      creating = attempt;
      const settle = () => {
        if (creating === attempt) creating = null;
      };
      attempt.then(settle, settle);
    }
    return creating;
  }

  async function createRuntime(owner: number): Promise<RuntimeApi> {
    const sdk = await loadSdk();
    const created = sdk.PersistentExecRuntime.create();
    if (owner !== generation) {
      created.destroy();
      throw new Error("persistent-exec runtime was shut down while starting");
    }
    runtime = created;
    return created;
  }

  /** Swaps pi's shell tools for ours, or hands shell access back and tells the user on failure. */
  async function prepareSession(ctx: UiContext | undefined): Promise<void> {
    prepared = true;
    const others = pi.getActiveTools().filter((name) => name !== EXEC_TOOL && name !== STDIN_TOOL);
    try {
      await ensureRuntime();
    } catch (error) {
      // pi activates newly registered tools; without a runtime they could only fail.
      pi.setActiveTools(others);
      const reason = error instanceof Error ? error.message : String(error);
      ctx?.ui?.notify?.(
        `pi-unified-exec could not start its native runtime (${reason}); using pi's built-in shell tools.`,
        "error",
      );
      return;
    }
    pi.setActiveTools([
      ...others.filter((name) => !REPLACED_TOOLS.has(name)),
      EXEC_TOOL,
      STDIN_TOOL,
    ]);
  }

  pi.registerTool({
    name: EXEC_TOOL,
    label: "exec",
    description:
      process.platform === "win32"
        ? `Runs a command in a PTY, returning output or a session ID for ongoing interaction.\n\n${windowsShellGuidance()}`
        : "Runs a command in a PTY, returning output or a session ID for ongoing interaction.",
    promptSnippet: "Execute shell commands with persistent sessions and optional PTY interaction",
    parameters: execParameters,
    outputSchema,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const yieldMs = clampExecYield(
        optionalUnsignedInteger(params.yield_time_ms, "yield_time_ms") ?? DEFAULT_EXEC_YIELD_MS,
      );
      const maxOutputTokens =
        optionalUnsignedInteger(params.max_output_tokens, "max_output_tokens") ??
        DEFAULT_OUTPUT_TOKENS;
      signal?.throwIfAborted();
      const activeRuntime = await ensureRuntime();
      const sessionId = activeRuntime.spawn({
        cmd: params.cmd,
        workdir: resolve(ctx.cwd, params.workdir ?? "."),
        tty: params.tty ?? false,
      });
      return withSessionLock(sessionInteractions, sessionId, undefined, async () => {
        const startedAt = performance.now();
        onUpdate?.({ content: [], details: { session_id: sessionId, output: "" } });
        let waited;
        try {
          waited = await waitForSession(activeRuntime, sessionId, {
            yieldMs,
            maxBytes: outputBudgetBytes(maxOutputTokens),
            signal,
            onOutput: streamOutput(sessionId, onUpdate),
            terminateOnAbort: true,
          });
        } catch (error) {
          activeRuntime.terminate(sessionId);
          await drainTerminatedSession(activeRuntime, sessionId);
          throw error;
        }
        return toolResult(buildOutput(waited, sessionId, startedAt));
      });
    },
    renderCall(args, theme, context) {
      startRenderTimer(context.state as RenderState, context.executionStarted);
      const component =
        (context.lastComponent as ToolCallRenderComponent | undefined) ??
        new ToolCallRenderComponent(theme);
      component.update(args.cmd || "...", theme, context.expanded);
      return component;
    },
    renderResult(result, options, theme, context) {
      updateRenderTimer(context.state as RenderState, options.isPartial, context.isError, context);
      const component =
        (context.lastComponent as ToolResultRenderComponent | undefined) ??
        new ToolResultRenderComponent();
      component.update(result, options, context.state as RenderState, theme, context.isError);
      return component;
    },
  });

  pi.registerTool({
    name: STDIN_TOOL,
    label: "stdin",
    description: "Writes characters to an existing unified exec session and returns recent output.",
    promptSnippet: "Write to or poll a running exec_command session",
    parameters: stdinParameters,
    outputSchema,
    async execute(_toolCallId, params, signal, onUpdate) {
      const sessionId = positiveInteger(params.session_id, "session_id");
      const chars = params.chars ?? "";
      const defaultYield = chars === "" ? DEFAULT_POLL_YIELD_MS : DEFAULT_WRITE_YIELD_MS;
      const requestedYield =
        optionalUnsignedInteger(params.yield_time_ms, "yield_time_ms") ?? defaultYield;
      const yieldMs = clampWriteYield(requestedYield, chars === "");
      const maxOutputTokens =
        optionalUnsignedInteger(params.max_output_tokens, "max_output_tokens") ??
        DEFAULT_OUTPUT_TOKENS;
      return withSessionLock(sessionInteractions, sessionId, signal, async () => {
        // Without a runtime no session can exist, so a poll fails like any unknown session ID.
        const activeRuntime = runtime;
        if (!activeRuntime) throw new Error(`unknown session_id ${sessionId}`);
        signal?.throwIfAborted();
        if (chars !== "") activeRuntime.write(sessionId, chars);

        const startedAt = performance.now();
        onUpdate?.({ content: [], details: { session_id: sessionId, output: "" } });
        const waited = await waitForSession(activeRuntime, sessionId, {
          yieldMs,
          maxBytes: outputBudgetBytes(maxOutputTokens),
          signal,
          onOutput: streamOutput(sessionId, onUpdate),
        });
        return toolResult(buildOutput(waited, sessionId, startedAt));
      });
    },
    renderCall(args, theme, context) {
      const state = context.state as RenderState;
      startRenderTimer(state, context.executionStarted);
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const label = args.chars
        ? `Wrote to session ${args.session_id}`
        : `${context.isPartial ? "Waiting" : "Waited"} for session ${args.session_id}`;
      const input = args.chars ? ` · ${previewInput(args.chars)}` : "";
      text.setText(
        `${theme.fg("toolTitle", theme.bold(args.chars ? "↳" : "•"))} ${theme.fg("dim", sanitizeDisplayText(`${label}${input}`))}`,
      );
      return text;
    },
    renderResult(result, options, theme, context) {
      updateRenderTimer(context.state as RenderState, options.isPartial, context.isError, context);
      const component =
        (context.lastComponent as ToolResultRenderComponent | undefined) ??
        new ToolResultRenderComponent();
      component.update(result, options, context.state as RenderState, theme, context.isError);
      return component;
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    // A start without a preceding shutdown must not leak the previous runtime.
    destroyRuntime();
    await prepareSession(ctx);
  });

  // Hosts embedding pi through the SDK can prompt without emitting session_start.
  pi.on("before_agent_start", async (_event, ctx) => {
    if (!prepared) await prepareSession(ctx);
  });

  pi.on("session_shutdown", async () => {
    destroyRuntime();
  });
}

type UiContext = {
  ui?: { notify?: (message: string, type?: "info" | "warning" | "error") => void };
};

type UpdateSink =
  | ((update: {
      content: Array<{ type: "text"; text: string }>;
      details: Partial<ToolOutput>;
    }) => void)
  | undefined;

/** Forwards a bounded output snapshot to pi as a partial tool result. */
function streamOutput(sessionId: number, onUpdate: UpdateSink): (snapshot: OutputSnapshot) => void {
  return (snapshot) =>
    onUpdate?.({
      content: [{ type: "text", text: snapshot.output }],
      details: {
        session_id: sessionId,
        output: snapshot.output,
        ...(snapshot.truncated
          ? { truncated: true, original_token_count: approxTokens(snapshot.originalBytes) }
          : {}),
      },
    });
}

function outputBudgetBytes(maxOutputTokens: number): number {
  return Math.min(maxOutputTokens, MAX_OUTPUT_TOKENS) * BYTES_PER_TOKEN;
}

function windowsShellGuidance(): string {
  return `Windows safety rules:
- Do not compose destructive filesystem commands across shells. Do not enumerate paths in PowerShell and then pass them to \`cmd /c\`, batch builtins, or another shell for deletion or moving. Use one shell end-to-end, prefer native PowerShell cmdlets such as \`Remove-Item\` / \`Move-Item\` with \`-LiteralPath\`, and avoid string-built shell commands for file operations.
- Before any recursive delete or move on Windows, verify the resolved absolute target paths stay within the intended workspace or explicitly named target directory. Never issue a recursive delete or move against a computed path if the final target has not been checked.
- When using \`Start-Process\` to launch a background helper or service, pass \`-WindowStyle Hidden\` unless the user explicitly asked for a visible interactive window. Use visible windows only for interactive tools the user needs to see or control.`;
}

function optionalUnsignedInteger(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function clampExecYield(yieldMs: number): number {
  const minimum = process.platform === "win32" ? MIN_WINDOWS_EXEC_YIELD_MS : MIN_YIELD_MS;
  return Math.min(Math.max(yieldMs, minimum), MAX_WRITE_YIELD_MS);
}

function clampWriteYield(yieldMs: number, emptyPoll: boolean): number {
  const minimum = emptyPoll ? MIN_POLL_YIELD_MS : MIN_YIELD_MS;
  const maximum = emptyPoll ? MAX_POLL_YIELD_MS : MAX_WRITE_YIELD_MS;
  return Math.min(Math.max(yieldMs, minimum), maximum);
}
