import {
  ClientMessageSchema,
  MAX_ELEMENTS_PER_UPDATE,
  MAX_SESSION_FRAME_BYTES,
  PROTOCOL_VERSION,
  ServerMessageSchema,
  applyAccepted,
  reconcile,
  type ClientMessage,
  type PresencePayload,
  type PresenceState,
  type Principal,
  type SceneElement,
  type ServerMessage,
  type SessionInfo,
  SERVER_MESSAGE_TYPES,
} from "@manifold/protocol";
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
  const parsed = ServerMessageSchema.safeParse(raw);
  if (!parsed.success) return { kind: "malformed", detail: `invalid ${type} frame` };
  return { kind: "message", message: parsed.data };
}

export type ConnectionStatus = "idle" | "connecting" | "open" | "reconnecting" | "closed";

type ServerMessageOf<T extends ServerMessage["type"]> = Extract<ServerMessage, { type: T }>;

export interface SceneUpdateRejection {
  readonly element: SceneElement;
  readonly reason: "element_too_large" | "element_not_serializable" | "server_rejected";
  readonly serializedBytes: number | null;
  readonly limitBytes: number;
}

export interface SessionEvents {
  /** Server messages, by type. */
  message: (msg: ServerMessage) => void;
  status: (status: ConnectionStatus) => void;
  /** Scene replaced wholesale (first init, resync, or reconnect). */
  scene_reset: () => void;
  /** Scene changed incrementally (accepted records applied). */
  scene_changed: (elements: readonly SceneElement[], by: string) => void;
  /** Local records refused before apply or rejected by the server after optimistic apply. */
  scene_rejected: (rejections: readonly SceneUpdateRejection[]) => void;
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
// Reserve 25% of the wire limit for the scene_update envelope and future metadata.
const SCENE_UPDATE_ELEMENTS_BYTE_BUDGET = (MAX_SESSION_FRAME_BYTES * 3) / 4;

/**
 * Counts the UTF-8 bytes of one element's JSON without allocating another full-size
 * encoded buffer. Large freedraw records make that otherwise significant transient memory.
 */
function serializedElementByteLength(element: SceneElement): number | null {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(element);
  } catch {
    return null;
  }
  if (serialized === undefined) return null;

  let bytes = 0;
  for (let index = 0; index < serialized.length; index += 1) {
    const code = serialized.charCodeAt(index);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = serialized.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}
interface InflightSceneElement {
  readonly element: SceneElement;
  readonly stamp: string;
}

export class SessionClient {
  /** Local scene truth: canonical after init, optimistic between acks. */
  readonly scene = new Map<string, SceneElement>();
  readonly roster = new Map<string, PresenceState>();
  readonly sessions = new Map<string, SessionInfo>();
  /** Live view refcounts per attached session (see attachTerminal). */
  private readonly attachCounts = new Map<string, number>();
  epoch = "";
  rev = 0;
  self: Principal | null = null;
  selfConnId: string | null = null;
  status: ConnectionStatus = "idle";

  private readonly opts: Required<Pick<SessionClientOptions, "url" | "padId" | "token">> &
    SessionClientOptions;
  private socket: WebSocket | null = null;
  private listeners = new Map<EventKey, Set<Handler>>();
  private outbox: ClientMessage[] = [];
  private attempts = 0;
  private closedIntentionally = false;
  private updateCounter = 0;
  private readonly inflightUpdates = new Map<string, readonly InflightSceneElement[]>();
  private readonly rejectedSceneStamps = new Set<string>();
  private reconnectTimer: Timer | null = null;
  private keepaliveTimer: Timer | null = null;
  private closeError: Error | null = null;

