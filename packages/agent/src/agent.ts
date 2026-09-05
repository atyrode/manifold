import {
  DIAL_LIVENESS_TIMEOUT_MS,
  PROTOCOL_VERSION,
  SERVER_TO_AGENT_MESSAGE_TYPES,
  ServerToAgentMessageSchema,
  defaultRuntime,
  reconnectDelayMs,
  type AgentMessage,
  type LogEvent,
  type RuntimeDeps,
  type ServerToAgentMessage,
  type TerminalHostEvent,
  type TerminalHostStatus,
} from "@manifold/protocol";
import type { AgentLogRecord, AgentLogSink } from "./log.ts";
import type { TerminalHostDialer, TerminalHostLink } from "./terminal-host-link.ts";

/**
 * The manifold-agent's single machine-channel client — the TRANSPORT half of a machine
 * (issue #278). It dials OUT to the server's `/ws/machine`, holds the machine token, and
 * bridges every frame to the TERMINAL HOST that owns the PTYs over the local seam
 * (`terminal-host-link.ts`). It owns no terminal: a transport restart, crash or failed
 * replacement ends nothing, and {@link Agent.shutdown} is the SIGTERM path precisely because
 * it kills nothing.
 *
 * This is deliberately the ONLY machine-channel state machine (mirrors the SDK's role on the
 * session channel): handshake, frame classification, reconnect/backoff, and the seat on the
 * terminal host all live here. The hub is dialled only while the seat is held — a hello with
 * an inventory this process cannot vouch for would be exactly the incident's "new agent,
 * zero terminals" — and losing the seat closes the hub socket until it is held again.
 */

/** Reported in `hello`; bump on breaking agent-side behavior. */
const AGENT_VERSION = "0.2.0";

/** Maximum queued websocket bytes before reconnect recovery replaces live streaming. */
export const MAX_SOCKET_BUFFERED_AMOUNT_BYTES = 8 * 1024 * 1024;

/** Close code the transport uses when it loses the terminal host mid-connection. */
export const TERMINAL_HOST_LOST_CLOSE_CODE = 4010;

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
  /** Connects to the terminal host; `unixTerminalHostDialer` in production, in-memory in tests. */
  readonly dialTerminalHost: TerminalHostDialer;
  /** id/clock injection (defaults to wall-clock); lets tests seed deterministic log times. */
  readonly runtime?: RuntimeDeps;
  readonly sink?: AgentLogSink;
  /** Backoff for BOTH the hub dial and the host seat; they are the same shape of retry. */
  readonly backoff?: AgentBackoffOptions;
  /** Silence deadline before the transport is declared dead (default 75s; protocol version.ts). */
  readonly livenessTimeoutMs?: number;
  /** Socket factory; DI seam (mirrors the server's RawSocket) so unit tests inject fakes. */
  readonly createSocket?: (url: string) => WebSocket;
}

/** Frame classification outcome (mirrors the SDK's terminal-channel classifier). */
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
 * reconnect. The terminal state is the host's, so reconnect re-establishes a clean channel.
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

/** The seat on the terminal host: the link plus the host identity learned on `attached`. */
interface Seat {
  readonly link: TerminalHostLink;
  readonly terminalHostId: string;
}

export class Agent {
  private readonly machineToken: string;
  private readonly machineName: string;
  private readonly wsUrl: string;
  private readonly runtime: RuntimeDeps;
  private readonly sink: AgentLogSink;
  private readonly baseMs: number;
  private readonly capMs: number;
  private readonly livenessTimeoutMs: number;
  private readonly dialTerminalHost: TerminalHostDialer;
  private readonly createSocket: (url: string) => WebSocket;

  private seat: Seat | null = null;
  /** The link whose `attach` is outstanding; becomes the seat on `attached`. */
  private pendingSeatLink: TerminalHostLink | null = null;
  private seatAttempts = 0;
  private seatTimer: Timer | null = null;
  private seatDialing = false;

  private socket: WebSocket | null = null;
  /** The socket whose hello is waiting on the host's status report, if any. */
  private helloPending: WebSocket | null = null;
  /** The socket a hello went out on; host events are bridged only once this is set. */
  private helloSent: WebSocket | null = null;
  private machineId: string | null = null;
  private serverEpochValue: string | null = null;
  private attempts = 0;
  private reconnectTimer: Timer | null = null;
  private livenessTimer: Timer | null = null;
  private stopped = false;
  private welcomeWaiters: Array<() => void> = [];
  private advertisedDeadTerminalIds: string[] = [];

