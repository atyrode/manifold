import {
  DIAL_LIVENESS_TIMEOUT_MS,
  MAX_SESSION_BASE64_CHARS,
  MAX_SUBSCRIBE_TOPICS,
  PROTOCOL_VERSION,
  SERVER_MESSAGE_TYPES,
  ServerMessageSchema,
  formatManifoldUri,
  type CONNECTION_LEVEL_MESSAGE_TYPES,
  type ClientMessageBody,
  type ManifoldRef,
  type ServerMessage,
  type ServerMessageBody,
} from "@manifold/protocol";
import {
  LivenessWatchdog,
  MALFORMED_FRAME_CLOSE_CODE,
  ReconnectBackoff,
  classifyEnvelope,
} from "./dial-loop.ts";
import { StreamState, type OpenStreamOptions, type StreamHandle } from "./stream.ts";

/**
 * ONE socket per tab, ever. A room used to be a socket; now a room is a CHANNEL on a
 * shared connection, and this module owns that connection: dialing, keepalive, reconnect
 * with rejoin-every-channel, frame classification, and demultiplexing. `SessionClient`
 * keeps its per-room ref and becomes a channel handle on top of this.
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

/**
 * What a room handle can be handed as ROOM traffic: every CHANNEL frame. Connection-level
 * frames are excluded by the protocol's own classification rather than by a hand-kept
 * list, so a new connection-level category (v14's `plugins` roster was the first with a
 * body) can never reach a channel that has no idea what to do with it.
 * `channel_closed` is excluded too: it is this layer's business, not a room's.
 */
export type ChannelFrame = Exclude<
  ServerMessageBody,
  { type: (typeof CONNECTION_LEVEL_MESSAGE_TYPES)[number] | "channel_closed" }
>;

/**
 * A frame that addresses the SOCKET rather than a room, minus the frames the pool answers
 * itself: `ping` is liveness and `observed` completes the observer handshake here. Every
 * handle on the connection hears the remaining connection frames.
 */
export type ConnectionFrame = Exclude<
  Extract<ServerMessageBody, { type: (typeof CONNECTION_LEVEL_MESSAGE_TYPES)[number] }>,
  { type: "ping" | "observed" } | { subscriptionId: string }
>;

/**
 * The connection frames that are STATE: the pool replays the latest of each to a handle that
 * attaches after it arrived, so a client subscribing late is never left waiting for the next
 * change.
 *
 * `event` is deliberately not one of them. An event is NEWS — it says something changed at an
 * instant, and the thing it describes is already readable through the door a fresh client
 * uses. Remembering the last one and handing it to a late attacher would deliver a
 * notification about a change that had already been observed, which is the backlog ADR 0012 §5
 * refuses, arriving through the SDK instead of through a queue.
 */
export type ConnectionStateFrame = Exclude<ConnectionFrame, { type: "event" }>;

/** What one room handle needs from the socket it shares. */
export interface ChannelSink {
  /** Built fresh per join so resume hints (epoch/rev) are always current. */
  joinBody(): JoinBody;
  /**
   * One ROOM frame routed to this channel. Nothing routing-level arrives here: `ping`
   * answers the socket, `channel_closed` is this layer's own business, and a
   * connection-level frame goes to `connectionFrame` instead.
   */
  receive(body: ChannelFrame): void;
  /**
   * One connection-level frame: server correlation, plugin roster, or an event. Shared by
   * every channel on the socket, so a handle treats it as workspace news rather than room state.
   */
  connectionFrame(body: ConnectionFrame): void;
  transportPhase(phase: TransportPhase): void;
  /**
   * This channel is over. `terminal` means no automatic retry (a 44xx refusal or exhausted
   * initialization deadline) — the handle reports failure; otherwise it is rejoining.
   */
  channelClosed(code: number, reason: string, terminal: boolean): void;
  /** The connection is gone for good; null means this handle deliberately released it. */
  transportClosed(failure: ConnectionFailure | null): void;
}

/** What a roomless workspace observer needs from the socket it shares. */
export interface ObserverSink {
  connectionFrame(body: ConnectionFrame): void;
  transportPhase(phase: TransportPhase): void;
  observed(): void;
  /** The connection is gone for good; null means this handle deliberately released it. */
  transportClosed(failure: ConnectionFailure | null): void;
}

