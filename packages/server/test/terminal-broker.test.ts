import { describe, expect, test } from "bun:test";
import {
  PROTOCOL_VERSION,
  ROOT_TILE_ID,
  ServerToAgentMessageSchema,
  TERMINAL_PROGRAM_MIN_PROTOCOL_VERSION,
  type Container,
  type ServerToAgentMessage,
} from "@manifold/protocol";
import { AuthService, ServiceError } from "../src/auth.ts";
import { silentLogger } from "../src/log.ts";
import { PlaceExecutor, assemblyPlacementVocabulary, assemblyItemNouns } from "../src/placement.ts";
import { RoomManager } from "../src/room.ts";
import { SessionChannel } from "../src/session-channel.ts";
import { TerminalBroker, type MachineChannel } from "../src/terminal-broker.ts";
import { FakeClock, FakeRuntime, FakeSocket, testStore, testTileTrees } from "./helpers.ts";

class FakeMachine implements MachineChannel {
  readonly sent: ServerToAgentMessage[] = [];

  constructor(
    readonly machineId: string,
    readonly protocolVersion: number = PROTOCOL_VERSION,
    readonly terminalHostId: string | null = null,
  ) {}

  send(message: ServerToAgentMessage): boolean {
    this.sent.push(ServerToAgentMessageSchema.parse(message));
    return true;
  }

  clear(): void {
    this.sent.length = 0;
  }
}

/**
 * Everything a broker needs to be asked for a terminal, up to and including the opener's
 * channel, with the one machine online at `agentProtocolVersion`. The composition it builds
 * is where a terminal lives: the container IS the home, so the opener's own container is the
 * one the terminal is homed in and every terminal-scoped message it sends is addressed to
 * the right room. A canvas opener would be homed in a solo composition it is not joined to,
 * which is the lifecycle rule under test elsewhere, not the plumbing under test here.
 */
function brokerSetup(agentProtocolVersion: number = PROTOCOL_VERSION) {
  const runtime = new FakeRuntime();
  const clock = new FakeClock(runtime);
  const store = testStore();
  const auth = new AuthService(store, "b".repeat(64), runtime);
  const root = auth.authenticate("b".repeat(64));
  const container: Container = {
    id: runtime.newId(),
    name: "terminal composition",
    createdAt: runtime.now(),
    discipline: "composition",
  };
  store.createContainer(container);
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
  // Terminals are a FLOOR item kind, so this fixture needs no contributed traits: it never
  // places a plugin-owned element, and an empty roster is the honest input for that.
  broker.setPlacement(
    new PlaceExecutor(
      store,
      rooms,
      broker,
      runtime,
      assemblyPlacementVocabulary(() => []),
      assemblyItemNouns(() => []),
    ),
  );
  const enrollment = auth.enrollMachine("fake", root);
  const machine = new FakeMachine(enrollment.machine.id, agentProtocolVersion);
  broker.setMachineOnline(machine);
  const socket = new FakeSocket();
  const opener = new SessionChannel(runtime.newId(), socket, root, container.id, "c1");
  return { runtime, clock, store, auth, root, container, rooms, broker, machine, socket, opener };
}

/** {@link brokerSetup} plus the opener's first `terminal_open`, with the `create` it produced. */
function openingFixture() {
  const setup = brokerSetup();
  setup.broker.open(setup.opener, {
    type: "terminal_open",
    elementId: "terminal-1",
    cols: 80,
    rows: 24,
    placement: "tile",
  });
  const create = setup.machine.sent.find((message) => message.type === "create");
  if (create === undefined || create.type !== "create") throw new Error("missing create request");
  return { ...setup, create };
}

