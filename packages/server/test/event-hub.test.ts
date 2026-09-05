import { describe, expect, test } from "bun:test";
import {
  CONNECTION_BODIES,
  ContainerResponseSchema,
  MAX_SUBSCRIPTIONS_PER_CONNECTION,
  PROTOCOL_VERSION,
  PlaceResponseSchema,
  ServerMessageSchema,
  formatManifoldUri,
  topicMatches,
  type Cap,
  type Container,
  type ManifoldRef,
  type ServerEvent,
} from "@manifold/protocol";
import { FLOOR_EVENT_OWNERS } from "../src/assembly.ts";
import { AuthService, type AuthContext } from "../src/auth.ts";
import { silentLogger, type Logger, type LogLevel } from "../src/log.ts";
import { assemblyPlacementVocabulary, assemblyItemNouns, PlaceExecutor } from "../src/placement.ts";
import type { PluginHost } from "../src/plugin-host.ts";
import { RoomManager } from "../src/room.ts";
import { SessionGateway } from "../src/session-ws.ts";
import type { ServerStore } from "../src/stores.ts";
import { TerminalBroker } from "../src/terminal-broker.ts";
import {
  FakeClock,
  FakeRuntime,
  FakeSocket,
  testEventHub,
  testPluginHost,
  testStore,
  testTileTrees,
} from "./helpers.ts";
import type { EventHub } from "../src/event-hub.ts";

/**
 * THE EVENT PLANE, from the socket inwards.
 *
 * These drive the real `SessionGateway` against the real assembly rather than the hub alone,
 * because the properties worth defending are end-to-end ones: that a `subscribe` frame reaches
 * the registry, that an emission at a door reaches the socket, that the frame a client sees
 * validates against the published schema, and that a dead socket takes its interest with it.
 * A hub tested in isolation would prove the Map works and nothing about the plane.
 */

const OWNER_KEY = "e".repeat(64);
const CH = "c1";

interface PlaneFixture {
  readonly runtime: FakeRuntime;
  readonly clock: FakeClock;
  readonly store: ServerStore;
  readonly auth: AuthService;
  readonly owner: AuthContext;
  readonly container: Container;
  readonly other: Container;
  readonly rooms: RoomManager;
  readonly broker: TerminalBroker;
  readonly host: PluginHost;
  readonly events: EventHub;
  readonly gateway: SessionGateway;
  readonly logs: {
    readonly level: LogLevel;
    readonly evt: string;
    readonly fields?: Readonly<Record<string, unknown>>;
  }[];
}

/** Records what the plane said, so a refusal can be asserted as an observable rather than a hole. */
class CaptureLogger implements Logger {
  readonly lines: {
    level: LogLevel;
    evt: string;
    fields?: Readonly<Record<string, unknown>>;
  }[] = [];

  info(evt: string): void {
    this.lines.push({ level: "info", evt });
  }

  warn(evt: string, fields?: Readonly<Record<string, unknown>>): void {
    this.lines.push({ level: "warn", evt, ...(fields === undefined ? {} : { fields }) });
  }

  error(evt: string): void {
    this.lines.push({ level: "error", evt });
  }
}

function newContainer(runtime: FakeRuntime, name: string): Container {
  return { id: runtime.newId(), name, createdAt: runtime.now(), discipline: "canvas" };
}

async function planeFixture(): Promise<PlaneFixture> {
  const runtime = new FakeRuntime();
  const clock = new FakeClock(runtime);
  const store = testStore();
  const auth = new AuthService(store, OWNER_KEY, runtime);
  const owner = auth.authenticate(OWNER_KEY);
  const container = newContainer(runtime, "watched canvas");
  const other = newContainer(runtime, "unwatched canvas");
  store.createContainer(container);
  store.createContainer(other);
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
  broker.setPlacement(
    new PlaceExecutor(
      store,
      rooms,
      broker,
      runtime,
      assemblyPlacementVocabulary(() => host?.roster() ?? []),
      assemblyItemNouns(() => host?.roster() ?? []),
    ),
  );
  const logger = new CaptureLogger();
  // Production wiring order: the plane before the host, reading the assembly through a thunk.
  let host: PluginHost | null = null;
  const events = testEventHub(
    store,
    auth,
    broker,
    () => {
      if (host === null) throw new Error("the event plane read the assembly before the host");
      return host.assembly();
    },
    runtime,
    logger,
  );
  host = await testPluginHost(store, auth, rooms, broker, runtime, { events, logger });
  broker.setEvents(events);
  rooms.setEvents(events);
  const gateway = new SessionGateway(
    auth,
    rooms,
    broker,
    host,
    clock,
    logger,
    runtime,
    events,
  );
  return {
    runtime,
    clock,
    store,
    auth,
    owner,
    container,
    other,
    rooms,
    broker,
    host,
    events,
    gateway,
    logs: logger.lines,
  };
}

