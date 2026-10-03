import { describe, expect, test } from "bun:test";
import {
  ROOT_TILE_ID,
  PROTOCOL_VERSION,
  ServerToAgentMessageSchema,
  MAX_TERMINAL_DELIVERY_PENDING_FRAMES,
  MAX_TERMINAL_DELIVERY_UNACKED_BYTES,
  MAX_TERMINAL_DELIVERY_UNACKED_FRAMES,
  MAX_TERMINAL_VIEWPORTS,
  TERMINAL_VIEWPORT_LEASE_MS,
  TERMINAL_GEOMETRY_PROTOCOL_VERSION,
  type TerminalGeometry,
  type Container,
  type ServerMessage,
  type ServerToAgentMessage,
} from "@manifold/protocol";
import { AuthService, ServiceError } from "../src/auth.ts";
import { silentLogger } from "../src/log.ts";
import { PlaceExecutor, assemblyPlacementVocabulary, assemblyItemNouns } from "../src/placement.ts";
import { RoomManager } from "../src/room.ts";
import { SessionChannel } from "../src/session-channel.ts";
import { TerminalBroker, type MachineChannel } from "../src/terminal-broker.ts";
import {
  FakeClock,
  FakeRuntime,
  FakeSocket,
  testPluginHost,
  testStore,
  testTileTrees,
} from "./helpers.ts";

class FakeMachine implements MachineChannel {
  readonly sent: ServerToAgentMessage[] = [];
  readonly terminalRestart = true;
  acceptResize = true;

  constructor(
    readonly machineId: string,
    readonly terminalHostId: string | null = null,
    readonly terminalExecution: MachineChannel["terminalExecution"] = "unconfined",
    readonly terminalGeometry = false,
    readonly protocolVersion = PROTOCOL_VERSION,
  ) {}

  send(message: ServerToAgentMessage): boolean {
    this.sent.push(ServerToAgentMessageSchema.parse(message));
    return message.type !== "resize" || this.acceptResize;
  }

  clear(): void {
    this.sent.length = 0;
  }
}

/**
 * Everything a broker needs to be asked for a terminal, up to and including the opener's
 * channel, with one machine online under its declared execution policy. The composition it builds
 * is where a terminal lives: the container IS the home, so the opener's own container is the
 * one the terminal is homed in and every terminal-scoped message it sends is addressed to
 * the right room. A canvas opener would be homed in a solo composition it is not joined to,
 * which is the lifecycle rule under test elsewhere, not the plumbing under test here.
 */
function brokerSetup(
  terminalExecution: MachineChannel["terminalExecution"] = "unconfined",
  terminalGeometry = false,
  protocolVersion = PROTOCOL_VERSION,
) {
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
      testTileTrees,
    ),
  );
  const enrollment = auth.enrollMachine("fake", root);
  const machine = new FakeMachine(
    enrollment.machine.id,
    null,
    terminalExecution,
    terminalGeometry,
    protocolVersion,
  );
  broker.setMachineOnline(machine);
  const socket = new FakeSocket();
  const opener = new SessionChannel(runtime.newId(), socket, root, container.id, "c1");
  return { runtime, clock, store, auth, root, container, rooms, broker, machine, socket, opener };
}

function pendingTerminalId(setup: ReturnType<typeof brokerSetup>): string {
  const tile = Object.values(setup.rooms.get(setup.container.id)?.tileLayout() ?? {}).find(
    (candidate) =>
      candidate.dir === null &&
      candidate.ref?.kind === "terminal" &&
      setup.store.getTerminal(candidate.ref.terminalId) === null,
  );
  if (tile?.dir !== null || tile.ref?.kind !== "terminal")
    throw new Error("missing pending terminal tile");
  return tile.ref.terminalId;
}

function fitPending(setup: ReturnType<typeof brokerSetup>, cols = 80, rows = 24): string {
  const terminalId = pendingTerminalId(setup);
  setup.broker.resize(setup.opener, {
    type: "terminal_resize",
    terminalId,
    viewportId: "fixture",
    viewport: { cols, rows },
  });
  return terminalId;
}

/** {@link brokerSetup} plus the opener's first `terminal_open`, with the `create` it produced. */
function openingFixture(terminalGeometry = false, protocolVersion = PROTOCOL_VERSION) {
  const setup = brokerSetup("unconfined", terminalGeometry, protocolVersion);
  setup.broker.open(setup.opener, {
    type: "terminal_open",
    elementId: "terminal-1",
    placement: "tile",
  });
  fitPending(setup);
  const create = setup.machine.sent.find((message) => message.type === "create");
  if (create === undefined || create.type !== "create") throw new Error("missing create request");
  return { ...setup, create };
}

function brokerFixture(terminalGeometry = false, protocolVersion = PROTOCOL_VERSION) {
  const fixture = openingFixture(terminalGeometry, protocolVersion);
  fixture.broker.onCreated(fixture.machine.machineId, fixture.create.terminalId);
  fixture.socket.clear();
  fixture.machine.clear();
  return fixture;
}

function encoded(value: string): string {
  return Buffer.from(value).toString("base64");
}

interface TerminalFixture {
  rooms: RoomManager;
  broker: TerminalBroker;
  machine: FakeMachine;
  create: Extract<ServerToAgentMessage, { type: "create" }>;
}

/** The view a fixture channel attaches unless a test names its own. */
const VIEW = "view";

type DeliveryFrame = Extract<
  ServerMessage,
  { type: "terminal_snapshot" | "terminal_output" | "terminal_geometry" }
>;

/** Every delivery frame one channel carried for one exact view, in wire order. */
function deliveredTo(channel: SessionChannel, viewportId = VIEW): DeliveryFrame[] {
  if (!(channel.socket instanceof FakeSocket)) throw new Error("fixture channels use FakeSocket");
  return channel.socket
    .frames()
    .filter(
      (frame): frame is DeliveryFrame =>
        (frame.type === "terminal_snapshot" ||
          frame.type === "terminal_output" ||
          frame.type === "terminal_geometry") &&
        frame.ch === channel.channel &&
        frame.viewportId === viewportId,
    );
}

/** A parser that completed everything its view was sent: one cumulative acknowledgement. */
function ackCompleted(fixture: TerminalFixture, channel: SessionChannel, viewportId = VIEW): void {
  const latest = deliveredTo(channel, viewportId).at(-1);
  if (latest === undefined) throw new Error(`nothing was delivered to ${viewportId}`);
  fixture.broker.ack(channel, {
    type: "terminal_ack",
    terminalId: latest.terminalId,
    viewportId,
    deliveryId: latest.deliveryId,
    deliverySeq: latest.deliverySeq,
  });
}

/** Attaches one exact view; it stays PENDING until the test hands over the owner's snapshot. */
function attachView(fixture: TerminalFixture, channel: SessionChannel, viewportId = VIEW): void {
  fixture.broker.attach(channel, {
    type: "terminal_attach",
    terminalId: fixture.create.terminalId,
    viewportId,
  });
}

/** Attaches each named view and hands it a snapshot its parser completes, so each is LIVE. */
function attachLive(
  fixture: TerminalFixture,
  channel: SessionChannel,
  ...viewportIds: string[]
): void {
  fixture.rooms.get(channel.containerId)?.join(channel);
  for (const viewportId of viewportIds.length === 0 ? [VIEW] : viewportIds) {
    attachView(fixture, channel, viewportId);
    fixture.broker.onSnapshot(fixture.machine.machineId, {
      type: "snapshot",
      terminalId: fixture.create.terminalId,
      seq: 0,
      data: encoded("initial"),
    });
    ackCompleted(fixture, channel, viewportId);
  }
}

function viewportFixture(...viewportIds: string[]) {
  const fixture = brokerFixture();
  attachLive(fixture, fixture.opener, ...viewportIds);
  fixture.clock.advance(5_000);
  fixture.socket.clear();
  fixture.machine.clear();
  return fixture;
}

function measureViewport(
  fixture: TerminalFixture,
  channel: SessionChannel,
  viewportId: string,
  cols: number,
  rows: number,
): void {
  fixture.broker.resize(channel, {
    type: "terminal_resize",
    terminalId: fixture.create.terminalId,
    viewportId,
    viewport: { cols, rows },
  });
}

function withdrawViewport(
  fixture: TerminalFixture,
  channel: SessionChannel,
  viewportId: string,
): void {
  fixture.broker.resize(channel, {
    type: "terminal_resize",
    terminalId: fixture.create.terminalId,
    viewportId,
    viewport: null,
  });
}

function sourceGeometry(fixture: TerminalFixture, seq: number, geometry: TerminalGeometry): void {
  fixture.broker.onGeometry(fixture.machine.machineId, {
    type: "terminal_geometry",
    terminalId: fixture.create.terminalId,
    seq,
    geometry,
  });
}

function geometrySnapshot(
  fixture: TerminalFixture,
  seq: number,
  geometry: TerminalGeometry,
  data: string,
): void {
  fixture.broker.onSnapshot(fixture.machine.machineId, {
    type: "geometry_snapshot",
    terminalId: fixture.create.terminalId,
    seq,
    geometry,
    data: encoded(data),
  });
}

type SourceFrame = {
  [T in DeliveryFrame["type"]]: Omit<
    Extract<DeliveryFrame, { type: T }>,
    "ch" | "viewportId" | "deliveryId" | "deliverySeq" | "skipped"
  >;
}[DeliveryFrame["type"]];

/**
 * The view-independent stream a socket carried, in order. Delivery stamps are left out because
 * these tests are about source ordering; the per-view credit tests assert the stamps.
 */
function terminalStream(socket: FakeSocket) {
  return socket.messages().flatMap<SourceFrame>((frame) => {
    switch (frame.type) {
      case "terminal_snapshot": {
        const { type, terminalId, seq, data, geometry } = frame;
        return [{ type, terminalId, seq, data, geometry }];
      }
      case "terminal_output": {
        const { type, terminalId, seq, data } = frame;
        return [{ type, terminalId, seq, data }];
      }
      case "terminal_geometry": {
        const { type, terminalId, seq, geometry } = frame;
        return [{ type, terminalId, seq, geometry }];
      }
      default:
        return [];
    }
  });
}

function geometryViewportFixture(viewportId = VIEW) {
  const fixture = brokerFixture(true);
  fixture.rooms.get(fixture.container.id)?.join(fixture.opener);
  fixture.broker.attach(fixture.opener, {
    type: "terminal_attach",
    terminalId: fixture.create.terminalId,
    viewportId,
  });
  geometrySnapshot(fixture, 0, { cols: 80, rows: 24, revision: 0 }, "initial");
  ackCompleted(fixture, fixture.opener, viewportId);
  fixture.clock.advance(5_000);
  fixture.socket.clear();
  fixture.machine.clear();
  return fixture;
}

function sessionToken(create: Extract<ServerToAgentMessage, { type: "create" }>): string {
  const token = create.env.MANIFOLD_TOKEN;
  if (token === undefined) throw new Error("missing session token");
  return token;
}

