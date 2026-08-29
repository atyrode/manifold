import { describe, expect, test } from "bun:test";
import {
  ROOT_TILE_ID,
  ServerToAgentMessageSchema,
  type Pad,
  type ServerToAgentMessage,
} from "@manifold/protocol";
import { AuthService, ServiceError } from "../src/auth.ts";
import { silentLogger } from "../src/log.ts";
import { PlaceExecutor } from "../src/placement.ts";
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

/**
 * The fixture opens a terminal in a COMPOSITION, which is where a terminal lives: the pad
 * IS the home, so the opener's own container is the one the session is homed in and every
 * session-scoped message it sends is addressed to the right room. A canvas opener would be
 * homed in a solo composition it is not joined to, which is the lifecycle rule under test
 * elsewhere, not the plumbing under test here.
 */
function openingFixture() {
  const runtime = new FakeRuntime();
  const clock = new FakeClock(runtime);
  const store = testStore();
  const auth = new AuthService(store, "b".repeat(64), runtime);
  const root = auth.authenticate("b".repeat(64));
  const pad: Pad = {
    id: runtime.newId(),
    name: "terminal composition",
    createdAt: runtime.now(),
    layout: "tiled",
  };
  store.createPad(pad);
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
  broker.setPlacement(new PlaceExecutor(store, rooms, broker, runtime));
  const enrollment = auth.enrollMachine("fake", root);
  const machine = new FakeMachine(enrollment.machine.id);
  broker.setMachineOnline(machine);
  const socket = new FakeSocket();
  const opener = new SessionPeer(runtime.newId(), socket, root, pad.id, "c1");
  broker.open(opener, {
    type: "terminal_open",
    elementId: "terminal-1",
    cols: 80,
    rows: 24,
    placement: "tile",
  });
  const create = machine.sent.find((message) => message.type === "create");
  if (create === undefined || create.type !== "create") throw new Error("missing create request");
  return { runtime, clock, store, auth, root, pad, rooms, broker, machine, socket, opener, create };
}

function brokerFixture() {
  const fixture = openingFixture();
  fixture.broker.onCreated(fixture.machine.machineId, fixture.create.sessionId);
  fixture.socket.clear();
  fixture.machine.clear();
  return fixture;
}

function encoded(value: string): string {
  return Buffer.from(value).toString("base64");
}

