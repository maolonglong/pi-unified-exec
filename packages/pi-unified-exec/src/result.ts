import { type Static, Type } from "typebox";
import type { WaitResult } from "./session";

/** Declared so codemode scripts receive `structuredContent` instead of the model-facing text. */
export const outputSchema = Type.Object(
  {
    wall_time_seconds: Type.Number({
      description: "Elapsed wall time spent waiting for output in seconds.",
    }),
    output: Type.String({ description: "Command output text, possibly truncated." }),
    exit_code: Type.Optional(
      Type.Number({ description: "Process exit code when the command finished during this call." }),
    ),
    session_id: Type.Optional(
      Type.Number({
        description: "Session identifier to pass to write_stdin when the process is still running.",
      }),
    ),
    original_token_count: Type.Optional(
      Type.Number({ description: "Approximate token count before output truncation." }),
    ),
    truncated: Type.Optional(
      Type.Boolean({ description: "True when output was omitted from the middle." }),
    ),
    cancelled: Type.Optional(
      Type.Boolean({ description: "True when the call was cancelled before it finished." }),
    ),
  },
  { additionalProperties: false },
);

/** Structured result, shaped like Codex's `unified_exec_output_schema` plus extension fields. */
export type ToolOutput = Static<typeof outputSchema>;

const BYTES_PER_TOKEN = 4;

export function approxTokens(bytes: number): number {
  return Math.ceil(bytes / BYTES_PER_TOKEN);
}

export function buildOutput(waited: WaitResult, sessionId: number, startedAt: number): ToolOutput {
  return {
    wall_time_seconds: Math.round(((performance.now() - startedAt) / 1_000) * 1e4) / 1e4,
    output: waited.output,
    ...(waited.exitCode === null ? { session_id: sessionId } : { exit_code: waited.exitCode }),
    original_token_count: approxTokens(waited.originalBytes),
    ...(waited.truncated ? { truncated: true } : {}),
    ...(waited.cancelled ? { cancelled: true } : {}),
  };
}

export function isFailure(output: ToolOutput): boolean {
  return output.cancelled === true || (output.exit_code !== undefined && output.exit_code !== 0);
}

/** Model-facing text in the layout Codex's unified exec returns. */
export function formatModelText(output: ToolOutput): string {
  const header = [`Wall time: ${output.wall_time_seconds.toFixed(4)} seconds`];
  if (output.cancelled) header.push("Cancelled before the command finished");
  if (output.exit_code !== undefined) header.push(`Process exited with code ${output.exit_code}`);
  if (output.session_id !== undefined) {
    header.push(`Process running with session ID ${output.session_id}`);
  }
  if (output.original_token_count !== undefined) {
    header.push(`Original token count: ${output.original_token_count}`);
  }
  header.push("Output:");
  return `${header.join("\n")}\n${output.output}`;
}

export function toolResult(output: ToolOutput) {
  return {
    content: [{ type: "text" as const, text: formatModelText(output) }],
    details: output,
    structuredContent: output,
    ...(isFailure(output) ? { isError: true } : {}),
  };
}
