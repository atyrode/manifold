import {
  AGENT_MESSAGE_TYPES,
  AgentMessageSchema,
  DIAL_PING_INTERVAL_MS,
  MACHINE_PROTOCOL_COMPAT_VERSIONS,
  MAX_SESSION_FRAME_BYTES,
  PROTOCOL_VERSION,
  ServerToAgentMessageSchema,
  type AgentMessage,
  type RuntimeDeps,
  type ServerToAgentMessage,
} from "@manifold/protocol";
import { ServiceError, type AuthService } from "./auth.ts";
import type { Logger } from "./log.ts";
import type { RoomTimers } from "./room.ts";
import type { RawSocket } from "./session-channel.ts";
import type { ServerStore } from "./stores.ts";
import type { DrainOutcome, MachineChannel, TerminalBroker } from "./terminal-broker.ts";

type ClassifiedFrame =
  | { kind: "message"; message: AgentMessage }
  | { kind: "unknown_type"; frameType: string }
  | { kind: "malformed"; detail: string };

const KNOWN_AGENT_TYPES: Readonly<Record<string, true>> = Object.fromEntries(
  AGENT_MESSAGE_TYPES.map((type): [string, true] => [type, true]),
);

const SUPERSEDE_DAMP_MS = 5_000;

interface PendingMachineConnection {
  socket: RawSocket;
  channel: LiveMachineChannel | null;
  cancelHelloTimeout: (() => void) | null;
  cancelPing: (() => void) | null;
  awaitingPong: boolean;
}

export class LiveMachineChannel implements MachineChannel {
  constructor(
    readonly machineId: string,
    readonly tokenPrincipalId: string,
    readonly socket: RawSocket,
    readonly protocolVersion: number,
    readonly terminalHostId: string | null,
  ) {}

  send(message: ServerToAgentMessage): boolean {
    const payload = JSON.stringify(ServerToAgentMessageSchema.parse(message));
    if (this.socket.bufferedAmount + Buffer.byteLength(payload) > MAX_SESSION_FRAME_BYTES) {
      this.socket.close(1013, "machine outbound queue overflow");
      return false;
    }
    return this.socket.send(payload) !== 0;
  }

  close(code: number, reason: string): void {
    this.socket.close(code, reason);
  }
}

function classifyAgentFrame(data: unknown): ClassifiedFrame {
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
  if (KNOWN_AGENT_TYPES[frameType] !== true) {
    return { kind: "unknown_type", frameType };
  }
  const parsed = AgentMessageSchema.safeParse(raw);
  if (!parsed.success) return { kind: "malformed", detail: `invalid ${frameType} frame` };
  return { kind: "message", message: parsed.data };
}

/**
 * What the gateway knows when a hello arrives for a machine, reduced to the facts the
 * admission verdict is a function of. Pure input, so the verdict can be proven in isolation.
 */
export interface AdmissionInput {
  /** The live fenced channel for this machine, or null when nobody is connected. */
  readonly incumbent: { readonly terminalHostId: string | null } | null;
  /** `machines.owner_host_id`: the owner the last ADMITTED hello named. */
  readonly persistedOwner: string | null;
  /** The newcomer's `hello.terminalHostId`, or null for an agent that is its own owner. */
  readonly newcomerOwner: string | null;
  /** Every durable `running` terminal row bound to this machine. */
  readonly durableRunning: readonly string[];
  /** Every terminal the newcomer's hello ACCOUNTS FOR: advertised alive, or advertised exited. */
  readonly advertised: ReadonlySet<string>;
}

export type Admission =
  | { readonly verdict: "refuse"; readonly reason: string }
  | {
      readonly verdict: "admit";
      /** A live incumbent is fenced out in favour of this newcomer. */
      readonly supersedes: boolean;
    };

