/**
 * ============================================================================
 * ADVERSARIAL TEST HARNESS — RAW WEBSOCKET ALLOWED HERE ONLY.
 *
 * This file is the sole AGENTS.md invariant 3 exemption. It deliberately bypasses the
 * SessionClient only to prove server rejection and forward-compatibility paths. It MUST
 * NOT be imported by production code or used as a second valid-protocol client.
 * ============================================================================
 */

import {
  AgentMessageSchema,
  SERVER_MESSAGE_TYPES,
  SERVER_TO_AGENT_MESSAGE_TYPES,
  ServerMessageSchema,
  ServerToAgentMessageSchema,
  type AgentMessage,
  type ServerMessage,
  type ServerToAgentMessage,
} from "@manifold/protocol";
import type { TestServer } from "./spawn.ts";

const OPEN_TIMEOUT_MS = 5_000;

/**
 * The channel a raw session socket drives. Since v12 every channel-level frame carries a
 * routing id, and these tests exercise ONE room per socket, so they share one id.
 */
export const RAW_TERMINAL_CHANNEL = "c1";

/**
 * One channel-level frame as it appears on the wire. Connection-level frames (`ping`)
 * carry no channel and are still written with plain `JSON.stringify`, as is any
 * deliberately malformed text.
 */
export function sessionFrame(
  body: Record<string, unknown>,
  ch: string = RAW_TERMINAL_CHANNEL,
): string {
  return JSON.stringify({ ch, ...body });
}

/** Close metadata is retained because authentication and policy codes are e2e contracts. */
export interface RawCloseInfo {
  readonly code: number;
  readonly reason: string;
  readonly wasClean: boolean;
  readonly initiatedBy: "LOCAL" | "REMOTE";
}

interface AdversarialSocket {
  readonly closeInfo: RawCloseInfo | null;
  readonly closed: Promise<RawCloseInfo>;
  readonly readyState: number;
  sendRaw(frame: string): void;
  close(): Promise<void>;
}

/** The intentionally tiny raw ref makes invalid text possible without duplicating SDK state. */
export interface AdversarialSessionSocket extends AdversarialSocket {
  readonly frames: readonly ServerMessage[];
}

/** A raw machine peer exposes fencing and delayed-agent paths that a reconnecting daemon cannot. */
export interface AdversarialMachineSocket extends AdversarialSocket {
  readonly frames: readonly ServerToAgentMessage[];
  send(message: AgentMessage): void;
}

function classifyIncoming(data: unknown): ServerMessage | null {
  if (typeof data !== "string") throw new Error("server sent a non-text session frame");
  let decoded: unknown;
  try {
    decoded = JSON.parse(data);
  } catch (error) {
    throw new Error("server sent non-JSON text", { cause: error });
  }
  if (typeof decoded !== "object" || decoded === null || !("type" in decoded)) {
    throw new Error("server sent a frame without a type");
  }
  if (typeof decoded.type !== "string") throw new Error("server sent a non-string frame type");
  if (!SERVER_MESSAGE_TYPES.some((knownType) => knownType === decoded.type)) return null;
  return ServerMessageSchema.parse(decoded);
}

function classifyIncomingMachine(data: unknown): ServerToAgentMessage | null {
  if (typeof data !== "string") throw new Error("server sent a non-text machine frame");
  let decoded: unknown;
  try {
    decoded = JSON.parse(data);
  } catch (error) {
    throw new Error("server sent non-JSON machine text", { cause: error });
  }
  if (typeof decoded !== "object" || decoded === null || !("type" in decoded)) {
    throw new Error("server sent a machine frame without a type");
  }
  if (typeof decoded.type !== "string") {
    throw new Error("server sent a non-string machine frame type");
  }
  if (!SERVER_TO_AGENT_MESSAGE_TYPES.some((knownType) => knownType === decoded.type)) return null;
  return ServerToAgentMessageSchema.parse(decoded);
}