/** Bounded, non-secret transport failure data handed to each channel on a dead socket. */
export interface ConnectionFailure {
  readonly code: number;
  readonly reason: string;
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

/** Common connection-level surface shared by room channels and roomless observers. */
export interface PooledSession {
  /** Diagnostics: identifies the physical connection this handle rides. */
  readonly transportId: string;
  isOpen(): boolean;
  subscribe(topics: readonly ManifoldRef[]): () => void;
  openStream(options: OpenStreamOptions): StreamHandle;
  /** Re-establishes the transport: an explicit `connect()` on a live handle asks for this. */
  redial(): void;
  release(): void;
}

/** A joined room on a shared socket, from the owning handle's point of view. */
export interface PooledChannel extends PooledSession {
  readonly id: string;
  /** Whether room frames may go on the wire (socket open and this channel initialized). */
  isOpen(): boolean;
  send(body: ClientMessageBody): void;
}

/** A roomless observer on the same shared socket. */
export type PooledObserver = PooledSession;

const KNOWN_SERVER_TYPES: ReadonlySet<string> = new Set(SERVER_MESSAGE_TYPES);

const TERMINAL_CLOSE_CODE_MIN = 4400;
const TERMINAL_CLOSE_CODE_MAX = 4499;
const PONG_FRAME = JSON.stringify({ type: "pong" });
const MAX_CLOSE_REASON_CHARS = 120;
const boundedCloseReason = (reason: string): string => {
  const trimmed = reason.trim();
  return trimmed === "" ? "transport closed" : trimmed.slice(0, MAX_CLOSE_REASON_CHARS);
};

/**
 * First-attempt reconnect ceiling for a session socket. Tighter than the instance dial's,
 * because this is the socket a viewer is watching a workspace through: the cap the caller
 * chooses is what bounds a long outage, and the base is what makes a blip invisible.
 */
const RECONNECT_BASE_MS = 250;

/** A live socket does not prove that any particular room received its initial state. */
const CHANNEL_INIT_TIMEOUT_MS = 10_000;
const CHANNEL_INIT_MAX_ATTEMPTS = 3;

type ClassifiedFrame =
  | { kind: "message"; message: ServerMessage }
  | { kind: "unknown_type" }
  | { kind: "malformed"; detail: string };

type TerminalDataFrame = Extract<ServerMessage, { type: "terminal_output" | "terminal_snapshot" }>;

/**
 * Frame policy (CONTRACTS.md): unknown `type` values are ignored for forward
 * compatibility; malformed frames of KNOWN types (or non-JSON) are protocol errors — the
 * connection closes (4002) and heals via reconnect → fresh init on every channel. The envelope
 * half is the dial skeleton's (`./dial-loop.ts`); what a valid server frame IS stays here, in
 * the schema and in the one hand-written predicate below.
 */
function isTerminalDataFrame(raw: object): raw is TerminalDataFrame {
  const type = Reflect.get(raw, "type");
  const ch = Reflect.get(raw, "ch");
  const terminalId = Reflect.get(raw, "terminalId");
  const seq = Reflect.get(raw, "seq");
  const data = Reflect.get(raw, "data");
  return (
    (type === "terminal_output" || type === "terminal_snapshot") &&
    typeof ch === "string" &&
    ch.length > 0 &&
    typeof terminalId === "string" &&
    terminalId.length > 0 &&
    typeof seq === "number" &&
    Number.isInteger(seq) &&
    seq >= 0 &&
    typeof data === "string" &&
    data.length <= MAX_SESSION_BASE64_CHARS
  );
}

function classifyServerFrame(data: unknown): ClassifiedFrame {
  const envelope = classifyEnvelope(data, (type) => KNOWN_SERVER_TYPES.has(type));
  if (envelope.kind !== "envelope") return envelope;
  const { type, raw } = envelope;
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
  initialized: boolean;
  initTimer: ReturnType<typeof setTimeout> | null;
  initTimeouts: number;
  /**
   * Rejoin backoff for a channel the server dropped for a healable reason — the SAME skeleton
   * the socket itself reconnects on, per channel, because one dropped room heals while every
   * other room on the socket keeps streaming.
   */
  readonly rejoin: ReconnectBackoff;
}

/**
 * The latest STATE frame of each connection-level category on this socket: state, not a log.
 * A roster describes the workspace NOW, so one slot per category is the whole memory, and a
 * new category added to the protocol fails to compile until it is listed here.
 */
type ConnectionState = {
  [K in ConnectionStateFrame["type"]]: Extract<ConnectionStateFrame, { type: K }> | null;
};

/** One topic this socket holds, and how many handles asked for it. */
interface TopicRecord {
  readonly ref: ManifoldRef;
  count: number;
}

/**
 * The slice of a browser `window` the pool listens on, typed structurally: the SDK is
 * consumed by the server and the testkit under bun-types alone, so it may not name the DOM
 * lib's `window` or `PageTransitionEvent`. Under Bun no document exists and the lookup
 * answers `undefined`.
 */
type PageListener = (event: { readonly persisted?: boolean }) => void;
interface PageWindow {
  addEventListener(type: "pagehide" | "pageshow", listener: PageListener): void;
  removeEventListener(type: "pagehide" | "pageshow", listener: PageListener): void;
}
function pageWindow(): PageWindow | undefined {
  // `typeof globalThis` under bun-types has no `window` and no index signature; Reflect reads it as a value.
  const candidate: unknown = Reflect.get(globalThis, "window");
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    !("addEventListener" in candidate) ||
    typeof candidate.addEventListener !== "function" ||
    !("removeEventListener" in candidate) ||
    typeof candidate.removeEventListener !== "function"
  ) {
    return undefined;
  }
  // A browser window, checked above for exactly the two methods used; the DOM lib that
  // would name it is not in scope for every consumer of this package.
  const page = candidate as PageWindow;
  return page;
}