describe("TerminalBroker attach handoff", () => {
  test("delayed snapshot(6) flushes exactly outputs 7 through 10 in order", () => {
    const fixture = brokerFixture();
    attachView(fixture, fixture.opener, VIEW);
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

describe("TerminalBroker owner-ordered geometry", () => {
  test("PENDING handoff preserves mixed arrival order and independent output/geometry watermarks", () => {
    const fixture = brokerFixture(true);
    const terminalId = fixture.create.terminalId;
    fixture.rooms.get(fixture.container.id)?.join(fixture.opener);
    attachView(fixture, fixture.opener, VIEW);
    expect(fixture.machine.sent).toEqual([{ type: "geometry_snapshot_request", terminalId }]);
    fixture.broker.onSnapshot(fixture.machine.machineId, {
      type: "snapshot",
      terminalId,
      seq: 0,
      data: encoded("wrong legacy response"),
    });
    expect(terminalStream(fixture.socket)).toEqual([]);
    const output = (seq: number, data: string) =>
      fixture.broker.onOutput(fixture.machine.machineId, {
        type: "output",
        terminalId,
        seq,
        data: encoded(data),
      });
    output(1, "covered");
    sourceGeometry(fixture, 1, { cols: 60, rows: 18, revision: 1 });
    output(2, "distinct bytes even when text repeats");
    sourceGeometry(fixture, 2, { cols: 70, rows: 20, revision: 2 });
    sourceGeometry(fixture, 2, { cols: 90, rows: 30, revision: 3 });
    output(3, "distinct bytes even when text repeats");
    sourceGeometry(fixture, 3, { cols: 100, rows: 35, revision: 4 });
    output(4, "last tail");
    expect(terminalStream(fixture.socket)).toEqual([]);
    geometrySnapshot(fixture, 1, { cols: 60, rows: 18, revision: 1 }, "covered snapshot");
    expect(terminalStream(fixture.socket)).toEqual([
      {
        type: "terminal_snapshot",
        terminalId,
        seq: 1,
        data: encoded("covered snapshot"),
        geometry: { cols: 60, rows: 18, revision: 1 },
      },
      {
        type: "terminal_output",
        terminalId,
        seq: 2,
        data: encoded("distinct bytes even when text repeats"),
      },
      {
        type: "terminal_geometry",
        terminalId,
        seq: 2,
        geometry: { cols: 70, rows: 20, revision: 2 },
      },
      {
        type: "terminal_geometry",
        terminalId,
        seq: 2,
        geometry: { cols: 90, rows: 30, revision: 3 },
      },
      {
        type: "terminal_output",
        terminalId,
        seq: 3,
        data: encoded("distinct bytes even when text repeats"),
      },
      {
        type: "terminal_geometry",
        terminalId,
        seq: 3,
        geometry: { cols: 100, rows: 35, revision: 4 },
      },
      { type: "terminal_output", terminalId, seq: 4, data: encoded("last tail") },
    ]);
    // The attaching snapshot is older than the room record, but neither replaces the other.
    expect(fixture.broker.listForContainer(fixture.container.id)).toMatchObject([
      { cols: 100, rows: 35 },
    ]);
    fixture.socket.clear();
    for (const seq of [4, 3, 2]) output(seq, "late duplicate");
    for (const revision of [4, 2, 1]) sourceGeometry(fixture, 3, { cols: 10, rows: 10, revision });
    geometrySnapshot(fixture, 0, { cols: 80, rows: 24, revision: 0 }, "unsolicited old snapshot");
    output(5, "new tail");
    sourceGeometry(fixture, 5, { cols: 110, rows: 40, revision: 5 });
    expect(terminalStream(fixture.socket)).toEqual([
      { type: "terminal_output", terminalId, seq: 5, data: encoded("new tail") },
      {
        type: "terminal_geometry",
        terminalId,
        seq: 5,
        geometry: { cols: 110, rows: 40, revision: 5 },
      },
    ]);
    fixture.store.close();
  });

  test("rapid desired changes do not publish admission or resend intermediate owner acknowledgements", () => {
    const fixture = geometryViewportFixture();
    const terminalId = fixture.create.terminalId;
    const metadataSocket = new FakeSocket();
    const metadata = new SessionChannel(
      fixture.runtime.newId(),
      metadataSocket,
      fixture.root,
      fixture.container.id,
      "record-only",
    );
    fixture.rooms.get(fixture.container.id)?.join(metadata);
    measureViewport(fixture, fixture.opener, "view", 40, 10);
    measureViewport(fixture, fixture.opener, "view", 45, 11);
    // Returning to the still-applied birth grid must cancel the newer requested target.
    measureViewport(fixture, fixture.opener, "view", 80, 24);
    expect(fixture.machine.sent).toEqual([
      { type: "resize", terminalId, cols: 40, rows: 10 },
      { type: "resize", terminalId, cols: 45, rows: 11 },
      { type: "resize", terminalId, cols: 80, rows: 24 },
    ]);
    expect(fixture.broker.listForContainer(fixture.container.id)).toMatchObject([
      { cols: 80, rows: 24 },
    ]);
    expect(fixture.socket.messages().filter((frame) => frame.type === "terminal_event")).toEqual(
      [],
    );
    fixture.machine.clear();
    for (const geometry of [
      { cols: 40, rows: 10, revision: 1 },
      { cols: 45, rows: 11, revision: 2 },
      { cols: 80, rows: 24, revision: 3 },
    ]) {
      sourceGeometry(fixture, 0, geometry);
      measureViewport(fixture, fixture.opener, "view", 80, 24);
      expect(fixture.broker.listForContainer(fixture.container.id)).toMatchObject([
        { cols: geometry.cols, rows: geometry.rows },
      ]);
    }
    expect(fixture.machine.sent).toEqual([]);
    expect(
      terminalStream(fixture.socket).map((frame) =>
        frame.type === "terminal_geometry" ? [frame.seq, frame.geometry.revision] : frame.type,
      ),
    ).toEqual([
      [0, 1],
      [0, 2],
      [0, 3],
    ]);
    expect(terminalStream(metadataSocket)).toEqual([]);
    expect(metadataSocket.messages().filter((frame) => frame.type === "terminal_event")).toEqual([
      { type: "terminal_event", terminalId, kind: "resized", cols: 40, rows: 10 },
      { type: "terminal_event", terminalId, kind: "resized", cols: 45, rows: 11 },
      { type: "terminal_event", terminalId, kind: "resized", cols: 80, rows: 24 },
    ]);
    fixture.store.close();
  });

  test("LIVE snapshot geometry filters late source duplicates without conflating its output seq", () => {
    const fixture = brokerFixture(true);
    const terminalId = fixture.create.terminalId;
    attachView(fixture, fixture.opener, VIEW);
    geometrySnapshot(fixture, 10, { cols: 100, rows: 30, revision: 8 }, "snapshot ahead");
    fixture.socket.clear();
    sourceGeometry(fixture, 10, { cols: 10, rows: 10, revision: 8 });
    sourceGeometry(fixture, 10, { cols: 50, rows: 12, revision: 9 });
    sourceGeometry(fixture, 10, { cols: 80, rows: 24, revision: 10 });
    for (const seq of [9, 10, 11, 11]) {
      fixture.broker.onOutput(fixture.machine.machineId, {
        type: "output",
        terminalId,
        seq,
        data: encoded(`tail-${seq}`),
      });
    }
    expect(terminalStream(fixture.socket)).toEqual([
      {
        type: "terminal_geometry",
        terminalId,
        seq: 10,
        geometry: { cols: 50, rows: 12, revision: 9 },
      },
      {
        type: "terminal_geometry",
        terminalId,
        seq: 10,
        geometry: { cols: 80, rows: 24, revision: 10 },
      },
      { type: "terminal_output", terminalId, seq: 11, data: encoded("tail-11") },
    ]);
    fixture.store.close();
  });

  for (const bound of ["frames", "bytes"] as const) {
    test(`mixed PENDING ${bound} overflow retires the viewer and its viewport before a late snapshot`, () => {
      const fixture = brokerFixture(true);
      const terminalId = fixture.create.terminalId;
      fixture.clock.advance(5_000);
      const baselineJobs = fixture.clock.pendingJobs;
      attachView(fixture, fixture.opener, "pending");
      measureViewport(fixture, fixture.opener, "pending", 40, 10);
      fixture.machine.clear();
      if (bound === "frames") {
        for (let seq = 1; seq <= 128; seq += 1) {
          fixture.broker.onOutput(fixture.machine.machineId, {
            type: "output",
            terminalId,
            seq,
            data: encoded(`tail-${seq}`),
          });
          sourceGeometry(fixture, seq, { cols: 80 + (seq % 2), rows: 24, revision: seq });
        }
        expect(fixture.socket.messages().filter((frame) => frame.type === "error")).toEqual([]);
        sourceGeometry(fixture, 128, { cols: 90, rows: 30, revision: 129 });
      } else {
        fixture.broker.onOutput(fixture.machine.machineId, {
          type: "output",
          terminalId,
          seq: 1,
          data: "YWFh".repeat((1_048_576 - 4) / 4),
        });
        // Geometry charges no payload bytes, only one of the bounded frames.
        sourceGeometry(fixture, 1, { cols: 90, rows: 30, revision: 1 });
        expect(fixture.socket.messages().filter((frame) => frame.type === "error")).toEqual([]);
        fixture.broker.onOutput(fixture.machine.machineId, {
          type: "output",
          terminalId,
          seq: 2,
          data: encoded("over"),
        });
      }
      // The refusal names the exact view before the generic error, without wording to match.
      expect(fixture.socket.messages().slice(-2)).toEqual([
        {
          type: "terminal_delivery",
          terminalId,
          viewportId: "pending",
          deliveryId: null,
          state: "refused",
          skipped: false,
          reason: "pending_overflow",
        },
        {
          type: "error",
          code: "conflict",
          message: "terminal attach queue overflow",
          ref: terminalId,
        },
      ]);
      expect(fixture.clock.pendingJobs).toBe(baselineJobs);
      geometrySnapshot(fixture, 0, { cols: 80, rows: 24, revision: 0 }, "too late");
      expect(terminalStream(fixture.socket)).toEqual([]);
      expect(fixture.machine.sent).toEqual([]);
      fixture.store.close();
    });
  }

  for (const failure of ["snapshot", "queued-geometry", "live-geometry"] as const) {
    test(`failed ${failure} reliable delivery releases only the failing viewer`, () => {
      const fixture = geometryViewportFixture("survivor");
      const terminalId = fixture.create.terminalId;
      measureViewport(fixture, fixture.opener, "survivor", 120, 40);
      sourceGeometry(fixture, 0, { cols: 120, rows: 40, revision: 1 });
      class DroppingGeometrySocket extends FakeSocket {
        dropType: string | null = null;

        override send(data: string): number {
          const frame = JSON.parse(data) as { type: string };
          return frame.type === this.dropType ? 0 : super.send(data);
        }
      }
      const socket = new DroppingGeometrySocket();
      const failed = new SessionChannel(
        fixture.runtime.newId(),
        socket,
        fixture.root,
        fixture.container.id,
        "geometry-failure",
        false,
        (closing) => {
          fixture.broker.detachAll(closing);
          fixture.rooms.get(fixture.container.id)?.leave(closing);
        },
      );
      fixture.rooms.get(fixture.container.id)?.join(failed);
      attachView(fixture, failed, "retiring");
      if (failure === "live-geometry")
        geometrySnapshot(fixture, 0, { cols: 120, rows: 40, revision: 1 }, "attached");
      measureViewport(fixture, failed, "retiring", 60, 18);
      socket.dropType = failure === "snapshot" ? "terminal_snapshot" : "terminal_geometry";
      fixture.machine.clear();
      if (failure === "live-geometry") {
        sourceGeometry(fixture, 0, { cols: 60, rows: 18, revision: 2 });
        expect(fixture.machine.sent).toEqual([{ type: "resize", terminalId, cols: 120, rows: 40 }]);
        // Even failure cleanup cannot advertise the recovery request as applied.
        expect(fixture.broker.listForContainer(fixture.container.id)).toMatchObject([
          { cols: 60, rows: 18 },
        ]);
        sourceGeometry(fixture, 0, { cols: 120, rows: 40, revision: 3 });
      } else {
        if (failure === "queued-geometry")
          sourceGeometry(fixture, 0, { cols: 100, rows: 30, revision: 2 });
        geometrySnapshot(fixture, 0, { cols: 120, rows: 40, revision: 1 }, "handoff");
      }
      expect(failed.isClosed).toBe(true);
      expect(fixture.clock.pendingJobs).toBe(1);
      fixture.machine.clear();
      measureViewport(fixture, fixture.opener, "survivor", 125, 42);
      expect(fixture.machine.sent).toEqual([{ type: "resize", terminalId, cols: 125, rows: 42 }]);
      withdrawViewport(fixture, fixture.opener, "survivor");
      expect(fixture.clock.pendingJobs).toBe(0);
      fixture.store.close();
    });
  }

  test("re-adoption discards the offline pending generation and keeps the owner's independent revision", () => {
    const fixture = geometryViewportFixture();
    const terminalId = fixture.create.terminalId;
    sourceGeometry(fixture, 0, { cols: 60, rows: 18, revision: 1 });
    fixture.broker.onOutput(fixture.machine.machineId, {
      type: "output",
      terminalId,
      seq: 1,
      data: encoded("before replacement attachment"),
    });
    attachView(fixture, fixture.opener, VIEW);
    sourceGeometry(fixture, 1, { cols: 80, rows: 16, revision: 2 });
    fixture.broker.onOutput(fixture.machine.machineId, {
      type: "output",
      terminalId,
      seq: 2,
      data: encoded("old queued tail"),
    });
    fixture.broker.setMachineOffline(fixture.machine);
    fixture.socket.clear();
    sourceGeometry(fixture, 2, { cols: 10, rows: 10, revision: 99 });
    geometrySnapshot(fixture, 2, { cols: 10, rows: 10, revision: 99 }, "offline old snapshot");
    expect(terminalStream(fixture.socket)).toEqual([]);
    const replacement = new FakeMachine(fixture.machine.machineId, null, "unconfined", true);
    fixture.broker.setMachineOnline(replacement);
    expect(
      fixture.broker.adoptTerminal(replacement.machineId, {
        terminalId,
        alive: true,
        cols: 80,
        rows: 16,
        seq: 2,
      }),
    ).toBe(true);
    expect(replacement.sent).toEqual([{ type: "geometry_snapshot_request", terminalId }]);
    sourceGeometry(fixture, 2, { cols: 100, rows: 30, revision: 3 });
    fixture.broker.onOutput(replacement.machineId, {
      type: "output",
      terminalId,
      seq: 3,
      data: encoded("fresh adopted tail"),
    });
    geometrySnapshot(fixture, 2, { cols: 80, rows: 16, revision: 2 }, "adopted snapshot");
    expect(terminalStream(fixture.socket)).toEqual([
      {
        type: "terminal_snapshot",
        terminalId,
        seq: 2,
        data: encoded("adopted snapshot"),
        geometry: { cols: 80, rows: 16, revision: 2 },
      },
      {
        type: "terminal_geometry",
        terminalId,
        seq: 2,
        geometry: { cols: 100, rows: 30, revision: 3 },
      },
      { type: "terminal_output", terminalId, seq: 3, data: encoded("fresh adopted tail") },
    ]);
    fixture.socket.clear();
    sourceGeometry(fixture, 2, { cols: 10, rows: 10, revision: 2 });
    expect(terminalStream(fixture.socket)).toEqual([]);
    expect(fixture.broker.listForContainer(fixture.container.id)).toMatchObject([
      { cols: 100, rows: 30 },
    ]);
    fixture.store.close();
  });

  test("replacement attach and process restart never replay geometry from the previous pending generation", async () => {
    const fixture = geometryViewportFixture();
    const terminalId = fixture.create.terminalId;
    sourceGeometry(fixture, 0, { cols: 100, rows: 30, revision: 8 });
    attachView(fixture, fixture.opener, VIEW);
    fixture.broker.onOutput(fixture.machine.machineId, {
      type: "output",
      terminalId,
      seq: 1,
      data: encoded("discarded by replacement snapshot"),
    });
    sourceGeometry(fixture, 1, { cols: 90, rows: 28, revision: 9 });
    attachView(fixture, fixture.opener, VIEW);
    fixture.socket.clear();
    geometrySnapshot(fixture, 1, { cols: 90, rows: 28, revision: 9 }, "old request");
    expect(terminalStream(fixture.socket)).toEqual([]);
    geometrySnapshot(fixture, 1, { cols: 90, rows: 28, revision: 9 }, "replacement snapshot");
    expect(terminalStream(fixture.socket)).toEqual([
      {
        type: "terminal_snapshot",
        terminalId,
        seq: 1,
        data: encoded("replacement snapshot"),
        geometry: { cols: 90, rows: 28, revision: 9 },
      },
    ]);
    attachView(fixture, fixture.opener, VIEW);
    sourceGeometry(fixture, 1, { cols: 100, rows: 30, revision: 10 });
    const restarted = fixture.broker.restartById(
      terminalId,
      fixture.root.principal.id,
      fixture.auth.credentialReference(fixture.root),
    );
    fixture.broker.onRestarted(fixture.machine.machineId, {
      type: "terminal_restarted",
      terminalId,
    });
    expect(await restarted).toBe("ok");
    fixture.socket.clear();
    sourceGeometry(fixture, 0, { cols: 70, rows: 20, revision: 1 });
    fixture.broker.onOutput(fixture.machine.machineId, {
      type: "output",
      terminalId,
      seq: 1,
      data: encoded("new process first bytes"),
    });
    geometrySnapshot(fixture, 0, { cols: 100, rows: 30, revision: 0 }, "new process snapshot");
    expect(terminalStream(fixture.socket)).toEqual([
      {
        type: "terminal_snapshot",
        terminalId,
        seq: 0,
        data: encoded("new process snapshot"),
        geometry: { cols: 100, rows: 30, revision: 0 },
      },
      {
        type: "terminal_geometry",
        terminalId,
        seq: 0,
        geometry: { cols: 70, rows: 20, revision: 1 },
      },
      { type: "terminal_output", terminalId, seq: 1, data: encoded("new process first bytes") },
    ]);
    expect(fixture.broker.listForContainer(fixture.container.id)).toMatchObject([
      { cols: 70, rows: 20 },
    ]);
    fixture.store.close();
  });

  test("a restarted owner's revision-zero snapshot replaces retained metadata with its actual birth grid", async () => {
    const fixture = geometryViewportFixture();
    const terminalId = fixture.create.terminalId;
    sourceGeometry(fixture, 0, { cols: 100, rows: 30, revision: 8 });
    const restarted = fixture.broker.restartById(
      terminalId,
      fixture.root.principal.id,
      fixture.auth.credentialReference(fixture.root),
    );
    fixture.broker.onRestarted(fixture.machine.machineId, {
      type: "terminal_restarted",
      terminalId,
    });
    expect(await restarted).toBe("ok");
    fixture.socket.clear();
    geometrySnapshot(fixture, 0, { cols: 80, rows: 24, revision: 0 }, "fresh birth");
    expect(terminalStream(fixture.socket)).toEqual([
      {
        type: "terminal_snapshot",
        terminalId,
        seq: 0,
        data: encoded("fresh birth"),
        geometry: { cols: 80, rows: 24, revision: 0 },
      },
    ]);
    expect(fixture.broker.listForContainer(fixture.container.id)).toMatchObject([
      { cols: 80, rows: 24 },
    ]);
    fixture.socket.clear();
    sourceGeometry(fixture, 0, { cols: 70, rows: 20, revision: 1 });
    expect(terminalStream(fixture.socket)).toEqual([
      {
        type: "terminal_geometry",
        terminalId,
        seq: 0,
        geometry: { cols: 70, rows: 20, revision: 1 },
      },
    ]);
    fixture.store.close();
  });

  for (const capability of [
    { supported: false, protocolVersion: PROTOCOL_VERSION },
    { supported: true, protocolVersion: TERMINAL_GEOMETRY_PROTOCOL_VERSION - 1 },
  ]) {
    test(`legacy projection remains explicit for support=${capability.supported}, version=${capability.protocolVersion}`, () => {
      const fixture = brokerFixture(capability.supported, capability.protocolVersion);
      const terminalId = fixture.create.terminalId;
      fixture.rooms.get(fixture.container.id)?.join(fixture.opener);
      attachView(fixture, fixture.opener, "legacy-view");
      expect(fixture.machine.sent).toEqual([{ type: "snapshot_request", terminalId }]);
      sourceGeometry(fixture, 0, { cols: 10, rows: 10, revision: 1 });
      geometrySnapshot(fixture, 0, { cols: 10, rows: 10, revision: 1 }, "unsupported response");
      expect(terminalStream(fixture.socket)).toEqual([]);
      fixture.broker.onSnapshot(fixture.machine.machineId, {
        type: "snapshot",
        terminalId,
        seq: 0,
        data: encoded("legacy"),
      });
      expect(terminalStream(fixture.socket)).toEqual([
        {
          type: "terminal_snapshot",
          terminalId,
          seq: 0,
          data: encoded("legacy"),
          geometry: { cols: 80, rows: 24, revision: null },
        },
      ]);
      fixture.socket.clear();
      measureViewport(fixture, fixture.opener, "legacy-view", 55, 17);
      expect(terminalStream(fixture.socket)).toEqual([
        {
          type: "terminal_geometry",
          terminalId,
          seq: 0,
          geometry: { cols: 55, rows: 17, revision: null },
        },
      ]);
      const pendingSocket = new FakeSocket();
      const pending = new SessionChannel(
        fixture.runtime.newId(),
        pendingSocket,
        fixture.root,
        fixture.container.id,
        "legacy-pending",
      );
      attachView(fixture, pending, VIEW);
      measureViewport(fixture, fixture.opener, "legacy-view", 60, 20);
      expect(terminalStream(pendingSocket)).toEqual([]);
      fixture.broker.onSnapshot(fixture.machine.machineId, {
        type: "snapshot",
        terminalId,
        seq: 0,
        data: encoded("legacy pending snapshot"),
      });
      expect(terminalStream(pendingSocket)).toEqual([
        {
          type: "terminal_snapshot",
          terminalId,
          seq: 0,
          data: encoded("legacy pending snapshot"),
          geometry: { cols: 60, rows: 20, revision: null },
        },
      ]);
      expect(fixture.broker.listForContainer(fixture.container.id)).toMatchObject([
        { cols: 60, rows: 20 },
      ]);
      fixture.store.close();
    });
  }
});

describe("TerminalBroker viewport arbitration", () => {
  test("minimizes each dimension independently and publishes every tied view without duplicate resizes", () => {
    const fixture = viewportFixture("narrow", "short", "both");
    const terminalId = fixture.create.terminalId;
    measureViewport(fixture, fixture.opener, "narrow", 80, 40);
    measureViewport(fixture, fixture.opener, "short", 120, 16);
    expect(fixture.machine.sent).toEqual([
      { type: "resize", terminalId, cols: 80, rows: 40 },
      { type: "resize", terminalId, cols: 80, rows: 16 },
    ]);
    expect(fixture.socket.messages().at(-1)).toEqual({
      type: "terminal_sizing",
      terminalId,
      sizing: {
        mode: "smallest",
        columns: [{ connId: fixture.opener.id, viewportId: "narrow" }],
        rows: [{ connId: fixture.opener.id, viewportId: "short" }],
      },
    });
    fixture.machine.clear();
    fixture.socket.clear();
    measureViewport(fixture, fixture.opener, "both", 80, 16);
    expect(fixture.machine.sent).toEqual([]);
    expect(fixture.socket.messages()).toEqual([
      {
        type: "terminal_sizing",
        terminalId,
        sizing: {
          mode: "smallest",
          columns: [
            { connId: fixture.opener.id, viewportId: "narrow" },
            { connId: fixture.opener.id, viewportId: "both" },
          ],
          rows: [
            { connId: fixture.opener.id, viewportId: "short" },
            { connId: fixture.opener.id, viewportId: "both" },
          ],
        },
      },
    ]);
    fixture.socket.clear();
    measureViewport(fixture, fixture.opener, "both", 80, 16);
    expect(fixture.machine.sent).toEqual([]);
    expect(fixture.socket.messages()).toEqual([]);
    withdrawViewport(fixture, fixture.opener, "both");
    expect(fixture.machine.sent).toEqual([]);
    expect(fixture.socket.messages().at(-1)).toMatchObject({
      type: "terminal_sizing",
      sizing: {
        columns: [{ connId: fixture.opener.id, viewportId: "narrow" }],
        rows: [{ connId: fixture.opener.id, viewportId: "short" }],
      },
    });
    withdrawViewport(fixture, fixture.opener, "narrow");
    expect(fixture.machine.sent).toEqual([{ type: "resize", terminalId, cols: 120, rows: 16 }]);
    withdrawViewport(fixture, fixture.opener, "short");
    expect(fixture.broker.listForContainer(fixture.container.id)).toMatchObject([
      { id: terminalId, cols: 120, rows: 16 },
    ]);
    expect(fixture.socket.messages().at(-1)).toEqual({
      type: "terminal_sizing",
      terminalId,
      sizing: { mode: "retained", columns: [], rows: [] },
    });
    expect(fixture.clock.pendingJobs).toBe(0);
    fixture.store.close();
  });

  test("native refusal retains geometry and retires intents until fresh measurement", () => {
    const fixture = viewportFixture("accepted", "refused", "larger");
    const terminalId = fixture.create.terminalId;
    const siblingSocket = new FakeSocket();
    const sibling = new SessionChannel(
      fixture.runtime.newId(),
      siblingSocket,
      fixture.root,
      fixture.container.id,
      "native-sibling",
    );
    attachLive(fixture, sibling, "old-sibling", "fresh");
    measureViewport(fixture, fixture.opener, "accepted", 120, 40);
    measureViewport(fixture, sibling, "old-sibling", 140, 50);
    fixture.machine.clear();
    fixture.socket.clear();
    siblingSocket.clear();
    fixture.machine.acceptResize = false;

    measureViewport(fixture, fixture.opener, "refused", 60, 18);
    expect(fixture.machine.sent).toEqual([{ type: "resize", terminalId, cols: 60, rows: 18 }]);
    expect(fixture.broker.listForContainer(fixture.container.id)).toMatchObject([
      { id: terminalId, cols: 120, rows: 40 },
    ]);
    const retained = {
      type: "terminal_sizing" as const,
      terminalId,
      sizing: { mode: "retained" as const, columns: [], rows: [] },
    };
    expect(fixture.socket.messages()).toEqual([
      { type: "error", code: "no_machine", ref: terminalId },
      retained,
    ]);
    expect(siblingSocket.messages()).toEqual([retained]);
    expect(fixture.clock.pendingJobs).toBe(0);

    fixture.machine.acceptResize = true;
    fixture.machine.clear();
    fixture.socket.clear();
    siblingSocket.clear();
    fixture.clock.advance(10_000);
    withdrawViewport(fixture, fixture.opener, "refused");
    expect(fixture.machine.sent).toEqual([]);
    expect(fixture.socket.messages()).toEqual([]);
    expect(siblingSocket.messages()).toEqual([]);
    measureViewport(fixture, sibling, "fresh", 130, 45);
    expect(fixture.machine.sent).toEqual([{ type: "resize", terminalId, cols: 130, rows: 45 }]);
    expect(fixture.socket.messages()).toEqual([
      { type: "terminal_event", terminalId, kind: "resized", cols: 130, rows: 45 },
      // Each attached view of this channel carries the applied grid in its own lane.
      ...["accepted", "refused", "larger"].map((viewportId) =>
        expect.objectContaining({
          type: "terminal_geometry",
          terminalId,
          viewportId,
          seq: 0,
          geometry: { cols: 130, rows: 45, revision: null },
        }),
      ),
      {
        type: "terminal_sizing",
        terminalId,
        sizing: {
          mode: "smallest",
          columns: [{ connId: sibling.id, viewportId: "fresh" }],
          rows: [{ connId: sibling.id, viewportId: "fresh" }],
        },
      },
    ]);
    measureViewport(fixture, fixture.opener, "larger", 150, 55);
    fixture.machine.acceptResize = false;
    fixture.machine.clear();
    fixture.socket.clear();
    siblingSocket.clear();
    withdrawViewport(fixture, sibling, "fresh");
    expect(fixture.machine.sent).toEqual([{ type: "resize", terminalId, cols: 150, rows: 55 }]);
    expect(fixture.socket.messages()).toEqual([retained]);
    expect(siblingSocket.messages()).toEqual([retained]);
    expect(fixture.broker.listForContainer(fixture.container.id)).toMatchObject([
      { id: terminalId, cols: 130, rows: 45 },
    ]);
    expect(fixture.clock.pendingJobs).toBe(0);
    fixture.machine.acceptResize = true;
    fixture.machine.clear();
    fixture.socket.clear();
    fixture.clock.advance(TERMINAL_VIEWPORT_LEASE_MS);
    withdrawViewport(fixture, fixture.opener, "larger");
    expect(fixture.machine.sent).toEqual([]);
    expect(fixture.socket.messages()).toEqual([]);
    fixture.store.close();
  });

  test("native refusal clears intents before its error synchronously closes the requester", () => {
    const fixture = viewportFixture("old-observer", "fresh");
    const terminalId = fixture.create.terminalId;
    class DroppingSocket extends FakeSocket {
      dropError = false;

      override send(data: string): number {
        const frame = JSON.parse(data) as { type: string };
        if (this.dropError && frame.type === "error") return 0;
        return super.send(data);
      }
    }
    const socket = new DroppingSocket();
    const channel = new SessionChannel(
      fixture.runtime.newId(),
      socket,
      fixture.root,
      fixture.container.id,
      "closing-requester",
      false,
      (closing) => {
        fixture.broker.detachAll(closing);
        fixture.rooms.get(fixture.container.id)?.leave(closing);
      },
    );
    attachLive(fixture, channel, "refused");
    measureViewport(fixture, fixture.opener, "old-observer", 120, 40);
    fixture.socket.clear();
    fixture.machine.clear();
    fixture.machine.acceptResize = false;
    socket.dropError = true;

    measureViewport(fixture, channel, "refused", 60, 18);
    expect(channel.isClosed).toBe(true);
    expect(fixture.machine.sent).toEqual([{ type: "resize", terminalId, cols: 60, rows: 18 }]);
    expect(fixture.broker.listForContainer(fixture.container.id)).toMatchObject([
      { cols: 120, rows: 40 },
    ]);
    expect(
      fixture.socket
        .messages()
        .filter((frame) => frame.type === "terminal_sizing" || frame.type === "terminal_event"),
    ).toEqual([
      {
        type: "terminal_sizing",
        terminalId,
        sizing: { mode: "retained", columns: [], rows: [] },
      },
    ]);
    expect(fixture.clock.pendingJobs).toBe(0);
    fixture.machine.acceptResize = true;
    fixture.machine.clear();
    fixture.clock.advance(10_000);
    measureViewport(fixture, fixture.opener, "fresh", 130, 45);
    expect(fixture.machine.sent).toEqual([{ type: "resize", terminalId, cols: 130, rows: 45 }]);
    withdrawViewport(fixture, fixture.opener, "fresh");
    expect(fixture.clock.pendingJobs).toBe(0);
    fixture.store.close();
  });

  test("PENDING measurements contribute only after their ordered snapshot and tail become LIVE", () => {
    const fixture = viewportFixture("home");
    const terminalId = fixture.create.terminalId;
    measureViewport(fixture, fixture.opener, "home", 120, 40);
    const socket = new FakeSocket();
    const pending = new SessionChannel(
      fixture.runtime.newId(),
      socket,
      fixture.root,
      fixture.container.id,
      "pending",
    );
    fixture.rooms.get(fixture.container.id)?.join(pending);
    attachView(fixture, pending, "pending-fit");
    expect(socket.messages().at(-1)).toMatchObject({
      type: "terminal_sizing",
      sizing: {
        mode: "smallest",
        columns: [{ connId: fixture.opener.id, viewportId: "home" }],
        rows: [{ connId: fixture.opener.id, viewportId: "home" }],
      },
    });
    fixture.machine.clear();
    socket.clear();
    measureViewport(fixture, pending, "pending-fit", 70, 18);
    expect(fixture.machine.sent).toEqual([]);
    fixture.broker.onOutput(fixture.machine.machineId, {
      type: "output",
      terminalId,
      seq: 2,
      data: encoded("tail"),
    });
    expect(socket.messages()).toEqual([]);
    fixture.broker.onSnapshot(fixture.machine.machineId, {
      type: "snapshot",
      terminalId,
      seq: 1,
      data: encoded("watermark"),
    });
    expect(socket.messages().map((message) => message.type)).toEqual([
      "terminal_snapshot",
      "terminal_output",
      "terminal_event",
      "terminal_geometry",
      "terminal_sizing",
    ]);
    expect(fixture.machine.sent).toEqual([{ type: "resize", terminalId, cols: 70, rows: 18 }]);
    expect(socket.messages().at(-1)).toMatchObject({
      type: "terminal_sizing",
      sizing: {
        mode: "smallest",
        columns: [{ connId: pending.id, viewportId: "pending-fit" }],
        rows: [{ connId: pending.id, viewportId: "pending-fit" }],
      },
    });
    fixture.store.close();
  });

  test("refresh renews only its own bounded lease and expiry retains the last requested grid", () => {
    const fixture = viewportFixture("suspended", "awake");
    const terminalId = fixture.create.terminalId;
    measureViewport(fixture, fixture.opener, "suspended", 60, 18);
    measureViewport(fixture, fixture.opener, "awake", 100, 32);
    expect(fixture.clock.pendingJobs).toBe(1);
    fixture.clock.advance(10_000);
    fixture.machine.clear();
    fixture.socket.clear();
    measureViewport(fixture, fixture.opener, "awake", 100, 32);
    expect(fixture.machine.sent).toEqual([]);
    expect(fixture.socket.messages()).toEqual([]);
    expect(fixture.clock.pendingJobs).toBe(1);
    fixture.clock.advance(TERMINAL_VIEWPORT_LEASE_MS - 10_001);
    expect(fixture.machine.sent).toEqual([]);
    fixture.clock.advance(1);
    expect(fixture.machine.sent).toEqual([{ type: "resize", terminalId, cols: 100, rows: 32 }]);
    expect(fixture.socket.messages().at(-1)).toMatchObject({
      type: "terminal_sizing",
      sizing: {
        columns: [{ connId: fixture.opener.id, viewportId: "awake" }],
        rows: [{ connId: fixture.opener.id, viewportId: "awake" }],
      },
    });
    fixture.machine.clear();
    fixture.clock.advance(10_000);
    expect(fixture.machine.sent).toEqual([]);
    expect(fixture.broker.listForContainer(fixture.container.id)).toMatchObject([
      { id: terminalId, cols: 100, rows: 32 },
    ]);
    expect(fixture.socket.messages().at(-1)).toEqual({
      type: "terminal_sizing",
      terminalId,
      sizing: { mode: "retained", columns: [], rows: [] },
    });
    expect(fixture.clock.pendingJobs).toBe(0);
    fixture.store.close();
  });

  test("same viewport ids on sibling room channels are independent and departure preserves the sibling", () => {
    const fixture = viewportFixture("same-id");
    const terminalId = fixture.create.terminalId;
    const sibling = new SessionChannel(
      fixture.runtime.newId(),
      fixture.socket,
      fixture.root,
      fixture.container.id,
      "sibling",
    );
    attachLive(fixture, sibling, "same-id");
    measureViewport(fixture, fixture.opener, "same-id", 60, 30);
    measureViewport(fixture, sibling, "same-id", 100, 20);
    fixture.socket.clear();
    fixture.machine.clear();
    fixture.rooms.get(fixture.container.id)?.leave(fixture.opener);
    fixture.broker.detachAll(fixture.opener);
    fixture.opener.dispose();
    expect(fixture.socket.closed).toBeNull();
    expect(fixture.machine.sent).toEqual([{ type: "resize", terminalId, cols: 100, rows: 20 }]);
    expect(fixture.socket.frames().at(-1)).toMatchObject({
      ch: "sibling",
      type: "terminal_sizing",
      sizing: {
        columns: [{ connId: sibling.id, viewportId: "same-id" }],
        rows: [{ connId: sibling.id, viewportId: "same-id" }],
      },
    });
    fixture.broker.onOutput(fixture.machine.machineId, {
      type: "output",
      terminalId,
      seq: 1,
      data: encoded("surviving-channel"),
    });
    expect(fixture.socket.frames().at(-1)).toMatchObject({
      ch: "sibling",
      type: "terminal_output",
      seq: 1,
    });
    withdrawViewport(fixture, sibling, "same-id");
    expect(fixture.clock.pendingJobs).toBe(0);
    fixture.store.close();
  });

  test("read-only, spectator, non-controller and unattached channels cannot constrain the grid", () => {
    const fixture = viewportFixture("real");
    const readonly = fixture.auth.mintToken(
      {
        principalId: fixture.root.principal.id,
        caps: ["containers:read"],
        containerId: fixture.container.id,
      },
      fixture.root,
    );
    const other = fixture.auth.mintToken(
      {
        principal: { name: "other controller", kind: "human" },
        caps: ["containers:read", "terminals:write"],
        containerId: fixture.container.id,
      },
      fixture.root,
    );
    const denied = [
      { auth: fixture.auth.authenticate(readonly.token), spectator: false, code: "forbidden" },
      { auth: fixture.root, spectator: true, code: "forbidden" },
      { auth: fixture.auth.authenticate(other.token), spectator: false, code: "not_controller" },
    ] as const;
    measureViewport(fixture, fixture.opener, "real", 110, 36);
    for (const [index, candidate] of denied.entries()) {
      const socket = new FakeSocket();
      const channel = new SessionChannel(
        fixture.runtime.newId(),
        socket,
        candidate.auth,
        fixture.container.id,
        `denied-${index}`,
        candidate.spectator,
      );
      attachLive(fixture, channel, "tiny");
      socket.clear();
      fixture.machine.clear();
      measureViewport(fixture, channel, "tiny", 10, 5);
      expect(socket.messages().at(-1)).toMatchObject({ type: "error", code: candidate.code });
      expect(fixture.machine.sent).toEqual([]);
    }
    const detachedSocket = new FakeSocket();
    const detached = new SessionChannel(
      fixture.runtime.newId(),
      detachedSocket,
      fixture.root,
      fixture.container.id,
      "unattached",
    );
    measureViewport(fixture, detached, "tiny", 10, 5);
    expect(detachedSocket.messages().at(-1)).toMatchObject({ type: "error", code: "conflict" });
    expect(fixture.broker.listForContainer(fixture.container.id)).toMatchObject([
      { cols: 110, rows: 36 },
    ]);
    withdrawViewport(fixture, fixture.opener, "real");
    expect(fixture.clock.pendingJobs).toBe(0);
    fixture.store.close();
  });

  for (const cause of ["home-deny", "credential-revoked"] as const) {
    const description =
      cause === "home-deny"
        ? "principal-wide home deny retires every credential of a non-owner controller and retains its grid"
        : "credential revocation retires only that credential under a non-owner controller";
    test(description, () => {
      const fixture = viewportFixture();
      const grant = fixture.auth.mintToken(
        {
          principal: { name: "revocable controller", kind: "human" },
          caps: ["containers:read", "terminals:write"],
          containerId: fixture.container.id,
        },
        fixture.root,
      );
      const actor = fixture.auth.authenticate(grant.token);
      const socket = new FakeSocket();
      const channel = new SessionChannel(
        fixture.runtime.newId(),
        socket,
        actor,
        fixture.container.id,
        "revocable",
      );
      const siblingGrant = fixture.auth.mintToken(
        {
          principalId: actor.principal.id,
          caps: ["containers:read", "terminals:write"],
          containerId: fixture.container.id,
        },
        fixture.root,
      );
      const siblingSocket = new FakeSocket();
      const sibling = new SessionChannel(
        fixture.runtime.newId(),
        siblingSocket,
        fixture.auth.authenticate(siblingGrant.token),
        fixture.container.id,
        "independent-credential",
      );
      attachLive(fixture, channel, "retired");
      attachLive(fixture, sibling, "sibling");
      fixture.broker.take(channel, {
        type: "terminal_take",
        terminalId: fixture.create.terminalId,
      });
      measureViewport(fixture, sibling, "sibling", 110, 36);
      measureViewport(fixture, channel, "retired", 60, 18);
      fixture.machine.clear();
      fixture.socket.clear();
      siblingSocket.clear();
      if (cause === "home-deny") {
        fixture.auth.grant(
          {
            principal: { kind: "principal", id: actor.principal.id },
            node: `manifold://container/${fixture.container.id}`,
            caps: ["terminals:write"],
            effect: "deny",
            reach: "node",
          },
          fixture.root,
        );
      } else {
        fixture.store.revokeToken(actor.tokenId!, fixture.runtime.now());
      }
      if (cause === "home-deny") {
        expect(fixture.machine.sent).toEqual([]);
        expect(fixture.broker.listForContainer(fixture.container.id)).toMatchObject([
          { cols: 60, rows: 18, controllerId: actor.principal.id },
        ]);
        const retained = {
          type: "terminal_sizing" as const,
          terminalId: fixture.create.terminalId,
          sizing: { mode: "retained" as const, columns: [], rows: [] },
        };
        expect(fixture.socket.messages()).toEqual([retained]);
        expect(siblingSocket.messages()).toEqual([retained]);
        expect(fixture.clock.pendingJobs).toBe(0);
      } else {
        measureViewport(fixture, sibling, "sibling", 110, 36);
        expect(fixture.machine.sent).toEqual([
          { type: "resize", terminalId: fixture.create.terminalId, cols: 110, rows: 36 },
        ]);
        expect(fixture.broker.listForContainer(fixture.container.id)).toMatchObject([
          { cols: 110, rows: 36, controllerId: actor.principal.id },
        ]);
        expect(fixture.socket.messages().at(-1)).toEqual({
          type: "terminal_sizing",
          terminalId: fixture.create.terminalId,
          sizing: {
            mode: "smallest",
            columns: [{ connId: sibling.id, viewportId: "sibling" }],
            rows: [{ connId: sibling.id, viewportId: "sibling" }],
          },
        });
      }
      socket.clear();
      measureViewport(fixture, channel, "retired", 60, 18);
      expect(socket.messages().at(-1)).toMatchObject({ type: "error", code: "forbidden" });
      withdrawViewport(fixture, sibling, "sibling");
      expect(fixture.clock.pendingJobs).toBe(0);
      fixture.store.close();
    });
  }

  test("controller transfer retires former intent and taking back cannot resurrect it", () => {
    const fixture = viewportFixture("former");
    const terminalId = fixture.create.terminalId;
    const grant = fixture.auth.mintToken(
      {
        principal: { name: "successor", kind: "human" },
        caps: ["containers:read", "terminals:write"],
        containerId: fixture.container.id,
      },
      fixture.root,
    );
    const socket = new FakeSocket();
    const successor = new SessionChannel(
      fixture.runtime.newId(),
      socket,
      fixture.auth.authenticate(grant.token),
      fixture.container.id,
      "successor",
    );
    attachLive(fixture, successor, "new");
    measureViewport(fixture, fixture.opener, "former", 60, 18);
    fixture.machine.clear();
    fixture.broker.take(successor, { type: "terminal_take", terminalId });
    expect(fixture.machine.sent).toEqual([]);
    expect(socket.messages().at(-1)).toEqual({
      type: "terminal_sizing",
      terminalId,
      sizing: { mode: "retained", columns: [], rows: [] },
    });
    expect(fixture.clock.pendingJobs).toBe(0);
    measureViewport(fixture, successor, "new", 110, 36);
    expect(fixture.machine.sent).toEqual([{ type: "resize", terminalId, cols: 110, rows: 36 }]);
    fixture.machine.clear();
    fixture.broker.take(fixture.opener, { type: "terminal_take", terminalId });
    expect(fixture.machine.sent).toEqual([]);
    expect(fixture.broker.listForContainer(fixture.container.id)).toMatchObject([
      { cols: 110, rows: 36 },
    ]);
    expect(fixture.socket.messages().at(-1)).toEqual({
      type: "terminal_sizing",
      terminalId,
      sizing: { mode: "retained", columns: [], rows: [] },
    });
    expect(fixture.clock.pendingJobs).toBe(0);
    fixture.store.close();
  });

  test("the registration bound spans channels, refuses extra identities and permits reuse after withdrawal", () => {
    const ids = Array.from(
      { length: MAX_TERMINAL_VIEWPORTS / 2 },
      (_, index) => `viewport-${index}`,
    );
    const fixture = viewportFixture(...ids, "overflow");
    const terminalId = fixture.create.terminalId;
    const sibling = new SessionChannel(
      fixture.runtime.newId(),
      new FakeSocket(),
      fixture.root,
      fixture.container.id,
      "bounded-sibling",
    );
    attachLive(fixture, sibling, ...ids);
    for (let index = 0; index < MAX_TERMINAL_VIEWPORTS / 2; index += 1) {
      measureViewport(fixture, fixture.opener, `viewport-${index}`, 80, 24);
      measureViewport(fixture, sibling, `viewport-${index}`, 80, 24);
    }
    const expected = Array.from({ length: MAX_TERMINAL_VIEWPORTS / 2 }, (_, index) => ({
      connId: fixture.opener.id,
      viewportId: `viewport-${index}`,
    })).concat(
      Array.from({ length: MAX_TERMINAL_VIEWPORTS / 2 }, (_, index) => ({
        connId: sibling.id,
        viewportId: `viewport-${index}`,
      })),
    );
    expect(fixture.socket.messages().at(-1)).toMatchObject({
      type: "terminal_sizing",
      sizing: { mode: "smallest", columns: expected, rows: expected },
    });
    expect(fixture.clock.pendingJobs).toBe(1);
    fixture.machine.clear();
    fixture.socket.clear();
    measureViewport(fixture, fixture.opener, "overflow", 10, 5);
    expect(fixture.socket.messages().at(-1)).toMatchObject({ type: "error", code: "conflict" });
    expect(fixture.machine.sent).toEqual([]);
    expect(fixture.broker.listForContainer(fixture.container.id)).toMatchObject([
      { cols: 80, rows: 24 },
    ]);
    measureViewport(fixture, fixture.opener, "viewport-0", 80, 24);
    expect(fixture.machine.sent).toEqual([]);
    withdrawViewport(fixture, sibling, "viewport-0");
    measureViewport(fixture, fixture.opener, "overflow", 10, 5);
    expect(fixture.machine.sent).toEqual([{ type: "resize", terminalId, cols: 10, rows: 5 }]);
    expect(fixture.socket.messages().at(-1)).toMatchObject({
      type: "terminal_sizing",
      sizing: {
        columns: [{ connId: fixture.opener.id, viewportId: "overflow" }],
        rows: [{ connId: fixture.opener.id, viewportId: "overflow" }],
      },
    });
    fixture.store.close();
  });

  test("replacement attachment retires old measurements without resetting retained geometry or losing queued output", () => {
    const fixture = viewportFixture("mount");
    const terminalId = fixture.create.terminalId;
    measureViewport(fixture, fixture.opener, "mount", 60, 18);
    fixture.machine.clear();
    fixture.socket.clear();
    attachView(fixture, fixture.opener, "mount");
    expect(fixture.machine.sent).toEqual([{ type: "snapshot_request", terminalId }]);
    expect(fixture.clock.pendingJobs).toBe(1);
    expect(fixture.socket.messages().at(-1)).toEqual({
      type: "terminal_sizing",
      terminalId,
      sizing: { mode: "retained", columns: [], rows: [] },
    });
    fixture.broker.onOutput(fixture.machine.machineId, {
      type: "output",
      terminalId,
      seq: 1,
      data: encoded("between-mounts"),
    });
    fixture.broker.onSnapshot(fixture.machine.machineId, {
      type: "snapshot",
      terminalId,
      seq: 0,
      data: encoded("replacement"),
    });
    expect(terminalStream(fixture.socket)).toEqual([
      // The re-attached view's fresh incarnation: its snapshot, then output that arrived meanwhile.
      {
        type: "terminal_snapshot",
        terminalId,
        seq: 0,
        data: encoded("replacement"),
        geometry: { cols: 60, rows: 18, revision: null },
      },
      { type: "terminal_output", terminalId, seq: 1, data: encoded("between-mounts") },
    ]);
    expect(fixture.clock.pendingJobs).toBe(0);
    expect(fixture.broker.listForContainer(fixture.container.id)).toMatchObject([
      { cols: 60, rows: 18 },
    ]);
    measureViewport(fixture, fixture.opener, "mount", 100, 30);
    expect(fixture.machine.sent).toContainEqual({
      type: "resize",
      terminalId,
      cols: 100,
      rows: 30,
    });
    fixture.store.close();
  });

  for (const failure of ["snapshot", "queued-output", "live-output", "resize-broadcast"] as const) {
    test(`failed ${failure} delivery retires that viewer's geometry and deadlines`, () => {
      const fixture = viewportFixture("survivor");
      const terminalId = fixture.create.terminalId;
      class DroppingSocket extends FakeSocket {
        dropType: string | null = null;

        override send(data: string): number {
          const frame = JSON.parse(data) as { type: string };
          if (frame.type === this.dropType) return 0;
          return super.send(data);
        }
      }
      const socket = new DroppingSocket();
      const channel = new SessionChannel(
        fixture.runtime.newId(),
        socket,
        fixture.root,
        fixture.container.id,
        "failing-viewer",
        false,
        (closing) => {
          fixture.broker.detachAll(closing);
          fixture.rooms.get(fixture.container.id)?.leave(closing);
        },
      );
      measureViewport(fixture, fixture.opener, "survivor", 120, 40);
      if (failure === "live-output" || failure === "resize-broadcast") {
        attachLive(fixture, channel, "removed");
      } else {
        fixture.rooms.get(fixture.container.id)?.join(channel);
        attachView(fixture, channel, "removed");
      }
      measureViewport(fixture, channel, "removed", 60, 18);
      socket.dropType =
        failure === "snapshot"
          ? "terminal_snapshot"
          : failure === "resize-broadcast"
            ? "terminal_event"
            : "terminal_output";
      if (failure === "resize-broadcast") {
        measureViewport(fixture, channel, "removed", 50, 12);
      } else {
        if (failure !== "snapshot") {
          fixture.broker.onOutput(fixture.machine.machineId, {
            type: "output",
            terminalId,
            seq: 1,
            data: encoded("dropped-tail"),
          });
        }
        if (failure !== "live-output") {
          fixture.broker.onSnapshot(fixture.machine.machineId, {
            type: "snapshot",
            terminalId,
            seq: 0,
            data: encoded("dropped-snapshot"),
          });
        }
      }
      expect(channel.isClosed).toBe(true);
      expect(fixture.broker.listForContainer(fixture.container.id)).toMatchObject([
        { cols: 120, rows: 40 },
      ]);
      expect(
        fixture.socket
          .messages()
          .filter((message) => message.type === "terminal_sizing")
          .at(-1),
      ).toMatchObject({
        type: "terminal_sizing",
        sizing: {
          columns: [{ connId: fixture.opener.id, viewportId: "survivor" }],
          rows: [{ connId: fixture.opener.id, viewportId: "survivor" }],
        },
      });
      expect(fixture.clock.pendingJobs).toBe(1);
      fixture.machine.clear();
      measureViewport(fixture, fixture.opener, "survivor", 125, 42);
      expect(fixture.machine.sent).toEqual([{ type: "resize", terminalId, cols: 125, rows: 42 }]);
      withdrawViewport(fixture, fixture.opener, "survivor");
      expect(fixture.clock.pendingJobs).toBe(0);
      fixture.store.close();
    });
  }

  for (const failure of ["snapshot-timeout", "queue-overflow"] as const) {
    test(`${failure} retires a PENDING viewport instead of letting it enter a later handoff`, () => {
      const fixture = viewportFixture("survivor");
      const terminalId = fixture.create.terminalId;
      const socket = new FakeSocket();
      const pending = new SessionChannel(
        fixture.runtime.newId(),
        socket,
        fixture.root,
        fixture.container.id,
        "pending-failure",
      );
      measureViewport(fixture, fixture.opener, "survivor", 120, 40);
      attachView(fixture, pending, "pending");
      measureViewport(fixture, pending, "pending", 60, 18);
      expect(fixture.clock.pendingJobs).toBe(2);
      fixture.machine.clear();
      if (failure === "snapshot-timeout") {
        fixture.clock.advance(10_000);
      } else {
        for (let seq = 1; seq <= 257; seq += 1) {
          fixture.broker.onOutput(fixture.machine.machineId, {
            type: "output",
            terminalId,
            seq,
            data: encoded("overflow"),
          });
        }
      }
      // The scoped refusal reaches the refused view before the generic error.
      expect(socket.messages().slice(-2)).toEqual([
        {
          type: "terminal_delivery",
          terminalId,
          viewportId: "pending",
          deliveryId: null,
          state: "refused",
          skipped: false,
          reason: failure === "snapshot-timeout" ? "snapshot_timeout" : "pending_overflow",
        },
        expect.objectContaining({ type: "error", code: "conflict", ref: terminalId }),
      ]);
      expect(fixture.clock.pendingJobs).toBe(1);
      fixture.broker.onSnapshot(fixture.machine.machineId, {
        type: "snapshot",
        terminalId,
        seq: 0,
        data: encoded("too-late"),
      });
      expect(fixture.machine.sent).toEqual([]);
      expect(fixture.broker.listForContainer(fixture.container.id)).toMatchObject([
        { cols: 120, rows: 40 },
      ]);
      withdrawViewport(fixture, fixture.opener, "survivor");
      expect(fixture.clock.pendingJobs).toBe(0);
      fixture.store.close();
    });
  }

  for (const lifecycle of [
    "detach",
    "machine-offline",
    "retained-exit",
    "clean-exit",
    "missing-inventory",
    "kill",
    "drop-home",
    "rebind",
  ] as const) {
    test(`${lifecycle} releases viewport registrations and their expiry callback`, () => {
      const fixture = viewportFixture("retiring");
      const terminalId = fixture.create.terminalId;
      measureViewport(fixture, fixture.opener, "retiring", 60, 18);
      expect(fixture.clock.pendingJobs).toBe(1);
      switch (lifecycle) {
        case "detach":
          fixture.broker.detach(fixture.opener, {
            type: "terminal_detach",
            terminalId,
            viewportId: "retiring",
          });
          break;
        case "machine-offline":
          fixture.broker.setMachineOffline(fixture.machine);
          break;
        case "retained-exit":
          fixture.broker.onExited(fixture.machine.machineId, terminalId, 3);
          break;
        case "clean-exit":
          fixture.broker.onExited(fixture.machine.machineId, terminalId, 0);
          break;
        case "missing-inventory":
          fixture.broker.reconcileMachineHello(fixture.machine.machineId, []);
          break;
        case "kill":
          fixture.broker.killById(terminalId);
          break;
        case "drop-home":
          fixture.broker.dropContainer(fixture.container.id);
          break;
        case "rebind": {
          const home: Container = {
            id: fixture.runtime.newId(),
            name: "new home",
            createdAt: fixture.runtime.now(),
            discipline: "composition",
          };
          fixture.store.createContainer(home);
          fixture.broker.rebindTerminal(terminalId, fixture.container.id, home.id, ROOT_TILE_ID);
          break;
        }
      }
      fixture.clock.advance(5_000);
      expect(fixture.clock.pendingJobs).toBe(0);
      fixture.machine.clear();
      fixture.clock.advance(TERMINAL_VIEWPORT_LEASE_MS);
      expect(fixture.machine.sent).toEqual([]);
      fixture.store.close();
    });
  }

  for (const lifecycle of ["adoption", "restart"] as const) {
    test(`${lifecycle} retires old geometry while preserving snapshot handoff and retained dimensions`, async () => {
      const fixture = viewportFixture("process");
      const terminalId = fixture.create.terminalId;
      measureViewport(fixture, fixture.opener, "process", 60, 18);
      ackCompleted(fixture, fixture.opener, "process");
      fixture.machine.clear();
      if (lifecycle === "adoption") {
        expect(
          fixture.broker.adoptTerminal(fixture.machine.machineId, {
            terminalId,
            cols: 60,
            rows: 18,
            seq: 0,
            alive: true,
          }),
        ).toBe(true);
      } else {
        const outcome = fixture.broker.restartById(
          terminalId,
          fixture.root.principal.id,
          fixture.auth.credentialReference(fixture.root),
        );
        fixture.broker.onRestarted(fixture.machine.machineId, {
          type: "terminal_restarted",
          terminalId,
        });
        expect(await outcome).toBe("ok");
      }
      expect(fixture.socket.messages().at(-1)).toEqual({
        type: "terminal_sizing",
        terminalId,
        sizing: { mode: "retained", columns: [], rows: [] },
      });
      fixture.machine.clear();
      fixture.broker.onSnapshot(fixture.machine.machineId, {
        type: "snapshot",
        terminalId,
        seq: 0,
        data: encoded("new-process"),
      });
      expect(fixture.machine.sent).toEqual([]);
      expect(fixture.broker.listForContainer(fixture.container.id)).toMatchObject([
        { cols: 60, rows: 18 },
      ]);
      measureViewport(fixture, fixture.opener, "process", 100, 32);
      expect(fixture.machine.sent).toEqual([{ type: "resize", terminalId, cols: 100, rows: 32 }]);
      fixture.store.close();
    });

    test(`${lifecycle} refuses a re-anchoring view when its online snapshot never arrives`, async () => {
      const fixture = viewportFixture("process");
      const terminalId = fixture.create.terminalId;
      measureViewport(fixture, fixture.opener, "process", 60, 18);
      ackCompleted(fixture, fixture.opener, "process");
      fixture.socket.clear();
      if (lifecycle === "adoption") {
        expect(
          fixture.broker.adoptTerminal(fixture.machine.machineId, {
            terminalId,
            cols: 60,
            rows: 18,
            seq: 0,
            alive: true,
          }),
        ).toBeTrue();
      } else {
        const outcome = fixture.broker.restartById(
          terminalId,
          fixture.root.principal.id,
          fixture.auth.credentialReference(fixture.root),
        );
        fixture.broker.onRestarted(fixture.machine.machineId, {
          type: "terminal_restarted",
          terminalId,
        });
        expect(await outcome).toBe("ok");
      }
      fixture.clock.advance(10_000);
      expect(fixture.socket.messages()).toContainEqual(
        expect.objectContaining({
          type: "terminal_delivery",
          terminalId,
          viewportId: "process",
          state: "refused",
          reason: "snapshot_timeout",
        }),
      );
      fixture.broker.onSnapshot(fixture.machine.machineId, {
        type: "snapshot",
        terminalId,
        seq: 0,
        data: encoded("too-late"),
      });
      expect(deliveredTo(fixture.opener, "process")).toEqual([]);
      fixture.store.close();
    });
  }
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
      viewportId: "fixture",
      viewport: { cols: 100, rows: 30 },
    });
    expect(fixture.machine.sent).toEqual([]);
    expect(
      secondSocket
        .messages()
        .filter((message) => message.type === "error")
        .map((message) => message.code),
    ).toEqual(["not_controller", "not_controller"]);

    attachView(fixture, second, "fixture");
    fixture.broker.onSnapshot(fixture.machine.machineId, {
      type: "snapshot",
      terminalId: fixture.create.terminalId,
      seq: 0,
      data: encoded("initial"),
    });
    fixture.machine.clear();

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
      viewportId: "fixture",
      viewport: { cols: 120, rows: 40 },
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
    // Removal reports departure, not retained error/unknown evidence. The departure notice
    // drops the row from every terminal listing.
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
        readiness: "application",
      },
    ]);

    expect(fixture.socket.messages()).toContainEqual({
      type: "terminal_event",
      terminalId: fixture.create.terminalId,
      kind: "controller_changed",
      controllerId: fixture.root.principal.id,
    });
    expect(fixture.socket.messages()).toContainEqual({
      type: "terminal_event",
      terminalId: fixture.create.terminalId,
      kind: "ready",
      readiness: "application",
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
    expect(
      fixture.store
        .listEvents({ type: "terminal_exited", limit: 10 })
        .map((event) => JSON.parse(event.payload)),
    ).toEqual([
      {
        terminalId: fixture.create.terminalId,
        machineId: fixture.machine.machineId,
        exitCode: 23,
      },
    ]);
    fixture.store.close();
  });

  test("a viewer first attached offline survives until retained owner adoption and ordered replay", () => {
    const fixture = brokerFixture();
    const terminalId = fixture.create.terminalId;
    fixture.broker.setMachineOffline(fixture.machine);
    fixture.rooms.get(fixture.container.id)?.join(fixture.opener);
    fixture.socket.clear();
    attachView(fixture, fixture.opener, VIEW);
    fixture.clock.advance(30_000);
    expect(fixture.socket.messages().filter((message) => message.type === "error")).toEqual([]);
    expect(fixture.machine.sent).toEqual([]);
    fixture.broker.setMachineOnline(fixture.machine);
    expect(
      fixture.broker.adoptTerminal(fixture.machine.machineId, {
        terminalId,
        cols: 80,
        rows: 24,
        alive: true,
        seq: 10,
      }),
    ).toBeTrue();
    expect(fixture.machine.sent).toEqual([{ type: "snapshot_request", terminalId }]);
    fixture.broker.onOutput(fixture.machine.machineId, {
      type: "output",
      terminalId,
      seq: 11,
      data: encoded("tail"),
    });
    expect(
      fixture.socket.messages().filter((message) => message.type === "terminal_output"),
    ).toEqual([]);
    fixture.broker.onSnapshot(fixture.machine.machineId, {
      type: "snapshot",
      terminalId,
      seq: 10,
      data: encoded("retained owner"),
    });
    expect(
      fixture.socket
        .messages()
        .filter(
          (message) => message.type === "terminal_snapshot" || message.type === "terminal_output",
        )
        .map((message) => [message.type, message.seq, message.data]),
    ).toEqual([
      ["terminal_snapshot", 10, encoded("retained owner")],
      ["terminal_output", 11, encoded("tail")],
    ]);
    fixture.store.close();
  });

  test("successful adoption heals each existing view only after its sent work completes", () => {
    const fixture = brokerFixture();
    attachView(fixture, fixture.opener, VIEW);
    fixture.broker.onSnapshot(fixture.machine.machineId, {
      type: "snapshot",
      terminalId: fixture.create.terminalId,
      seq: 0,
      data: encoded("initial"),
    });
    const initial = deliveredTo(fixture.opener).at(-1);
    if (initial === undefined) throw new Error("missing initial snapshot");
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
    // The view's parser has not finished its snapshot yet: a fresh one must not jump the queue.
    expect(fixture.machine.sent).toEqual([]);
    expect(
      fixture.socket.messages().filter((message) => message.type === "terminal_delivery"),
    ).toEqual([
      {
        type: "terminal_delivery",
        terminalId: fixture.create.terminalId,
        viewportId: VIEW,
        deliveryId: initial.deliveryId,
        state: "recovering",
        skipped: false,
        reason: null,
      },
    ]);
    fixture.broker.ack(fixture.opener, {
      type: "terminal_ack",
      terminalId: fixture.create.terminalId,
      viewportId: VIEW,
      deliveryId: initial.deliveryId,
      deliverySeq: initial.deliverySeq,
    });
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

  test.each(["held", "recovering"] as const)(
    "owner re-adoption discloses output omitted while %s",
    (timing) => {
      const fixture = brokerFixture();
      const terminalId = fixture.create.terminalId;
      attachView(fixture, fixture.opener);
      fixture.broker.onSnapshot(fixture.machine.machineId, {
        type: "snapshot",
        terminalId,
        seq: 0,
        data: encoded("initial"),
      });
      if (timing === "held") {
        for (let seq = 1; seq <= MAX_TERMINAL_DELIVERY_UNACKED_FRAMES; seq++) {
          fixture.broker.onOutput(fixture.machine.machineId, {
            type: "output",
            terminalId,
            seq,
            data: encoded("byte"),
          });
        }
      }
      const before = deliveredTo(fixture.opener).length;
      const sourceSeq = timing === "held" ? MAX_TERMINAL_DELIVERY_UNACKED_FRAMES : 10;
      fixture.machine.clear();
      expect(
        fixture.broker.adoptTerminal(fixture.machine.machineId, {
          terminalId,
          cols: 100,
          rows: 30,
          alive: true,
          seq: sourceSeq,
        }),
      ).toBeTrue();
      if (timing === "recovering") {
        for (const seq of [11, 12]) {
          fixture.broker.onOutput(fixture.machine.machineId, {
            type: "output",
            terminalId,
            seq,
            data: encoded("omitted"),
          });
        }
      }
      expect(
        fixture.socket
          .messages()
          .filter((frame) => frame.type === "terminal_delivery" && frame.state === "recovering")
          .map((frame) => frame.type === "terminal_delivery" && frame.skipped),
      ).toEqual(timing === "held" ? [true] : [false, true]);
      expect(deliveredTo(fixture.opener)).toHaveLength(before);
      expect(fixture.machine.sent).toEqual([]);
      ackCompleted(fixture, fixture.opener);
      expect(fixture.machine.sent).toEqual([{ type: "snapshot_request", terminalId }]);
      fixture.broker.onSnapshot(fixture.machine.machineId, {
        type: "snapshot",
        terminalId,
        seq: timing === "held" ? sourceSeq : 12,
        data: encoded("retained"),
      });
      expect(deliveredTo(fixture.opener).at(-1)).toMatchObject({
        type: "terminal_snapshot",
        skipped: true,
        data: encoded("retained"),
      });
      fixture.store.close();
    },
  );
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
    attachView(fixture, fixture.opener, VIEW);

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
    attachView(fixture, fixture.opener, VIEW);
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

describe("TerminalBroker per-view parser credit", () => {
  const range = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, index) => from + index);
  const emit = (fixture: TerminalFixture, seq: number, data = encoded(`out-${seq}`)) =>
    fixture.broker.onOutput(fixture.machine.machineId, {
      type: "output",
      terminalId: fixture.create.terminalId,
      seq,
      data,
    });
  const notices = (socket: FakeSocket) =>
    socket.messages().filter((message) => message.type === "terminal_delivery");
  const frames = MAX_TERMINAL_DELIVERY_UNACKED_FRAMES;

  test("a stalled view holds only its own window while a sibling on the same channel keeps every frame", () => {
    const fixture = viewportFixture("slow", "healthy");
    for (const seq of range(1, frames + 44)) {
      emit(fixture, seq);
      ackCompleted(fixture, fixture.opener, "healthy");
    }
    const healthy = deliveredTo(fixture.opener, "healthy");
    expect(healthy.map((frame) => frame.seq)).toEqual(range(1, frames + 44));
    expect(healthy.map((frame) => frame.deliverySeq)).toEqual(range(1, frames + 44));
    const slow = deliveredTo(fixture.opener, "slow");
    const deliveryId = slow[0]?.deliveryId;
    if (deliveryId === undefined) throw new Error("stalled viewer received no delivery");
    expect(slow.map((frame) => frame.seq)).toEqual(range(1, frames));
    // One transition while waiting, never a notice per held frame.
    expect(notices(fixture.socket)).toEqual([
      {
        type: "terminal_delivery",
        terminalId: fixture.create.terminalId,
        viewportId: "slow",
        deliveryId,
        state: "waiting",
        skipped: false,
        reason: null,
      },
    ]);
    fixture.store.close();
  });

  test("only completed ordinals of the current incarnation and view release held frames", () => {
    const fixture = viewportFixture("slow", "other");
    for (const seq of range(1, frames + 44)) emit(fixture, seq);
    const sent = () => deliveredTo(fixture.opener, "slow");
    const deliveryId = sent()[0]?.deliveryId ?? "";
    const ack = (id: string, deliverySeq: number, viewportId = "slow") =>
      fixture.broker.ack(fixture.opener, {
        type: "terminal_ack",
        terminalId: fixture.create.terminalId,
        viewportId,
        deliveryId: id,
        deliverySeq,
      });
    ack(deliveryId, frames + 1);
    ack("an-older-incarnation", 9);
    ack(deliveryId, 9, "other");
    expect(sent()).toHaveLength(frames);
    ack(deliveryId, 9);
    expect(
      sent()
        .slice(frames)
        .map((frame) => frame.deliverySeq),
    ).toEqual(range(frames + 1, frames + 9));
    ack(deliveryId, 9);
    ack(deliveryId, 4);
    expect(sent()).toHaveLength(frames + 9);
    fixture.store.close();
  });

  test("encoded payload bytes bound the window as well as frames", () => {
    const fixture = viewportFixture();
    const half = "A".repeat(MAX_TERMINAL_DELIVERY_UNACKED_BYTES / 2);
    emit(fixture, 1, half);
    emit(fixture, 2, half);
    emit(fixture, 3, encoded("next"));
    expect(deliveredTo(fixture.opener).map((frame) => frame.seq)).toEqual([1, 2]);
    const [first] = deliveredTo(fixture.opener);
    if (first === undefined) throw new Error("missing first output");
    fixture.broker.ack(fixture.opener, {
      type: "terminal_ack",
      terminalId: fixture.create.terminalId,
      viewportId: VIEW,
      deliveryId: first.deliveryId,
      deliverySeq: first.deliverySeq,
    });
    expect(deliveredTo(fixture.opener).map((frame) => frame.seq)).toEqual([1, 2, 3]);
    fixture.store.close();
  });

  test("held geometry and output leave in arrival order under consecutive ordinals", () => {
    const fixture = geometryViewportFixture();
    for (const seq of range(1, frames)) emit(fixture, seq);
    sourceGeometry(fixture, frames, { cols: 60, rows: 18, revision: 1 });
    emit(fixture, frames + 1);
    sourceGeometry(fixture, frames + 1, { cols: 70, rows: 20, revision: 2 });
    expect(deliveredTo(fixture.opener)).toHaveLength(frames);
    ackCompleted(fixture, fixture.opener);
    expect(
      deliveredTo(fixture.opener)
        .slice(frames)
        .map((frame) => [frame.type, frame.deliverySeq, frame.seq]),
    ).toEqual([
      ["terminal_geometry", frames + 1, frames],
      ["terminal_output", frames + 2, frames + 1],
      ["terminal_geometry", frames + 3, frames + 1],
    ]);
    fixture.store.close();
  });

  test("pending overflow skips honestly and waits for sent work before one fresh snapshot", () => {
    const fixture = viewportFixture("slow", "healthy");
    const overflow = frames + MAX_TERMINAL_DELIVERY_PENDING_FRAMES + 1;
    for (const seq of range(1, overflow + 40)) {
      emit(fixture, seq);
      ackCompleted(fixture, fixture.opener, "healthy");
    }
    const sent = deliveredTo(fixture.opener, "slow");
    expect(sent.map((frame) => frame.seq)).toEqual(range(1, frames));
    expect(
      notices(fixture.socket).map((notice) => [notice.viewportId, notice.state, notice.skipped]),
    ).toEqual([
      ["slow", "waiting", false],
      ["slow", "recovering", true],
    ]);
    // Unpaid work blocks the recovery snapshot: a fresh one never evades outstanding credit.
    expect(fixture.machine.sent).toEqual([]);
    const last = sent.at(-1);
    if (last === undefined) throw new Error("missing sent work");
    fixture.broker.ack(fixture.opener, {
      type: "terminal_ack",
      terminalId: fixture.create.terminalId,
      viewportId: "slow",
      deliveryId: last.deliveryId,
      deliverySeq: last.deliverySeq,
    });
    expect(fixture.machine.sent).toEqual([
      { type: "snapshot_request", terminalId: fixture.create.terminalId },
    ]);
    emit(fixture, overflow + 41);
    ackCompleted(fixture, fixture.opener, "healthy");
    fixture.broker.onSnapshot(fixture.machine.machineId, {
      type: "snapshot",
      terminalId: fixture.create.terminalId,
      seq: overflow + 40,
      data: encoded("retained screen"),
    });
    const recovered = deliveredTo(fixture.opener, "slow").slice(frames);
    expect(recovered.map((frame) => [frame.type, frame.deliverySeq, frame.seq])).toEqual([
      ["terminal_snapshot", 0, overflow + 40],
      ["terminal_output", 1, overflow + 41],
    ]);
    expect(recovered[0]).toMatchObject({ skipped: true });
    expect(recovered[0]?.deliveryId).not.toBe(last.deliveryId);
    expect(deliveredTo(fixture.opener, "healthy").map((frame) => frame.seq)).toEqual(
      range(1, overflow + 41),
    );
    fixture.store.close();
  });

  test("detach fences one view's incarnation and a rejoin starts fresh beside its sibling", () => {
    const fixture = viewportFixture("leaving", "kept");
    for (const seq of range(1, frames + 4)) {
      emit(fixture, seq);
      ackCompleted(fixture, fixture.opener, "kept");
    }
    const old = deliveredTo(fixture.opener, "leaving").at(-1);
    if (old === undefined) throw new Error("missing old incarnation");
    fixture.broker.detach(fixture.opener, {
      type: "terminal_detach",
      terminalId: fixture.create.terminalId,
      viewportId: "leaving",
    });
    attachView(fixture, fixture.opener, "leaving");
    fixture.broker.onSnapshot(fixture.machine.machineId, {
      type: "snapshot",
      terminalId: fixture.create.terminalId,
      seq: frames + 4,
      data: encoded("rejoined"),
    });
    // A late completion of the retired incarnation credits nothing in the new one.
    fixture.broker.ack(fixture.opener, {
      type: "terminal_ack",
      terminalId: fixture.create.terminalId,
      viewportId: "leaving",
      deliveryId: old.deliveryId,
      deliverySeq: old.deliverySeq,
    });
    emit(fixture, frames + 5);
    ackCompleted(fixture, fixture.opener, "kept");
    const rejoined = deliveredTo(fixture.opener, "leaving").slice(frames);
    expect(rejoined.map((frame) => [frame.type, frame.deliverySeq, frame.seq])).toEqual([
      ["terminal_snapshot", 0, frames + 4],
      ["terminal_output", 1, frames + 5],
    ]);
    expect(rejoined[0]).toMatchObject({ skipped: false });
    expect(rejoined[0]?.deliveryId).not.toBe(old.deliveryId);
    expect(deliveredTo(fixture.opener, "kept").map((frame) => frame.seq)).toEqual(
      range(1, frames + 5),
    );
    fixture.store.close();
  });

  test("attach refusals name the refused view instead of only a generic error", () => {
    const fixture = viewportFixture();
    for (const index of range(1, MAX_TERMINAL_VIEWPORTS - 1)) {
      attachView(fixture, fixture.opener, `view-${index}`);
    }
    fixture.socket.clear();
    attachView(fixture, fixture.opener, "one-too-many");
    expect(fixture.socket.messages()).toEqual([
      {
        type: "terminal_delivery",
        terminalId: fixture.create.terminalId,
        viewportId: "one-too-many",
        deliveryId: null,
        state: "refused",
        skipped: false,
        reason: "view_limit",
      },
      {
        type: "error",
        code: "conflict",
        message: "terminal view limit reached",
        ref: fixture.create.terminalId,
      },
    ]);
    fixture.broker.onExited(fixture.machine.machineId, fixture.create.terminalId, 3);
    fixture.socket.clear();
    attachView(fixture, fixture.opener, "late");
    expect(notices(fixture.socket)).toMatchObject([
      { viewportId: "late", deliveryId: null, state: "refused", reason: "exited" },
    ]);
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

  test.each([0, 130, null])(
    "hello replays exit %s once, revokes its credential, and cannot resurrect it",
    (exitCode) => {
      const fixture = brokerFixture();
      const token = sessionToken(fixture.create);
      const advertised = {
        terminalId: fixture.create.terminalId,
        cols: 80,
        rows: 24,
        seq: 0,
        alive: false,
        exitCode,
      };
      // Another machine cannot claim the terminal or remove it through exit replay.
      fixture.broker.reconcileMachineHello("not-the-owner", [advertised]);
      fixture.broker.onExited("not-the-owner", fixture.create.terminalId, 0);
      expect(fixture.store.getTerminal(fixture.create.terminalId)?.status).toBe("running");

      fixture.broker.reconcileMachineHello(fixture.machine.machineId, [advertised]);
      fixture.broker.reconcileMachineHello(fixture.machine.machineId, [advertised]);
      fixture.broker.onExited(fixture.machine.machineId, fixture.create.terminalId, exitCode);
      if (exitCode === 0) {
        expect(fixture.store.getTerminal(fixture.create.terminalId)).toBeNull();
        expect(fixture.store.getContainer(fixture.container.id)).toBeNull();
        expect(fixture.broker.listForContainer(fixture.container.id)).toEqual([]);
      } else {
        expect(fixture.store.getTerminal(fixture.create.terminalId)).toMatchObject({
          status: "exited",
          exitCode,
        });
        expect(
          fixture.rooms.get(fixture.container.id)?.homesTerminal(fixture.create.terminalId),
        ).toBe(true);
      }
      expect(() => fixture.auth.authenticate(token)).toThrow(ServiceError);
      expect(
        fixture.store
          .listEvents({ type: "terminal_exited", limit: 10 })
          .map((event) => JSON.parse(event.payload)),
      ).toEqual([
        {
          terminalId: fixture.create.terminalId,
          machineId: fixture.machine.machineId,
          exitCode,
        },
      ]);
      expect(
        fixture.broker.adoptTerminal(fixture.machine.machineId, { ...advertised, alive: true }),
      ).toBeFalse();
      fixture.store.close();
    },
  );

  test("an owner inventory missing a PTY keeps its home leaf for inspection", () => {
    const fixture = brokerFixture();
    const room = fixture.rooms.get(fixture.container.id);
    if (room === null) throw new Error("missing room");
    room.join(fixture.opener);
    fixture.socket.clear();

    fixture.broker.reconcileMachineHello(fixture.machine.machineId, []);
    expect(fixture.broker.listForContainer(fixture.container.id)).toMatchObject([
      { id: fixture.create.terminalId, status: "exited", exitCode: null },
    ]);

    // Missing inventory is not an observed root exit. Preserve its unknown evidence.
    fixture.broker.pruneExitedUnhomedForContainer(fixture.container.id);
    expect(room.homesTerminal(fixture.create.terminalId)).toBeTrue();
    expect(fixture.broker.listForContainer(fixture.container.id)).toHaveLength(1);
    expect(fixture.store.getTerminal(fixture.create.terminalId)).not.toBeNull();
    expect(fixture.store.getContainer(fixture.container.id)).not.toBeNull();
    fixture.store.close();
  });

  test("the prune collects an exited terminal whose home leaf is gone and retires the home", () => {
    const fixture = brokerFixture();
    fixture.broker.reconcileMachineHello(fixture.machine.machineId, []);
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
    attachView(fixture, fixture.opener, "fixture");
    fixture.broker.onSnapshot(fixture.machine.machineId, {
      type: "snapshot",
      terminalId: fixture.create.terminalId,
      seq: 0,
      data: encoded("before-room-unload"),
    });
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
      viewportId: "fixture",
      viewport: { cols: 100, rows: 30 },
    });
    fixture.broker.take(fixture.opener, {
      type: "terminal_take",
      terminalId: fixture.create.terminalId,
    });
    fixture.broker.onExited(fixture.machine.machineId, fixture.create.terminalId, 3);
    expect(fixture.rooms.introspect()).toHaveLength(0);
    fixture.store.close();
  });
});

describe("TerminalBroker live stream and control contracts", () => {
  test("driving a missing PTY conflicts, but dismissing it is the kill it asked for", () => {
    const fixture = brokerFixture();
    fixture.broker.reconcileMachineHello(fixture.machine.machineId, []);
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
      viewportId: "fixture",
      viewport: { cols: 90, rows: 25 },
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
        exitReason: null,
        readiness: null,
        cols: 80,
        rows: 24,
        controllerId: fixture.root.principal.id,
        createdBy: fixture.root.principal.id,
      },
    });
    expect(
      fixture.socket.messages().find((message) => message.type === "terminal_opened"),
    ).toMatchObject({ elementId: ROOT_TILE_ID, ref: "terminal-1" });
    secondSocket.clear();
    fixture.broker.onReady(fixture.machine.machineId, fixture.create.terminalId, "bracketed_paste");
    fixture.broker.onReady(fixture.machine.machineId, fixture.create.terminalId, "application");
    expect(secondSocket.messages().filter((message) => message.type === "terminal_event")).toEqual([
      {
        type: "terminal_event",
        terminalId: fixture.create.terminalId,
        kind: "ready",
        readiness: "bracketed_paste",
      },
    ]);
    fixture.store.close();
  });

  test("duplicate and regressed output seq values are dropped on the LIVE path", () => {
    const fixture = brokerFixture();
    attachView(fixture, fixture.opener, VIEW);
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

    attachView(fixture, fixture.opener, VIEW);
    attachView(fixture, second, VIEW);
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

describe("TerminalBroker first-viewer tile fit", () => {
  test("an approved container share cannot reserve an ordinary account shell", () => {
    const setup = brokerSetup();
    try {
      const minted = setup.auth.mintShare(
        {
          node: { kind: "container", containerId: setup.container.id },
          origin: "https://guest.example",
          caps: ["containers:read", "terminals:spawn", "terminals:write"],
        },
        setup.root,
      );
      const share = setup.store.getShare(minted.share.id);
      if (share === null) throw new Error("missing share");
      const guest = { id: "guest-fit", kind: "human" as const, name: "fit", color: "#2563eb" };
      expect(() => setup.auth.mintShareTicket(share, guest)).toThrow(ServiceError);
      setup.auth.approveShareRecipient(
        { shareId: share.id, guestPrincipalId: guest.id, caps: minted.share.caps },
        setup.root,
      );
      const ticket = setup.auth.mintShareTicket(share, guest);
      const socket = new FakeSocket();
      const channel = new SessionChannel(
        setup.runtime.newId(),
        socket,
        setup.auth.authenticate(ticket.token),
        setup.container.id,
        "remote-fit",
      );
      setup.broker.open(channel, {
        type: "terminal_open",
        elementId: "withdrawn-before-fit",
        placement: "tile",
      });
      expect(setup.broker.hasPendingOpenForContainer(setup.container.id)).toBe(false);
      setup.auth.removeShareRecipient(
        { shareId: share.id, guestPrincipalId: guest.id },
        setup.root,
      );
      expect(setup.machine.sent.some((message) => message.type === "create")).toBe(false);
      expect(setup.broker.hasPendingOpenForContainer(setup.container.id)).toBe(false);
      expect(socket.messages()).toContainEqual(
        expect.objectContaining({ type: "error", code: "forbidden", ref: "withdrawn-before-fit" }),
      );
    } finally {
      setup.store.close();
    }
  });

  test("only a real writable home viewport births a pending tile, without a controller requirement", () => {
    const setup = brokerSetup();
    setup.broker.open(setup.opener, {
      type: "terminal_open",
      elementId: "authorized-birth",
      placement: "tile",
    });
    const terminalId = pendingTerminalId(setup);
    setup.broker.resize(setup.opener, {
      type: "terminal_resize",
      terminalId,
      viewportId: "withdrawn",
      viewport: null,
    });
    const readonly = setup.auth.mintToken(
      {
        principal: { name: "read-only home viewer", kind: "human" },
        caps: ["containers:read"],
        containerId: setup.container.id,
      },
      setup.root,
    );
    for (const [index, context] of [
      setup.auth.authenticate(readonly.token),
      setup.root,
    ].entries()) {
      const socket = new FakeSocket();
      const channel = new SessionChannel(
        setup.runtime.newId(),
        socket,
        context,
        setup.container.id,
        `unauthorized-birth-${index}`,
        index === 1,
      );
      setup.broker.resize(channel, {
        type: "terminal_resize",
        terminalId,
        viewportId: "unauthorized",
        viewport: { cols: 10, rows: 5 },
      });
      expect(socket.messages().at(-1)).toMatchObject({ type: "error", code: "forbidden" });
    }
    expect(setup.machine.sent).toEqual([]);
    const writable = setup.auth.mintToken(
      {
        principal: { name: "writable home viewer", kind: "human" },
        caps: ["containers:read", "terminals:write"],
        containerId: setup.container.id,
      },
      setup.root,
    );
    const context = setup.auth.authenticate(writable.token);
    expect(context.principal.id).not.toBe(setup.root.principal.id);
    const channel = new SessionChannel(
      setup.runtime.newId(),
      new FakeSocket(),
      context,
      setup.container.id,
      "authorized-birth",
    );
    setup.broker.resize(channel, {
      type: "terminal_resize",
      terminalId,
      viewportId: "measured",
      viewport: { cols: 96, rows: 30 },
    });
    expect(setup.machine.sent).toEqual([
      expect.objectContaining({ type: "create", terminalId, cols: 96, rows: 30 }),
    ]);
    setup.broker.onCreated(setup.machine.machineId, terminalId);
    expect(setup.broker.listForContainer(setup.container.id)).toMatchObject([
      { cols: 96, rows: 30, controllerId: setup.root.principal.id },
    ]);
    setup.store.close();
  });

  test("publishes a measurable tile before creating one PTY at the first viewer geometry", () => {
    const setup = brokerSetup();
    setup.broker.open(setup.opener, {
      type: "terminal_open",
      elementId: "fit-me",
      placement: "tile",
    });

    const terminalId = pendingTerminalId(setup);
    expect(setup.machine.sent).toEqual([]);
    const racingViewer = new SessionChannel(
      setup.runtime.newId(),
      new FakeSocket(),
      setup.root,
      setup.container.id,
      "race",
    );

    setup.broker.resize(setup.opener, {
      type: "terminal_resize",
      terminalId,
      viewportId: "fixture",
      viewport: { cols: 132, rows: 41 },
    });
    setup.broker.resize(racingViewer, {
      type: "terminal_resize",
      terminalId,
      viewportId: "fixture",
      viewport: { cols: 70, rows: 20 },
    });

    expect(setup.machine.sent).toEqual([
      expect.objectContaining({ type: "create", terminalId, cols: 132, rows: 41 }),
    ]);
    setup.broker.onCreated(setup.machine.machineId, terminalId);
    expect(setup.store.getTerminal(terminalId)?.launchRecipe).toMatchObject({
      cols: 132,
      rows: 41,
    });
    setup.store.close();
  });

  test("an explicit viewport starts only its own terminal without fitting concurrent leaves", () => {
    const setup = brokerSetup();
    setup.broker.open(setup.opener, {
      type: "terminal_open",
      elementId: "unrelated-viewer",
      placement: "tile",
    });
    const waitingId = pendingTerminalId(setup);
    setup.broker.open(setup.opener, {
      type: "terminal_open",
      elementId: "headless-viewer",
      placement: "tile",
      cols: 96,
      rows: 30,
    });
    const created = setup.machine.sent.find((message) => message.type === "create");
    if (created?.type !== "create") throw new Error("explicit viewport did not start its terminal");
    expect(created.terminalId).not.toBe(waitingId);
    expect(created).toMatchObject({ cols: 96, rows: 30 });
    expect(setup.machine.sent).toHaveLength(1);
    setup.broker.onCreated(setup.machine.machineId, created.terminalId);
    expect(setup.broker.listForContainer(setup.container.id)).toMatchObject([
      { id: created.terminalId, cols: 96, rows: 30 },
    ]);
    expect(setup.store.getTerminal(waitingId)).toBeNull();
    setup.broker.resize(setup.opener, {
      type: "terminal_resize",
      terminalId: waitingId,
      viewportId: "fixture",
      viewport: { cols: 132, rows: 41 },
    });
    expect(setup.machine.sent).toContainEqual(
      expect.objectContaining({ type: "create", terminalId: waitingId, cols: 132, rows: 41 }),
    );
    setup.store.close();
  });

  test("times out without a viewer and removes the unstarted tile", () => {
    const setup = brokerSetup();
    setup.broker.open(setup.opener, {
      type: "terminal_open",
      elementId: "unseen",
      placement: "tile",
    });
    const terminalId = pendingTerminalId(setup);

    setup.clock.advance(10_000);

    expect(setup.machine.sent).toEqual([]);
    expect(setup.rooms.get(setup.container.id)?.homesTerminal(terminalId)).toBe(false);
    expect(setup.socket.messages()).toContainEqual(
      expect.objectContaining({
        type: "error",
        code: "no_machine",
        ref: "unseen",
        message: "terminal fit timed out",
      }),
    );
    setup.store.close();
  });
});

describe("TerminalBroker execution policy", () => {
  test.each(["governed", null] as const)(
    "runtime-free shells and programs are refused when execution is %s",
    (execution) => {
      const setup = brokerSetup(execution);
      for (const program of [undefined, { argv: ["/bin/sh"] as [string] }]) {
        setup.socket.clear();
        setup.broker.open(setup.opener, {
          type: "terminal_open",
          elementId: "unbound",
          cols: 80,
          rows: 24,
          placement: "tile",
          ...(program === undefined ? {} : { program }),
        });
        expect(setup.machine.sent).toEqual([]);
        expect(setup.socket.messages()).toMatchObject([
          {
            type: "error",
            code: execution === "governed" ? "forbidden" : "unsupported",
            ref: "unbound",
          },
        ]);
      }
      setup.store.close();
    },
  );
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
    const machine = new FakeMachine(setup.machine.machineId, "host-A");
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

  test("ordinary restart acknowledgement survives a drain latched after owner dispatch", async () => {
    const setup = drainSetup();
    try {
      setup.broker.open(setup.opener, {
        type: "terminal_open",
        elementId: "restart-before-drain",
        placement: "tile",
      });
      const terminalId = fitPending(setup);
      setup.broker.onCreated(setup.machine.machineId, terminalId);
      const before = setup.store.getTerminal(terminalId);
      setup.machine.clear();
      const restarted = setup.broker.restartById(
        terminalId,
        setup.root.principal.id,
        setup.auth.credentialReference(setup.root),
      );
      const command = setup.machine.sent.find((message) => message.type === "terminal_restart");
      if (command?.type !== "terminal_restart") throw new Error("restart was not dispatched");

      const drained = setup.broker.drain(setup.machine.machineId, true);
      setup.answer(setup.lastRequest(), { terminalIds: [terminalId] });
      expect((await drained).ok).toBe(true);
      setup.broker.onRestarted(setup.machine.machineId, {
        type: "terminal_restarted",
        terminalId,
      });

      expect(await restarted).toBe("ok");
      expect(setup.machine.sent.some((message) => message.type === "kill")).toBe(false);
      expect(setup.store.getTerminal(terminalId)).toMatchObject({
        id: terminalId,
        containerId: before!.containerId,
        createdAt: before!.createdAt,
        status: "running",
      });
      expect(
        await setup.broker.restartById(
          terminalId,
          setup.root.principal.id,
          setup.auth.credentialReference(setup.root),
        ),
      ).toBe("machine_draining");
    } finally {
      setup.store.close();
    }
  });

  test("inventory news follows the committed latch even when the owner refuses", async () => {
    const setup = drainSetup();
    const host = await testPluginHost(
      setup.store,
      setup.auth,
      setup.rooms,
      setup.broker,
      setup.runtime,
    );
    const inventoryNews = () =>
      setup.store
        .listEvents({ type: "machine_inventory_changed", limit: 100 })
        .map(({ payload }) => JSON.parse(payload) as unknown);
    try {
      const closing = setup.broker.drain(setup.machine.machineId, true);
      expect(inventoryNews()).toEqual([{ machineId: setup.machine.machineId, draining: true }]);
      setup.clock.advance(10_000);
      expect((await closing).ok).toBe(false);
      expect(setup.store.getMachine(setup.machine.machineId)?.draining).toBe(true);

      const unchanged = setup.broker.drain(setup.machine.machineId, true);
      setup.answer(setup.lastRequest(), { terminalHostId: "wrong-owner" });
      expect((await unchanged).ok).toBe(false);
      expect(inventoryNews()).toEqual([{ machineId: setup.machine.machineId, draining: true }]);

      setup.broker.setMachineOffline(setup.machine);
      expect((await setup.broker.drain(setup.machine.machineId, false)).ok).toBe(false);
      expect(setup.store.getMachine(setup.machine.machineId)?.draining).toBe(false);
      expect(inventoryNews()).toEqual([
        { machineId: setup.machine.machineId, draining: false },
        { machineId: setup.machine.machineId, draining: true },
      ]);
    } finally {
      host.close();
      setup.store.close();
    }
  });

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
    fitPending(setup);
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
      expect.objectContaining({ type: "error", ref: "too-late" }),
    ]);
    expect(setup.machine.sent.filter((message) => message.type === "create")).toHaveLength(1);

    setup.answer(setup.lastRequest(), { terminalIds: [create.terminalId] });
    expect(await outcome).toEqual({
      ok: true,
      status: { terminalHostId: "host-A", draining: true, terminalIds: [create.terminalId] },
    });
    setup.broker.onCreated(setup.machine.machineId, create.terminalId);

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
    fitPending(setup);
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
      expect.objectContaining({ type: "error", ref: "refused" }),
    ]);
    // A cancel with nobody to tell still reopens the hub's half.
    expect((await setup.broker.drain(setup.machine.machineId, false)).ok).toBe(false);
    expect(setup.broker.isMachineDraining(setup.machine.machineId)).toBe(false);
    setup.store.close();
  });
});

