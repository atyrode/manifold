import { describe, expect, test } from "bun:test";
import {
  DIAL_PING_INTERVAL_MS,
  MACHINE_PROTOCOL_COMPAT_VERSIONS,
  PROTOCOL_VERSION,
  ServerToAgentMessageSchema,
  type Container,
  type ServerToAgentMessage,
} from "@manifold/protocol";
import { AuthService } from "../src/auth.ts";
import { silentLogger, type Logger } from "../src/log.ts";
import { LiveMachineChannel, MachineGateway } from "../src/machine-ws.ts";
import { RoomManager } from "../src/room.ts";
import type { RawSocket } from "../src/session-channel.ts";
import { TerminalBroker } from "../src/terminal-broker.ts";
import { FakeClock, FakeRuntime, FakeSocket, testStore, testTileTrees } from "./helpers.ts";

class StatusSocket implements RawSocket {
  bufferedAmount = 0;
  readonly sent: string[] = [];
  closed: { code: number | undefined; reason: string | undefined } | null = null;

  constructor(private readonly status: number) {}

  send(data: string): number {
    this.sent.push(data);
    return this.status;
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }
}

function machineMessages(socket: FakeSocket): ServerToAgentMessage[] {
  return socket.sent.map((frame) => ServerToAgentMessageSchema.parse(JSON.parse(frame)));
}

class CaptureLogger implements Logger {
  readonly events: { evt: string; fields: Readonly<Record<string, unknown>> | undefined }[] = [];

  info(evt: string, fields?: Readonly<Record<string, unknown>>): void {
    this.events.push({ evt, fields });
  }

  warn(): void {}

  error(): void {}
}

describe("machine channel send status", () => {
  test("-1 is accepted as enqueued backpressure", () => {
    const socket = new StatusSocket(-1);
    const channel = new LiveMachineChannel("machine", "principal", socket);

    expect(channel.send({ type: "kill", terminalId: "terminal" })).toBe(true);
    expect(socket.closed).toBeNull();
  });

  test("0 is reported as a dropped frame", () => {
    const socket = new StatusSocket(0);
    const channel = new LiveMachineChannel("machine", "principal", socket);

    expect(channel.send({ type: "kill", terminalId: "terminal" })).toBe(false);
  });
});