/**
 * THE ADMISSION VERDICT (#278). A token authenticates a MACHINE; it does not prove that the
 * process presenting it owns the machine's PTYs, and on 2026-09-05 acting as if it did is
 * what turned an agent restart into six destroyed terminals. So a hello is admitted only
 * when it PROVES continuity with the machine's running terminals, and token possession is
 * never that proof. There are exactly three proofs:
 *
 *   NOTHING TO CONTINUE — the machine has no durable running terminal. Any owner may take
 *     the seat: there is no work a wrong one could hijack.
 *   OWNER — the newcomer names the same `terminalHostId` as the reference owner: the live
 *     incumbent when there is one, else the last admitted hello. Two transports, one owner:
 *     the PTYs never moved, and what its inventory says about them (alive, exited, absent) is
 *     the owner's word.
 *   INVENTORY, legacy only — neither side names an owner and the newcomer accounts for every
 *     durable running terminal, alive or exited. This is what keeps a pre-v24 agent's
 *     reconnect and hub restart working exactly as before. It is NOT accepted across an
 *     ownership change: a process that names a different owner cannot hold another process's
 *     PTYs, whatever it advertises, and a legacy agent cannot hold a terminal host's.
 *
 * Everything else is REFUSED before welcome, whether or not anybody is connected. Admitting
 * an unproven claimant "to keep the machine reachable" was evaluated and rejected: it made
 * the claimant the incumbent, so the returning owner was refused, drains reported the
 * claimant's empty inventory as the machine's, and terminals born on the claimant were later
 * disbelieved by the owner's reconciliation. The refused agent re-dials with backoff; the
 * moment the owner is back, or an operator has killed the rows through the named door, the
 * same hello is admitted. The invariant this buys is what every downstream path relies on:
 * THE ADMITTED CHANNEL IS THE OWNER OF RECORD, so its inventory may be believed, its drain
 * answer is the machine's, and a terminal born on it is born in the process that owns it.
 */
export function decideAdmission(input: AdmissionInput): Admission {
  const supersedes = input.incumbent !== null;
  if (input.durableRunning.length === 0) return { verdict: "admit", supersedes };
  const reference =
    input.incumbent === null ? input.persistedOwner : input.incumbent.terminalHostId;
  if (input.newcomerOwner !== null) {
    if (reference === input.newcomerOwner) return { verdict: "admit", supersedes };
    return {
      verdict: "refuse",
      reason:
        reference === null
          ? "terminal continuity unproven: this machine's running terminals belong to an agent that named no owner"
          : "terminal continuity unproven: terminal owner does not match the owner of record",
    };
  }
  if (reference !== null) {
    return {
      verdict: "refuse",
      reason:
        "terminal continuity unproven: this machine's running terminals belong to a terminal owner",
    };
  }
  const unaccounted = input.durableRunning.filter((id) => !input.advertised.has(id));
  if (unaccounted.length === 0) return { verdict: "admit", supersedes };
  return {
    verdict: "refuse",
    reason: `terminal continuity unproven: ${unaccounted.length} running terminal(s) unaccounted for`,
  };
}

/** Authenticates, fences, and dispatches every `/ws/machine` connection. */
export class MachineGateway {
  private readonly connections = new Map<string, PendingMachineConnection>();
  private readonly activeByMachine = new Map<string, LiveMachineChannel>();
  private readonly lastSupersededAtByToken = new Map<string, number>();
  private readonly removeRevocationListener: () => void;

  constructor(
    private readonly auth: AuthService,
    private readonly store: ServerStore,
    private readonly broker: TerminalBroker,
    private readonly timers: RoomTimers,
    private readonly logger: Logger,
    private readonly serverEpoch: string,
    private readonly runtime: RuntimeDeps,
  ) {
    this.removeRevocationListener = auth.onRevoked((principalId, containerId) => {
      this.revokePrincipal(principalId, containerId);
    });
  }
  private pruneExpiredSupersessionDamp(now: number): void {
    for (const [tokenPrincipalId, supersededAt] of this.lastSupersededAtByToken) {
      if (now - supersededAt >= SUPERSEDE_DAMP_MS) {
        this.lastSupersededAtByToken.delete(tokenPrincipalId);
      }
    }
  }

  /** Starts a bounded hello deadline for a newly upgraded machine socket. */
  open(id: string, socket: RawSocket): void {
    const connection: PendingMachineConnection = {
      socket,
      channel: null,
      cancelHelloTimeout: null,
      cancelPing: null,
      awaitingPong: false,
    };
    connection.cancelHelloTimeout = this.timers.schedule(() => {
      connection.cancelHelloTimeout = null;
      if (connection.channel === null) {
        this.logger.warn("machine_hello_timeout");
        socket.close(4002, "hello timeout");
      }
    }, 10_000);
    this.connections.set(id, connection);
  }

