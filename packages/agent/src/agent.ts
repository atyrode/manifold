import {
  AGENT_LIVENESS_TIMEOUT_MS,
  PROTOCOL_VERSION,
  SERVER_TO_AGENT_MESSAGE_TYPES,
  ServerToAgentMessageSchema,
  defaultRuntime,
  type AdvertisedSession,
  type AgentMessage,
  type RuntimeDeps,
  type ServerToAgentMessage,
} from "@manifold/protocol";
import { PtySession, type PtyOutput } from "./session.ts";

/**
 * The manifold-agent's single machine-channel client. It dials OUT to the server's
 * `/ws/machine`, multiplexes every PTY over that one socket, and survives server restarts:
 * PTYs live in {@link PtySession} objects independent of the socket, so a dropped connection
 * only pauses streaming — on reconnect a fresh `hello` re-advertises the survivors and the
 * server re-adopts them (CONTRACTS.md §/ws/machine).
 *
 * This is deliberately the ONLY machine-channel state machine (mirrors the SDK's role on the
 * session channel): handshake, frame classification, reconnect/backoff, and PTY lifecycle
 * all live here.
 */

/** Reported in `hello`; bump on breaking agent-side behavior. */
const AGENT_VERSION = "0.1.0";

/** Structured log record; `ts` is stamped from the injected runtime clock. */
export interface AgentLogRecord {
  readonly ts: number;
  readonly level: "info" | "warn" | "error";
  readonly evt: string;
  readonly [field: string]: unknown;
}

/** Where structured logs go. main.ts writes them as JSONL to stdout; tests drop them. */
export type AgentLogSink = (record: AgentLogRecord) => void;

/** Reconnect backoff tuning. Defaults: 500 ms base, 15 s cap (CONTRACTS.md). */
export interface AgentBackoffOptions {
  readonly baseMs?: number;
  readonly capMs?: number;
}

/** Construction inputs for an {@link Agent}. */
export interface AgentOptions {
  /** http(s) URL of the server; the ws(s) `/ws/machine` URL is derived from it. */
  readonly serverUrl: string;
  readonly machineToken: string;
  readonly machineName: string;
  /** id/clock injection (defaults to wall-clock); lets tests seed deterministic log times. */
  readonly runtime?: RuntimeDeps;
  readonly sink?: AgentLogSink;
  readonly backoff?: AgentBackoffOptions;
  /** Silence deadline before the transport is declared dead (default 75s; protocol version.ts). */
  readonly livenessTimeoutMs?: number;
  /** Socket factory; DI seam (mirrors the server's RawSocket) so unit tests inject fakes. */
  readonly createSocket?: (url: string) => WebSocket;
  /** Shell argv for spawned PTYs; DI seam so tests pin a deterministic shell. */
  readonly shellCommand?: readonly string[];
}

type CreateMessage = Extract<ServerToAgentMessage, { type: "create" }>;

/** Frame classification outcome (mirrors the SDK's session-channel classifier). */
type ClassifiedFrame =
  | { readonly kind: "message"; readonly message: ServerToAgentMessage }
  | { readonly kind: "unknown_type"; readonly frameType: string }
  | { readonly kind: "malformed"; readonly detail: string };

const KNOWN_SERVER_TYPES: Record<string, true> = Object.fromEntries(
  SERVER_TO_AGENT_MESSAGE_TYPES.map((type): [string, true] => [type, true]),
);

/**
 * Frame policy (CONTRACTS.md hard rule 3): unknown `type` → ignore for forward
 * compatibility; malformed frame of a KNOWN type (or non-JSON) → protocol error, close and
 * reconnect. All agent state is local, so reconnect re-establishes a clean session.
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
  const frameType = Reflect.get(raw, "type") as string;
  if (KNOWN_SERVER_TYPES[frameType] !== true) return { kind: "unknown_type", frameType };
  const parsed = ServerToAgentMessageSchema.safeParse(raw);
  if (!parsed.success) return { kind: "malformed", detail: `invalid ${frameType} frame` };
  return { kind: "message", message: parsed.data };
}

/** Derives the `ws(s)://…/ws/machine` endpoint from the server's http(s) URL. */
function deriveMachineWsUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  const scheme = url.protocol === "https:" ? "wss:" : "ws:";
  const basePath = url.pathname.replace(/\/+$/, "");
  return `${scheme}//${url.host}${basePath}/ws/machine`;
}