describe("machine hello reconciliation", () => {
  test("a durable running terminal absent from hello is marked exited", () => {
    const runtime = new FakeRuntime();
    const clock = new FakeClock(runtime);
    const store = testStore();
    const auth = new AuthService(store, "c".repeat(64), runtime);
    const root = auth.authenticate("c".repeat(64));
    // A terminal's `containerId` names the composition it LIVES in, and only a composition
    // can home a terminal, so the durable fixture row needs a composition container.
    const container: Container = {
      id: runtime.newId(),
      name: "hello composition",
      createdAt: runtime.now(),
      discipline: "composition",
    };
    store.createContainer(container);
    const enrollment = auth.enrollMachine("agent", root);
    const sessionGrant = auth.mintSessionAgentToken(
      "missing-terminal",
      container.id,
      root.principal.id,
    );
    store.createTerminal({
      id: "missing-terminal",
      machineId: enrollment.machine.id,
      containerId: container.id,
      createdBy: root.principal.id,
      agentPrincipalId: sessionGrant.principal.id,
      createdAt: runtime.now(),
    });
    const rooms = new RoomManager(store, runtime, clock, silentLogger, testTileTrees);
    const broker = new TerminalBroker(
      store,
      auth,
      rooms,
      runtime,
      clock,
      silentLogger,
      () => "http://localhost:7777",
      testTileTrees,
    );
    rooms.setTerminalProvider((containerId) => broker.listForContainer(containerId));
    rooms.setPendingOpenProvider((containerId) => broker.hasPendingOpenForContainer(containerId));
    const gateway = new MachineGateway(
      auth,
      store,
      broker,
      clock,
      silentLogger,
      "server-epoch",
      runtime,
    );
    const socket = new FakeSocket();
    gateway.open("connection", socket);

    gateway.message(
      "connection",
      JSON.stringify({
        type: "hello",
        token: enrollment.machineToken,
        name: "agent",
        agentVersion: "test",
        protocolVersion: PROTOCOL_VERSION,
        terminals: [],
      }),
    );

    expect(store.getTerminal("missing-terminal")?.status).toBe("exited");
    expect(broker.listForContainer(container.id)[0]?.status).toBe("exited");
    gateway.shutdown();
    store.close();
  });

  test("an advertised terminal that cannot be adopted is killed", () => {
    const runtime = new FakeRuntime();
    const clock = new FakeClock(runtime);
    const store = testStore();
    const auth = new AuthService(store, "d".repeat(64), runtime);
    const root = auth.authenticate("d".repeat(64));
    const enrollment = auth.enrollMachine("agent", root);
    const rooms = new RoomManager(store, runtime, clock, silentLogger, testTileTrees);
    const broker = new TerminalBroker(
      store,
      auth,
      rooms,
      runtime,
      clock,
      silentLogger,
      () => "http://localhost:7777",
      testTileTrees,
    );
    const gateway = new MachineGateway(
      auth,
      store,
      broker,
      clock,
      silentLogger,
      "server-epoch",
      runtime,
    );
    const socket = new FakeSocket();
    gateway.open("connection", socket);

    gateway.message(
      "connection",
      JSON.stringify({
        type: "hello",
        token: enrollment.machineToken,
        name: "agent",
        agentVersion: "test",
        protocolVersion: PROTOCOL_VERSION,
        terminals: [{ terminalId: "unknown", cols: 80, rows: 24, alive: true, seq: 0 }],
      }),
    );

    expect(machineMessages(socket).map((message) => message.type)).toEqual(["welcome", "kill"]);
    gateway.shutdown();
    store.close();
  });

  test("current PROTOCOL_VERSION is always machine-channel accepted", () => {
    // Guards the AGENTS.md invariant: whoever bumps PROTOCOL_VERSION must decide
    // whether the agent wire changed (reset the set) or not (extend it) — this
    // fails the build until that decision is made explicitly.
    expect(MACHINE_PROTOCOL_COMPAT_VERSIONS.has(PROTOCOL_VERSION)).toBe(true);
  });

  test("a pre-reset hello is refused, so its durable terminal is neither adopted nor reaped", () => {
    // v16 RESET the machine wire, so no PRE-reset hello is welcome any more. v17 rode along
    // additively — the event plane is session-side and left `AgentMessage` and
    // `ServerToAgentMessage` byte-identical — so the compat set admits both and this deploy
    // owes no fleet restart (invariant 10, first clause). What the reset means is that
    // everything below v16 is refused, and that is what this asserts rather than the set's
    // exact size, which every additive version would otherwise have to come and edit.
    expect(MACHINE_PROTOCOL_COMPAT_VERSIONS.has(15)).toBe(false);
    // Refusal is decided at NEGOTIATION, ahead of reconciliation, which is what leaves the
    // advertised PTY's durable row untouched: the machine is expected to come back speaking a
    // version in the set and be reconciled then.
    const runtime = new FakeRuntime();
    const clock = new FakeClock(runtime);
    const store = testStore();
    const auth = new AuthService(store, "f".repeat(64), runtime);
    const root = auth.authenticate("f".repeat(64));
    const container: Container = {
      id: runtime.newId(),
      name: "pre-reset composition",
      createdAt: runtime.now(),
      discipline: "composition",
    };
    store.createContainer(container);
    const enrollment = auth.enrollMachine("agent", root);
    const sessionGrant = auth.mintSessionAgentToken(
      "pre-reset-terminal",
      container.id,
      root.principal.id,
    );
    store.createTerminal({
      id: "pre-reset-terminal",
      machineId: enrollment.machine.id,
      containerId: container.id,
      createdBy: root.principal.id,
      agentPrincipalId: sessionGrant.principal.id,
      createdAt: runtime.now(),
    });
    const rooms = new RoomManager(store, runtime, clock, silentLogger, testTileTrees);
    const broker = new TerminalBroker(
      store,
      auth,
      rooms,
      runtime,
      clock,
      silentLogger,
      () => "http://localhost:7777",
      testTileTrees,
    );
    rooms.setTerminalProvider((containerId) => broker.listForContainer(containerId));
    rooms.setPendingOpenProvider((containerId) => broker.hasPendingOpenForContainer(containerId));
    const gateway = new MachineGateway(
      auth,
      store,
      broker,
      clock,
      silentLogger,
      "server-epoch",
      runtime,
    );
    const socket = new FakeSocket();
    gateway.open("connection", socket);

    gateway.message(
      "connection",
      JSON.stringify({
        type: "hello",
        token: enrollment.machineToken,
        name: "agent",
        agentVersion: "test-pre-reset",
        // Below the v16 reset, not merely below the current version: v17 is additive, so
        // `PROTOCOL_VERSION - 1` is a version this server still welcomes.
        protocolVersion: 15,
        terminals: [
          { terminalId: "pre-reset-terminal", cols: 120, rows: 40, alive: true, seq: 42 },
        ],
      }),
    );

    // Not welcomed, and not killed either: a refused channel gets no frames at all.
    expect(socket.closed?.code).toBe(4409);
    expect(machineMessages(socket)).toEqual([]);
    // Neither half of reconciliation ran. The row is listed because it is DURABLE, but it is
    // listed exactly as the store held it: the advertised 120x40 never became live geometry,
    // and no absence marked the row exited.
    const listed = broker.listForContainer(container.id);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe("pre-reset-terminal");
    expect({ cols: listed[0]?.cols, rows: listed[0]?.rows }).toEqual({ cols: 80, rows: 24 });
    expect(store.getTerminal("pre-reset-terminal")?.status).toBe("running");
    gateway.shutdown();
    store.close();
  });

  test("rejects a wire-incompatible protocol version with 4409 and a structured log", () => {
    const runtime = new FakeRuntime();
    const clock = new FakeClock(runtime);
    const store = testStore();
    const auth = new AuthService(store, "a".repeat(64), runtime);
    const root = auth.authenticate("a".repeat(64));
    const enrollment = auth.enrollMachine("agent", root);
    const rooms = new RoomManager(store, runtime, clock, silentLogger, testTileTrees);
    const broker = new TerminalBroker(
      store,
      auth,
      rooms,
      runtime,
      clock,
      silentLogger,
      () => "http://localhost:7777",
      testTileTrees,
    );
    const warned: Array<{ evt: string; fields: Record<string, unknown> | undefined }> = [];
    const logger: Logger = {
      info: () => {},
      warn: (evt, fields) => warned.push({ evt, fields }),
      error: () => {},
    };
    const gateway = new MachineGateway(auth, store, broker, clock, logger, "server-epoch", runtime);
    const socket = new FakeSocket();
    gateway.open("connection", socket);

    gateway.message(
      "connection",
      JSON.stringify({
        type: "hello",
        token: enrollment.machineToken,
        name: "agent",
        agentVersion: "test-old",
        protocolVersion: 1,
        terminals: [],
      }),
    );

    expect(socket.closed?.code).toBe(4409);
    expect(machineMessages(socket)).toEqual([]);
    const rejected = warned.find((w) => w.evt === "machine_version_rejected");
    expect(rejected?.fields?.agentProtocolVersion).toBe(1);
    expect(rejected?.fields?.serverProtocolVersion).toBe(PROTOCOL_VERSION);
    gateway.shutdown();
    store.close();
  });

  test("damps repeated machine supersession while preserving the active fence", () => {
    const runtime = new FakeRuntime();
    const clock = new FakeClock(runtime);
    const store = testStore();
    const auth = new AuthService(store, "e".repeat(64), runtime);
    const root = auth.authenticate("e".repeat(64));
    const enrollment = auth.enrollMachine("agent", root);
    const rooms = new RoomManager(store, runtime, clock, silentLogger, testTileTrees);
    const broker = new TerminalBroker(
      store,
      auth,
      rooms,
      runtime,
      clock,
      silentLogger,
      () => "http://localhost:7777",
      testTileTrees,
    );
    const logger = new CaptureLogger();
    const gateway = new MachineGateway(auth, store, broker, clock, logger, "server-epoch", runtime);
    const hello = JSON.stringify({
      type: "hello",
      token: enrollment.machineToken,
      name: "agent",
      agentVersion: "test",
      protocolVersion: PROTOCOL_VERSION,
      terminals: [],
    });
    const first = new FakeSocket();
    gateway.open("first", first);
    gateway.message("first", hello);
    const second = new FakeSocket();
    gateway.open("second", second);
    gateway.message("second", hello);

    expect(first.closed).toEqual({ code: 4001, reason: "superseded" });
    expect(logger.events).toEqual([
      {
        evt: "machine_superseded",
        fields: { machineId: enrollment.machine.id },
      },
    ]);

    const immediate = new FakeSocket();
    gateway.open("immediate", immediate);
    gateway.message("immediate", hello);

    expect(immediate.closed).toEqual({ code: 4003, reason: "supersession damped" });
    expect(second.closed).toBeNull();
    expect(machineMessages(immediate)).toEqual([]);

    clock.advance(5_000);
    const afterDamp = new FakeSocket();
    gateway.open("after-damp", afterDamp);
    gateway.message("after-damp", hello);

    expect(second.closed).toEqual({ code: 4001, reason: "superseded" });
    expect(afterDamp.closed).toBeNull();
    expect(logger.events).toEqual([
      {
        evt: "machine_superseded",
        fields: { machineId: enrollment.machine.id },
      },
      {
        evt: "machine_superseded",
        fields: { machineId: enrollment.machine.id },
      },
    ]);
    gateway.shutdown();
    store.close();
  });
});

