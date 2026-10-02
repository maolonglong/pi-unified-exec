import { stripVTControlCharacters } from "node:util";
import { keyHint, truncateToVisualLines } from "@earendil-works/pi-coding-agent";
import { type Component, Container, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { ToolOutput } from "./result";

const CALL_PREVIEW_LINES = 3;
const OUTPUT_PREVIEW_LINES = 5;
const INPUT_PREVIEW_CHARS = 80;

export interface RenderState {
  startedAt?: number;
  endedAt?: number;
  interval?: NodeJS.Timeout;
}

export type ToolTheme = {
  bold(text: string): string;
  fg(
    color:
      | "toolTitle"
      | "accent"
      | "toolOutput"
      | "warning"
      | "success"
      | "error"
      | "muted"
      | "dim",
    text: string,
  ): string;
};

interface RenderableResult {
  content: Array<{ type: string; text?: string }>;
  details?: unknown;
}

/** Elapsed time in the form pi's shell tools use: `1.2s`, `2m 5s`, `1h 2m 5s`. */
export function formatDuration(milliseconds: number): string {
  const seconds = milliseconds / 1_000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remainder = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${remainder}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${remainder}s`;
}

/** A carriage return moves the cursor to column 0 and later text overwrites what was there. */
function overwriteCarriageReturns(text: string): string {
  if (!text.includes("\r")) return text;
  return text
    .split("\n")
    .map((line) => {
      if (!line.includes("\r")) return line;
      const cells: string[] = [];
      let column = 0;
      for (const character of line) {
        if (character === "\r") column = 0;
        else cells[column++] = character;
      }
      return cells.join("");
    })
    .join("\n");
}

/**
 * Makes untrusted process output safe and readable in the TUI. Sequences are stripped before
 * controls so escape payloads never become visible text; leftover introducers are removed too,
 * because partial output can end inside a sequence.
 */
export function sanitizeDisplayText(text: string): string {
  return overwriteCarriageReturns(stripVTControlCharacters(text).replace(/\r\n/g, "\n")).replace(
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f￹-￻]/g,
    "",
  );
}

export function startRenderTimer(state: RenderState, executionStarted: boolean): void {
  if (executionStarted && state.startedAt === undefined) {
    state.startedAt = Date.now();
    state.endedAt = undefined;
  }
}

export function updateRenderTimer(
  state: RenderState,
  isPartial: boolean,
  isError: boolean,
  context: { invalidate(): void },
): void {
  if (state.startedAt !== undefined && isPartial && !state.interval) {
    state.interval = setInterval(() => context.invalidate(), 1_000);
  }
  if (!isPartial || isError) {
    state.endedAt ??= Date.now();
    if (state.interval) {
      clearInterval(state.interval);
      state.interval = undefined;
    }
  }
}

export function previewInput(input: string): string {
  const escaped = JSON.stringify(input);
  if ([...escaped].length <= INPUT_PREVIEW_CHARS) return escaped;
  return `${[...escaped].slice(0, INPUT_PREVIEW_CHARS - 4).join("")}..."`;
}

function textContent(result: RenderableResult): string {
  return result.content
    .filter((item): item is { type: string; text: string } => typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

/** `$ command`, with long commands folded to a few visual lines until expanded. */
export class ToolCallRenderComponent implements Component {
  private readonly text = new Text("", 0, 0);
  private theme: ToolTheme;
  private expanded = false;

  constructor(theme: ToolTheme) {
    this.theme = theme;
  }

  update(command: string, theme: ToolTheme, expanded: boolean): void {
    this.theme = theme;
    this.expanded = expanded;
    this.text.setText(theme.fg("toolTitle", theme.bold(`$ ${sanitizeDisplayText(command)}`)));
  }

  render(width: number): string[] {
    const lines = this.text.render(width);
    if (this.expanded || lines.length <= CALL_PREVIEW_LINES) return lines;
    const skipped = lines.length - CALL_PREVIEW_LINES;
    const notice = this.theme.fg("muted", `… +${skipped} ${skipped === 1 ? "line" : "lines"}`);
    return [...lines.slice(0, CALL_PREVIEW_LINES), truncateToWidth(notice, width, "...")];
  }

  invalidate(): void {
    this.text.invalidate();
  }
}

/** Collapsed output: the last visual lines, wrapped like bash output, cached per width. */
class CollapsedOutput implements Component {
  private cachedWidth: number | undefined;
  private lines: string[] = [];

  constructor(
    private readonly styled: string,
    private readonly theme: ToolTheme,
  ) {}

  render(width: number): string[] {
    if (this.cachedWidth !== width) {
      const preview = truncateToVisualLines(this.styled, OUTPUT_PREVIEW_LINES, width);
      this.cachedWidth = width;
      this.lines = preview.visualLines;
      if (preview.skippedCount > 0) {
        const hint =
          this.theme.fg("muted", `... (${preview.skippedCount} earlier lines,`) +
          ` ${keyHint("app.tools.expand", "to expand")}${this.theme.fg("muted", ")")}`;
        this.lines = [truncateToWidth(hint, width, "..."), ...this.lines];
      }
    }
    return ["", ...this.lines];
  }

  invalidate(): void {
    this.cachedWidth = undefined;
  }
}

export class ToolResultRenderComponent extends Container {
  update(
    result: RenderableResult,
    options: { expanded: boolean; isPartial: boolean },
    state: RenderState,
    theme: ToolTheme,
    isError: boolean,
  ): void {
    this.clear();
    const details = result.details as Partial<ToolOutput> | undefined;
    const rawOutput = details?.output ?? (isError ? textContent(result) : "");
    const output = sanitizeDisplayText(rawOutput).trimEnd();

    if (output) {
      const styled = output
        .split("\n")
        .map((line) => theme.fg("toolOutput", line))
        .join("\n");
      this.addChild(
        options.expanded ? new Text(`\n${styled}`, 0, 0) : new CollapsedOutput(styled, theme),
      );
    } else if (!options.isPartial && !isError) {
      this.addChild(new Text(`\n${theme.fg("muted", "(no output)")}`, 0, 0));
    }

    if (details?.truncated) {
      const notice = `Output truncated from approximately ${details.original_token_count} tokens. Omitted output is not retained.`;
      this.addChild(new Text(`\n${theme.fg("warning", `[${notice}]`)}`, 0, 0));
    }

    this.addChild(
      new Text(`\n${formatRenderStatus(details, options.isPartial, state, theme, isError)}`, 0, 0),
    );
  }
}

function formatRenderStatus(
  details: Partial<ToolOutput> | undefined,
  isPartial: boolean,
  state: RenderState,
  theme: ToolTheme,
  isError: boolean,
): string {
  const elapsedMilliseconds =
    state.startedAt === undefined
      ? (details?.wall_time_seconds ?? 0) * 1_000
      : (state.endedAt ?? Date.now()) - state.startedAt;
  const duration = formatDuration(elapsedMilliseconds);
  const output = details?.output ? sanitizeDisplayText(details.output).trimEnd() : "";
  const lines = output ? output.split("\n").length : 0;
  const lineCount = `${lines} ${lines === 1 ? "line" : "lines"}`;
  const session = details?.session_id === undefined ? "" : ` · session ${details.session_id}`;

  if (isPartial) {
    return `${theme.fg("warning", "Running")}${theme.fg("dim", `${session} · elapsed ${duration}`)}`;
  }
  if (details?.cancelled) {
    return `${theme.fg("warning", "Cancelled")}${theme.fg("dim", `${session} · waited ${duration}`)}`;
  }
  if (!details || (isError && details.exit_code === undefined)) {
    return `${theme.fg("error", "Failed")}${theme.fg("dim", ` · took ${duration}`)}`;
  }
  if (details.exit_code === undefined) {
    return `${theme.fg("success", `Session ${details.session_id} running`)}${theme.fg("dim", ` · ${lineCount} · waited ${duration}`)}`;
  }
  const color = details.exit_code === 0 ? "success" : "error";
  return `${theme.fg(color, `Exit ${details.exit_code}`)}${theme.fg("dim", ` · ${lineCount} · took ${duration}`)}`;
}