export class Agent {
  private readonly machineToken: string;
  private readonly machineName: string;
  private readonly wsUrl: string;
  private readonly runtime: RuntimeDeps;
  private readonly sink: AgentLogSink;
  private readonly baseMs: number;
  private readonly capMs: number;
  private readonly shellCommand: readonly string[] | undefined;
  private readonly livenessTimeoutMs: number;

  private readonly sessions = new Map<string, PtySession>();
  private readonly createSocket: (url: string) => WebSocket;
  private socket: WebSocket | null = null;
  private machineId: string | null = null;
  private serverEpochValue: string | null = null;
  private attempts = 0;
  private reconnectTimer: Timer | null = null;
  private livenessTimer: Timer | null = null;
  private stopped = false;
  private welcomeWaiters: Array<() => void> = [];

  constructor(opts: AgentOptions) {
    this.machineToken = opts.machineToken;
    this.machineName = opts.machineName;
    this.wsUrl = deriveMachineWsUrl(opts.serverUrl);
    this.runtime = opts.runtime ?? defaultRuntime;
    this.sink = opts.sink ?? (() => {});
    this.baseMs = opts.backoff?.baseMs ?? 500;
    this.capMs = opts.backoff?.capMs ?? 15_000;
    this.shellCommand = opts.shellCommand;
    this.livenessTimeoutMs = opts.livenessTimeoutMs ?? AGENT_LIVENESS_TIMEOUT_MS;
    this.createSocket = opts.createSocket ?? ((url: string) => new WebSocket(url));
  }

  /** Machine id learned from `welcome` (null until the first successful handshake). */
  get id(): string | null {
    return this.machineId;
  }

  /** Server boot epoch learned from `welcome` (null while disconnected). */
  get serverEpoch(): string | null {
    return this.serverEpochValue;
  }

  /** Count of live PTY sessions currently owned by this agent. */
  get sessionCount(): number {
    return this.sessions.size;
  }

  /** Dials the server and resolves once the first `welcome` is received. */
  connect(): Promise<void> {
    this.stopped = false;
    const { promise, resolve } = Promise.withResolvers<void>();
    this.welcomeWaiters.push(resolve);
    if (this.socket === null && this.reconnectTimer === null) this.dial();
    return promise;
  }

  /**
   * Stops reconnecting, closes the socket, and kills every PTY — resolving once they have all
   * exited. This is the SIGTERM path: the process can exit 0 afterward.
   */
  async shutdown(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.livenessTimer !== null) {
      clearTimeout(this.livenessTimer);
      this.livenessTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    if (socket !== null) socket.close(1000, "shutdown");
    const kills: Array<Promise<unknown>> = [];
    for (const session of this.sessions.values()) kills.push(session.kill());
    await Promise.all(kills);
    this.sessions.clear();
    this.log("info", "shutdown");
  }

  private log(level: AgentLogRecord["level"], evt: string, fields?: Record<string, unknown>): void {
    this.sink({ ts: this.runtime.now(), level, evt, ...fields });
  }

  private dial(): void {
    if (this.stopped) return;
    const socket = this.createSocket(this.wsUrl);
    this.socket = socket;
    this.log("info", "dialing", { attempt: this.attempts });
    socket.onopen = () => {
      if (this.socket === socket) {
        this.armLiveness(socket);
        this.sendHello(socket);
      }
    };
    socket.onmessage = (ev: MessageEvent) => {
      if (this.socket === socket) {
        this.armLiveness(socket);
        this.onFrame(socket, ev.data);
      }
    };
    // Spec says a close event follows every error, but route defensively anyway:
    // onDisconnect is idempotent per socket, so a follow-up close is a no-op.
    socket.onerror = () => this.onDisconnect(socket);
    socket.onclose = (ev: CloseEvent) => this.onDisconnect(socket, ev.code, ev.reason);
  }