/** A minted token, so authority is exercised through real attenuation rather than a literal. */
function context(fixture: PlaneFixture, caps: readonly Cap[], containerId?: string): string {
  const grant = fixture.auth.mintToken(
    {
      principal: { name: "guest", kind: "human" },
      caps: [...caps],
      ...(containerId === undefined ? {} : { containerId }),
    },
    fixture.owner,
  );
  return grant.token;
}

/** Opens a socket and takes its event-plane seat by joining one room. */
function connect(
  fixture: PlaneFixture,
  id: string,
  options: { readonly token?: string; readonly containerId?: string } = {},
): FakeSocket {
  const socket = new FakeSocket();
  fixture.gateway.open(id, socket);
  fixture.gateway.message(
    id,
    JSON.stringify({
      ch: CH,
      type: "join",
      containerId: options.containerId ?? fixture.container.id,
      token: options.token ?? OWNER_KEY,
      protocolVersion: PROTOCOL_VERSION,
    }),
  );
  socket.clear();
  return socket;
}

function subscribe(fixture: PlaneFixture, id: string, topics: readonly ManifoldRef[]): void {
  fixture.gateway.message(id, JSON.stringify({ type: "subscribe", topics }));
}

function unsubscribe(fixture: PlaneFixture, id: string, topics: readonly ManifoldRef[]): void {
  fixture.gateway.message(id, JSON.stringify({ type: "unsubscribe", topics }));
}

/** Every `event` frame a socket received, validated as the wire validates it. */
function eventsOn(socket: FakeSocket): ServerEvent[] {
  const received: ServerEvent[] = [];
  for (const raw of socket.sent) {
    const frame = ServerMessageSchema.parse(JSON.parse(raw));
    if (frame.type === "event") received.push(frame);
  }
  return received;
}

const INDEX_TOPIC: ManifoldRef = { kind: "plugin", pluginId: "core.index" };
/** The placement door's own node: where a commit's workspace-wide half is heard. */
const SPACE_TOPIC: ManifoldRef = { kind: "plugin", pluginId: "core.space" };

