import {
  TERMINAL_HOST_COMMAND_TYPES,
  TERMINAL_HOST_PROTOCOL_VERSION,
  TerminalHostCommandSchema,
  defaultRuntime,
  type AdvertisedTerminal,
  type LogEvent,
  type RuntimeDeps,
  type TerminalHostCommand,
  type TerminalHostErrorCode,
  type TerminalHostEvent,
  type TerminalHostStatus,
} from "@manifold/protocol";
import type { AgentLogRecord, AgentLogSink } from "./log.ts";
import { PtyTerminal, type PtyOutput } from "./terminal.ts";

/**
 * THE TERMINAL HOST (issue #278): the process that owns every PTY on a machine and nothing
 * else. It holds no hub token and dials nothing; it answers the machine's terminal commands
 * over the local IPC seam (`@manifold/protocol` terminal-host.ts) for whichever transport
 * currently holds the single seat, and keeps every ring, mirror and output sequence in memory
 * exactly as the single-process agent did — so a transport restart, crash or failed
 * replacement is invisible to the shells.
 *
 * Two things here are deliberately NOT convenient:
 *
 * - Admission is a latch. `drain` closes it and it stays closed across transport restarts,
 *   because the hub's atomic drain contract needs "nothing new was admitted since you asked"
 *   to hold regardless of which transport is asking.
 * - Stopping is either MAINTENANCE (`shutdown_request`: refused unless drained and empty,
 *   decided in the same synchronous step as admission) or DESTRUCTIVE ({@link TerminalHost.shutdown},
 *   the SIGTERM path, which kills the shells with the old grace/escalation). There is no
 *   "drain and then kill what is left" in between; that is the operator's separate decision.
 */

/** Grace allowed for normal PTY termination before destructive shutdown escalates to SIGKILL. */
export const SHUTDOWN_GRACE_MS = 3_000;

const KNOWN_COMMAND_TYPES: Record<string, true> = Object.fromEntries(
  TERMINAL_HOST_COMMAND_TYPES.map((type): [string, true] => [type, true]),
);

/** How a host reaches one connected peer; the socket layer (or a test) provides it. */
export interface TerminalHostPeer {
  /** Writes one event; false when the peer's queue overflowed and the connection is being cut. */
  write(event: TerminalHostEvent): boolean;
  /** Closes the connection; the host's `detach` is called back by the socket layer. */
  close(): void;
}

/** A host's end of one connection; the socket layer calls it per frame and on close. */
export interface TerminalHostSession {
  /** Delivers one already-decoded JSON value; the host validates it. */
  deliver(raw: unknown): void;
  /** The peer went away (or was cut); releases the seat if this connection held it. */
  detach(): void;
}

interface Connection {
  readonly peer: TerminalHostPeer;
  attached: boolean;
  closed: boolean;
}

/** Construction inputs for a {@link TerminalHost}. */
export interface TerminalHostOptions {
  readonly sink?: AgentLogSink;
  readonly runtime?: RuntimeDeps;
  /** Shell argv for spawned PTYs; DI seam so tests pin a deterministic shell. */
  readonly shellCommand?: readonly string[];
  /** Grace before destructive shutdown escalates PTYs to SIGKILL; defaults to 3 seconds. */
  readonly shutdownGraceMs?: number;
  /** Reported in status as the running code; main.ts passes `MANIFOLD_BUILD`. */
  readonly build?: string;
  /** Called after a `shutdown_request` was accepted; main.ts exits the process. */
  readonly onMaintenanceShutdown?: () => void;
}

export class TerminalHost {
  /** In-memory identity, stable for the life of this process; a fresh host is a fresh id. */
  readonly terminalHostId: string;

  private readonly terminals = new Map<string, PtyTerminal>();
  private readonly connections = new Set<Connection>();
  private transport: Connection | null = null;
  private draining = false;
  private stopping = false;
  private readonly sink: AgentLogSink;
  private readonly runtime: RuntimeDeps;
  private readonly shellCommand: readonly string[] | undefined;
  private readonly shutdownGraceMs: number;
  private readonly build: string;
  private readonly onMaintenanceShutdown: () => void;