/** Opens an unjoined raw socket; callers then craft the exact invalid first or later frame. */
export async function rawSessionSocket(
  server: Pick<TestServer, "wsUrl">,
): Promise<AdversarialSessionSocket> {
  const socket = new WebSocket(server.wsUrl);
  const frames: ServerMessage[] = [];
  const opened = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<RawCloseInfo>();
  let didOpen = false;
  let closeInfo: RawCloseInfo | null = null;
  let locallyInitiated = false;

  socket.onopen = () => {
    didOpen = true;
    opened.resolve();
  };
  socket.onmessage = (event) => {
    try {
      const message = classifyIncoming(event.data);
      if (message !== null) frames.push(message);
    } catch (error) {
      locallyInitiated = true;
      socket.close(4002, "malformed server frame");
      if (!didOpen) opened.reject(error);
    }
  };
  socket.onerror = () => {
    if (!didOpen) opened.reject(new Error("raw session socket failed before opening"));
  };
  socket.onclose = (event) => {
    closeInfo = {
      code: event.code,
      reason: event.reason,
      wasClean: event.wasClean,
      initiatedBy: locallyInitiated ? "LOCAL" : "REMOTE",
    };
    if (!didOpen)
      opened.reject(new Error(`raw session socket closed before opening (${event.code})`));
    closed.resolve(closeInfo);
  };

  try {
    await Promise.race([
      opened.promise,
      Bun.sleep(OPEN_TIMEOUT_MS).then(() => {
        throw new Error(`raw session socket open timed out after ${OPEN_TIMEOUT_MS}ms`);
      }),
    ]);
  } catch (error) {
    locallyInitiated = true;
    socket.close();
    throw error;
  }

  return {
    frames,
    get closeInfo() {
      return closeInfo;
    },
    closed: closed.promise,
    get readyState() {
      return socket.readyState;
    },
    sendRaw(frame: string): void {
      if (socket.readyState !== WebSocket.OPEN) throw new Error("raw session socket is not open");
      socket.send(frame);
    },
    async close(): Promise<void> {
      if (socket.readyState === WebSocket.CLOSED) return;
      if (socket.readyState === WebSocket.OPEN) {
        locallyInitiated = true;
        socket.close(1000);
      }
      await closed.promise;
    },
  };
}

/** Opens an unjoined machine socket so tests can control hello, create, and snapshot timing. */
export async function rawMachineSocket(
  server: Pick<TestServer, "httpUrl">,
): Promise<AdversarialMachineSocket> {
  const url = new URL("/ws/machine", server.httpUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url);
  const frames: ServerToAgentMessage[] = [];
  const opened = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<RawCloseInfo>();
  let didOpen = false;
  let locallyInitiated = false;
  let closeInfo: RawCloseInfo | null = null;

  socket.onopen = () => {
    didOpen = true;
    opened.resolve();
  };
  socket.onmessage = (event) => {
    try {
      const message = classifyIncomingMachine(event.data);
      if (message !== null) frames.push(message);
    } catch (error) {
      locallyInitiated = true;
      socket.close(4002, "malformed server frame");
      if (!didOpen) opened.reject(error);
    }
  };
  socket.onerror = () => {
    if (!didOpen) opened.reject(new Error("raw machine socket failed before opening"));
  };
  socket.onclose = (event) => {
    closeInfo = {
      code: event.code,
      reason: event.reason,
      wasClean: event.wasClean,
      initiatedBy: locallyInitiated ? "LOCAL" : "REMOTE",
    };
    if (!didOpen) {
      opened.reject(new Error(`raw machine socket closed before opening (${event.code})`));
    }
    closed.resolve(closeInfo);
  };

  try {
    await Promise.race([
      opened.promise,
      Bun.sleep(OPEN_TIMEOUT_MS).then(() => {
        throw new Error(`raw machine socket open timed out after ${OPEN_TIMEOUT_MS}ms`);
      }),
    ]);
  } catch (error) {
    locallyInitiated = true;
    socket.close();
    throw error;
  }

  return {
    frames,
    get closeInfo() {
      return closeInfo;
    },
    closed: closed.promise,
    get readyState() {
      return socket.readyState;
    },
    send(message: AgentMessage): void {
      if (socket.readyState !== WebSocket.OPEN) throw new Error("raw machine socket is not open");
      socket.send(JSON.stringify(AgentMessageSchema.parse(message)));
    },
    sendRaw(frame: string): void {
      if (socket.readyState !== WebSocket.OPEN) throw new Error("raw machine socket is not open");
      socket.send(frame);
    },
    async close(): Promise<void> {
      if (socket.readyState === WebSocket.CLOSED) return;
      if (socket.readyState === WebSocket.OPEN) {
        locallyInitiated = true;
        socket.close(1000);
      }
      await closed.promise;
    },
  };
}
