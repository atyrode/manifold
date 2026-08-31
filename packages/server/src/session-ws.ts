import {
  CHANNEL_LIMIT_CLOSE_CODE,
  CLIENT_MESSAGE_TYPES,
  CONNECTION_BODIES,
  CURSOR_MIN_INTERVAL_MS,
  ClientMessageSchema,
  GESTURE_MIN_INTERVAL_MS,
  MAX_SESSION_CHANNELS_PER_CONNECTION,
  MAX_SESSION_FRAME_BYTES,
  PROTOCOL_VERSION,
  type ClientMessage,
  type RuntimeDeps,
} from "@manifold/protocol";
import { ServiceError, type AuthService } from "./auth.ts";
import type { Logger } from "./log.ts";
import type { PluginHost } from "./plugin-host.ts";
import type { Room, RoomManager, RoomTimers } from "./room.ts";
import { SessionPeer, serializeServerMessage, type RawSocket } from "./session-peer.ts";
import type { TerminalBroker } from "./terminal-broker.ts";

type ClassifiedFrame =
  | { kind: "message"; message: ClientMessage }
  | { kind: "unknown_type"; frameType: string }
  | { kind: "malformed"; detail: string };

type CursorUpdate = Extract<ClientMessage, { type: "cursor" }>;
type GestureUpdate = Extract<ClientMessage, { type: "gesture" }>;
type JoinMessage = Extract<ClientMessage, { type: "join" }>;

const KNOWN_CLIENT_TYPES: Readonly<Record<string, true>> = Object.fromEntries(
  CLIENT_MESSAGE_TYPES.map((type): [string, true] => [type, true]),
);

const RESYNC_MIN_INTERVAL_MS = 1_000;
const JOIN_DEADLINE_MS = 10_000;

/** Connection-level liveness answer; it belongs to the socket, so it carries no channel. */
const PONG_FRAME = JSON.stringify({ type: "pong" });

/**
 * Which frames a spectator channel may send. Reading is the whole point of a watching
 * channel, so state, doc updates, terminal output and the attach/detach subscription pair
 * all flow to it — but every mutation is refused, so a widget's live preview can never
 * type into a PTY, resize it, move an element, or fake presence. The map is keyed by the
 * frame union itself: a new client frame cannot compile without declaring its answer.
 */
const SPECTATOR_MAY_SEND: Readonly<Record<ClientMessage["type"], boolean>> = {
  // A duplicate join closes the socket either way; the read-only refusal must not mask it.
  join: true,
  leave: true,
  resync_request: true,
  ping: true,
  terminal_attach: true,
  terminal_detach: true,
  doc_update: false,
  gesture: false,
  presence: false,
  cursor: false,
  terminal_open: false,
  terminal_input: false,
  terminal_resize: false,
  terminal_take: false,
  terminal_kill: false,
};

/**
 * One joined room on one socket. Throttle state is per channel because the cadences it
 * enforces are per room: a canvas being scribbled on must not starve a second room's
 * cursor stream, and a resync of one room says nothing about another.
 */
interface SessionChannel {
  readonly peer: SessionPeer;
  readonly room: Room;
  lastResyncAt: number | null;
  cancelResyncFlush: (() => void) | null;
  lastCursorAt: number | null;
  pendingCursor: CursorUpdate | null;
  cancelCursorFlush: (() => void) | null;
  lastGestureAt: number | null;
  pendingGesture: GestureUpdate | null;
  cancelGestureFlush: (() => void) | null;
}

