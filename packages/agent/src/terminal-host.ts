import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
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
import type { MachineJobOwner } from "./job-owner.ts";
import type { OomKillWatch } from "./oom-kills.ts";
import { startLinuxJob, LinuxJobRefusal } from "./job-linux.ts";
import { jobDigest } from "./job-journal.ts";

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

type CreateCommand = Extract<TerminalHostCommand, { type: "create" }>;
interface LaunchRecipe {
  readonly create: CreateCommand;
  readonly command?: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
  readonly cwd?: string;
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
  /** The independently supervised native job owner in this host process. */
  readonly jobOwner?: MachineJobOwner;
  /** This host's cgroup OOM-kill observations; absent, a destructive stop is `owner_stopped`. */
  readonly oomKills?: OomKillWatch;
}

export class TerminalHost {
  /** In-memory identity, stable for the life of this process; a fresh host is a fresh id. */
  readonly terminalHostId: string;

  private readonly terminals = new Map<string, PtyTerminal>();
  private readonly recipes = new Map<string, LaunchRecipe>();
  private readonly restarting = new Set<string>();
  private readonly failedRestarts = new WeakSet<PtyTerminal>();
  private readonly cancelledRestarts = new Set<string>();
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
  private readonly jobOwner: MachineJobOwner | undefined;
  private readonly oomKills: OomKillWatch | undefined;