function sessionToken(create: Extract<ServerToAgentMessage, { type: "create" }>): string {
  const token = create.env.MANIFOLD_TOKEN;
  if (token === undefined) throw new Error("missing session token");
  return token;
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
      "c2",
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
    ).toEqual(["not_controller", "not_controller", "forbidden"]);

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

  test("owner wildcard capability kills without the controller lease", () => {
    const fixture = brokerFixture();
    const grant = fixture.auth.mintToken(
      { principal: { name: "owner janitor", kind: "human" }, caps: ["*"] },
      fixture.root,
    );
    const janitorSocket = new FakeSocket();
    const janitor = new SessionPeer(
      fixture.runtime.newId(),
      janitorSocket,
      fixture.auth.authenticate(grant.token),
      fixture.pad.id,
      "c2",
    );
    fixture.broker.kill(janitor, {
      type: "terminal_kill",
      sessionId: fixture.create.sessionId,
    });
    expect(fixture.machine.sent.map((message) => message.type)).toEqual(["kill"]);
    expect(janitorSocket.messages().filter((message) => message.type === "error")).toEqual([]);
    fixture.store.close();
  });

  test("offline kill persists exit and kills the PTY if its machine reconnects", () => {
    const fixture = brokerFixture();
    const room = fixture.rooms.get(fixture.pad.id);
    if (room === null) throw new Error("missing room");
    room.join(fixture.opener);
    fixture.socket.clear();
    fixture.broker.setMachineOffline(fixture.machine);

    fixture.broker.kill(fixture.opener, {
      type: "terminal_kill",
      sessionId: fixture.create.sessionId,
    });

    expect(fixture.broker.listForPad(fixture.pad.id)).toMatchObject([
      { id: fixture.create.sessionId, status: "exited", exitCode: null },
    ]);
    // L2: the exit is durable and STAYS visible — the home leaf is untouched, so the prune
    // that collects unhomed exits has nothing to collect here.
    fixture.broker.pruneExitedUnhomedForPad(fixture.pad.id);
    expect(fixture.broker.listForPad(fixture.pad.id)).toHaveLength(1);
    expect(fixture.store.getSession(fixture.create.sessionId)).toMatchObject({
      status: "exited",
      exitCode: null,
    });
    expect(fixture.socket.messages()).toContainEqual({
      type: "session_event",
      sessionId: fixture.create.sessionId,
      kind: "exited",
      exitCode: null,
    });

    fixture.broker.setMachineOnline(fixture.machine);
    fixture.broker.reconcileMachineHello(fixture.machine.machineId, [
      {
        sessionId: fixture.create.sessionId,
        cols: 80,
        rows: 24,
        alive: true,
        seq: 0,
      },
    ]);
    expect(fixture.machine.sent).toContainEqual({
      type: "kill",
      sessionId: fixture.create.sessionId,
    });
    fixture.store.close();
  });

  test("session re-adoption broadcasts the reset controller lease", () => {
    const fixture = brokerFixture();
    const room = fixture.rooms.get(fixture.pad.id);
    if (room === null) throw new Error("missing room");
    room.join(fixture.opener);
    fixture.socket.clear();
    const grant = fixture.auth.mintToken(
      {
        principal: { name: "pre-restart controller", kind: "human" },
        caps: ["pads:read", "terminal:write"],
        padId: fixture.pad.id,
      },
      fixture.root,
    );
    const controller = new SessionPeer(
      fixture.runtime.newId(),
      new FakeSocket(),
      fixture.auth.authenticate(grant.token),
      fixture.pad.id,
      "c2",
    );
    fixture.broker.take(controller, {
      type: "terminal_take",
      sessionId: fixture.create.sessionId,
    });
    expect(fixture.socket.messages().at(-1)).toMatchObject({
      type: "session_event",
      sessionId: fixture.create.sessionId,
      kind: "controller_changed",
      controllerId: controller.auth.principal.id,
    });
    fixture.socket.clear();

    const restarted = new TerminalBroker(
      fixture.store,
      fixture.auth,
      fixture.rooms,
      fixture.runtime,
      fixture.clock,
      silentLogger,
      () => "http://localhost:7777",
    );
    restarted.reconcileMachineHello(fixture.machine.machineId, [
      {
        sessionId: fixture.create.sessionId,
        cols: 80,
        rows: 24,
        alive: true,
        seq: 0,
      },
    ]);

    expect(fixture.socket.messages()).toContainEqual({
      type: "session_event",
      sessionId: fixture.create.sessionId,
      kind: "controller_changed",
      controllerId: fixture.root.principal.id,
    });
    fixture.store.close();
  });
  test("disconnected exit adoption records the advertised exit code", () => {
    const fixture = brokerFixture();

    expect(
      fixture.broker.adoptSession(fixture.machine.machineId, {
        sessionId: fixture.create.sessionId,
        cols: 80,
        rows: 24,
        alive: false,
        exitCode: 23,
        seq: 4,
      }),
    ).toBeFalse();

    expect(fixture.store.getSession(fixture.create.sessionId)).toMatchObject({
      status: "exited",
      exitCode: 23,
    });
    fixture.store.close();
  });

  test("successful adoption re-pends existing viewers and requests a healing snapshot", () => {
    const fixture = brokerFixture();
    fixture.broker.attach(fixture.opener, {
      type: "terminal_attach",
      sessionId: fixture.create.sessionId,
    });
    fixture.broker.onSnapshot(fixture.machine.machineId, {
      type: "snapshot",
      sessionId: fixture.create.sessionId,
      seq: 0,
      data: encoded("initial"),
    });
    fixture.socket.clear();
    fixture.machine.clear();

    expect(
      fixture.broker.adoptSession(fixture.machine.machineId, {
        sessionId: fixture.create.sessionId,
        cols: 100,
        rows: 30,
        alive: true,
        seq: 10,
      }),
    ).toBeTrue();
    expect(fixture.machine.sent).toEqual([
      { type: "snapshot_request", sessionId: fixture.create.sessionId },
    ]);

    fixture.broker.onOutput(fixture.machine.machineId, {
      type: "output",
      sessionId: fixture.create.sessionId,
      seq: 11,
      data: encoded("tail"),
    });
    expect(fixture.socket.messages()).not.toContainEqual(
      expect.objectContaining({ type: "terminal_output" }),
    );
    fixture.broker.onSnapshot(fixture.machine.machineId, {
      type: "snapshot",
      sessionId: fixture.create.sessionId,
      seq: 10,
      data: encoded("healed"),
    });
    expect(
      fixture.socket
        .messages()
        .filter(
          (message) => message.type === "terminal_snapshot" || message.type === "terminal_output",
        )
        .map((message) => [message.type, message.seq]),
    ).toEqual([
      ["terminal_snapshot", 10],
      ["terminal_output", 11],
    ]);
    fixture.store.close();
  });
});