/** One WebSocket carrying every room a tab renders. */
class PooledConnection {
  private socket: WebSocket | null = null;
  private readonly channels = new Map<string, ChannelRecord>();
  private readonly observers = new Set<ObserverSink>();
  private observerSent = false;
  private observerAdmitted = false;
  private readonly connectionState: ConnectionState = { session: null, plugins: null };
  /** Live subscriptions, keyed by the ONE joined form of their address. */
  private readonly topics = new Map<string, TopicRecord>();
  private readonly streams = new Map<string, { state: StreamState; count: number }>();
  private readonly streamsById = new Map<string, StreamState>();
  private nextStreamSeq = 0;
  private nextChannelSeq = 0;
  private readonly backoff: ReconnectBackoff;
  private readonly liveness = new LivenessWatchdog({
    timeoutMs: DIAL_LIVENESS_TIMEOUT_MS,
    reason: "server silent past deadline",
    current: () => this.socket,
  });
  private dead = false;

  /**
   * A document leaving the foreground for good — a full navigation, a reload, a tab going
   * into the back/forward cache — must release its rooms NOW, not when the server's ping
   * finally goes unanswered: until then every peer sees a ghost occupant, and a spotlight
   * addressed to this principal can land on the ghost (#172). `pagehide` is the one event
   * fired on every such exit; the close is a normal 1000, so `onclose` schedules the usual
   * redial, whose timer only ever fires if the page comes back — and `pageshow` with
   * `persisted` short-circuits that backoff so a restored page reconnects at once.
   * Browser-only by construction: a Bun client has no document to hide.
   */
  private readonly onPageHide: PageListener = () => {
    this.socket?.close(1000, "pagehide");
  };
  private readonly onPageShow: PageListener = (event) => {
    if (event.persisted !== true || this.dead) return;
    this.backoff.cancel();
    if (this.socket === null) this.dial();
  };

  constructor(
    readonly id: string,
    private readonly url: string,
    private readonly token: string,
    private readonly factory: WebSocketFactory,
    private readonly reconnect: boolean,
    private readonly backoffCapMs: number,
    private readonly onDead: (connection: PooledConnection) => void,
  ) {
    this.backoff = new ReconnectBackoff({
      baseMs: RECONNECT_BASE_MS,
      capMs: backoffCapMs,
      // The redial's own preconditions: a torn-down connection never dials again, and a
      // socket that came back another way (a manual `redial`) has nothing owed to it.
      dial: () => {
        if (!this.dead && this.socket === null) this.dial();
      },
    });
    pageWindow()?.addEventListener("pagehide", this.onPageHide);
    pageWindow()?.addEventListener("pageshow", this.onPageShow);
  }

