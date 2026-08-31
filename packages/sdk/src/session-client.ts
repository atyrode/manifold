import {
  ActionOutcomeSchema,
  BootstrapPrincipalRequestSchema,
  ClientMessageBodySchema,
  HttpErrorSchema,
  MAX_DOC_UPDATE_BYTES,
  MachinesResponseSchema,
  MintTokenRequestSchema,
  PROTOCOL_VERSION,
  AttendanceResponseSchema,
  ContainerResponseSchema,
  ContainerTerminalsResponseSchema,
  IndexResponseSchema,
  PlaceRequestSchema,
  PlaceResponseSchema,
  RevokeRequestSchema,
  RevokeResultSchema,
  TerminalsResponseSchema,
  TokenGrantSchema,
  placementContainerFor,
  placementRefusalRule,
  topicMatches,
  type ActionDenial,
  type ActionOutcome,
  type BootstrapPrincipalRequest,
  type Cap,
  type ClientMessageBody,
  type Gesture,
  type MachineSummary,
  type MintTokenRequest,
  type Container,
  type Attendance,
  type ContainerTerminalSummary,
  type IndexEntry,
  type ManifoldRef,
  type PlaceResponse,
  type PlacementDenial,
  type PlacementDestination,
  type PlacementRef,
  type PluginRoster,
  type PresencePayload,
  type PresenceState,
  type Principal,
  type RevokeResult,
  type SceneElement,
  type ServerEvent,
  type ServerMessageBody,
  type TerminalInfo,
  type TerminalSummary,
  type TileLayout,
  type TokenGrant,
} from "@manifold/protocol";
import {
  LOCAL_ORIGIN,
  Y,
  REMOTE_ORIGIN,
  changedElementIds,
  createSceneDoc,
  decodeUpdate,
  elementText as sceneElementText,
  elementsMap,
  encodeUpdate,
  layoutMap,
  nextZIndex,
  patchElement,
  readElement,
  readTileLayout,
  removeElement,
  setTileRatios as sceneSetTileRatios,
  writeElement,
  type ScenePatch,
} from "@manifold/scene";
import { bytesToBase64, textToBase64 } from "./base64.ts";
import {
  acquireChannel,
  type ChannelFrame,
  type ConnectionFrame,
  type JoinBody,
  type PooledChannel,
} from "./connection-pool.ts";

/**
 * THE per-room session client. Browsers, tests, and tools all speak to the server
 * through this state machine — never through a second WebSocket implementation (AGENTS.md
 * invariant). It owns everything a ROOM means: the join handshake, epoch/rev tracking,
 * gap-triggered resync, optimistic local reconciliation, offline-edit rebase, and the
 * terminal subscription refcounts.
 *
 * What it no longer owns is the SOCKET. Since v12 the transport is multiplexed: this
 * client is a channel handle on a pooled connection keyed by (url, token), so a tab
 * rendering a canvas plus five portal portals holds ONE TCP connection with six channels.
 * The public ref is unchanged — construct one per room, `connect()`, subscribe — and
 * reconnect, keepalive, and rejoin-every-channel live one layer down in
 * `connection-pool.ts`.
 *
 * Some of its ref is WORKSPACE-level rather than room-level: the action door
 * (`action`), the workspace reads (`machines`, `index`, `attendance`, `terminalsByContainer`,
 * `terminals`), and the plugin roster (`onPlugins`). A plugin holds only this client, so
 * the questions it asks the workspace arrive through the same handle — over HTTP and the
 * connection-level frame category, never over a room channel.
 */

export type ConnectionStatus = "idle" | "connecting" | "open" | "reconnecting" | "closed";

/**
 * Subscribers see channel-agnostic BODIES: a handle already knows which room it is, so
 * making every listener carry a routing id would be noise. Wire frames satisfy these
 * types structurally, which is why nothing downstream had to change for v12.
 */
type ServerMessageOf<T extends ServerMessageBody["type"]> = Extract<ServerMessageBody, { type: T }>;

export interface SceneTx {
  /**
   * Authors one element. `collaborative` names the PAYLOAD fields the document should hold as
   * shared text rather than as plain values, and the author is the only party that knows: the
   * protocol's element schema is a neutral envelope (ADR 0013 §16), so the SDK carries a record
   * it does not interpret. Omitting it means "this record has no collaborative field", which is
   * the truth for every kind but one.
   */
  create(element: SceneElement, collaborative?: readonly string[]): void;
  patch(id: string, patch: ScenePatch): boolean;
  remove(id: string): boolean;
  text(id: string): Y.Text | null;
  nextZIndex(): number;
}

export interface SessionEvents {
  /** Server messages, by type. */
  message: (msg: ServerMessageBody) => void;
  status: (status: ConnectionStatus) => void;
  /** Scene document was replaced after an epoch change or full state adoption. */
  scene_reset: () => void;
  /** Validated element projections changed inside the Yjs document. */
  elements_changed: (ids: readonly string[], origin: "local" | "remote" | "undo") => void;
  /**
   * A composition's layout tree changed. The tree is small and read whole, so
   * subscribers re-read `layout()` rather than diffing tile ids.
   */
  layout_changed: (origin: "local" | "remote" | "undo") => void;
  attendance_changed: () => void;
  terminals_changed: () => void;
  /**
   * The workspace's plugin roster arrived (socket open) or changed (an enable/disable).
   * It is connection-level news, not room traffic, so it never reaches `message`.
   * Subscribe through `onPlugins`, which replays the last one it heard.
   */
  plugins_changed: (roster: PluginRoster) => void;
}