describe("event plane subscription authority", () => {
  test("an owner subscribes to a container and hears it; the OTHER container stays silent", async () => {
    const fixture = await planeFixture();
    const socket = connect(fixture, "tab");
    subscribe(fixture, "tab", [{ kind: "container", containerId: fixture.container.id }]);
    expect(fixture.events.held("tab")).toBe(1);

    // A placement into the watched container is a commit at the space door.
    await fixture.host.dispatch(fixture.owner, "core.space.place", {
      ref: { kind: "container", containerId: fixture.other.id },
      destination: { kind: "canvas", containerId: fixture.container.id, x: 10, y: 20 },
    });

    const heard = eventsOn(socket);
    expect(heard.map((event) => event.kind)).toEqual(["item_placed"]);
    expect(heard[0]?.topic).toEqual({ kind: "container", containerId: fixture.container.id });
    expect(heard[0]?.actor).toBe(fixture.owner.principal.id);
    fixture.gateway.shutdown();
    fixture.store.close();
  });

  test("leaf removal announces on the container that held it, once, at the commit", async () => {
    const fixture = await planeFixture();
    /*
      `core.space.removeTile` was a bespoke DELETE route until issue #114, so it had no
      commit point a socket could hear. Now it does, and the property worth pinning is the
      ADDRESS: `tile_removed` is `item_placed`'s mirror, on the composition that lost the
      leaf, because that is the node the write changed.
     */
    const created = await fixture.host.dispatch(fixture.owner, "core.index.createContainer", {
      name: "watched composition",
      discipline: "composition",
    });
    if (!created.ok) throw new Error(`the composition was refused: ${created.denial.message}`);
    const composition = ContainerResponseSchema.parse(created.result).container;
    const placed = await fixture.host.dispatch(fixture.owner, "core.space.place", {
      ref: { kind: "container", containerId: fixture.other.id },
      destination: { kind: "tile", containerId: composition.id, targetTileId: null, edge: null },
    });
    if (!placed.ok) throw new Error(`the leaf was refused: ${placed.denial.message}`);
    const landed = PlaceResponseSchema.parse(placed.result);
    if (landed.op !== "add_tile") throw new Error(`expected add_tile, got ${landed.op}`);

    // Subscribed AFTER the placement, so the only frame in flight is the removal's own.
    const socket = connect(fixture, "tab");
    subscribe(fixture, "tab", [{ kind: "container", containerId: composition.id }]);

    const removed = await fixture.host.dispatch(fixture.owner, "core.space.removeTile", {
      containerId: composition.id,
      tileId: landed.tileId,
    });

    expect(removed).toEqual({ ok: true, result: {} });
    const heard = eventsOn(socket);
    expect(heard.map((event) => event.kind)).toEqual(["tile_removed"]);
    expect(heard[0]?.topic).toEqual({ kind: "container", containerId: composition.id });
    expect(heard[0]?.actor).toBe(fixture.owner.principal.id);
    expect(heard[0]?.payload).toEqual({ tileId: landed.tileId });
    // An emission whose kind no manifest declares is a logged error and no frame, so the
    // frame above is only evidence once nothing was refused on the way out.
    expect(fixture.logs.some((line) => line.evt === "event_undeclared")).toBe(false);
    fixture.gateway.shutdown();
    fixture.store.close();
  });

  test("a container-scoped token is CONFINED: its own container yes, another no, a collection no", async () => {
    const fixture = await planeFixture();
    const token = context(fixture, ["containers:read"], fixture.container.id);
    connect(fixture, "scoped", { token, containerId: fixture.container.id });

    subscribe(fixture, "scoped", [
      { kind: "container", containerId: fixture.container.id },
      // Inside its own container's subtree: an element is addressed THROUGH the container the
      // token holds, so the same grant answers for it.
      { kind: "element", containerId: fixture.container.id, elementId: "el-1" },
      // Outside it.
      { kind: "container", containerId: fixture.other.id },
      // A workspace-scoped collection has no container above it, so it is in nobody's subtree.
      INDEX_TOPIC,
    ]);

    expect(fixture.events.held("scoped")).toBe(2);
    // The refusals are a log line, never a frame: a per-topic answer on the wire would make
    // the plane an oracle for "does this node exist and may I read it".
    expect(fixture.logs.some((line) => line.evt === "session_subscribe_forbidden")).toBe(true);
    fixture.gateway.shutdown();
    fixture.store.close();
  });

  test("a token without containers:read subscribes to nothing at all", async () => {
    const fixture = await planeFixture();
    // `scenes:write` is a real cap and deliberately not the one a subscription needs: the plane
    // reuses the resolve door's `containers:read` and invents no second vocabulary.
    const token = context(fixture, ["scenes:write"], fixture.container.id);
    connect(fixture, "writer", { token, containerId: fixture.container.id });

    subscribe(fixture, "writer", [{ kind: "container", containerId: fixture.container.id }]);

    expect(fixture.events.held("writer")).toBe(0);
    fixture.gateway.shutdown();
    fixture.store.close();
  });

  test("a subscribe before any join is refused by the handshake rule, not by the hub", async () => {
    const fixture = await planeFixture();
    const socket = new FakeSocket();
    fixture.gateway.open("cold", socket);

    subscribe(fixture, "cold", [INDEX_TOPIC]);

    // The credential arrives with `join`, so there is nothing to authorize against yet.
    expect(socket.closed).toEqual({ code: 4002, reason: "first frame must be join" });
    expect(fixture.events.held("cold")).toBe(0);
    fixture.gateway.shutdown();
    fixture.store.close();
  });
});

