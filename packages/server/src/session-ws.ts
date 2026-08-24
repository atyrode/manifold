import {
  CLIENT_MESSAGE_TYPES,
  ClientMessageSchema,
  MAX_SESSION_FRAME_BYTES,
  PROTOCOL_VERSION,
  type ClientMessage,
  type RuntimeDeps,
} from "@manifold/protocol";
import { ServiceError, type AuthService } from "./auth.ts";
import type { Logger } from "./log.ts";
import type { Room, RoomManager, RoomTimers } from "./room.ts";
import { SessionPeer, type RawSocket } from "./session-peer.ts";
import type { TerminalBroker } from "./terminal-broker.ts";

type ClassifiedFrame =
  | { kind: "message"; message: ClientMessage }
  | { kind: "unknown_type"; frameType: string }
  | { kind: "malformed"; detail: string };

type CursorUpdate = Extract<ClientMessage, { type: "cursor" }>;

const KNOWN_CLIENT_TYPES: Readonly<Record<string, true>> = Object.fromEntries(
  CLIENT_MESSAGE_TYPES.map((type): [string, true] => [type, true]),
);

const RESYNC_MIN_INTERVAL_MS = 1_000;
const CURSOR_MIN_INTERVAL_MS = 30;

interface SessionConnection {
  socket: RawSocket;
  peer: SessionPeer | null;
  room: Room | null;
  cancelJoinTimeout: (() => void) | null;
  lastResyncAt: number | null;
  cancelResyncFlush: (() => void) | null;
  lastCursorAt: number | null;
  pendingCursor: CursorUpdate | null;
  cancelCursorFlush: (() => void) | null;
  closed: boolean;
}

function classifyClientFrame(data: unknown): ClassifiedFrame {
  if (typeof data !== "string") return { kind: "malformed", detail: "non-text frame" };
  if (Buffer.byteLength(data) > MAX_SESSION_FRAME_BYTES) {
    return { kind: "malformed", detail: "frame exceeds 1 MiB" };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return { kind: "malformed", detail: "invalid JSON" };
  }
  if (raw === null || typeof raw !== "object") {
    return { kind: "malformed", detail: "missing type discriminator" };
  }
  const frameType = Reflect.get(raw, "type");
  if (typeof frameType !== "string") {
    return { kind: "malformed", detail: "missing type discriminator" };
  }
  if (KNOWN_CLIENT_TYPES[frameType] !== true) {
    return { kind: "unknown_type", frameType };
  }
  const parsed = ClientMessageSchema.safeParse(raw);
  if (!parsed.success) return { kind: "malformed", detail: `invalid ${frameType} frame` };
  return { kind: "message", message: parsed.data };
}

/** Owns join policy and dispatch for every `/ws/session` connection. */
export class SessionGateway {
  private readonly connections = new Map<string, SessionConnection>();
  private readonly removeRevocationListener: () => void;

  constructor(
    private readonly auth: AuthService,
    private readonly rooms: RoomManager,
    private readonly broker: TerminalBroker,
    private readonly timers: RoomTimers,
    private readonly logger: Logger,
    private readonly runtime: RuntimeDeps,
  ) {
    this.removeRevocationListener = auth.onRevoked((principalId, padId) => {
      this.revokePrincipal(principalId, padId);
    });
  }

  /** Starts the mandatory ten-second first-frame join deadline. */
  open(id: string, socket: RawSocket): void {
    const connection: SessionConnection = {
      socket,
      peer: null,
      room: null,
      cancelJoinTimeout: null,
      lastResyncAt: null,
      cancelResyncFlush: null,
      lastCursorAt: null,
      pendingCursor: null,
      cancelCursorFlush: null,
      closed: false,
    };
    connection.cancelJoinTimeout = this.timers.schedule(() => {
      connection.cancelJoinTimeout = null;
      if (connection.peer === null) socket.close(4002, "join timeout");
    }, 10_000);
    this.connections.set(id, connection);
  }

  /** Classifies, validates, and dispatches one inbound text frame. */
  message(id: string, data: unknown): void {
    const connection = this.connections.get(id);
    if (connection === undefined) return;
    const classified = classifyClientFrame(data);
    switch (classified.kind) {
      case "unknown_type":
        this.logger.warn("session_unknown_frame");
        return;
      case "malformed":
        this.logger.warn("session_malformed_frame", { detail: classified.detail });
        connection.socket.close(4002, "malformed client frame");
        return;
      case "message":
        if (connection.peer === null) {
          this.join(id, connection, classified.message);
          return;
        }
        this.dispatch(connection, classified.message);
        return;
      default: {
        const exhaustive: never = classified;
        void exhaustive;
      }
    }
  }

  private join(id: string, connection: SessionConnection, message: ClientMessage): void {
    if (message.type !== "join") {
      connection.socket.close(4002, "first frame must be join");
      return;
    }
    if (message.protocolVersion !== PROTOCOL_VERSION) {
      connection.socket.close(4409, "protocol version mismatch");
      return;
    }

    let context;
    try {
      context = this.auth.authenticate(message.token);
    } catch (error) {
      if (error instanceof ServiceError && error.code === "forbidden") {
        connection.socket.close(4403, error.message === "revoked" ? "revoked" : "forbidden");
      } else {
        connection.socket.close(4401, "unauthorized");
      }
      return;
    }
    if (!this.auth.allows(context, "pads:read", message.padId)) {
      connection.socket.close(4403, "forbidden");
      return;
    }
    const room = this.rooms.get(message.padId);
    if (room === null) {
      connection.socket.close(4404, "pad not found");
      return;
    }

    connection.cancelJoinTimeout?.();
    connection.cancelJoinTimeout = null;
    const peer = new SessionPeer(id, connection.socket, context, message.padId);
    connection.peer = peer;
    connection.room = room;
    room.join(peer);
  }