  /** Registers one room on this socket, joining it as soon as the wire allows. */
  attach(sink: ChannelSink): PooledChannel {
    this.nextChannelSeq += 1;
    const id = `c${this.nextChannelSeq}`;
    const record: ChannelRecord = {
      id,
      sink,
      prefix: `{"ch":"${id}",`,
      sent: false,
      initialized: false,
      initTimer: null,
      initTimeouts: 0,
      rejoin: new ReconnectBackoff({
        baseMs: RECONNECT_BASE_MS,
        capMs: this.backoffCapMs,
        dial: () => {
          if (this.dead || this.channels.get(id) !== record) return;
          if (this.socket?.readyState === 1) this.sendJoin(record);
        },
      }),
    };
    this.channels.set(id, record);
    if (this.socket !== null && this.socket.readyState === 1) {
      sink.transportPhase("connecting");
    } else {
      sink.transportPhase(this.backoff.attempts === 0 ? "connecting" : "reconnecting");
    }
    // Replay after the phase transition: a SessionClient clears stale socket correlation
    // when that transition arrives, so reversing these two steps would erase the current
    // connection id from every channel attached to an already-open pooled socket.
    for (const body of Object.values(this.connectionState)) {
      if (body !== null) sink.connectionFrame(body);
    }
    if (this.socket !== null && this.socket.readyState === 1) {
      this.sendJoin(record);
    } else if (this.socket === null && !this.backoff.pending) {
      this.dial();
    }
    return {
      id,
      transportId: this.id,
      isOpen: () => this.socket?.readyState === 1 && record.initialized,
      send: (body) => {
        this.sendBody(record, body);
      },
      subscribe: (topics) => this.subscribe(topics),
      openStream: (options) => this.openStream(options),
      redial: () => {
        this.dial();
      },
      release: () => {
        this.release(record);
      },
    };
  }

  /** Registers a workspace observer without allocating a room channel. */
  attachObserver(sink: ObserverSink): PooledObserver {
    this.observers.add(sink);
    if (this.socket !== null && this.socket.readyState === 1) {
      sink.transportPhase("connecting");
    } else {
      sink.transportPhase(this.backoff.attempts === 0 ? "connecting" : "reconnecting");
    }
    for (const body of Object.values(this.connectionState)) {
      if (body !== null) sink.connectionFrame(body);
    }
    if (this.socket !== null && this.socket.readyState === 1) {
      this.sendObserve();
      // Observation belongs to the socket. If a prior observer released while a room kept
      // that socket alive, a later observer inherits the still-live admission immediately.
      if (this.observerAdmitted) sink.observed();
    } else if (this.socket === null && !this.backoff.pending) {
      this.dial();
    }
    return {
      transportId: this.id,
      isOpen: () => this.socket?.readyState === 1 && this.observerAdmitted,
      subscribe: (topics) => this.subscribe(topics),
      openStream: (options) => this.openStream(options),
      redial: () => {
        this.dial();
      },
      release: () => {
        if (!this.observers.delete(sink)) return;
        if (this.observers.size === 0 && this.channels.size === 0) this.teardown(1000, null);
      },
    };
  }

  private sendObserve(): void {
    if (
      this.observerSent ||
      this.observers.size === 0 ||
      this.socket === null ||
      this.socket.readyState !== 1
    ) {
      return;
    }
    this.observerSent = true;
    this.writeConnection({
      type: "observe",
      token: this.token,
      protocolVersion: PROTOCOL_VERSION,
    });
  }

  private sendJoin(record: ChannelRecord): void {
    const socket = this.socket;
    if (record.sent || socket?.readyState !== 1) return;
    record.rejoin.cancel();
    record.sent = true;
    record.initialized = false;
    const timer = setTimeout(() => {
      if (record.initTimer !== timer || this.socket !== socket) return;
      record.initTimer = null;
      if (this.channels.get(record.id) !== record || !record.sent) return;
      record.initTimeouts += 1;
      // Join and leave are ordered synchronous server operations. Leave first: a second
      // join on an occupied channel is a protocol error that would close every sibling.
      this.write(record, { type: "leave" });
      this.channelClosed(
        record,
        4008,
        `channel initialization timed out after ${record.initTimeouts} attempt(s)`,
        !this.reconnect || record.initTimeouts >= CHANNEL_INIT_MAX_ATTEMPTS,
      );
    }, CHANNEL_INIT_TIMEOUT_MS);
    record.initTimer = timer;
    this.write(record, record.sink.joinBody());
  }