describe("event plane matching", () => {
  test("a container subscription hears its OWN elements: the grammar's one hop", async () => {
    const fixture = await planeFixture();
    const socket = connect(fixture, "tab");
    subscribe(fixture, "tab", [{ kind: "container", containerId: fixture.container.id }]);

    /*
      An element has no identity outside its container and is ADDRESSED through it, so a
      subscription to the container hears what happens to its leaves. Emitted through the hub
      rather than through a drag, because the subject here is the MATCHING rule: the placement
      algebra's own legality is exercised at length in `placement.test.ts`, and dragging a real
      note into place to prove one hop would put that whole algebra between the test and its
      claim.
     */
    fixture.events.emit(
      "core.space",
      { kind: "element", containerId: fixture.container.id, elementId: "el-1" },
      "item_placed",
      fixture.owner.principal.id,
      { op: "unplace" },
    );

    const heard = eventsOn(socket);
    expect(heard.map((event) => event.topic)).toEqual([
      { kind: "element", containerId: fixture.container.id, elementId: "el-1" },
    ]);
    fixture.gateway.shutdown();
    fixture.store.close();
  });

  test("the fan-out index and `topicMatches` agree over every address form", () => {
    /*
      The hub narrows the registry with a two-key index and lets `topicMatches` decide each
      candidate, so the two must never disagree: an index that missed a key the relation
      accepts would silently drop deliveries. Asserted over the whole cross product of the
      seven forms rather than by inspection, so widening either half without the other fails.
     */
    const refs: ManifoldRef[] = [
      { kind: "terminal", terminalId: "t-1" },
      { kind: "container", containerId: "c-1" },
      { kind: "container", containerId: "c-2" },
      { kind: "element", containerId: "c-1", elementId: "el-1" },
      { kind: "tile", containerId: "c-1", tileId: "ti-1" },
      { kind: "principal", principalId: "p-1" },
      { kind: "plugin", pluginId: "core.index" },
      { kind: "action", actionName: "core.space.place" },
    ];
    for (const topic of refs) {
      // The index's own rule, restated here as the test's independent copy.
      const candidates = new Set(
        topic.kind === "element" || topic.kind === "tile"
          ? [
              formatManifoldUri(topic),
              formatManifoldUri({ kind: "container", containerId: topic.containerId }),
            ]
          : [formatManifoldUri(topic)],
      );
      for (const subscribed of refs) {
        const reachable = candidates.has(formatManifoldUri(subscribed));
        expect({ subscribed, topic, reachable }).toEqual({
          subscribed,
          topic,
          reachable: topicMatches(subscribed, topic),
        });
      }
    }
  });

  test("a terminal is a ROOT: a container subscription does not hear its terminals", async () => {
    const fixture = await planeFixture();
    // Documented deliberately, because it is the one place the plane declines a hop it could
    // have made: a terminal keeps its identity across a rehome, so its container is state
    // rather than address, and a rule needing the store could only be evaluated server-side.
    expect(
      topicMatches(
        { kind: "container", containerId: fixture.container.id },
        { kind: "terminal", terminalId: "t-1" },
      ),
    ).toBe(false);
    fixture.gateway.shutdown();
    fixture.store.close();
  });
});

