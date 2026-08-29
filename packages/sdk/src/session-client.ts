import {
  ClientMessageSchema,
  MAX_DOC_UPDATE_BYTES,
  PROTOCOL_VERSION,
  SERVER_MESSAGE_TYPES,
  ServerMessageSchema,
  reconnectDelayMs,
  type Cap,
  type ClientMessage,
  type Gesture,
  type PresencePayload,
  type PresenceState,
  type Principal,
  type SceneElement,
  type ServerMessage,
  type SessionInfo,
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

/**
 * THE session-channel client. Browsers, tests, and tools all speak to the server through
 * this state machine — never through a second WebSocket implementation (AGENTS.md
 * invariant). It owns: the join handshake, reconnect with rejoin, epoch/rev tracking,
 * gap-triggered resync, optimistic local reconciliation, and offline-edit rebase.
 */

const KNOWN_SERVER_TYPES: ReadonlySet<string> = new Set(SERVER_MESSAGE_TYPES);

type ClassifiedFrame =
  | { kind: "message"; message: ServerMessage }
  | { kind: "unknown_type" }
  | { kind: "malformed"; detail: string };

/**
 * Frame policy (CONTRACTS.md): unknown `type` values are ignored for forward
 * compatibility; malformed frames of KNOWN types (or non-JSON) are protocol errors —
 * the caller closes the socket (4002) and heals via reconnect → fresh init.
 */
type TerminalDataFrame = Extract<ServerMessage, { type: "terminal_output" | "terminal_snapshot" }>;

function isTerminalDataFrame(raw: object): raw is TerminalDataFrame {
  const type = Reflect.get(raw, "type");
  const sessionId = Reflect.get(raw, "sessionId");
  const seq = Reflect.get(raw, "seq");
  const data = Reflect.get(raw, "data");
  return (
    (type === "terminal_output" || type === "terminal_snapshot") &&
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

export type ConnectionStatus = "idle" | "connecting" | "open" | "reconnecting" | "closed";

type ServerMessageOf<T extends ServerMessage["type"]> = Extract<ServerMessage, { type: T }>;

export interface SceneTx {
  create(element: SceneElement): void;
  patch(id: string, patch: ScenePatch): boolean;
  remove(id: string): boolean;
  text(id: string): Y.Text | null;
  nextZIndex(): number;
}

export interface SessionEvents {
  /** Server messages, by type. */
  message: (msg: ServerMessage) => void;
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
}

type EventKey = ServerMessage["type"] | keyof SessionEvents;
type Handler = (...args: never[]) => void;

export interface SessionClientOptions {
  /** ws(s) URL of the session endpoint, e.g. ws://localhost:7777/ws/session */
  url: string;
  padId: string;
  token: string;
  /**
   * Joins as a spectator: this socket watches the room (state, doc updates, terminal
   * output) without occupying it. It is absent from the roster and from pad presence,
   * it never keeps a transient container alive, and the server rejects any write it
   * sends. Live previews of a container use it; anything a user acts in does not.
   */
  spectator?: boolean;
  /** Reconnect on unexpected close (default true). */
  reconnect?: boolean;
  /** DI seam for tests. */
  webSocketFactory?: (url: string) => WebSocket;
  /** Backoff schedule cap in ms (default 8000). */
  backoffCapMs?: number;
}

const OUTBOX_LIMIT = 256;
const KEEPALIVE_INTERVAL_MS = 45_000;
const MALFORMED_FRAME_CLOSE_CODE = 4002;
const TERMINAL_CLOSE_CODE_MIN = 4400;
const TERMINAL_CLOSE_CODE_MAX = 4499;

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
  selfCaps: readonly Cap[] = [];
  status: ConnectionStatus = "idle";

  private readonly opts: Required<Pick<SessionClientOptions, "url" | "padId" | "token">> &
    SessionClientOptions;
  private socket: WebSocket | null = null;
  private listeners = new Map<EventKey, Set<Handler>>();
  private outbox: ClientMessage[] = [];
  private attempts = 0;
  private closedIntentionally = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private keepaliveTimer: NodeJS.Timeout | null = null;
  private closeError: Error | null = null;
  private currentDoc = createSceneDoc();
  private undoManager!: Y.UndoManager;
  private hasLocalEdits = false;

  constructor(opts: SessionClientOptions) {
    this.opts = opts;
    this.installDoc(this.currentDoc);
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

  on<T extends ServerMessage["type"]>(type: T, fn: (msg: ServerMessageOf<T>) => void): () => void;
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

  /** Resolves on the first successful init. Reconnects keep running afterwards. */
  connect(): Promise<void> {
    this.closedIntentionally = false;
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
    this.dial();
    return promise;
  }

  private startKeepalive(): void {
    this.stopKeepalive();
    const timer = setInterval(() => {
      if (this.keepaliveTimer !== timer) return;
      this.send({ type: "ping" });
    }, KEEPALIVE_INTERVAL_MS);
    this.keepaliveTimer = timer;
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer === null) return;
    clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
  }

  close(): void {
    this.closedIntentionally = true;
    this.closeError = null;
    this.stopKeepalive();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000);
    this.setStatus("closed");
  }

  private dial(): void {
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

    this.setStatus(this.attempts === 0 ? "connecting" : "reconnecting");
    const factory = this.opts.webSocketFactory ?? ((url: string) => new WebSocket(url));
    const socket = factory(this.opts.url);
    this.socket = socket;

    socket.onopen = () => {
      if (this.socket !== socket) return;
      const join: ClientMessage = {
        type: "join",
        padId: this.opts.padId,
        token: this.opts.token,
        protocolVersion: PROTOCOL_VERSION,
        // Omitted rather than sent as false: the flag's absence IS the occupant case,
        // and a reconnect must re-declare it because the server tracks it per socket.
        ...(this.opts.spectator === true ? { spectator: true } : {}),
        ...(this.epoch !== "" ? { lastEpoch: this.epoch, lastRev: this.rev } : {}),
      };
      socket.send(JSON.stringify(join));
    };

    socket.onmessage = (ev: MessageEvent) => {
      if (this.socket !== socket) return;
      const classified = classifyServerFrame(ev.data);
      switch (classified.kind) {
        case "message":
          this.handle(classified.message);
          return;
        case "unknown_type":
          return; // forward compatibility: newer servers may emit types we don't know
        case "malformed":
          // A malformed KNOWN frame means version skew or corruption — local state is no
          // longer provable. Close with an application protocol error and heal through
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

      // 44xx codes are permanent session rejections. Retrying them cannot succeed without
      // changed credentials/input, whereas our own 4002 protocol-healing close must redial.
      const terminalClose =
        event.code !== MALFORMED_FRAME_CLOSE_CODE &&
        event.code >= TERMINAL_CLOSE_CODE_MIN &&
        event.code <= TERMINAL_CLOSE_CODE_MAX;
      if (terminalClose) {
        this.closedIntentionally = true;
        const reason = event.reason.trim();
        this.closeError = new Error(
          reason === ""
            ? `session rejected with close code ${event.code}`
            : `session rejected with close code ${event.code}: ${reason}`,
        );
        this.setStatus("closed");
        return;
      }

      if (this.closedIntentionally || this.opts.reconnect === false) {
        this.setStatus("closed");
        return;
      }
      const cap = this.opts.backoffCapMs ?? 8000;
      const delay = reconnectDelayMs(this.attempts, 250, cap);
      this.attempts += 1;
      const timer = setTimeout(() => {
        // clearTimeout cannot retract a callback already queued by the event loop. The
        // identity check fences such stale callbacks after close() or a manual connect().
        if (this.reconnectTimer !== timer) return;
        this.reconnectTimer = null;
        if (!this.closedIntentionally && this.socket === null) this.dial();
      }, delay);
      this.reconnectTimer = timer;
      this.setStatus("reconnecting");
    };
  }

  // ------------------------------------------------------------------ incoming

  private handle(msg: ServerMessage): void {
    switch (msg.type) {
      case "init":
      case "resync": {
        this.attempts = 0;
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
        this.selfCaps = msg.selfCaps;
        this.roster.clear();
        for (const p of msg.roster) this.roster.set(p.principal.id, p);
        this.sessions.clear();
        for (const s of msg.sessions) this.sessions.set(s.id, s);
        this.setStatus("open");
        this.startKeepalive();
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
          // The session left this pad for the workspace pool; it is no longer
          // reachable over this connection.
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
      case "terminal_output":
      case "pong": {
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

  private send(msg: ClientMessage): void {
    if (this.socket !== null && this.socket.readyState === 1 && this.status === "open") {
      // Development guard: never put an invalid frame on the wire. High-volume binary
      // frame types are constructed entirely by this SDK, so avoid rescanning their payloads.
      if (msg.type !== "cursor" && msg.type !== "doc_update" && msg.type !== "terminal_input") {
        ClientMessageSchema.parse(msg);
      }
      this.socket.send(JSON.stringify(msg));
      return;
    }
    if (msg.type === "cursor" || msg.type === "gesture" || msg.type === "ping") return;
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
   * server can enforce discipline and the bubble lifecycle.
   */
  setTileRatios(splitId: string, ratios: readonly number[]): void {
    sceneSetTileRatios(this.currentDoc, splitId, ratios, LOCAL_ORIGIN);
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
   * `placement: "tile"` is how a TILED container births one: it has no canvas to author
   * into, so the server writes the tile leaf and the resolved `session.elementId` is that
   * tile id. `elementId` stays the correlation token either way — under the default
   * element placement it is also the id the caller authors its element under.
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