describe("TerminalBroker restart in place", () => {
  test("replacement owner uses persisted launch intent while retaining identity and cwd", async () => {
    const f = brokerSetup();
    f.broker.open(f.opener, {
      type: "terminal_open",
      elementId: "original",
      placement: "tile",
      cols: 110,
      rows: 35,
      cwd: "/original",
      program: { argv: ["/bin/sh", "-l"] },
      env: { PROJECT: "kept" },
    });
    fitPending(f, 110, 35);
    const create = f.machine.sent.find((message) => message.type === "create");
    if (!create || create.type !== "create") throw new Error("missing create");
    const terminalId = create.terminalId;
    f.broker.onCreated(f.machine.machineId, terminalId);
    f.broker.rename(terminalId, "kept name");
    f.broker.onCwd(f.machine.machineId, terminalId, "/last/observed");
    const before = f.store.getTerminal(terminalId);
    expect(JSON.stringify(before)).not.toContain(sessionToken(create));
    f.broker.onOwnerLost(f.machine.machineId);
    const replacement = new FakeMachine(f.machine.machineId, "replacement");
    const broker = new TerminalBroker(
      f.store,
      f.auth,
      f.rooms,
      f.runtime,
      f.clock,
      silentLogger,
      () => "http://localhost:7777",
      testTileTrees,
    );
    broker.setMachineOnline(replacement);
    // Only the hub knows why the predecessor's terminal ended, and a restarted hub still says so.
    expect(broker.listForContainer(before!.containerId)).toMatchObject([
      { id: terminalId, status: "exited", exitCode: null, exitReason: "owner_lost" },
    ]);
    const result = broker.restartById(
      terminalId,
      f.root.principal.id,
      f.auth.credentialReference(f.root),
    );
    const command = replacement.sent.find((message) => message.type === "terminal_restart");
    if (!command || command.type !== "terminal_restart" || !command.create)
      throw new Error("missing restart");
    expect(command.cwd).toBe("/last/observed");
    expect(command.create).toMatchObject({
      cwd: "/original",
      program: create.program,
      env: { PROJECT: "kept", MANIFOLD_CONTAINER: before!.containerId },
    });
    const freshToken = command.create.env.MANIFOLD_TOKEN!;
    expect(f.auth.authenticate(freshToken).containerScope).toBe(before!.containerId);
    expect(() => f.auth.authenticate(sessionToken(create))).toThrow(ServiceError);
    broker.onRestarted(f.machine.machineId, {
      type: "terminal_restarted",
      terminalId,
      cwd: "/last/observed",
    });
    expect(await result).toBe("ok");
    expect(f.store.getTerminal(terminalId)).toMatchObject({
      id: terminalId,
      name: "kept name",
      containerId: before!.containerId,
      createdAt: before!.createdAt,
      createdBy: before!.createdBy,
      cwd: "/last/observed",
      status: "running",
      exitReason: null,
    });
    expect(broker.listForContainer(before!.containerId)).toMatchObject([
      { id: terminalId, status: "running", exitReason: null },
    ]);
    expect(f.rooms.get(before!.containerId)?.homesTerminal(terminalId)).toBe(true);
    f.store.close();
  });

  test("a relative launch cwd remains restart intent, not an observed cwd", async () => {
    const f = brokerSetup();
    f.broker.open(f.opener, {
      type: "terminal_open",
      placement: "tile",
      elementId: "relative",
      cols: 80,
      rows: 24,
      cwd: "./project",
    });
    fitPending(f);
    const create = f.machine.sent.find((message) => message.type === "create");
    if (!create || create.type !== "create") throw new Error("missing create");
    f.broker.onCreated(f.machine.machineId, create.terminalId);
    f.broker.onOwnerLost(f.machine.machineId);

    const replacement = new FakeMachine(f.machine.machineId, "replacement-relative");
    const broker = new TerminalBroker(
      f.store,
      f.auth,
      f.rooms,
      f.runtime,
      f.clock,
      silentLogger,
      () => "http://localhost:7777",
      testTileTrees,
    );
    broker.setMachineOnline(replacement);
    const result = broker.restartById(
      create.terminalId,
      f.root.principal.id,
      f.auth.credentialReference(f.root),
    );
    const command = replacement.sent.find((message) => message.type === "terminal_restart");
    if (command?.type !== "terminal_restart") throw new Error("missing restart");
    expect(command.cwd).toBeUndefined();
    expect(command.create?.cwd).toBe("./project");

    broker.onRestarted(f.machine.machineId, {
      type: "terminal_restarted",
      terminalId: create.terminalId,
    });
    expect(await result).toBe("ok");
    f.store.close();
  });

  test("running restart resets sequence numbers and snapshots before new output", async () => {
    const f = brokerFixture();
    const terminalId = f.create.terminalId;
    f.rooms.get(f.container.id)?.join(f.opener);
    attachView(f, f.opener);
    f.broker.onSnapshot(f.machine.machineId, {
      type: "snapshot",
      terminalId,
      seq: 50,
      data: encoded("old"),
    });
    f.broker.onOutput(f.machine.machineId, {
      type: "output",
      terminalId,
      seq: 51,
      data: encoded("old tail"),
    });
    f.socket.clear();
    const result = f.broker.restartById(
      terminalId,
      f.root.principal.id,
      f.auth.credentialReference(f.root),
    );
    expect(f.auth.authenticate(sessionToken(f.create)).principal.kind).toBe("agent");
    f.broker.onRestarted(f.machine.machineId, {
      type: "terminal_restarted",
      terminalId,
      cwd: "/original",
      fallback: "original",
    });
    expect(await result).toBe("ok");
    expect(() => f.auth.authenticate(sessionToken(f.create))).toThrow(ServiceError);
    f.broker.onOutput(f.machine.machineId, {
      type: "output",
      terminalId,
      seq: 1,
      data: encoded("new"),
    });
    f.broker.onSnapshot(f.machine.machineId, {
      type: "snapshot",
      terminalId,
      seq: 0,
      data: encoded("fresh"),
    });
    expect(
      f.socket
        .messages()
        .filter(
          (message) =>
            message.type === "terminal_event" ||
            message.type === "terminal_snapshot" ||
            message.type === "terminal_output",
        ),
    ).toEqual([
      {
        type: "terminal_event",
        terminalId,
        kind: "restarted",
        controllerId: f.root.principal.id,
        cwd: "/original",
        fallback: "original",
      },
      // The new process starts a fresh incarnation: no ordinal survives the old byte stream.
      expect.objectContaining({
        type: "terminal_snapshot",
        terminalId,
        viewportId: VIEW,
        deliverySeq: 0,
        seq: 0,
        data: encoded("fresh"),
        geometry: { cols: 80, rows: 24, revision: null },
      }),
      expect.objectContaining({
        type: "terminal_output",
        terminalId,
        deliverySeq: 1,
        seq: 1,
        data: encoded("new"),
      }),
    ]);
    f.store.close();
  });

  test("bounded refusal revokes only the new credential and preserves the original process", async () => {
    const f = brokerFixture();
    const terminalId = f.create.terminalId;
    const pending = f.broker.restartById(
      terminalId,
      f.root.principal.id,
      f.auth.credentialReference(f.root),
    );
    expect(
      await f.broker.restartById(
        terminalId,
        f.root.principal.id,
        f.auth.credentialReference(f.root),
      ),
    ).toBe("restart_pending");
    const command = f.machine.sent.find((message) => message.type === "terminal_restart");
    if (command?.type !== "terminal_restart") throw new Error("missing restart");
    const token = command.create!.env.MANIFOLD_TOKEN!;
    f.broker.onRestartError("another-machine", terminalId, "wrong-owner");
    f.clock.advance(10_000);
    expect(await pending).toBe("restart_timeout");
    expect(() => f.auth.authenticate(token)).toThrow(ServiceError);
    expect(f.auth.authenticate(sessionToken(f.create)).principal.kind).toBe("agent");
    const refused = f.broker.restartById(
      terminalId,
      f.root.principal.id,
      f.auth.credentialReference(f.root),
    );
    f.broker.onRestartError(f.machine.machineId, terminalId, "restart_failed");
    expect(await refused).toBe("restart_failed");
    expect(f.store.getTerminal(terminalId)?.status).toBe("running");
    f.broker.setMachineOnline({
      machineId: f.machine.machineId,
      terminalHostId: null,
      terminalExecution: "unconfined",
      send: (message) => f.machine.send(message),
    });
    f.machine.clear();
    expect(
      await f.broker.restartById(
        terminalId,
        f.root.principal.id,
        f.auth.credentialReference(f.root),
      ),
    ).toBe("unsupported");
    expect(f.machine.sent).toEqual([]);
    f.broker.setMachineOnline(f.machine);
    await f.broker.drain(f.machine.machineId, true);
    expect(
      await f.broker.restartById(
        terminalId,
        f.root.principal.id,
        f.auth.credentialReference(f.root),
      ),
    ).toBe("machine_draining");
    f.store.close();
  });

  test("legacy rows restart as an explicitly reported shell only on unconfined owners", async () => {
    const f = brokerSetup();
    const terminalId = "legacy";
    f.store.createTerminal({
      id: terminalId,
      machineId: f.machine.machineId,
      containerId: f.container.id,
      createdBy: f.root.principal.id,
      agentPrincipalId: null,
      createdAt: 0,
      cwd: "/legacy/work",
    });
    f.store.markTerminalExited(terminalId, null, null);
    const broker = new TerminalBroker(
      f.store,
      f.auth,
      f.rooms,
      f.runtime,
      f.clock,
      silentLogger,
      () => "http://localhost:7777",
      testTileTrees,
    );
    broker.setMachineOnline(f.machine);
    const result = broker.restartById(
      terminalId,
      f.root.principal.id,
      f.auth.credentialReference(f.root),
    );
    const command = f.machine.sent.find((message) => message.type === "terminal_restart");
    expect(command).toMatchObject({
      type: "terminal_restart",
      terminalId,
      noRecipe: true,
      cwd: "/legacy/work",
    });
    if (command?.type !== "terminal_restart") throw new Error("missing restart");
    expect(command.create?.program).toBeUndefined();
    expect(f.auth.authenticate(command.create!.env.MANIFOLD_TOKEN!).containerScope).toBe(
      f.container.id,
    );
    broker.onRestarted(f.machine.machineId, {
      type: "terminal_restarted",
      terminalId,
      cwd: "/legacy/work",
      fallback: "no_recipe",
    });
    expect(await result).toBe("ok");
    broker.setMachineOnline(new FakeMachine(f.machine.machineId, null, "governed"));
    expect(
      await broker.restartById(terminalId, f.root.principal.id, f.auth.credentialReference(f.root)),
    ).toBe("no_recipe");
    f.store.close();
  });
});