/**
 * One live subscription on this handle: the nodes it named, the handler that hears them, and
 * the pool-level refcount release — null while this handle holds no channel, because a
 * subscription outlives the sockets that carry it while a refcount cannot.
 */
interface TopicSubscription {
  readonly topics: readonly ManifoldRef[];
  readonly handler: (event: ServerEvent) => void;
  release: (() => void) | null;
}

type EventKey = ChannelFrame["type"] | keyof SessionEvents;
type Handler = (...args: never[]) => void;

/**
 * What `place()` answers: the placement it executed, or the declared RULE that refused
 * it. A refusal is data — never an exception — because a client renders it.
 */
export type PlaceOutcome =
  | { readonly ok: true; readonly result: PlaceResponse }
  | { readonly ok: false; readonly denial: PlacementDenial };

/**
 * What an access door answers: the thing it issued, or the denial that refused it. Same
 * shape as `PlaceOutcome` and for the same reason — a caller renders a refusal, and a
 * refused delegation is an answer rather than a broken call.
 */
export type AccessOutcome<T> =
  { readonly ok: true; readonly result: T } | { readonly ok: false; readonly denial: ActionDenial };

export interface SessionClientOptions {
  /** ws(s) URL of the terminal endpoint, e.g. ws://localhost:7777/ws/session */
  url: string;
  containerId: string;
  token: string;
  /**
   * Joins as a spectator: this channel watches the room (state, doc updates, terminal
   * output) without occupying it. It is absent from the roster and from container presence,
   * and the server rejects any write it sends. Live previews of a container use it;
   * anything a user acts in does not.
   */
  spectator?: boolean;
  /**
   * Reconnect on unexpected close (default true). Reconnect belongs to the shared
   * CONNECTION, so the first client to open a given (url, token) transport sets it.
   */
  reconnect?: boolean;
  /**
   * DI call ref for tests. It is also part of the pool key: two clients sharing a factory
   * (and url and token) share one socket, while a test handing each client its own
   * socket double keeps them genuinely separate.
   */
  webSocketFactory?: (url: string) => WebSocket;
  /** Backoff schedule cap in ms (default 8000); a connection-level policy. */
  backoffCapMs?: number;
  /**
   * HTTP origin for placement writes; defaults to the origin `url` implies (same host,
   * ws(s) mapped to http(s)), which is what a same-origin deployment wants.
   */
  apiUrl?: string;
}

const OUTBOX_LIMIT = 256;

export class SessionClient {
  readonly attendance = new Map<string, PresenceState>();
  readonly terminals = new Map<string, TerminalInfo>();
  private readonly elementsState = new Map<string, SceneElement>();
  readonly elements: ReadonlyMap<string, SceneElement> = this.elementsState;
  /** Live view refcounts per attached terminal (see attachTerminal). */
  private readonly attachCounts = new Map<string, number>();
  epoch = "";
  rev = 0;
  self: Principal | null = null;
  selfConnId: string | null = null;
  private selfCapsState: readonly Cap[] = [];
  status: ConnectionStatus = "idle";

  private readonly opts: Required<Pick<SessionClientOptions, "url" | "containerId" | "token">> &
    SessionClientOptions;
  /** This room's channel on the shared socket; null before connect and after close. */
  private channel: PooledChannel | null = null;
  private listeners = new Map<EventKey, Set<Handler>>();
  private outbox: ClientMessageBody[] = [];
  private closeError: Error | null = null;
  /**
   * The last plugin roster this connection delivered, replayed to every late `onPlugins`
   * subscriber. A roster is workspace state, so the newest one is the whole truth.
   */
  private pluginRoster: PluginRoster | null = null;
  /**
   * Live event subscriptions. A Set rather than a keyed table: two callers may name the same
   * node for different reasons, and each holds its own release — so identity is the record
   * itself, never the topics it happens to share.
   */
  private readonly subscriptions = new Set<TopicSubscription>();
  private currentDoc = createSceneDoc();
  private undoManager!: Y.UndoManager;
  private hasLocalEdits = false;

  constructor(opts: SessionClientOptions) {
    this.opts = opts;
    this.installDoc(this.currentDoc);
  }

  /**
   * The pooled connection carrying this room, or null before `connect()`. Two handles
   * reporting the same id ARE sharing one socket — the multiplex invariant, observable
   * without reaching into the transport.
   */
  get transportId(): string | null {
    return this.channel?.transportId ?? null;
  }

  /** This room's channel id on that connection; it appears in every frame it exchanges. */
  get channelId(): string | null {
    return this.channel?.id ?? null;
  }

  /**
   * The joining principal's granted caps, as the last init/resync reported them — empty
   * until the first one lands. A method rather than a field because it is an ANSWER a
   * caller may hold across reconnects (a plugin gating its affordances asks again), and
   * because the plugin engine's `SessionHandle` is a method-only ref.
   */
  selfCaps(): readonly Cap[] {
    return this.selfCapsState;
  }

