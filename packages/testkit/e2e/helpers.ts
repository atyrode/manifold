import type { SceneElement, ServerMessageBody, TerminalInfo } from "@manifold/protocol";
import { base64ToText, type SessionClient } from "@manifold/sdk";
import {
  connect,
  waitFor,
  type ProcessOutput,
  type TestAgent,
  type TestServer,
} from "../src/index.ts";

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
 * Waits for the next composition layout change, resolving with its provenance. Structural
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

/** Records exactly one terminal's terminal stream, preserving raw emission sequence numbers. */
export function captureTerminal(client: SessionClient, terminalId: string): TerminalCapture {
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
    if (message.terminalId !== terminalId) return;
    capture.snapshotSeq = message.seq;
    capture.snapshotText = base64ToText(message.data);
  });
  const offOutput = client.on("terminal_output", (message) => {
    if (message.terminalId !== terminalId) return;
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

/** Attaches one client to a terminal and returns its capture once the snapshot has landed. */
export async function attachedCapture(
  client: SessionClient,
  terminalId: string,
  timeoutMs = 10_000,
): Promise<TerminalCapture> {
  const capture = captureTerminal(client, terminalId);
  client.attachTerminal(terminalId);
  try {
    await waitFor(() => capture.snapshotSeq !== null, timeoutMs, 20);
  } catch (error) {
    capture.stop();
    throw error;
  }
  return capture;
}

type PortalElement = Extract<SceneElement, { type: "portal" }>;

/**
 * The one way a canvas references a container — including the composition a terminal lives
 * in, which is why no element carries a terminal id any more.
 */
export function portalElement(
  id: string,
  containerId: string,
  patch: Partial<Omit<PortalElement, "id" | "type" | "containerId">> = {},
): SceneElement {
  return {
    id,
    type: "portal",
    containerId,
    x: 0,
    y: 0,
    width: 720,
    height: 480,
    zIndex: 0,
    ...patch,
  };
}

/** What a canvas birth needs to say; every field but the element id and grant has a default. */
export interface OpenTerminalOptions {
  readonly elementId: string;
  /**
   * The grant the HOME client joins with. It has to be workspace-scoped: the composition a
   * terminal is born into is server-minted, so no container-scoped token could ever name it.
   */
  readonly token: string;
  readonly cols?: number;
  readonly rows?: number;
  readonly machineId?: string;
  /** Where to author the canvas's own portal onto the new home; omitted authors none. */
  readonly portalAt?: { readonly x: number; readonly y: number };
}

export interface OpenedTerminal {
  readonly terminal: TerminalInfo;
  /**
   * A client on the terminal's home composition. Every terminal message is gated on
   * `terminal.containerId === peer.containerId`, so the canvas that spawned the PTY cannot drive it — and
   * since `SessionClient` pools one socket per (url, token), this second room costs no
   * second connection, exactly as it costs none in the browser.
   */
  readonly homeClient: SessionClient;
}

/**
 * The whole canvas spawn gesture, once: open the PTY from the canvas, author the canvas's
 * portal onto the composition the server gave it, and join that composition so the terminal
 * can actually be driven.
 */
export async function openTerminalAt(
  canvas: SessionClient,
  server: TestServer,
  options: OpenTerminalOptions,
): Promise<OpenedTerminal> {
  const terminal = await canvas.openTerminal({
    elementId: options.elementId,
    cols: options.cols ?? 80,
    rows: options.rows ?? 24,
    ...(options.machineId === undefined ? {} : { machineId: options.machineId }),
  });
  if (terminal.status !== "running") {
    throw new Error(`terminal ${terminal.id} was born ${terminal.status}`);
  }
  const portalAt = options.portalAt;
  if (portalAt !== undefined) {
    canvas.transact((tx) => {
      tx.create(portalElement(options.elementId, terminal.containerId, portalAt));
    });
    await waitFor(() => canvas.elements.has(options.elementId), 10_000, 20);
  }
  const homeClient = await connect(server, {
    containerId: terminal.containerId,
    token: options.token,
    reconnect: false,
  });
  try {
    await waitFor(() => homeClient.terminals.get(terminal.id)?.status === "running", 10_000, 20);
  } catch (error) {
    homeClient.close();
    throw error;
  }
  return { terminal, homeClient };
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

/** Stops every child even when an earlier stop reports an error, then refs the first failure. */
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
