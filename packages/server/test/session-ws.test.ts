import { describe, expect, test } from "bun:test";
import { CURSOR_MIN_INTERVAL_MS, PROTOCOL_VERSION, type Pad } from "@manifold/protocol";
import { AuthService } from "../src/auth.ts";
import { silentLogger } from "../src/log.ts";
import { RoomManager } from "../src/room.ts";
import { SessionGateway } from "../src/session-ws.ts";
import { TerminalBroker } from "../src/terminal-broker.ts";
import { FakeClock, FakeRuntime, FakeSocket, testStore } from "./helpers.ts";

function gatewayFixture() {
  const runtime = new FakeRuntime();
  const clock = new FakeClock(runtime);
  const store = testStore();
  const ownerKey = "e".repeat(64);
  const auth = new AuthService(store, ownerKey, runtime);
  const pad: Pad = {
    id: runtime.newId(),
    name: "sync pad",
    createdAt: runtime.now(),
    layout: "canvas",
    transient: false,
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
  const gateway = new SessionGateway(auth, rooms, broker, clock, silentLogger, runtime);
  return { runtime, clock, store, ownerKey, auth, pad, rooms, gateway };
}

function join(
  gateway: SessionGateway,
  id: string,
  socket: FakeSocket,
  padId: string,
  token: string,
): void {
  gateway.open(id, socket);
  gateway.message(
    id,
    JSON.stringify({
      type: "join",
      padId,
      token,
      protocolVersion: PROTOCOL_VERSION,
    }),
  );
  expect(socket.messages()[0]?.type).toBe("init");
  socket.clear();
}

/** Joins the read-only socket a portal widget's live preview opens. */
function joinSpectator(
  gateway: SessionGateway,
  id: string,
  socket: FakeSocket,
  padId: string,
  token: string,
): void {
  gateway.open(id, socket);
  gateway.message(
    id,
    JSON.stringify({
      type: "join",
      padId,
      token,
      protocolVersion: PROTOCOL_VERSION,
      spectator: true,
    }),
  );
  expect(socket.messages()[0]?.type).toBe("init");
  socket.clear();
}

describe("SessionGateway high-rate request cadence", () => {
  test("resync floods produce at most one authoritative frame per second", () => {
    const fixture = gatewayFixture();
    const socket = new FakeSocket();
    join(fixture.gateway, "peer", socket, fixture.pad.id, fixture.ownerKey);

    for (let index = 0; index < 20; index += 1) {
      fixture.gateway.message("peer", JSON.stringify({ type: "resync_request" }));
    }
    expect(socket.messages().filter((message) => message.type === "resync")).toHaveLength(1);

    fixture.clock.advance(999);
    fixture.gateway.message("peer", JSON.stringify({ type: "resync_request" }));
    expect(socket.messages().filter((message) => message.type === "resync")).toHaveLength(1);
    fixture.clock.advance(1);
    fixture.gateway.message("peer", JSON.stringify({ type: "resync_request" }));
    expect(socket.messages().filter((message) => message.type === "resync")).toHaveLength(2);
    fixture.gateway.shutdown();
    fixture.store.close();
  });

  test("a rapid second resync request is served once at the cadence boundary", () => {
    const fixture = gatewayFixture();
    const socket = new FakeSocket();
    join(fixture.gateway, "peer", socket, fixture.pad.id, fixture.ownerKey);

    fixture.gateway.message("peer", JSON.stringify({ type: "resync_request" }));
    fixture.gateway.message("peer", JSON.stringify({ type: "resync_request" }));
    fixture.gateway.message("peer", JSON.stringify({ type: "resync_request" }));

    expect(socket.messages().filter((message) => message.type === "resync")).toHaveLength(1);
    expect(fixture.clock.pendingJobs).toBe(1);
    fixture.clock.advance(999);
    expect(socket.messages().filter((message) => message.type === "resync")).toHaveLength(1);
    fixture.clock.advance(1);
    expect(socket.messages().filter((message) => message.type === "resync")).toHaveLength(2);
    expect(fixture.clock.pendingJobs).toBe(0);

    fixture.gateway.shutdown();
    fixture.store.close();
  });

  test("rapid cursors coalesce to one trailing frame with the latest coordinates", () => {
    const fixture = gatewayFixture();
    const first = new FakeSocket();
    const second = new FakeSocket();
    join(fixture.gateway, "first", first, fixture.pad.id, fixture.ownerKey);
    join(fixture.gateway, "second", second, fixture.pad.id, fixture.ownerKey);

    fixture.gateway.message("first", JSON.stringify({ type: "cursor", x: 1, y: 1 }));
    first.clear();
    second.clear();
    fixture.clock.advance(10);
    for (const coordinate of [2, 3, 4]) {
      fixture.gateway.message(
        "first",
        JSON.stringify({ type: "cursor", x: coordinate, y: coordinate }),
      );
    }

    expect(fixture.clock.pendingJobs).toBe(1);
    expect(second.messages().filter((message) => message.type === "cursor")).toEqual([]);
    fixture.clock.advance(CURSOR_MIN_INTERVAL_MS - 10 - 1);
    expect(second.messages().filter((message) => message.type === "cursor")).toEqual([]);
    fixture.clock.advance(1);

    const cursors = second.messages().filter((message) => message.type === "cursor");
    expect(cursors).toHaveLength(1);
    expect(cursors.map((message) => [message.x, message.y])).toEqual([[4, 4]]);
    expect(fixture.clock.pendingJobs).toBe(0);
    fixture.gateway.shutdown();
    fixture.store.close();
  });

  test("closing a connection cancels its pending cursor flush", () => {
    const fixture = gatewayFixture();
    const first = new FakeSocket();
    const second = new FakeSocket();
    join(fixture.gateway, "first", first, fixture.pad.id, fixture.ownerKey);
    join(fixture.gateway, "second", second, fixture.pad.id, fixture.ownerKey);
    fixture.gateway.message("first", JSON.stringify({ type: "cursor", x: 1, y: 1 }));
    second.clear();
    fixture.clock.advance(10);
    fixture.gateway.message("first", JSON.stringify({ type: "cursor", x: 9, y: 9 }));
    expect(fixture.clock.pendingJobs).toBe(1);

    fixture.gateway.close("first");
    expect(fixture.clock.pendingJobs).toBe(0);
    fixture.clock.advance(30);
    expect(second.messages().filter((message) => message.type === "cursor")).toEqual([]);
    fixture.gateway.shutdown();
    fixture.store.close();
  });
});

describe("SessionGateway connection identity", () => {
  test("same-principal peers receive distinct init ids and each other's stamped cursors", () => {
    const fixture = gatewayFixture();
    const first = new FakeSocket();
    const second = new FakeSocket();

    fixture.gateway.open("first", first);
    fixture.gateway.message(
      "first",
      JSON.stringify({
        type: "join",
        padId: fixture.pad.id,
        token: fixture.ownerKey,
        protocolVersion: PROTOCOL_VERSION,
      }),
    );
    fixture.gateway.open("second", second);
    fixture.gateway.message(
      "second",
      JSON.stringify({
        type: "join",
        padId: fixture.pad.id,
        token: fixture.ownerKey,
        protocolVersion: PROTOCOL_VERSION,
      }),
    );

    const firstInit = first.messages().find((message) => message.type === "init");
    const secondInit = second.messages().find((message) => message.type === "init");
    expect(firstInit?.selfConnId).toBe("first");
    expect(secondInit?.selfConnId).toBe("second");
    expect(firstInit?.selfConnId).not.toBe(secondInit?.selfConnId);

    first.clear();
    second.clear();
    fixture.gateway.message("first", JSON.stringify({ type: "cursor", x: 1, y: 2 }));
    fixture.gateway.message("second", JSON.stringify({ type: "cursor", x: 3, y: 4 }));

    expect(
      first.messages().find((message) => message.type === "cursor" && message.connId === "second"),
    ).toMatchObject({
      type: "cursor",
      connId: "second",
      x: 3,
      y: 4,
    });
    expect(
      second.messages().find((message) => message.type === "cursor" && message.connId === "first"),
    ).toMatchObject({
      type: "cursor",
      connId: "first",
      x: 1,
      y: 2,
    });
    fixture.gateway.shutdown();
    fixture.store.close();
  });
});

describe("SessionGateway gesture cadence", () => {
  test("active gestures coalesce while end bypasses the cadence immediately", () => {
    const fixture = gatewayFixture();
    const first = new FakeSocket();
    const second = new FakeSocket();
    join(fixture.gateway, "first", first, fixture.pad.id, fixture.ownerKey);
    join(fixture.gateway, "second", second, fixture.pad.id, fixture.ownerKey);

    const gesture = (phase: "active" | "end", x: number) =>
      JSON.stringify({
        type: "gesture",
        kind: "move",
        phase,
        elementId: "element",
        x,
        y: x,
      });

    fixture.gateway.message("first", gesture("active", 1));
    expect(second.messages().at(-1)).toMatchObject({
      type: "gesture",
      principalId: expect.any(String),
      connId: "first",
      phase: "active",
      x: 1,
    });
    second.clear();

    fixture.clock.advance(10);
    fixture.gateway.message("first", gesture("active", 2));
    fixture.gateway.message("first", gesture("active", 3));
    expect(second.messages()).toEqual([]);
    expect(fixture.clock.pendingJobs).toBe(1);

    fixture.gateway.message("first", gesture("end", 4));
    expect(fixture.clock.pendingJobs).toBe(0);
    expect(second.messages()).toEqual([
      expect.objectContaining({
        type: "gesture",
        connId: "first",
        phase: "end",
        x: 4,
      }),
    ]);
    fixture.clock.advance(30);
    expect(second.messages()).toHaveLength(1);
    fixture.gateway.shutdown();
    fixture.store.close();
  });

  test("a trailing active gesture sends only the newest coordinates", () => {
    const fixture = gatewayFixture();
    const first = new FakeSocket();
    const second = new FakeSocket();
    join(fixture.gateway, "first", first, fixture.pad.id, fixture.ownerKey);
    join(fixture.gateway, "second", second, fixture.pad.id, fixture.ownerKey);
    fixture.gateway.message(
      "first",
      JSON.stringify({
        type: "gesture",
        kind: "resize",
        phase: "active",
        elementId: "element",
        x: 0,
        y: 0,
        width: 10,
        height: 10,
      }),
    );
    second.clear();
    fixture.clock.advance(5);
    for (const width of [20, 30, 40]) {
      fixture.gateway.message(
        "first",
        JSON.stringify({
          type: "gesture",
          kind: "resize",
          phase: "active",
          elementId: "element",
          x: 0,
          y: 0,
          width,
          height: width,
        }),
      );
    }
    fixture.clock.advance(25);

    expect(second.messages()).toEqual([
      expect.objectContaining({ type: "gesture", width: 40, height: 40 }),
    ]);
    fixture.gateway.shutdown();
    fixture.store.close();
  });
});

describe("SessionGateway spectator sockets", () => {
  test("a watching socket is absent from the roster and from pad presence", () => {
    const fixture = gatewayFixture();
    const occupantSocket = new FakeSocket();
    const watcherSocket = new FakeSocket();
    const watcherToken = fixture.auth.mintToken(
      {
        principal: { name: "widget watcher", kind: "human" },
        caps: ["pads:read"],
      },
      fixture.auth.authenticate(fixture.ownerKey),
    ).token;
    join(fixture.gateway, "occupant", occupantSocket, fixture.pad.id, fixture.ownerKey);

    joinSpectator(fixture.gateway, "watcher", watcherSocket, fixture.pad.id, watcherToken);

    // Nobody joined: the occupant hears no roster delta for a watcher.
    expect(occupantSocket.messages()).toEqual([]);
    // The widget avatars read this endpoint's source, so a watcher must not appear in it.
    expect(fixture.rooms.presence()).toEqual([
      {
        padId: fixture.pad.id,
        principals: [expect.objectContaining({ name: "owner" })],
      },
    ]);

    // Reading is the whole point: the watcher still receives the room's fan-out.
    fixture.gateway.message("occupant", JSON.stringify({ type: "cursor", x: 7, y: 9 }));
    expect(watcherSocket.messages()).toEqual([
      expect.objectContaining({ type: "cursor", connId: "occupant", x: 7, y: 9 }),
    ]);

    fixture.gateway.shutdown();
    fixture.store.close();
  });

  test("every write a watching socket attempts is refused while its reads are served", () => {
    const fixture = gatewayFixture();
    const occupantSocket = new FakeSocket();
    const watcherSocket = new FakeSocket();
    join(fixture.gateway, "occupant", occupantSocket, fixture.pad.id, fixture.ownerKey);
    joinSpectator(fixture.gateway, "watcher", watcherSocket, fixture.pad.id, fixture.ownerKey);

    const writes = [
      { type: "doc_update", update: "AA==" },
      { type: "presence", payload: { focus: null } },
      { type: "cursor", x: 1, y: 1 },
      { type: "gesture", kind: "move", phase: "active", elementId: "element", x: 1, y: 1 },
      { type: "terminal_open", elementId: "element", cols: 80, rows: 24 },
      { type: "terminal_input", sessionId: "session", data: "AA==" },
      { type: "terminal_resize", sessionId: "session", cols: 80, rows: 24 },
      { type: "terminal_take", sessionId: "session" },
      { type: "terminal_kill", sessionId: "session" },
    ];
    for (const write of writes) {
      watcherSocket.clear();
      fixture.gateway.message("watcher", JSON.stringify(write));
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

    // Recovery and keepalive stay open, or a dropped preview could never resync.
    watcherSocket.clear();
    fixture.gateway.message("watcher", JSON.stringify({ type: "resync_request" }));
    fixture.gateway.message("watcher", JSON.stringify({ type: "ping" }));
    expect(watcherSocket.messages().map((message) => message.type)).toEqual(["resync", "pong"]);

    fixture.gateway.shutdown();
    fixture.store.close();
  });
});
