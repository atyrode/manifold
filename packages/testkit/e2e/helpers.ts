import type { SceneElement, ServerMessage } from "@manifold/protocol";
import { base64ToText, type SessionClient } from "@manifold/sdk";
import { waitFor, type ProcessOutput, type TestAgent, type TestServer } from "../src/index.ts";

type ServerMessageOf<T extends ServerMessage["type"]> = Extract<ServerMessage, { type: T }>;

/** A terminal capture keeps snapshot and post-snapshot output separate for seq-exact checks. */
export interface TerminalCapture {
  snapshotSeq: number | null;
  snapshotText: string;
  outputText: string;
  readonly outputSeqs: number[];
  stop(): void;
}

/** Waits for one typed SDK message without leaving an event listener behind on timeout. */
export function nextMessage<T extends ServerMessage["type"]>(
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

/** Records exactly one session's terminal stream, preserving raw emission sequence numbers. */
export function captureTerminal(client: SessionClient, sessionId: string): TerminalCapture {
  const capture: TerminalCapture = {
    snapshotSeq: null,
    snapshotText: "",
    outputText: "",
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
    if (message.sessionId !== sessionId || capture.snapshotSeq === null) return;
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

/** Produces the smallest protocol-valid scene record so tests vary only relevant LWW fields. */
export function sceneElement(
  id: string,
  version = 1,
  versionNonce = 100,
  isDeleted = false,
): SceneElement {
  return { id, version, versionNonce, isDeleted };
}

/** Canonicalizes scene values by id for convergence comparisons independent of Map insertion order. */
export function sortedScene(client: SessionClient): SceneElement[] {
  return [...client.scene.values()].sort((left, right) => left.id.localeCompare(right.id));
}

/** Hashes only the required durability witness: sorted `(id, version)` pairs. */
export async function sceneVersionHash(elements: Iterable<SceneElement>): Promise<string> {
  const pairs = [...elements]
    .map((element) => [element.id, element.version] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(pairs)),
  );
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
