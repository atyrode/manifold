import {
  SERVER_MESSAGE_TYPES,
  ServerMessageSchema,
  reconnectDelayMs,
  type ClientMessageBody,
  type ServerMessage,
  type ServerMessageBody,
} from "@manifold/protocol";

/**
 * ONE socket per tab, ever. A room used to be a socket; now a room is a CHANNEL on a
 * shared connection, and this module owns that connection: dialing, keepalive, reconnect
 * with rejoin-every-channel, frame classification, and demultiplexing. `SessionClient`
 * keeps its per-room surface and becomes a channel handle on top of this.
 *
 * The pool is keyed by (WebSocket factory, url, token). The factory is part of the
 * transport identity on purpose: a test that hands each client its own socket double
 * genuinely has separate transports, and pooling must not pretend otherwise.
 */

export type WebSocketFactory = (url: string) => WebSocket;

/** The join a channel wants sent whenever its connection comes up. */
export type JoinBody = Extract<ClientMessageBody, { type: "join" }>;

/** Transport states a channel hears about; its own `open` comes from its own init. */
export type TransportPhase = "connecting" | "reconnecting";

/** What a room handle can be handed: every frame except the two routing-level ones. */
export type ChannelFrame = Exclude<ServerMessageBody, { type: "pong" | "channel_closed" }>;

/** What one room handle needs from the socket it shares. */
export interface ChannelSink {
  /** Built fresh per join so resume hints (epoch/rev) are always current. */
  joinBody(): JoinBody;
  /**
   * One frame routed to this channel. The two routing-level frames never arrive here:
   * `pong` answers the socket and `channel_closed` is this layer's own business.
   */
  receive(body: ChannelFrame): void;
  transportPhase(phase: TransportPhase): void;
  /**
   * This channel is over. `terminal` means retrying cannot help (a 44xx refusal) — the
   * handle reports the failure; otherwise the connection is already rejoining it.
   */
  channelClosed(code: number, reason: string, terminal: boolean): void;
  /** The connection is gone for good; `error` is null for a deliberate close. */
  transportClosed(error: Error | null): void;
}

export interface AcquireOptions {
  readonly url: string;
  readonly token: string;
  /** Reconnect on unexpected close (default true). First acquirer sets it. */
  readonly reconnect?: boolean;
  /** Backoff schedule cap in ms (default 8000). First acquirer sets it. */
  readonly backoffCapMs?: number;
  readonly webSocketFactory?: WebSocketFactory;
}

/** A joined room on a shared socket, from the owning handle's point of view. */
export interface PooledChannel {
  readonly id: string;
  /** Diagnostics: identifies the connection this channel rides, for tests and logs. */
  readonly transportId: string;
  /** Whether frames may go on the wire right now (socket open and this channel joined). */
  isOpen(): boolean;
  send(body: ClientMessageBody): void;
  /** Re-establishes the transport: an explicit `connect()` on a live handle asks for this. */
  redial(): void;
  /** Leaves the room, closing the socket when this was its last channel. */
  release(): void;
}

const KNOWN_SERVER_TYPES: ReadonlySet<string> = new Set(SERVER_MESSAGE_TYPES);

const KEEPALIVE_INTERVAL_MS = 45_000;
const MALFORMED_FRAME_CLOSE_CODE = 4002;
const TERMINAL_CLOSE_CODE_MIN = 4400;
const TERMINAL_CLOSE_CODE_MAX = 4499;
const PING_FRAME = JSON.stringify({ type: "ping" });

type ClassifiedFrame =
  | { kind: "message"; message: ServerMessage }
  | { kind: "unknown_type" }
  | { kind: "malformed"; detail: string };

type TerminalDataFrame = Extract<ServerMessage, { type: "terminal_output" | "terminal_snapshot" }>;

/**
 * Frame policy (CONTRACTS.md): unknown `type` values are ignored for forward
 * compatibility; malformed frames of KNOWN types (or non-JSON) are protocol errors — the
 * connection closes (4002) and heals via reconnect → fresh init on every channel.
 */