  constructor(opts: AgentOptions) {
    this.machineToken = opts.machineToken;
    this.machineName = opts.machineName;
    this.wsUrl = deriveMachineWsUrl(opts.serverUrl);
    this.runtime = opts.runtime ?? defaultRuntime;
    this.sink = opts.sink ?? (() => {});
    this.baseMs = opts.backoff?.baseMs ?? 500;
    this.capMs = opts.backoff?.capMs ?? 15_000;
    this.livenessTimeoutMs = opts.livenessTimeoutMs ?? DIAL_LIVENESS_TIMEOUT_MS;
    this.dialTerminalHost = opts.dialTerminalHost;
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

  /** The terminal host whose seat this transport holds (null while unattached). */
  get terminalHostId(): string | null {
    return this.seat?.terminalHostId ?? null;
  }

  /** Takes the host seat, dials the server, and resolves once the first `welcome` arrives. */
  connect(): Promise<void> {
    this.stopped = false;
    const { promise, resolve } = Promise.withResolvers<void>();
    this.welcomeWaiters.push(resolve);
    if (this.seat === null) {
      if (!this.seatDialing && this.seatTimer === null) void this.takeSeat();
    } else if (this.socket === null && this.reconnectTimer === null) {
      this.dial();
    }
    return promise;
  }

  /**
   * Stops reconnecting, closes the hub socket and releases the host seat. This is the SIGTERM
   * path, and it kills NOTHING: every PTY stays with the terminal host for the next transport.
   */
  shutdown(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.seatTimer !== null) {
      clearTimeout(this.seatTimer);
      this.seatTimer = null;
    }
    if (this.livenessTimer !== null) {
      clearTimeout(this.livenessTimer);
      this.livenessTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    this.helloPending = null;
    this.helloSent = null;
    if (socket !== null) socket.close(1000, "shutdown");
    const seat = this.seat;
    this.seat = null;
    if (seat !== null) seat.link.close();
    const pending = this.pendingSeatLink;
    this.pendingSeatLink = null;
    if (pending !== null) pending.close();
    this.log("info", "shutdown");
    return Promise.resolve();
  }

  private log(
    level: AgentLogRecord["level"],
    evt: LogEvent,
    fields?: Record<string, unknown>,
  ): void {
    this.sink({ ts: this.runtime.now(), level, evt, ...fields });
  }

  // ---------------------------------------------------------------------------- the host seat

  private async takeSeat(): Promise<void> {
    if (this.stopped || this.seat !== null || this.seatDialing) return;
    this.seatDialing = true;
    this.log("info", "terminal_host_dialing", { attempt: this.seatAttempts });
    let link: TerminalHostLink;
    try {
      link = await this.dialTerminalHost({
        onEvent: (event) => this.onHostEvent(link, event),
        onClose: (detail) => this.onHostClosed(link, detail),
      });
    } catch (error) {
      this.seatDialing = false;
      this.log("warn", "terminal_host_unreachable", {
        message: error instanceof Error ? error.message : String(error),
      });
      this.scheduleSeatRetry();
      return;
    }
    this.seatDialing = false;
    if (this.stopped) {
      link.close();
      return;
    }
    this.pendingSeatLink = link;
    link.send({ type: "attach" });
  }

  private onHostEvent(link: TerminalHostLink, event: TerminalHostEvent): void {
    if (this.seat?.link !== link && this.pendingSeatLink !== link) return; // stale link
    switch (event.type) {
      case "attached": {
        if (this.pendingSeatLink !== link) return;
        this.pendingSeatLink = null;
        this.seat = { link, terminalHostId: event.terminalHostId };
        this.seatAttempts = 0;
        this.log("info", "terminal_host_attached", {
          terminalHostId: event.terminalHostId,
          terminals: event.terminals.length,
          draining: event.draining,
        });
        if (this.socket === null && this.reconnectTimer === null) this.dial();
        return;
      }
      case "attach_refused":
        // Incumbent wins; we are an observer here and we retry later. Never a kill.
        this.pendingSeatLink = null;
        this.log("warn", "terminal_host_refused", { reason: event.reason });
        link.close();
        this.scheduleSeatRetry();
        return;
      case "status":
        this.onHostStatus(event);
        return;
      case "shutdown_refused":
      case "shutting_down":
      case "error":
        // Answers to a maintenance client, or a refusal that the close will report.
        this.log("warn", "ignored_unknown_frame", { frameType: event.type });
        return;
      case "created":
      case "create_error":
      case "output":
      case "snapshot":
      case "exited":
      case "drain_status":
        this.bridgeToHub(event);
        return;
      default: {
        const exhaustive: never = event;
        void exhaustive;
      }
    }
  }

  private onHostClosed(link: TerminalHostLink, detail: string): void {
    if (this.pendingSeatLink === link) {
      this.pendingSeatLink = null;
      if (!this.stopped) this.scheduleSeatRetry();
      return;
    }
    if (this.seat?.link !== link) return;
    this.seat = null;
    this.log("warn", "terminal_host_lost", { detail });
    // Without the seat this process can vouch for nothing: close the hub socket now (the
    // server keeps the machine's terminals as they were) and hold reconnects until re-seated.
    const socket = this.socket;
    if (socket !== null) socket.close(TERMINAL_HOST_LOST_CLOSE_CODE, "terminal host unavailable");
    if (!this.stopped) this.scheduleSeatRetry();
  }

  private scheduleSeatRetry(): void {
    if (this.stopped || this.seatTimer !== null) return;
    const delay = reconnectDelayMs(this.seatAttempts, this.baseMs, this.capMs);
    this.seatAttempts += 1;
    this.log("info", "reconnect_scheduled", {
      target: "terminal_host",
      attempt: this.seatAttempts,
      delayMs: Math.round(delay),
    });
    this.seatTimer = setTimeout(() => {
      this.seatTimer = null;
      void this.takeSeat();
    }, delay);
  }

  // ---------------------------------------------------------------------------- the hub socket

  private dial(): void {
    if (this.stopped || this.seat === null) return;
    const socket = this.createSocket(this.wsUrl);
    this.socket = socket;
    this.log("info", "dialing", { attempt: this.attempts });
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.armLiveness(socket);
      // The hello's inventory is the HOST's, read fresh for every socket: a terminal may have
      // exited since the last report, and a stale advertisement is a lie the hub acts on.
      this.helloPending = socket;
      this.seat?.link.send({ type: "status_request" });
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

  private onHostStatus(status: TerminalHostStatus): void {
    const socket = this.helloPending;
    if (socket === null || this.socket !== socket) return;
    this.helloPending = null;
    if (socket.readyState !== WebSocket.OPEN) return;
    const seat = this.seat;
    if (seat === null) return;
    this.advertisedDeadTerminalIds = [];
    for (const terminal of status.terminals) {
      if (!terminal.alive) this.advertisedDeadTerminalIds.push(terminal.terminalId);
    }
    this.send(socket, {
      type: "hello",
      token: this.machineToken,
      name: this.machineName,
      agentVersion: AGENT_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      terminals: status.terminals,
      terminalHostId: seat.terminalHostId,
    });
    this.helloSent = socket;
    this.log("info", "hello", {
      terminals: status.terminals.length,
      terminalHostId: seat.terminalHostId,
    });
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
        // The hub has now seen every exit this hello advertised: acknowledge them so the host
        // forgets the records. A terminal that exits after the report stays for the next one.
        const seat = this.seat;
        if (seat !== null) {
          for (const terminalId of this.advertisedDeadTerminalIds) {
            seat.link.send({ type: "kill", terminalId });
          }
        }
        this.advertisedDeadTerminalIds = [];
        this.log("info", "welcome", { machineId: msg.machineId, serverEpoch: msg.serverEpoch });
        const waiters = this.welcomeWaiters;
        this.welcomeWaiters = [];
        for (const resolve of waiters) resolve();
        return;
      }
      case "ping":
        this.send(socket, { type: "pong" });
        return;
      case "create":
      case "input":
      case "resize":
      case "kill":
      case "snapshot_request":
      case "drain":
        this.seat?.link.send(msg);
        return;
      default: {
        const exhaustive: never = msg;
        void exhaustive;
      }
    }
  }

