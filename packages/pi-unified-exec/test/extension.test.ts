import { expect, spyOn, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { type ExtensionAPI, initTheme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import persistentExecExtension from "../src/index";
import { loadSdk, type RuntimeApi } from "../src/sdk";

initTheme("dark");

const PERSISTENT_SESSION_TEST_TIMEOUT_MS = process.platform === "win32" ? 15_000 : 5_000;

interface RenderContext {
  args: Record<string, unknown>;
  state: Record<string, unknown>;
  lastComponent?: Component;
  invalidate(): void;
  executionStarted: boolean;
  expanded: boolean;
  isPartial: boolean;
  isError: boolean;
}

interface TestTheme {
  bold(text: string): string;
  fg(color: string, text: string): string;
}

interface RegisteredTool {
  description: string;
  parameters: Record<string, unknown>;
  promptSnippet?: string;
  promptGuidelines?: string[];
  outputSchema?: Record<string, unknown>;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: ((update: { content: Array<{ type: string; text: string }> }) => void) | undefined,
    context: { cwd: string },
  ): Promise<{
    content: Array<{ type: string; text: string }>;
    details: Record<string, unknown>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  }>;
  renderCall?(args: Record<string, any>, theme: TestTheme, context: RenderContext): Component;
  renderResult?(
    result: { content: Array<{ type: string; text: string }>; details?: Record<string, unknown> },
    options: { expanded: boolean; isPartial: boolean },
    theme: TestTheme,
    context: RenderContext,
  ): Component;
}

const plainTheme: TestTheme = {
  bold: (text) => text,
  fg: (_color, text) => text,
};

function renderContext(
  args: Record<string, unknown>,
  state: Record<string, unknown> = {},
): RenderContext {
  return {
    args,
    state,
    invalidate() {},
    executionStarted: true,
    expanded: false,
    isPartial: true,
    isError: false,
  };
}

function createHarness() {
  const tools = new Map<string, RegisteredTool>();
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  let activeTools = ["read", "bash", "powershell", "write"];
  const pi = {
    registerTool(tool: RegisteredTool & { name: string }) {
      tools.set(tool.name, tool);
    },
    on(event: string, handler: (...args: unknown[]) => Promise<unknown>) {
      handlers.set(event, handler);
    },
    getActiveTools() {
      return activeTools;
    },
    setActiveTools(names: string[]) {
      activeTools = names;
    },
  };

  persistentExecExtension(pi as unknown as ExtensionAPI);
  return {
    tools,
    handlers,
    activeTools: () => activeTools,
  };
}

test("matches Codex tool descriptions", () => {
  const { tools } = createHarness();
  const exec = tools.get("exec_command");
  const stdin = tools.get("write_stdin");
  if (!exec || !stdin) throw new Error("persistent tools were not registered");

  const windowsGuidance = `Windows safety rules:
- Do not compose destructive filesystem commands across shells. Do not enumerate paths in PowerShell and then pass them to \`cmd /c\`, batch builtins, or another shell for deletion or moving. Use one shell end-to-end, prefer native PowerShell cmdlets such as \`Remove-Item\` / \`Move-Item\` with \`-LiteralPath\`, and avoid string-built shell commands for file operations.
- Before any recursive delete or move on Windows, verify the resolved absolute target paths stay within the intended workspace or explicitly named target directory. Never issue a recursive delete or move against a computed path if the final target has not been checked.
- When using \`Start-Process\` to launch a background helper or service, pass \`-WindowStyle Hidden\` unless the user explicitly asked for a visible interactive window. Use visible windows only for interactive tools the user needs to see or control.`;
  const execDescription =
    process.platform === "win32"
      ? `Runs a command in a PTY, returning output or a session ID for ongoing interaction.\n\n${windowsGuidance}`
      : "Runs a command in a PTY, returning output or a session ID for ongoing interaction.";

  expect({
    exec: {
      description: exec.description,
      promptSnippet: exec.promptSnippet,
      promptGuidelines: exec.promptGuidelines,
    },
    stdin: {
      description: stdin.description,
      promptSnippet: stdin.promptSnippet,
      promptGuidelines: stdin.promptGuidelines,
    },
  }).toEqual({
    exec: {
      description: execDescription,
      promptSnippet: "Execute shell commands with persistent sessions and optional PTY interaction",
      promptGuidelines: undefined,
    },
    stdin: {
      description:
        "Writes characters to an existing unified exec session and returns recent output.",
      promptSnippet: "Write to or poll a running exec_command session",
      promptGuidelines: undefined,
    },
  });
});

test("matches Codex schemas for supported parameters", () => {
  const { tools } = createHarness();
  const exec = tools.get("exec_command");
  const stdin = tools.get("write_stdin");
  if (!exec || !stdin) throw new Error("persistent tools were not registered");

  const schema = (tool: RegisteredTool) => JSON.parse(JSON.stringify(tool.parameters));
  const outputBudget =
    "Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy.";
  const execYield =
    process.platform === "win32"
      ? "Maximum time to wait before returning a session ID for a still-running command. Commands that finish sooner return immediately. For ordinary commands, omit this parameter to use the 10000 ms default. Effective range on Windows is 10000-30000 ms."
      : "Wait before yielding output. Defaults to 10000 ms; effective range is 250-30000 ms.";

  expect(schema(exec)).toEqual({
    type: "object",
    properties: {
      cmd: { type: "string", description: "Shell command to execute." },
      workdir: {
        type: "string",
        description: "Working directory for the command. Defaults to the turn cwd.",
      },
      tty: {
        type: "boolean",
        description: "True allocates a PTY for the command; false or omitted uses plain pipes.",
      },
      yield_time_ms: { type: "number", description: execYield },
      max_output_tokens: { type: "number", description: outputBudget },
    },
    required: ["cmd"],
    additionalProperties: false,
  });
  expect(schema(stdin)).toEqual({
    type: "object",
    properties: {
      session_id: {
        type: "number",
        description: "Identifier of the running unified exec session.",
      },
      chars: {
        type: "string",
        description: "Bytes to write to stdin. Defaults to empty, which polls without writing.",
      },
      yield_time_ms: {
        type: "number",
        description:
          "Wait before yielding output. Non-empty writes default to 250 ms and cap at 30000 ms; empty polls wait 5000-300000 ms by default.",
      },
      max_output_tokens: { type: "number", description: outputBudget },
    },
    required: ["session_id"],
    additionalProperties: false,
  });
});

test("truncates exec calls by visual lines", () => {
  const exec = createHarness().tools.get("exec_command");
  if (!exec?.renderCall) throw new Error("exec call renderer was not registered");

  const command = "x".repeat(80);
  const component = exec.renderCall({ cmd: command }, plainTheme, renderContext({ cmd: command }));
  const lines = component.render(10);

  expect(command).not.toContain("\n");
  expect(lines).toHaveLength(4);
  expect(lines.slice(0, 3).join("")).toStartWith("$ ");
  expect(lines[3]).toBe("… +6 lines");

  const expandedContext = renderContext({ cmd: command });
  expandedContext.expanded = true;
  expandedContext.lastComponent = component;
  const expanded = exec.renderCall({ cmd: command }, plainTheme, expandedContext);
  expect(expanded.render(10).join("")).toContain(command);
});

test("renders a compact output tail and full expanded output", () => {
  const exec = createHarness().tools.get("exec_command");
  if (!exec?.renderResult) throw new Error("exec renderer was not registered");
  const result = {
    content: [{ type: "text", text: "ignored" }],
    details: {
      output: Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join("\n"),
      exit_code: 0,
      wall_time_seconds: 1.25,
    },
  };
  const context = renderContext({ cmd: "printf output" });

  const collapsed = exec.renderResult(
    result,
    { expanded: false, isPartial: false },
    plainTheme,
    context,
  );
  const collapsedText = collapsed.render(80).join("\n");
  expect(collapsedText).toContain("3 earlier lines");
  expect(collapsedText).not.toContain("line 1");
  expect(collapsedText).toContain("line 8");
  expect(collapsedText).toContain("Exit 0 · 8 lines · took 1.3s");

  context.lastComponent = collapsed;
  const expanded = exec.renderResult(
    result,
    { expanded: true, isPartial: false },
    plainTheme,
    context,
  );
  expect(expanded.render(80).join("\n")).toContain("line 1");
});

test("renders untrusted output as text without changing tool results", () => {
  const output =
    "中文🙂\tstart\x1b[31mRED\x1b[0m\x1b[2J\x1b[H\x1b[?25l" +
    "\x1b]2;TITLE\x07\x1b]52;c;VEVTVA==\x1b\\" +
    "\x00\x07\b\x7f\x9b2J\x85\ufff9end\nsecond";
  const tools = createHarness().tools;
  for (const name of ["exec_command", "write_stdin"]) {
    const tool = tools.get(name)!;
    for (const expanded of [false, true]) {
      for (const isPartial of [false, true]) {
        for (const isError of [false, true]) {
          const context = renderContext({});
          context.isError = isError;
          const result = {
            content: [{ type: "text", text: output }],
            ...(isError ? {} : { details: { output, exit_code: 0 } }),
          };
          const before = JSON.stringify(result);
          const component = tool.renderResult!(
            result,
            { expanded, isPartial },
            plainTheme,
            context,
          );
          const rendered = component.render(100).join("\n");
          expect(rendered).toContain("中文🙂   startREDend");
          expect(rendered).toContain("second");
          expect(rendered).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f\ufff9-\ufffb]/);
          expect(JSON.stringify(result)).toBe(before);
        }
      }
    }
  }
});