function isTerminalDataFrame(raw: object): raw is TerminalDataFrame {
  const type = Reflect.get(raw, "type");
  const ch = Reflect.get(raw, "ch");
  const sessionId = Reflect.get(raw, "sessionId");
  const seq = Reflect.get(raw, "seq");
  const data = Reflect.get(raw, "data");
  return (
    (type === "terminal_output" || type === "terminal_snapshot") &&
    typeof ch === "string" &&
    ch.length > 0 &&
    typeof sessionId === "string" &&
    sessionId.length > 0 &&
    typeof seq === "number" &&
    Number.isInteger(seq) &&
    seq >= 0 &&
    typeof data === "string" &&
    data.length <= 700_000
  );
}

function classifyServerFrame(data: unknown): ClassifiedFrame {
  if (typeof data !== "string") return { kind: "malformed", detail: "non-text frame" };
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return { kind: "malformed", detail: "invalid JSON" };
  }
  if (raw === null || typeof raw !== "object" || typeof Reflect.get(raw, "type") !== "string") {
    return { kind: "malformed", detail: "missing type discriminator" };
  }
  const type = Reflect.get(raw, "type") as string;
  if (!KNOWN_SERVER_TYPES.has(type)) return { kind: "unknown_type" };
  if (type === "terminal_output" || type === "terminal_snapshot") {
    return isTerminalDataFrame(raw)
      ? { kind: "message", message: raw }
      : { kind: "malformed", detail: `invalid ${type} frame` };
  }
  const parsed = ServerMessageSchema.safeParse(raw);
  if (!parsed.success) return { kind: "malformed", detail: `invalid ${type} frame` };
  return { kind: "message", message: parsed.data };
}

interface ChannelRecord {
  readonly id: string;
  readonly sink: ChannelSink;
  /** `{"ch":"c1",` — channel ids are tokens, so tagging is a prefix splice. */
  readonly prefix: string;
  /** Whether the server has this channel: joined on the wire, awaiting or holding init. */
  sent: boolean;
  /** Rejoin backoff for a channel the server dropped for a healable reason. */
  attempts: number;
  cancelRejoin: (() => void) | null;
}

/** One WebSocket carrying every room a tab renders. */
class PooledConnection {
  private socket: WebSocket | null = null;
  private readonly channels = new Map<string, ChannelRecord>();
  private nextChannelSeq = 0;
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private dead = false;

  constructor(
    readonly id: string,
    private readonly url: string,
    private readonly factory: WebSocketFactory,
    private readonly reconnect: boolean,
    private readonly backoffCapMs: number,
    private readonly onDead: (connection: PooledConnection) => void,
  ) {}

  /** Registers one room on this socket, joining it as soon as the wire allows. */
  attach(sink: ChannelSink): PooledChannel {
    this.nextChannelSeq += 1;
    const id = `c${this.nextChannelSeq}`;
    const record: ChannelRecord = {
      id,
      sink,
      prefix: `{"ch":"${id}",`,
      sent: false,
      attempts: 0,
      cancelRejoin: null,
    };
    this.channels.set(id, record);
    if (this.socket !== null && this.socket.readyState === 1) {
      sink.transportPhase("connecting");
      this.sendJoin(record);
    } else {
      sink.transportPhase(this.attempts === 0 ? "connecting" : "reconnecting");
      if (this.socket === null && this.reconnectTimer === null) this.dial();
    }
    return {
      id,
      transportId: this.id,
      isOpen: () => this.socket?.readyState === 1 && record.sent,
      send: (body) => {
        this.sendBody(record, body);
      },
      redial: () => {
        this.dial();
      },
      release: () => {
        this.release(record);
      },
    };
  }

  private sendJoin(record: ChannelRecord): void {
    record.sent = true;
    this.write(record, record.sink.joinBody());
  }

  private sendBody(record: ChannelRecord, body: ClientMessageBody): void {
    if (this.socket === null || this.socket.readyState !== 1) return;
    this.write(record, body);
  }

  /** Tags one body with its channel and puts it on the wire. */
  private write(record: ChannelRecord, body: ClientMessageBody): void {
    const socket = this.socket;
    if (socket === null) return;
    socket.send(record.prefix + JSON.stringify(body).slice(1));
  }