describe("machine liveness heartbeat", () => {
  function fixture(ownerKey: string) {
    const runtime = new FakeRuntime();
    const clock = new FakeClock(runtime);
    const store = testStore();
    const auth = new AuthService(store, ownerKey, runtime);
    const root = auth.authenticate(ownerKey);
    const enrollment = auth.enrollMachine("agent", root);
    const rooms = new RoomManager(store, runtime, clock, silentLogger, testTileTrees);
    const broker = new TerminalBroker(
      store,
      auth,
      rooms,
      runtime,
      clock,
      silentLogger,
      () => "http://localhost:7777",
      testTileTrees,
    );
    const gateway = new MachineGateway(
      auth,
      store,
      broker,
      clock,
      silentLogger,
      "server-epoch",
      runtime,
    );
    const socket = new FakeSocket();
    gateway.open("connection", socket);
    gateway.message(
      "connection",
      JSON.stringify({
        type: "hello",
        token: enrollment.machineToken,
        name: "agent",
        agentVersion: "test",
        protocolVersion: PROTOCOL_VERSION,
        terminals: [],
      }),
    );
    return { clock, store, gateway, socket, machineId: enrollment.machine.id };
  }

  test("a ponging machine stays online across many intervals", () => {
    const value = fixture("1".repeat(64));

    for (let round = 0; round < 3; round++) {
      value.clock.advance(DIAL_PING_INTERVAL_MS);
      const pings = machineMessages(value.socket).filter((m) => m.type === "ping");
      expect(pings).toHaveLength(round + 1);
      value.gateway.message("connection", JSON.stringify({ type: "pong" }));
    }

    expect(value.socket.closed).toBeNull();
    expect(value.gateway.isOnline(value.machineId)).toBe(true);
    value.gateway.shutdown();
    value.store.close();
  });

  test("an unanswered ping closes the socket within two intervals", () => {
    const value = fixture("2".repeat(64));

    value.clock.advance(DIAL_PING_INTERVAL_MS); // ping sent
    expect(value.socket.closed).toBeNull();
    value.clock.advance(DIAL_PING_INTERVAL_MS); // still unanswered -> close

    expect(value.socket.closed?.code).toBe(4008);
    expect(value.socket.closed?.reason).toBe("liveness timeout");
    // The transport close event then reaches the gateway, taking the machine offline.
    value.gateway.close("connection");
    expect(value.gateway.isOnline(value.machineId)).toBe(false);
    value.gateway.shutdown();
    value.store.close();
  });

  test("closing a connection disarms its ping timer", () => {
    const value = fixture("3".repeat(64));

    expect(value.clock.pendingJobs).toBeGreaterThan(0);
    value.gateway.close("connection");
    expect(value.clock.pendingJobs).toBe(0);
    value.gateway.shutdown();
    value.store.close();
  });
});