  private installDoc(doc: Y.Doc): void {
    const map = elementsMap(doc);
    this.undoManager = new Y.UndoManager(map, {
      trackedOrigins: new Set([LOCAL_ORIGIN]),
      captureTimeout: 400,
    });
    map.observeDeep((events, transaction) => {
      const ids = changedElementIds(events as unknown as readonly Y.YEvent<never>[]);
      for (const id of ids) {
        const element = readElement(doc, id);
        if (element === null) this.elementsState.delete(id);
        else this.elementsState.set(id, element);
      }
      if (ids.length > 0) this.emit("elements_changed", ids, this.classifyOrigin(transaction));
    });
    // Canvas containers never write tiles, so this observer stays silent for them and
    // a composition needs no second subscription path.
    layoutMap(doc).observeDeep((_events, transaction) => {
      this.emit("layout_changed", this.classifyOrigin(transaction));
    });
    doc.on("update", (update, origin) => {
      if (origin === REMOTE_ORIGIN) return;
      this.hasLocalEdits = true;
      this.send({ type: "doc_update", update: encodeUpdate(update) });
    });
  }

  /** Both projection observers report provenance the same way. */
  private classifyOrigin(transaction: Y.Transaction): "local" | "remote" | "undo" {
    if (transaction.origin === LOCAL_ORIGIN) return "local";
    if (transaction.origin === this.undoManager) return "undo";
    return "remote";
  }

  private replaceDoc(): void {
    this.currentDoc.destroy();
    this.elementsState.clear();
    this.currentDoc = createSceneDoc();
    this.installDoc(this.currentDoc);
  }

  // ------------------------------------------------------------------ events