describe("TerminalBroker bounded pending work", () => {
  test("an unanswered create times out, errors the opener, kills the orphan, and revokes", () => {
    const fixture = openingFixture();
    const token = sessionToken(fixture.create);
    expect(fixture.auth.authenticate(token).principal.kind).toBe("agent");

    fixture.clock.advance(9_999);
    expect(fixture.socket.messages()).toEqual([]);
    fixture.clock.advance(1);

    expect(fixture.socket.messages().at(-1)).toMatchObject({
      type: "error",
      code: "no_machine",
      ref: "terminal-1",
    });
    expect(fixture.machine.sent.map((message) => message.type)).toEqual(["create", "kill"]);
    expect(() => fixture.auth.authenticate(token)).toThrow(ServiceError);
    fixture.store.close();
  });

  test("an unanswered snapshot drops the viewer with an error instead of leaving PENDING", () => {
    const fixture = brokerFixture();
    fixture.broker.attach(fixture.opener, {
      type: "terminal_attach",
      sessionId: fixture.create.sessionId,
    });

    fixture.clock.advance(10_000);
    expect(fixture.socket.messages().at(-1)).toMatchObject({
      type: "error",
      code: "conflict",
      ref: fixture.create.sessionId,
    });
    fixture.broker.onSnapshot(fixture.machine.machineId, {
      type: "snapshot",
      sessionId: fixture.create.sessionId,
      seq: 0,
      data: encoded("late"),
    });
    expect(fixture.socket.messages().some((message) => message.type === "terminal_snapshot")).toBe(
      false,
    );
    fixture.store.close();
  });

  test("PENDING output overflow fails only the attach and keeps the shared socket alive", () => {
    const fixture = brokerFixture();
    fixture.broker.attach(fixture.opener, {
      type: "terminal_attach",
      sessionId: fixture.create.sessionId,
    });
    for (let seq = 1; seq <= 257; seq += 1) {
      fixture.broker.onOutput(fixture.machine.machineId, {
        type: "output",
        sessionId: fixture.create.sessionId,
        seq,
        data: encoded("x"),
      });
    }

    expect(fixture.socket.messages().at(-1)).toMatchObject({
      type: "error",
      code: "conflict",
      message: "terminal attach queue overflow",
    });
    expect(fixture.socket.closed).toBeNull();
    expect(fixture.opener.send({ type: "saved", rev: 1, at: 0 })).toBe(true);
    expect(fixture.socket.messages().at(-1)?.type).toBe("saved");
    fixture.store.close();
  });
});