interface SessionConnection {
  readonly socket: RawSocket;
  /** Bun's socket id; it prefixes every membership's `selfConnId`. */
  readonly id: string;
  /** Channel id → its room membership. Insertion ordered, which the drain rotation uses. */
  readonly channels: Map<string, SessionChannel>;
  /** Rotates the drain start so a chatty room cannot monopolize socket buffer space. */
  drainCursor: number;
  /**
   * Stamps a fresh `selfConnId` on every join. A room membership is what the roster,
   * cursor echo-suppression, and the broker's viewer registry are keyed by, so a channel
   * rejoining the SAME socket (a role swap) must never reuse the identity of the
   * membership it replaced.
   */
  nextPeerSeq: number;
  cancelJoinTimeout: (() => void) | null;
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

/** Owns join policy, channel demultiplexing, and dispatch for every `/ws/session` socket. */
export class SessionGateway {
  private readonly connections = new Map<string, SessionConnection>();
  private readonly removeRevocationListener: () => void;
  private readonly removeRosterListener: () => void;

  constructor(
    private readonly auth: AuthService,
    private readonly rooms: RoomManager,
    private readonly broker: TerminalBroker,
    private readonly plugins: PluginHost,
    private readonly timers: RoomTimers,
    private readonly logger: Logger,
    private readonly runtime: RuntimeDeps,
  ) {
    this.removeRevocationListener = auth.onRevoked((principalId, padId) => {
      this.revokePrincipal(principalId, padId);
    });
    this.removeRosterListener = plugins.onRosterChange((roster) => {
      const frame = JSON.stringify(CONNECTION_BODIES.plugins.parse({ type: "plugins", roster }));
      for (const connection of this.connections.values()) {
        if (!connection.closed) connection.socket.send(frame);
      }
    });
  }

  /** Starts the mandatory ten-second first-frame join deadline. */
  open(id: string, socket: RawSocket): void {
    const connection: SessionConnection = {
      id,
      socket,
      nextPeerSeq: 0,
      channels: new Map(),
      drainCursor: 0,
      cancelJoinTimeout: null,
      closed: false,
    };
    this.armJoinDeadline(connection);
    this.connections.set(id, connection);
    /*
      The roster, before anything else and before any join. It is CONNECTION-level state:
      it describes the workspace's vocabulary rather than any one room, so it is written
      straight to the socket like `pong` and never passes through channel serialization —
      a peer cannot tag it with a room, and a client with no room yet still learns what
      exists. Delivered here on open and again on every change (D3).
     */
    socket.send(
      JSON.stringify(
        CONNECTION_BODIES.plugins.parse({ type: "plugins", roster: this.plugins.roster() }),
      ),
    );
  }

  /**
   * A socket must be carrying at least one room to stay open — at the handshake and
   * again after its last channel leaves. One deadline, one close code: an idle
   * connection is indistinguishable from one that never joined.
   */
  private armJoinDeadline(connection: SessionConnection): void {
    connection.cancelJoinTimeout?.();
    connection.cancelJoinTimeout = this.timers.schedule(() => {
      connection.cancelJoinTimeout = null;
      if (connection.channels.size === 0) connection.socket.close(4002, "join timeout");
    }, JOIN_DEADLINE_MS);
  }