  private clearInit(record: ChannelRecord): void {
    if (record.initTimer !== null) clearTimeout(record.initTimer);
    record.initTimer = null;
    record.initialized = false;
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

  /**
   * Puts one CONNECTION-level body on the wire untagged. The subscription pair addresses the
   * socket, so splicing a channel prefix onto it would be a routing lie — and the server
   * strict-parses, so it would be a closed socket rather than a warning.
   */
  private writeConnection(body: ClientMessageBody): void {
    const socket = this.socket;
    if (socket === null || socket.readyState !== 1) return;
    socket.send(JSON.stringify(body));
  }

  private openStream(options: OpenStreamOptions): StreamHandle {
    // Share only a replay we still retain in full; never pretend an old snapshot
    // contains live frames already delivered to earlier holders.
    const key = JSON.stringify([
      options.kind,
      formatManifoldUri(options.node),
      options.cursor ?? null,
    ]);
    let held = this.streams.get(key);
    if (
      held === undefined ||
      held.state.status === "closed" ||
      held.state.status === "refused" ||
      (held.state.snapshot !== null && held.state.cursor?.seq !== held.state.snapshot.lastSeq)
    ) {
      const state = new StreamState(`s${++this.nextStreamSeq}`, options);
      held = { state, count: 0 };
      this.streams.set(key, held);
      this.streamsById.set(state.subscriptionId, state);
      this.writeConnection({
        type: "stream_open",
        subscriptionId: state.subscriptionId,
        ...options,
      });
    }
    held.count += 1;
    const owned = held;
    return held.state.handle(() => {
      owned.count -= 1;
      if (owned.count !== 0) return;
      if (this.streams.get(key) === owned) this.streams.delete(key);
      this.streamsById.delete(owned.state.subscriptionId);
      this.writeConnection({ type: "stream_close", subscriptionId: owned.state.subscriptionId });
    });
  }

  /**
   * One handle's declared interest, refcounted onto the socket's own set. Only the 0→1 and
   * 1→0 transitions reach the wire: the server holds a SET, so re-declaring a topic it
   * already has is noise, and dropping one another handle still wants is a bug the refcount
   * exists to make unsayable.
   */
  private subscribe(topics: readonly ManifoldRef[]): () => void {
    const added: ManifoldRef[] = [];
    const mine: string[] = [];
    for (const ref of topics) {
      const key = formatManifoldUri(ref);
      mine.push(key);
      const held = this.topics.get(key);
      if (held === undefined) {
        this.topics.set(key, { ref, count: 1 });
        added.push(ref);
        continue;
      }
      held.count += 1;
    }
    this.declare("subscribe", added);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const dropped: ManifoldRef[] = [];
      for (const key of mine) {
        const held = this.topics.get(key);
        if (held === undefined) continue;
        held.count -= 1;
        if (held.count > 0) continue;
        this.topics.delete(key);
        dropped.push(held.ref);
      }
      this.declare("unsubscribe", dropped);
    };
  }

  /**
   * Declares or withdraws topics, in frames the wire admits. The bound is the protocol's
   * (`MAX_SUBSCRIBE_TOPICS`) and exceeding it is a MALFORMED frame, so a client watching more
   * nodes than one frame holds sends several rather than one the server refuses to read.
   */
  private declare(type: "subscribe" | "unsubscribe", refs: readonly ManifoldRef[]): void {
    for (let at = 0; at < refs.length; at += MAX_SUBSCRIBE_TOPICS) {
      this.writeConnection({ type, topics: refs.slice(at, at + MAX_SUBSCRIBE_TOPICS) });
    }
  }

  private release(record: ChannelRecord): void {
    if (this.channels.get(record.id) !== record) return;
    this.channels.delete(record.id);
    record.rejoin.cancel();
    this.clearInit(record);
    if (this.channels.size === 0 && this.observers.size === 0) {
      // The last handle left: closing the socket releases its connection-level state too.
      this.teardown(1000, null);
      return;
    }
    if (record.sent && this.socket?.readyState === 1) this.write(record, { type: "leave" });
  }