function brokerFixture() {
  const fixture = openingFixture();
  fixture.broker.onCreated(fixture.machine.machineId, fixture.create.terminalId);
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
      terminalId: fixture.create.terminalId,
    });
    expect(fixture.machine.sent).toEqual([
      { type: "snapshot_request", terminalId: fixture.create.terminalId },
    ]);

    for (let seq = 1; seq <= 6; seq += 1) {
      fixture.broker.onOutput(fixture.machine.machineId, {
        type: "output",
        terminalId: fixture.create.terminalId,
        seq,
        data: encoded(`output-${seq}`),
      });
    }
    for (let seq = 7; seq <= 10; seq += 1) {
      fixture.broker.onOutput(fixture.machine.machineId, {
        type: "output",
        terminalId: fixture.create.terminalId,
        seq,
        data: encoded(`output-${seq}`),
      });
    }
    fixture.broker.onSnapshot(fixture.machine.machineId, {
      type: "snapshot",
      terminalId: fixture.create.terminalId,
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
  test("gates input and resize until terminal_take transfers control", () => {
    const fixture = brokerFixture();
    const grant = fixture.auth.mintToken(
      {
        principal: { name: "second controller", kind: "human" },
        caps: ["containers:read", "terminals:write"],
        containerId: fixture.container.id,
      },
      fixture.root,
    );
    const secondContext = fixture.auth.authenticate(grant.token);
    const secondSocket = new FakeSocket();
    const second = new SessionChannel(
      fixture.runtime.newId(),
      secondSocket,
      secondContext,
      fixture.container.id,
      "c2",
    );

    fixture.broker.input(second, {
      type: "terminal_input",
      terminalId: fixture.create.terminalId,
      data: encoded("denied"),
    });
    fixture.broker.resize(second, {
      type: "terminal_resize",
      terminalId: fixture.create.terminalId,
      cols: 100,
      rows: 30,
    });
    expect(fixture.machine.sent).toEqual([]);
    expect(
      secondSocket
        .messages()
        .filter((message) => message.type === "error")
        .map((message) => message.code),
    ).toEqual(["not_controller", "not_controller"]);

    fixture.broker.take(second, {
      type: "terminal_take",
      terminalId: fixture.create.terminalId,
    });
    fixture.broker.input(second, {
      type: "terminal_input",
      terminalId: fixture.create.terminalId,
      data: encoded("allowed"),
    });
    fixture.broker.resize(second, {
      type: "terminal_resize",
      terminalId: fixture.create.terminalId,
      cols: 120,
      rows: 40,
    });
    expect(fixture.machine.sent.map((message) => message.type)).toEqual(["input", "resize"]);

    fixture.socket.clear();
    fixture.broker.input(fixture.opener, {
      type: "terminal_input",
      terminalId: fixture.create.terminalId,
      data: encoded("former-controller"),
    });
    expect(fixture.socket.messages().at(-1)).toMatchObject({
      type: "error",
      code: "not_controller",
    });

    // The kill comes last because it is DESTRUCTION, and it no longer goes through this
    // class's own door: `core.terminals.kill` is the only one, and the lease rule it applies
    // is tested where it now lives (packages/server/test/plugin-host.test.ts). What the
    // broker still owes is the mechanism — the PTY is asked to stop.
    expect(fixture.broker.killById(fixture.create.terminalId)).toBe("ok");
    expect(fixture.machine.sent.map((message) => message.type)).toEqual([
      "input",
      "resize",
      "kill",
    ]);
    expect(fixture.broker.listForContainer(fixture.container.id)).toEqual([]);
    expect(fixture.store.getTerminal(fixture.create.terminalId)).toBeNull();
    fixture.store.close();
  });

  test("an offline kill removes the terminal anyway and kills the PTY if its machine returns", () => {
    const fixture = brokerFixture();
    const room = fixture.rooms.get(fixture.container.id);
    if (room === null) throw new Error("missing room");
    room.join(fixture.opener);
    fixture.socket.clear();
    fixture.broker.setMachineOffline(fixture.machine);

    expect(fixture.broker.killById(fixture.create.terminalId)).toBe("ok");

    // Undeliverable is not a reason to keep the terminal. The request was the whole intent,
    // so the terminal, its row and the home it was the last occupant of all go, and nobody is
    // left staring at an entry that outlived what it described.
    expect(fixture.broker.listForContainer(fixture.container.id)).toEqual([]);
    expect(fixture.store.getTerminal(fixture.create.terminalId)).toBeNull();
    expect(fixture.store.getContainer(fixture.container.id)).toBeNull();
    // And no EXIT is announced: an exit is what a terminal that stopped ON ITS OWN reports,
    // and inventing one here is exactly the state this rule exists to forbid. What the home
    // hears is the departure notice, which is what drops the row from every terminal listing.
    expect(
      fixture.socket.messages().filter((message) => message.type === "terminal_event"),
    ).toEqual([{ type: "terminal_event", terminalId: fixture.create.terminalId, kind: "parked" }]);

    // The durability the persisted exit used to buy now comes from the ABSENCE of a row: a
    // PTY that outlived an undeliverable kill has nothing to be adopted against, so hello
    // reconciliation kills it outright — the hello is the owner's, because the gateway
    // admits no other (#278).
    fixture.broker.setMachineOnline(fixture.machine);
    fixture.broker.reconcileMachineHello(fixture.machine.machineId, [
      {
        terminalId: fixture.create.terminalId,
        cols: 80,
        rows: 24,
        alive: true,
        seq: 0,
      },
    ]);
    expect(fixture.machine.sent).toContainEqual({
      type: "kill",
      terminalId: fixture.create.terminalId,
    });
    fixture.store.close();
  });

  test("terminal re-adoption broadcasts the reset controller lease", () => {
    const fixture = brokerFixture();
    const room = fixture.rooms.get(fixture.container.id);
    if (room === null) throw new Error("missing room");
    room.join(fixture.opener);
    fixture.socket.clear();
    const grant = fixture.auth.mintToken(
      {
        principal: { name: "pre-restart controller", kind: "human" },
        caps: ["containers:read", "terminals:write"],
        containerId: fixture.container.id,
      },
      fixture.root,
    );
    const controller = new SessionChannel(
      fixture.runtime.newId(),
      new FakeSocket(),
      fixture.auth.authenticate(grant.token),
      fixture.container.id,
      "c2",
    );
    fixture.broker.take(controller, {
      type: "terminal_take",
      terminalId: fixture.create.terminalId,
    });
    expect(fixture.socket.messages().at(-1)).toMatchObject({
      type: "terminal_event",
      terminalId: fixture.create.terminalId,
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
      testTileTrees,
    );
    restarted.reconcileMachineHello(fixture.machine.machineId, [
      {
        terminalId: fixture.create.terminalId,
        cols: 80,
        rows: 24,
        alive: true,
        seq: 0,
      },
    ]);

    expect(fixture.socket.messages()).toContainEqual({
      type: "terminal_event",
      terminalId: fixture.create.terminalId,
      kind: "controller_changed",
      controllerId: fixture.root.principal.id,
    });
    fixture.store.close();
  });
  test("disconnected exit adoption records the advertised exit code", () => {
    const fixture = brokerFixture();

    expect(
      fixture.broker.adoptTerminal(fixture.machine.machineId, {
        terminalId: fixture.create.terminalId,
        cols: 80,
        rows: 24,
        alive: false,
        exitCode: 23,
        seq: 4,
      }),
    ).toBeFalse();

    expect(fixture.store.getTerminal(fixture.create.terminalId)).toMatchObject({
      status: "exited",
      exitCode: 23,
    });
    fixture.store.close();
  });

  test("successful adoption re-pends existing viewers and requests a healing snapshot", () => {
    const fixture = brokerFixture();
    fixture.broker.attach(fixture.opener, {
      type: "terminal_attach",
      terminalId: fixture.create.terminalId,
    });
    fixture.broker.onSnapshot(fixture.machine.machineId, {
      type: "snapshot",
      terminalId: fixture.create.terminalId,
      seq: 0,
      data: encoded("initial"),
    });
    fixture.socket.clear();
    fixture.machine.clear();

    expect(
      fixture.broker.adoptTerminal(fixture.machine.machineId, {
        terminalId: fixture.create.terminalId,
        cols: 100,
        rows: 30,
        alive: true,
        seq: 10,
      }),
    ).toBeTrue();
    expect(fixture.machine.sent).toEqual([
      { type: "snapshot_request", terminalId: fixture.create.terminalId },
    ]);

    fixture.broker.onOutput(fixture.machine.machineId, {
      type: "output",
      terminalId: fixture.create.terminalId,
      seq: 11,
      data: encoded("tail"),
    });
    expect(fixture.socket.messages()).not.toContainEqual(
      expect.objectContaining({ type: "terminal_output" }),
    );
    fixture.broker.onSnapshot(fixture.machine.machineId, {
      type: "snapshot",
      terminalId: fixture.create.terminalId,
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
      terminalId: fixture.create.terminalId,
    });

    fixture.clock.advance(10_000);
    expect(fixture.socket.messages().at(-1)).toMatchObject({
      type: "error",
      code: "conflict",
      ref: fixture.create.terminalId,
    });
    fixture.broker.onSnapshot(fixture.machine.machineId, {
      type: "snapshot",
      terminalId: fixture.create.terminalId,
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
      terminalId: fixture.create.terminalId,
    });
    for (let seq = 1; seq <= 257; seq += 1) {
      fixture.broker.onOutput(fixture.machine.machineId, {
        type: "output",
        terminalId: fixture.create.terminalId,
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
  test("container deletion kills a running PTY, drops broker state, and revokes its agent token", () => {
    const fixture = brokerFixture();
    const token = sessionToken(fixture.create);
    fixture.machine.clear();

    fixture.broker.dropContainer(fixture.container.id);
    fixture.rooms.drop(fixture.container.id);
    fixture.store.deleteContainer(fixture.container.id);

    expect(fixture.machine.sent).toEqual([{ type: "kill", terminalId: fixture.create.terminalId }]);
    expect(fixture.broker.listForContainer(fixture.container.id)).toEqual([]);
    expect(() => fixture.auth.authenticate(token)).toThrow(ServiceError);
    fixture.store.close();
  });

  test("PTY exit revokes the injected session-agent token", () => {
    const fixture = brokerFixture();
    const token = sessionToken(fixture.create);
    expect(fixture.auth.authenticate(token).principal.kind).toBe("agent");

    fixture.broker.onExited(fixture.machine.machineId, fixture.create.terminalId, 0);

    expect(() => fixture.auth.authenticate(token)).toThrow(ServiceError);
    fixture.store.close();
  });

  test("an exited terminal keeps its home leaf, so the prune leaves it alone", () => {
    const fixture = brokerFixture();
    const room = fixture.rooms.get(fixture.container.id);
    if (room === null) throw new Error("missing room");
    room.join(fixture.opener);
    fixture.socket.clear();

    fixture.broker.onExited(fixture.machine.machineId, fixture.create.terminalId, 0);
    expect(fixture.broker.listForContainer(fixture.container.id)).toMatchObject([
      { id: fixture.create.terminalId, status: "exited", exitCode: 0 },
    ]);

    // L2: nothing is deleted on exit. The leaf survives, so the exit code stays on screen
    // until somebody dismisses it, and the prune must not dismiss it for them.
    fixture.broker.pruneExitedUnhomedForContainer(fixture.container.id);
    expect(room.homesTerminal(fixture.create.terminalId)).toBeTrue();
    expect(fixture.broker.listForContainer(fixture.container.id)).toHaveLength(1);
    expect(fixture.store.getTerminal(fixture.create.terminalId)).not.toBeNull();
    expect(fixture.store.getContainer(fixture.container.id)).not.toBeNull();
    fixture.store.close();
  });

  test("the prune collects an exited terminal whose home leaf is gone and retires the home", () => {
    const fixture = brokerFixture();
    fixture.broker.onExited(fixture.machine.machineId, fixture.create.terminalId, 0);
    const room = fixture.rooms.get(fixture.container.id);
    if (room === null) throw new Error("missing room");

    // Listing stays pure: reading the terminal listing never collects anything.
    expect(fixture.broker.listForContainer(fixture.container.id)).toHaveLength(1);
    expect(fixture.store.getTerminal(fixture.create.terminalId)).not.toBeNull();

    expect(room.removeTileLeafById(ROOT_TILE_ID)).toBeTrue();
    fixture.broker.pruneExitedUnhomedForContainer(fixture.container.id);
    expect(fixture.broker.listForContainer(fixture.container.id)).toEqual([]);
    expect(fixture.store.getTerminal(fixture.create.terminalId)).toBeNull();
    // The terminal was the only thing the composition held, so the composition goes too.
    expect(fixture.store.getContainer(fixture.container.id)).toBeNull();
    fixture.store.close();
  });

  test("broker lifecycle broadcasts never materialize an unloaded container room", () => {
    const fixture = brokerFixture();
    /*
      Birth makes the home resident — it has to, since the leaf is written into the live
      document. Fencing that room leaves the container on disk with nothing loaded, which is
      the state the rule is about: a lifecycle broadcast must reach `rooms.live`, never
      `rooms.get`, or every exit in the workspace would page a document back in.
     */
    fixture.rooms.drop(fixture.container.id);
    expect(fixture.rooms.introspect()).toHaveLength(0);

    fixture.broker.resize(fixture.opener, {
      type: "terminal_resize",
      terminalId: fixture.create.terminalId,
      cols: 100,
      rows: 30,
    });
    fixture.broker.take(fixture.opener, {
      type: "terminal_take",
      terminalId: fixture.create.terminalId,
    });
    fixture.broker.onExited(fixture.machine.machineId, fixture.create.terminalId, 0);
    expect(fixture.rooms.introspect()).toHaveLength(0);
    fixture.store.close();
  });
});

describe("TerminalBroker live stream and control contracts", () => {
  test("driving an exited terminal conflicts, but dismissing it is the kill it asked for", () => {
    const fixture = brokerFixture();
    fixture.broker.onExited(fixture.machine.machineId, fixture.create.terminalId, 0);
    fixture.socket.clear();
    fixture.machine.clear();

    fixture.broker.input(fixture.opener, {
      type: "terminal_input",
      terminalId: fixture.create.terminalId,
      data: encoded("ignored"),
    });
    fixture.broker.resize(fixture.opener, {
      type: "terminal_resize",
      terminalId: fixture.create.terminalId,
      cols: 90,
      rows: 25,
    });
    fixture.broker.take(fixture.opener, {
      type: "terminal_take",
      terminalId: fixture.create.terminalId,
    });

    // Driving a dead PTY is a conflict: there is nothing on the other end to drive.
    expect(
      fixture.socket
        .messages()
        .filter((message) => message.type === "error")
        .map((message) => message.code),
    ).toEqual(["conflict", "conflict", "conflict"]);

    expect(fixture.broker.killById(fixture.create.terminalId)).toBe("ok");

    // Killing one is not. A lease is a claim on a LIVE PTY, so an exited terminal has no
    // controller to win and dismissing it is the same verb as killing a running one — which
    // is why "kill" refusing here would leave dead terminals nobody could clear.
    expect(
      fixture.socket
        .messages()
        .filter((message) => message.type === "error")
        .map((message) => message.code),
    ).toEqual(["conflict", "conflict", "conflict"]);
    expect(fixture.store.getTerminal(fixture.create.terminalId)).toBeNull();
    expect(fixture.store.getContainer(fixture.container.id)).toBeNull();
    // No PTY was asked to stop: it already had.
    expect(fixture.machine.sent).toEqual([]);
    fixture.store.close();
  });

  test("every peer in the terminal's HOME receives terminal_opened with its leaf", () => {
    const fixture = openingFixture();
    const room = fixture.rooms.get(fixture.container.id);
    if (room === null) throw new Error("missing room");
    const secondSocket = new FakeSocket();
    const second = new SessionChannel(
      fixture.runtime.newId(),
      secondSocket,
      fixture.root,
      fixture.container.id,
      "c2",
    );
    room.join(fixture.opener);
    room.join(second);
    fixture.socket.clear();
    secondSocket.clear();

    fixture.broker.onCreated(fixture.machine.machineId, fixture.create.terminalId);

    // L1: the fan-out goes to the home room, addressed by the leaf the server wrote — the
    // opener's `ref` echo is a private correlation token and never reaches other peers.
    const opened = secondSocket.messages().find((message) => message.type === "terminal_opened");
    expect(opened).toEqual({
      type: "terminal_opened",
      elementId: ROOT_TILE_ID,
      terminal: {
        id: fixture.create.terminalId,
        containerId: fixture.container.id,
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
      terminalId: fixture.create.terminalId,
    });
    fixture.broker.onSnapshot(fixture.machine.machineId, {
      type: "snapshot",
      terminalId: fixture.create.terminalId,
      seq: 0,
      data: encoded("snapshot"),
    });
    fixture.socket.clear();

    for (const seq of [2, 2, 1, 3]) {
      fixture.broker.onOutput(fixture.machine.machineId, {
        type: "output",
        terminalId: fixture.create.terminalId,
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
    const second = new SessionChannel(
      fixture.runtime.newId(),
      secondSocket,
      fixture.root,
      fixture.container.id,
      "c2",
    );

    fixture.broker.attach(fixture.opener, {
      type: "terminal_attach",
      terminalId: fixture.create.terminalId,
    });
    fixture.broker.attach(second, {
      type: "terminal_attach",
      terminalId: fixture.create.terminalId,
    });
    expect(
      fixture.machine.sent.filter((message) => message.type === "snapshot_request"),
    ).toHaveLength(1);

    fixture.broker.onSnapshot(fixture.machine.machineId, {
      type: "snapshot",
      terminalId: fixture.create.terminalId,
      seq: 42,
      data: encoded("snapshot-42"),
    });
    expect(
      fixture.machine.sent.filter((message) => message.type === "snapshot_request"),
    ).toHaveLength(2);
    fixture.broker.onSnapshot(fixture.machine.machineId, {
      type: "snapshot",
      terminalId: fixture.create.terminalId,
      seq: 59,
      data: encoded("snapshot-59"),
    });
    fixture.broker.onSnapshot(fixture.machine.machineId, {
      type: "snapshot",
      terminalId: fixture.create.terminalId,
      seq: 26,
      data: encoded("stale-out-of-order-snapshot"),
    });

    for (const seq of [43, 44, 45, 45, 44, 60]) {
      fixture.broker.onOutput(fixture.machine.machineId, {
        type: "output",
        terminalId: fixture.create.terminalId,
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
    const room = fixture.rooms.get(fixture.container.id);
    if (room === null) throw new Error("missing room");
    room.join(fixture.opener);
    fixture.socket.clear();

    room.leave(fixture.opener);
    expect(fixture.broker.hasPendingOpenForContainer(fixture.container.id)).toBe(true);
    expect(fixture.rooms.introspect()).toHaveLength(1);

    fixture.broker.onCreateError(fixture.machine.machineId, fixture.create.terminalId);
    expect(fixture.broker.hasPendingOpenForContainer(fixture.container.id)).toBe(false);
    expect(fixture.rooms.introspect()).toHaveLength(0);
    fixture.store.close();
  });
});

describe("TerminalBroker program and env (issue #192)", () => {
  test("the opener's env rides under the fixed keys, and the program rides verbatim", () => {
    const setup = brokerSetup();
    setup.broker.open(setup.opener, {
      type: "terminal_open",
      elementId: "terminal-program",
      cols: 80,
      rows: 24,
      placement: "tile",
      program: { argv: ["/bin/sh", "-c", "printf CMD_OK"] },
      env: { CODE_TEST: "x" },
    });
    const create = setup.machine.sent.find((message) => message.type === "create");
    if (create === undefined || create.type !== "create") throw new Error("missing create");
    expect(create.program).toEqual({ argv: ["/bin/sh", "-c", "printf CMD_OK"] });
    // The four minted keys are the LAST written: they read after the opener's own, so an
    // opener's key can never shadow them even before the schema refuses the prefix.
    expect(Object.keys(create.env)).toEqual([
      "CODE_TEST",
      "MANIFOLD_URL",
      "MANIFOLD_CONTAINER",
      "MANIFOLD_TOKEN",
    ]);
    expect(create.env.CODE_TEST).toBe("x");
    expect(create.env.MANIFOLD_CONTAINER).toBe(setup.container.id);
    setup.store.close();
  });

  test("a program aimed at a pre-v22 agent is refused unsupported, and nothing is minted", () => {
    /*
      The agent parses `create` strictly, so a `program` key would be a malformed frame to
      an agent that predates it — it would drop its socket and the opener would learn
      nothing. The broker refuses BEFORE the token is minted or the deadline armed, so the
      refusal leaves no pending open, no principal and no frame on the machine channel.
    */
    const setup = brokerSetup(TERMINAL_PROGRAM_MIN_PROTOCOL_VERSION - 1);
    setup.broker.open(setup.opener, {
      type: "terminal_open",
      elementId: "terminal-too-new",
      cols: 80,
      rows: 24,
      placement: "tile",
      program: { argv: ["/bin/sh"] },
    });
    expect(setup.machine.sent).toEqual([]);
    expect(setup.broker.hasPendingOpenForContainer(setup.container.id)).toBe(false);
    const errors = setup.socket.messages().filter((message) => message.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: "unsupported", ref: "terminal-too-new" });

    // The same agent still births a plain shell: absence of the field IS the old gesture.
    setup.socket.clear();
    setup.broker.open(setup.opener, {
      type: "terminal_open",
      elementId: "terminal-plain",
      cols: 80,
      rows: 24,
      placement: "tile",
      env: { CODE_TEST: "x" },
    });
    const create = setup.machine.sent.find((message) => message.type === "create");
    if (create === undefined || create.type !== "create") throw new Error("missing create");
    expect("program" in create).toBe(false);
    expect(create.env.CODE_TEST).toBe("x");
    setup.store.close();
  });
});

/**
 * THE ADMISSION CONTRACT (#278): the latch closes BEFORE the owner is asked, the owner's
 * answer is behind every create the hub sent, and every way the owner cannot answer leaves
 * admission closed. A drain never kills, exits or forgets anything.
 */
describe("TerminalBroker drain (issue #278)", () => {
  /** A machine whose agent names an owner and answers drains under the test's control. */
  function drainSetup() {
    const setup = brokerSetup();
    const machine = new FakeMachine(setup.machine.machineId, PROTOCOL_VERSION, "host-A");
    setup.broker.setMachineOnline(machine);
    machine.clear();
    const answer = (
      request: ServerToAgentMessage,
      overrides: Partial<{ terminalHostId: string; draining: boolean; terminalIds: string[] }> = {},
    ): void => {
      if (request.type !== "drain") throw new Error("expected a drain request");
      setup.broker.onDrainStatus(machine.machineId, {
        type: "drain_status",
        requestId: request.requestId,
        terminalHostId: "host-A",
        draining: request.draining,
        terminalIds: [],
        ...overrides,
      });
    };
    const lastRequest = (): ServerToAgentMessage => {
      const request = machine.sent.at(-1);
      if (request === undefined) throw new Error("nothing was sent to the machine");
      return request;
    };
    return { ...setup, machine, answer, lastRequest };
  }

  test("draining closes admission first, then reports what the owner holds behind every create", async () => {
    const setup = drainSetup();
    // A create already on the wire when the drain is requested: the owner's report is
    // ordered behind it, so its id is in the answer even though `created` has not landed.
    setup.broker.open(setup.opener, {
      type: "terminal_open",
      elementId: "in-flight",
      cols: 80,
      rows: 24,
      placement: "tile",
    });
    const create = setup.machine.sent.find((message) => message.type === "create");
    if (create === undefined || create.type !== "create") throw new Error("missing create");

    const outcome = setup.broker.drain(setup.machine.machineId, true);
    // The latch is set synchronously, and persisted, before the owner has answered anything.
    expect(setup.broker.isMachineDraining(setup.machine.machineId)).toBe(true);
    expect(setup.store.getMachine(setup.machine.machineId)?.draining).toBe(true);
    expect(setup.lastRequest()).toMatchObject({ type: "drain", draining: true });
    setup.socket.clear();
    setup.broker.open(setup.opener, {
      type: "terminal_open",
      elementId: "too-late",
      cols: 80,
      rows: 24,
      placement: "tile",
    });
    expect(setup.socket.messages()).toEqual([
      expect.objectContaining({ type: "error", code: "conflict", ref: "too-late" }),
    ]);
    expect(setup.machine.sent.filter((message) => message.type === "create")).toHaveLength(1);

    setup.answer(setup.lastRequest(), { terminalIds: [create.terminalId] });
    expect(await outcome).toEqual({
      ok: true,
      status: { terminalHostId: "host-A", draining: true, terminalIds: [create.terminalId] },
    });
    // The in-flight create still commits: closing admission is not killing work.
    setup.broker.onCreated(setup.machine.machineId, create.terminalId);
    expect(setup.store.getTerminal(create.terminalId)?.status).toBe("running");

    // Cancel is the only thing that reopens it.
    const cancel = setup.broker.drain(setup.machine.machineId, false);
    expect(setup.broker.isMachineDraining(setup.machine.machineId)).toBe(false);
    setup.answer(setup.lastRequest(), { terminalIds: [create.terminalId] });
    expect((await cancel).ok).toBe(true);
    setup.socket.clear();
    setup.broker.open(setup.opener, {
      type: "terminal_open",
      elementId: "after-cancel",
      cols: 80,
      rows: 24,
      placement: "tile",
    });
    expect(setup.machine.sent.filter((message) => message.type === "create")).toHaveLength(2);
    setup.store.close();
  });

  test("an owner that cannot answer is a refusal, and admission stays closed", async () => {
    const setup = drainSetup();

    // Deadline.
    const timedOut = setup.broker.drain(setup.machine.machineId, true);
    setup.clock.advance(10_000);
    expect((await timedOut).ok).toBe(false);
    expect(setup.broker.isMachineDraining(setup.machine.machineId)).toBe(true);

    // Wrong owner answering.
    const wrongOwner = setup.broker.drain(setup.machine.machineId, true);
    setup.answer(setup.lastRequest(), { terminalHostId: "host-B" });
    expect((await wrongOwner).ok).toBe(false);

    // Owner that did not apply the state.
    const notApplied = setup.broker.drain(setup.machine.machineId, true);
    setup.answer(setup.lastRequest(), { draining: false });
    expect((await notApplied).ok).toBe(false);

    // A late answer to a superseded request is ignored, not credited to the new one.
    const first = setup.broker.drain(setup.machine.machineId, true);
    const firstRequest = setup.lastRequest();
    const second = setup.broker.drain(setup.machine.machineId, true);
    expect((await first).ok).toBe(false);
    setup.answer(firstRequest, { terminalIds: ["stale"] });
    setup.answer(setup.lastRequest(), { terminalIds: ["t1"] });
    expect(await second).toEqual({
      ok: true,
      status: { terminalHostId: "host-A", draining: true, terminalIds: ["t1"] },
    });

    // Offline: unknown, and still closed.
    setup.broker.setMachineOffline(setup.machine);
    expect((await setup.broker.drain(setup.machine.machineId, true)).ok).toBe(false);
    expect(setup.broker.isMachineDraining(setup.machine.machineId)).toBe(true);
    expect(setup.store.getMachine(setup.machine.machineId)?.draining).toBe(true);

    // Disconnect mid-request fails closed rather than waiting out the deadline.
    setup.broker.setMachineOnline(setup.machine);
    const midway = setup.broker.drain(setup.machine.machineId, true);
    setup.broker.setMachineOffline(setup.machine);
    expect((await midway).ok).toBe(false);
    setup.store.close();
  });

  test("a pre-v24 agent cannot be drained, but the hub's half still refuses new terminals", async () => {
    const setup = brokerSetup();
    const outcome = await setup.broker.drain(setup.machine.machineId, true);
    expect(outcome.ok).toBe(false);
    expect(setup.machine.sent).toEqual([]);
    setup.broker.open(setup.opener, {
      type: "terminal_open",
      elementId: "refused",
      cols: 80,
      rows: 24,
      placement: "tile",
    });
    expect(setup.machine.sent).toEqual([]);
    expect(setup.socket.messages()).toEqual([
      expect.objectContaining({ type: "error", code: "conflict", ref: "refused" }),
    ]);
    // A cancel with nobody to tell still reopens the hub's half.
    expect((await setup.broker.drain(setup.machine.machineId, false)).ok).toBe(false);
    expect(setup.broker.isMachineDraining(setup.machine.machineId)).toBe(false);
    setup.store.close();
  });
});
