import { describe, expect, test } from "bun:test";
import {
  CAPS,
  CHANNEL_LIMIT_CLOSE_CODE,
  CURSOR_MIN_INTERVAL_MS,
  DIAL_PING_INTERVAL_MS,
  MANIFOLD_ROOT_URI,
  MAX_SESSION_CHANNELS_PER_CONNECTION,
  PROTOCOL_VERSION,
  formatManifoldUri,
  CreateRunCredentialResultSchema,
  type Container,
} from "@manifold/protocol";
import { LOCAL_ORIGIN, Y, createSceneDoc, encodeUpdate, writeElement } from "@manifold/scene";
import { AuthService, INTERACTIVE_TOKEN_TTL_MS } from "../src/auth.ts";
import type { EventHub } from "../src/event-hub.ts";
import { silentLogger, type Logger, type LogLevel } from "../src/log.ts";
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
  readonly plugins: PluginHost;
}

async function gatewayFixture(
  logger: Logger = silentLogger,
  Clock: typeof FakeClock = FakeClock,
): Promise<GatewayFixture> {
  const runtime = new FakeRuntime();
  const clock = new Clock(runtime);
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
  const gateway = new SessionGateway(auth, rooms, broker, plugins, clock, logger, runtime, events);
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
    plugins,
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
  // Socket correlation, vocabulary and authority arrive before the room's readiness.
  expect(socket.messages().map((message) => message.type)).toEqual([
    "session",
    "plugins",
    "authority_context",
    "init",
  ]);
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
  expect(socket.messages().map((message) => message.type)).toEqual([
    "session",
    "plugins",
    "authority_context",
    "init",
  ]);
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

  test("same-principal sockets keep distinct correlation through refusal and closure", async () => {
    const logs: Array<{
      level: LogLevel;
      evt: string;
      fields: Readonly<Record<string, unknown>>;
    }> = [];
    const logger: Logger = {
      info: (evt, fields = {}) => logs.push({ level: "info", evt, fields }),
      warn: (evt, fields = {}) => logs.push({ level: "warn", evt, fields }),
      error: (evt, fields = {}) => logs.push({ level: "error", evt, fields }),
    };
    const fixture = await gatewayFixture(logger);
    const healthy = new FakeSocket();
    const refused = new FakeSocket();
    fixture.gateway.open("session-healthy", healthy);
    fixture.gateway.open("session-refused", refused);

    expect(healthy.messages()[0]).toEqual({
      type: "session",
      connectionId: "session-healthy",
    });
    expect(refused.messages()[0]).toEqual({
      type: "session",
      connectionId: "session-refused",
    });
    joinChannel(fixture, "session-healthy", healthy);
    send(fixture.gateway, "session-refused", "missing-room", {
      type: "join",
      containerId: "missing",
      token: fixture.ownerKey,
      protocolVersion: PROTOCOL_VERSION,
    });

    expect(
      logs.find(
        ({ evt, fields }) =>
          evt === "session_channel_refused" && fields.connectionId === "session-refused",
      )?.fields,
    ).toMatchObject({
      channelId: "missing-room",
      principalId: fixture.auth.ownerPrincipal.id,
      code: 4404,
      reason: "container not found",
    });

    fixture.gateway.close("session-refused", 1006);
    expect(
      logs.find(
        ({ evt, fields }) => evt === "session_closed" && fields.connectionId === "session-refused",
      )?.fields,
    ).toMatchObject({
      principalId: fixture.auth.ownerPrincipal.id,
      code: 1006,
      cause: "transport_drop",
      channels: [],
    });

    healthy.clear();
    send(fixture.gateway, "session-healthy", CH, { type: "resync_request" });
    expect(healthy.messages().some((message) => message.type === "resync")).toBe(true);
    expect(healthy.closed).toBeNull();
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
    expect(routed).toEqual(["a", "a", "b", "b"]);

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

    // A socket carrying neither rooms nor an observer must complete another handshake.
    send(fixture.gateway, "tab", "b", { type: "leave" });
    fixture.clock.advance(10_000);
    expect(socket.closed).toEqual({ code: 4002, reason: "handshake timeout" });

    fixture.gateway.shutdown();
    fixture.store.close();
  });

  test("a roomless observer authenticates once and keeps connection state live", async () => {
    const fixture = await gatewayFixture();
    const socket = new FakeSocket();
    fixture.gateway.open("tab", socket);
    socket.clear();

    fixture.gateway.message(
      "tab",
      JSON.stringify({
        type: "observe",
        token: fixture.ownerKey,
        protocolVersion: PROTOCOL_VERSION,
      }),
    );
    expect(socket.frames()).toEqual([
      { type: "authority_context", workspaceCaps: [...CAPS], workspaceEvents: true },
      { type: "observed" },
    ]);
    expect(fixture.rooms.live(fixture.container.id)).toBeNull();

    fixture.clock.advance(10_000);
    expect(socket.closed).toBeNull();

    joinChannel(fixture, "tab", socket);
    socket.clear();
    send(fixture.gateway, "tab", CH, { type: "leave" });
    fixture.clock.advance(10_000);
    expect(socket.closed).toBeNull();

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

  test("a forbidden foreign home refuses only its channel and preserves admitted document traffic", async () => {
    const fixture = await gatewayFixture();
    try {
      const foreign = fixture.secondContainer("forbidden document home");
      const token = fixture.auth.mintToken(
        {
          principal: { name: "scoped document editor", kind: "human" },
          caps: ["containers:read", "scenes:write"],
          containerId: fixture.container.id,
        },
        fixture.auth.authenticate(fixture.ownerKey),
      ).token;
      expect(
        fixture.auth.allows(fixture.auth.authenticate(token), "containers:read", foreign.id),
      ).toBe(false);
      const socket = new FakeSocket();
      const witness = new FakeSocket();
      join(fixture.gateway, "witness", witness, fixture.container.id, fixture.ownerKey);
      fixture.gateway.open("editor", socket);
      joinChannel(fixture, "editor", socket, { ch: "admitted", token });
      socket.clear();
      witness.clear();

      send(fixture.gateway, "editor", "foreign", {
        type: "join",
        containerId: foreign.id,
        token,
        protocolVersion: PROTOCOL_VERSION,
        spectator: true,
      });
      expect(socket.frames()).toEqual([
        { type: "channel_closed", ch: "foreign", code: 4403, reason: "forbidden" },
      ]);
      expect(socket.closed).toBeNull();

      socket.clear();
      send(fixture.gateway, "editor", "admitted", { type: "resync_request" });
      expect(socket.frames()).toEqual([
        expect.objectContaining({ type: "resync", ch: "admitted" }),
      ]);
      send(fixture.gateway, "editor", "admitted", {
        type: "doc_update",
        update: docUpdateFor("survives-foreign-refusal"),
      });
      expect(fixture.rooms.get(fixture.container.id)?.element("survives-foreign-refusal")).toEqual(
        expect.objectContaining({ id: "survives-foreign-refusal", type: "portal" }),
      );
      expect(witness.messages().some((message) => message.type === "doc_update")).toBe(true);
      expect(socket.closed).toBeNull();
    } finally {
      fixture.gateway.shutdown();
      fixture.store.close();
    }
  });

  test("a stale protocol version still closes the whole socket", async () => {
    const fixture = await gatewayFixture();
    const socket = new FakeSocket();
    fixture.gateway.open("tab", socket);
    joinChannel(fixture, "tab", socket, { ch: "admitted" });
    socket.clear();
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

  test("invalid credentials on a second join still close the whole socket", async () => {
    const fixture = await gatewayFixture();
    try {
      const socket = new FakeSocket();
      fixture.gateway.open("tab", socket);
      joinChannel(fixture, "tab", socket, { ch: "admitted" });
      socket.clear();
      send(fixture.gateway, "tab", "invalid", {
        type: "join",
        containerId: fixture.container.id,
        token: "not-a-credential",
        protocolVersion: PROTOCOL_VERSION,
      });
      expect(socket.closed).toEqual({ code: 4401, reason: "unauthorized" });
    } finally {
      fixture.gateway.shutdown();
      fixture.store.close();
    }
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

    // A socket that has completed neither handshake is never pinged, because the ten-second
    // deadline already answers for it.
    const fresh = new FakeSocket();
    fixture.gateway.open("fresh", fresh);
    fixture.gateway.message("fresh", JSON.stringify({ type: "pong" }));
    expect(fresh.closed).toEqual({ code: 4002, reason: "first frame must be join or observe" });

    fixture.gateway.shutdown();
    fixture.store.close();
  });
});

describe("SessionGateway live workspace authority", () => {
  test("workspace and container credentials receive their own root hints before room readiness", async () => {
    const fixture = await gatewayFixture();
    try {
      const owner = fixture.auth.authenticate(fixture.ownerKey);
      for (const containerId of [undefined, fixture.container.id]) {
        const token = fixture.auth.mintToken(
          {
            principal: { name: "fleet reader", kind: "human" },
            caps: ["containers:read", "machines:mint"],
            ...(containerId === undefined ? {} : { containerId }),
          },
          owner,
        ).token;
        const socket = new FakeSocket();
        const id = containerId === undefined ? "workspace" : "scoped";
        fixture.gateway.open(id, socket);
        expect(socket.frames().some((frame) => frame.type === "authority_context")).toBe(false);
        joinChannel(fixture, id, socket, { token });
        expect(socket.frames().map((frame) => frame.type)).toEqual([
          "session",
          "plugins",
          "authority_context",
          "init",
        ]);
        expect(socket.frames()[2]).toEqual({
          type: "authority_context",
          workspaceCaps: containerId === undefined ? ["containers:read", "machines:mint"] : [],
          workspaceEvents: containerId === undefined,
        });
        expect(socket.frames().find((frame) => frame.type === "init")?.selfCaps).toContain(
          "containers:read",
        );
      }
    } finally {
      fixture.gateway.shutdown();
      fixture.store.close();
    }
  });

  test("machine-targeted Runs have no workspace hint even with a null container scope", async () => {
    const fixture = await gatewayFixture();
    try {
      const owner = fixture.auth.authenticate(fixture.ownerKey);
      const registered = await fixture.auth.registerAgent(
        {
          name: "machine observer",
          purpose: "Read one machine",
          harness: "external",
          context: { profile: {} },
          grant: {
            caps: ["containers:read", "machines:read"],
            targets: ["manifold://machine/machine"],
            reach: "subtree",
            maxRunLifetimeMs: 600_000,
            delegation: { maxDepth: 0, maxDescendants: 0 },
            expiresAt: 3_600_000,
          },
        },
        owner,
      );
      const runner = fixture.auth.authenticate(registered.credential!.token);
      const admitted = CreateRunCredentialResultSchema.parse(
        fixture.auth.createRun(
          {
            agentId: registered.agent.agentId,
            target: "manifold://machine/machine",
            lifetimeMs: 120_000,
            session: { harness: "external", sessionId: "machine-session", machineId: "machine" },
          },
          runner,
        ),
      );
      const actor = fixture.auth.authenticate(admitted.credential.token);
      expect(actor.containerScope).toBeNull();
      const policy = fixture.auth.agentPolicyChallenge(actor);
      fixture.auth.acknowledgeAgentPolicy(
        {
          revision: policy.revision,
          acknowledgements: policy.required.map(({ id, digest }) => ({ id, digest })),
        },
        actor,
      );
      const socket = new FakeSocket();
      fixture.gateway.open("machine", socket);
      socket.clear();
      fixture.gateway.message(
        "machine",
        JSON.stringify({
          type: "observe",
          token: admitted.credential.token,
          protocolVersion: PROTOCOL_VERSION,
        }),
      );
      expect(socket.frames()).toEqual([
        { type: "authority_context", workspaceCaps: [], workspaceEvents: false },
        { type: "observed" },
      ]);
      fixture.gateway.message(
        "machine",
        JSON.stringify({
          type: "subscribe",
          topics: [{ kind: "plugin", pluginId: "core.machines" }],
        }),
      );
      expect(fixture.events.held("machine")).toBe(0);
    } finally {
      fixture.gateway.shutdown();
      fixture.store.close();
    }
  });

  test("live denies narrow hints without remounting, and wildcard hints require unattenuated root", async () => {
    const fixture = await gatewayFixture();
    try {
      const owner = fixture.auth.authenticate(fixture.ownerKey);
      const token = fixture.auth.mintToken(
        { principal: { name: "fleet administrator", kind: "human" }, caps: ["*"] },
        owner,
      ).token;
      const actor = fixture.auth.authenticate(token);
      const socket = new FakeSocket();
      join(fixture.gateway, "fleet", socket, fixture.container.id, token);
      const descendantDenial = fixture.auth.grant(
        {
          principal: { kind: "principal", id: actor.principal.id },
          node: `manifold://container/${fixture.container.id}`,
          caps: ["scenes:write"],
          effect: "deny",
          reach: "subtree",
        },
        owner,
      );
      expect(socket.frames()).toEqual([
        {
          type: "authority_context",
          workspaceCaps: CAPS.filter((cap) => cap !== "*"),
          workspaceEvents: true,
        },
      ]);
      socket.clear();
      const workspaceDenial = fixture.auth.grant(
        {
          principal: { kind: "principal", id: actor.principal.id },
          node: "manifold://",
          caps: ["containers:read", "machines:mint"],
          effect: "deny",
          reach: "node",
        },
        owner,
      );
      expect(socket.frames()).toEqual([
        {
          type: "authority_context",
          workspaceCaps: CAPS.filter(
            (cap) => cap !== "*" && cap !== "containers:read" && cap !== "machines:mint",
          ),
          workspaceEvents: false,
        },
      ]);
      socket.clear();
      fixture.auth.revokeGrant(descendantDenial.id, owner);
      expect(socket.frames()).toEqual([]);
      expect(socket.closed).toBeNull();
      send(fixture.gateway, "fleet", CH, { type: "resync_request" });
      expect(socket.frames().map((frame) => frame.type)).toEqual(["resync"]);
      socket.clear();
      fixture.auth.revokeGrant(workspaceDenial.id, owner);
      expect(socket.frames()).toEqual([
        { type: "authority_context", workspaceCaps: [...CAPS], workspaceEvents: true },
      ]);
      socket.clear();
      fixture.gateway.close("fleet");
      fixture.auth.grant(
        {
          principal: { kind: "principal", id: actor.principal.id },
          node: "manifold://",
          caps: ["terminals:write"],
          effect: "deny",
          reach: "node",
        },
        owner,
      );
      expect(socket.frames()).toEqual([]);
      fixture.gateway.shutdown();
      expect(fixture.clock.pendingJobs).toBe(0);
      fixture.auth.grant(
        {
          principal: { kind: "principal", id: actor.principal.id },
          node: "manifold://",
          caps: ["containers:write"],
          effect: "deny",
          reach: "node",
        },
        owner,
      );
      expect(socket.frames()).toEqual([]);
    } finally {
      fixture.gateway.shutdown();
      fixture.store.close();
    }
  });

  test("a later broader handshake cannot replace the physical credential's event authority", async () => {
    const fixture = await gatewayFixture();
    try {
      const token = fixture.auth.mintToken(
        {
          principal: { name: "scoped observer", kind: "human" },
          caps: ["containers:read"],
          containerId: fixture.container.id,
        },
        fixture.auth.authenticate(fixture.ownerKey),
      ).token;
      const socket = new FakeSocket();
      fixture.gateway.open("tab", socket);
      socket.clear();
      fixture.gateway.message(
        "tab",
        JSON.stringify({ type: "observe", token, protocolVersion: PROTOCOL_VERSION }),
      );
      expect(socket.frames()).toEqual([
        { type: "authority_context", workspaceCaps: [], workspaceEvents: false },
        { type: "observed" },
      ]);
      socket.clear();
      joinChannel(fixture, "tab", socket, { token: fixture.ownerKey });
      expect(socket.frames().some((frame) => frame.type === "authority_context")).toBe(false);
      fixture.gateway.message(
        "tab",
        JSON.stringify({
          type: "subscribe",
          topics: [{ kind: "plugin", pluginId: "core.machines" }],
        }),
      );
      expect(fixture.events.held("tab")).toBe(0);
      fixture.auth.revokePrincipal(
        fixture.auth.authenticate(token).principal.id,
        fixture.auth.authenticate(fixture.ownerKey),
      );
      expect(socket.closed).toEqual({ code: 4403, reason: "revoked" });
    } finally {
      fixture.gateway.shutdown();
      fixture.store.close();
    }
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

  test("durable Agent runs isolate trace and socket identities; generic revocation fences a cross-Agent child", async () => {
    const fixture = await gatewayFixture();
    try {
      const owner = fixture.auth.authenticate(fixture.ownerKey);
      const registered = await fixture.auth.registerAgent(
        {
          name: "socket analyst",
          purpose: "Inspect one container",
          harness: "external",
          context: { profile: {} },
          grant: {
            caps: ["containers:read", "agents:delegate"],
            targets: ["manifold://"],
            reach: "subtree",
            maxRunLifetimeMs: 600_000,
            delegation: { maxDepth: 1, maxDescendants: 1 },
            expiresAt: 3_600_000,
          },
        },
        owner,
      );
      const runner = fixture.auth.authenticate(registered.credential!.token);
      const runs = ["first", "second"].map((sessionId) =>
        CreateRunCredentialResultSchema.parse(
          fixture.auth.createRun(
            {
              agentId: registered.agent.agentId,
              lifetimeMs: 120_000,
              session: { harness: "external", sessionId, machineId: "machine" },
            },
            runner,
          ),
        ),
      );
      const actors = runs.map(({ credential }) => fixture.auth.authenticate(credential.token));
      for (const actor of actors) {
        const policy = fixture.auth.agentPolicyChallenge(actor);
        fixture.auth.acknowledgeAgentPolicy(
          {
            revision: policy.revision,
            acknowledgements: policy.required.map(({ id, digest }) => ({ id, digest })),
          },
          actor,
        );
      }
      const firstSocket = new FakeSocket();
      const secondSocket = new FakeSocket();
      join(
        fixture.gateway,
        "agent-first",
        firstSocket,
        fixture.container.id,
        runs[0]!.credential.token,
      );
      join(
        fixture.gateway,
        "agent-second",
        secondSocket,
        fixture.container.id,
        runs[1]!.credential.token,
      );
      for (const actor of actors)
        expect((await fixture.plugins.dispatch(actor, "core.machines.list", {})).ok).toBe(true);
      const first = fixture.auth.inspectRun({ runId: runs[0]!.run.id, limit: 50 }, owner);
      const second = fixture.auth.inspectRun({ runId: runs[1]!.run.id, limit: 50 }, owner);
      expect(
        first.connections
          .filter((connection) => connection.state === "live")
          .map((connection) => connection.connectionId),
      ).toEqual(["agent-first"]);
      expect(
        second.connections
          .filter((connection) => connection.state === "live")
          .map((connection) => connection.connectionId),
      ).toEqual(["agent-second"]);
      expect(first.traces.map((trace) => trace.action)).toEqual(["core.machines.list"]);
      expect(second.traces.map((trace) => trace.action)).toEqual(["core.machines.list"]);
      expect(first.traces[0]!.traceId).not.toBe(second.traces[0]!.traceId);
      const renewed = fixture.auth.renewAgentRun(
        { runId: runs[0]!.run.id, lifetimeMs: 180_000 },
        runner,
      );
      expect(firstSocket.closed).toEqual({ code: 4403, reason: "revoked" });
      expect(secondSocket.closed).toBeNull();
      const replacementSocket = new FakeSocket();
      join(
        fixture.gateway,
        "agent-replacement",
        replacementSocket,
        fixture.container.id,
        renewed.credential.token,
      );
      const childAgent = await fixture.auth.registerAgent(
        {
          name: "socket reviewer",
          purpose: "Review the delegated container",
          harness: "external",
          context: { profile: {} },
          grant: registered.agent.grant,
        },
        owner,
      );
      const child = fixture.auth.createChildRun(
        { runId: runs[1]!.run.id, agentId: childAgent.agent.agentId },
        owner,
      );
      expect(child.run.principal.id).not.toBe(runs[1]!.run.principal.id);
      expect(child.run.parentRunId).toBe(runs[1]!.run.id);
      const childToken = fixture.auth.claimRunLaunch(child.run.id, owner).token!;
      const childActor = fixture.auth.authenticate(childToken);
      const childPolicy = fixture.auth.agentPolicyChallenge(childActor);
      fixture.auth.acknowledgeAgentPolicy(
        {
          revision: childPolicy.revision,
          acknowledgements: childPolicy.required.map(({ id, digest }) => ({ id, digest })),
        },
        childActor,
      );
      const childSocket = new FakeSocket();
      join(fixture.gateway, "agent-child", childSocket, fixture.container.id, childToken);
      expect(childSocket.closed).toBeNull();
      expect(
        (
          await fixture.plugins.dispatch(owner, "core.access.revoke", {
            principalId: registered.agent.principalId,
          })
        ).ok,
      ).toBe(true);
      expect(replacementSocket.closed).toEqual({ code: 4403, reason: "revoked" });
      expect(secondSocket.closed).toEqual({ code: 4403, reason: "revoked" });
      expect(childSocket.closed).toEqual({ code: 4403, reason: "revoked" });
      for (const token of [renewed.credential.token, runs[1]!.credential.token, childToken])
        expect(() => fixture.auth.authenticate(token)).toThrow("revoked");
      expect(fixture.store.getAgentRun(runs[0]!.run.id)?.state).toBe("revoked");
      expect(fixture.store.getAgentRun(runs[1]!.run.id)?.state).toBe("revoked");
      expect(fixture.store.getAgentRun(child.run.id)?.state).toBe("revoked");
    } finally {
      fixture.gateway.shutdown();
      fixture.store.close();
    }
  });

  test("an expiring browser credential fences an already-open session socket", async () => {
    const fixture = await gatewayFixture();
    const socket = new FakeSocket();
    const token = fixture.auth.acceptPreviewIdentity({
      version: 1,
      id: "assertion",
      issuer: "https://manifold.example",
      audience: "https://preview.manifold.example",
      issuedAt: fixture.runtime.now(),
      expiresAt: fixture.runtime.now() + 60_000,
      nonce: "n".repeat(43),
      principal: {
        id: "production-human",
        kind: "human",
        name: "production human",
        color: "#1971c2",
      },
      caps: ["containers:read"],
      containerId: null,
    }).token;
    join(fixture.gateway, "preview", socket, fixture.container.id, token);

    // Answered ping by ping rather than in one jump: an unanswered interval is the liveness
    // verdict (4008), and the claim here is that the CREDENTIAL fences a socket that is alive.
    const rounds = INTERACTIVE_TOKEN_TTL_MS / DIAL_PING_INTERVAL_MS;
    for (let round = 1; round < rounds; round += 1) {
      fixture.clock.advance(DIAL_PING_INTERVAL_MS);
      fixture.gateway.message("preview", JSON.stringify({ type: "pong" }));
    }
    expect(socket.closed).toBeNull();
    fixture.clock.advance(DIAL_PING_INTERVAL_MS);
    expect(socket.closed).toEqual({ code: 4403, reason: "expired" });

    fixture.gateway.shutdown();
    fixture.store.close();
  });

  for (const rollbackDays of [0, 7]) {
    test(`a 30-day credential expires at its absolute deadline with ${rollbackDays} days of clock rollback`, async () => {
      // Match the production platform's overflow behavior, not an unbounded fake timer.
      class PlatformClock extends FakeClock {
        override schedule(callback: () => void, delayMs: number): () => void {
          return super.schedule(callback, delayMs > 2_147_483_647 ? 1 : delayMs);
        }
      }
      const fixture = await gatewayFixture(silentLogger, PlatformClock);
      let wallOffset = 0;
      fixture.runtime.now = () => fixture.runtime.time + wallOffset;
      const day = 24 * 60 * 60_000;
      const expiresAt = fixture.runtime.now() + 30 * day;
      const token = fixture.auth.mintTokenV2(
        {
          principal: { name: "long session", kind: "human" },
          scope: [
            {
              target: MANIFOLD_ROOT_URI,
              reach: "subtree",
              caps: ["containers:read"],
            },
          ],
          expiresAt,
        },
        fixture.auth.authenticate(fixture.ownerKey),
      ).token;
      const socket = new FakeSocket();
      try {
        join(fixture.gateway, "long-session", socket, fixture.container.id, token);
        const advanceAlive = (duration: number): void => {
          const until = fixture.runtime.time + duration;
          while (fixture.runtime.time < until) {
            fixture.clock.advance(Math.min(DIAL_PING_INTERVAL_MS, until - fixture.runtime.time));
            fixture.gateway.message("long-session", JSON.stringify({ type: "pong" }));
            socket.sent.length = 0;
          }
        };
        advanceAlive(24 * day);
        expect(socket.closed).toBeNull();
        wallOffset -= rollbackDays * day;
        advanceAlive((6 + rollbackDays) * day - 1);
        expect(socket.closed).toBeNull();
        fixture.clock.advance(1);
        expect(socket.closed?.code).toBe(4403);
      } finally {
        fixture.gateway.shutdown();
        fixture.store.close();
      }
    });
  }

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
      {
        type: "terminal_resize",
        terminalId: "terminal",
        viewportId: "fixture",
        viewport: { cols: 80, rows: 24 },
      },
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
  test("home grant changes publish evaluated authority without interrupting admitted rooms", async () => {
    const fixture = await gatewayFixture();
    try {
      const other = fixture.secondContainer("unaffected home");
      const root = fixture.auth.authenticate(fixture.ownerKey);
      const grant = fixture.auth.mintToken(
        {
          principal: { name: "home authority editor", kind: "human" },
          caps: ["containers:read", "scenes:write"],
        },
        root,
      );
      const owner = new FakeSocket();
      fixture.gateway.open("owner", owner);
      joinChannel(fixture, "owner", owner);
      expect(owner.frames().find((frame) => frame.type === "init")).toMatchObject({
        selfCaps: ["*"],
        sceneWriteAllowed: true,
      });
      const socket = new FakeSocket();
      fixture.gateway.open("editor", socket);
      joinChannel(fixture, "editor", socket, { ch: "home", token: grant.token });
      joinChannel(fixture, "editor", socket, {
        ch: "other",
        containerId: other.id,
        token: grant.token,
      });
      expect(socket.frames().filter((frame) => frame.type === "init")).toEqual([
        expect.objectContaining({ ch: "home", sceneWriteAllowed: true }),
        expect.objectContaining({ ch: "other", sceneWriteAllowed: true }),
      ]);
      socket.clear();
      owner.clear();
      const deny = fixture.auth.grant(
        {
          principal: { kind: "principal", id: grant.principal.id },
          node: formatManifoldUri({ kind: "container", containerId: fixture.container.id }),
          caps: ["scenes:write"],
          effect: "deny",
          reach: "node",
        },
        root,
      );
      expect(socket.frames()).toEqual([
        expect.objectContaining({
          type: "resync",
          ch: "home",
          selfCaps: ["containers:read", "scenes:write"],
          sceneWriteAllowed: false,
        }),
      ]);
      expect(owner.frames()).toEqual([]);
      expect(socket.closed).toBeNull();
      socket.clear();
      fixture.auth.grant(
        {
          principal: { kind: "principal", id: grant.principal.id },
          node: formatManifoldUri({ kind: "container", containerId: fixture.container.id }),
          caps: ["containers:write"],
          effect: "deny",
          reach: "node",
        },
        root,
      );
      expect(socket.frames()).toEqual([]);
      send(fixture.gateway, "editor", "home", {
        type: "doc_update",
        update: docUpdateFor("refused-by-home"),
      });
      expect(fixture.rooms.get(fixture.container.id)?.element("refused-by-home")).toBeNull();
      expect(socket.frames()).toEqual([
        expect.objectContaining({ type: "error", ch: "home", code: "forbidden" }),
        expect.objectContaining({ type: "resync", ch: "home", sceneWriteAllowed: false }),
      ]);
      socket.clear();
      fixture.auth.revokeGrant(deny.id, root);
      expect(socket.frames()).toEqual([
        expect.objectContaining({ type: "resync", ch: "home", sceneWriteAllowed: true }),
      ]);
      send(fixture.gateway, "editor", "home", {
        type: "doc_update",
        update: docUpdateFor("restored-at-home"),
      });
      send(fixture.gateway, "editor", "other", {
        type: "doc_update",
        update: docUpdateFor("uninterrupted-other-home"),
      });
      expect(fixture.rooms.get(fixture.container.id)?.element("restored-at-home")).not.toBeNull();
      expect(fixture.rooms.get(other.id)?.element("uninterrupted-other-home")).not.toBeNull();
      expect(socket.closed).toBeNull();
    } finally {
      fixture.gateway.shutdown();
      fixture.store.close();
    }
  });

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
      const refusal = {
        type: "error",
        code: "forbidden",
        message: "scenes:write capability required",
      };
      expect(readerSocket.messages()).toEqual(
        write["type"] === "doc_update"
          ? [refusal, expect.objectContaining({ type: "resync", sceneWriteAllowed: false })]
          : [refusal],
      );
      // Refused means refused: neither the update nor the gesture ever reached the room.
      expect(writerSocket.messages()).toEqual([]);
    }

    // A reader is not a spectator: recovery still answers, because a token that may READ the
    // scene must be able to catch up on it.
    fixture.clock.advance(1_000);
    readerSocket.clear();
    send(fixture.gateway, "reader", CH, { type: "resync_request" });
    expect(readerSocket.messages().map((message) => message.type)).toEqual(["resync"]);

    // And the gate lets the authorized write through: the reader sees both the owner's update
    // and its server-authored summary.
    readerSocket.clear();
    send(fixture.gateway, "writer", CH, {
      type: "doc_update",
      update: docUpdateFor("owner-element"),
    });
    expect(readerSocket.messages().map((message) => message.type)).toEqual([
      "doc_update",
      "doc_update",
    ]);

    fixture.gateway.shutdown();
    fixture.store.close();
  });
});

test("recipient narrowing and removal fence only retired ticket sockets and allow reapproved joins", async () => {
  const fix = await gatewayFixture();
  try {
    const owner = fix.auth.authenticate(fix.ownerKey);
    const minted = fix.auth.mintShare(
      {
        node: { kind: "container", containerId: fix.container.id },
        caps: ["tokens:mint", "containers:read", "scenes:write"],
        origin: "https://guest.example",
      },
      owner,
    );
    const share = fix.auth.authenticateShare(minted.token);
    const guest = { id: "guest-local", kind: "human" as const, name: "guest", color: "#3355cc" };
    const input = { shareId: share.id, guestPrincipalId: guest.id };
    expect(() => fix.auth.mintShareTicket(share, guest)).toThrow("recipient_unapproved");
    fix.auth.approveShareRecipient(
      {
        ...input,
        caps: ["tokens:mint", "containers:read", "scenes:write"],
      },
      owner,
    );
    const first = fix.auth.mintShareTicket(share, guest);
    const second = fix.auth.mintShareTicket(share, guest);
    const source = fix.auth.authenticate(first.token);
    const child = fix.auth.mintToken(
      {
        principal: { name: "derived socket", kind: "human" },
        caps: ["containers:read", "scenes:write"],
      },
      source,
    );
    const terminal = fix.auth.mintTerminalLifecycleToken(
      "derived-session-socket",
      fix.container.id,
      source.principal.id,
      source.tokenId,
    );
    const unrelated = fix.auth.mintToken(
      {
        principalId: first.principal.id,
        caps: ["containers:read"],
        containerId: fix.container.id,
      },
      owner,
    );
    const firstSocket = new FakeSocket();
    const secondSocket = new FakeSocket();
    const unrelatedSocket = new FakeSocket();
    const childSocket = new FakeSocket();
    const terminalSocket = new FakeSocket();
    join(fix.gateway, "recipient-first", firstSocket, fix.container.id, first.token);
    join(fix.gateway, "recipient-second", secondSocket, fix.container.id, second.token);
    join(fix.gateway, "recipient-unrelated", unrelatedSocket, fix.container.id, unrelated.token);
    join(fix.gateway, "recipient-derived", childSocket, fix.container.id, child.token);
    join(fix.gateway, "recipient-terminal", terminalSocket, fix.container.id, terminal.token);
    fix.auth.approveShareRecipient({ ...input, caps: ["containers:read"] }, owner);
    expect(firstSocket.closed?.code).toBe(4403);
    expect(secondSocket.closed?.code).toBe(4403);
    expect(childSocket.closed?.code).toBe(4403);
    expect(terminalSocket.closed?.code).toBe(4403);
    expect(unrelatedSocket.closed).toBeNull();
    const narrowed = fix.auth.mintShareTicket(share, guest);
    const narrowedSocket = new FakeSocket();
    join(fix.gateway, "recipient-narrowed", narrowedSocket, fix.container.id, narrowed.token);
    expect(narrowedSocket.closed).toBeNull();
    fix.auth.removeShareRecipient(input, owner);
    expect(narrowedSocket.closed?.code).toBe(4403);
    expect(unrelatedSocket.closed).toBeNull();
    expect(() => fix.auth.mintShareTicket(share, guest)).toThrow("recipient_unapproved");
    fix.auth.approveShareRecipient({ ...input, caps: ["containers:read"] }, owner);
    const reapproved = fix.auth.mintShareTicket(share, guest);
    const reapprovedSocket = new FakeSocket();
    join(fix.gateway, "recipient-reapproved", reapprovedSocket, fix.container.id, reapproved.token);
    expect(reapprovedSocket.closed).toBeNull();
    expect(reapproved.principal.id).toBe(first.principal.id);
    fix.auth.revokeShare(share.id, owner);
    expect(reapprovedSocket.closed?.code).toBe(4403);
    expect(unrelatedSocket.closed).toBeNull();
  } finally {
    fix.gateway.shutdown();
    fix.store.close();
  }
});

for (const scenario of [
  {
    name: "owner-sponsored cross-Agent descendant",
    recipientSponsorsParent: true,
    refresh: "none",
  },
  { name: "renewed standing-sponsored child", recipientSponsorsParent: false, refresh: "renew" },
  {
    name: "session-rebound child and its terminal identity",
    recipientSponsorsParent: true,
    refresh: "rebind",
  },
] as const) {
  test(`recipient withdrawal fences ${scenario.name} without retiring independent authority`, async () => {
    const fix = await gatewayFixture();
    try {
      const owner = fix.auth.authenticate(fix.ownerKey);
      const minted = fix.auth.mintShare(
        {
          node: { kind: "container", containerId: fix.container.id },
          caps: ["tokens:mint", "agents:run", "agents:delegate", "containers:read"],
          origin: "https://run-guest.example",
        },
        owner,
      );
      const share = fix.auth.authenticateShare(minted.token);
      const guest = { id: "run-guest", kind: "human" as const, name: "guest", color: "#3355cc" };
      const recipient = { shareId: share.id, guestPrincipalId: guest.id };
      expect(() => fix.auth.mintShareTicket(share, guest)).toThrow("recipient_unapproved");
      fix.auth.approveShareRecipient(
        { ...recipient, caps: ["tokens:mint", "agents:run", "agents:delegate", "containers:read"] },
        owner,
      );
      const ticket = fix.auth.authenticate(fix.auth.mintShareTicket(share, guest).token);
      const register = (name: string, sponsor: typeof owner) =>
        fix.auth.registerAgent(
          {
            name,
            purpose: "Inspect the delegated container",
            harness: "external",
            context: { profile: {} },
            grant: {
              caps: ["containers:read", "agents:delegate"],
              targets: [`manifold://container/${fix.container.id}`],
              reach: "subtree",
              maxRunLifetimeMs: 600_000,
              delegation: { maxDepth: 1, maxDescendants: 1 },
              expiresAt: fix.runtime.now() + 600_000,
            },
          },
          sponsor,
        );
      const parentAgent = await register(
        "parent",
        scenario.recipientSponsorsParent ? ticket : owner,
      );
      const childAgent = await register("child", scenario.recipientSponsorsParent ? owner : ticket);
      if (parentAgent.credential === undefined || childAgent.credential === undefined)
        throw new Error("registration produced no runner");
      const parent = CreateRunCredentialResultSchema.parse(
        fix.auth.createRun(
          { agentId: parentAgent.agent.agentId, lifetimeMs: 180_000 },
          fix.auth.authenticate(parentAgent.credential.token),
        ),
      );
      const acknowledge = (token: string): void => {
        const actor = fix.auth.authenticate(token);
        const policy = fix.auth.agentPolicyChallenge(actor);
        fix.auth.acknowledgeAgentPolicy(
          {
            revision: policy.revision,
            acknowledgements: policy.required.map(({ id, digest }) => ({ id, digest })),
          },
          actor,
        );
      };
      acknowledge(parent.credential.token);
      const child = fix.auth.createChildRun(
        { runId: parent.run.id, agentId: childAgent.agent.agentId, lifetimeMs: 60_000 },
        owner,
      );
      let childToken = fix.auth.claimRunLaunch(child.run.id, owner).token;
      if (childToken === undefined) throw new Error("child produced no launch credential");
      acknowledge(childToken);
      let terminalSocket: FakeSocket | undefined;
      let terminalToken: string | undefined;
      if (scenario.refresh === "renew") {
        childToken = fix.auth.renewAgentRun(
          { runId: child.run.id, lifetimeMs: 120_000 },
          fix.auth.authenticate(childAgent.credential.token),
        ).credential.token;
      } else if (scenario.refresh === "rebind") {
        const session = { harness: "external", machineId: "fixture-machine", sessionId: "child" };
        fix.auth.bindRunSession(child.run.id, session, owner);
        fix.store.createTerminal({
          id: fix.runtime.newId(),
          machineId: session.machineId,
          containerId: fix.container.id,
          createdBy: owner.principal.id,
          agentPrincipalId: child.run.principal.id,
          runId: child.run.id,
          session,
          createdAt: fix.runtime.now(),
          launchRecipe: { cols: 80, rows: 24, env: {}, program: { argv: ["/bin/sh", "-l"] } },
        });
        childToken = fix.auth.bindRunSession(child.run.id, session, owner);
        const childActor = fix.auth.authenticate(childToken);
        terminalToken = fix.auth.mintTerminalLifecycleToken(
          "rebound-child-terminal",
          fix.container.id,
          childActor.principal.id,
          childActor.tokenId,
        ).token;
        terminalSocket = new FakeSocket();
        join(fix.gateway, "cross-agent-terminal", terminalSocket, fix.container.id, terminalToken);
        expect(
          fix.auth.allows(fix.auth.authenticate(terminalToken), "scenes:write", fix.container.id),
        ).toBe(false);
      }
      const boundChildToken = childToken;
      if (scenario.refresh === "none") {
        // Retained owner-issued descendants can lack a direct recipient row.
        const credential = fix.auth.authenticate(boundChildToken);
        fix.store.db
          .query<void, [string | null]>("DELETE FROM share_ticket_credentials WHERE token_id=?")
          .run(credential.tokenId);
      }
      const parentSocket = new FakeSocket();
      const childSocket = new FakeSocket();
      const ownerSocket = new FakeSocket();
      join(
        fix.gateway,
        "cross-agent-parent",
        parentSocket,
        fix.container.id,
        parent.credential.token,
      );
      join(fix.gateway, "cross-agent-child", childSocket, fix.container.id, boundChildToken);
      join(fix.gateway, "cross-agent-owner", ownerSocket, fix.container.id, fix.ownerKey);
      fix.auth.removeShareRecipient(recipient, owner);
      expect(childSocket.closed).toEqual({ code: 4403, reason: "revoked" });
      expect(() => fix.auth.authenticate(boundChildToken)).toThrow("revoked");
      expect(fix.store.getAgentRun(child.run.id)?.state).toBe("revoked");
      if (scenario.recipientSponsorsParent) {
        expect(parentSocket.closed).toEqual({ code: 4403, reason: "revoked" });
        expect(fix.store.getAgentRun(parent.run.id)?.state).toBe("revoked");
      } else {
        expect(parentSocket.closed).toBeNull();
        expect(fix.store.getAgentRun(parent.run.id)?.state).toBe("active");
        expect(
          fix.auth.allows(
            fix.auth.authenticate(parent.credential.token),
            "containers:read",
            fix.container.id,
          ),
        ).toBe(true);
      }
      if (terminalSocket !== undefined && terminalToken !== undefined) {
        expect(terminalSocket.closed).toEqual({ code: 4403, reason: "revoked" });
        expect(() => fix.auth.authenticate(terminalToken)).toThrow("revoked");
      }
      expect(ownerSocket.closed).toBeNull();
    } finally {
      fix.gateway.shutdown();
      fix.store.close();
    }
  });
}
