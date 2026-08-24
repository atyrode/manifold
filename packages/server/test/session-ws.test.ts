import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION, type Pad } from "@manifold/protocol";
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
  const pad: Pad = { id: runtime.newId(), name: "sync pad", createdAt: runtime.now() };
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
  return { runtime, clock, store, ownerKey, pad, gateway };
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
    fixture.clock.advance(19);
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

describe("SessionGateway automatic resync cadence", () => {
  test("rapid epoch-mismatched updates share the one-per-second resync gate", () => {
    const fixture = gatewayFixture();
    const socket = new FakeSocket();
    join(fixture.gateway, "peer", socket, fixture.pad.id, fixture.ownerKey);

    const sendMismatch = (index: number): void => {
      fixture.gateway.message(
        "peer",
        JSON.stringify({
          type: "scene_update",
          updateId: `mismatch-${index}`,
          epoch: "wrong-epoch",
          baseRev: 0,
          elements: [
            {
              id: "element",
              version: index + 1,
              versionNonce: 1,
              isDeleted: false,
            },
          ],
        }),
      );
    };
    for (let index = 0; index < 300; index += 1) sendMismatch(index);

    expect(socket.messages().filter((message) => message.type === "resync")).toHaveLength(1);
    expect(socket.messages().filter((message) => message.type === "error")).toHaveLength(300);
    fixture.clock.advance(999);
    sendMismatch(300);
    expect(socket.messages().filter((message) => message.type === "resync")).toHaveLength(1);
    fixture.clock.advance(1);
    sendMismatch(301);
    expect(socket.messages().filter((message) => message.type === "resync")).toHaveLength(2);
    fixture.gateway.shutdown();
    fixture.store.close();
  });
});