  /**
   * Relays immediately when the cadence is open, otherwise retains exactly the newest
   * cursor and flushes it at the boundary. This preserves latest-wins without flooding.
   */
  private relayCursor(
    connection: SessionConnection,
    peer: SessionPeer,
    room: Room,
    cursor: CursorUpdate,
  ): void {
    const now = this.runtime.now();
    const elapsed =
      connection.lastCursorAt === null ? CURSOR_MIN_INTERVAL_MS : now - connection.lastCursorAt;
    if (elapsed >= CURSOR_MIN_INTERVAL_MS) {
      connection.cancelCursorFlush?.();
      connection.cancelCursorFlush = null;
      connection.pendingCursor = null;
      connection.lastCursorAt = now;
      room.relayCursor(peer, cursor);
      return;
    }

    connection.pendingCursor = cursor;
    if (connection.cancelCursorFlush !== null) return;
    connection.cancelCursorFlush = this.timers.schedule(() => {
      connection.cancelCursorFlush = null;
      const pending = connection.pendingCursor;
      connection.pendingCursor = null;
      if (connection.closed || pending === null) return;
      const livePeer = connection.peer;
      const liveRoom = connection.room;
      if (livePeer === null || liveRoom === null) return;
      connection.lastCursorAt = this.runtime.now();
      liveRoom.relayCursor(livePeer, pending);
    }, CURSOR_MIN_INTERVAL_MS - elapsed);
  }

  /** Applies one cadence gate to explicit requests and automatic epoch-mismatch recovery. */
  private sendResyncIfDue(connection: SessionConnection, peer: SessionPeer, room: Room): void {
    const now = this.runtime.now();
    const elapsed =
      connection.lastResyncAt === null ? RESYNC_MIN_INTERVAL_MS : now - connection.lastResyncAt;
    if (elapsed >= RESYNC_MIN_INTERVAL_MS) {
      connection.cancelResyncFlush?.();
      connection.cancelResyncFlush = null;
      connection.lastResyncAt = now;
      room.sendResync(peer);
      return;
    }

    if (connection.cancelResyncFlush !== null) return;
    connection.cancelResyncFlush = this.timers.schedule(() => {
      connection.cancelResyncFlush = null;
      if (connection.closed) return;
      const livePeer = connection.peer;
      const liveRoom = connection.room;
      if (livePeer === null || liveRoom === null) return;
      connection.lastResyncAt = this.runtime.now();
      liveRoom.sendResync(livePeer);
    }, RESYNC_MIN_INTERVAL_MS - elapsed);
  }

  private dispatch(connection: SessionConnection, message: ClientMessage): void {
    const peer = connection.peer;
    const room = connection.room;
    if (peer === null || room === null) return;
    switch (message.type) {
      case "join":
        peer.close(4002, "duplicate join");
        return;
      case "scene_update":
        if (!this.auth.allows(peer.auth, "scene:write", peer.padId)) {
          peer.send({
            type: "error",
            code: "forbidden",
            message: "scene:write capability required",
            ref: message.updateId,
          });
          return;
        }
        if (!room.applyUpdate(peer, message)) this.sendResyncIfDue(connection, peer, room);
        return;
      case "presence":
        room.updatePresence(peer, message.payload);
        return;
      case "cursor":
        this.relayCursor(connection, peer, room, message);
        return;
      case "resync_request":
        this.sendResyncIfDue(connection, peer, room);
        return;
      case "terminal_open":
        this.broker.open(peer, message);
        return;
      case "terminal_attach":
        this.broker.attach(peer, message);
        return;
      case "terminal_detach":
        this.broker.detach(peer, message);
        return;
      case "terminal_input":
        this.broker.input(peer, message);
        return;
      case "terminal_resize":
        this.broker.resize(peer, message);
        return;
      case "terminal_take":
        this.broker.take(peer, message);
        return;
      case "terminal_kill":
        this.broker.kill(peer, message);
        return;
      case "ping":
        peer.send({ type: "pong" });
        return;
      default: {
        const exhaustive: never = message;
        void exhaustive;
      }
    }
  }

  /** Flushes application-side queued frames after Bun's drain callback. */
  drain(id: string): void {
    this.connections.get(id)?.peer?.drain();
  }

  /** Cleans room/presence/viewer state after a socket closes. */
  close(id: string): void {
    const connection = this.connections.get(id);
    if (connection === undefined) return;
    this.connections.delete(id);
    connection.closed = true;
    connection.pendingCursor = null;
    connection.cancelCursorFlush?.();
    connection.cancelCursorFlush = null;
    connection.cancelResyncFlush?.();
    connection.cancelResyncFlush = null;
    connection.cancelJoinTimeout?.();
    if (connection.peer !== null) {
      connection.room?.leave(connection.peer);
      this.broker.detachAll(connection.peer);
    }
  }

  /** Fences every live tab belonging to a newly revoked principal. */
  revokePrincipal(principalId: string, padId: string | null = null): void {
    for (const [id, connection] of [...this.connections]) {
      const peer = connection.peer;
      if (peer?.auth.principal.id !== principalId) continue;
      if (padId !== null && peer.auth.padScope !== padId) continue;
      peer.close(4403, "revoked");
      this.close(id);
    }
  }

  /** Closes all session sockets and unregisters auth fanout during graceful shutdown. */
  shutdown(): void {
    this.removeRevocationListener();
    for (const [id, connection] of [...this.connections]) {
      connection.cancelJoinTimeout?.();
      if (connection.peer === null) {
        connection.socket.close(1001, "server shutting down");
      } else {
        connection.peer.close(1001, "server shutting down");
      }
      this.close(id);
    }
  }
}