  private sendHello(socket: WebSocket): void {
    const sessions: AdvertisedSession[] = [];
    for (const session of this.sessions.values()) {
      if (session.alive) sessions.push(session.toAdvertised());
    }
    this.send(socket, {
      type: "hello",
      token: this.machineToken,
      name: this.machineName,
      agentVersion: AGENT_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      sessions,
    });
    this.log("info", "hello", { sessions: sessions.length });
  }

  private onFrame(socket: WebSocket, data: unknown): void {
    const classified = classifyServerFrame(data);
    switch (classified.kind) {
      case "message":
        this.handle(socket, classified.message);
        return;
      case "unknown_type":
        this.log("info", "ignored_unknown_frame", { frameType: classified.frameType });
        return;
      case "malformed":
        // Version skew or corruption of a known frame: local state is no longer provable.
        // Close with an application protocol error and heal via the reconnect → hello path.
        this.log("warn", "malformed_frame", { detail: classified.detail });
        socket.close(4002, "malformed frame");
        return;
    }
  }

  private handle(socket: WebSocket, msg: ServerToAgentMessage): void {
    switch (msg.type) {
      case "welcome": {
        this.machineId = msg.machineId;
        this.serverEpochValue = msg.serverEpoch;
        this.attempts = 0; // handshake succeeded: reset backoff
        this.log("info", "welcome", { machineId: msg.machineId, serverEpoch: msg.serverEpoch });
        const waiters = this.welcomeWaiters;
        this.welcomeWaiters = [];
        for (const resolve of waiters) resolve();
        return;
      }
      case "create":
        this.onCreate(socket, msg);
        return;
      case "input": {
        const session = this.sessions.get(msg.sessionId);
        if (session !== undefined) session.write(Buffer.from(msg.data, "base64"));
        return;
      }
      case "resize": {
        const session = this.sessions.get(msg.sessionId);
        if (session !== undefined) session.resize(msg.cols, msg.rows);
        return;
      }
      case "kill": {
        const session = this.sessions.get(msg.sessionId);
        if (session !== undefined) void session.kill();
        return;
      }
      case "snapshot_request":
        void this.onSnapshotRequest(socket, msg.sessionId);
        return;
      case "ping":
        this.send(socket, { type: "pong" });
        return;
      default: {
        const exhaustive: never = msg;
        void exhaustive;
      }
    }
  }

  private onCreate(socket: WebSocket, msg: CreateMessage): void {
    if (this.sessions.has(msg.sessionId)) {
      // Idempotent re-create (e.g. a retried request): acknowledge the existing session.
      this.send(socket, { type: "created", sessionId: msg.sessionId });
      return;
    }
    try {
      const session = new PtySession({
        sessionId: msg.sessionId,
        cols: msg.cols,
        rows: msg.rows,
        env: msg.env,
        onOutput: (output) => this.onOutput(msg.sessionId, output),
        ...(msg.cwd !== undefined ? { cwd: msg.cwd } : {}),
        ...(this.shellCommand !== undefined ? { command: this.shellCommand } : {}),
      });
      this.sessions.set(msg.sessionId, session);
      void this.watchExit(msg.sessionId, session);
      this.send(socket, { type: "created", sessionId: msg.sessionId });
      this.log("info", "created", { sessionId: msg.sessionId, cols: msg.cols, rows: msg.rows });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.send(socket, { type: "create_error", sessionId: msg.sessionId, message });
      this.log("error", "create_error", { sessionId: msg.sessionId, message });
    }
  }

  private onOutput(sessionId: string, output: PtyOutput): void {
    // Ring + mirror were already updated inside the PtySession. Stream to the server ONLY
    // when connected; disconnected output stays in ring+mirror and heals on the next attach
    // via snapshot semantics (CONTRACTS.md). Gating here also skips base64 work while down.
    const socket = this.socket;
    if (socket === null || socket.readyState !== WebSocket.OPEN) return;
    this.send(socket, {
      type: "output",
      sessionId,
      seq: output.seq,
      data: Buffer.from(output.bytes).toString("base64"),
    });
  }