  constructor(opts: TerminalHostOptions = {}) {
    this.runtime = opts.runtime ?? defaultRuntime;
    this.terminalHostId = this.runtime.newId();
    this.sink = opts.sink ?? (() => {});
    this.shellCommand = opts.shellCommand;
    this.shutdownGraceMs = opts.shutdownGraceMs ?? SHUTDOWN_GRACE_MS;
    this.build = opts.build ?? "unknown";
    this.onMaintenanceShutdown = opts.onMaintenanceShutdown ?? (() => {});
  }

  /** Count of retained terminal records: live PTYs plus exits nobody has acknowledged. */
  get terminalCount(): number {
    return this.terminals.size;
  }

  /** Whether admission is latched closed. */
  get isDraining(): boolean {
    return this.draining;
  }

  /** Whether a transport currently holds the seat. */
  get transportAttached(): boolean {
    return this.transport !== null;
  }

  /** The read-only report, as any connection receives it for `status_request`. */
  status(): TerminalHostStatus {
    return {
      type: "status",
      terminalHostId: this.terminalHostId,
      terminalHostProtocolVersion: TERMINAL_HOST_PROTOCOL_VERSION,
      build: this.build,
      pid: process.pid,
      draining: this.draining,
      transportAttached: this.transport !== null,
      terminals: this.inventory(),
    };
  }

  /** Accepts one connection. Every connection starts as an observer; `attach` claims the seat. */
  open(peer: TerminalHostPeer): TerminalHostSession {
    const connection: Connection = { peer, attached: false, closed: false };
    this.connections.add(connection);
    return {
      deliver: (raw) => this.deliver(connection, raw),
      detach: () => this.detach(connection),
    };
  }

  /**
   * DESTRUCTIVE: kills every PTY (grace, then SIGKILL) and drops every connection. This is the
   * host's SIGTERM path and the only way a live terminal is ended without a hub `kill`.
   */
  async shutdown(): Promise<void> {
    this.stopping = true;
    const terminals = [...this.terminals.values()];
    const kills = terminals.map((terminal) => terminal.kill());
    let graceTimer: Timer | undefined;
    await Promise.race([
      Promise.all(kills),
      new Promise<void>((resolve) => {
        graceTimer = setTimeout(resolve, this.shutdownGraceMs);
      }),
    ]);
    clearTimeout(graceTimer);
    for (const terminal of terminals) {
      if (terminal.alive) terminal.forceKill();
    }
    await Promise.all(kills);
    for (const terminal of terminals) terminal.dispose();
    this.terminals.clear();
    for (const connection of [...this.connections]) this.cut(connection);
    this.log("info", "shutdown", { terminals: terminals.length });
  }

  private log(
    level: AgentLogRecord["level"],
    evt: LogEvent,
    fields?: Record<string, unknown>,
  ): void {
    this.sink({ ts: this.runtime.now(), level, evt, ...fields });
  }

  private inventory(): AdvertisedTerminal[] {
    const terminals: AdvertisedTerminal[] = [];
    for (const terminal of this.terminals.values()) terminals.push(terminal.toAdvertised());
    return terminals;
  }

  private liveTerminalIds(): string[] {
    const ids: string[] = [];
    for (const [terminalId, terminal] of this.terminals) {
      if (terminal.alive) ids.push(terminalId);
    }
    return ids;
  }

  /** Sends the seam's own refusal, then cuts the connection. */
  private refuse(connection: Connection, code: TerminalHostErrorCode, detail?: string): void {
    this.log("warn", "terminal_host_refused_frame", { code, ...(detail ? { detail } : {}) });
    connection.peer.write({ type: "error", code, ...(detail !== undefined ? { detail } : {}) });
    this.cut(connection);
  }

  private cut(connection: Connection): void {
    if (connection.closed) return;
    this.detach(connection);
    connection.peer.close();
  }

  private detach(connection: Connection): void {
    if (connection.closed) return;
    connection.closed = true;
    this.connections.delete(connection);
    if (this.transport === connection) {
      this.transport = null;
      this.log("info", "transport_detached", { terminals: this.terminals.size });
    }
  }

