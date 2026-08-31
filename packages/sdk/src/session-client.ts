import {
  ActionOutcomeSchema,
  ClientMessageBodySchema,
  CreatePadFolderRequestSchema,
  HttpErrorSchema,
  MAX_DOC_UPDATE_BYTES,
  MachinesResponseSchema,
  MovePadTreeItemRequestSchema,
  PROTOCOL_VERSION,
  PadPresenceResponseSchema,
  PadResponseSchema,
  PadSessionsResponseSchema,
  PadTreeResponseSchema,
  PlaceRequestSchema,
  PlaceResponseSchema,
  PlacementDeniedResponseSchema,
  RenamePadRequestSchema,
  TerminalsResponseSchema,
  type ActionOutcome,
  type Cap,
  type ClientMessageBody,
  type Gesture,
  type MachineSummary,
  type Pad,
  type PadPresence,
  type PadSessionSummary,
  type PadTreeItem,
  type PlaceResponse,
  type PlacementDenial,
  type PlacementDestination,
  type PlacementSurface,
  type PluginRoster,
  type PresencePayload,
  type PresenceState,
  type Principal,
  type SceneElement,
  type ServerMessageBody,
  type SessionInfo,
  type TerminalSummary,
  type TileLayout,
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
 * rendering a canvas plus five portal widgets holds ONE TCP connection with six channels.
 * The public surface is unchanged — construct one per room, `connect()`, subscribe — and
 * reconnect, keepalive, and rejoin-every-channel live one layer down in
 * `connection-pool.ts`.
 *
 * Some of its surface is WORKSPACE-level rather than room-level: the action door
 * (`action`), the workspace reads (`machines`, `padTree`, `padPresence`, `padSessions`,
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
  create(element: SceneElement): void;
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
   * A tiled container's layout tree changed. The tree is small and read whole, so
   * subscribers re-read `layout()` rather than diffing tile ids.
   */
  layout_changed: (origin: "local" | "remote" | "undo") => void;
  roster_changed: () => void;
  sessions_changed: () => void;
  /**
   * The workspace's plugin roster arrived (socket open) or changed (an enable/disable).
   * It is connection-level news, not room traffic, so it never reaches `message`.
   * Subscribe through `onPlugins`, which replays the last one it heard.
   */
  plugins_changed: (roster: PluginRoster) => void;
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

export interface SessionClientOptions {
  /** ws(s) URL of the session endpoint, e.g. ws://localhost:7777/ws/session */
  url: string;
  padId: string;
  token: string;
  /**
   * Joins as a spectator: this channel watches the room (state, doc updates, terminal
   * output) without occupying it. It is absent from the roster and from pad presence,
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
   * DI seam for tests. It is also part of the pool key: two clients sharing a factory
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
  readonly roster = new Map<string, PresenceState>();
  readonly sessions = new Map<string, SessionInfo>();
  private readonly elementsState = new Map<string, SceneElement>();
  readonly elements: ReadonlyMap<string, SceneElement> = this.elementsState;
  /** Live view refcounts per attached session (see attachTerminal). */
  private readonly attachCounts = new Map<string, number>();
  epoch = "";
  rev = 0;
  self: Principal | null = null;
  selfConnId: string | null = null;
  private selfCapsState: readonly Cap[] = [];
  status: ConnectionStatus = "idle";

  private readonly opts: Required<Pick<SessionClientOptions, "url" | "padId" | "token">> &
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
   * because the plugin engine's `SessionHandle` is a method-only surface.
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
    // a tiled container needs no second subscription path.
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
        console.error("evt=session_listener_failed", type, error);
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
        reject(this.closeError ?? new Error("session closed before init"));
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
    // Releasing is the whole story: it leaves this room and, when this was the tab's last
    // room, closes the socket — a close IS a leave, so no extra frame is spent.
    channel?.release();
    this.setStatus("closed");
  }

  /** The join THIS room wants, rebuilt per attempt so resume hints are current. */
  private joinBody(): JoinBody {
    return {
      type: "join",
      padId: this.opts.padId,
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
          this.channel = null;
          this.closeError = new Error(
            reason.trim() === ""
              ? `session rejected with close code ${code}`
              : `session rejected with close code ${code}: ${reason.trim()}`,
          );
          this.setStatus("closed");
        },
        transportClosed: (error) => {
          this.channel = null;
          this.closeError = error;
          this.setStatus("closed");
        },
      },
    );
  }

  // ------------------------------------------------------------------ incoming

  /**
   * A frame addressed to the SOCKET this room rides. It never touches epoch/rev, never
   * queues, and never reaches `message`: the roster describes the workspace, not the room,
   * and every handle on the connection hears the same one.
   *
   * `plugins` is the only connection-level category v14 defines, so the body is read
   * directly; a second category makes `body.roster` a type error, which is exactly the
   * prompt to fan the categories out here.
   */
  private handleConnection(body: ConnectionFrame): void {
    this.pluginRoster = body.roster;
    this.emit("plugins_changed", body.roster);
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
        this.roster.clear();
        for (const p of msg.roster) this.roster.set(p.principal.id, p);
        this.sessions.clear();
        for (const s of msg.sessions) this.sessions.set(s.id, s);
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
            if (this.sessions.get(attachedId)?.status === "running") {
              this.send({ type: "terminal_attach", sessionId: attachedId });
            }
          }
        }
        this.emit(msg.type, msg);
        this.emit("scene_reset");
        this.emit("roster_changed");
        this.emit("sessions_changed");
        break;
      }
      case "doc_update": {
        Y.applyUpdate(this.currentDoc, decodeUpdate(msg.update), REMOTE_ORIGIN);
        this.emit(msg.type, msg);
        break;
      }
      case "roster": {
        if (msg.joined) this.roster.set(msg.joined.principal.id, msg.joined);
        if (msg.left) this.roster.delete(msg.left.principalId);
        this.emit(msg.type, msg);
        this.emit("roster_changed");
        break;
      }
      case "presence": {
        const entry = this.roster.get(msg.principalId);
        if (entry) {
          this.roster.set(msg.principalId, {
            ...entry,
            payload: { ...entry.payload, ...msg.payload },
          });
        }
        this.emit(msg.type, msg);
        this.emit("roster_changed");
        break;
      }
      case "terminal_opened": {
        this.sessions.set(msg.session.id, msg.session);
        this.emit(msg.type, msg);
        this.emit("sessions_changed");
        break;
      }
      case "session_event": {
        if (msg.kind === "parked") {
          // A departure notice: the session is no longer in THIS room, so it is no longer
          // reachable over this channel. It either re-homed into another composition (a
          // merge or an extraction) or it was killed and left every room.
          this.sessions.delete(msg.sessionId);
          this.emit(msg.type, msg);
          this.emit("sessions_changed");
          break;
        }
        const session = this.sessions.get(msg.sessionId);
        if (session) {
          const next: SessionInfo = { ...session };
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
          this.sessions.set(msg.sessionId, next);
        }
        this.emit(msg.type, msg);
        this.emit("sessions_changed");
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
        create: (element) => writeElement(this.currentDoc, element, LOCAL_ORIGIN),
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
   * The tiled container's node table, or null for a canvas — and also for a tree that
   * fails validation, including one that tiles this very container: an unusable tree is
   * never handed to the renderer. Read whole on every `layout_changed`.
   */
  layout(): TileLayout | null {
    return readTileLayout(this.currentDoc, this.opts.padId);
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
   * THE placement call: put an item in a container. One envelope, one endpoint, and a
   * refusal that names the RULE which refused it — legality lives in the protocol's
   * placement declarations, so a caller never has to know which verb this used to be.
   *
   * It is HTTP rather than a socket message because placement crosses containers: this
   * client is joined to ONE room, and the write may touch two.
   */
  async place(surface: PlacementSurface, destination: PlacementDestination): Promise<PlaceOutcome> {
    const request = PlaceRequestSchema.parse({ surface, destination });
    const response = await fetch(`${this.apiOrigin()}/api/place`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.opts.token}`,
      },
      body: JSON.stringify(request),
    });
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`place returned a non-JSON response (${response.status})`);
    }
    if (response.ok) return { ok: true, result: PlaceResponseSchema.parse(payload) };
    const denied = PlacementDeniedResponseSchema.safeParse(payload);
    // A denial is an ANSWER, not a failure: the caller renders the rule (and its drag
    // preview already asked `resolvePlacement` the same question locally).
    if (denied.success) return { ok: false, denial: denied.data.error.denial };
    const failure = HttpErrorSchema.safeParse(payload);
    throw new Error(
      failure.success ? failure.data.error.message : `place failed (${response.status})`,
    );
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

  /** The HTTP origin this session's socket URL implies; `apiUrl` overrides it. */
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

  /** The enrolled machines with live online state (`GET /api/machines`). */
  async machines(): Promise<readonly MachineSummary[]> {
    return MachinesResponseSchema.parse(await this.getJson("/api/machines")).machines;
  }

  /** The workspace index — pads and folders in tree order (`GET /api/pad-tree`). */
  async padTree(): Promise<readonly PadTreeItem[]> {
    return PadTreeResponseSchema.parse(await this.getJson("/api/pad-tree")).items;
  }

  /** Who occupies which pad right now (`GET /api/pad-presence`). */
  async padPresence(): Promise<readonly PadPresence[]> {
    return PadPresenceResponseSchema.parse(await this.getJson("/api/pad-presence")).pads;
  }

  /** Every pad-homed terminal session, for per-pad counts (`GET /api/pad-sessions`). */
  async padSessions(): Promise<readonly PadSessionSummary[]> {
    return PadSessionsResponseSchema.parse(await this.getJson("/api/pad-sessions")).sessions;
  }

  /** Every terminal in the workspace with its home composition (`GET /api/terminals`). */
  async terminals(): Promise<readonly TerminalSummary[]> {
    return TerminalsResponseSchema.parse(await this.getJson("/api/terminals")).terminals;
  }

  // --------------------------------------------------------- workspace writes

  /*
    The workspace index's writes, beside its reads for the same reason: the section that
    LISTS containers is the section that renames and deletes them, and it holds only this
    client. They are still HTTP routes rather than actions this wave — AXIOMS.md §Roadmap
    puts "pad/folder CRUD + tree moves" in the workspace-index-actions row — so each one
    mirrors its route's request/response schema exactly, the same discipline the web app's
    own fetch layer keeps.
   */

  /** One authed JSON write; a non-2xx is a failure — these routes carry no denials. */
  private async writeJson(path: string, method: string, body?: unknown): Promise<unknown> {
    const response = await fetch(`${this.apiOrigin()}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.opts.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`${method} ${path} returned a non-JSON response (${response.status})`);
    }
    if (response.ok) return payload;
    const failure = HttpErrorSchema.safeParse(payload);
    throw new Error(
      failure.success
        ? failure.data.error.message
        : `${method} ${path} failed (${response.status})`,
    );
  }

  /** Renames one container (`PATCH /api/pads/:id`). */
  async renamePad(padId: string, name: string): Promise<Pad> {
    const request = RenamePadRequestSchema.parse({ name });
    const body = await this.writeJson(
      `/api/pads/${encodeURIComponent(padId)}`,
      "PATCH",
      request,
    );
    return PadResponseSchema.parse(body).pad;
  }

  /** Deletes one container (`DELETE /api/pads/:id`); the server enforces authority. */
  async deletePad(padId: string): Promise<void> {
    await this.writeJson(`/api/pads/${encodeURIComponent(padId)}`, "DELETE");
  }

  /** Creates an index folder (`POST /api/pad-folders`); answers the whole new index. */
  async createPadFolder(name: string, parentId: string | null): Promise<readonly PadTreeItem[]> {
    const request = CreatePadFolderRequestSchema.parse({ name, parentId });
    return PadTreeResponseSchema.parse(await this.writeJson("/api/pad-folders", "POST", request))
      .items;
  }

  /** Renames an index folder (`PATCH /api/pad-folders/:id`). */
  async renamePadFolder(folderId: string, name: string): Promise<readonly PadTreeItem[]> {
    const request = RenamePadRequestSchema.parse({ name });
    return PadTreeResponseSchema.parse(
      await this.writeJson(`/api/pad-folders/${encodeURIComponent(folderId)}`, "PATCH", request),
    ).items;
  }

  /** Deletes an index folder (`DELETE /api/pad-folders/:id`); its children move up. */
  async deletePadFolder(folderId: string): Promise<readonly PadTreeItem[]> {
    return PadTreeResponseSchema.parse(
      await this.writeJson(`/api/pad-folders/${encodeURIComponent(folderId)}`, "DELETE"),
    ).items;
  }

  /** Moves one index item between siblings or into a folder (`PUT /api/pad-tree`). */
  async movePadTreeItem(
    item: { readonly kind: "pad" | "folder"; readonly id: string },
    parentId: string | null,
    index: number,
  ): Promise<readonly PadTreeItem[]> {
    const request = MovePadTreeItemRequestSchema.parse({ item, parentId, index });
    return PadTreeResponseSchema.parse(await this.writeJson("/api/pad-tree", "PUT", request)).items;
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
   * Opens a terminal and resolves with its session once the server confirms.
   *
   * A terminal is born into a COMPOSITION of its own, and `session.padId` names it. Under
   * the default placement the caller is a canvas, so `elementId` is both the correlation
   * token and the id the caller authors its own element under — a `portal` onto
   * `session.padId`, never a terminal element, because a canvas only ever references the
   * container a terminal lives in. `placement: "tile"` is how a TILED container births
   * one: that container IS the home, so the server writes the tile leaf itself and the
   * caller authors nothing. Read the leaf from `layout()` (`tileIdForSurface`) once this
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
  }): Promise<SessionInfo> {
    const { promise, resolve, reject } = Promise.withResolvers<SessionInfo>();
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
      settle(() => resolve(msg.session));
    });
    const offError = this.on("error", (msg) => {
      if (msg.ref !== opts.elementId) return;
      settle(() => reject(new Error(`terminal_open failed: ${msg.code}`)));
    });
    const offStatus = this.on("status", (status: ConnectionStatus) => {
      if (status === "closed") {
        settle(() => reject(this.closeError ?? new Error("session closed before terminal opened")));
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
  attachTerminal(sessionId: string): void {
    const next = (this.attachCounts.get(sessionId) ?? 0) + 1;
    this.attachCounts.set(sessionId, next);
    this.send({ type: "terminal_attach", sessionId });
  }

  detachTerminal(sessionId: string): void {
    const current = this.attachCounts.get(sessionId) ?? 0;
    if (current > 1) {
      this.attachCounts.set(sessionId, current - 1);
      return;
    }
    this.attachCounts.delete(sessionId);
    if (current === 1) this.send({ type: "terminal_detach", sessionId });
  }

  sendTerminalInput(sessionId: string, data: string | Uint8Array): void {
    const b64 = typeof data === "string" ? textToBase64(data) : bytesToBase64(data);
    this.send({ type: "terminal_input", sessionId, data: b64 });
  }

  resizeTerminal(sessionId: string, cols: number, rows: number): void {
    this.send({ type: "terminal_resize", sessionId, cols, rows });
  }

  takeTerminal(sessionId: string): void {
    this.send({ type: "terminal_take", sessionId });
  }

  killTerminal(sessionId: string): void {
    this.send({ type: "terminal_kill", sessionId });
  }
}
