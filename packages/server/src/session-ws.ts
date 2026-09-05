import {
  AUTH_REFUSALS,
  CHANNEL_LIMIT_CLOSE_CODE,
  CLIENT_MESSAGE_TYPES,
  CONNECTION_BODIES,
  CURSOR_MIN_INTERVAL_MS,
  ClientMessageSchema,
  DIAL_PING_INTERVAL_MS,
  GESTURE_MIN_INTERVAL_MS,
  MAX_SESSION_CHANNELS_PER_CONNECTION,
  MAX_SESSION_FRAME_BYTES,
  PROTOCOL_VERSION,
  type ActionDenialRule,
  type ActionOutcome,
  type ClientMessage,
  type ErrorCode,
  type RuntimeDeps,
} from "@manifold/protocol";
import { ServiceError, type AuthService } from "./auth.ts";
import type { EventHub, EventSubscriber } from "./event-hub.ts";
import type { Logger } from "./log.ts";
import type { PluginHost } from "./plugin-host.ts";
import type { Room, RoomManager, RoomTimers } from "./room.ts";
import { SessionChannel, serializeServerMessage, type RawSocket } from "./session-channel.ts";
import type { TerminalBroker } from "./terminal-broker.ts";

type ClassifiedFrame =
  | { kind: "message"; message: ClientMessage }
  | { kind: "unknown_type"; frameType: string }
  | { kind: "malformed"; detail: string };

type CursorUpdate = Extract<ClientMessage, { type: "cursor" }>;
type GestureUpdate = Extract<ClientMessage, { type: "gesture" }>;
type JoinMessage = Extract<ClientMessage, { type: "join" }>;
type SubscriptionUpdate = Extract<ClientMessage, { type: "subscribe" | "unsubscribe" }>;

const KNOWN_CLIENT_TYPES: Readonly<Record<string, true>> = Object.fromEntries(
  CLIENT_MESSAGE_TYPES.map((type): [string, true] => [type, true]),
);

const RESYNC_MIN_INTERVAL_MS = 1_000;
const JOIN_DEADLINE_MS = 10_000;

/**
 * Connection-level liveness probe; it belongs to the socket, so it carries no channel.
 * The SERVER asks and the client answers — the same orientation every other dial uses,
 * and the only one a throttled background tab can honour (see `DIAL_PING_INTERVAL_MS`).
 */
const PING_FRAME = JSON.stringify({ type: "ping" });

/**
 * How a denial reads on a socket. The action door's five rungs are the workspace's refusal
 * vocabulary and the session channel's error codes are the socket's; this is the one place
 * they meet, keyed by the rung union so a new rung cannot compile without an answer here.
 *
 * `unknown_action` and `plugin_disabled` both land on `forbidden` because from a client's
 * seat they are the same fact — this workspace will not do that right now — and that is the
 * code the gateway has always sent for a refused creation. An `invalid_args` is a malformed
 * request, and a handler's `refused` is a policy conflict, which is exactly what the broker's
 * own `conflict` has always meant.
 */
const DENIAL_ERROR_CODES: Readonly<Record<ActionDenialRule, ErrorCode>> = {
  unknown_action: "forbidden",
  plugin_disabled: "forbidden",
  forbidden: "forbidden",
  invalid_args: "invalid",
  refused: "conflict",
};

/**
 * Which frames a spectator channel may send. Reading is the whole point of a watching
 * channel, so state, doc updates, terminal output and the attach/detach subscription pair
 * all flow to it — but every mutation is refused, so a portal's live preview can never
 * type into a PTY, resize it, move an element, or fake presence. The map is keyed by the
 * frame union itself: a new client frame cannot compile without declaring its answer.
 *
 * The event plane's pair is `true` for the same reason `terminal_attach` is: subscribing is a
 * READ, answered by the same `containers:read` grant a spectator already had to hold to be
 * watching at all, and the hub re-asks it per topic. (They never reach this table in
 * practice — a connection-level frame routes before channel dispatch — but the table is keyed
 * by the union, so the answer is stated rather than left to routing order.)
 */
