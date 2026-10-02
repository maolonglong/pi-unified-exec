import { OutputBuffer } from "./output";
import type { RuntimeApi } from "./sdk";

const POLL_INTERVAL_MS = 25;
/** Matches pi's bash tool: streaming UI updates are coalesced to one per interval. */
const UPDATE_THROTTLE_MS = 100;
const TERMINATE_DRAIN_MS = 1_000;

export interface WaitResult {
  output: string;
  exitCode: number | null;
  originalBytes: number;
  truncated: boolean;
  cancelled?: boolean;
}

export type OutputSnapshot = Pick<WaitResult, "output" | "originalBytes" | "truncated">;

/**
 * Serializes interactions with one session so concurrent writes and polls keep their order.
 * A waiter that is cancelled must not remove a still-active predecessor's lock.
 */
export async function withSessionLock<T>(
  locks: Map<number, Promise<void>>,
  sessionId: number,
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = locks.get(sessionId) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const current = previous.then(() => gate);
  locks.set(sessionId, current);

  try {
    await awaitWithAbort(previous, signal);
    return await operation();
  } finally {
    release?.();
    void current.then(() => {
      if (locks.get(sessionId) === current) locks.delete(sessionId);
    });
  }
}

function awaitWithAbort(promise: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolveWait, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new Error("command wait aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolveWait();
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Polls a session until it exits or `yieldMs` elapses, accumulating bounded output.
 * Streams throttled snapshots through `onOutput`; the final output is returned, not streamed.
 */
export async function waitForSession(
  runtime: RuntimeApi,
  sessionId: number,
  options: {
    yieldMs: number;
    maxBytes: number;
    signal: AbortSignal | undefined;
    onOutput: (snapshot: OutputSnapshot) => void;
    /** Terminate the session when cancelled; otherwise leave it running for later polls. */
    terminateOnAbort?: boolean;
  },
): Promise<WaitResult> {
  const { yieldMs, maxBytes, signal, onOutput, terminateOnAbort = false } = options;
  const deadline = performance.now() + yieldMs;
  const output = new OutputBuffer(maxBytes);
  const snapshot = (): OutputSnapshot => ({
    output: output.output,
    originalBytes: output.originalBytes,
    truncated: output.truncated,
  });
  let dirty = false;
  let lastUpdateAt = Number.NEGATIVE_INFINITY;
  try {
    while (true) {
      signal?.throwIfAborted();
      const poll = runtime.poll(sessionId);
      output.append(poll);
      if (poll.exit_code !== null) return { ...snapshot(), exitCode: poll.exit_code };
      if (poll.output || poll.omitted_bytes > 0) dirty = true;

      const now = performance.now();
      if (dirty && now - lastUpdateAt >= UPDATE_THROTTLE_MS) {
        dirty = false;
        lastUpdateAt = now;
        onOutput(snapshot());
      }
      const remaining = deadline - now;
      if (remaining <= 0) return { ...snapshot(), exitCode: null };
      await abortableDelay(Math.min(POLL_INTERVAL_MS, remaining), signal);
    }
  } catch (error) {
    if (!signal?.aborted) throw error;
    let exitCode: number | null = null;
    if (terminateOnAbort) {
      runtime.terminate(sessionId);
      exitCode = await drainTerminatedSession(runtime, sessionId, output);
    }
    return { ...snapshot(), exitCode, cancelled: true };
  }
}

function abortableDelay(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  signal?.throwIfAborted();
  if (!signal) return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
  return new Promise((resolveDelay, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolveDelay();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("command wait aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Collects what a terminated session still emits, returning its exit code if it appears. */
export async function drainTerminatedSession(
  runtime: RuntimeApi,
  sessionId: number,
  output?: OutputBuffer,
): Promise<number | null> {
  const deadline = performance.now() + TERMINATE_DRAIN_MS;
  while (performance.now() < deadline) {
    try {
      const poll = runtime.poll(sessionId);
      output?.append(poll);
      if (poll.exit_code !== null) return poll.exit_code;
    } catch {
      return null;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, POLL_INTERVAL_MS));
  }
  return null;
}