describe("TerminalBroker lifecycle cleanup", () => {
  test("pad deletion kills a running PTY, drops broker state, and revokes its agent token", () => {
    const fixture = brokerFixture();
    const token = sessionToken(fixture.create);
    fixture.machine.clear();

    fixture.broker.dropPad(fixture.pad.id);
    fixture.rooms.drop(fixture.pad.id);
    fixture.store.deletePad(fixture.pad.id);

    expect(fixture.machine.sent).toEqual([{ type: "kill", sessionId: fixture.create.sessionId }]);
    expect(fixture.broker.listForPad(fixture.pad.id)).toEqual([]);
    expect(() => fixture.auth.authenticate(token)).toThrow(ServiceError);
    fixture.store.close();
  });

  test("PTY exit revokes the injected session-agent token", () => {
    const fixture = brokerFixture();
    const token = sessionToken(fixture.create);
    expect(fixture.auth.authenticate(token).principal.kind).toBe("agent");

    fixture.broker.onExited(fixture.machine.machineId, fixture.create.sessionId, 0);

    expect(() => fixture.auth.authenticate(token)).toThrow(ServiceError);
    fixture.store.close();
  });

  test("an exited terminal keeps its home leaf, so the prune leaves it alone", () => {
    const fixture = brokerFixture();
    const room = fixture.rooms.get(fixture.pad.id);
    if (room === null) throw new Error("missing room");
    room.join(fixture.opener);
    fixture.socket.clear();

    fixture.broker.onExited(fixture.machine.machineId, fixture.create.sessionId, 0);
    expect(fixture.broker.listForPad(fixture.pad.id)).toMatchObject([
      { id: fixture.create.sessionId, status: "exited", exitCode: 0 },
    ]);

    // L2: nothing is deleted on exit. The leaf survives, so the exit code stays on screen
    // until somebody dismisses it, and the prune must not dismiss it for them.
    fixture.broker.pruneExitedUnhomedForPad(fixture.pad.id);
    expect(room.homesSession(fixture.create.sessionId)).toBeTrue();
    expect(fixture.broker.listForPad(fixture.pad.id)).toHaveLength(1);
    expect(fixture.store.getSession(fixture.create.sessionId)).not.toBeNull();
    expect(fixture.store.getPad(fixture.pad.id)).not.toBeNull();
    fixture.store.close();
  });

  test("the prune collects an exited terminal whose home leaf is gone and retires the home", () => {
    const fixture = brokerFixture();
    fixture.broker.onExited(fixture.machine.machineId, fixture.create.sessionId, 0);
    const room = fixture.rooms.get(fixture.pad.id);
    if (room === null) throw new Error("missing room");

    // Listing stays pure: reading the roster never collects anything.
    expect(fixture.broker.listForPad(fixture.pad.id)).toHaveLength(1);
    expect(fixture.store.getSession(fixture.create.sessionId)).not.toBeNull();

    expect(room.removeTileLeafById(ROOT_TILE_ID)).toBeTrue();
    fixture.broker.pruneExitedUnhomedForPad(fixture.pad.id);
    expect(fixture.broker.listForPad(fixture.pad.id)).toEqual([]);
    expect(fixture.store.getSession(fixture.create.sessionId)).toBeNull();
    // The terminal was the only thing the composition held, so the composition goes too.
    expect(fixture.store.getPad(fixture.pad.id)).toBeNull();
    fixture.store.close();
  });

  test("broker lifecycle broadcasts never materialize an unloaded pad room", () => {
    const fixture = brokerFixture();
    /*
      Birth makes the home resident — it has to, since the leaf is written into the live
      document. Fencing that room leaves the pad on disk with nothing loaded, which is the
      state the rule is about: a lifecycle broadcast must reach `rooms.live`, never
      `rooms.get`, or every exit in the workspace would page a document back in.
     */
    fixture.rooms.drop(fixture.pad.id);
    expect(fixture.rooms.introspect()).toHaveLength(0);

    fixture.broker.resize(fixture.opener, {
      type: "terminal_resize",
      sessionId: fixture.create.sessionId,
      cols: 100,
      rows: 30,
    });
    fixture.broker.take(fixture.opener, {
      type: "terminal_take",
      sessionId: fixture.create.sessionId,
    });
    fixture.broker.onExited(fixture.machine.machineId, fixture.create.sessionId, 0);
    expect(fixture.rooms.introspect()).toHaveLength(0);
    fixture.store.close();
  });
});

