import type { SceneElement, ServerMessageBody } from "@manifold/protocol";
import { base64ToText, type SessionClient } from "@manifold/sdk";
import { waitFor, type ProcessOutput, type TestAgent, type TestServer } from "../src/index.ts";

// The SDK hands subscribers channel-agnostic bodies: a room handle already knows its room.
type ServerMessageOf<T extends ServerMessageBody["type"]> = Extract<ServerMessageBody, { type: T }>;

/** A terminal capture keeps snapshot and post-snapshot output separate for seq-exact checks. */
export interface TerminalCapture {
  snapshotSeq: number | null;
  snapshotText: string;
  outputText: string;
  pendingOutputCount: number;
  readonly outputSeqs: number[];
  stop(): void;
}

/** Waits for one typed SDK message without leaving an event listener behind on timeout. */
export function nextMessage<T extends ServerMessageBody["type"]>(
  client: SessionClient,
  type: T,
  timeoutMs = 10_000,
  predicate?: (message: ServerMessageOf<T>) => boolean,
): Promise<ServerMessageOf<T>> {
  const { promise, resolve, reject } = Promise.withResolvers<ServerMessageOf<T>>();
  // Registration precedes the timer so both closures can capture `const` bindings; messages
  // only ever arrive asynchronously, so the handler cannot observe `timer` before it exists.
  const off = client.on(type, (message) => {
    if (predicate !== undefined && !predicate(message)) return;
    clearTimeout(timer);
    off();
    resolve(message);
  });
  const timer = setTimeout(() => {
    off();
    reject(new Error(`timed out waiting for ${type} after ${timeoutMs}ms`));
  }, timeoutMs);
  return promise;
}

/**
 * Waits for the next tiled-container layout change, resolving with its provenance. Structural
 * tile writes are server-authored, so a joined renderer must observe them as remote updates.
 */
export function nextLayoutChange(
  client: SessionClient,
  timeoutMs = 10_000,
): Promise<"local" | "remote" | "undo"> {
  const { promise, resolve, reject } = Promise.withResolvers<"local" | "remote" | "undo">();
  const off = client.on("layout_changed", (origin) => {
    clearTimeout(timer);
    off();
    resolve(origin);
  });
  const timer = setTimeout(() => {
    off();
    reject(new Error(`timed out waiting for layout_changed after ${timeoutMs}ms`));
  }, timeoutMs);
  return promise;
}

/** Records exactly one session's terminal stream, preserving raw emission sequence numbers. */
export function captureTerminal(client: SessionClient, sessionId: string): TerminalCapture {
  const capture: TerminalCapture = {
    snapshotSeq: null,
    snapshotText: "",
    outputText: "",
    pendingOutputCount: 0,
    outputSeqs: [],
    stop(): void {
      offSnapshot();
      offOutput();
    },
  };
  const offSnapshot = client.on("terminal_snapshot", (message) => {
    if (message.sessionId !== sessionId) return;
    capture.snapshotSeq = message.seq;
    capture.snapshotText = base64ToText(message.data);
  });
  const offOutput = client.on("terminal_output", (message) => {
    if (message.sessionId !== sessionId) return;
    if (capture.snapshotSeq === null) {
      capture.pendingOutputCount += 1;
      return;
    }
    capture.outputSeqs.push(message.seq);
    capture.outputText += base64ToText(message.data);
  });
  return capture;
}

/** Waits for decoded terminal snapshot+output text while retaining the capture for seq checks. */
export async function waitForTerminalText(
  capture: TerminalCapture,
  text: string,
  timeoutMs = 10_000,
): Promise<void> {
  await waitFor(() => (capture.snapshotText + capture.outputText).includes(text), timeoutMs, 20);
}

type TerminalElement = Extract<SceneElement, { type: "terminal" }>;

/** Produces a protocol-valid native terminal element with optional test-specific fields. */
export function terminalElement(
  id: string,
  patch: Partial<Omit<TerminalElement, "id" | "type">> = {},
): SceneElement {
  return {
    id,
    type: "terminal",
    sessionId: `session-${id}`,
    x: 0,
    y: 0,
    width: 720,
    height: 480,
    zIndex: 0,
    ...patch,
  };
}

export function textElement(id: string, text: string): SceneElement {
  return {
    id,
    type: "text",
    text,
    x: 0,
    y: 0,
    width: 240,
    height: 48,
    zIndex: 0,
    fontSize: 20,
    color: "#f8f9fa",
  };
}

export function drawElement(id: string, points: number[]): SceneElement {
  return {
    id,
    type: "draw",
    points,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    zIndex: 0,
    strokeWidth: 3,
    color: "#2563eb",
  };
}

/** Canonicalizes scene values by id for convergence comparisons independent of Map insertion order. */
export function sortedScene(client: SessionClient): SceneElement[] {
  return [...client.elements.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function canonicalJson(value: unknown): string | undefined {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalJson(item) ?? "null");
    return `[${items.join(",")}]`;
  }
  if (typeof value === "object") {
    const fields: string[] = [];
    for (const key of Object.keys(value).sort()) {
      const encoded = canonicalJson(Reflect.get(value, key));
      if (encoded !== undefined) fields.push(`${JSON.stringify(key)}:${encoded}`);
    }
    return `{${fields.join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Hashes canonical full element content, independent of element or object-key insertion order. */
export async function sceneContentHash(elements: Iterable<SceneElement>): Promise<string> {
  const sorted = [...elements].sort((left, right) => left.id.localeCompare(right.id));
  const canonical = canonicalJson(sorted);
  if (canonical === undefined) throw new Error("scene content is not JSON-serializable");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  let hex = "";
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/** Closes SDK clients intentionally so their reconnect timers cannot outlive a test. */
export function closeClients(clients: readonly (SessionClient | null | undefined)[]): void {
  for (const client of clients) client?.close();
}

/** Stops every child even when an earlier stop reports an error, then surfaces the first failure. */
export async function stopProcesses(
  processes: readonly (TestServer | TestAgent | null | undefined)[],
): Promise<void> {
  let firstError: unknown;
  for (const process of [...processes].reverse()) {
    if (process === null || process === undefined) continue;
    try {
      await process.stop();
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError !== undefined) throw firstError;
}

function formatProcessOutput(output: ProcessOutput, index: number): string {
  const stdout = output.stdout.length === 0 ? "<empty>" : output.stdout.join("\n");
  const stderr = output.stderr.length === 0 ? "<empty>" : output.stderr.join("\n");
  return `process ${index} stdout tail:\n${stdout}\nprocess ${index} stderr tail:\n${stderr}`;
}

/** Wraps every assertion failure with bounded child logs without exposing tokens beyond ready URLs. */
export function e2eFailure(
  error: unknown,
  processes: readonly (TestServer | TestAgent | null | undefined)[],
): Error {
  const message = error instanceof Error ? error.message : String(error);
  const dumps: string[] = [];
  processes.forEach((process, index) => {
    if (process !== null && process !== undefined) {
      dumps.push(formatProcessOutput(process.output, index + 1));
    }
  });
  return new Error(`${message}\n\n${dumps.join("\n\n")}`, { cause: error });
}