  /** Classifies and validates one agent frame before handshake or broker dispatch. */
  message(id: string, data: unknown): void {
    const connection = this.connections.get(id);
    if (connection === undefined) return;
    const classified = classifyAgentFrame(data);
    switch (classified.kind) {
      case "unknown_type":
        this.logger.warn("machine_unknown_frame");
        return;
      case "malformed":
        this.logger.warn("machine_malformed_frame", { detail: classified.detail });
        connection.socket.close(4002, "malformed agent frame");
        return;
      case "message":
        if (connection.channel === null) {
          this.hello(connection, classified.message);
          return;
        }
        if (this.activeByMachine.get(connection.channel.machineId) !== connection.channel) return;
        if (classified.message.type === "pong") {
          connection.awaitingPong = false;
          return;
        }
        this.dispatch(connection.channel, classified.message);
        return;
      default: {
        const exhaustive: never = classified;
        void exhaustive;
      }
    }
  }

  private hello(connection: PendingMachineConnection, message: AgentMessage): void {
    if (message.type !== "hello") {
      this.logger.warn("machine_rejected", { code: 4002, reason: "first frame must be hello" });
      connection.socket.close(4002, "first frame must be hello");
      return;
    }
    if (!MACHINE_PROTOCOL_COMPAT_VERSIONS.has(message.protocolVersion)) {
      // Long-lived agents survive server deploys, so the compat set is the whole point: it
      // admits every wire version this server can still speak — v16 and v17, since the event
      // plane is session-side and left the machine frames byte-identical — and refuses
      // everything below the v16 reset right here. Say so out loud — a silent 4409 lockout is
      // a diagnosed outage (2026-08-25).
      this.logger.warn("machine_version_rejected", {
        agentProtocolVersion: message.protocolVersion,
        serverProtocolVersion: PROTOCOL_VERSION,
        agentVersion: message.agentVersion,
        machineName: message.name,
      });
      connection.socket.close(4409, "protocol version mismatch");
      return;
    }

    let authenticated;
    try {
      authenticated = this.auth.authenticateMachine(message.token);
    } catch (error) {
      if (error instanceof ServiceError && error.code === "forbidden") {
        this.logger.warn("machine_rejected", {
          code: 4403,
          reason: "revoked",
          machineName: message.name,
        });
        connection.socket.close(4403, "revoked");
      } else {
        this.logger.warn("machine_rejected", {
          code: 4401,
          reason: "unauthorized",
          machineName: message.name,
        });
        connection.socket.close(4401, "unauthorized");
      }
      return;
    }

    const now = this.runtime.now();
    this.pruneExpiredSupersessionDamp(now);
    const terminalHostId = message.terminalHostId ?? null;
    const channel = new LiveMachineChannel(
      authenticated.id,
      authenticated.tokenPrincipalId,
      connection.socket,
      message.protocolVersion,
      terminalHostId,
    );
    const older = this.activeByMachine.get(authenticated.id) ?? null;
    const advertised = new Set<string>();
    for (const terminal of message.terminals) advertised.add(terminal.terminalId);
    const admission = decideAdmission({
      incumbent: older,
      persistedOwner: authenticated.ownerHostId,
      newcomerOwner: terminalHostId,
      durableRunning: this.store
        .listRunningTerminalsForMachine(authenticated.id)
        .map((terminal) => terminal.id),
      advertised,
    });
    if (admission.verdict === "refuse") {
      // Refused at NEGOTIATION, like a version mismatch: no welcome, no reconciliation, and
      // an incumbent never learns a claimant knocked. The agent re-dials with backoff; the
      // moment the owner is back or the rows are killed through the named door, the same
      // hello is admitted below.
      connection.cancelHelloTimeout?.();
      connection.cancelHelloTimeout = null;
      this.logger.warn("machine_admission_refused", {
        machineId: authenticated.id,
        reason: admission.reason,
        terminalHostId,
        ownerHostId: older === null ? authenticated.ownerHostId : older.terminalHostId,
      });
      connection.socket.close(4003, admission.reason);
      return;
    }
    const lastSupersededAt = this.lastSupersededAtByToken.get(authenticated.tokenPrincipalId);
    if (
      admission.supersedes &&
      lastSupersededAt !== undefined &&
      now - lastSupersededAt < SUPERSEDE_DAMP_MS
    ) {
      connection.cancelHelloTimeout?.();
      connection.cancelHelloTimeout = null;
      this.logger.warn("machine_supersession_damped", { machineId: authenticated.id });
      connection.socket.close(4003, "supersession damped");
      return;
    }
    connection.channel = channel;
    connection.cancelHelloTimeout?.();
    connection.cancelHelloTimeout = null;
    // Admission proved this hello is the owner of every running terminal (or that there is
    // none), so its identity IS the owner of record from here on.
    this.store.touchMachine(authenticated.id, message.name, now, terminalHostId);
    if (
      !channel.send({
        type: "welcome",
        machineId: authenticated.id,
        serverEpoch: this.serverEpoch,
      })
    ) {
      channel.close(1011, "welcome frame dropped");
      return;
    }
    this.activeByMachine.set(authenticated.id, channel);
    this.broker.setMachineOnline(channel);
    if (older !== null) {
      this.lastSupersededAtByToken.set(authenticated.tokenPrincipalId, now);
      this.logger.info("machine_superseded", { machineId: authenticated.id });
      older.close(4001, "superseded");
    }
    this.broker.reconcileMachineHello(authenticated.id, message.terminals);
    this.schedulePing(connection);
  }