  private deliver(connection: Connection, raw: unknown): void {
    if (connection.closed || this.stopping) return;
    if (raw === null || typeof raw !== "object" || typeof Reflect.get(raw, "type") !== "string") {
      this.refuse(connection, "malformed_frame", "missing type discriminator");
      return;
    }
    const frameType = Reflect.get(raw, "type") as string;
    if (KNOWN_COMMAND_TYPES[frameType] !== true) {
      // A newer transport on an older host: forward-compat ignore, as the hub wire does.
      this.log("info", "ignored_unknown_frame", { frameType });
      return;
    }
    const parsed = TerminalHostCommandSchema.safeParse(raw);
    if (!parsed.success) {
      this.refuse(connection, "malformed_frame", `invalid ${frameType} frame`);
      return;
    }
    this.handle(connection, parsed.data);
  }

  private handle(connection: Connection, command: TerminalHostCommand): void {
    switch (command.type) {
      case "status_request":
        connection.peer.write(this.status());
        return;
      case "attach":
        this.onAttach(connection);
        return;
      case "shutdown_request":
        this.onShutdownRequest(connection);
        return;
      case "create":
      case "input":
      case "resize":
      case "kill":
      case "snapshot_request":
      case "drain":
        if (this.transport !== connection) {
          this.refuse(
            connection,
            "not_attached",
            `${command.type} from a connection without the seat`,
          );
          return;
        }
        this.handleMachineCommand(connection, command);
        return;
      default: {
        const exhaustive: never = command;
        void exhaustive;
      }
    }
  }

  private onAttach(connection: Connection): void {
    if (this.transport !== null && this.transport !== connection) {
      // Incumbent wins. The newcomer stays an observer and must retry later; it never
      // supersedes a live seat, because "two transports" is exactly the incident's shape.
      this.log("warn", "transport_refused", { reason: "transport_attached" });
      connection.peer.write({ type: "attach_refused", reason: "transport_attached" });
      return;
    }
    this.transport = connection;
    connection.attached = true;
    this.log("info", "transport_attached", {
      terminals: this.terminals.size,
      draining: this.draining,
    });
    connection.peer.write({
      type: "attached",
      terminalHostId: this.terminalHostId,
      draining: this.draining,
      terminals: this.inventory(),
    });
  }

  /**
   * Maintenance stop: legal only when admission is latched closed AND nothing is retained.
   * Decided synchronously here — the same turn a `create` would be admitted in — so the
   * answer cannot go stale between the check and the exit.
   */
  private onShutdownRequest(connection: Connection): void {
    if (!this.draining) {
      this.log("warn", "terminal_host_shutdown_refused", { reason: "not_draining" });
      connection.peer.write({ type: "shutdown_refused", reason: "not_draining", terminalIds: [] });
      return;
    }
    if (this.terminals.size > 0) {
      const terminalIds = [...this.terminals.keys()];
      this.log("warn", "terminal_host_shutdown_refused", {
        reason: "terminals_retained",
        terminals: terminalIds.length,
      });
      connection.peer.write({
        type: "shutdown_refused",
        reason: "terminals_retained",
        terminalIds,
      });
      return;
    }
    this.stopping = true;
    this.log("info", "terminal_host_shutdown_accepted", {});
    connection.peer.write({ type: "shutting_down", terminalHostId: this.terminalHostId });
    for (const other of [...this.connections]) this.cut(other);
    this.onMaintenanceShutdown();
  }

  private handleMachineCommand(
    connection: Connection,
    command: Exclude<
      TerminalHostCommand,
      { type: "attach" | "status_request" | "shutdown_request" }
    >,
  ): void {
    switch (command.type) {
      case "create":
        this.onCreate(connection, command);
        return;
      case "input": {
        const terminal = this.terminals.get(command.terminalId);
        if (terminal !== undefined && terminal.alive) {
          terminal.write(Buffer.from(command.data, "base64"));
        }
        return;
      }
      case "resize": {
        const terminal = this.terminals.get(command.terminalId);
        if (terminal !== undefined && terminal.alive) terminal.resize(command.cols, command.rows);
        return;
      }
      case "kill": {
        // Live: end it (the exit event follows). Dead: the transport has acknowledged the
        // exit on the hub's behalf, so the retained record can go.
        const terminal = this.terminals.get(command.terminalId);
        if (terminal === undefined) return;
        if (terminal.alive) {
          void terminal.kill();
        } else {
          this.terminals.delete(command.terminalId);
          terminal.dispose();
        }
        return;
      }
      case "snapshot_request":
        void this.onSnapshotRequest(connection, command.terminalId);
        return;
      case "drain":
        this.draining = command.draining;
        this.log("info", "drain", { draining: command.draining, requestId: command.requestId });
        connection.peer.write({
          type: "drain_status",
          requestId: command.requestId,
          terminalHostId: this.terminalHostId,
          draining: this.draining,
          terminalIds: this.liveTerminalIds(),
        });
        return;
      default: {
        const exhaustive: never = command;
        void exhaustive;
      }
    }
  }