  private async onSnapshotRequest(socket: WebSocket, sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return; // unknown/dead session: server handles the absence
    try {
      const snapshot = await session.snapshot();
      // Reply only if the requesting socket is still current (a snapshot for a superseded
      // socket is moot — the server re-requests on the new connection).
      if (this.socket === socket) {
        // The mirror serialization is a UTF-16 string; the machine channel carries every
        // `data` field as base64 (CONTRACTS.md), so encode its UTF-8 bytes for the wire.
        const data = Buffer.from(snapshot.data, "utf8").toString("base64");
        this.send(socket, { type: "snapshot", sessionId, seq: snapshot.seq, data });
        this.log("info", "snapshot", { sessionId, seq: snapshot.seq });
      }
    } catch {
      // Exiting PTYs intentionally reject a marker still queued in xterm. This handler is
      // void-dispatched, and Bun treats an unhandled rejection as fatal, so log the abandon
      // and let the server's snapshot deadline + hello reconciliation resolve the dead session.
      this.log("warn", "snapshot_abandoned", { sessionId });
    }
  }

  private async watchExit(sessionId: string, session: PtySession): Promise<void> {
    const { exitCode } = await session.exited;
    // Emit `exited` if connected, then DROP the dead session from the registry (the server
    // persists status; a dropped session is simply not advertised on the next hello).
    const socket = this.socket;
    if (socket !== null && socket.readyState === WebSocket.OPEN) {
      this.send(socket, { type: "exited", sessionId, exitCode });
    }
    this.sessions.delete(sessionId);
    session.dispose();
    this.log("info", "exited", { sessionId, exitCode });
  }

  private send(socket: WebSocket, msg: AgentMessage): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(msg));
  }

  /**
   * Phantom-transport watchdog: a healthy connection carries server pings every
   * 30s even when idle, so silence past the deadline means dead TCP that nobody
   * RST (a mid-reload proxy swallowing the close is the observed case,
   * 2026-08-25). Close locally and heal via the reconnect path.
   */
  private armLiveness(socket: WebSocket): void {
    if (this.livenessTimer !== null) {
      clearTimeout(this.livenessTimer);
      this.livenessTimer = null;
    }
    this.livenessTimer = setTimeout(() => {
      this.livenessTimer = null;
      if (this.socket !== socket) return;
      this.log("warn", "liveness_timeout", { timeoutMs: this.livenessTimeoutMs });
      socket.close(4008, "server silent past deadline");
    }, this.livenessTimeoutMs);
  }

  private onDisconnect(socket: WebSocket, code?: number, reason?: string): void {
    if (this.socket !== socket) return; // stale/superseded socket
    this.socket = null;
    this.machineId = null;
    this.serverEpochValue = null;
    if (this.livenessTimer !== null) {
      clearTimeout(this.livenessTimer);
      this.livenessTimer = null;
    }
    if (code === 4409) {
      // Version-locked out: this process runs different wire code than the server.
      // Reconnecting cannot fix that — only a process restart reloads current code.
      this.log("error", "protocol_version_rejected", { code, reason });
    }
    this.log("warn", "disconnected", {
      ...(code !== undefined ? { code } : {}),
      ...(reason !== undefined && reason !== "" ? { reason } : {}),
    });
    if (!this.stopped) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    // Jittered exponential backoff capped at capMs: delay ∈ [50%, 100%] of min(cap, base·2^n).
    // Jitter spreads reconnect storms; the cap bounds worst-case latency (CONTRACTS.md).
    const ceiling = Math.min(this.capMs, this.baseMs * 2 ** this.attempts);
    const delay = ceiling * (0.5 + Math.random() * 0.5);
    this.attempts += 1;
    this.log("info", "reconnect_scheduled", { attempt: this.attempts, delayMs: Math.round(delay) });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.dial();
    }, delay);
  }
}