  /** Arms the next liveness ping; an unanswered previous ping closes the socket. */
  private schedulePing(connection: PendingMachineConnection): void {
    connection.cancelPing = this.timers.schedule(() => {
      connection.cancelPing = null;
      const channel = connection.channel;
      if (channel === null) return;
      if (connection.awaitingPong) {
        this.logger.warn("machine_liveness_timeout", { machineId: channel.machineId });
        channel.close(4008, "liveness timeout");
        return;
      }
      connection.awaitingPong = true;
      if (!channel.send({ type: "ping" })) {
        channel.close(1011, "ping frame dropped");
        return;
      }
      this.schedulePing(connection);
    }, DIAL_PING_INTERVAL_MS);
  }

  private dispatch(channel: LiveMachineChannel, message: AgentMessage): void {
    switch (message.type) {
      case "hello":
        channel.close(4002, "duplicate hello");
        return;
      case "created":
        this.broker.onCreated(channel.machineId, message.terminalId);
        return;
      case "create_error":
        this.broker.onCreateError(channel.machineId, message.terminalId);
        return;
      case "output":
        this.broker.onOutput(channel.machineId, message);
        return;
      case "snapshot":
        this.broker.onSnapshot(channel.machineId, message);
        return;
      case "exited":
        this.broker.onExited(channel.machineId, message.terminalId, message.exitCode);
        return;
      case "pong":
        return;
      case "drain_status":
        this.broker.onDrainStatus(channel.machineId, message);
        return;
      default: {
        const exhaustive: never = message;
        void exhaustive;
      }
    }
  }

  /** Cleans broker online state after a machine socket closes. */
  close(id: string): void {
    const connection = this.connections.get(id);
    if (connection === undefined) return;
    this.connections.delete(id);
    connection.cancelHelloTimeout?.();
    connection.cancelPing?.();
    connection.cancelPing = null;
    const channel = connection.channel;
    if (channel === null) return;
    if (this.activeByMachine.get(channel.machineId) === channel) {
      this.activeByMachine.delete(channel.machineId);
    }
    this.broker.setMachineOffline(channel);
  }

  /** Fences a machine socket whose token principal was durably revoked. */
  revokePrincipal(principalId: string, containerId: string | null = null): void {
    if (containerId !== null) return;
    for (const [id, connection] of [...this.connections]) {
      const channel = connection.channel;
      if (channel?.tokenPrincipalId !== principalId) continue;
      channel.close(4403, "revoked");
      this.close(id);
    }
  }

  /** Reports persisted machine liveness for HTTP summaries. */
  isOnline(machineId: string): boolean {
    return this.activeByMachine.has(machineId);
  }

  /**
   * `core.machines.drain`'s mechanism, through the same door the roster asks liveness of:
   * the plugin declares `{ isOnline, drain }` and nothing about sockets. The broker owns the
   * latch and the owner round trip; this is the door, not a second implementation.
   */
  drain(machineId: string, draining: boolean): Promise<DrainOutcome> {
    return this.broker.drain(machineId, draining);
  }

  /** Closes every machine channel and unregisters auth fanout at shutdown. */
  shutdown(): void {
    this.removeRevocationListener();
    for (const [id, connection] of [...this.connections]) {
      connection.cancelHelloTimeout?.();
      if (connection.channel === null) {
        connection.socket.close(1001, "server shutting down");
      } else {
        connection.channel.close(1001, "server shutting down");
      }
      this.close(id);
    }
  }
}
