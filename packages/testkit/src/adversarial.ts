/**
 * ============================================================================
 * ADVERSARIAL TEST HARNESS — RAW WEBSOCKET ALLOWED HERE ONLY.
 *
 * This file is the sole AGENTS.md invariant 3 exemption. It deliberately bypasses the
 * SessionClient only to prove server rejection and forward-compatibility paths. It MUST
 * NOT be imported by production code or used as a second valid-protocol client.
 * ============================================================================
 */

import { SERVER_MESSAGE_TYPES, ServerMessageSchema, type ServerMessage } from "@manifold/protocol";
import type { TestServer } from "./spawn.ts";

const OPEN_TIMEOUT_MS = 5_000;

/** Close metadata is retained because authentication and policy codes are e2e contracts. */
export interface RawCloseInfo {
  readonly code: number;
  readonly reason: string;
  readonly wasClean: boolean;
}

/** The intentionally tiny raw surface makes invalid text possible without duplicating SDK state. */
export interface AdversarialSessionSocket {
  readonly frames: readonly ServerMessage[];
  readonly closeInfo: RawCloseInfo | null;
  readonly closed: Promise<RawCloseInfo>;
  readonly readyState: number;
  sendRaw(frame: string): void;
  close(): Promise<void>;
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

  socket.onopen = () => {
    didOpen = true;
    opened.resolve();
  };
  socket.onmessage = (event) => {
    try {
      const message = classifyIncoming(event.data);
      if (message !== null) frames.push(message);
    } catch (error) {
      socket.close(4002, "malformed server frame");
      if (!didOpen) opened.reject(error);
    }
  };
  socket.onerror = () => {
    if (!didOpen) opened.reject(new Error("raw session socket failed before opening"));
  };
  socket.onclose = (event) => {
    closeInfo = { code: event.code, reason: event.reason, wasClean: event.wasClean };
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
      socket.close(1000);
      await closed.promise;
    },
  };
}
