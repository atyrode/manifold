import {
  ClientMessageSchema,
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

export interface SessionEvents {
  /** Server messages, by type. */
  message: (msg: ServerMessage) => void;
  status: (status: ConnectionStatus) => void;
  /** Scene replaced wholesale (first init, resync, or reconnect). */
  scene_reset: () => void;
  /** Scene changed incrementally (accepted records applied). */
  scene_changed: (elements: readonly SceneElement[], by: string) => void;
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

export class SessionClient {
  /** Local scene truth: canonical after init, optimistic between acks. */
  readonly scene = new Map<string, SceneElement>();
  readonly roster = new Map<string, PresenceState>();
  readonly sessions = new Map<string, SessionInfo>();
  epoch = "";
  rev = 0;
  self: Principal | null = null;
  status: ConnectionStatus = "idle";

  private readonly opts: Required<Pick<SessionClientOptions, "url" | "padId" | "token">> &
    SessionClientOptions;
  private socket: WebSocket | null = null;
  private listeners = new Map<EventKey, Set<Handler>>();
  private outbox: ClientMessage[] = [];
  private attempts = 0;
  private closedIntentionally = false;
  private updateCounter = 0;

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

  private emit(type: EventKey, ...args: unknown[]): void {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const fn of [...set]) (fn as (...a: unknown[]) => void)(...args);
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
        reject(new Error("session closed before init"));
      }
    });
    this.dial();
    return promise;
  }

  close(): void {
    this.closedIntentionally = true;
    this.socket?.close(1000);
    this.socket = null;
    this.setStatus("closed");
  }

  private dial(): void {
    this.setStatus(this.attempts === 0 ? "connecting" : "reconnecting");
    const factory = this.opts.webSocketFactory ?? ((url: string) => new WebSocket(url));
    const socket = factory(this.opts.url);
    this.socket = socket;

    socket.onopen = () => {
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
          socket.close(4002, "malformed server frame");
          return;
      }
    };

    socket.onclose = () => {
      if (this.socket !== socket) return; // superseded socket
      this.socket = null;
      if (this.closedIntentionally || this.opts.reconnect === false) {
        this.setStatus("closed");
        return;
      }
      const cap = this.opts.backoffCapMs ?? 8000;
      const delay = Math.min(cap, 250 * 2 ** this.attempts) * (0.5 + Math.random() * 0.5);
      this.attempts += 1;
      setTimeout(() => {
        if (!this.closedIntentionally) this.dial();
      }, delay);
      this.setStatus("reconnecting");
    };
  }

  // ------------------------------------------------------------------ incoming

  private handle(msg: ServerMessage): void {
    switch (msg.type) {
      case "init":
      case "resync": {
        this.attempts = 0;
        // Rebase: local records that beat the server state (offline/optimistic edits)
        // are re-submitted through the normal update path after adoption.
        const localBefore = [...this.scene.values()];
        this.scene.clear();
        for (const el of msg.elements) this.scene.set(el.id, el);
        this.epoch = msg.epoch;
        this.rev = msg.rev;
        this.self = msg.self;
        this.roster.clear();
        for (const p of msg.roster) this.roster.set(p.principal.id, p);
        this.sessions.clear();
        for (const s of msg.sessions) this.sessions.set(s.id, s);
        this.setStatus("open");
        this.flushOutbox();
        const rebase = reconcile(this.scene, localBefore).accepted;
        if (rebase.length > 0) this.updateScene(rebase);
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
        if (msg.code === "epoch_mismatch") this.send({ type: "resync_request" });
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
    // Development guard: never put an invalid frame on the wire.
    ClientMessageSchema.parse(msg);
    if (this.socket !== null && this.socket.readyState === 1 && this.status === "open") {
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
      // Scene updates from a previous epoch are re-stamped by updateScene during rebase;
      // stale ones are dropped here rather than bounced off the epoch fence.
      if (msg.type === "scene_update" && msg.epoch !== this.epoch) continue;
      this.send(msg);
    }
  }

  /**
   * Applies elements optimistically to the local scene and submits them.
   * Returns the updateId (echoed in scene_ack), or null if nothing won locally.
   */
  updateScene(elements: readonly SceneElement[]): string | null {
    const { accepted } = reconcile(this.scene, elements);
    if (accepted.length === 0) return null;
    applyAccepted(this.scene, accepted);
    this.emit("scene_changed", accepted, this.self?.id ?? "local");
    const updateId = `u${++this.updateCounter}`;
    this.send({
      type: "scene_update",
      updateId,
      epoch: this.epoch,
      baseRev: this.rev,
      elements: [...accepted],
    });
    return updateId;
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

  attachTerminal(sessionId: string): void {
    this.send({ type: "terminal_attach", sessionId });
  }

  detachTerminal(sessionId: string): void {
    this.send({ type: "terminal_detach", sessionId });
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