test("neutralizes incomplete escape sequences and untrusted call titles", () => {
  const tools = createHarness().tools;
  const exec = tools.get("exec_command")!;
  for (const suffix of ["\x1b", "\x1b[", "\x1b]52;c;", "\x90payload", "\x1bPpayload"]) {
    const output = `safe${suffix}`;
    for (const expanded of [false, true]) {
      const context = renderContext({ cmd: output });
      context.expanded = expanded;
      context.executionStarted = false;
      const call = exec.renderCall!({ cmd: output }, plainTheme, context);
      const result = exec.renderResult!(
        { content: [], details: { output } },
        { expanded, isPartial: true },
        plainTheme,
        context,
      );
      for (const component of [call, result]) {
        const rendered = component.render(100).join("\n");
        expect(rendered).toContain("safe");
        expect(rendered).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
      }
    }
  }
  const args = { session_id: 1, chars: "\x9dtitle\x9c" };
  const context = renderContext(args);
  context.executionStarted = false;
  const rendered = tools.get("write_stdin")!.renderCall!(args, plainTheme, context).render(100);
  expect(rendered.join("\n")).not.toMatch(/[\x7f-\x9f]/);
});

test("keeps every streamed escape prefix safe when reusing render components", () => {
  const tools = createHarness().tools;
  const sequences = [
    "\x1b[2J",
    "\x1b]52;c;VEVTVA==\x1b\\",
    "\x9d52;c;VEVTVA==\x9c",
    "\x1bPpayload\x1b\\",
  ];
  for (const name of ["exec_command", "write_stdin"]) {
    for (const expanded of [false, true]) {
      const context = renderContext({});
      for (const sequence of sequences) {
        for (let length = 0; length <= sequence.length; length++) {
          const output = `first\nsecond\nthird\nfourth\nfifth\nsafe${sequence.slice(0, length)}`;
          const component = tools.get(name)!.renderResult!(
            { content: [], details: { output } },
            { expanded, isPartial: true },
            plainTheme,
            context,
          );
          context.lastComponent = component;
          // keyHint uses the global theme; allow its SGR styling, not cursor/OSC controls.
          const frame = component
            .render(40)
            .join("\n")
            .replace(/\x1b\[[0-9;]*m/g, "");
          expect(frame).toContain("safe");
          expect(frame).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
        }
      }
      const final = tools.get(name)!.renderResult!(
        { content: [], details: { output: "finished", exit_code: 0 } },
        { expanded, isPartial: false },
        plainTheme,
        context,
      );
      const frame = final.render(60).join("\n");
      expect(frame).toContain("finished");
      expect(frame).not.toContain("safe");
      expect(frame).not.toContain("earlier lines");
    }
  }
});

test("renders live and persistent session states", () => {
  const exec = createHarness().tools.get("exec_command");
  if (!exec?.renderCall || !exec.renderResult)
    throw new Error("exec renderers were not registered");
  const state: Record<string, unknown> = {};
  const callContext = renderContext({ cmd: "sleep 30" }, state);
  exec.renderCall({ cmd: "sleep 30" }, plainTheme, callContext);
  const resultContext = renderContext({ cmd: "sleep 30" }, state);

  const partial = exec.renderResult(
    {
      content: [],
      details: { output: "ready", session_id: 42 },
    },
    { expanded: false, isPartial: true },
    plainTheme,
    resultContext,
  );
  expect(partial.render(80).join("\n")).toContain("Running · session 42 · elapsed");

  resultContext.lastComponent = partial;
  state.startedAt = 1_000;
  state.endedAt = 6_000;
  const waiting = exec.renderResult(
    {
      content: [{ type: "text", text: "ignored" }],
      details: { output: "ready", session_id: 42, wall_time_seconds: 0.25 },
    },
    { expanded: false, isPartial: false },
    plainTheme,
    resultContext,
  );
  expect(waiting.render(80).join("\n")).toContain("Session 42 running · 1 line · waited 5.0s");
  expect(state.interval).toBeUndefined();
});

test("renders semantic stdin actions with bounded escaped input", () => {
  const stdin = createHarness().tools.get("write_stdin");
  if (!stdin?.renderCall || !stdin.renderResult)
    throw new Error("stdin renderers were not registered");
  const chars = `${"x".repeat(100)}\n`;
  const writeContext = renderContext({ session_id: 7, chars });
  const write = stdin.renderCall({ session_id: 7, chars }, plainTheme, writeContext);
  const writeText = write.render(200).join("\n");
  expect(writeText).toContain('Wrote to session 7 · "xxx');
  expect(writeText.trimEnd()).toEndWith('..."');
  expect(writeText).not.toContain("\n");

  const state: Record<string, unknown> = {};
  const pollContext = renderContext({ session_id: 7 }, state);
  const poll = stdin.renderCall({ session_id: 7 }, plainTheme, pollContext);
  expect(poll.render(80).join("\n")).toContain("Waiting for session 7");
  stdin.renderResult(
    {
      content: [{ type: "text", text: "ignored" }],
      details: { output: "", exit_code: 0, wall_time_seconds: 0.5 },
    },
    { expanded: false, isPartial: false },
    plainTheme,
    renderContext({ session_id: 7 }, state),
  );
  pollContext.lastComponent = poll;
  pollContext.isPartial = false;
  const waited = stdin.renderCall({ session_id: 7 }, plainTheme, pollContext);
  expect(waited.render(80).join("\n")).toContain("Waited for session 7");
});

test("renders failures and truncation metadata", () => {
  const exec = createHarness().tools.get("exec_command");
  if (!exec?.renderResult) throw new Error("exec renderer was not registered");
  const component = exec.renderResult(
    {
      content: [{ type: "text", text: "ignored" }],
      details: {
        output: "tail",
        exit_code: 2,
        wall_time_seconds: 0.25,
        original_token_count: 1234,
        truncated: true,
      },
    },
    { expanded: false, isPartial: false },
    plainTheme,
    renderContext({ cmd: "false" }),
  );
  const rendered = component.render(100).join("\n");
  expect(rendered.match(/Output truncated/g)).toHaveLength(1);
  expect(rendered).toContain("Exit 2 · 1 line · took 0.3s");
});

test(
  "removes bash and runs a persistent stdin session",
  async () => {
    const harness = createHarness();
    await harness.handlers.get("session_start")?.();

    expect(harness.activeTools()).toEqual(["read", "write", "exec_command", "write_stdin"]);
    expect(harness.handlers.has("tool_result")).toBe(false);

    const exec = harness.tools.get("exec_command");
    const stdin = harness.tools.get("write_stdin");
    if (!exec || !stdin) throw new Error("persistent tools were not registered");

    const first = await exec.execute(
      "call-1",
      {
        cmd: "node -e \"setTimeout(()=>{process.stdout.write('ready');process.stdin.once('data',d=>{process.stdout.write('received:'+d.toString().trim());process.stdin.destroy()})},300)\"",
        tty: true,
        yield_time_ms: 250,
      },
      undefined,
      undefined,
      { cwd: process.cwd() },
    );
    expect(first.details.output).toBe(process.platform === "win32" ? "ready" : "");
    expect(typeof first.details.session_id).toBe("number");

    const second = await stdin.execute(
      "call-2",
      {
        session_id: first.details.session_id,
        chars: "hello\n",
        yield_time_ms: 1_000,
      },
      undefined,
      undefined,
      { cwd: process.cwd() },
    );
    // The PTY also echoes the written line, so assert only the program's own output.
    const transcript = `${first.details.output}${second.details.output}`;
    expect(transcript.replace(/hello\r?\n/, "")).toBe("readyreceived:hello");
    expect(second.details.exit_code).toBe(0);

    await harness.handlers.get("session_shutdown")?.();
  },
  PERSISTENT_SESSION_TEST_TIMEOUT_MS,
);

test(
  "serializes concurrent interactions for one session",
  async () => {
    const harness = createHarness();
    await harness.handlers.get("session_start")?.();
    const exec = harness.tools.get("exec_command");
    const stdin = harness.tools.get("write_stdin");
    if (!exec || !stdin) throw new Error("persistent tools were not registered");

    const script =
      'let buffer="",firstAt=0;process.stdout.write("ready");process.stdin.on("data",data=>{buffer+=data;while(buffer.includes("\\n")){const newline=buffer.indexOf("\\n");buffer=buffer.slice(newline+1);if(firstAt===0){firstAt=Date.now();process.stdout.write("first\\n")}else{process.stdout.write("delay:"+(Date.now()-firstAt)+"\\n");process.exit(0)}}})';
    const encodedScript = Buffer.from(script).toString("base64");
    const command = `node -e "eval(Buffer.from('${encodedScript}','base64').toString())"`;
    const first = await exec.execute(
      "call-start",
      { cmd: command, tty: true, yield_time_ms: 250 },
      undefined,
      undefined,
      { cwd: process.cwd() },
    );
    const sessionId = Number(first.details.session_id);

    const [firstWrite, secondWrite] = await Promise.all([
      stdin.execute(
        "call-first-write",
        { session_id: sessionId, chars: "one\n", yield_time_ms: 500 },
        undefined,
        undefined,
        { cwd: process.cwd() },
      ),
      stdin.execute(
        "call-second-write",
        { session_id: sessionId, chars: "two\n", yield_time_ms: 1_000 },
        undefined,
        undefined,
        { cwd: process.cwd() },
      ),
    ]);

    expect(firstWrite.details.output).toContain("first");
    const delay = Number(String(secondWrite.details.output).match(/delay:(\d+)/)?.[1]);
    expect(delay).toBeGreaterThanOrEqual(350);
    expect(secondWrite.details.exit_code).toBe(0);
    await harness.handlers.get("session_shutdown")?.();
  },
  PERSISTENT_SESSION_TEST_TIMEOUT_MS,
);

test("bounds final and partial output while preserving original size", async () => {
  const harness = createHarness();
  await harness.handlers.get("session_start")?.();
  const exec = harness.tools.get("exec_command");
  if (!exec) throw new Error("exec_command was not registered");
  let maxUpdateBytes = 0;

  const result = await exec.execute(
    "call-large",
    {
      cmd: "node -e \"process.stdout.write('x'.repeat(2000000))\"",
      yield_time_ms: 5_000,
      max_output_tokens: 10,
    },
    undefined,
    (update) => {
      maxUpdateBytes = Math.max(
        maxUpdateBytes,
        Buffer.byteLength(update.content[0]?.text ?? "", "utf8"),
      );
    },
    { cwd: process.cwd() },
  );

  expect(maxUpdateBytes).toBeLessThan(200);
  expect(Buffer.byteLength(String(result.details.output), "utf8")).toBeLessThan(200);
  expect(Number(result.details.original_token_count)).toBeGreaterThan(400_000);
  await harness.handlers.get("session_shutdown")?.();
});

async function mockHarness(overrides: Partial<RuntimeApi> = {}) {
  const runtime: RuntimeApi = {
    spawn: () => 1,
    write() {},
    poll: () => ({ output: "", original_bytes: 0, omitted_bytes: 0, exit_code: null }),
    terminate() {},
    destroy() {},
    ...overrides,
  };
  const sdk = await loadSdk();
  const create = spyOn(sdk.PersistentExecRuntime, "create").mockReturnValue(runtime);
  const harness = createHarness();
  try {
    await harness.handlers.get("session_start")?.();
  } finally {
    create.mockRestore();
  }
  return harness;
}

test("cancelling a queued write preserves the predecessor's lock", async () => {
  const writes: string[] = [];
  const harness = await mockHarness({ write: (_id, chars = "") => writes.push(chars) });
  const stdin = harness.tools.get("write_stdin")!;
  const context = { cwd: process.cwd() };
  const a = new AbortController();
  const b = new AbortController();
  const c = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => (started = resolve));
  const first = stdin.execute("a", { session_id: 1 }, a.signal, started, context);
  await ready;
  const queued = stdin.execute("b", { session_id: 1, chars: "B" }, b.signal, undefined, context);
  b.abort();
  await expect(queued).rejects.toThrow();
  const last = stdin.execute(
    "c",
    { session_id: 1, chars: "C" },
    c.signal,
    () => c.abort(),
    context,
  );
  try {
    // Flush runnable callbacks; A cannot finish until explicitly cancelled below.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(writes).toEqual([]);
  } finally {
    a.abort();
    await first;
    await last;
    await harness.handlers.get("session_shutdown")?.();
  }
  expect(writes).toEqual(["C"]);
});

