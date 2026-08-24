import { describe, expect, test } from "bun:test";
import {
  ServerToAgentMessageSchema,
  type Pad,
  type ServerToAgentMessage,
} from "@manifold/protocol";
import { AuthService } from "../src/auth.ts";
import { silentLogger } from "../src/log.ts";
import { RoomManager } from "../src/room.ts";
import { SessionPeer } from "../src/session-peer.ts";
import { TerminalBroker, type MachineChannel } from "../src/terminal-broker.ts";
import { FakeClock, FakeRuntime, FakeSocket, testStore } from "./helpers.ts";

class FakeMachine implements MachineChannel {
  readonly sent: ServerToAgentMessage[] = [];

  constructor(readonly machineId: string) {}

  send(message: ServerToAgentMessage): boolean {
    this.sent.push(ServerToAgentMessageSchema.parse(message));
    return true;
  }

  clear(): void {
    this.sent.length = 0;
  }
}

function brokerFixture() {
  const runtime = new FakeRuntime();
  const clock = new FakeClock(runtime);
  const store = testStore();
  const auth = new AuthService(store, "b".repeat(64), runtime);
  const root = auth.authenticate("b".repeat(64));
  const pad: Pad = { id: runtime.newId(), name: "terminal pad", createdAt: runtime.now() };
  store.createPad(pad);
  const rooms = new RoomManager(store, runtime, clock, silentLogger);
  const broker = new TerminalBroker(
    store,
    auth,
    rooms,
    runtime,
    silentLogger,
    () => "http://localhost:7777",
  );
  rooms.setSessionProvider((padId) => broker.listForPad(padId));
  const enrollment = auth.enrollMachine("fake", root);
  const machine = new FakeMachine(enrollment.machine.id);
  broker.setMachineOnline(machine);
  const socket = new FakeSocket();
  const opener = new SessionPeer(runtime.newId(), socket, root, pad.id);
  broker.open(opener, { type: "terminal_open", elementId: "terminal-1", cols: 80, rows: 24 });
  const create = machine.sent.find((message) => message.type === "create");
  if (create === undefined || create.type !== "create") throw new Error("missing create request");
  broker.onCreated(machine.machineId, create.sessionId);
  socket.clear();
  machine.clear();
  return { runtime, store, auth, root, pad, rooms, broker, machine, socket, opener, create };
}

function encoded(value: string): string {
  return Buffer.from(value).toString("base64");
}

describe("TerminalBroker attach handoff", () => {
  test("delayed snapshot(6) flushes exactly outputs 7 through 10 in order", () => {
    const fixture = brokerFixture();
    fixture.broker.attach(fixture.opener, {
      type: "terminal_attach",
      sessionId: fixture.create.sessionId,
    });
    expect(fixture.machine.sent).toEqual([
      { type: "snapshot_request", sessionId: fixture.create.sessionId },
    ]);

    for (let seq = 1; seq <= 6; seq += 1) {
      fixture.broker.onOutput(fixture.machine.machineId, {
        type: "output",
        sessionId: fixture.create.sessionId,
        seq,
        data: encoded(`output-${seq}`),
      });
    }
    for (let seq = 7; seq <= 10; seq += 1) {
      fixture.broker.onOutput(fixture.machine.machineId, {
        type: "output",
        sessionId: fixture.create.sessionId,
        seq,
        data: encoded(`output-${seq}`),
      });
    }
    fixture.broker.onSnapshot(fixture.machine.machineId, {
      type: "snapshot",
      sessionId: fixture.create.sessionId,
      seq: 6,
      data: encoded("snapshot-at-6"),
    });

    const terminal = fixture.socket
      .messages()
      .filter(
        (message) => message.type === "terminal_snapshot" || message.type === "terminal_output",
      );
    expect(terminal.map((message) => [message.type, message.seq])).toEqual([
      ["terminal_snapshot", 6],
      ["terminal_output", 7],
      ["terminal_output", 8],
      ["terminal_output", 9],
      ["terminal_output", 10],
    ]);
    const outputSeqs = terminal
      .filter((message) => message.type === "terminal_output")
      .map((message) => message.seq);
    expect(outputSeqs.some((seq) => seq <= 6)).toBe(false);
    fixture.store.close();
  });
});

describe("TerminalBroker controller lease", () => {
  test("gates input resize and kill until terminal_take transfers control", () => {
    const fixture = brokerFixture();
    const grant = fixture.auth.mintToken(
      {
        principal: { name: "second controller", kind: "human" },
        caps: ["pads:read", "terminal:write"],
        padId: fixture.pad.id,
      },
      fixture.root,
    );
    const secondContext = fixture.auth.authenticate(grant.token);
    const secondSocket = new FakeSocket();
    const second = new SessionPeer(
      fixture.runtime.newId(),
      secondSocket,
      secondContext,
      fixture.pad.id,
    );

    fixture.broker.input(second, {
      type: "terminal_input",
      sessionId: fixture.create.sessionId,
      data: encoded("denied"),
    });
    fixture.broker.resize(second, {
      type: "terminal_resize",
      sessionId: fixture.create.sessionId,
      cols: 100,
      rows: 30,
    });
    fixture.broker.kill(second, {
      type: "terminal_kill",
      sessionId: fixture.create.sessionId,
    });
    expect(fixture.machine.sent).toEqual([]);
    expect(
      secondSocket
        .messages()
        .filter((message) => message.type === "error")
        .map((message) => message.code),
    ).toEqual(["not_controller", "not_controller", "not_controller"]);

    fixture.broker.take(second, {
      type: "terminal_take",
      sessionId: fixture.create.sessionId,
    });
    fixture.broker.input(second, {
      type: "terminal_input",
      sessionId: fixture.create.sessionId,
      data: encoded("allowed"),
    });
    fixture.broker.resize(second, {
      type: "terminal_resize",
      sessionId: fixture.create.sessionId,
      cols: 120,
      rows: 40,
    });
    fixture.broker.kill(second, {
      type: "terminal_kill",
      sessionId: fixture.create.sessionId,
    });
    expect(fixture.machine.sent.map((message) => message.type)).toEqual([
      "input",
      "resize",
      "kill",
    ]);

    fixture.socket.clear();
    fixture.broker.input(fixture.opener, {
      type: "terminal_input",
      sessionId: fixture.create.sessionId,
      data: encoded("former-controller"),
    });
    expect(fixture.socket.messages().at(-1)).toMatchObject({
      type: "error",
      code: "not_controller",
    });
    fixture.store.close();
  });
});
