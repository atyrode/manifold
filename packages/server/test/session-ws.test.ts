import { describe, expect, test } from "bun:test";
import {
  CHANNEL_LIMIT_CLOSE_CODE,
  CURSOR_MIN_INTERVAL_MS,
  DIAL_PING_INTERVAL_MS,
  MAX_SESSION_CHANNELS_PER_CONNECTION,
  PROTOCOL_VERSION,
  type Container,
} from "@manifold/protocol";
import { LOCAL_ORIGIN, Y, createSceneDoc, encodeUpdate, writeElement } from "@manifold/scene";
import { AuthService } from "../src/auth.ts";
import type { EventHub } from "../src/event-hub.ts";
import { silentLogger } from "../src/log.ts";
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

/** Tests that are not about routing drive one channel per socket, exactly as v11 did. */
const CH = "c1";

interface GatewayFixture {
  readonly runtime: FakeRuntime;
  readonly clock: FakeClock;
  readonly store: ServerStore;
  readonly ownerKey: string;
  readonly auth: AuthService;
  readonly container: Container;
  /** Creates one more container so a socket can carry two rooms at once. */
  readonly secondContainer: (name: string) => Container;
  readonly rooms: RoomManager;
  readonly gateway: SessionGateway;
  readonly events: EventHub;
}