describe("TerminalBroker live stream and control contracts", () => {
  test("control operations on an exited session all return conflict", () => {
    const fixture = brokerFixture();
    fixture.broker.onExited(fixture.machine.machineId, fixture.create.sessionId, 0);
    fixture.socket.clear();
    fixture.machine.clear();

    fixture.broker.input(fixture.opener, {
      type: "terminal_input",
      sessionId: fixture.create.sessionId,
      data: encoded("ignored"),
    });
    fixture.broker.resize(fixture.opener, {
      type: "terminal_resize",
      sessionId: fixture.create.sessionId,
      cols: 90,
      rows: 25,
    });
    fixture.broker.take(fixture.opener, {
      type: "terminal_take",
      sessionId: fixture.create.sessionId,
    });
    fixture.broker.kill(fixture.opener, {
      type: "terminal_kill",
      sessionId: fixture.create.sessionId,
    });

    expect(
      fixture.socket
        .messages()
        .filter((message) => message.type === "error")
        .map((message) => message.code),
    ).toEqual(["conflict", "conflict", "conflict", "conflict"]);
    expect(fixture.machine.sent).toEqual([]);
    fixture.store.close();
  });

  test("every peer in the terminal's HOME receives terminal_opened with its leaf", () => {
    const fixture = openingFixture();
    const room = fixture.rooms.get(fixture.pad.id);
    if (room === null) throw new Error("missing room");
    const secondSocket = new FakeSocket();
    const second = new SessionPeer(
      fixture.runtime.newId(),
      secondSocket,
      fixture.root,
      fixture.pad.id,
      "c2",
    );
    room.join(fixture.opener);
    room.join(second);
    fixture.socket.clear();
    secondSocket.clear();

    fixture.broker.onCreated(fixture.machine.machineId, fixture.create.sessionId);

    // L1: the fan-out goes to the home room, addressed by the leaf the server wrote — the
    // opener's `ref` echo is a private correlation token and never reaches other peers.
    const opened = secondSocket.messages().find((message) => message.type === "terminal_opened");
    expect(opened).toEqual({
      type: "terminal_opened",
      elementId: ROOT_TILE_ID,
      session: {
        id: fixture.create.sessionId,
        padId: fixture.pad.id,
        name: null,
        machineId: fixture.machine.machineId,
        status: "running",
        exitCode: null,
        cols: 80,
        rows: 24,
        controllerId: fixture.root.principal.id,
        createdBy: fixture.root.principal.id,
      },
    });
    expect(
      fixture.socket.messages().find((message) => message.type === "terminal_opened"),
    ).toMatchObject({ elementId: ROOT_TILE_ID, ref: "terminal-1" });
    fixture.store.close();
  });

  test("duplicate and regressed output seq values are dropped on the LIVE path", () => {
    const fixture = brokerFixture();
    fixture.broker.attach(fixture.opener, {
      type: "terminal_attach",
      sessionId: fixture.create.sessionId,
    });
    fixture.broker.onSnapshot(fixture.machine.machineId, {
      type: "snapshot",
      sessionId: fixture.create.sessionId,
      seq: 0,
      data: encoded("snapshot"),
    });
    fixture.socket.clear();

    for (const seq of [2, 2, 1, 3]) {
      fixture.broker.onOutput(fixture.machine.machineId, {
        type: "output",
        sessionId: fixture.create.sessionId,
        seq,
        data: encoded(`output-${seq}`),
      });
    }

    expect(
      fixture.socket
        .messages()
        .filter((message) => message.type === "terminal_output")
        .map((message) => message.seq),
    ).toEqual([2, 3]);
    fixture.store.close();
  });
});