  private release(record: ChannelRecord): void {
    if (this.channels.get(record.id) !== record) return;
    this.channels.delete(record.id);
    record.cancelRejoin?.();
    record.cancelRejoin = null;
    if (this.channels.size === 0) {
      // The last room left: closing the socket IS leaving everything, so a `leave` frame
      // here would be pure ceremony on a connection about to disappear.
      this.teardown(1000, null);
      return;
    }
    if (record.sent && this.socket?.readyState === 1) this.write(record, { type: "leave" });
  }

  /** Opens a fresh socket, fencing every callback of the one it replaces. */
  private dial(): void {
    if (this.dead) return;
    this.stopKeepalive();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Fence every callback from the prior socket before asking it to close. Native close
    // events may arrive after the replacement has already opened.
    const previousSocket = this.socket;
    this.socket = null;
    previousSocket?.close(1000);

    const phase: TransportPhase = this.attempts === 0 ? "connecting" : "reconnecting";
    for (const record of this.channels.values()) {
      record.sent = false;
      record.sink.transportPhase(phase);
    }

    const socket = this.factory(this.url);
    this.socket = socket;

    socket.onopen = () => {
      if (this.socket !== socket) return;
      // One socket, one dial, every room rejoined: a reconnect is N joins, not N sockets.
      for (const record of this.channels.values()) this.sendJoin(record);
      this.startKeepalive();
    };

    socket.onmessage = (event: MessageEvent) => {
      if (this.socket !== socket) return;
      const classified = classifyServerFrame(event.data);
      switch (classified.kind) {
        case "message":
          this.route(classified.message);
          return;
        case "unknown_type":
          return; // forward compatibility: newer servers may emit types we don't know
        case "malformed":
          // A malformed KNOWN frame means version skew or corruption — no room's state is
          // provable any more. Close with an application protocol error and heal through
          // the normal reconnect → fresh init path (CONTRACTS.md).
          console.error("manifold-sdk: malformed server frame", classified.detail);
          socket.close(MALFORMED_FRAME_CLOSE_CODE, "malformed server frame");
          return;
      }
    };

    socket.onclose = (event: CloseEvent) => {
      if (this.socket !== socket) return; // superseded socket
      this.socket = null;
      this.stopKeepalive();
      for (const record of this.channels.values()) record.sent = false;

      // 44xx codes are permanent session rejections. Retrying them cannot succeed without
      // changed credentials/input, whereas our own 4002 protocol-healing close must redial.
      const terminalClose =
        event.code !== MALFORMED_FRAME_CLOSE_CODE &&
        event.code >= TERMINAL_CLOSE_CODE_MIN &&
        event.code <= TERMINAL_CLOSE_CODE_MAX;
      if (terminalClose) {
        const reason = event.reason.trim();
        this.teardown(
          null,
          new Error(
            reason === ""
              ? `session rejected with close code ${event.code}`
              : `session rejected with close code ${event.code}: ${reason}`,
          ),
        );
        return;
      }
      if (!this.reconnect) {
        this.teardown(null, null);
        return;
      }

      const delay = reconnectDelayMs(this.attempts, 250, this.backoffCapMs);
      this.attempts += 1;
      const timer = setTimeout(() => {
        // clearTimeout cannot retract a callback already queued by the event loop. The
        // identity check fences such stale callbacks after teardown or a manual redial.
        if (this.reconnectTimer !== timer) return;
        this.reconnectTimer = null;
        if (!this.dead && this.socket === null) this.dial();
      }, delay);
      this.reconnectTimer = timer;
      for (const record of this.channels.values()) record.sink.transportPhase("reconnecting");
    };
  }

  /** Demultiplexes one validated frame to the channel that owns it. */
  private route(frame: ServerMessage): void {
    if (frame.type === "pong") return; // socket liveness, owned here
    const record = this.channels.get(frame.ch);
    if (record === undefined) return; // a frame for a room this tab already released
    if (frame.type === "init" || frame.type === "resync") {
      this.attempts = 0;
      record.attempts = 0;
    }
    if (frame.type === "channel_closed") {
      this.channelClosed(record, frame.code, frame.reason);
      return;
    }
    // The wire frame IS the body plus routing, so it is handed over as-is: copying a PTY
    // output frame at 60 Hz per room to strip one key would be pure waste, and a
    // subscriber reading a body simply never looks at `ch`.
    record.sink.receive(frame);
  }