test("validates all parameters and cancellation before side effects", async () => {
  let spawns = 0;
  let writes = 0;
  const harness = await mockHarness({
    spawn: () => ++spawns,
    write: () => {
      writes++;
    },
  });
  const context = { cwd: process.cwd() };
  const stdin = harness.tools.get("write_stdin")!;
  for (const invalid of [{ yield_time_ms: -1 }, { max_output_tokens: 0.5 }]) {
    await expect(
      stdin.execute(
        "invalid",
        { session_id: 1, chars: "SIDE_EFFECT", ...invalid },
        undefined,
        undefined,
        context,
      ),
    ).rejects.toThrow();
  }
  const controller = new AbortController();
  controller.abort();
  await expect(
    stdin.execute(
      "aborted",
      { session_id: 1, chars: "SIDE_EFFECT" },
      controller.signal,
      undefined,
      context,
    ),
  ).rejects.toThrow();
  await expect(
    harness.tools
      .get("exec_command")!
      .execute("aborted", { cmd: "SIDE_EFFECT" }, controller.signal, undefined, context),
  ).rejects.toThrow();
  expect({ spawns, writes }).toEqual({ spawns: 0, writes: 0 });
  await harness.handlers.get("session_shutdown")?.();
});

test("cancelled exec preserves partial output and termination drain", async () => {
  let terminated = false;
  const harness = await mockHarness({
    terminate: () => {
      terminated = true;
    },
    poll: () => ({
      output: terminated ? "drained" : "diagnostic",
      original_bytes: terminated ? 7 : 10,
      omitted_bytes: 0,
      exit_code: terminated ? 137 : null,
    }),
  });
  const controller = new AbortController();
  const result = await harness.tools.get("exec_command")!.execute(
    "cancel",
    { cmd: "command" },
    controller.signal,
    (update) => {
      if (update.content.length) controller.abort();
    },
    { cwd: process.cwd() },
  );
  expect(terminated).toBe(true);
  expect(result.details).toMatchObject({
    output: "diagnosticdrained",
    exit_code: 137,
    cancelled: true,
  });
  expect(result.details.session_id).toBeUndefined();
  expect(result.structuredContent).toEqual(result.details);
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain("Cancelled");
  await harness.handlers.get("session_shutdown")?.();
});

