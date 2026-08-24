import {
  AGENT_MESSAGE_TYPES,
  AgentMessageSchema,
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
import type { RawSocket } from "./session-peer.ts";
import type { ServerStore } from "./stores.ts";
import type { MachineChannel, TerminalBroker } from "./terminal-broker.ts";

type ClassifiedFrame =
  | { kind: "message"; message: AgentMessage }
  | { kind: "unknown_type"; frameType: string }
  | { kind: "malformed"; detail: string };

const KNOWN_AGENT_TYPES: Readonly<Record<string, true>> = Object.fromEntries(
  AGENT_MESSAGE_TYPES.map((type): [string, true] => [type, true]),
);

interface PendingMachineConnection {
  socket: RawSocket;
  channel: LiveMachineChannel | null;
  cancelHelloTimeout: (() => void) | null;
}

class LiveMachineChannel implements MachineChannel {
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
    return this.socket.send(payload) >= 0;
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
    this.removeRevocationListener = auth.onRevoked((principalId) => {
      this.revokePrincipal(principalId);
    });
  }

  /** Starts a bounded hello deadline for a newly upgraded machine socket. */
  open(id: string, socket: RawSocket): void {
    const connection: PendingMachineConnection = {
      socket,
      channel: null,
      cancelHelloTimeout: null,
    };
    connection.cancelHelloTimeout = this.timers.schedule(() => {
      connection.cancelHelloTimeout = null;
      if (connection.channel === null) socket.close(4002, "hello timeout");
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
      connection.socket.close(4002, "first frame must be hello");
      return;
    }
    if (message.protocolVersion !== PROTOCOL_VERSION) {
      connection.socket.close(4409, "protocol version mismatch");
      return;
    }

    let authenticated;
    try {
      authenticated = this.auth.authenticateMachine(message.token);
    } catch (error) {
      if (error instanceof ServiceError && error.code === "forbidden") {
        connection.socket.close(4403, "revoked");
      } else {
        connection.socket.close(4401, "unauthorized");
      }
      return;
    }

    const channel = new LiveMachineChannel(
      authenticated.id,
      authenticated.tokenPrincipalId,
      connection.socket,
    );
    const older = this.activeByMachine.get(authenticated.id);
    this.activeByMachine.set(authenticated.id, channel);
    connection.channel = channel;
    connection.cancelHelloTimeout?.();
    connection.cancelHelloTimeout = null;
    this.store.touchMachine(authenticated.id, message.name, this.runtime.now());
    this.broker.setMachineOnline(channel);
    if (older !== undefined) older.close(4001, "superseded");
    channel.send({ type: "welcome", machineId: authenticated.id, serverEpoch: this.serverEpoch });
    for (const advertised of message.sessions) {
      this.broker.adoptSession(authenticated.id, advertised);
    }
  }

  private dispatch(channel: LiveMachineChannel, message: AgentMessage): void {
    switch (message.type) {
      case "hello":
        channel.close(4002, "duplicate hello");
        return;
      case "created":
        this.broker.onCreated(channel.machineId, message.sessionId);
        return;
      case "create_error":
        this.broker.onCreateError(channel.machineId, message.sessionId);
        return;
      case "output":
        this.broker.onOutput(channel.machineId, message);
        return;
      case "snapshot":
        this.broker.onSnapshot(channel.machineId, message);
        return;
      case "exited":
        this.broker.onExited(channel.machineId, message.sessionId, message.exitCode);
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
    const channel = connection.channel;
    if (channel === null) return;
    if (this.activeByMachine.get(channel.machineId) === channel) {
      this.activeByMachine.delete(channel.machineId);
    }
    this.broker.setMachineOffline(channel);
  }

  /** Fences a machine socket whose token principal was durably revoked. */
  revokePrincipal(principalId: string): void {
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