  /**
   * The server dropped ONE room. A 44xx refusal is terminal for that room (the pad is
   * gone, the cap is full) and the handle reports it; anything else — an overflowing
   * queue, state past the transport ceiling — heals exactly as a socket close did, by
   * rejoining on backoff while every other room keeps streaming.
   */
  private channelClosed(record: ChannelRecord, code: number, reason: string): void {
    const terminal =
      code !== MALFORMED_FRAME_CLOSE_CODE &&
      code >= TERMINAL_CLOSE_CODE_MIN &&
      code <= TERMINAL_CLOSE_CODE_MAX;
    record.sent = false;
    if (terminal) {
      this.channels.delete(record.id);
      record.cancelRejoin?.();
      record.cancelRejoin = null;
      record.sink.channelClosed(code, reason, true);
      if (this.channels.size === 0) this.teardown(1000, null);
      return;
    }
    record.sink.channelClosed(code, reason, false);
    if (record.cancelRejoin !== null) return;
    const delay = reconnectDelayMs(record.attempts, 250, this.backoffCapMs);
    record.attempts += 1;
    const timer = setTimeout(() => {
      if (record.cancelRejoin === null) return;
      record.cancelRejoin = null;
      if (this.dead || this.channels.get(record.id) !== record) return;
      if (this.socket?.readyState === 1) this.sendJoin(record);
    }, delay);
    record.cancelRejoin = () => {
      clearTimeout(timer);
    };
  }

  private startKeepalive(): void {
    this.stopKeepalive();
    const timer = setInterval(() => {
      if (this.keepaliveTimer !== timer) return;
      if (this.socket?.readyState === 1) this.socket.send(PING_FRAME);
    }, KEEPALIVE_INTERVAL_MS);
    this.keepaliveTimer = timer;
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer === null) return;
    clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
  }

  /**
   * Retires this connection: closes the socket when a code is given, cancels every timer,
   * unregisters from the pool, and tells whatever channels are left that the transport is
   * gone. A dead connection never dials again — the next `connect()` builds a new one.
   */
  private teardown(closeCode: number | null, error: Error | null): void {
    if (this.dead) return;
    this.dead = true;
    this.stopKeepalive();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    if (closeCode !== null) socket?.close(closeCode);
    const orphans = [...this.channels.values()];
    this.channels.clear();
    this.onDead(this);
    for (const record of orphans) {
      record.cancelRejoin?.();
      record.sink.transportClosed(error);
    }
  }
}

const DEFAULT_FACTORY: WebSocketFactory = (url: string) => new WebSocket(url);
const registries = new WeakMap<WebSocketFactory, Map<string, PooledConnection>>();
let nextTransportSeq = 0;

/**
 * Returns a channel on the connection this (factory, url, token) triple names, dialing
 * one if the tab does not have it yet. Reconnect policy and backoff belong to the
 * CONNECTION: the first acquirer sets them, and later channels ride the same transport.
 */
export function acquireChannel(options: AcquireOptions, sink: ChannelSink): PooledChannel {
  const factory = options.webSocketFactory ?? DEFAULT_FACTORY;
  let registry = registries.get(factory);
  if (registry === undefined) {
    registry = new Map();
    registries.set(factory, registry);
  }
  const key = `${options.url}\u0000${options.token}`;
  let connection = registry.get(key);
  if (connection === undefined) {
    nextTransportSeq += 1;
    const owned = registry;
    connection = new PooledConnection(
      `t${nextTransportSeq}`,
      options.url,
      factory,
      options.reconnect !== false,
      options.backoffCapMs ?? 8000,
      (dead) => {
        if (owned.get(key) === dead) owned.delete(key);
      },
    );
    registry.set(key, connection);
  }
  return connection.attach(sink);
}