  private onCreate(
    connection: Connection,
    msg: Extract<TerminalHostCommand, { type: "create" }>,
  ): void {
    if (this.terminals.has(msg.terminalId)) {
      // Idempotent re-create (e.g. a retried request): acknowledge the existing terminal.
      connection.peer.write({ type: "created", terminalId: msg.terminalId });
      return;
    }
    if (this.draining) {
      // The latch: refused by name, in the same synchronous step that would have admitted it.
      const message = "terminal host draining";
      connection.peer.write({ type: "create_error", terminalId: msg.terminalId, message });
      this.log("warn", "create_error", { terminalId: msg.terminalId, message });
      return;
    }
    // A program named by the opener execs in place of the shell — the pinned test shell
    // included, since a test that names a program means that program (issue #192).
    const command = msg.program?.argv ?? this.shellCommand;
    try {
      const terminal = new PtyTerminal({
        terminalId: msg.terminalId,
        cols: msg.cols,
        rows: msg.rows,
        env: msg.env,
        onOutput: (output) => this.onOutput(msg.terminalId, output),
        ...(msg.cwd !== undefined ? { cwd: msg.cwd } : {}),
        ...(command !== undefined ? { command } : {}),
      });
      this.terminals.set(msg.terminalId, terminal);
      void this.watchExit(msg.terminalId, terminal);
      connection.peer.write({ type: "created", terminalId: msg.terminalId });
      this.log("info", "created", { terminalId: msg.terminalId, cols: msg.cols, rows: msg.rows });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      connection.peer.write({ type: "create_error", terminalId: msg.terminalId, message });
      this.log("error", "create_error", { terminalId: msg.terminalId, message });
    }
  }

  private onOutput(terminalId: string, output: PtyOutput): void {
    // Ring + mirror were already updated inside the PtyTerminal. Stream to the transport ONLY
    // while one holds the seat; output produced with no transport stays in ring+mirror and
    // heals on the next hub attach via snapshot semantics (CONTRACTS.md §attach).
    const transport = this.transport;
    if (transport === null) return;
    transport.peer.write({
      type: "output",
      terminalId,
      seq: output.seq,
      data: Buffer.from(output.bytes).toString("base64"),
    });
  }

  private async onSnapshotRequest(connection: Connection, terminalId: string): Promise<void> {
    const terminal = this.terminals.get(terminalId);
    if (terminal === undefined) return; // unknown/dead terminal: the hub handles the absence
    try {
      const snapshot = await terminal.snapshot();
      // One frame carries (seq, data): the tuple is atomic on the seam. Reply only if the
      // requesting transport still holds the seat — a successor re-requests on its own hello.
      if (this.transport === connection) {
        const data = Buffer.from(snapshot.data, "utf8").toString("base64");
        connection.peer.write({ type: "snapshot", terminalId, seq: snapshot.seq, data });
        this.log("info", "snapshot", { terminalId, seq: snapshot.seq });
      }
    } catch {
      // Exiting PTYs intentionally reject a marker still queued in xterm; log the abandon and
      // let the hub's snapshot deadline + hello reconciliation resolve the dead terminal.
      this.log("warn", "snapshot_abandoned", { terminalId });
    }
  }

  private async watchExit(terminalId: string, terminal: PtyTerminal): Promise<void> {
    const { exitCode } = await terminal.exited;
    if (this.terminals.get(terminalId) !== terminal) return; // already forgotten
    // The record is RETAINED (alive:false + exit code) until a transport acknowledges it with
    // `kill`: an attached transport does so once the hub has the `exited`; a transport that
    // attaches later advertises it dead in its hello and acknowledges on welcome.
    const transport = this.transport;
    if (transport !== null) transport.peer.write({ type: "exited", terminalId, exitCode });
    this.log("info", "exited", { terminalId, exitCode });
  }
}
