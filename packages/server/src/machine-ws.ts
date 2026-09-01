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
import type { MachineChannel, TerminalBroker } from "./terminal-broker.ts";

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
    const channel = new LiveMachineChannel(
      authenticated.id,
      authenticated.tokenPrincipalId,
      connection.socket,
    );
    const older = this.activeByMachine.get(authenticated.id);
    const lastSupersededAt = this.lastSupersededAtByToken.get(authenticated.tokenPrincipalId);
    if (
      older !== undefined &&
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
    this.store.touchMachine(authenticated.id, message.name, now);
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
    if (older !== undefined) {
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