const SPECTATOR_MAY_SEND: Readonly<Record<ClientMessage["type"], boolean>> = {
  // A duplicate join closes the socket either way; the read-only refusal must not mask it.
  join: true,
  leave: true,
  resync_request: true,
  pong: true,
  subscribe: true,
  unsubscribe: true,
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
interface ChannelState {
  readonly peer: SessionChannel;
  readonly room: Room;
  lastResyncAt: number | null;
  cancelResyncFlush: (() => void) | null;
  lastCursorAt: number | null;
  pendingCursor: CursorUpdate | null;
  cancelCursorFlush: (() => void) | null;
  lastGestureAt: number | null;
  pendingGesture: GestureUpdate | null;
  cancelGestureFlush: (() => void) | null;
  /**
   * The container this channel's carry was last PROJECTED into — a room other than its
   * own, named by the aim (issue #66). Remembered because the frames that must retire a
   * projection are precisely the ones that cannot name it: an `end` frame carries no aim,
   * and an aim that moves to another container says nothing about the one it left.
   */
  aimedContainerId: string | null;
}

interface SessionConnection {
  readonly socket: RawSocket;
  /** Bun's socket id; it prefixes every membership's `selfConnId`. */
  readonly id: string;
  /** Channel id → its room membership. Insertion ordered, which the drain rotation uses. */
  readonly channels: Map<string, ChannelState>;
  /** Rotates the drain start so a chatty room cannot monopolize socket buffer space. */
  drainCursor: number;
  /**
   * Stamps a fresh `selfConnId` on every join. A room membership is what attendance,
   * cursor echo-suppression, and the broker's viewer registry are keyed by, so a channel
   * rejoining the SAME socket (a role swap) must never reuse the identity of the
   * membership it replaced.
   */
  nextPeerSeq: number;
  /**
   * The socket's event-plane identity, seated on its FIRST successful join and never
   * re-seated. Subscriptions are the socket's, not a channel's — a topic is a NODE, and a
   * client watching the machine roster or a terminal in a container it never joined has no
   * channel to hang the interest on — but the credential they are authorized against can only
   * arrive with a join, which is why this is null until then and why a `subscribe` before the
   * first join is refused by the handshake rule that refuses everything else.
   *
   * Never re-seated because a socket carries ONE credential's channels by construction (the
   * SDK pools by token), and in the case that convention is broken the first join's context is
   * the conservative choice: it can only be equal or NARROWER than a later join's authority,
   * never wider, and it is a credential this socket demonstrably authenticated. A revoked
   * credential closes the whole socket (`revokePrincipal`), so it cannot outlive its grant.
   */
  subscriber: EventSubscriber | null;
  cancelJoinTimeout: (() => void) | null;
  /**
   * The liveness watchdog, armed at the first surviving join and never re-armed: a socket
   * that never joined is already governed by the ten-second join deadline, so pinging
   * before then would be a second answer to a question one timer already settles.
   */
  cancelPing: (() => void) | null;
  /** A ping is outstanding; the next tick reaps rather than asking again. */
  awaitingPong: boolean;
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
    private readonly events: EventHub,
  ) {
    this.removeRevocationListener = auth.onRevoked((principalId, containerId) => {
      this.revokePrincipal(principalId, containerId);
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
      subscriber: null,
      cancelJoinTimeout: null,
      cancelPing: null,
      awaitingPong: false,
      closed: false,
    };
    this.armJoinDeadline(connection);
    this.connections.set(id, connection);
    /*
      The roster, before anything else and before any join. It is CONNECTION-level state:
      it describes the workspace's vocabulary rather than any one room, so it is written
      straight to the socket like `ping` and never passes through channel serialization —
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

  /**
   * Arms the next liveness ping; an unanswered previous ping closes the socket, which runs
   * the normal `close(id)` path and releases room, presence and viewer state. Without this
   * a half-open socket (laptop asleep, wifi handoff, a discarded tab) is held open for the
   * lifetime of the process, inflating every presence count that names it (issue #55).
   */
  private schedulePing(connection: SessionConnection): void {
    connection.cancelPing = this.timers.schedule(() => {
      connection.cancelPing = null;
      if (connection.closed) return;
      if (connection.awaitingPong) {
        this.logger.warn("session_liveness_timeout", { connectionId: connection.id });
        connection.socket.close(4008, "liveness timeout");
        return;
      }
      connection.awaitingPong = true;
      connection.socket.send(PING_FRAME);
      this.schedulePing(connection);
    }, DIAL_PING_INTERVAL_MS);
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
        if (message.type === "pong") {
          connection.awaitingPong = false;
          return;
        }
        if (message.type === "join") {
          this.joinChannel(connection, message);
          return;
        }
        if (message.type === "subscribe" || message.type === "unsubscribe") {
          this.routeSubscription(connection, message);
          return;
        }
        const channel = connection.channels.get(message.ch);
        if (channel === undefined) {
          // A frame can legitimately be in flight when the server retires its channel
          // (container deleted, queue overflow). Dropping it keeps that race from killing the
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

  /**
   * Routes the event plane's connection-level pair. It lands HERE rather than in `dispatch`
   * because a topic is a NODE and a node is not a room: these frames carry no `ch` to resolve,
   * and tying a subscription's lifetime to a room membership that has nothing to do with it is
   * exactly the id pun the frame grammar keeps connection-level frames out of.
   *
   * Neither frame is answered. The hub subscribes the topics this credential may read and
   * declines the rest silently (ADR 0012): a per-topic refusal would turn the plane into an
   * oracle answering "does this node exist and may I read it" one probe at a time, and a
   * client learns its authority from `selfCaps` instead.
   */
  private routeSubscription(connection: SessionConnection, message: SubscriptionUpdate): void {
    const subscriber = connection.subscriber;
    if (subscriber === null) {
      // Unreachable through the grammar — the first frame must be a join and a join that
      // completes seats this — so it is a close rather than a drop: a socket that got here
      // is speaking a protocol this server does not have.
      connection.socket.close(4002, "subscribe before join");
      return;
    }
    if (message.type === "subscribe") {
      this.events.subscribe(subscriber, message.topics);
      return;
    }
    this.events.unsubscribe(subscriber.id, message.topics);
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
   * channel, so a portal pointing at a deleted container never takes a tab down with it.
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
      /*
        THE REFUSAL CLASS, RELAYED VERBATIM (ADR 0019 §2). `AUTH_REFUSALS` is the closed set
        of words a credential refusal can be, and the close reason is where a lens reads it:
        `expired` says "come back with a fresh credential", `revoked` says "stop asking", and
        anything else is the generic `forbidden` this line has always sent. Re-spelling the
        words here — or mapping `expired` onto `forbidden` because the branch predates it —
        would put the whole point of naming the class behind a translation nobody maintains.
       */
      if (error instanceof ServiceError && error.code === "forbidden") {
        const named: readonly string[] = AUTH_REFUSALS;
        connection.socket.close(4403, named.includes(error.message) ? error.message : "forbidden");
      } else {
        connection.socket.close(4401, "unauthorized");
      }
      return;
    }
    if (!this.auth.allows(context, "containers:read", message.containerId)) {
      connection.socket.close(4403, "forbidden");
      return;
    }
    if (connection.channels.size >= MAX_SESSION_CHANNELS_PER_CONNECTION) {
      this.logger.warn("session_channel_limit", { containerId: message.containerId });
      this.refuseChannel(connection, message.ch, CHANNEL_LIMIT_CLOSE_CODE, "channel limit reached");
      return;
    }
    const room = this.rooms.get(message.containerId);
    if (room === null) {
      this.refuseChannel(connection, message.ch, 4404, "container not found");
      return;
    }
    this.broker.pruneExitedUnhomedForContainer(message.containerId);

    connection.cancelJoinTimeout?.();
    connection.cancelJoinTimeout = null;
    // Liveness starts where the join deadline stops governing: the ten-second deadline is
    // the whole answer for a socket holding no rooms, and this watchdog is the answer for
    // one that holds them (issue #55). Armed once — a second room on this socket is not a
    // second transport.
    if (connection.cancelPing === null) this.schedulePing(connection);
    // THE EVENT-PLANE SEAT, taken once per socket at the first join that survives every
    // refusal above. `context` is what the hub discharges every subscribe and every delivery
    // against; the closure is the only thing the hub ever learns about a WebSocket.
    connection.subscriber ??= {
      id: connection.id,
      auth: context,
      deliver: (frame) => {
        if (!connection.closed) connection.socket.send(frame);
      },
    };
    const peer = new SessionChannel(
      `${connection.id}.${(connection.nextPeerSeq += 1)}`,
      connection.socket,
      context,
      message.containerId,
      message.ch,
      message.spectator === true,
      (closing) => {
        this.retireChannel(connection, closing);
      },
    );
    const channel: ChannelState = {
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
      aimedContainerId: null,
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
  private retireChannel(connection: SessionConnection, peer: SessionChannel): void {
    if (connection.channels.get(peer.channel)?.peer !== peer) return;
    this.releaseChannel(connection, peer.channel);
  }

  /**
   * Relays immediately when the cadence is open, otherwise retains exactly the newest
   * cursor and flushes it at the boundary. This preserves latest-wins without flooding.
   */
  private relayCursor(
    connection: SessionConnection,
    channel: ChannelState,
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
    channel: ChannelState,
    gesture: GestureUpdate,
  ): void {
    const now = this.runtime.now();
    if (gesture.phase === "end") {
      channel.cancelGestureFlush?.();
      channel.cancelGestureFlush = null;
      channel.pendingGesture = null;
      channel.lastGestureAt = now;
      this.deliverGesture(channel, gesture);
      return;
    }

    const elapsed =
      channel.lastGestureAt === null ? GESTURE_MIN_INTERVAL_MS : now - channel.lastGestureAt;
    if (elapsed >= GESTURE_MIN_INTERVAL_MS) {
      channel.cancelGestureFlush?.();
      channel.cancelGestureFlush = null;
      channel.pendingGesture = null;
      channel.lastGestureAt = now;
      this.deliverGesture(channel, gesture);
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
      this.deliverGesture(channel, pending);
    }, GESTURE_MIN_INTERVAL_MS - elapsed);
  }

  /**
   * EVERY ROOM ONE GESTURE FRAME ADDRESSES.
   *
   * A gesture belongs to the room it happens in, and for `move`, `resize` and `draw` that
   * is the whole story. A CARRY also names the container its aim would land in, and that
   * container is frequently a different room: a tile dragged over a portal streams through
   * the CANVAS's room while the split it previews lands in the portal's container, so a
   * collaborator sitting in that container's own fullscreen view — staring at the very
   * tree about to change — received nothing at all. The client half of this ships as the
   * portal's own socket feed, which fixes the direction where the viewer happens to hold a
   * socket per container; this is the direction that cannot be fixed from a client, and
   * without it `CarryAim.containerId` addressed a container the transport could not reach.
   *
   * READ AUTHORITY ON THE AIMED CONTAINER IS THE BAR, and it is exactly the right one: it
   * is what opening that container's view costs, so a peer may only project an aim into a
   * room it could have joined outright, and a forged `containerId` reaches nobody. Only
   * RESIDENT rooms are addressed — a preview is never a reason to load a document.
   *
   * The PREVIOUS projection is fanned too whenever it differs, because the frame that must
   * retire a projection is the one that stopped naming it: an `end` frame carries no aim
   * at all, and an aim that moved to another container says nothing about the one it left.
   * Both would otherwise sit until the receiving side's aim TTL swept them.
   */
  private deliverGesture(channel: ChannelState, gesture: GestureUpdate): void {
    channel.room.relayGesture(channel.peer, gesture);
    const aimed = gesture.carry?.aim?.containerId ?? null;
    const projected =
      gesture.phase === "end" || aimed === null || aimed === channel.peer.containerId
        ? null
        : aimed;
    const previous = channel.aimedContainerId;
    channel.aimedContainerId = projected;
    if (projected === null && previous === null) return;
    for (const containerId of new Set([projected, previous])) {
      if (containerId === null) continue;
      if (!this.auth.allows(channel.peer.auth, "containers:read", containerId)) continue;
      this.rooms.live(containerId)?.relayGesture(channel.peer, gesture, true);
    }
  }

  /** Applies one cadence gate to explicit requests and automatic epoch-mismatch recovery. */
  private sendResyncIfDue(connection: SessionConnection, channel: ChannelState): void {
    const now = this.runtime.now();
    const elapsed =
      channel.lastResyncAt === null ? RESYNC_MIN_INTERVAL_MS : now - channel.lastResyncAt;
    if (elapsed >= RESYNC_MIN_INTERVAL_MS) {
      channel.cancelResyncFlush?.();
      channel.cancelResyncFlush = null;
      channel.lastResyncAt = now;
      this.broker.pruneExitedUnhomedForContainer(channel.peer.containerId);
      channel.room.sendResync(channel.peer);
      return;
    }

    if (channel.cancelResyncFlush !== null) return;
    channel.cancelResyncFlush = this.timers.schedule(() => {
      channel.cancelResyncFlush = null;
      if (connection.closed) return;
      if (connection.channels.get(channel.peer.channel) !== channel) return;
      channel.lastResyncAt = this.runtime.now();
      this.broker.pruneExitedUnhomedForContainer(channel.peer.containerId);
      channel.room.sendResync(channel.peer);
    }, RESYNC_MIN_INTERVAL_MS - elapsed);
  }

  /**
   * Asks the action door a POLICY question on behalf of a socket, and answers the socket in
   * its own vocabulary. Two things make this the whole bridge between the planes:
   *
   * - the denial travels back as the error frame the client already handles — same shape,
   *   same `ref` correlation, and now the ladder's own message, so a refused terminal reads
   *   the same whether it was refused over HTTP or over the wire;
   * - it resolves to whether the caller may PROCEED, so a frame whose effect is still floor
   *   work (a create) runs that work in the continuation, and a frame whose effect the
   *   action itself performs (a kill) simply ignores the answer.
   *
   * A dispatch that THREW is a broken door rather than a denial: the host has already logged
   * it, and the socket is told the request failed instead of being left waiting forever.
   *
   * The CONNECTION comes in beside the channel so the ledger can say where the exercise
   * arrived: a trace's `session` is the socket, not the room membership, because one socket
   * is one session and its channels are memberships within it (axiom A6, ADR 0018 §2).
   */
  private async dispatchPolicy(
    connection: SessionConnection,
    peer: SessionChannel,
    action: string,
    ref: string,
    args: Record<string, unknown>,
  ): Promise<boolean> {
    let outcome: ActionOutcome;
    try {
      outcome = await this.plugins.dispatch(peer.auth, action, args, connection.id);
    } catch {
      peer.send({ type: "error", code: "conflict", message: `${action} failed`, ref });
      return false;
    }
    if (outcome.ok) return true;
    peer.send({
      type: "error",
      code: DENIAL_ERROR_CODES[outcome.denial.rule],
      message: outcome.denial.message,
      ref,
    });
    return false;
  }

  /**
   * THE scene-write gate, asked in one place for both frames that carry a scene write.
   * `doc_update` and `gesture` are the same authorization question — may this principal change
   * what this container looks like — and they carried the same refusal twice, which is one edit
   * away from two different answers to one question. Resolves to whether the caller may
   * PROCEED, exactly as {@link dispatchPolicy} does, and refuses in the vocabulary the client
   * already handles.
   */
  private mayWriteScene(peer: SessionChannel): boolean {
    if (this.auth.allows(peer.auth, "scenes:write", peer.containerId)) return true;
    peer.send({ type: "error", code: "forbidden", message: "scenes:write capability required" });
    return false;
  }

  private dispatch(
    connection: SessionConnection,
    channel: ChannelState,
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
      case "pong":
      case "subscribe":
      case "unsubscribe":
        // Routed before dispatch: join creates channels, and the three connection-level frames
        // address the socket, so none of them has a channel for this switch to apply it to.
        return;
      case "leave":
        this.releaseChannel(connection, message.ch);
        return;
      case "doc_update":
        if (!this.mayWriteScene(peer)) return;
        room.applyDocUpdate(peer, message.update);
        return;
      case "gesture":
        if (!this.mayWriteScene(peer)) return;
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
        /*
          POLICY THROUGH THE LADDER. Whether a terminal may be born here, now, by this
          principal — and running WHAT — is `core.terminals`' question, and it is asked
          exactly the way every other caller asks it: one dispatch, one denial vocabulary,
          one log line. The transport keeps moving bytes and stops knowing why: the PTY
          itself is born afterwards, on this channel, because a create is a round trip whose
          reply is socket traffic (ADR 0013 — terminal policy is a plugin, terminal bytes are
          floor).

          The program and env go to the door FROM THIS FRAME, and the broker receives the
          same frame only once the door allowed: one value, read at one place, judged before
          anything is minted or sent (issue #192). A door that never saw the program would be
          authorizing "a shell" while the machine was asked for something else, which is the
          gap the door's input closes. `cwd` stays the transport's: it is where the shell
          starts, never what runs.

          Creation dies with the plugin and cleanup does not, and now that is a property of
          the ROSTER rather than of this file: `open` is an ordinary action, so a disabled
          plugin refuses it at rung 2, while `kill` is declared `cleanup` and outlives the
          disable — nobody is locked out of removing what already exists (D12).
         */
        void this.dispatchPolicy(connection, peer, "core.terminals.open", message.elementId, {
          containerId: peer.containerId,
          elementId: message.elementId,
          cols: message.cols,
          rows: message.rows,
          ...(message.machineId === undefined ? {} : { machineId: message.machineId }),
          ...(message.placement === undefined ? {} : { placement: message.placement }),
          ...(message.program === undefined ? {} : { program: message.program }),
          ...(message.env === undefined ? {} : { env: message.env }),
        }).then((allowed) => {
          if (allowed) this.broker.open(peer, message);
        });
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
        // The LEASE is policy and the TRANSFER is transport, so this frame has `open`'s shape
        // rather than `kill`'s: `core.terminals.take` answers whether this principal may hold
        // the terminal, and the broker moves the lease and announces it afterwards, because a
        // lease belongs to a connection and the `controller_changed` broadcast goes to the room
        // that connection is joined to. The broker no longer decides anything about authority.
        void this.dispatchPolicy(connection, peer, "core.terminals.take", message.terminalId, {
          terminalId: message.terminalId,
        }).then((allowed) => {
          if (allowed) this.broker.take(peer, message);
        });
        return;
      case "terminal_kill":
        // The kill is the ACTION's, whole: authority, the lease rule and the destruction all
        // live behind one door, so this frame and the workspace index cannot answer
        // differently about the same terminal (invariant 14).
        void this.dispatchPolicy(connection, peer, "core.terminals.kill", message.terminalId, {
          terminalId: message.terminalId,
        });
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

  /**
   * Cleans every channel's room/presence/viewer state after a socket closes — and every
   * subscription it held. Subscriptions are presence-class: the socket dying IS their expiry,
   * so there is nothing to persist, nothing on a timer, and no reconnect that resumes them.
   */
  close(id: string): void {
    const connection = this.connections.get(id);
    if (connection === undefined) return;
    this.connections.delete(id);
    connection.closed = true;
    connection.cancelJoinTimeout?.();
    connection.cancelJoinTimeout = null;
    connection.cancelPing?.();
    connection.cancelPing = null;
    for (const ch of [...connection.channels.keys()]) this.releaseChannel(connection, ch);
    connection.subscriber = null;
    this.events.release(id);
  }

  /**
   * Fences every live tab belonging to a newly revoked principal. A connection carries
   * one credential's channels (the SDK pools by token), and a dead credential
   * invalidates all of them, so this is a socket-level close by nature.
   */
  revokePrincipal(principalId: string, containerId: string | null = null): void {
    for (const [id, connection] of [...this.connections]) {
      let fenced = false;
      for (const channel of connection.channels.values()) {
        const peer = channel.peer;
        if (peer.auth.principal.id !== principalId) continue;
        if (containerId !== null && peer.auth.containerScope !== containerId) continue;
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