  /** Opens a fresh socket, fencing every callback of the one it replaces. */
  private dial(): void {
    if (this.dead) return;
    this.liveness.clear();
    this.backoff.cancel();

    // Fence every callback from the prior socket before asking it to close. Native close
    // events may arrive after the replacement has already opened.
    const previousSocket = this.socket;
    this.socket = null;
    previousSocket?.close(1000);

    this.connectionState.session = null;
    this.observerSent = false;
    this.observerAdmitted = false;
    const phase: TransportPhase = this.backoff.attempts === 0 ? "connecting" : "reconnecting";
    for (const record of this.channels.values()) {
      this.clearInit(record);
      record.rejoin.cancel();
      record.sent = false;
      record.sink.transportPhase(phase);
    }
    for (const sink of this.observers) sink.transportPhase(phase);
    for (const state of this.streamsById.values()) state.reconnect();

    const socket = this.factory(this.url);
    this.socket = socket;

    socket.onopen = () => {
      if (this.socket !== socket) return;
      // One socket, one admission: a roomless observer authenticates first when present,
      // then every room joins. The server processes these writes in order.
      this.sendObserve();
      for (const record of this.channels.values()) this.sendJoin(record);
      /*
        Subscriptions are presence-class state: they died with the previous socket, so they are
        re-declared here rather than remembered by the server. AFTER the handshake frames,
        because those carry the credential this declaration is authorized against.
      */
      this.declare(
        "subscribe",
        [...this.topics.values()].map((held) => held.ref),
      );
      for (const state of this.streamsById.values()) {
        if (state.status === "closed" || state.status === "refused") continue;
        const { kind, node } = state.options;
        this.writeConnection({
          type: "stream_open",
          subscriptionId: state.subscriptionId,
          kind,
          node,
          ...(state.cursor === undefined ? {} : { cursor: state.cursor }),
        });
      }
      this.liveness.arm(socket);
    };

    socket.onmessage = (event: MessageEvent) => {
      if (this.socket !== socket) return;
      // ANY inbound frame is proof of life, a server ping included — so the deadline is
      // reset here rather than where the pong is written.
      this.liveness.arm(socket);
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
      this.liveness.clear();
      for (const record of this.channels.values()) {
        record.sent = false;
        this.clearInit(record);
        record.rejoin.cancel();
      }
      this.observerSent = false;
      this.observerAdmitted = false;

      // 44xx codes are permanent terminal rejections. Retrying them cannot succeed without
      // changed credentials/input, whereas our own 4002 protocol-healing close must redial.
      const terminalClose =
        event.code !== MALFORMED_FRAME_CLOSE_CODE &&
        event.code >= TERMINAL_CLOSE_CODE_MIN &&
        event.code <= TERMINAL_CLOSE_CODE_MAX;
      if (terminalClose) {
        this.teardown(null, {
          code: event.code,
          reason: boundedCloseReason(event.reason),
        });
        return;
      }
      if (!this.reconnect) {
        this.teardown(null, {
          code: event.code,
          reason: boundedCloseReason(event.reason),
        });
        return;
      }

      this.backoff.schedule();
      for (const state of this.streamsById.values()) state.reconnect();
      for (const record of this.channels.values()) record.sink.transportPhase("reconnecting");
      for (const sink of this.observers) sink.transportPhase("reconnecting");
    };
  }