describe("event plane fan-out", () => {
  test("a slow event subscriber drops overflow without losing its socket or subscriptions", async () => {
    const fixture = await planeFixture();
    try {
      const slow = connect(fixture, "slow");
      const healthy = connect(fixture, "healthy");
      subscribe(fixture, "slow", [SPACE_TOPIC]);
      subscribe(fixture, "healthy", [SPACE_TOPIC]);
      slow.bufferedAmount = 1;

      for (let index = 0; index < 300; index += 1) {
        fixture.events.emit("core.space", SPACE_TOPIC, "item_placed", null, { index });
      }

      expect(slow.closed).toBeNull();
      expect(eventsOn(slow)).toEqual([]);
      expect(fixture.events.held("slow")).toBe(1);
      expect(fixture.logs.filter((line) => line.evt === "socket_backpressure")).toEqual(
        Array.from({ length: 300 - 256 }, () => ({
          level: "warn",
          evt: "socket_backpressure",
          fields: { connectionId: "slow", topic: SPACE_TOPIC },
        })),
      );
      expect(eventsOn(healthy).map((event) => event.payload.index)).toEqual(
        Array.from({ length: 300 }, (_, index) => index),
      );
      expect(healthy.closed).toBeNull();
      const roomFrame = { type: "saved", rev: 7, at: fixture.runtime.now() } as const;
      fixture.rooms.get(fixture.container.id)!.broadcast(roomFrame);
      slow.bufferedAmount = 0;
      fixture.gateway.drain("slow");
      expect(eventsOn(slow).map((event) => event.payload.index)).toEqual(
        Array.from({ length: 256 }, (_, index) => index),
      );
      expect(slow.frames().filter((frame) => frame.type === "saved")).toEqual([
        { ch: CH, ...roomFrame },
      ]);
      slow.clear();
      healthy.clear();
      fixture.events.emit("core.space", SPACE_TOPIC, "item_placed", null, { index: 300 });
      expect(eventsOn(slow).map((event) => event.payload.index)).toEqual([300]);
      expect(eventsOn(healthy).map((event) => event.payload.index)).toEqual([300]);
      expect(slow.closed).toBeNull();
    } finally {
      fixture.gateway.shutdown();
      fixture.store.close();
    }
  });

  test("event buffering counts UTF-8 bytes as well as frames", async () => {
    const fixture = await planeFixture();
    try {
      const socket = connect(fixture, "tab");
      subscribe(fixture, "tab", [SPACE_TOPIC]);
      socket.bufferedAmount = 1;
      // Fewer than 256 frames and fewer than 1 MiB of JS characters, but over 1 MiB
      // on the wire: the same byte bound that protects room traffic must apply.
      for (let index = 0; index < 80; index += 1) {
        fixture.events.emit("core.space", SPACE_TOPIC, "item_placed", null, {
          detail: "é".repeat(8_000),
        });
      }
      expect(socket.closed).toBeNull();
      expect(eventsOn(socket)).toEqual([]);
      expect(fixture.events.held("tab")).toBe(1);
      socket.bufferedAmount = 0;
      fixture.gateway.drain("tab");
      const received = eventsOn(socket);
      const queuedBytes = socket.sent.reduce((sum, frame) => sum + Buffer.byteLength(frame), 0);
      expect(queuedBytes).toBeLessThanOrEqual(1_048_576);
      expect(queuedBytes + Buffer.byteLength(socket.sent[0]!)).toBeGreaterThan(1_048_576);
      expect(fixture.logs.filter((line) => line.evt === "socket_backpressure")).toEqual(
        Array.from({ length: 80 - received.length }, () => ({
          level: "warn",
          evt: "socket_backpressure",
          fields: { connectionId: "tab", topic: SPACE_TOPIC },
        })),
      );
      socket.clear();
      fixture.events.emit("core.space", SPACE_TOPIC, "item_placed", null, { resumed: true });
      expect(eventsOn(socket).map((event) => event.payload)).toEqual([{ resumed: true }]);
      expect(socket.closed).toBeNull();
    } finally {
      fixture.gateway.shutdown();
      fixture.store.close();
    }
  });

  test("queued events drain in order without a room routing tag", async () => {
    const fixture = await planeFixture();
    try {
      const socket = connect(fixture, "tab");
      subscribe(fixture, "tab", [SPACE_TOPIC]);
      socket.bufferedAmount = 1;
      for (let index = 0; index < 3; index += 1) {
        fixture.events.emit("core.space", SPACE_TOPIC, "item_placed", null, { index });
      }
      expect(eventsOn(socket)).toEqual([]);
      socket.bufferedAmount = 0;
      fixture.gateway.drain("tab");
      expect(eventsOn(socket).map((event) => event.payload.index)).toEqual([0, 1, 2]);
      expect(socket.frames().every((frame) => !("ch" in frame))).toBe(true);
      expect(socket.closed).toBeNull();
    } finally {
      fixture.gateway.shutdown();
      fixture.store.close();
    }
  });

  test("two live sockets on one topic each hear it exactly once", async () => {
    const fixture = await planeFixture();
    const first = connect(fixture, "tab-a");
    const second = connect(fixture, "tab-b");
    // The second socket subscribes to the container AND to an element inside it: two matching
    // subscriptions, one socket, and still one frame.
    subscribe(fixture, "tab-a", [INDEX_TOPIC]);
    subscribe(fixture, "tab-b", [INDEX_TOPIC]);

    await fixture.host.dispatch(fixture.owner, "core.index.createContainer", { name: "born" });

    expect(eventsOn(first).map((event) => event.kind)).toEqual(["container_created"]);
    expect(eventsOn(second).map((event) => event.kind)).toEqual(["container_created"]);
    fixture.gateway.shutdown();
    fixture.store.close();
  });

  test("one socket holding two matching subscriptions still hears one frame", async () => {
    const fixture = await planeFixture();
    const socket = connect(fixture, "tab");
    subscribe(fixture, "tab", [
      { kind: "container", containerId: fixture.container.id },
      { kind: "element", containerId: fixture.container.id, elementId: "el-1" },
    ]);

    fixture.events.emit(
      "core.space",
      { kind: "element", containerId: fixture.container.id, elementId: "el-1" },
      "item_placed",
      fixture.owner.principal.id,
      { op: "unplace" },
    );

    // Both subscriptions match, and the audience is a set of SOCKETS rather than of
    // subscriptions — so the fan-out cannot multiply one fact by how closely a client watches.
    expect(eventsOn(socket)).toHaveLength(1);
    fixture.gateway.shutdown();
    fixture.store.close();
  });

  test("a node-addressed commit also reaches its door's COLLECTION, once and with one row", async () => {
    const fixture = await planeFixture();
    const room = connect(fixture, "room");
    const workspace = connect(fixture, "workspace");
    subscribe(fixture, "room", [{ kind: "container", containerId: fixture.container.id }]);
    subscribe(fixture, "workspace", [SPACE_TOPIC]);

    /*
      THE REGRESSION THIS PINS. A placement is addressed to the destination container, and the
      readings it moves — the index and both terminal rosters — are taken from chrome OUTSIDE
      every room they report on: `unplaced` is derived from the containment graph, and a
      placement births compositions whose ids no subscriber could have named in advance. Once
      those feeds traded their cadence for a subscription (ADR 0012 §6) a room-addressed frame
      was the ONLY notice they would ever get, and it is one they cannot hear — the index
      simply stopped resurfacing unplaced terminals. So the fan-out delivers every emission to
      its door's own node as well, and `manifold://plugin/<owner>` means what the feeds already
      assume: everything that plugin's doors announced.
     */
    await fixture.host.dispatch(fixture.owner, "core.space.place", {
      ref: { kind: "container", containerId: fixture.other.id },
      destination: { kind: "canvas", containerId: fixture.container.id, x: 10, y: 20 },
    });

    const inRoom = eventsOn(room);
    const outside = eventsOn(workspace);
    expect(inRoom.map((event) => event.topic)).toEqual([
      { kind: "container", containerId: fixture.container.id },
    ]);
    // Delivered under the address that REACHED it, so the SDK's own copy of `topicMatches`
    // routes the frame to the subscription that asked for it.
    expect(outside.map((event) => event.topic)).toEqual([SPACE_TOPIC]);
    expect(outside.map((event) => event.kind)).toEqual(["item_placed"]);
    // A second audience is not a second event: the trail records the fact, not its reach.
    expect(fixture.store.listEvents({ type: "item_placed", limit: 10 })).toHaveLength(1);
    fixture.gateway.shutdown();
    fixture.store.close();
  });

  test("holding a node AND its door's collection is still one frame, at the node", async () => {
    const fixture = await planeFixture();
    const socket = connect(fixture, "tab");
    subscribe(fixture, "tab", [
      { kind: "container", containerId: fixture.container.id },
      SPACE_TOPIC,
    ]);

    await fixture.host.dispatch(fixture.owner, "core.space.place", {
      ref: { kind: "container", containerId: fixture.other.id },
      destination: { kind: "canvas", containerId: fixture.container.id, x: 1, y: 2 },
    });

    // The audience is a set of SOCKETS across BOTH addresses, and the node the emission named
    // is offered first — so watching a room and its door's collection cannot double a commit.
    const heard = eventsOn(socket);
    expect(heard.map((event) => event.topic)).toEqual([
      { kind: "container", containerId: fixture.container.id },
    ]);
    fixture.gateway.shutdown();
    fixture.store.close();
  });

  test("a refused action publishes NOTHING, however much its handler staged", async () => {
    const fixture = await planeFixture();
    const socket = connect(fixture, "tab");
    subscribe(fixture, "tab", [INDEX_TOPIC]);

    // Renaming a container that does not exist is a refusal from the door, and a refusal is
    // not an event: the staging buffer is discarded rather than flushed.
    const outcome = await fixture.host.dispatch(fixture.owner, "core.index.renameContainer", {
      containerId: "c-missing",
      name: "ghost",
    });

    expect(outcome.ok).toBe(false);
    expect(eventsOn(socket)).toEqual([]);
    // And nothing reached the durable trail either, which is the same claim read from the
    // other side: history and fan-out are one call.
    expect(fixture.store.listEvents({ type: "container_renamed", limit: 10 })).toEqual([]);
    fixture.gateway.shutdown();
    fixture.store.close();
  });

  test("ONE COMMIT, ONE EVENT: a drag that commits once produces exactly one row and one frame", async () => {
    const fixture = await planeFixture();
    const socket = connect(fixture, "tab");
    subscribe(fixture, "tab", [{ kind: "container", containerId: fixture.container.id }]);

    /*
      A divider drag or a canvas drag paints per frame and commits ONCE, as one
      `core.space.place` — the plane rule's commit point (D6). The server-side guarantee this
      pins is the other half: one dispatch flushes the staging buffer exactly once, so a
      gesture cannot become a stream however many frames the client painted.
     */
    await fixture.host.dispatch(fixture.owner, "core.space.place", {
      ref: { kind: "container", containerId: fixture.other.id },
      destination: { kind: "canvas", containerId: fixture.container.id, x: 1, y: 2 },
    });

    expect(eventsOn(socket)).toHaveLength(1);
    expect(fixture.store.listEvents({ type: "item_placed", limit: 10 })).toHaveLength(1);
    fixture.gateway.shutdown();
    fixture.store.close();
  });

  test("an emission whose kind its emitter never declared is refused, loudly and totally", async () => {
    const fixture = await planeFixture();
    const socket = connect(fixture, "tab");
    subscribe(fixture, "tab", [INDEX_TOPIC]);

    fixture.events.emit("core.index", INDEX_TOPIC, "container_invented", null, {});

    expect(eventsOn(socket)).toEqual([]);
    expect(fixture.store.listEvents({ type: "container_invented", limit: 10 })).toEqual([]);
    expect(fixture.logs.some((line) => line.evt === "event_undeclared")).toBe(true);
    fixture.gateway.shutdown();
    fixture.store.close();
  });

  test("a plugin may not emit on another plugin's node", async () => {
    const fixture = await planeFixture();
    const socket = connect(fixture, "tab");
    subscribe(fixture, "tab", [{ kind: "plugin", pluginId: FLOOR_EVENT_OWNERS.machines }]);

    // `container_created` is core.index's kind and core.machines' node is not its to address.
    fixture.events.emit(
      "core.index",
      { kind: "plugin", pluginId: FLOOR_EVENT_OWNERS.machines },
      "container_created",
      null,
      {},
    );

    expect(eventsOn(socket)).toEqual([]);
    expect(fixture.logs.some((line) => line.evt === "event_undeclared")).toBe(true);
    fixture.gateway.shutdown();
    fixture.store.close();
  });
});