  /** Host → hub, once a hello is out on the current socket; otherwise the host retains it. */
  private bridgeToHub(
    event: Extract<
      TerminalHostEvent,
      { type: "created" | "create_error" | "output" | "snapshot" | "exited" | "drain_status" }
    >,
  ): void {
    const socket = this.socket;
    if (socket === null || this.helloSent !== socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    if (event.type === "output") {
      // A websocket queue above 8 MiB is treated as a sick transport. The host retains 2 MiB
      // per terminal, so this tolerates several busy terminals before reconnect recovery takes
      // over, while still bounding duplicate buffering in the websocket implementation.
      if (socket.bufferedAmount > MAX_SOCKET_BUFFERED_AMOUNT_BYTES) {
        this.log("warn", "socket_backpressure", {
          bufferedAmount: socket.bufferedAmount,
          capBytes: MAX_SOCKET_BUFFERED_AMOUNT_BYTES,
        });
        socket.close(4009, "outbound buffer exceeded");
        return;
      }
    }
    this.send(socket, event);
    if (event.type === "exited") {
      // Delivered: acknowledge so the host drops the record (its `kill` on a dead terminal).
      this.seat?.link.send({ type: "kill", terminalId: event.terminalId });
    }
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
    if (this.helloPending === socket) this.helloPending = null;
    if (this.helloSent === socket) this.helloSent = null;
    this.machineId = null;
    this.serverEpochValue = null;
    this.advertisedDeadTerminalIds = [];
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
    // Without the seat the retry would be a hello we cannot back; re-seating dials instead.
    if (!this.stopped && this.seat !== null) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    const delay = reconnectDelayMs(this.attempts, this.baseMs, this.capMs);
    this.attempts += 1;
    this.log("info", "reconnect_scheduled", {
      target: "hub",
      attempt: this.attempts,
      delayMs: Math.round(delay),
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.dial();
    }, delay);
  }
}