  /** Demultiplexes one validated frame to the channel that owns it. */
  private route(frame: ServerMessage): void {
    /*
      Connection-level frames address the SOCKET, never a room, so they have no channel to
      be routed to. Liveness is answered here and goes no further; every other category is
      workspace news that EVERY handle on this socket hears. A future category that is not
      handled below stops compiling at `frame.ch`, which no connection frame carries.
     */
    if (frame.type === "ping") {
      /*
        The answer is the whole client half of the liveness scheme, and answering rather
        than asking is the point: a background tab's timers are throttled to roughly one
        firing a minute, so a server reaping on heartbeats the CLIENT generated would close
        tabs that are perfectly alive. Replying to an inbound frame is throttled by nothing.
       */
      if (this.socket?.readyState === 1) this.socket.send(PONG_FRAME);
      return;
    }
    if (frame.type === "observed") {
      this.observerAdmitted = true;
      this.backoff.reset();
      for (const sink of [...this.observers]) sink.observed();
      return;
    }
    if ("subscriptionId" in frame) {
      this.streamsById.get(frame.subscriptionId)?.receive(frame);
      return;
    }
    if (frame.type === "session" || frame.type === "plugins" || frame.type === "event") {
      this.acceptConnectionFrame(frame);
      return;
    }
    const record = this.channels.get(frame.ch);
    if (record === undefined) return; // a frame for a room this tab already released
    if (frame.type === "init" || frame.type === "resync") {
      if (!record.sent) return; // late state for the join abandoned before backoff
      this.clearInit(record);
      record.initialized = true;
      record.initTimeouts = 0;
      this.backoff.reset();
      record.rejoin.cancel();
      if (this.observers.size > 0 && !this.observerAdmitted) {
        // A room init also proves socket admission, but the explicit observe still completes
        // so the server knows this connection may remain roomless.
        this.sendObserve();
      }
      record.rejoin.reset();
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
   * Hands one connection-level frame to every channel on the socket, remembering it when it
   * is STATE. Remembering is what makes a late attach cheap (see `attach`), and fanning out to
   * the channel sinks keeps ONE delivery mechanism: a handle hears connection news exactly the
   * way it hears room frames, with no second listener registry to keep in step.
   *
   * An event is the category that is NOT remembered, and the narrowing below is where that is
   * enforced: replaying the last notification to a handle that attached afterwards would tell
   * it about a change it can already read, which is a backlog with one entry. A third category
   * added to the protocol stops compiling here, in `ConnectionState` and in `route` — three
   * loud errors rather than a silently dropped frame.
   */
  private acceptConnectionFrame(frame: ConnectionFrame): void {
    switch (frame.type) {
      case "session":
        this.connectionState.session = frame;
        break;
      case "plugins":
        this.connectionState.plugins = frame;
        break;
      case "event":
        break;
      default: {
        const exhaustive: never = frame;
        void exhaustive;
      }
    }
    // Snapshot: a sink may release its handle while hearing this.
    for (const record of [...this.channels.values()]) record.sink.connectionFrame(frame);
    for (const sink of [...this.observers]) sink.connectionFrame(frame);
  }

  /**
   * The server dropped ONE room. A 44xx refusal is terminal for that room (the container is
   * gone, the cap is full) and the handle reports it; anything else — an overflowing
   * queue, state past the transport ceiling — heals exactly as a socket close did, by
   * rejoining on backoff while every other room keeps streaming.
   */
  private channelClosed(
    record: ChannelRecord,
    code: number,
    reason: string,
    exhausted = false,
  ): void {
    const terminal =
      exhausted ||
      (code !== MALFORMED_FRAME_CLOSE_CODE &&
        code >= TERMINAL_CLOSE_CODE_MIN &&
        code <= TERMINAL_CLOSE_CODE_MAX);
    this.clearInit(record);
    record.sent = false;
    if (terminal) {
      this.channels.delete(record.id);
      record.rejoin.cancel();
      record.sink.channelClosed(code, reason, true);
      if (this.channels.size === 0 && this.observers.size === 0) this.teardown(1000, null);
      return;
    }
    if (record.rejoin.pending) return;
    record.rejoin.schedule();
    record.sink.channelClosed(code, reason, false);
  }

  /**
   * Retires this connection: closes the socket when a code is given, cancels every timer,
   * unregisters from the pool, and tells whatever channels are left that the transport is
   * gone. A dead connection never dials again — the next `connect()` builds a new one.
   */
  private teardown(closeCode: number | null, failure: ConnectionFailure | null): void {
    if (this.dead) return;
    this.dead = true;
    this.liveness.clear();
    this.backoff.cancel();
    pageWindow()?.removeEventListener("pagehide", this.onPageHide);
    pageWindow()?.removeEventListener("pageshow", this.onPageShow);
    const socket = this.socket;
    this.socket = null;
    if (closeCode !== null) socket?.close(closeCode);
    const orphans = [...this.channels.values()];
    this.channels.clear();
    const observerOrphans = [...this.observers];
    this.observers.clear();
    this.onDead(this);
    for (const state of this.streamsById.values()) {
      state.receive({
        type: "stream_closed",
        subscriptionId: state.subscriptionId,
        reason: failure?.reason ?? "transport closed",
      });
    }
    this.streams.clear();
    this.streamsById.clear();
    for (const record of orphans) {
      record.rejoin.cancel();
      this.clearInit(record);
      record.sink.transportClosed(failure);
    }
    for (const sink of observerOrphans) sink.transportClosed(failure);
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
      options.token,
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

/** Returns a roomless observer on the same pooled transport as every room channel. */
export function acquireObserver(options: AcquireOptions, sink: ObserverSink): PooledObserver {
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
      options.token,
      factory,
      options.reconnect !== false,
      options.backoffCapMs ?? 8000,
      (dead) => {
        if (owned.get(key) === dead) owned.delete(key);
      },
    );
    registry.set(key, connection);
  }
  return connection.attachObserver(sink);
}
