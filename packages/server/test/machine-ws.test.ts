import { describe, expect, test } from "bun:test";
import {
  PROTOCOL_VERSION,
  ServerToAgentMessageSchema,
  type Pad,
  type ServerToAgentMessage,
} from "@manifold/protocol";
import { AuthService } from "../src/auth.ts";
import { silentLogger, type Logger } from "../src/log.ts";
import { LiveMachineChannel, MachineGateway } from "../src/machine-ws.ts";
import { RoomManager } from "../src/room.ts";
import type { RawSocket } from "../src/session-peer.ts";
import { TerminalBroker } from "../src/terminal-broker.ts";
import { FakeClock, FakeRuntime, FakeSocket, testStore } from "./helpers.ts";

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

    expect(channel.send({ type: "kill", sessionId: "session" })).toBe(true);
    expect(socket.closed).toBeNull();
  });

  test("0 is reported as a dropped frame", () => {
    const socket = new StatusSocket(0);
    const channel = new LiveMachineChannel("machine", "principal", socket);

    expect(channel.send({ type: "kill", sessionId: "session" })).toBe(false);
  });
});

describe("machine hello reconciliation", () => {
  test("a durable running session absent from hello is marked exited", () => {
    const runtime = new FakeRuntime();
    const clock = new FakeClock(runtime);
    const store = testStore();
    const auth = new AuthService(store, "c".repeat(64), runtime);
    const root = auth.authenticate("c".repeat(64));
    const pad: Pad = { id: runtime.newId(), name: "hello pad", createdAt: runtime.now() };
    store.createPad(pad);
    const enrollment = auth.enrollMachine("agent", root);
    const sessionGrant = auth.mintSessionAgentToken("missing-session", pad.id, root.principal.id);
    store.createSession({
      id: "missing-session",
      machineId: enrollment.machine.id,
      padId: pad.id,
      elementId: "terminal",
      createdBy: root.principal.id,
      agentPrincipalId: sessionGrant.principal.id,
      createdAt: runtime.now(),
    });
    const rooms = new RoomManager(store, runtime, clock, silentLogger);
    const broker = new TerminalBroker(
      store,
      auth,
      rooms,
      runtime,
      clock,
      silentLogger,
      () => "http://localhost:7777",
    );
    rooms.setSessionProvider((padId) => broker.listForPad(padId));
    rooms.setPendingOpenProvider((padId) => broker.hasPendingOpenForPad(padId));
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
        sessions: [],
      }),
    );

    expect(store.getSession("missing-session")?.status).toBe("exited");
    expect(broker.listForPad(pad.id)[0]?.status).toBe("exited");
    gateway.shutdown();
    store.close();
  });

  test("an advertised session that cannot be adopted is killed", () => {
    const runtime = new FakeRuntime();
    const clock = new FakeClock(runtime);
    const store = testStore();
    const auth = new AuthService(store, "d".repeat(64), runtime);
    const root = auth.authenticate("d".repeat(64));
    const enrollment = auth.enrollMachine("agent", root);
    const rooms = new RoomManager(store, runtime, clock, silentLogger);
    const broker = new TerminalBroker(
      store,
      auth,
      rooms,
      runtime,
      clock,
      silentLogger,
      () => "http://localhost:7777",
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
        sessions: [{ sessionId: "unknown", cols: 80, rows: 24, alive: true, seq: 0 }],
      }),
    );

    expect(machineMessages(socket).map((message) => message.type)).toEqual(["welcome", "kill"]);
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
    const rooms = new RoomManager(store, runtime, clock, silentLogger);
    const broker = new TerminalBroker(
      store,
      auth,
      rooms,
      runtime,
      clock,
      silentLogger,
      () => "http://localhost:7777",
    );
    const logger = new CaptureLogger();
    const gateway = new MachineGateway(auth, store, broker, clock, logger, "server-epoch", runtime);
    const hello = JSON.stringify({
      type: "hello",
      token: enrollment.machineToken,
      name: "agent",
      agentVersion: "test",
      protocolVersion: PROTOCOL_VERSION,
      sessions: [],
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