describe("event plane lifetime", () => {
  test("unsubscribe stops delivery and leaves the socket alive", async () => {
    const fixture = await planeFixture();
    const socket = connect(fixture, "tab");
    subscribe(fixture, "tab", [INDEX_TOPIC]);
    unsubscribe(fixture, "tab", [INDEX_TOPIC]);

    expect(fixture.events.held("tab")).toBe(0);
    await fixture.host.dispatch(fixture.owner, "core.index.createContainer", { name: "born" });

    expect(eventsOn(socket)).toEqual([]);
    expect(socket.closed).toBeNull();
    fixture.gateway.shutdown();
    fixture.store.close();
  });

  test("unsubscribing from a topic never held is a no-op, not an error", async () => {
    const fixture = await planeFixture();
    const socket = connect(fixture, "tab");

    unsubscribe(fixture, "tab", [INDEX_TOPIC]);

    // Presence-class state has no transaction to violate, and a client tearing down a panel it
    // is no longer sure it registered must not have to remember.
    expect(socket.closed).toBeNull();
    expect(fixture.events.held("tab")).toBe(0);
    fixture.gateway.shutdown();
    fixture.store.close();
  });

  test("SOCKET DEATH takes every subscription with it: nothing is persisted, nothing resumes", async () => {
    const fixture = await planeFixture();
    const socket = connect(fixture, "tab");
    subscribe(fixture, "tab", [INDEX_TOPIC]);
    expect(fixture.events.held("tab")).toBe(1);

    fixture.gateway.close("tab");

    expect(fixture.events.held("tab")).toBe(0);
    socket.clear();
    await fixture.host.dispatch(fixture.owner, "core.index.createContainer", { name: "born" });
    // A reconnect re-declares its interest from scratch; there is no replay and no backlog,
    // so a dead socket's topics cannot come back to life on a new one.
    expect(eventsOn(socket)).toEqual([]);
    fixture.gateway.shutdown();
    fixture.store.close();
  });

  test("past the per-connection bound the excess is dropped and named, and the socket lives", async () => {
    const fixture = await planeFixture();
    const socket = connect(fixture, "tab");

    // 64 topics per frame is the wire's bound, so filling 256 takes four frames plus one more
    // that has nowhere to go.
    for (let batch = 0; batch * 64 < MAX_SUBSCRIPTIONS_PER_CONNECTION + 64; batch += 1) {
      const topics: ManifoldRef[] = [];
      for (let index = 0; index < 64; index += 1) {
        topics.push({ kind: "principal", principalId: `p-${String(batch * 64 + index)}` });
      }
      subscribe(fixture, "tab", topics);
    }

    expect(fixture.events.held("tab")).toBe(MAX_SUBSCRIPTIONS_PER_CONNECTION);
    expect(fixture.logs.some((line) => line.evt === "session_subscription_limit")).toBe(true);
    // Closing a whole tab because one panel over-subscribed is the blast radius multiplexing
    // exists to remove.
    expect(socket.closed).toBeNull();
    fixture.gateway.shutdown();
    fixture.store.close();
  });
});