  on<T extends ServerMessageBody["type"]>(
    type: T,
    fn: (msg: ServerMessageOf<T>) => void,
  ): () => void;
  on<K extends keyof SessionEvents>(type: K, fn: SessionEvents[K]): () => void;
  on(type: EventKey, fn: Handler): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn);
    return () => set.delete(fn);
  }

  /**
   * One listener's failure must never starve its siblings: document state advances
   * before projection events are emitted. Errors remain observable without propagating
   * into the Yjs transaction or starving later listeners.
   */
  private emit(type: EventKey, ...args: unknown[]): void {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        (fn as (...a: unknown[]) => void)(...args);
      } catch (error) {
        console.error("evt=terminal_listener_failed", type, error);
      }
    }
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.emit("status", status);
  }

  // ------------------------------------------------------------------ lifecycle

  /**
   * Resolves on the first successful init; reconnects keep running afterwards. Calling it
   * on a handle that already holds a channel is an explicit "reconnect now": the shared
   * transport redials and every room on it rejoins.
   */
  connect(): Promise<void> {
    this.closeError = null;
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const offInit = this.on("init", () => {
      offInit();
      offStatus();
      resolve();
    });
    const offStatus = this.on("status", (s: ConnectionStatus) => {
      if (s === "closed") {
        offStatus();
        offInit();
        reject(this.closeError ?? new Error("terminal closed before init"));
      }
    });
    if (this.channel === null) this.attach();
    else this.channel.redial();
    return promise;
  }

  close(): void {
    this.closeError = null;
    const channel = this.channel;
    this.channel = null;
    // Subscriptions are refcounted on the SOCKET, which may outlive this room: dropping this
    // handle's share is what keeps a sibling's subscription alive and this one's from leaking.
    for (const record of this.subscriptions) {
      record.release?.();
      record.release = null;
    }
    // Releasing is the whole story: it leaves this room and, when this was the tab's last
    // room, closes the socket — a close IS a leave, so no extra frame is spent.
    channel?.release();
    this.setStatus("closed");
  }

  /** The join THIS room wants, rebuilt per attempt so resume hints are current. */
  private joinBody(): JoinBody {
    return {
      type: "join",
      containerId: this.opts.containerId,
      token: this.opts.token,
      protocolVersion: PROTOCOL_VERSION,
      // Omitted rather than sent as false: the flag's absence IS the occupant case, and
      // every join must re-declare it because the server tracks it per channel.
      ...(this.opts.spectator === true ? { spectator: true } : {}),
      ...(this.epoch !== "" ? { lastEpoch: this.epoch, lastRev: this.rev } : {}),
    };
  }

  /** Acquires this room's channel on the pooled connection its (url, token) names. */
  private attach(): void {
    this.channel = acquireChannel(
      {
        url: this.opts.url,
        token: this.opts.token,
        ...(this.opts.reconnect !== undefined ? { reconnect: this.opts.reconnect } : {}),
        ...(this.opts.backoffCapMs !== undefined ? { backoffCapMs: this.opts.backoffCapMs } : {}),
        ...(this.opts.webSocketFactory !== undefined
          ? { webSocketFactory: this.opts.webSocketFactory }
          : {}),
      },
      {
        joinBody: () => this.joinBody(),
        receive: (body) => {
          this.handle(body);
        },
        connectionFrame: (body) => {
          this.handleConnection(body);
        },
        transportPhase: (phase) => {
          this.setStatus(phase);
        },
        channelClosed: (code, reason, terminal) => {
          if (!terminal) {
            // The connection is rejoining this room on backoff; from this handle's point
            // of view that is exactly a reconnect, and its outbox waits for the fresh init.
            this.setStatus("reconnecting");
            return;
          }
          this.forgetSubscriptions();
          this.channel = null;
          this.closeError = new Error(
            reason.trim() === ""
              ? `terminal rejected with close code ${code}`
              : `terminal rejected with close code ${code}: ${reason.trim()}`,
          );
          this.setStatus("closed");
        },
        transportClosed: (error) => {
          this.forgetSubscriptions();
          this.channel = null;
          this.closeError = error;
          this.setStatus("closed");
        },
      },
    );
    // A handle may declare interest before it ever holds a channel, and it holds a NEW one
    // after a terminal close. Either way the declarations go out here, once, against the
    // connection that will carry them; the pool re-declares them on every redial of that
    // socket, so a reconnect is not this layer's business.
    for (const record of this.subscriptions) record.release = this.channel.subscribe(record.topics);
  }

  /**
   * Drops this handle's refcounts WITHOUT withdrawing them on the wire: the connection they
   * were counted on is gone, so there is nothing to tell and nobody to tell it. The
   * subscriptions themselves survive — `attach` re-declares them on the next socket, which is
   * what makes a subscription outlive a transport it never knew about.
   */
  private forgetSubscriptions(): void {
    for (const record of this.subscriptions) record.release = null;
  }

  // ------------------------------------------------------------------ incoming

  /**
   * A frame addressed to the SOCKET this room rides. It never touches epoch/rev, never
   * queues, and never reaches `message`: a roster describes the workspace and an event
   * describes a node, neither of which is this room's traffic, and every handle on the
   * connection hears the same one.
   */
  private handleConnection(body: ConnectionFrame): void {
    switch (body.type) {
      case "plugins":
        this.pluginRoster = body.roster;
        this.emit("plugins_changed", body.roster);
        return;
      case "event":
        this.deliverEvent(body);
        return;
      default: {
        const exhaustive: never = body;
        return exhaustive;
      }
    }
  }

  /**
   * Hands one event to the subscriptions that named its node. The match is
   * `topicMatches` — the protocol's own relation, the same one the server fans out by — so a
   * frame this socket was sent can never fail to find the handler that asked for it.
   *
   * A subscription that named several topics still hears one delivery per event: a handler
   * asked about a set of nodes, not about a set of matches.
   */
  private deliverEvent(event: ServerEvent): void {
    for (const record of [...this.subscriptions]) {
      if (!record.topics.some((topic) => topicMatches(topic, event.topic))) continue;
      try {
        record.handler(event);
      } catch (error) {
        console.error("evt=terminal_listener_failed", "event", error);
      }
    }
  }

  /**
   * THE event-plane door: declares interest in a set of nodes and answers the release.
   *
   * Topics are REFS, never `manifold://` strings — the address is compiler-joined, which is
   * why the topic namespace needs no registry (`REGISTRY.md` §Runtime-joined namespaces). What
   * arrives is a notification: a subscriber that needs the new state READS it, through the
   * same door a fresh client uses, because there is no offset to resume from and nothing is
   * replayed. That is the whole contract, and it is why a feed can trade its timer for a
   * subscription without changing what it does when it wakes up.
   *
   * The wire declaration is refcounted onto the SOCKET one layer down, so two panels watching
   * one container cost one `subscribe`, and neither can cancel the other by releasing first.
   * Subscribing before `connect()` is legal: the declaration goes out with the join.
   */
  subscribe(topics: readonly ManifoldRef[], handler: (event: ServerEvent) => void): () => void {
    const record: TopicSubscription = { topics: [...topics], handler, release: null };
    this.subscriptions.add(record);
    if (this.channel !== null) record.release = this.channel.subscribe(record.topics);
    return () => {
      if (!this.subscriptions.delete(record)) return;
      record.release?.();
      record.release = null;
    };
  }

  /**
   * Subscribes to the workspace's plugin roster and REPLAYS the last one synchronously,
   * so a host mounting after the socket opened renders a composition immediately instead
   * of waiting for the next enable/disable. Returns the unsubscribe.
   */
  onPlugins(fn: (roster: PluginRoster) => void): () => void {
    const off = this.on("plugins_changed", fn);
    if (this.pluginRoster !== null) fn(this.pluginRoster);
    return off;
  }

  private handle(msg: ChannelFrame): void {
    switch (msg.type) {
      case "init":
      case "resync": {
        const previousSelfConnId = this.selfConnId;
        const lineageChanged = this.epoch !== "" && this.epoch !== msg.epoch;
        if (lineageChanged) {
          this.outbox = this.outbox.filter((queued) => queued.type !== "doc_update");
          this.replaceDoc();
        }
        Y.applyUpdate(this.currentDoc, decodeUpdate(msg.doc), REMOTE_ORIGIN);
        this.epoch = msg.epoch;
        this.rev = msg.rev;
        this.self = msg.self;
        this.selfConnId = msg.selfConnId;
        this.selfCapsState = msg.selfCaps;
        this.attendance.clear();
        for (const p of msg.attendance) this.attendance.set(p.principal.id, p);
        this.terminals.clear();
        for (const s of msg.terminals) this.terminals.set(s.id, s);
        this.setStatus("open");
        // Keepalive belongs to the socket, which the pooled connection owns and pings.
        this.flushOutbox();
        if (this.hasLocalEdits) {
          const state = Y.encodeStateAsUpdate(this.currentDoc);
          if (state.byteLength <= MAX_DOC_UPDATE_BYTES) {
            this.send({ type: "doc_update", update: encodeUpdate(state) });
          } else {
            console.error(
              "evt=doc_state_too_large",
              `bytes=${state.byteLength}`,
              `limit=${MAX_DOC_UPDATE_BYTES}`,
            );
          }
        }
        // Re-subscribe views only after a real reconnect: the server's viewer registry is
        // connection-scoped, while a same-connection resync preserves those subscriptions.
        if (previousSelfConnId !== null && previousSelfConnId !== msg.selfConnId) {
          for (const attachedId of this.attachCounts.keys()) {
            if (this.terminals.get(attachedId)?.status === "running") {
              this.send({ type: "terminal_attach", terminalId: attachedId });
            }
          }
        }
        this.emit(msg.type, msg);
        this.emit("scene_reset");
        this.emit("attendance_changed");
        this.emit("terminals_changed");
        break;
      }
      case "doc_update": {
        Y.applyUpdate(this.currentDoc, decodeUpdate(msg.update), REMOTE_ORIGIN);
        this.emit(msg.type, msg);
        break;
      }
      case "attendance": {
        if (msg.joined) this.attendance.set(msg.joined.principal.id, msg.joined);
        if (msg.left) this.attendance.delete(msg.left.principalId);
        this.emit(msg.type, msg);
        this.emit("attendance_changed");
        break;
      }
      case "presence": {
        const entry = this.attendance.get(msg.principalId);
        if (entry) {
          this.attendance.set(msg.principalId, {
            ...entry,
            payload: { ...entry.payload, ...msg.payload },
          });
        }
        this.emit(msg.type, msg);
        this.emit("attendance_changed");
        break;
      }
      case "terminal_opened": {
        this.terminals.set(msg.terminal.id, msg.terminal);
        this.emit(msg.type, msg);
        this.emit("terminals_changed");
        break;
      }
      case "terminal_event": {
        if (msg.kind === "parked") {
          // A departure notice: the terminal is no longer in THIS room, so it is no longer
          // reachable over this channel. It either re-homed into another composition (a
          // merge or an extraction) or it was killed and left every room.
          this.terminals.delete(msg.terminalId);
          this.emit(msg.type, msg);
          this.emit("terminals_changed");
          break;
        }
        const terminal = this.terminals.get(msg.terminalId);
        if (terminal) {
          const next: TerminalInfo = { ...terminal };
          if (msg.kind === "exited") {
            next.status = "exited";
            next.exitCode = msg.exitCode ?? null;
          }
          if (msg.kind === "controller_changed") next.controllerId = msg.controllerId ?? null;
          if (msg.kind === "resized") {
            if (msg.cols !== undefined) next.cols = msg.cols;
            if (msg.rows !== undefined) next.rows = msg.rows;
          }
          if (msg.kind === "renamed") next.name = msg.name ?? null;
          this.terminals.set(msg.terminalId, next);
        }
        this.emit(msg.type, msg);
        this.emit("terminals_changed");
        break;
      }
      case "error": {
        this.emit(msg.type, msg);
        break;
      }
      case "cursor":
      case "gesture":
      case "terminal_snapshot":
      case "terminal_output": {
        this.emit(msg.type, msg);
        break;
      }
      case "saved": {
        this.rev = Math.max(this.rev, msg.rev);
        this.emit(msg.type, msg);
        break;
      }
      default: {
        const _exhaustive: never = msg;
        void _exhaustive;
      }
    }
    this.emit("message", msg);
  }

  // ------------------------------------------------------------------ outgoing

  private send(msg: ClientMessageBody): void {
    if (this.channel !== null && this.channel.isOpen() && this.status === "open") {
      // Development guard: never put an invalid frame on the wire. High-volume binary
      // frame types are constructed entirely by this SDK, so avoid rescanning their payloads.
      if (msg.type !== "cursor" && msg.type !== "doc_update" && msg.type !== "terminal_input") {
        ClientMessageBodySchema.parse(msg);
      }
      this.channel.send(msg);
      return;
    }
    // High-rate ephemera is never worth replaying: a stale cursor or gesture is noise.
    // Liveness is not here at all — the pooled connection owns the socket's ping.
    if (msg.type === "cursor" || msg.type === "gesture") return;
    if (this.outbox.length >= OUTBOX_LIMIT) this.outbox.shift();
    this.outbox.push(msg);
  }

  private flushOutbox(): void {
    const queued = this.outbox;
    this.outbox = [];
    for (const msg of queued) this.send(msg);
  }

  transact(fn: (tx: SceneTx) => void): void {
    this.currentDoc.transact(() => {
      fn({
        create: (element, collaborative) =>
          writeElement(this.currentDoc, element, LOCAL_ORIGIN, collaborative),
        patch: (id, patch) => patchElement(this.currentDoc, id, patch, LOCAL_ORIGIN),
        remove: (id) => removeElement(this.currentDoc, id, LOCAL_ORIGIN),
        text: (id) => sceneElementText(this.currentDoc, id),
        nextZIndex: () => nextZIndex(this.currentDoc),
      });
    }, LOCAL_ORIGIN);
  }

  undo(): void {
    this.undoManager.undo();
  }

  redo(): void {
    this.undoManager.redo();
  }

  elementText(id: string): Y.Text | null {
    return sceneElementText(this.currentDoc, id);
  }

  /**
   * The composition's node table, or null for a canvas — and also for a tree that
   * fails validation, including one that tiles this very container: an unusable tree is
   * never handed to the renderer. Read whole on every `layout_changed`.
   */
  layout(): TileLayout | null {
    return readTileLayout(this.currentDoc, this.opts.containerId);
  }

  /**
   * The only layout mutation the SDK owns: a divider drag is high-frequency and purely
   * geometric. Structural writes (splits, removals, extraction) stay on HTTP so the
   * server can enforce discipline and the composition lifecycle — a leaf that leaves
   * re-homes its terminal, and a composition emptied by the move is retired.
   */
  setTileRatios(splitId: string, ratios: readonly number[]): void {
    sceneSetTileRatios(this.currentDoc, splitId, ratios, LOCAL_ORIGIN);
  }

  /**
   * THE placement call: put an item in a container. One envelope, one verb, and a refusal
   * that names the RULE which refused it — legality lives in the protocol's placement
   * declarations, so a caller never has to know which verb this used to be.
   *
   * It dispatches `core.space.place` (ADR 0013 §14): the algebra is mechanism and stays
   * floor, the verb is a plugin, and there is exactly one door onto "place a thing". This
   * method survives the move because the SHAPE is the contract — callers keep asking for a
   * ref and a destination and keep getting a `PlaceOutcome`.
   *
   * The denial is REBUILT rather than received: the action door's `refused` rung carries one
   * string, which leads with the algebra's own rule, and the two other fields of a
   * `PlacementDenial` are things this caller already holds — it sent the ref, and the
   * container is a total function of the destination. Anything that is NOT a placement rule
   * (a cap the caller lacks, a disabled plugin, a placement that could not be carried out)
   * throws, exactly as the HTTP failures it replaces did.
   */
  async place(ref: PlacementRef, destination: PlacementDestination): Promise<PlaceOutcome> {
    const request = PlaceRequestSchema.parse({ ref, destination });
    const outcome = await this.action("core.space.place", request);
    if (outcome.ok) return { ok: true, result: PlaceResponseSchema.parse(outcome.result) };
    const rule = placementRefusalRule(outcome.denial.message);
    if (rule === null) throw new Error(outcome.denial.message);
    // A denial is an ANSWER, not a failure: the caller renders the rule (and its drag
    // preview already asked `resolvePlacement` the same question locally).
    return {
      ok: false,
      denial: { rule, ref, container: placementContainerFor(destination) },
    };
  }

  /**
   * THE action call: invoke a plugin action by its full `plugin.local` name. A denial is
   * DATA — the rule that refused and its message — exactly like a placement refusal,
   * because a client renders it; only a broken door (non-JSON, an error envelope) throws.
   *
   * HTTP rather than a socket frame for the same reason placement is: an action addresses
   * the WORKSPACE, while this client is joined to one room.
   */
  async action(name: string, args: unknown): Promise<ActionOutcome> {
    const response = await fetch(`${this.apiOrigin()}/api/actions/${encodeURIComponent(name)}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.opts.token}`,
      },
      // An argument-free action still sends an envelope: the door parses a body.
      body: JSON.stringify(args ?? {}),
    });
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`action ${name} returned a non-JSON response (${response.status})`);
    }
    if (response.ok) return ActionOutcomeSchema.parse(payload);
    const failure = HttpErrorSchema.safeParse(payload);
    throw new Error(
      failure.success ? failure.data.error.message : `action ${name} failed (${response.status})`,
    );
  }

  /** The HTTP origin this terminal's socket URL implies; `apiUrl` overrides it. */
  private apiOrigin(): string {
    if (this.opts.apiUrl !== undefined) return this.opts.apiUrl.replace(/\/+$/, "");
    const url = new URL(this.opts.url);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    return url.origin;
  }

  // ---------------------------------------------------------- workspace reads

  /*
    A plugin asks the WORKSPACE these questions — which machines exist, what the index
    holds — and it holds only this client. The reads therefore live here rather than in
    each host's own fetch layer, which is what kept them out of reach of anything but the
    web app: one door per concept.
   */

  /** One authed GET; a non-2xx is a failure, never data — these reads have no denials. */
  private async getJson(path: string): Promise<unknown> {
    const response = await fetch(`${this.apiOrigin()}${path}`, {
      headers: { authorization: `Bearer ${this.opts.token}` },
    });
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`GET ${path} returned a non-JSON response (${response.status})`);
    }
    if (response.ok) return payload;
    const failure = HttpErrorSchema.safeParse(payload);
    throw new Error(
      failure.success ? failure.data.error.message : `GET ${path} failed (${response.status})`,
    );
  }

  /**
   * One authed write to a route that is NOT an action. Exactly one door needs it — leaf
   * removal — and the comment there says why that door is a route.
   */
  private async sendJson(method: string, path: string): Promise<void> {
    const response = await fetch(`${this.apiOrigin()}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.opts.token}` },
    });
    if (response.ok) return;
    const failure = HttpErrorSchema.safeParse(await response.json().catch(() => null));
    throw new Error(
      failure.success
        ? failure.data.error.message
        : `${method} ${path} failed (${String(response.status)})`,
    );
  }

  /** The enrolled machines with live online state (`core.machines.list`). */
  async machines(): Promise<readonly MachineSummary[]> {
    return MachinesResponseSchema.parse(await this.invoke("core.machines.list", {})).machines;
  }

  /** The workspace index — containers and folders in tree order (`core.index.read`). */
  async index(): Promise<readonly IndexEntry[]> {
    return IndexResponseSchema.parse(await this.invoke("core.index.read", {})).items;
  }

  /** Who occupies which container right now (`GET /api/attendance`). */
  async attendanceByContainer(): Promise<readonly Attendance[]> {
    return AttendanceResponseSchema.parse(await this.getJson("/api/attendance")).attendance;
  }

  /** Every container-homed terminal, for per-container counts (`core.terminals.listByContainer`). */
  async terminalsByContainer(): Promise<readonly ContainerTerminalSummary[]> {
    return ContainerTerminalsResponseSchema.parse(
      await this.invoke("core.terminals.listByContainer", {}),
    ).terminals;
  }

  /** Every terminal in the workspace with its home composition (`core.terminals.listAll`). */
  async allTerminals(): Promise<readonly TerminalSummary[]> {
    return TerminalsResponseSchema.parse(await this.invoke("core.terminals.listAll", {})).terminals;
  }

  // --------------------------------------------------------- workspace writes

  /*
    The workspace index's writes, beside its reads for the same reason: the section that
    LISTS containers is the section that renames and deletes them, and it holds only this
    client. Every one of them is now a `core.views` ACTION — the bespoke routes are gone
    (D13) — and each wrapper keeps its name, its arguments and its answer, because a method
    name is a contract with plugin authors while the door behind it is ours to move.
   */

  /**
   * One action as a TYPED WRAPPER calls it: the result on success, a throw carrying the
   * denial's message on refusal. `action` itself keeps denials as DATA, which is right for a
   * caller that renders the rule; these wrappers replaced routes whose refusal was an HTTP
   * error, and every caller of theirs is written around a throw. One shape per call site,
   * chosen by the call site.
   */
  private async invoke(name: string, args: unknown): Promise<unknown> {
    const outcome = await this.action(name, args);
    if (!outcome.ok) throw new Error(outcome.denial.message);
    return outcome.result;
  }

  /** Renames one container (`core.index.renameContainer`). */
  async renameContainer(containerId: string, name: string): Promise<Container> {
    const result = await this.invoke("core.index.renameContainer", { containerId, name });
    return ContainerResponseSchema.parse(result).container;
  }

  /** Retires one container (`core.index.deleteContainer`); the door enforces root authority. */
  async deleteContainer(containerId: string): Promise<void> {
    await this.invoke("core.index.deleteContainer", { containerId });
  }

  /** One container's record (`core.index.readContainer`), for a reference the index has not answered. */
  async getContainer(containerId: string): Promise<Container> {
    const result = await this.invoke("core.index.readContainer", { containerId });
    return ContainerResponseSchema.parse(result).container;
  }

  /**
   * Removes one leaf from a composition (`DELETE /api/containers/:id/tiles/:tileId`). Removal is
   * the one tile gesture that is NOT a placement — nothing accepts "nowhere" for a LEAF — so
   * it keeps its own route while every MOVE of a leaf's occupant goes through `place`.
   */
  async removeContainerTile(containerId: string, tileId: string): Promise<void> {
    await this.sendJson(
      "DELETE",
      `/api/containers/${encodeURIComponent(containerId)}/tiles/${encodeURIComponent(tileId)}`,
    );
  }

  /** Creates an index folder (`core.index.createFolder`); answers the whole new index. */
  async createFolder(name: string, parentId: string | null): Promise<readonly IndexEntry[]> {
    const result = await this.invoke("core.index.createFolder", { name, parentId });
    return IndexResponseSchema.parse(result).items;
  }

  /** Renames an index folder (`core.index.renameFolder`). */
  async renameFolder(folderId: string, name: string): Promise<readonly IndexEntry[]> {
    const result = await this.invoke("core.index.renameFolder", { folderId, name });
    return IndexResponseSchema.parse(result).items;
  }

  /** Deletes an index folder (`core.index.deleteFolder`); its children move up. */
  async deleteFolder(folderId: string): Promise<readonly IndexEntry[]> {
    const result = await this.invoke("core.index.deleteFolder", { folderId });
    return IndexResponseSchema.parse(result).items;
  }

  /** Moves one index item between siblings or into a folder (`core.index.moveEntry`). */
  async moveIndexEntry(
    item: { readonly kind: "container" | "folder"; readonly id: string },
    parentId: string | null,
    index: number,
  ): Promise<readonly IndexEntry[]> {
    const result = await this.invoke("core.index.moveEntry", { item, parentId, index });
    return IndexResponseSchema.parse(result).items;
  }

  // -------------------------------------------------------------- access doors

  /*
    Handing authority out, over the same client every other capability uses (A2): a remote
    human, the browser and an agent reach `core.access` identically. Unlike the index writes
    above, a denial here is DATA rather than a throw — "you may not mint that cap" and
    "you may not widen your container scope" are answers a caller renders and often expects, so
    `invoke`'s throw-on-refusal would turn a normal negotiation into an exception.
  */

  /** One access door, with its refusal kept as data. */
  private async accessDoor<T>(
    name: string,
    args: unknown,
    parse: (result: unknown) => T,
  ): Promise<AccessOutcome<T>> {
    const outcome = await this.action(name, args);
    if (!outcome.ok) return { ok: false, denial: outcome.denial };
    return { ok: true, result: parse(outcome.result) };
  }

  /**
   * Creates a principal holding a root token (`core.access.createPrincipal`). Root-only,
   * and the workspace's bootstrap: this is how the owner key becomes a durable identity.
   */
  async createPrincipal(input: BootstrapPrincipalRequest): Promise<AccessOutcome<TokenGrant>> {
    const request = BootstrapPrincipalRequestSchema.parse(input);
    return this.accessDoor("core.access.createPrincipal", request, (result) =>
      TokenGrantSchema.parse(result),
    );
  }

  /**
   * Mints a token (`core.access.mint`) no broader than this client's own authority —
   * the delegation path an agent uses to hand a sub-agent strictly less than it holds.
   */
  async mintToken(input: MintTokenRequest): Promise<AccessOutcome<TokenGrant>> {
    const request = MintTokenRequestSchema.parse(input);
    return this.accessDoor("core.access.mint", request, (result) => TokenGrantSchema.parse(result));
  }

  /**
   * Revokes a principal's tokens (`core.access.revoke`) and answers HOW MANY died —
   * zero is a success, not a refusal. Live sockets holding a revoked token are closed by
   * the server's revocation fence, so this is the whole cutoff.
   */
  async revokeToken(principalId: string): Promise<AccessOutcome<RevokeResult>> {
    const request = RevokeRequestSchema.parse({ principalId });
    return this.accessDoor("core.access.revoke", request, (result) =>
      RevokeResultSchema.parse(result),
    );
  }

  sendGesture(gesture: Gesture): void {
    this.send({ type: "gesture", ...gesture });
  }

  outboxSize(): number {
    return this.outbox.length;
  }

  sendPresence(payload: PresencePayload): void {
    this.send({ type: "presence", payload });
  }

  sendCursor(x: number, y: number): void {
    this.send({ type: "cursor", x, y });
  }

  requestResync(): void {
    this.send({ type: "resync_request" });
  }

  /**
   * Opens a terminal and resolves with its terminal once the server confirms.
   *
   * A terminal is born into a COMPOSITION of its own, and `terminal.containerId` names it. Under
   * the default placement the caller is a canvas, so `elementId` is both the correlation
   * token and the id the caller authors its own element under — a `portal` onto
   * `terminal.containerId`, never a terminal element, because a canvas only ever references the
   * container a terminal lives in. `placement: "tile"` is how a TILED container births
   * one: that container IS the home, so the server writes the tile leaf itself and the
   * caller authors nothing. Read the leaf from `layout()` (`tileIdForRef`) once this
   * resolves; the doc update precedes the confirmation on the same socket.
   */
  openTerminal(opts: {
    elementId: string;
    cols: number;
    rows: number;
    cwd?: string;
    machineId?: string;
    placement?: "tile";
    timeoutMs?: number;
  }): Promise<TerminalInfo> {
    const { promise, resolve, reject } = Promise.withResolvers<TerminalInfo>();
    const settle = (outcome: () => void): void => {
      clearTimeout(timer);
      offOpened();
      offError();
      offStatus();
      outcome();
    };
    const timer = setTimeout(
      () => settle(() => reject(new Error("terminal_open timed out"))),
      opts.timeoutMs ?? 15_000,
    );
    const offOpened = this.on("terminal_opened", (msg) => {
      // A server-placed reply echoes the token as `ref`, because its `elementId` is a
      // tile id this caller never chose.
      if ((msg.ref ?? msg.elementId) !== opts.elementId) return;
      settle(() => resolve(msg.terminal));
    });
    const offError = this.on("error", (msg) => {
      if (msg.ref !== opts.elementId) return;
      settle(() => reject(new Error(`terminal_open failed: ${msg.message ?? msg.code}`)));
    });
    const offStatus = this.on("status", (status: ConnectionStatus) => {
      if (status === "closed") {
        settle(() =>
          reject(this.closeError ?? new Error("terminal closed before terminal opened")),
        );
      }
    });
    this.send({
      type: "terminal_open",
      elementId: opts.elementId,
      cols: opts.cols,
      rows: opts.rows,
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts.machineId !== undefined ? { machineId: opts.machineId } : {}),
      ...(opts.placement !== undefined ? { placement: opts.placement } : {}),
    });
    return promise;
  }

  /**
   * Every view-attach sends a wire `terminal_attach`: the server replaces this
   * connection's viewer and emits a fresh snapshot(S)+outputs(S+1…), so EVERY
   * local view (old and new) re-renders from a coherent stream — a view that
   * subscribes late (cloned terminal element, mount race after refresh) would
   * otherwise never receive screen state and stay blank. Detach stays
   * refcounted because the server keys viewers by connection: a raw detach
   * from one view would starve every other view on this client.
   */
  attachTerminal(terminalId: string): void {
    const next = (this.attachCounts.get(terminalId) ?? 0) + 1;
    this.attachCounts.set(terminalId, next);
    this.send({ type: "terminal_attach", terminalId });
  }

  detachTerminal(terminalId: string): void {
    const current = this.attachCounts.get(terminalId) ?? 0;
    if (current > 1) {
      this.attachCounts.set(terminalId, current - 1);
      return;
    }
    this.attachCounts.delete(terminalId);
    if (current === 1) this.send({ type: "terminal_detach", terminalId });
  }

  sendTerminalInput(terminalId: string, data: string | Uint8Array): void {
    const b64 = typeof data === "string" ? textToBase64(data) : bytesToBase64(data);
    this.send({ type: "terminal_input", terminalId, data: b64 });
  }

  resizeTerminal(terminalId: string, cols: number, rows: number): void {
    this.send({ type: "terminal_resize", terminalId, cols, rows });
  }

  takeTerminal(terminalId: string): void {
    this.send({ type: "terminal_take", terminalId });
  }

  killTerminal(terminalId: string): void {
    this.send({ type: "terminal_kill", terminalId });
  }
}