async function gatewayFixture(): Promise<GatewayFixture> {
  const runtime = new FakeRuntime();
  const clock = new FakeClock(runtime);
  const store = testStore();
  const ownerKey = "e".repeat(64);
  const auth = new AuthService(store, ownerKey, runtime);
  const container: Container = {
    id: runtime.newId(),
    name: "sync container",
    createdAt: runtime.now(),
    discipline: "canvas",
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
  /*
    The plane, built the way `main.ts` builds it: BEFORE the host, reading the assembly through
    a thunk, then installed on the two floor doors. The fixture owns the hub because the
    subscription tests drive it directly.
   */
  let plugins: PluginHost | null = null;
  const events = testEventHub(
    store,
    auth,
    broker,
    () => {
      if (plugins === null) throw new Error("the event plane read the assembly before the host");
      return plugins.assembly();
    },
    runtime,
  );
  plugins = await testPluginHost(store, auth, rooms, broker, runtime, { events });
  broker.setEvents(events);
  rooms.setEvents(events);
  const gateway = new SessionGateway(
    auth,
    rooms,
    broker,
    plugins,
    clock,
    silentLogger,
    runtime,
    events,
  );
  const secondContainer = (name: string): Container => {
    const created: Container = {
      id: runtime.newId(),
      name,
      createdAt: runtime.now(),
      discipline: "canvas",
    };
    store.createContainer(created);
    return created;
  };
  return {
    runtime,
    clock,
    store,
    ownerKey,
    auth,
    container,
    secondContainer,
    rooms,
    gateway,
    events,
  };
}

/** Sends one channel-tagged client frame. */
function send(
  gateway: SessionGateway,
  id: string,
  ch: string,
  body: Record<string, unknown>,
): void {
  gateway.message(id, JSON.stringify({ ch, ...body }));
}

interface JoinOptions {
  readonly ch?: string;
  readonly containerId?: string;
  readonly token?: string;
  readonly spectator?: boolean;
}

/** Joins one channel on an already-open socket, without the `open` handshake. */
function joinChannel(
  fixture: GatewayFixture,
  id: string,
  socket: FakeSocket,
  options: JoinOptions = {},
): string {
  const ch = options.ch ?? CH;
  send(fixture.gateway, id, ch, {
    type: "join",
    containerId: options.containerId ?? fixture.container.id,
    token: options.token ?? fixture.ownerKey,
    protocolVersion: PROTOCOL_VERSION,
    ...(options.spectator === true ? { spectator: true } : {}),
  });
  // A second channel into the same room also hears that room's attendance deltas, so the
  // init this join earned is found by its channel id, not by frame order.
  const init = socket.frames().findLast((frame) => frame.type === "init" && frame.ch === ch);
  expect(init).toBeDefined();
  return ch;
}

function join(
  gateway: SessionGateway,
  id: string,
  socket: FakeSocket,
  containerId: string,
  token: string,
): void {
  gateway.open(id, socket);
  send(gateway, id, CH, { type: "join", containerId, token, protocolVersion: PROTOCOL_VERSION });
  // The plugin roster comes first and belongs to the SOCKET: a connection learns the workspace's
  // vocabulary before it carries any room, so the join's `init` is the second frame.
  expect(socket.messages().map((message) => message.type)).toEqual(["plugins", "init"]);
  socket.clear();
}

/** Joins the read-only channel a portal's live preview opens. */
function joinSpectator(
  gateway: SessionGateway,
  id: string,
  socket: FakeSocket,
  containerId: string,
  token: string,
): void {
  gateway.open(id, socket);
  send(gateway, id, CH, {
    type: "join",
    containerId,
    token,
    protocolVersion: PROTOCOL_VERSION,
    spectator: true,
  });
  expect(socket.messages().map((message) => message.type)).toEqual(["plugins", "init"]);
  socket.clear();
}

/**
 * One Yjs update authoring a single canvas element, as a client would send it. A portal is
 * the reference discipline a canvas uses for anything that lives elsewhere, and these tests
 * are about the transport, not about what is on the far side of it.
 */
function docUpdateFor(elementId: string): string {
  const doc = createSceneDoc();
  writeElement(
    doc,
    {
      id: elementId,
      type: "portal",
      containerId: `container-${elementId}`,
      x: 0,
      y: 0,
      width: 720,
      height: 480,
      zIndex: 0,
    },
    LOCAL_ORIGIN,
  );
  return encodeUpdate(Y.encodeStateAsUpdate(doc));
}

describe("SessionGateway high-rate request cadence", () => {
  test("resync floods produce at most one authoritative frame per second", async () => {
    const fixture = await gatewayFixture();
    const socket = new FakeSocket();
    join(fixture.gateway, "peer", socket, fixture.container.id, fixture.ownerKey);

    for (let index = 0; index < 20; index += 1) {
      send(fixture.gateway, "peer", CH, { type: "resync_request" });
    }
    expect(socket.messages().filter((message) => message.type === "resync")).toHaveLength(1);

    fixture.clock.advance(999);
    send(fixture.gateway, "peer", CH, { type: "resync_request" });
    expect(socket.messages().filter((message) => message.type === "resync")).toHaveLength(1);
    fixture.clock.advance(1);
    send(fixture.gateway, "peer", CH, { type: "resync_request" });
    expect(socket.messages().filter((message) => message.type === "resync")).toHaveLength(2);
    fixture.gateway.shutdown();
    fixture.store.close();
  });

  test("a rapid second resync request is served once at the cadence boundary", async () => {
    const fixture = await gatewayFixture();
    const socket = new FakeSocket();
    join(fixture.gateway, "peer", socket, fixture.container.id, fixture.ownerKey);
    /*
      Every joined socket arms a liveness watchdog (issue #55), so the cadence assertions in
      this file count what a room's THROTTLES arm beyond that baseline rather than counting
      the clock's whole job table.
     */
    const armed = fixture.clock.pendingJobs;

    send(fixture.gateway, "peer", CH, { type: "resync_request" });
    send(fixture.gateway, "peer", CH, { type: "resync_request" });
    send(fixture.gateway, "peer", CH, { type: "resync_request" });

    expect(socket.messages().filter((message) => message.type === "resync")).toHaveLength(1);
    expect(fixture.clock.pendingJobs).toBe(armed + 1);
    fixture.clock.advance(999);
    expect(socket.messages().filter((message) => message.type === "resync")).toHaveLength(1);
    fixture.clock.advance(1);
    expect(socket.messages().filter((message) => message.type === "resync")).toHaveLength(2);
    expect(fixture.clock.pendingJobs).toBe(armed);

    fixture.gateway.shutdown();
    fixture.store.close();
  });

  test("rapid cursors coalesce to one trailing frame with the latest coordinates", async () => {
    const fixture = await gatewayFixture();
    const first = new FakeSocket();
    const second = new FakeSocket();
    join(fixture.gateway, "first", first, fixture.container.id, fixture.ownerKey);
    join(fixture.gateway, "second", second, fixture.container.id, fixture.ownerKey);
    const armed = fixture.clock.pendingJobs; // the joined sockets' liveness watchdogs

    send(fixture.gateway, "first", CH, { type: "cursor", x: 1, y: 1 });
    first.clear();
    second.clear();
    fixture.clock.advance(10);
    for (const coordinate of [2, 3, 4]) {
      send(fixture.gateway, "first", CH, { type: "cursor", x: coordinate, y: coordinate });
    }

    expect(fixture.clock.pendingJobs).toBe(armed + 1);
    expect(second.messages().filter((message) => message.type === "cursor")).toEqual([]);
    fixture.clock.advance(CURSOR_MIN_INTERVAL_MS - 10 - 1);
    expect(second.messages().filter((message) => message.type === "cursor")).toEqual([]);
    fixture.clock.advance(1);

    const cursors = second.messages().filter((message) => message.type === "cursor");
    expect(cursors).toHaveLength(1);
    expect(cursors.map((message) => [message.x, message.y])).toEqual([[4, 4]]);
    expect(fixture.clock.pendingJobs).toBe(armed);
    fixture.gateway.shutdown();
    fixture.store.close();
  });

  test("closing a connection cancels its pending cursor flush", async () => {
    const fixture = await gatewayFixture();
    const first = new FakeSocket();
    const second = new FakeSocket();
    join(fixture.gateway, "first", first, fixture.container.id, fixture.ownerKey);
    join(fixture.gateway, "second", second, fixture.container.id, fixture.ownerKey);
    const armed = fixture.clock.pendingJobs; // the joined sockets' liveness watchdogs
    send(fixture.gateway, "first", CH, { type: "cursor", x: 1, y: 1 });
    second.clear();
    fixture.clock.advance(10);
    send(fixture.gateway, "first", CH, { type: "cursor", x: 9, y: 9 });
    expect(fixture.clock.pendingJobs).toBe(armed + 1);

    fixture.gateway.close("first");
    // Its flush AND its watchdog are gone; the surviving socket keeps its own.
    expect(fixture.clock.pendingJobs).toBe(armed - 1);
    fixture.clock.advance(30);
    expect(second.messages().filter((message) => message.type === "cursor")).toEqual([]);
    fixture.gateway.shutdown();
    fixture.store.close();
  });
});

describe("SessionGateway connection identity", () => {
  test("same-principal peers receive distinct init ids and each other's stamped cursors", async () => {
    const fixture = await gatewayFixture();
    const first = new FakeSocket();
    const second = new FakeSocket();

    fixture.gateway.open("first", first);
    joinChannel(fixture, "first", first);
    fixture.gateway.open("second", second);
    joinChannel(fixture, "second", second);

    const firstInit = first.messages().find((message) => message.type === "init");
    const secondInit = second.messages().find((message) => message.type === "init");
    const firstConnId = firstInit?.type === "init" ? firstInit.selfConnId : null;
    const secondConnId = secondInit?.type === "init" ? secondInit.selfConnId : null;
    expect(firstConnId).not.toBeNull();
    expect(secondConnId).not.toBeNull();
    expect(firstConnId).not.toBe(secondConnId);

    first.clear();
    second.clear();
    send(fixture.gateway, "first", CH, { type: "cursor", x: 1, y: 2 });
    send(fixture.gateway, "second", CH, { type: "cursor", x: 3, y: 4 });

    expect(
      first
        .messages()
        .find((message) => message.type === "cursor" && message.connId === secondConnId),
    ).toMatchObject({
      type: "cursor",
      connId: secondConnId,
      x: 3,
      y: 4,
    });
    expect(
      second
        .messages()
        .find((message) => message.type === "cursor" && message.connId === firstConnId),
    ).toMatchObject({
      type: "cursor",
      connId: firstConnId,
      x: 1,
      y: 2,
    });
    fixture.gateway.shutdown();
    fixture.store.close();
  });
});

describe("SessionGateway channel multiplexing", () => {
  test("two channels on one socket carry two rooms' documents independently", async () => {
    const fixture = await gatewayFixture();
    const other = fixture.secondContainer("other container");
    const socket = new FakeSocket();
    fixture.gateway.open("tab", socket);
    joinChannel(fixture, "tab", socket, { ch: "a" });
    joinChannel(fixture, "tab", socket, { ch: "b", containerId: other.id });
    socket.clear();

    send(fixture.gateway, "tab", "a", { type: "doc_update", update: docUpdateFor("in-a") });
    send(fixture.gateway, "tab", "b", { type: "doc_update", update: docUpdateFor("in-b") });

    // Each write landed in exactly the room its channel names.
    expect(fixture.rooms.live(fixture.container.id)?.element("in-a")).toMatchObject({ id: "in-a" });
    expect(fixture.rooms.live(fixture.container.id)?.element("in-b")).toBeNull();
    expect(fixture.rooms.live(other.id)?.element("in-b")).toMatchObject({ id: "in-b" });
    expect(fixture.rooms.live(other.id)?.element("in-a")).toBeNull();

    // And each fan-out came back tagged with the channel that owns it.
    const routed = socket
      .frames()
      .filter((frame) => frame.type === "doc_update")
      .map((frame) => (frame.type === "doc_update" ? frame.ch : null));
    expect(routed).toEqual(["a", "b"]);

    fixture.gateway.shutdown();
    fixture.store.close();
  });

  test("presence and attendance stay per channel: one socket, two memberships", async () => {
    const fixture = await gatewayFixture();
    const other = fixture.secondContainer("other container");
    const socket = new FakeSocket();
    const witnessA = new FakeSocket();
    const witnessB = new FakeSocket();
    join(fixture.gateway, "witness-a", witnessA, fixture.container.id, fixture.ownerKey);
    join(fixture.gateway, "witness-b", witnessB, other.id, fixture.ownerKey);
    fixture.gateway.open("tab", socket);
    joinChannel(fixture, "tab", socket, { ch: "a" });
    joinChannel(fixture, "tab", socket, { ch: "b", containerId: other.id });
    witnessA.clear();
    witnessB.clear();

    send(fixture.gateway, "tab", "a", { type: "presence", payload: { status: "working" } });

    expect(witnessA.messages()).toEqual([
      expect.objectContaining({ type: "presence", payload: { status: "working" } }),
    ]);
    // The other room heard nothing: presence belongs to a membership, not to a socket.
    expect(witnessB.messages()).toEqual([]);

    fixture.gateway.shutdown();
    fixture.store.close();
  });

  test("role is per channel: one socket occupies one room and only watches another", async () => {
    const fixture = await gatewayFixture();
    const other = fixture.secondContainer("watched container");
    const socket = new FakeSocket();
    fixture.gateway.open("tab", socket);
    joinChannel(fixture, "tab", socket, { ch: "live" });
    joinChannel(fixture, "tab", socket, { ch: "preview", containerId: other.id, spectator: true });
    socket.clear();

    // The watching channel writes nothing, so the watched room has no occupants.
    send(fixture.gateway, "tab", "preview", { type: "cursor", x: 1, y: 1 });
    expect(socket.frames()).toEqual([
      expect.objectContaining({
        type: "error",
        ch: "preview",
        message: "spectator sockets are read-only",
      }),
    ]);
    expect(fixture.rooms.presence().map((entry) => entry.containerId)).toEqual([
      fixture.container.id,
    ]);

    // The occupying channel on the SAME socket keeps full write authority.
    socket.clear();
    send(fixture.gateway, "tab", "live", { type: "doc_update", update: docUpdateFor("written") });
    expect(fixture.rooms.live(fixture.container.id)?.element("written")).toMatchObject({
      id: "written",
    });

    fixture.gateway.shutdown();
    fixture.store.close();
  });

  test("one channel leaving never disturbs the other, and an empty socket must rejoin", async () => {
    const fixture = await gatewayFixture();
    const other = fixture.secondContainer("other container");
    const socket = new FakeSocket();
    const witness = new FakeSocket();
    join(fixture.gateway, "witness", witness, other.id, fixture.ownerKey);
    fixture.gateway.open("tab", socket);
    joinChannel(fixture, "tab", socket, { ch: "a" });
    joinChannel(fixture, "tab", socket, { ch: "b", containerId: other.id });

    send(fixture.gateway, "tab", "a", { type: "leave" });

    // The left room lost its only membership, so it stops being resident entirely; the
    // socket and its other channel live on.
    expect(fixture.rooms.live(fixture.container.id)).toBeNull();
    expect(socket.closed).toBeNull();
    witness.clear();
    socket.clear();
    send(fixture.gateway, "tab", "b", { type: "presence", payload: { status: "working" } });
    expect(witness.messages()).toEqual([
      expect.objectContaining({ type: "presence", payload: { status: "working" } }),
    ]);

    // Frames for a retired channel are dropped, not fatal: they race the server's own
    // channel teardown, and killing the socket would take healthy rooms with it.
    socket.clear();
    send(fixture.gateway, "tab", "a", { type: "cursor", x: 5, y: 5 });
    expect(socket.frames()).toEqual([]);
    expect(socket.closed).toBeNull();

    // A socket carrying no rooms is closed exactly like one that never joined.
    send(fixture.gateway, "tab", "b", { type: "leave" });
    fixture.clock.advance(10_000);
    expect(socket.closed).toEqual({ code: 4002, reason: "join timeout" });

    fixture.gateway.shutdown();
    fixture.store.close();
  });

  test("the channel cap refuses one channel, never the connection", async () => {
    const fixture = await gatewayFixture();
    const socket = new FakeSocket();
    fixture.gateway.open("tab", socket);
    for (let index = 0; index < MAX_SESSION_CHANNELS_PER_CONNECTION; index += 1) {
      joinChannel(fixture, "tab", socket, { ch: `c${index}` });
      // This join's frames have been validated; do not re-decode their growing history.
      socket.clear();
    }

    send(fixture.gateway, "tab", "overflow", {
      type: "join",
      containerId: fixture.container.id,
      token: fixture.ownerKey,
      protocolVersion: PROTOCOL_VERSION,
    });
    const refusal = socket.frames().at(-1);
    expect(refusal).toEqual({
      type: "channel_closed",
      ch: "overflow",
      code: CHANNEL_LIMIT_CLOSE_CODE,
      reason: "channel limit reached",
    });
    expect(socket.closed).toBeNull();

    // The channels already carried by this socket are untouched.
    socket.clear();
    send(fixture.gateway, "tab", "c0", { type: "resync_request" });
    expect(socket.frames()).toEqual([expect.objectContaining({ type: "resync", ch: "c0" })]);

    fixture.gateway.shutdown();
    fixture.store.close();
  });

  test("a duplicate channel id is a client bug and closes the socket", async () => {
    const fixture = await gatewayFixture();
    const socket = new FakeSocket();
    fixture.gateway.open("tab", socket);
    joinChannel(fixture, "tab", socket, { ch: "a" });
    send(fixture.gateway, "tab", "a", {
      type: "join",
      containerId: fixture.container.id,
      token: fixture.ownerKey,
      protocolVersion: PROTOCOL_VERSION,
    });
    expect(socket.closed).toEqual({ code: 4002, reason: "duplicate join" });

    fixture.gateway.shutdown();
    fixture.store.close();
  });

  test("an unknown container refuses its channel; the socket keeps its other rooms", async () => {
    const fixture = await gatewayFixture();
    const socket = new FakeSocket();
    fixture.gateway.open("tab", socket);
    joinChannel(fixture, "tab", socket, { ch: "a" });
    socket.clear();

    send(fixture.gateway, "tab", "gone", {
      type: "join",
      containerId: "no-such-container",
      token: fixture.ownerKey,
      protocolVersion: PROTOCOL_VERSION,
    });

    expect(socket.frames()).toEqual([
      { type: "channel_closed", ch: "gone", code: 4404, reason: "container not found" },
    ]);
    expect(socket.closed).toBeNull();
    socket.clear();
    send(fixture.gateway, "tab", "a", { type: "resync_request" });
    expect(socket.frames().at(-1)?.type).toBe("resync");

    fixture.gateway.shutdown();
    fixture.store.close();
  });

  test("a stale protocol version still closes the whole socket", async () => {
    const fixture = await gatewayFixture();
    const socket = new FakeSocket();
    fixture.gateway.open("tab", socket);
    send(fixture.gateway, "tab", "a", {
      type: "join",
      containerId: fixture.container.id,
      token: fixture.ownerKey,
      protocolVersion: PROTOCOL_VERSION - 1,
    });
    expect(socket.closed).toEqual({ code: 4409, reason: "protocol version mismatch" });

    fixture.gateway.shutdown();
    fixture.store.close();
  });

  test("liveness is a socket property: the pair carries no channel", async () => {
    const fixture = await gatewayFixture();
    const socket = new FakeSocket();
    fixture.gateway.open("tab", socket);
    joinChannel(fixture, "tab", socket, { ch: "a" });
    socket.clear();

    fixture.clock.advance(DIAL_PING_INTERVAL_MS);
    expect(socket.frames()).toEqual([{ type: "ping" }]);
    fixture.gateway.message("tab", JSON.stringify({ type: "pong" }));

    // A socket that has joined nothing must still join first — and it is never pinged,
    // because the ten-second join deadline already answers for a connection with no room.
    const fresh = new FakeSocket();
    fixture.gateway.open("fresh", fresh);
    fixture.gateway.message("fresh", JSON.stringify({ type: "pong" }));
    expect(fresh.closed).toEqual({ code: 4002, reason: "first frame must be join" });

    fixture.gateway.shutdown();
    fixture.store.close();
  });
});

describe("SessionGateway liveness", () => {
  test("a tab that answers stays open across many intervals", async () => {
    const fixture = await gatewayFixture();
    const socket = new FakeSocket();
    fixture.gateway.open("tab", socket);
    joinChannel(fixture, "tab", socket);
    socket.clear();

    for (let round = 0; round < 3; round += 1) {
      fixture.clock.advance(DIAL_PING_INTERVAL_MS);
      expect(socket.frames().filter((frame) => frame.type === "ping")).toHaveLength(round + 1);
      fixture.gateway.message("tab", JSON.stringify({ type: "pong" }));
      expect(socket.closed).toBeNull();
    }

    fixture.gateway.shutdown();
    fixture.store.close();
  });

  test("an unanswered ping reaps the socket and the room stops counting it", async () => {
    /*
      The defect this closes (issue #55): a half-open socket — laptop asleep, wifi handoff,
      a tab the browser discarded — is a connection nothing will ever arrive on, and the room
      went on counting it in every presence payload for the life of the process.
     */
    const fixture = await gatewayFixture();
    const liveSocket = new FakeSocket();
    const ghostSocket = new FakeSocket();
    const ghostToken = fixture.auth.mintToken(
      { principal: { name: "ghost tab", kind: "human" }, caps: ["containers:read"] },
      fixture.auth.authenticate(fixture.ownerKey),
    ).token;
    join(fixture.gateway, "live", liveSocket, fixture.container.id, fixture.ownerKey);
    fixture.gateway.open("ghost", ghostSocket);
    joinChannel(fixture, "ghost", ghostSocket, { token: ghostToken });
    expect(fixture.rooms.presence()[0]?.principals).toHaveLength(2);

    // First interval: both are asked. Only the live tab answers.
    fixture.clock.advance(DIAL_PING_INTERVAL_MS);
    expect(ghostSocket.frames().filter((frame) => frame.type === "ping")).toHaveLength(1);
    fixture.gateway.message("live", JSON.stringify({ type: "pong" }));
    expect(ghostSocket.closed).toBeNull();

    // Second: the unanswered ping is the verdict, bounding detection at two intervals.
    fixture.clock.advance(DIAL_PING_INTERVAL_MS);
    expect(ghostSocket.closed).toEqual({ code: 4008, reason: "liveness timeout" });
    expect(liveSocket.closed).toBeNull();

    // The reap runs the ordinary close path, which is the whole point: room membership,
    // presence and viewer registrations are released exactly as a clean disconnect frees them.
    fixture.gateway.close("ghost");
    expect(fixture.rooms.presence()).toEqual([
      {
        containerId: fixture.container.id,
        principals: [expect.objectContaining({ name: "owner" })],
      },
    ]);

    fixture.gateway.shutdown();
    fixture.store.close();
  });

  test("the watchdog dies with the connection rather than outliving it", async () => {
    const fixture = await gatewayFixture();
    const socket = new FakeSocket();
    fixture.gateway.open("tab", socket);
    joinChannel(fixture, "tab", socket);
    expect(fixture.clock.pendingJobs).toBeGreaterThan(0);

    fixture.gateway.close("tab");
    expect(fixture.clock.pendingJobs).toBe(0);

    fixture.gateway.shutdown();
    fixture.store.close();
  });
});

describe("SessionGateway gesture cadence", () => {
  test("active gestures coalesce while end bypasses the cadence immediately", async () => {
    const fixture = await gatewayFixture();
    const first = new FakeSocket();
    const second = new FakeSocket();
    join(fixture.gateway, "first", first, fixture.container.id, fixture.ownerKey);
    join(fixture.gateway, "second", second, fixture.container.id, fixture.ownerKey);
    const armed = fixture.clock.pendingJobs; // the joined sockets' liveness watchdogs

    const gesture = (phase: "active" | "end", x: number): void => {
      send(fixture.gateway, "first", CH, {
        type: "gesture",
        kind: "move",
        phase,
        elementId: "element",
        x,
        y: x,
      });
    };

    gesture("active", 1);
    expect(second.messages().at(-1)).toMatchObject({
      type: "gesture",
      principalId: expect.any(String),
      phase: "active",
      x: 1,
    });
    second.clear();

    fixture.clock.advance(10);
    gesture("active", 2);
    gesture("active", 3);
    expect(second.messages()).toEqual([]);
    expect(fixture.clock.pendingJobs).toBe(armed + 1);

    gesture("end", 4);
    expect(fixture.clock.pendingJobs).toBe(armed);
    expect(second.messages()).toEqual([
      expect.objectContaining({
        type: "gesture",
        phase: "end",
        x: 4,
      }),
    ]);
    fixture.clock.advance(30);
    expect(second.messages()).toHaveLength(1);
    fixture.gateway.shutdown();
    fixture.store.close();
  });

  test("a trailing active gesture sends only the newest coordinates", async () => {
    const fixture = await gatewayFixture();
    const first = new FakeSocket();
    const second = new FakeSocket();
    join(fixture.gateway, "first", first, fixture.container.id, fixture.ownerKey);
    join(fixture.gateway, "second", second, fixture.container.id, fixture.ownerKey);
    send(fixture.gateway, "first", CH, {
      type: "gesture",
      kind: "resize",
      phase: "active",
      elementId: "element",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    });
    second.clear();
    fixture.clock.advance(5);
    for (const width of [20, 30, 40]) {
      send(fixture.gateway, "first", CH, {
        type: "gesture",
        kind: "resize",
        phase: "active",
        elementId: "element",
        x: 0,
        y: 0,
        width,
        height: width,
      });
    }
    fixture.clock.advance(25);

    expect(second.messages()).toEqual([
      expect.objectContaining({ type: "gesture", width: 40, height: 40 }),
    ]);
    fixture.gateway.shutdown();
    fixture.store.close();
  });

  /*
    THE CROSS-ROOM HALF (issue #66, audit 4.2). A carry over a portal streams through the
    CANVAS's room while the split it previews lands in the portal's container, so a
    collaborator sitting in that container's own view is in a room the frames never reach.
    These assert the routing, its authorization bar and its retraction — the three things a
    client cannot do for itself.
  */
  const carryFrame = (
    aimContainerId: string | null,
    phase: "active" | "end" = "active",
  ): Record<string, unknown> => ({
    type: "gesture",
    kind: "carry",
    phase,
    elementId: "element",
    x: 1,
    y: 1,
    carry: {
      ref: { kind: "element", containerId: "canvas", elementId: "element" },
      item: { kind: "terminal", containerId: null },
      ...(aimContainerId === null
        ? {}
        : {
            aim: {
              containerId: aimContainerId,
              tileId: "root",
              edge: "right",
              action: "place",
            },
          }),
    },
  });

  const tileCarryFrame = (
    sourceContainerId: string,
    aimContainerId: string | null = null,
    phase: "active" | "end" = "active",
  ): Record<string, unknown> => {
    const frame = carryFrame(aimContainerId, phase);
    return {
      ...frame,
      carry: {
        ...(frame["carry"] as Record<string, unknown>),
        ref: { kind: "tile", containerId: sourceContainerId, tileId: "source-leaf" },
      },
    };
  };

  test("a native tile carry reaches its source without an aim and retracts on a bare end", async () => {
    const fixture = await gatewayFixture();
    const source = fixture.secondContainer("source composition");
    const dragger = new FakeSocket();
    const watcher = new FakeSocket();
    join(fixture.gateway, "dragger", dragger, fixture.container.id, fixture.ownerKey);
    join(fixture.gateway, "watcher", watcher, source.id, fixture.ownerKey);
    watcher.clear();

    send(fixture.gateway, "dragger", CH, tileCarryFrame(source.id));
    expect(watcher.messages()).toEqual([
      expect.objectContaining({
        type: "gesture",
        phase: "active",
        aimOnly: true,
        carry: expect.objectContaining({
          ref: { kind: "tile", containerId: source.id, tileId: "source-leaf" },
        }),
      }),
    ]);
    watcher.clear();
    send(fixture.gateway, "dragger", CH, {
      type: "gesture",
      kind: "carry",
      phase: "end",
      elementId: "element",
      x: 1,
      y: 1,
    });
    expect(watcher.messages()).toEqual([
      expect.objectContaining({ type: "gesture", phase: "end", aimOnly: true }),
    ]);

    fixture.gateway.shutdown();
    fixture.store.close();
  });

  test("unrelated gestures stay home without erasing carry source and aim end recipients", async () => {
    const fixture = await gatewayFixture();
    const source = fixture.secondContainer("source composition");
    const aim = fixture.secondContainer("aim composition");
    const dragger = new FakeSocket();
    const homeWatcher = new FakeSocket();
    const sourceWatcher = new FakeSocket();
    const aimWatcher = new FakeSocket();
    join(fixture.gateway, "dragger", dragger, fixture.container.id, fixture.ownerKey);
    join(fixture.gateway, "home", homeWatcher, fixture.container.id, fixture.ownerKey);
    join(fixture.gateway, "source", sourceWatcher, source.id, fixture.ownerKey);
    join(fixture.gateway, "aim", aimWatcher, aim.id, fixture.ownerKey);
    for (const watcher of [homeWatcher, sourceWatcher, aimWatcher]) watcher.clear();

    send(fixture.gateway, "dragger", CH, tileCarryFrame(source.id, aim.id));
    for (const watcher of [sourceWatcher, aimWatcher]) {
      expect(watcher.messages()).toEqual([
        expect.objectContaining({ type: "gesture", kind: "carry", phase: "active", aimOnly: true }),
      ]);
      watcher.clear();
    }
    homeWatcher.clear();
    for (const kind of ["move", "resize", "draw"]) {
      fixture.clock.advance(30);
      send(fixture.gateway, "dragger", CH, {
        type: "gesture",
        kind,
        phase: "active",
        elementId: "other",
        x: 2,
        y: 2,
      });
      expect(homeWatcher.messages()).toEqual([
        expect.objectContaining({ type: "gesture", kind, phase: "active" }),
      ]);
      homeWatcher.clear();
      expect(sourceWatcher.messages()).toEqual([]);
      expect(aimWatcher.messages()).toEqual([]);
    }
    send(fixture.gateway, "dragger", CH, {
      type: "gesture",
      kind: "carry",
      phase: "end",
      elementId: "element",
      x: 1,
      y: 1,
    });
    for (const watcher of [sourceWatcher, aimWatcher]) {
      expect(watcher.messages()).toEqual([
        expect.objectContaining({ type: "gesture", kind: "carry", phase: "end", aimOnly: true }),
      ]);
    }
    fixture.gateway.shutdown();
    fixture.store.close();
  });

  test("ending one simultaneous carry preserves the other carry's foreign recipients", async () => {
    const fixture = await gatewayFixture();
    const first = fixture.secondContainer("first source");
    const second = fixture.secondContainer("second source");
    const dragger = new FakeSocket();
    const firstWatcher = new FakeSocket();
    const secondWatcher = new FakeSocket();
    join(fixture.gateway, "dragger", dragger, fixture.container.id, fixture.ownerKey);
    join(fixture.gateway, "first", firstWatcher, first.id, fixture.ownerKey);
    join(fixture.gateway, "second", secondWatcher, second.id, fixture.ownerKey);
    firstWatcher.clear();
    secondWatcher.clear();
    send(fixture.gateway, "dragger", CH, tileCarryFrame(first.id));
    firstWatcher.clear();
    fixture.clock.advance(30);
    send(fixture.gateway, "dragger", CH, { ...tileCarryFrame(second.id), elementId: "second" });
    expect(firstWatcher.messages()).toEqual([]);
    expect(secondWatcher.messages()).toEqual([
      expect.objectContaining({
        kind: "carry",
        phase: "active",
        elementId: "second",
        aimOnly: true,
      }),
    ]);
    secondWatcher.clear();
    send(fixture.gateway, "dragger", CH, {
      type: "gesture",
      kind: "carry",
      phase: "end",
      elementId: "element",
      x: 1,
      y: 1,
    });
    expect(firstWatcher.messages()).toEqual([
      expect.objectContaining({ kind: "carry", phase: "end", elementId: "element", aimOnly: true }),
    ]);
    expect(secondWatcher.messages()).toEqual([]);
    firstWatcher.clear();
    send(fixture.gateway, "dragger", CH, {
      type: "gesture",
      kind: "carry",
      phase: "end",
      elementId: "second",
      x: 1,
      y: 1,
    });
    expect(firstWatcher.messages()).toEqual([]);
    expect(secondWatcher.messages()).toEqual([
      expect.objectContaining({ kind: "carry", phase: "end", elementId: "second", aimOnly: true }),
    ]);
    fixture.gateway.shutdown();
    fixture.store.close();
  });

  test("source and aim sharing one room receive each carry frame only once", async () => {
    const fixture = await gatewayFixture();
    const source = fixture.secondContainer("source and target composition");
    const dragger = new FakeSocket();
    const watcher = new FakeSocket();
    join(fixture.gateway, "dragger", dragger, fixture.container.id, fixture.ownerKey);
    join(fixture.gateway, "watcher", watcher, source.id, fixture.ownerKey);
    watcher.clear();

    send(fixture.gateway, "dragger", CH, tileCarryFrame(source.id, source.id));
    expect(watcher.messages()).toEqual([
      expect.objectContaining({ type: "gesture", phase: "active", aimOnly: true }),
    ]);
    watcher.clear();
    send(fixture.gateway, "dragger", CH, tileCarryFrame(source.id, null, "end"));
    expect(watcher.messages()).toEqual([
      expect.objectContaining({ type: "gesture", phase: "end", aimOnly: true }),
    ]);

    fixture.gateway.shutdown();
    fixture.store.close();
  });

  test("a forged source receives neither active nor end without read authority", async () => {
    const fixture = await gatewayFixture();
    const source = fixture.secondContainer("unreadable source composition");
    const scoped = fixture.auth.mintToken(
      {
        principal: { name: "scoped dragger", kind: "human" },
        caps: ["containers:read", "scenes:write"],
        containerId: fixture.container.id,
      },
      fixture.auth.authenticate(fixture.ownerKey),
    ).token;
    const dragger = new FakeSocket();
    const watcher = new FakeSocket();
    join(fixture.gateway, "dragger", dragger, fixture.container.id, scoped);
    join(fixture.gateway, "watcher", watcher, source.id, fixture.ownerKey);
    watcher.clear();

    send(fixture.gateway, "dragger", CH, tileCarryFrame(source.id));
    send(fixture.gateway, "dragger", CH, tileCarryFrame(source.id, null, "end"));
    expect(watcher.messages()).toEqual([]);

    fixture.gateway.shutdown();
    fixture.store.close();
  });

  test("a carry aimed at another container reaches that container's own room", async () => {
    const fixture = await gatewayFixture();
    const aimed = fixture.secondContainer("the aimed composition");
    const dragger = new FakeSocket();
    const watcher = new FakeSocket();
    join(fixture.gateway, "dragger", dragger, fixture.container.id, fixture.ownerKey);
    // The viewer is in the AIMED room and nowhere near the dragger's.
    join(fixture.gateway, "watcher", watcher, aimed.id, fixture.ownerKey);
    watcher.clear();

    send(fixture.gateway, "dragger", CH, carryFrame(aimed.id));
    /*
      Stamped `aimOnly`, which is the whole of what makes the frame safe to deliver here:
      its geometry is in the sending room's space, so a receiver that painted a ghost from
      it would put a chip at another canvas's coordinates.
    */
    expect(watcher.messages()).toEqual([
      expect.objectContaining({
        type: "gesture",
        kind: "carry",
        aimOnly: true,
        carry: expect.objectContaining({ aim: expect.objectContaining({ containerId: aimed.id }) }),
      }),
    ]);

    // The release retires the projection at once. An end frame carries no aim at all, so
    // only the server's memory of where it last projected can route it — without that the
    // viewer's preview would hang until the aim TTL swept it.
    watcher.clear();
    send(fixture.gateway, "dragger", CH, carryFrame(null, "end"));
    expect(watcher.messages()).toEqual([
      expect.objectContaining({ type: "gesture", phase: "end", aimOnly: true }),
    ]);

    fixture.gateway.shutdown();
    fixture.store.close();
  });

  test("an aim moving to a third container retracts from the one it left", async () => {
    const fixture = await gatewayFixture();
    const first = fixture.secondContainer("first aimed");
    const second = fixture.secondContainer("second aimed");
    const dragger = new FakeSocket();
    const leftBehind = new FakeSocket();
    join(fixture.gateway, "dragger", dragger, fixture.container.id, fixture.ownerKey);
    join(fixture.gateway, "left", leftBehind, first.id, fixture.ownerKey);

    send(fixture.gateway, "dragger", CH, carryFrame(first.id));
    leftBehind.clear();
    // The cadence gate is per channel, so let the throttle window pass before the next frame.
    fixture.clock.advance(30);
    send(fixture.gateway, "dragger", CH, carryFrame(second.id));
    // The room it left still hears the frame — now aiming elsewhere — so its preview drops
    // immediately instead of sitting until the aim TTL.
    expect(leftBehind.messages()).toEqual([
      expect.objectContaining({
        aimOnly: true,
        carry: expect.objectContaining({
          aim: expect.objectContaining({ containerId: second.id }),
        }),
      }),
    ]);

    fixture.gateway.shutdown();
    fixture.store.close();
  });

  test("read authority on the aimed container is the bar, so a forged aim reaches nobody", async () => {
    const fixture = await gatewayFixture();
    const aimed = fixture.secondContainer("a container the dragger cannot read");
    /*
      A credential scoped to the dragger's OWN room only. Projecting an aim into a room is
      exactly as visible as joining it, so it costs exactly what joining costs — and a
      `containerId` a peer simply invented reaches nothing at all.
    */
    const scoped = fixture.auth.mintToken(
      {
        principal: { name: "scoped dragger", kind: "human" },
        caps: ["containers:read", "scenes:write"],
        containerId: fixture.container.id,
      },
      fixture.auth.authenticate(fixture.ownerKey),
    ).token;
    const dragger = new FakeSocket();
    const watcher = new FakeSocket();
    join(fixture.gateway, "dragger", dragger, fixture.container.id, scoped);
    join(fixture.gateway, "watcher", watcher, aimed.id, fixture.ownerKey);
    watcher.clear();

    send(fixture.gateway, "dragger", CH, carryFrame(aimed.id));
    expect(watcher.messages()).toEqual([]);

    fixture.gateway.shutdown();
    fixture.store.close();
  });
});

describe("SessionGateway spectator sockets", () => {
  test("a watching socket is absent from the attendance and from container presence", async () => {
    const fixture = await gatewayFixture();
    const occupantSocket = new FakeSocket();
    const watcherSocket = new FakeSocket();
    const watcherToken = fixture.auth.mintToken(
      {
        principal: { name: "portal watcher", kind: "human" },
        caps: ["containers:read"],
      },
      fixture.auth.authenticate(fixture.ownerKey),
    ).token;
    join(fixture.gateway, "occupant", occupantSocket, fixture.container.id, fixture.ownerKey);

    joinSpectator(fixture.gateway, "watcher", watcherSocket, fixture.container.id, watcherToken);

    // Nobody joined: the occupant hears no attendance delta for a watcher.
    expect(occupantSocket.messages()).toEqual([]);
    // The portal avatars read this endpoint's source, so a watcher must not appear in it.
    expect(fixture.rooms.presence()).toEqual([
      {
        containerId: fixture.container.id,
        principals: [expect.objectContaining({ name: "owner" })],
      },
    ]);

    // Reading is the whole point: the watcher still receives the room's fan-out.
    send(fixture.gateway, "occupant", CH, { type: "cursor", x: 7, y: 9 });
    expect(watcherSocket.messages()).toEqual([
      expect.objectContaining({ type: "cursor", x: 7, y: 9 }),
    ]);

    fixture.gateway.shutdown();
    fixture.store.close();
  });

  test("every write a watching socket attempts is refused while its reads are served", async () => {
    const fixture = await gatewayFixture();
    const occupantSocket = new FakeSocket();
    const watcherSocket = new FakeSocket();
    join(fixture.gateway, "occupant", occupantSocket, fixture.container.id, fixture.ownerKey);
    joinSpectator(
      fixture.gateway,
      "watcher",
      watcherSocket,
      fixture.container.id,
      fixture.ownerKey,
    );

    const writes: Record<string, unknown>[] = [
      { type: "doc_update", update: "AA==" },
      { type: "presence", payload: { focus: null } },
      { type: "cursor", x: 1, y: 1 },
      { type: "gesture", kind: "move", phase: "active", elementId: "element", x: 1, y: 1 },
      { type: "terminal_open", elementId: "element", cols: 80, rows: 24 },
      { type: "terminal_input", terminalId: "terminal", data: "AA==" },
      { type: "terminal_resize", terminalId: "terminal", cols: 80, rows: 24 },
      { type: "terminal_take", terminalId: "terminal" },
      { type: "terminal_kill", terminalId: "terminal" },
    ];
    for (const write of writes) {
      watcherSocket.clear();
      send(fixture.gateway, "watcher", CH, write);
      expect(watcherSocket.messages()).toEqual([
        {
          type: "error",
          code: "forbidden",
          message: "spectator sockets are read-only",
        },
      ]);
    }
    // Refused means refused: nothing a watcher sent ever reached the room.
    expect(occupantSocket.messages()).toEqual([]);

    // Recovery and liveness stay open: a dropped preview could never resync otherwise, and a
    // watcher forbidden to answer a ping would be reaped for being read-only.
    watcherSocket.clear();
    send(fixture.gateway, "watcher", CH, { type: "resync_request" });
    fixture.clock.advance(DIAL_PING_INTERVAL_MS);
    expect(watcherSocket.messages().map((message) => message.type)).toEqual(["resync", "ping"]);
    fixture.gateway.message("watcher", JSON.stringify({ type: "pong" }));
    fixture.clock.advance(DIAL_PING_INTERVAL_MS);
    expect(watcherSocket.closed).toBeNull();

    fixture.gateway.shutdown();
    fixture.store.close();
  });
});

describe("SessionGateway scene writes", () => {
  test("a reader in the room is refused both scene writes and nothing else it sends", async () => {
    /*
      `doc_update` and `gesture` are ONE authorization question — may this principal change what
      this container looks like — and they are asked at one gate. Asserted for both frames
      together because the refusal used to be written out twice: two copies are two chances for a
      later edit to answer the same question differently, and only one of the two answers is a
      bug anybody would notice.
     */
    const fixture = await gatewayFixture();
    const writerSocket = new FakeSocket();
    const readerSocket = new FakeSocket();
    const readerToken = fixture.auth.mintToken(
      {
        principal: { name: "read-only occupant", kind: "human" },
        caps: ["containers:read"],
      },
      fixture.auth.authenticate(fixture.ownerKey),
    ).token;
    join(fixture.gateway, "writer", writerSocket, fixture.container.id, fixture.ownerKey);
    join(fixture.gateway, "reader", readerSocket, fixture.container.id, readerToken);

    const writes: Record<string, unknown>[] = [
      { type: "doc_update", update: docUpdateFor("reader-element") },
      { type: "gesture", kind: "move", phase: "active", elementId: "element", x: 1, y: 1 },
    ];
    for (const write of writes) {
      readerSocket.clear();
      writerSocket.clear();
      send(fixture.gateway, "reader", CH, write);
      expect(readerSocket.messages()).toEqual([
        { type: "error", code: "forbidden", message: "scenes:write capability required" },
      ]);
      // Refused means refused: neither the update nor the gesture ever reached the room.
      expect(writerSocket.messages()).toEqual([]);
    }

    // A reader is not a spectator: recovery still answers, because a token that may READ the
    // scene must be able to catch up on it.
    readerSocket.clear();
    send(fixture.gateway, "reader", CH, { type: "resync_request" });
    expect(readerSocket.messages().map((message) => message.type)).toEqual(["resync"]);

    // And the gate lets the authorized write through unchanged: the reader sees the owner's.
    readerSocket.clear();
    send(fixture.gateway, "writer", CH, {
      type: "doc_update",
      update: docUpdateFor("owner-element"),
    });
    expect(readerSocket.messages().map((message) => message.type)).toEqual(["doc_update"]);

    fixture.gateway.shutdown();
    fixture.store.close();
  });
});