test("cancelled poll preserves consumed output without terminating the session", async () => {
  let polls = 0;
  let terminated = false;
  const harness = await mockHarness({
    terminate: () => {
      terminated = true;
    },
    poll: () => ({
      output: ++polls === 1 ? "first" : "later",
      original_bytes: 5,
      omitted_bytes: 0,
      exit_code: polls === 1 ? null : 0,
    }),
  });
  const controller = new AbortController();
  const stdin = harness.tools.get("write_stdin")!;
  const context = { cwd: process.cwd() };
  const first = await stdin.execute(
    "cancel",
    { session_id: 1 },
    controller.signal,
    (update) => {
      if (update.content.length) controller.abort();
    },
    context,
  );
  expect(first.details).toMatchObject({ output: "first", session_id: 1, cancelled: true });
  expect(terminated).toBe(false);
  const later = await stdin.execute("later", { session_id: 1 }, undefined, undefined, context);
  expect(later.details).toMatchObject({ output: "later", exit_code: 0 });
  await harness.handlers.get("session_shutdown")?.();
});

test("pi final frame expands commands, completes poll titles and uses failure background", async () => {
  const { ToolExecutionComponent } = await import("@earendil-works/pi-coding-agent");
  const harness = createHarness();
  const command = "echo first\necho second\necho third\necho CRITICAL_LAST_COMMAND";
  const ui = { requestRender() {} };
  const tool = harness.tools.get("exec_command")!;
  const component = new ToolExecutionComponent(
    "exec_command",
    "call",
    { cmd: command },
    {},
    tool as never,
    ui as never,
    process.cwd(),
  );
  const result = {
    content: [{ type: "text" as const, text: "diagnostic" }],
    details: { output: "diagnostic", exit_code: 7, wall_time_seconds: 1 },
  };
  component.updateResult({ ...result, isError: true });
  expect(stripVTControlCharacters(component.render(48).join("\n"))).not.toContain(
    "CRITICAL_LAST_COMMAND",
  );
  component.setExpanded(true);
  const expanded = component.render(48).join("\n");
  expect(stripVTControlCharacters(expanded)).toContain("CRITICAL_LAST_COMMAND");
  expect(stripVTControlCharacters(expanded)).toContain("Exit 7");
  // The failure state must paint a different background than a successful result.
  const success = new ToolExecutionComponent(
    "exec_command",
    "ok",
    { cmd: command },
    {},
    tool as never,
    ui as never,
    process.cwd(),
  );
  success.updateResult({
    content: [{ type: "text" as const, text: "fine" }],
    details: { output: "fine", exit_code: 0, wall_time_seconds: 1 },
    isError: false,
  });
  success.setExpanded(true);
  const background = (frame: string) =>
    frame
      .split("\n")
      .at(-1)
      ?.match(/^(?:\x1b\[[0-9;]*m)+/)?.[0];
  expect(background(expanded)).toBeTruthy();
  expect(background(expanded)).not.toBe(background(success.render(48).join("\n")));

  const poll = new ToolExecutionComponent(
    "write_stdin",
    "poll",
    { session_id: 1 },
    {},
    harness.tools.get("write_stdin") as never,
    ui as never,
    process.cwd(),
  );
  poll.markExecutionStarted();
  poll.updateResult({ content: [], details: { session_id: 1, output: "" }, isError: false }, true);
  poll.updateResult({ content: [], details: { output: "", exit_code: 0 }, isError: false });
  expect(stripVTControlCharacters(poll.render(48).join("\n"))).toContain("Waited for session 1");
});

test("native exec cancellation returns captured output and a terminal result", async () => {
  const harness = createHarness();
  await harness.handlers.get("session_start")?.();
  const controller = new AbortController();
  try {
    const result = await harness.tools.get("exec_command")!.execute(
      "cancel-native",
      { cmd: "node -e \"process.stdout.write('cancel-ready');setInterval(()=>{},1000)\"" },
      controller.signal,
      (update) => {
        if (update.content[0]?.text.includes("cancel-ready")) controller.abort();
      },
      { cwd: process.cwd() },
    );
    expect(result.details.cancelled).toBe(true);
    expect(result.details.output).toContain("cancel-ready");
    expect(typeof result.details.exit_code).toBe("number");
    expect(result.details.exit_code).not.toBe(0);
    expect(result.details.session_id).toBeUndefined();
  } finally {
    await harness.handlers.get("session_shutdown")?.();
  }
});

function resultOf(output: string, extra: Record<string, unknown> = {}) {
  return {
    content: [{ type: "text", text: "ignored" }],
    details: { output, exit_code: 0, wall_time_seconds: 1, ...extra },
  };
}

function renderOutput(output: string, extra: Record<string, unknown> = {}, width = 80): string {
  const exec = createHarness().tools.get("exec_command")!;
  const component = exec.renderResult!(
    resultOf(output, extra),
    { expanded: true, isPartial: false },
    plainTheme,
    renderContext({ cmd: "x" }),
  );
  return component.render(width).join("\n");
}

test("renders carriage returns the way a terminal overwrites them", () => {
  const progress = renderOutput("10%\r20%\r30%\ndone\r\nnext");
  expect(progress).toContain("30%");
  expect(progress).not.toContain("10%");
  expect(progress).not.toContain("20%");
  // CRLF is a line break, not an overwrite.
  expect(progress).toMatch(/\ndone\s*\nnext/);
  // A shorter rewrite only replaces the prefix it covers.
  expect(renderOutput("abcdef\rXY")).toContain("XYcdef");
});

test("formats long durations like pi's shell tools", () => {
  // Without render timestamps the tool-reported wall time is used.
  expect(renderOutput("x", { wall_time_seconds: 125 })).toContain("took 2m 5s");
  const exec = createHarness().tools.get("exec_command")!;
  const text = (ms: number) =>
    exec.renderResult!(
      resultOf("x"),
      { expanded: false, isPartial: false },
      plainTheme,
      renderContext({ cmd: "x" }, { startedAt: 0, endedAt: ms }),
    )
      .render(120)
      .join("\n");
  expect(text(125_000)).toContain("took 2m 5s");
  expect(text(3_725_000)).toContain("took 1h 2m 5s");
  expect(text(59_900)).toContain("took 59.9s");
});

test("gives the model Codex's text result and structured content", async () => {
  const harness = createHarness();
  await harness.handlers.get("session_start")?.();
  const exec = harness.tools.get("exec_command")!;
  const context = { cwd: process.cwd() };
  try {
    const done = await exec.execute(
      "ok",
      { cmd: `node -e "process.stdout.write('hi')"` },
      undefined,
      undefined,
      context,
    );
    expect(done.content).toHaveLength(1);
    expect(done.content[0].text).toMatch(
      /^Wall time: \d+\.\d{4} seconds\nProcess exited with code 0\nOriginal token count: 1\nOutput:\nhi$/,
    );
    expect(done.structuredContent).toEqual(done.details);
    expect(done.details).toMatchObject({ output: "hi", exit_code: 0, original_token_count: 1 });
    expect(done.isError).toBeUndefined();

    const failed = await exec.execute(
      "bad",
      { cmd: `node -e "process.exit(3)"` },
      undefined,
      undefined,
      context,
    );
    // PowerShell reports any failing native command as exit code 1, so only assert non-zero.
    expect(failed.content[0].text).toMatch(/Process exited with code [1-9]\d*/);
    expect(failed.isError).toBe(true);

    const running = await exec.execute(
      "run",
      { cmd: `node -e "setTimeout(()=>{},30000)"`, yield_time_ms: 250 },
      undefined,
      undefined,
      context,
    );
    expect(running.content[0].text).toMatch(
      /^Wall time: \d+\.\d{4} seconds\nProcess running with session ID \d+\nOriginal token count: 0\nOutput:\n$/,
    );
    expect(running.isError).toBeUndefined();
    expect(exec.outputSchema).toMatchObject({
      type: "object",
      required: ["wall_time_seconds", "output"],
      additionalProperties: false,
    });
  } finally {
    await harness.handlers.get("session_shutdown")?.();
  }
});

test("marks truncation in the details instead of the output text", async () => {
  const harness = createHarness();
  await harness.handlers.get("session_start")?.();
  try {
    const result = await harness.tools.get("exec_command")!.execute(
      "large",
      {
        cmd: "node -e \"process.stdout.write('x'.repeat(100000))\"",
        yield_time_ms: 5_000,
        max_output_tokens: 10,
      },
      undefined,
      undefined,
      { cwd: process.cwd() },
    );
    expect(result.details.truncated).toBe(true);
    expect(String(result.details.output)).not.toContain("Output truncated");
    expect(result.content[0].text).toContain("Original token count: 25000");
  } finally {
    await harness.handlers.get("session_shutdown")?.();
  }
});

test("throttles streaming updates", async () => {
  let polls = 0;
  const harness = await mockHarness({
    poll: () => {
      polls++;
      return {
        output: `chunk${polls}\n`,
        original_bytes: 7,
        omitted_bytes: 0,
        exit_code: polls >= 40 ? 0 : null,
      };
    },
  });
  let updates = 0;
  const started = performance.now();
  await harness.tools
    .get("exec_command")!
    .execute("stream", { cmd: "x" }, undefined, () => updates++, { cwd: process.cwd() });
  const seconds = (performance.now() - started) / 1_000;
  // One initial empty update, then at most one per 100 ms plus the first output.
  expect(updates).toBeLessThanOrEqual(Math.ceil(seconds * 10) + 3);
  expect(updates).toBeGreaterThan(1);
  await harness.handlers.get("session_shutdown")?.();
});

test("replaces the previous runtime when a session starts twice", async () => {
  let destroyed = 0;
  const harness = await mockHarness({
    destroy: () => {
      destroyed++;
    },
  });
  const sdk = await loadSdk();
  const create = spyOn(sdk.PersistentExecRuntime, "create").mockReturnValue({
    spawn: () => 1,
    write() {},
    poll: () => ({ output: "", original_bytes: 0, omitted_bytes: 0, exit_code: null }),
    terminate() {},
    destroy() {},
  });
  try {
    await harness.handlers.get("session_start")?.();
  } finally {
    create.mockRestore();
  }
  expect(destroyed).toBe(1);
  await harness.handlers.get("session_shutdown")?.();
});

test("keeps pi's shell tools and notifies the user when the native runtime fails to load", async () => {
  const harness = createHarness();
  const notifications: Array<{ message: string; type?: string }> = [];
  const sdk = await loadSdk();
  const create = spyOn(sdk.PersistentExecRuntime, "create").mockImplementation(() => {
    throw new Error("native library missing");
  });
  try {
    await harness.handlers.get("session_start")?.(
      { type: "session_start", reason: "startup" },
      { ui: { notify: (message: string, type?: string) => notifications.push({ message, type }) } },
    );
  } finally {
    create.mockRestore();
  }

  expect(harness.activeTools()).toEqual(["read", "bash", "powershell", "write"]);
  expect(notifications).toHaveLength(1);
  expect(notifications[0].type).toBe("error");
  expect(notifications[0].message).toContain("native library missing");
  await expect(
    harness.tools
      .get("exec_command")!
      .execute("call", { cmd: "echo hi" }, undefined, undefined, { cwd: process.cwd() }),
  ).rejects.toThrow("persistent-exec runtime is not initialized");
});