  /** Classifies, validates, and routes one inbound text frame to its channel. */
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
      case "message": {
        const message = classified.message;
        if (connection.channels.size === 0 && message.type !== "join") {
          connection.socket.close(4002, "first frame must be join");
          return;
        }
        if (message.type === "ping") {
          connection.socket.send(PONG_FRAME);
          return;
        }
        if (message.type === "join") {
          this.joinChannel(connection, message);
          return;
        }
        const channel = connection.channels.get(message.ch);
        if (channel === undefined) {
          // A frame can legitimately be in flight when the server retires its channel
          // (pad deleted, queue overflow). Dropping it keeps that race from killing the
          // rooms that are still healthy on this socket.
          this.logger.warn("session_unknown_channel", { frame: message.type });
          return;
        }
        this.dispatch(connection, channel, message);
        return;
      }
      default: {
        const exhaustive: never = classified;
        void exhaustive;
      }
    }
  }

  /** Writes a channel refusal for a channel that has no peer yet (join never completed). */
  private refuseChannel(
    connection: SessionConnection,
    ch: string,
    code: number,
    reason: string,
  ): void {
    const frame = serializeServerMessage({ type: "channel_closed", code, reason });
    connection.socket.send(`{"ch":"${ch}",${frame.body.slice(1)}`);
  }

  /**
   * Binds one channel id to one room. Credential and wire failures close the SOCKET
   * (they invalidate everything it carries); room-scoped failures refuse just this
   * channel, so a widget pointing at a deleted pad never takes a tab down with it.
   */
  private joinChannel(connection: SessionConnection, message: JoinMessage): void {
    if (message.protocolVersion !== PROTOCOL_VERSION) {
      connection.socket.close(4409, "protocol version mismatch");
      return;
    }
    if (connection.channels.has(message.ch)) {
      connection.socket.close(4002, "duplicate join");
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
    if (connection.channels.size >= MAX_SESSION_CHANNELS_PER_CONNECTION) {
      this.logger.warn("session_channel_limit", { padId: message.padId });
      this.refuseChannel(connection, message.ch, CHANNEL_LIMIT_CLOSE_CODE, "channel limit reached");
      return;
    }
    const room = this.rooms.get(message.padId);
    if (room === null) {
      this.refuseChannel(connection, message.ch, 4404, "pad not found");
      return;
    }
    this.broker.pruneExitedUnhomedForPad(message.padId);

    connection.cancelJoinTimeout?.();
    connection.cancelJoinTimeout = null;
    const peer = new SessionPeer(
      `${connection.id}.${(connection.nextPeerSeq += 1)}`,
      connection.socket,
      context,
      message.padId,
      message.ch,
      message.spectator === true,
      (closing) => {
        this.retireChannel(connection, closing);
      },
    );
    const channel: SessionChannel = {
      peer,
      room,
      lastResyncAt: null,
      cancelResyncFlush: null,
      lastCursorAt: null,
      pendingCursor: null,
      cancelCursorFlush: null,
      lastGestureAt: null,
      pendingGesture: null,
      cancelGestureFlush: null,
    };
    connection.channels.set(message.ch, channel);
    // A refused join already closed the peer, and `retireChannel` cleaned its record —
    // including re-arming the join deadline when nothing is left on this socket.
    room.join(peer);
  }

  /** Frees one channel's room membership, terminal viewers, and pending throttles. */
  private releaseChannel(connection: SessionConnection, ch: string): void {
    const channel = connection.channels.get(ch);
    if (channel === undefined) return;
    connection.channels.delete(ch);
    channel.pendingCursor = null;
    channel.cancelCursorFlush?.();
    channel.cancelCursorFlush = null;
    channel.pendingGesture = null;
    channel.cancelGestureFlush?.();
    channel.cancelGestureFlush = null;
    channel.cancelResyncFlush?.();
    channel.cancelResyncFlush = null;
    channel.room.leave(channel.peer);
    this.broker.detachAll(channel.peer);
    if (!connection.closed && connection.channels.size === 0) this.armJoinDeadline(connection);
  }

  /** Called by a peer that closed itself (channel refusal, overflow, transport failure). */
  private retireChannel(connection: SessionConnection, peer: SessionPeer): void {
    if (connection.channels.get(peer.channel)?.peer !== peer) return;
    this.releaseChannel(connection, peer.channel);
  }

  /**
   * Relays immediately when the cadence is open, otherwise retains exactly the newest
   * cursor and flushes it at the boundary. This preserves latest-wins without flooding.
   */
  private relayCursor(
    connection: SessionConnection,
    channel: SessionChannel,
    cursor: CursorUpdate,
  ): void {
    const now = this.runtime.now();
    const elapsed =
      channel.lastCursorAt === null ? CURSOR_MIN_INTERVAL_MS : now - channel.lastCursorAt;
    if (elapsed >= CURSOR_MIN_INTERVAL_MS) {
      channel.cancelCursorFlush?.();
      channel.cancelCursorFlush = null;
      channel.pendingCursor = null;
      channel.lastCursorAt = now;
      channel.room.relayCursor(channel.peer, cursor);
      return;
    }

    channel.pendingCursor = cursor;
    if (channel.cancelCursorFlush !== null) return;
    channel.cancelCursorFlush = this.timers.schedule(() => {
      channel.cancelCursorFlush = null;
      const pending = channel.pendingCursor;
      channel.pendingCursor = null;
      if (connection.closed || pending === null) return;
      if (connection.channels.get(channel.peer.channel) !== channel) return;
      channel.lastCursorAt = this.runtime.now();
      channel.room.relayCursor(channel.peer, pending);
    }, CURSOR_MIN_INTERVAL_MS - elapsed);
  }

  /**
   * Relays gesture end frames immediately; active frames are newest-wins at the gesture
   * cadence so a remote override can never be stranded by a throttled release.
   */
  private relayGesture(
    connection: SessionConnection,
    channel: SessionChannel,
    gesture: GestureUpdate,
  ): void {
    const now = this.runtime.now();
    if (gesture.phase === "end") {
      channel.cancelGestureFlush?.();
      channel.cancelGestureFlush = null;
      channel.pendingGesture = null;
      channel.lastGestureAt = now;
      channel.room.relayGesture(channel.peer, gesture);
      return;
    }

    const elapsed =
      channel.lastGestureAt === null ? GESTURE_MIN_INTERVAL_MS : now - channel.lastGestureAt;
    if (elapsed >= GESTURE_MIN_INTERVAL_MS) {
      channel.cancelGestureFlush?.();
      channel.cancelGestureFlush = null;
      channel.pendingGesture = null;
      channel.lastGestureAt = now;
      channel.room.relayGesture(channel.peer, gesture);
      return;
    }

    channel.pendingGesture = gesture;
    if (channel.cancelGestureFlush !== null) return;
    channel.cancelGestureFlush = this.timers.schedule(() => {
      channel.cancelGestureFlush = null;
      const pending = channel.pendingGesture;
      channel.pendingGesture = null;
      if (connection.closed || pending === null) return;
      if (connection.channels.get(channel.peer.channel) !== channel) return;
      channel.lastGestureAt = this.runtime.now();
      channel.room.relayGesture(channel.peer, pending);
    }, GESTURE_MIN_INTERVAL_MS - elapsed);
  }

  /** Applies one cadence gate to explicit requests and automatic epoch-mismatch recovery. */
  private sendResyncIfDue(connection: SessionConnection, channel: SessionChannel): void {
    const now = this.runtime.now();
    const elapsed =
      channel.lastResyncAt === null ? RESYNC_MIN_INTERVAL_MS : now - channel.lastResyncAt;
    if (elapsed >= RESYNC_MIN_INTERVAL_MS) {
      channel.cancelResyncFlush?.();
      channel.cancelResyncFlush = null;
      channel.lastResyncAt = now;
      this.broker.pruneExitedUnhomedForPad(channel.peer.padId);
      channel.room.sendResync(channel.peer);
      return;
    }

    if (channel.cancelResyncFlush !== null) return;
    channel.cancelResyncFlush = this.timers.schedule(() => {
      channel.cancelResyncFlush = null;
      if (connection.closed) return;
      if (connection.channels.get(channel.peer.channel) !== channel) return;
      channel.lastResyncAt = this.runtime.now();
      this.broker.pruneExitedUnhomedForPad(channel.peer.padId);
      channel.room.sendResync(channel.peer);
    }, RESYNC_MIN_INTERVAL_MS - elapsed);
  }

  private dispatch(
    connection: SessionConnection,
    channel: SessionChannel,
    message: ClientMessage,
  ): void {
    const peer = channel.peer;
    const room = channel.room;
    if (peer.spectator && !SPECTATOR_MAY_SEND[message.type]) {
      peer.send({
        type: "error",
        code: "forbidden",
        message: "spectator sockets are read-only",
      });
      return;
    }
    switch (message.type) {
      case "join":
      case "ping":
        // Routed before dispatch: join creates channels, ping answers the socket.
        return;
      case "leave":
        this.releaseChannel(connection, message.ch);
        return;
      case "doc_update":
        if (!this.auth.allows(peer.auth, "scene:write", peer.padId)) {
          peer.send({
            type: "error",
            code: "forbidden",
            message: "scene:write capability required",
          });
          return;
        }
        room.applyDocUpdate(peer, message.update);
        return;
      case "gesture":
        if (!this.auth.allows(peer.auth, "scene:write", peer.padId)) {
          peer.send({
            type: "error",
            code: "forbidden",
            message: "scene:write capability required",
          });
          return;
        }
        this.relayGesture(connection, channel, message);
        return;
      case "presence":
        room.updatePresence(peer, message.payload);
        return;
      case "cursor":
        this.relayCursor(connection, channel, message);
        return;
      case "resync_request":
        this.sendResyncIfDue(connection, channel);
        return;
      case "terminal_open":
        // Creation dies with the plugin, cleanup does not: a disabled terminals plugin
        // refuses NEW terminals here, while attach, input, detach and kill of sessions that
        // already exist keep working — nobody is locked out of removing things by an
        // administrator turning a plugin off (D12).
        if (!this.plugins.composition().enabled("core.terminals")) {
          peer.send({
            type: "error",
            code: "forbidden",
            message: "terminals plugin disabled",
            ref: message.elementId,
          });
          return;
        }
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
      default: {
        const exhaustive: never = message;
        void exhaustive;
      }
    }
  }

  /**
   * Flushes application-side queued frames after Bun's drain callback, rotating which
   * channel goes first: the socket buffer is shared, so a fixed order would let one
   * room's backlog permanently outrank another's.
   */
  drain(id: string): void {
    const connection = this.connections.get(id);
    if (connection === undefined || connection.channels.size === 0) return;
    if (connection.channels.size === 1) {
      for (const channel of connection.channels.values()) channel.peer.drain();
      return;
    }
    const peers = [...connection.channels.values()].map((channel) => channel.peer);
    const start = connection.drainCursor % peers.length;
    for (let offset = 0; offset < peers.length; offset += 1) {
      peers[(start + offset) % peers.length]?.drain();
    }
    connection.drainCursor = start + 1;
  }

  /** Cleans every channel's room/presence/viewer state after a socket closes. */
  close(id: string): void {
    const connection = this.connections.get(id);
    if (connection === undefined) return;
    this.connections.delete(id);
    connection.closed = true;
    connection.cancelJoinTimeout?.();
    connection.cancelJoinTimeout = null;
    for (const ch of [...connection.channels.keys()]) this.releaseChannel(connection, ch);
  }

  /**
   * Fences every live tab belonging to a newly revoked principal. A connection carries
   * one credential's channels (the SDK pools by token), and a dead credential
   * invalidates all of them, so this is a socket-level close by nature.
   */
  revokePrincipal(principalId: string, padId: string | null = null): void {
    for (const [id, connection] of [...this.connections]) {
      let fenced = false;
      for (const channel of connection.channels.values()) {
        const peer = channel.peer;
        if (peer.auth.principal.id !== principalId) continue;
        if (padId !== null && peer.auth.padScope !== padId) continue;
        fenced = true;
        break;
      }
      if (!fenced) continue;
      connection.socket.close(4403, "revoked");
      this.close(id);
    }
  }

  /** Closes all session sockets and unregisters auth fanout during graceful shutdown. */
  shutdown(): void {
    this.removeRevocationListener();
    this.removeRosterListener();
    for (const [id, connection] of [...this.connections]) {
      connection.cancelJoinTimeout?.();
      connection.socket.close(1001, "server shutting down");
      this.close(id);
    }
  }
}