  constructor(opts: TerminalHostOptions = {}) {
    this.runtime = opts.runtime ?? defaultRuntime;
    this.terminalHostId = this.runtime.newId();
    this.sink = opts.sink ?? (() => {});
    this.shellCommand = opts.shellCommand;
    this.shutdownGraceMs = opts.shutdownGraceMs ?? SHUTDOWN_GRACE_MS;
    this.build = opts.build ?? "unknown";
    this.onMaintenanceShutdown = opts.onMaintenanceShutdown ?? (() => {});
    this.jobOwner = opts.jobOwner;
    this.oomKills = opts.oomKills;
    this.jobOwner?.bindTerminalHost(this.terminalHostId);
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
      terminalExecution: this.jobOwner ? "governed" : "unconfined",
      terminalRestart: true,
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
   * host's SIGTERM path and the only way a live terminal is ended without a hub `kill`. The
   * seated transport is told why first, so the exits it forwards name the owner's stop.
   */
  async shutdown(): Promise<void> {
    this.stopping = true;
    const reason = this.oomKills?.killedRecently() ? "owner_oom_stopped" : "owner_stopped";
    this.transport?.peer.write({ type: "destructive_stop", reason });
    const terminals = [...this.terminals.values()];
    const kills = terminals.map(async (terminal) => {
      try {
        await terminal.kill();
      } catch (error) {
        if (!terminal.workloadEmpty) throw error;
      }
    });
    let graceTimer: Timer | undefined;
    try {
      await Promise.race([
        Promise.all(kills),
        new Promise<void>((resolve) => {
          graceTimer = setTimeout(resolve, this.shutdownGraceMs);
        }),
      ]);
    } finally {
      clearTimeout(graceTimer);
    }
    for (const terminal of terminals) {
      if (terminal.alive) terminal.forceKill();
    }
    await Promise.all(kills);
    for (const terminal of terminals) terminal.dispose();
    this.terminals.clear();
    this.recipes.clear();
    for (const connection of [...this.connections]) this.cut(connection);
    this.log("info", "shutdown", { terminals: terminals.length, reason });
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
    for (const terminal of this.terminals.values()) {
      const advertised = terminal.toAdvertised();
      if (this.failedRestarts.has(terminal)) advertised.exitCode = null;
      terminals.push(advertised);
    }
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
      case "terminal_restart":
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
    if (this.jobOwner && !this.jobOwner.maintenanceReady) {
      connection.peer.write({ type: "shutdown_refused", reason: "jobs_retained", terminalIds: [] });
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
        void this.onCreate(connection, command);
        return;
      case "terminal_restart":
        void this.onRestart(connection, command);
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
        if (this.restarting.has(command.terminalId)) {
          this.cancelledRestarts.add(command.terminalId);
          return;
        }
        if (terminal === undefined) return;
        if (terminal.alive) {
          void terminal.kill().catch(() => {
            this.log("warn", "terminal_empty_unproven", { terminalId: command.terminalId });
          });
        } else if (terminal.workloadEmpty) {
          this.terminals.delete(command.terminalId);
          this.recipes.delete(command.terminalId);
          terminal.dispose();
        }
        return;
      }
      case "snapshot_request":
        void this.onSnapshotRequest(connection, command.terminalId);
        return;
      case "drain":
        this.jobOwner?.setDraining(command.draining);
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

  private async onCreate(connection: Connection, msg: CreateCommand): Promise<void> {
    if (this.jobOwner && !msg.runtime) {
      connection.peer.write({
        type: "create_error",
        terminalId: msg.terminalId,
        message: "terminal_runtime_required",
      });
      return;
    }
    if (this.terminals.has(msg.terminalId)) {
      if (msg.runtime) {
        connection.peer.write({
          type: "create_error",
          terminalId: msg.terminalId,
          message: "terminal_admission_reused",
        });
      } else {
        connection.peer.write({ type: "created", terminalId: msg.terminalId });
      }
      return;
    }
    if (this.draining) {
      const message = "terminal host draining";
      connection.peer.write({ type: "create_error", terminalId: msg.terminalId, message });
      this.log("warn", "create_error", { terminalId: msg.terminalId, message });
      return;
    }
    try {
      const spawned = this.spawnTerminal(msg);
      const terminal = spawned instanceof PtyTerminal ? spawned : await spawned;
      this.rememberLaunch(msg, terminal);
      connection.peer.write({ type: "created", terminalId: msg.terminalId });
      this.watchReadiness(msg.terminalId, terminal);
      void this.watchExit(msg.terminalId, terminal);
      this.log("info", "created", { terminalId: msg.terminalId, cols: msg.cols, rows: msg.rows });
    } catch (error) {
      const message = msg.runtime
        ? "terminal_runtime_refused"
        : error instanceof Error
          ? error.message
          : String(error);
      connection.peer.write({ type: "create_error", terminalId: msg.terminalId, message });
      this.log("error", "create_error", { terminalId: msg.terminalId, message });
    }
  }

  private rememberLaunch(msg: CreateCommand, terminal: PtyTerminal): void {
    const cwd = msg.cwd ?? terminal.launchCwd;
    this.recipes.set(msg.terminalId, {
      create: msg,
      ...(terminal.originalCommand ? { command: terminal.originalCommand } : {}),
      ...(terminal.originalEnvironment ? { environment: terminal.originalEnvironment } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
    });
  }

  private spawnTerminal(
    msg: CreateCommand,
    recipe?: LaunchRecipe,
    restartCwd?: string,
  ): PtyTerminal | Promise<PtyTerminal> {
    let terminal: PtyTerminal | undefined;
    const callbacks = {
      onOutput: (output: PtyOutput) => this.onOutput(msg.terminalId, output),
      onCwd: (cwd: string) => {
        if (!this.restarting.has(msg.terminalId))
          this.transport?.peer.write({ type: "terminal_cwd", terminalId: msg.terminalId, cwd });
      },
    };
    if (msg.runtime) {
      return (async () => {
        try {
          if (!this.jobOwner || msg.program || msg.cwd !== undefined || Object.keys(msg.env).length)
            throw new Error("terminal_runtime_host_or_overrides_refused");
          await this.jobOwner.startTerminal(
            msg.runtime!,
            msg.terminalId,
            this.terminalHostId,
            (spec) => {
              try {
                terminal = new PtyTerminal({
                  terminalId: msg.terminalId,
                  cols: msg.cols,
                  rows: msg.rows,
                  ...callbacks,
                  ...(restartCwd !== undefined ? { restartCwd } : {}),
                  runtime: (pty) => startLinuxJob({ ...spec, terminal: pty }),
                });
              } catch {
                throw new LinuxJobRefusal(
                  "terminal-allocation-failed",
                  "terminal-allocation-failed",
                  true,
                );
              }
              this.terminals.set(msg.terminalId, terminal);
              return terminal.runtimeHandle!;
            },
          );
          if (!terminal || this.stopping) {
            await terminal?.kill();
            throw new Error("terminal_runtime_start_interrupted");
          }
          return terminal;
        } catch (error) {
          if (terminal) {
            await terminal.kill().catch(() => {});
            if (terminal.workloadEmpty) {
              terminal.dispose();
              if (this.terminals.get(msg.terminalId) === terminal)
                this.terminals.delete(msg.terminalId);
            } else {
              this.draining = true;
              this.jobOwner?.setDraining(true);
            }
          }
          throw error;
        }
      })();
    }
    if (this.jobOwner) throw new Error("terminal_runtime_required");
    const command = recipe?.command ?? msg.program?.argv ?? this.shellCommand;
    const environment = recipe?.environment ? { ...recipe.environment } : undefined;
    if (environment) {
      for (const name of [
        "MANIFOLD_URL",
        "MANIFOLD_CONTAINER",
        "MANIFOLD_ELEMENT",
        "MANIFOLD_TOKEN",
      ]) {
        if (msg.env[name] !== undefined) environment[name] = msg.env[name]!;
      }
    }
    terminal = new PtyTerminal({
      terminalId: msg.terminalId,
      cols: msg.cols,
      rows: msg.rows,
      env: msg.env,
      ...callbacks,
      ...(msg.cwd !== undefined ? { cwd: msg.cwd } : {}),
      ...(command !== undefined ? { command } : {}),
      ...(environment ? { environment } : {}),
    });
    this.terminals.set(msg.terminalId, terminal);
    return terminal;
  }

  private async onRestart(
    connection: Connection,
    msg: Extract<TerminalHostCommand, { type: "terminal_restart" }>,
  ): Promise<void> {
    const refuse = (reason: string) =>
      connection.peer.write({ type: "terminal_restart_error", terminalId: msg.terminalId, reason });
    if (this.draining) {
      refuse("draining");
      return;
    }
    if (this.restarting.has(msg.terminalId)) {
      refuse("restart_pending");
      return;
    }
    const previous = this.terminals.get(msg.terminalId);
    const recipe = this.recipes.get(msg.terminalId);
    const noRecipe = msg.noRecipe === true && recipe === undefined;
    if (noRecipe && this.jobOwner) {
      refuse("no_recipe");
      return;
    }
    const supplied =
      msg.create && noRecipe
        ? { cols: msg.create.cols, rows: msg.create.rows, env: msg.create.env }
        : msg.create;
    const create: CreateCommand | undefined =
      recipe?.create ??
      (supplied ? { ...supplied, type: "create", terminalId: msg.terminalId } : undefined);
    if (!create) {
      refuse("launch_recipe_unavailable");
      return;
    }
    let runtime = create.runtime;
    if (runtime || this.jobOwner) {
      const fresh = msg.create?.runtime;
      if (!fresh) {
        refuse("terminal_runtime_required");
        return;
      }
      if (recipe?.create.runtime) {
        const old = recipe.create.runtime.request;
        const next = fresh.request;
        if (
          old.jobId === next.jobId ||
          old.machineId !== next.machineId ||
          jobDigest(old.terminal ?? null) !== jobDigest(next.terminal ?? null) ||
          old.pluginId !== next.pluginId ||
          old.operationId !== next.operationId ||
          old.installationRevision !== next.installationRevision ||
          old.artifactSha256 !== next.artifactSha256 ||
          // A run's launcher may change input to resume, but only a fresh signed admission
          // for this exact binding reaches startTerminal below. Ordinary recipes stay exact.
          (!old.terminal?.runId && jobDigest(old.input) !== jobDigest(next.input)) ||
          jobDigest(old.resourceBindings ?? null) !== jobDigest(next.resourceBindings ?? null)
        ) {
          refuse("terminal_runtime_changed");
          return;
        }
      }
      runtime = fresh;
    }
    const preferred = previous?.sampleCwd() ?? msg.cwd;
    let cwd = preferred ?? recipe?.cwd ?? create.cwd ?? homedir();
    let fallback: "original" | "home" | undefined;
    if (!runtime) {
      const candidates = [
        { cwd, fallback: undefined },
        { cwd: recipe?.cwd ?? create.cwd ?? homedir(), fallback: "original" as const },
        {
          cwd: recipe?.environment?.HOME ?? create.env.HOME ?? homedir(),
          fallback: "home" as const,
        },
      ];
      const selected = candidates.find((candidate) => {
        try {
          accessSync(candidate.cwd, constants.X_OK);
          return statSync(candidate.cwd).isDirectory();
        } catch {
          return false;
        }
      });
      if (!selected) {
        refuse("cwd_unavailable");
        return;
      }
      ({ cwd, fallback } = selected);
    }
    this.restarting.add(msg.terminalId);
    let replacement: PtyTerminal | undefined;
    try {
      if (previous) {
        const killed = previous.kill();
        let timer: Timer | undefined;
        try {
          await Promise.race([
            killed,
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, this.shutdownGraceMs);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
        if (previous.alive) previous.forceKill();
        await killed;
        if (!previous.workloadEmpty) throw new Error("terminal_empty_unproven");
      }
      if (this.stopping || this.draining || this.cancelledRestarts.has(msg.terminalId))
        throw new Error("restart_interrupted");
      const dimensions = previous?.toAdvertised();
      const next: CreateCommand = {
        ...create,
        cols: dimensions?.cols ?? create.cols,
        rows: dimensions?.rows ?? create.rows,
        ...(runtime ? { runtime } : { cwd }),
        env: runtime ? create.env : (msg.create?.env ?? create.env),
      };
      replacement = await this.spawnTerminal(next, recipe, preferred);
      if (this.stopping || this.cancelledRestarts.has(msg.terminalId)) {
        await replacement.kill();
        throw new Error("restart_interrupted");
      }
      if (!recipe) this.rememberLaunch(create, replacement);
      previous?.dispose();
      this.restarting.delete(msg.terminalId);
      const observed = replacement.sampleCwd() ?? replacement.launchCwd;
      const restartedFallback = noRecipe ? "no_recipe" : (replacement.restartFallback ?? fallback);
      connection.peer.write({
        type: "terminal_restarted",
        terminalId: msg.terminalId,
        ...(observed !== undefined ? { cwd: observed } : {}),
        ...(restartedFallback !== undefined ? { fallback: restartedFallback } : {}),
      });
      this.watchReadiness(msg.terminalId, replacement);
      void this.watchExit(msg.terminalId, replacement);
    } catch (error) {
      if (replacement?.workloadEmpty) replacement.dispose();
      if (
        previous &&
        (!this.terminals.has(msg.terminalId) || this.terminals.get(msg.terminalId) === replacement)
      )
        this.terminals.set(msg.terminalId, previous);
      this.restarting.delete(msg.terminalId);
      if (previous && !previous.alive && this.terminals.get(msg.terminalId) === previous) {
        // A failed replacement is not the old program's natural completion. Retain unknown
        // evidence here and in reconnect inventory, even if the requested stop exited zero.
        this.failedRestarts.add(previous);
        connection.peer.write({
          type: "exited",
          terminalId: msg.terminalId,
          exitCode: null,
        });
      }
      refuse(error instanceof Error ? error.message : "restart_failed");
    } finally {
      this.restarting.delete(msg.terminalId);
      this.cancelledRestarts.delete(msg.terminalId);
    }
  }

  private watchReadiness(terminalId: string, terminal: PtyTerminal): void {
    void terminal.readiness.then((readiness) => {
      if (this.terminals.get(terminalId) !== terminal || this.restarting.has(terminalId)) return;
      this.transport?.peer.write({ type: "terminal_ready", terminalId, readiness });
    });
  }

  private onOutput(terminalId: string, output: PtyOutput): void {
    if (this.restarting.has(terminalId)) return;
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
    if (terminal === undefined || this.restarting.has(terminalId)) return;
    try {
      const snapshot = await terminal.snapshot();
      // One frame carries (seq, data): the tuple is atomic on the seam. Reply only if the
      // requesting transport still holds the seat — a successor re-requests on its own hello.
      if (
        this.transport === connection &&
        this.terminals.get(terminalId) === terminal &&
        !this.restarting.has(terminalId)
      ) {
        const data = Buffer.from(
          snapshot.data.buffer,
          snapshot.data.byteOffset,
          snapshot.data.byteLength,
        ).toString("base64");
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
    let exitCode: number | null;
    try {
      ({ exitCode } = await terminal.exited);
    } catch {
      this.draining = true;
      this.jobOwner?.setDraining(true);
      this.log("warn", "terminal_empty_unproven", { terminalId });
      return;
    }
    if (this.terminals.get(terminalId) !== terminal || this.restarting.has(terminalId)) return;
    // The record is RETAINED (alive:false + exit code) until a transport acknowledges it with
    // `kill`: an attached transport does so once the hub has the `exited`; a transport that
    // attaches later advertises it dead in its hello and acknowledges on welcome.
    const transport = this.transport;
    if (transport !== null) transport.peer.write({ type: "exited", terminalId, exitCode });
    this.log("info", "exited", { terminalId, exitCode });
  }
}