describe("event frame shape", () => {
  test("the frame validates as the published connection-level body, with no channel tag", async () => {
    const fixture = await planeFixture();
    const socket = connect(fixture, "tab");
    subscribe(fixture, "tab", [INDEX_TOPIC]);

    await fixture.host.dispatch(fixture.owner, "core.index.createContainer", { name: "born" });

    const raw = socket.sent.map((line) => JSON.parse(line) as Record<string, unknown>);
    const frame = raw.find((body) => body["type"] === "event");
    expect(frame).toBeDefined();
    // A topic is a NODE, so an event routinely names something no channel on this socket
    // joined; tagging it with one room's channel would be an id pun.
    expect(frame === undefined ? true : "ch" in frame).toBe(false);
    const parsed = CONNECTION_BODIES.event.parse(frame);
    expect(parsed.kind).toBe("container_created");
    expect(parsed.topic).toEqual(INDEX_TOPIC);
    expect(parsed.at).toBe(fixture.runtime.now());
    expect(parsed.actor).toBe(fixture.owner.principal.id);
    expect(typeof parsed.payload["containerId"]).toBe("string");
    fixture.gateway.shutdown();
    fixture.store.close();
  });
});

describe("floor doors emit at their commit points", () => {
  test("attendance: a principal joining a room reaches a collection subscriber once per arrival", async () => {
    const fixture = await planeFixture();
    const watcher = connect(fixture, "watcher");
    subscribe(fixture, "watcher", [{ kind: "plugin", pluginId: FLOOR_EVENT_OWNERS.attendance }]);
    watcher.clear();

    // A DIFFERENT principal from the watcher's, because attendance is per principal: the
    // watcher's own join already registered its principal in this room.
    const guest = context(fixture, ["containers:read"]);
    connect(fixture, "arriving", { token: guest });
    // A second tab on the same principal is not a second arrival, which is the same gate the
    // durable row has always used.
    connect(fixture, "arriving-twin", { token: guest });

    const heard = eventsOn(watcher);
    expect(heard.map((event) => event.kind)).toEqual(["principal_joined"]);
    expect(heard[0]?.payload["containerId"]).toBe(fixture.container.id);
    fixture.gateway.shutdown();
    fixture.store.close();
  });

  test("machines: an online transition fires once, and a superseded socket is not a new arrival", async () => {
    const fixture = await planeFixture();
    const socket = connect(fixture, "tab");
    subscribe(fixture, "tab", [{ kind: "plugin", pluginId: FLOOR_EVENT_OWNERS.machines }]);
    const enrollment = fixture.auth.enrollMachine("builder", fixture.owner);

    const first = {
      machineId: enrollment.machine.id,
      protocolVersion: PROTOCOL_VERSION,
      terminalHostId: null,
      send: () => true,
    };
    const second = {
      machineId: enrollment.machine.id,
      protocolVersion: PROTOCOL_VERSION,
      terminalHostId: null,
      send: () => true,
    };
    fixture.broker.setMachineOnline(first);
    // A machine reconnecting supersedes its own socket without ever having gone offline.
    fixture.broker.setMachineOnline(second);
    fixture.broker.setMachineOffline(second);

    expect(eventsOn(socket).map((event) => event.kind)).toEqual([
      "machine_online",
      "machine_offline",
    ]);
    fixture.gateway.shutdown();
    fixture.store.close();
  });

  test("terminal lifecycle keeps its audit trail scoped to the container it happened in", async () => {
    const fixture = await planeFixture();
    const socket = connect(fixture, "tab");
    subscribe(fixture, "tab", [{ kind: "plugin", pluginId: FLOOR_EVENT_OWNERS.terminals }]);
    fixture.store.createTerminal({
      id: "t-1",
      machineId: "m-1",
      containerId: fixture.container.id,
      createdBy: fixture.owner.principal.id,
      agentPrincipalId: "",
      createdAt: fixture.runtime.now(),
    });
    const reloaded = new TerminalBroker(
      fixture.store,
      fixture.auth,
      fixture.rooms,
      fixture.runtime,
      fixture.clock,
      silentLogger,
      () => "http://localhost:7777",
      testTileTrees,
    );
    reloaded.setEvents(fixture.events);

    expect(reloaded.rename("t-1", "renamed")).toBe("ok");

    // The TOPIC is the collection — the terminal index watches from outside every room — while
    // the audit TRAIL still lands under the container, so `core.events.list({ containerId })`
    // answers exactly what it answered before the plane existed.
    const heard = eventsOn(socket);
    expect(heard.map((event) => event.kind)).toEqual(["terminal_renamed"]);
    expect(heard[0]?.topic).toEqual({ kind: "plugin", pluginId: FLOOR_EVENT_OWNERS.terminals });
    const trail = fixture.store.listEvents({
      containerId: fixture.container.id,
      type: "terminal_renamed",
      limit: 10,
    });
    expect(trail).toHaveLength(1);
    fixture.gateway.shutdown();
    fixture.store.close();
  });

  test("plugin enablement announces on the engine's own ledger node", async () => {
    const fixture = await planeFixture();
    const socket = connect(fixture, "tab");
    subscribe(fixture, "tab", [{ kind: "plugin", pluginId: "engine.plugins" }]);

    const outcome = await fixture.host.dispatch(fixture.owner, "engine.plugins.setEnabled", {
      id: "core.draw",
      enabled: false,
    });
    expect(outcome.ok).toBe(true);

    const heard = eventsOn(socket);
    expect(heard.map((event) => event.kind)).toEqual(["plugin_disabled"]);
    // The toggled plugin is the PAYLOAD, not the topic: a plugin may not be the subject of
    // another plugin's emission, and enablement is the engine's ledger about it.
    expect(heard[0]?.payload["plugin"]).toBe("core.draw");
    fixture.gateway.shutdown();
    fixture.store.close();
  });
});