  constructor(opts: SessionClientOptions) {
    this.opts = opts;
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
   * One listener's failure must never starve its siblings: state (scene, rev) advances
   * BEFORE emission, and a duplicate echo reconciles to zero accepted records, so a
   * swallowed `scene_changed` would desynchronize a consumer unrecoverably. Errors are
   * still reported (never-swallow rule) — they are just not allowed to propagate.
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
    this.inflightUpdates.clear();
    this.rejectedSceneStamps.clear();
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
    this.inflightUpdates.clear();

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
      this.inflightUpdates.clear();

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
      const delay = Math.min(cap, 250 * 2 ** this.attempts) * (0.5 + Math.random() * 0.5);
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
        // First epoch adoption and same-epoch reconnects rebase optimistic edits. Only a
        // lineage change fences local records from being re-stamped into the new epoch.
        const rebaseEligible = this.epoch === "" || this.epoch === msg.epoch;
        if (this.epoch !== msg.epoch) this.inflightUpdates.clear();
        const localBefore = rebaseEligible
          ? [...this.scene.values()].filter(
              (element) =>
                !this.rejectedSceneStamps.has(
                  JSON.stringify([element.id, element.version, element.versionNonce]),
                ),
            )
          : [];
        this.rejectedSceneStamps.clear();
        this.scene.clear();
        for (const el of msg.elements) this.scene.set(el.id, el);
        this.epoch = msg.epoch;
        this.rev = msg.rev;
        this.self = msg.self;
        this.selfConnId = msg.selfConnId;
        this.roster.clear();
        for (const p of msg.roster) this.roster.set(p.principal.id, p);
        this.sessions.clear();
        for (const s of msg.sessions) this.sessions.set(s.id, s);
        this.setStatus("open");
        this.startKeepalive();
        this.flushOutbox();
        // Re-subscribe every session views still hold: the server's viewer
        // registry is connection-scoped and did not survive the reconnect.
        for (const attachedId of this.attachCounts.keys()) {
          if (this.sessions.get(attachedId)?.status === "running") {
            this.send({ type: "terminal_attach", sessionId: attachedId });
          }
        }
        if (rebaseEligible) {
          const rebase = reconcile(this.scene, localBefore).accepted;
          if (rebase.length > 0) this.updateScene(rebase);
        }
        this.emit(msg.type, msg);
        this.emit("scene_reset");
        this.emit("roster_changed");
        this.emit("sessions_changed");
        break;
      }
      case "scene_applied": {
        if (msg.rev > this.rev + 1) {
          // Missed a broadcast: converge via resync rather than guessing.
          this.send({ type: "resync_request" });
        }
        const { accepted } = reconcile(this.scene, msg.elements);
        applyAccepted(this.scene, accepted);
        this.rev = Math.max(this.rev, msg.rev);
        this.emit(msg.type, msg);
        if (accepted.length > 0) this.emit("scene_changed", accepted, msg.by);
        break;
      }
      case "scene_ack": {
        this.inflightUpdates.delete(msg.updateId);
        this.rev = Math.max(this.rev, msg.rev);
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
          this.sessions.set(msg.sessionId, next);
        }
        this.emit(msg.type, msg);
        this.emit("sessions_changed");
        break;
      }
      case "error": {
        let resyncRequested = false;
        if (msg.ref !== undefined) {
          const rejected = this.inflightUpdates.get(msg.ref);
          if (rejected !== undefined) {
            this.inflightUpdates.delete(msg.ref);
            for (const { stamp } of rejected) this.rejectedSceneStamps.add(stamp);
            this.send({ type: "resync_request" });
            resyncRequested = true;
            this.emit(
              "scene_rejected",
              rejected.map(({ element }) => ({
                element,
                reason: "server_rejected",
                serializedBytes: null,
                limitBytes: SCENE_UPDATE_ELEMENTS_BYTE_BUDGET,
              })),
            );
          }
        }
        if (msg.code === "epoch_mismatch" && !resyncRequested) {
          this.send({ type: "resync_request" });
        }
        this.emit(msg.type, msg);
        break;
      }
      case "cursor":
      case "terminal_snapshot":
      case "terminal_output":
      case "saved":
      case "pong": {
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
      // Development guard: never put an invalid frame on the wire. Before first init,
      // optimistic scene updates carry the not-yet-adopted empty epoch only in the outbox.
      ClientMessageSchema.parse(msg);
      this.socket.send(JSON.stringify(msg));
      return;
    }
    if (msg.type === "cursor" || msg.type === "ping") return; // droppable while away
    if (this.outbox.length >= OUTBOX_LIMIT) this.outbox.shift();
    this.outbox.push(msg);
  }

  private flushOutbox(): void {
    const queued = this.outbox;
    this.outbox = [];
    for (const msg of queued) {
      // First adoption rebases optimistic state into the adopted epoch, so its queued
      // empty-epoch frames are superseded and still dropped here. Only lineage changes fence
      // old scene history; same-epoch state is replayed by the normal outbox/rebase path.
      if (msg.type === "scene_update" && msg.epoch !== this.epoch) continue;
      this.send(msg);
    }
  }

  /**
   * Applies elements optimistically to the local scene and submits them.
   * Oversized records are reported through scene_rejected and left unapplied.
   * Returns every queued updateId (each echoed in scene_ack), or null if none were queued.
   */
  updateScene(elements: readonly SceneElement[]): readonly string[] | null {
    const { accepted } = reconcile(this.scene, elements);
    if (accepted.length === 0) return null;

    const chunks: SceneElement[][] = [];
    const rejected: SceneUpdateRejection[] = [];
    let chunk: SceneElement[] = [];
    let chunkBytes = 0;

    for (const element of accepted) {
      const elementBytes = serializedElementByteLength(element);
      if (elementBytes === null) {
        rejected.push({
          element,
          reason: "element_not_serializable",
          serializedBytes: null,
          limitBytes: SCENE_UPDATE_ELEMENTS_BYTE_BUDGET,
        });
        continue;
      }
      if (elementBytes > SCENE_UPDATE_ELEMENTS_BYTE_BUDGET) {
        rejected.push({
          element,
          reason: "element_too_large",
          serializedBytes: elementBytes,
          limitBytes: SCENE_UPDATE_ELEMENTS_BYTE_BUDGET,
        });
        continue;
      }

      const separatorBytes = chunk.length === 0 ? 0 : 1;
      if (
        chunk.length === MAX_ELEMENTS_PER_UPDATE ||
        chunkBytes + separatorBytes + elementBytes > SCENE_UPDATE_ELEMENTS_BYTE_BUDGET
      ) {
        chunks.push(chunk);
        chunk = [];
        chunkBytes = 0;
      }
      if (chunk.length > 0) chunkBytes += 1;
      chunk.push(element);
      chunkBytes += elementBytes;
    }
    if (chunk.length > 0) chunks.push(chunk);

    if (rejected.length > 0) this.emit("scene_rejected", rejected);
    if (chunks.length === 0) return null;

    const updateIds: string[] = [];
    for (const acceptedChunk of chunks) {
      const updateId = `u${++this.updateCounter}`;

      // Validate and queue each bounded frame before exposing its optimistic state. If a
      // later chunk fails, the scene still exactly reflects the frames already queued.
      this.send({
        type: "scene_update",
        updateId,
        epoch: this.epoch,
        baseRev: this.rev,
        elements: acceptedChunk,
      });
      this.inflightUpdates.set(
        updateId,
        acceptedChunk.map((element) => ({
          element,
          stamp: JSON.stringify([element.id, element.version, element.versionNonce]),
        })),
      );
      applyAccepted(this.scene, acceptedChunk);
      this.emit("scene_changed", acceptedChunk, this.self?.id ?? "local");
      updateIds.push(updateId);
    }
    return updateIds;
  }

  sendPresence(payload: PresencePayload): void {
    this.send({ type: "presence", payload });
  }

  sendCursor(x: number, y: number, tool?: "pointer" | "laser"): void {
    this.send({ type: "cursor", x, y, ...(tool !== undefined ? { tool } : {}) });
  }

  requestResync(): void {
    this.send({ type: "resync_request" });
  }

  /** Opens a terminal and resolves with its session once the server confirms. */
  openTerminal(opts: {
    elementId: string;
    cols: number;
    rows: number;
    cwd?: string;
    machineId?: string;
    timeoutMs?: number;
  }): Promise<SessionInfo> {
    const { promise, resolve, reject } = Promise.withResolvers<SessionInfo>();
    const settle = (outcome: () => void): void => {
      clearTimeout(timer);
      offOpened();
      offError();
      outcome();
    };
    const timer = setTimeout(
      () => settle(() => reject(new Error("terminal_open timed out"))),
      opts.timeoutMs ?? 15_000,
    );
    const offOpened = this.on("terminal_opened", (msg) => {
      if (msg.elementId !== opts.elementId) return;
      settle(() => resolve(msg.session));
    });
    const offError = this.on("error", (msg) => {
      if (msg.ref !== opts.elementId) return;
      settle(() => reject(new Error(`terminal_open failed: ${msg.code}`)));
    });
    this.send({
      type: "terminal_open",
      elementId: opts.elementId,
      cols: opts.cols,
      rows: opts.rows,
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts.machineId !== undefined ? { machineId: opts.machineId } : {}),
    });
    return promise;
  }

  /**
   * Attach/detach are refcounted: several views of one session (cloned terminal
   * elements) share a single wire subscription, because the server keys viewers
   * by connection — a raw detach from one view would starve every other view on
   * this client. Wire frames fire only on the 0→1 / 1→0 transitions; the no-gap
   * invariant holds because every attach yields a fresh snapshot(S)+outputs(S+1…).
   */
  attachTerminal(sessionId: string): void {
    const next = (this.attachCounts.get(sessionId) ?? 0) + 1;
    this.attachCounts.set(sessionId, next);
    if (next === 1) this.send({ type: "terminal_attach", sessionId });
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