describe("TerminalBroker concurrent snapshot generations", () => {
  test("one outstanding request preserves each viewer's own snapshot-plus-tail watermark", () => {
    const fixture = brokerFixture();
    // The home's own debounced save timers are armed by birth; the attach handoff must give
    // back every timer it takes, so the count has to return to exactly this baseline.
    const armedByBirth = fixture.clock.pendingJobs;
    const secondSocket = new FakeSocket();
    const second = new SessionPeer(
      fixture.runtime.newId(),
      secondSocket,
      fixture.root,
      fixture.pad.id,
      "c2",
    );

    fixture.broker.attach(fixture.opener, {
      type: "terminal_attach",
      sessionId: fixture.create.sessionId,
    });
    fixture.broker.attach(second, {
      type: "terminal_attach",
      sessionId: fixture.create.sessionId,
    });
    expect(
      fixture.machine.sent.filter((message) => message.type === "snapshot_request"),
    ).toHaveLength(1);

    fixture.broker.onSnapshot(fixture.machine.machineId, {
      type: "snapshot",
      sessionId: fixture.create.sessionId,
      seq: 42,
      data: encoded("snapshot-42"),
    });
    expect(
      fixture.machine.sent.filter((message) => message.type === "snapshot_request"),
    ).toHaveLength(2);
    fixture.broker.onSnapshot(fixture.machine.machineId, {
      type: "snapshot",
      sessionId: fixture.create.sessionId,
      seq: 59,
      data: encoded("snapshot-59"),
    });
    fixture.broker.onSnapshot(fixture.machine.machineId, {
      type: "snapshot",
      sessionId: fixture.create.sessionId,
      seq: 26,
      data: encoded("stale-out-of-order-snapshot"),
    });

    for (const seq of [43, 44, 45, 45, 44, 60]) {
      fixture.broker.onOutput(fixture.machine.machineId, {
        type: "output",
        sessionId: fixture.create.sessionId,
        seq,
        data: encoded(`output-${seq}`),
      });
    }

    const firstStream = fixture.socket
      .messages()
      .filter(
        (message) => message.type === "terminal_snapshot" || message.type === "terminal_output",
      )
      .map((message) => [message.type, message.seq]);
    const secondStream = secondSocket
      .messages()
      .filter(
        (message) => message.type === "terminal_snapshot" || message.type === "terminal_output",
      )
      .map((message) => [message.type, message.seq]);
    expect(firstStream).toEqual([
      ["terminal_snapshot", 42],
      ["terminal_output", 43],
      ["terminal_output", 44],
      ["terminal_output", 45],
      ["terminal_output", 60],
    ]);
    expect(secondStream).toEqual([
      ["terminal_snapshot", 59],
      ["terminal_output", 60],
    ]);
    expect(fixture.clock.pendingJobs).toBe(armedByBirth);
    fixture.store.close();
  });
});

describe("TerminalBroker pending-open room residency", () => {
  test("a pending open blocks eviction until its create fails", () => {
    const fixture = openingFixture();
    const room = fixture.rooms.get(fixture.pad.id);
    if (room === null) throw new Error("missing room");
    room.join(fixture.opener);
    fixture.socket.clear();

    room.leave(fixture.opener);
    expect(fixture.broker.hasPendingOpenForPad(fixture.pad.id)).toBe(true);
    expect(fixture.rooms.introspect()).toHaveLength(1);

    fixture.broker.onCreateError(fixture.machine.machineId, fixture.create.sessionId);
    expect(fixture.broker.hasPendingOpenForPad(fixture.pad.id)).toBe(false);
    expect(fixture.rooms.introspect()).toHaveLength(0);
    fixture.store.close();
  });
});
