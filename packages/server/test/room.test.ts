import { describe, expect, spyOn, test } from "bun:test";
import type { Pad, Principal, SceneElement } from "@manifold/protocol";
import type { AuthContext } from "../src/auth.ts";
import { openDatabase } from "../src/db.ts";
import { silentLogger, type Logger } from "../src/log.ts";
import { Room, RoomManager, SCENE_BYTES_LIMIT } from "../src/room.ts";
import { serializeServerMessage, SessionPeer } from "../src/session-peer.ts";
import { ServerStore, type SnapshotRecord } from "../src/stores.ts";
import { FakeClock, FakeRuntime, FakeSocket, testStore } from "./helpers.ts";

interface CountRow {
  count: number;
}

class FailingSnapshotStore extends ServerStore {
  readonly failingPads = new Set<string>();

  override saveSnapshot(
    padId: string,
    epoch: string,
    rev: number,
    ts: number,
    elements: readonly SceneElement[],
  ): SnapshotRecord {
    if (this.failingPads.has(padId)) throw new Error("injected snapshot failure");
    return super.saveSnapshot(padId, epoch, rev, ts, elements);
  }
}

function roomFixture(store: ServerStore = testStore()) {
  const runtime = new FakeRuntime();
  const clock = new FakeClock(runtime);
  const pad: Pad = { id: runtime.newId(), name: "test pad", createdAt: runtime.now() };
  store.createPad(pad);
  const principal: Principal = {
    id: runtime.newId(),
    kind: "human",
    name: "tester",
    color: "#2563eb",
  };
  store.createPrincipal(principal, runtime.now());
  const context: AuthContext = {
    principal,
    caps: ["*"],
    padScope: null,
    isRoot: true,
    tokenId: null,
  };
  const socket = new FakeSocket();
  const peer = new SessionPeer(runtime.newId(), socket, context, pad.id);
  const room = new Room(
    pad.id,
    store,
    runtime,
    clock,
    silentLogger,
    () => [],
    () => {},
  );
  room.join(peer);
  socket.clear();
  return { runtime, clock, store, pad, socket, peer, room };
}

function element(version: number, id = "element-1"): SceneElement {
  return {
    id,
    type: "terminal",
    sessionId: `session-${id}`,
    x: 0,
    y: 0,
    width: 720,
    height: 480,
    zIndex: 0,
    version,
    versionNonce: 7,
    isDeleted: false,
  };
}
function sceneAtLeastBytes(minimumBytes: number): SceneElement[] {
  const elements: SceneElement[] = [];
  let bytes = 2;
  for (let index = 0; bytes < minimumBytes; index += 1) {
    const suffix = index.toString(36);
    const record: SceneElement = {
      ...element(1, `element-${suffix}`),
      sessionId: `session-${suffix}-${"s".repeat(112)}`,
      x: 9_999_999_999,
      y: -9_999_999_999,
      zIndex: index,
      versionNonce: index,
    };
    elements.push(record);
    bytes += Buffer.byteLength(JSON.stringify(record)) + (elements.length === 1 ? 0 : 1);
  }
  return elements;
}

describe("Room scene consistency", () => {
  test("epoch fence emits epoch_mismatch without mutating canonical state", () => {
    const fixture = roomFixture();
    const handled = fixture.room.applyUpdate(fixture.peer, {
      type: "scene_update",
      updateId: "wrong-epoch",
      epoch: "stale",
      baseRev: 0,
      elements: [element(1)],
    });

    expect(handled).toBe(false);
    expect(fixture.room.rev).toBe(0);
    expect(fixture.room.scene.size).toBe(0);
    const messages = fixture.socket.messages();
    expect(messages.map((message) => message.type)).toEqual(["error"]);
    const error = messages[0];
    expect(error?.type).toBe("error");
    if (error?.type === "error") expect(error.code).toBe("epoch_mismatch");
    fixture.store.close();
  });

  test("rev advances only when reconciliation accepts a nonempty batch", () => {
    const fixture = roomFixture();
    fixture.room.applyUpdate(fixture.peer, {
      type: "scene_update",
      updateId: "accepted",
      epoch: fixture.room.epoch,
      baseRev: 0,
      elements: [element(1)],
    });
    expect(fixture.room.rev).toBe(1);

    fixture.socket.clear();
    fixture.room.applyUpdate(fixture.peer, {
      type: "scene_update",
      updateId: "duplicate",
      epoch: fixture.room.epoch,
      baseRev: 1,
      elements: [element(1)],
    });
    expect(fixture.room.rev).toBe(1);
    const messages = fixture.socket.messages();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({
      type: "scene_ack",
      updateId: "duplicate",
      rev: 1,
      acceptedIds: [],
    });
    fixture.store.close();
  });
});

describe("Room snapshot cadence", () => {
  test("saves exactly after 1.5 seconds of quiet", () => {
    const fixture = roomFixture();
    fixture.room.applyUpdate(fixture.peer, {
      type: "scene_update",
      updateId: "quiet",
      epoch: fixture.room.epoch,
      baseRev: 0,
      elements: [element(1)],
    });
    fixture.clock.advance(1_499);
    const before = fixture.store.db
      .query<CountRow, []>("SELECT COUNT(*) AS count FROM snapshots")
      .get();
    expect(before?.count).toBe(0);

    fixture.clock.advance(1);
    const after = fixture.store.db
      .query<CountRow, []>("SELECT COUNT(*) AS count FROM snapshots")
      .get();
    expect(after?.count).toBe(1);
    expect(fixture.store.latestSnapshot(fixture.pad.id)?.rev).toBe(1);
    expect(fixture.socket.messages().at(-1)?.type).toBe("saved");
    fixture.store.close();
  });

  test("forces a save at ten seconds under sustained edits", () => {
    const fixture = roomFixture();
    fixture.room.applyUpdate(fixture.peer, {
      type: "scene_update",
      updateId: "u1",
      epoch: fixture.room.epoch,
      baseRev: 0,
      elements: [element(1)],
    });
    for (let version = 2; version <= 10; version += 1) {
      fixture.clock.advance(1_000);
      fixture.room.applyUpdate(fixture.peer, {
        type: "scene_update",
        updateId: `u${version}`,
        epoch: fixture.room.epoch,
        baseRev: fixture.room.rev,
        elements: [element(version)],
      });
    }
    fixture.clock.advance(999);
    expect(fixture.store.latestSnapshot(fixture.pad.id)).toBeNull();
    fixture.clock.advance(1);
    expect(fixture.store.latestSnapshot(fixture.pad.id)?.rev).toBe(10);
    fixture.store.close();
  });
});

describe("Room failure isolation and residency", () => {
  test("a debounced snapshot failure stays inside its timer and retries", () => {
    const store = new FailingSnapshotStore(openDatabase(":memory:"));
    const fixture = roomFixture(store);
    store.failingPads.add(fixture.pad.id);
    fixture.room.applyUpdate(fixture.peer, {
      type: "scene_update",
      updateId: "will-retry",
      epoch: fixture.room.epoch,
      baseRev: 0,
      elements: [element(1)],
    });

    expect(() => fixture.clock.advance(1_500)).not.toThrow();
    expect(store.latestSnapshot(fixture.pad.id)).toBeNull();
    store.failingPads.delete(fixture.pad.id);
    fixture.clock.advance(1_500);
    expect(store.latestSnapshot(fixture.pad.id)?.rev).toBe(1);
    store.close();
  });

  test("flushAll persists later rooms after an earlier room throws", () => {
    const runtime = new FakeRuntime();
    const clock = new FakeClock(runtime);
    const store = new FailingSnapshotStore(openDatabase(":memory:"));
    const principal: Principal = {
      id: runtime.newId(),
      kind: "human",
      name: "shutdown tester",
      color: "#2563eb",
    };
    store.createPrincipal(principal, runtime.now());
    const auth: AuthContext = {
      principal,
      caps: ["*"],
      padScope: null,
      isRoot: true,
      tokenId: null,
    };
    const manager = new RoomManager(store, runtime, clock, silentLogger);
    const pads: Pad[] = [
      { id: runtime.newId(), name: "failing", createdAt: runtime.now() },
      { id: runtime.newId(), name: "healthy", createdAt: runtime.now() },
    ];
    for (const pad of pads) store.createPad(pad);
    const rooms = pads.map((pad) => {
      const room = manager.get(pad.id);
      if (room === null) throw new Error("missing room");
      const peer = new SessionPeer(runtime.newId(), new FakeSocket(), auth, pad.id);
      room.join(peer);
      room.applyUpdate(peer, {
        type: "scene_update",
        updateId: `update-${pad.id}`,
        epoch: room.epoch,
        baseRev: 0,
        elements: [{ ...element(1), id: `element-${pad.id}` }],
      });
      return room;
    });
    const failingPad = pads[0];
    const healthyPad = pads[1];
    if (failingPad === undefined || healthyPad === undefined) throw new Error("missing pad");
    store.failingPads.add(failingPad.id);

    expect(() => manager.flushAll()).not.toThrow();
    expect(store.latestSnapshot(failingPad.id)).toBeNull();
    expect(store.latestSnapshot(healthyPad.id)?.rev).toBe(rooms[1]?.rev);
    store.close();
  });

  test("last leave flushes and evicts when no running session references the room", () => {
    const runtime = new FakeRuntime();
    const clock = new FakeClock(runtime);
    const store = testStore();
    const pad: Pad = { id: runtime.newId(), name: "evict", createdAt: runtime.now() };
    store.createPad(pad);
    const principal: Principal = {
      id: runtime.newId(),
      kind: "human",
      name: "evictor",
      color: "#2563eb",
    };
    store.createPrincipal(principal, runtime.now());
    const auth: AuthContext = {
      principal,
      caps: ["*"],
      padScope: null,
      isRoot: true,
      tokenId: null,
    };
    const manager = new RoomManager(store, runtime, clock, silentLogger);
    const room = manager.get(pad.id);
    if (room === null) throw new Error("missing room");
    const peer = new SessionPeer(runtime.newId(), new FakeSocket(), auth, pad.id);
    room.join(peer);
    room.applyUpdate(peer, {
      type: "scene_update",
      updateId: "dirty-before-leave",
      epoch: room.epoch,
      baseRev: 0,
      elements: [element(1)],
    });

    room.leave(peer);
    expect(manager.introspect()).toHaveLength(0);
    expect(store.latestSnapshot(pad.id)?.rev).toBe(1);
    store.close();
  });
});

describe("Room bounded authoritative state", () => {
  test("an init larger than the old 1 MiB queue cap is delivered without closing", () => {
    const fixture = roomFixture();
    const large = sceneAtLeastBytes(1_100_000);
    fixture.store.saveSnapshot(fixture.pad.id, "large-epoch", 4, 1, large);
    const socket = new FakeSocket();
    const peer = new SessionPeer(
      fixture.runtime.newId(),
      socket,
      fixture.peer.auth,
      fixture.pad.id,
    );
    const room = new Room(
      fixture.pad.id,
      fixture.store,
      fixture.runtime,
      fixture.clock,
      silentLogger,
      () => [],
      () => {},
    );

    room.join(peer);
    expect(Buffer.byteLength(socket.sent[0] ?? "")).toBeGreaterThan(1_048_576);
    expect(socket.messages()[0]?.type).toBe("init");
    expect(socket.closed).toBeNull();
    fixture.store.close();
  });

  test("a scene update that would exceed the canonical hard limit is rejected", () => {
    const fixture = roomFixture();
    const nearLimit = sceneAtLeastBytes(SCENE_BYTES_LIMIT - 100);
    fixture.store.saveSnapshot(fixture.pad.id, "bounded-epoch", 3, 1, nearLimit);
    const socket = new FakeSocket();
    const peer = new SessionPeer(
      fixture.runtime.newId(),
      socket,
      fixture.peer.auth,
      fixture.pad.id,
    );
    const room = new Room(
      fixture.pad.id,
      fixture.store,
      fixture.runtime,
      fixture.clock,
      silentLogger,
      () => [],
      () => {},
    );
    room.applyUpdate(peer, {
      type: "scene_update",
      updateId: "too-large",
      epoch: room.epoch,
      baseRev: room.rev,
      elements: [element(1, "overflow")],
    });

    expect(room.rev).toBe(3);
    expect([...room.scene.values()]).toEqual(nearLimit);
    expect(socket.messages()).toEqual([
      {
        type: "error",
        code: "invalid",
        message: "scene too large",
        ref: "too-large",
      },
      {
        type: "scene_ack",
        updateId: "too-large",
        rev: 3,
        acceptedIds: [],
      },
    ]);
    fixture.store.close();
  });
});

describe("Room snapshot recovery and fanout", () => {
  test("a corrupt latest snapshot falls back to the next older valid revision", () => {
    const fixture = roomFixture();
    fixture.store.saveSnapshot(fixture.pad.id, "epoch", 1, 1, [element(1)]);
    fixture.store.saveSnapshot(fixture.pad.id, "epoch", 2, 2, [element(2)]);
    fixture.store.db
      .query<void, [string, number]>(
        "UPDATE snapshots SET blob = 'corrupt' WHERE pad_id = ? AND rev = ?",
      )
      .run(fixture.pad.id, 2);
    const socket = new FakeSocket();
    const peer = new SessionPeer(
      fixture.runtime.newId(),
      socket,
      fixture.peer.auth,
      fixture.pad.id,
    );
    const recovered = new Room(
      fixture.pad.id,
      fixture.store,
      fixture.runtime,
      fixture.clock,
      silentLogger,
      () => [],
      () => {},
    );

    recovered.join(peer);
    expect(recovered.rev).toBe(1);
    expect(recovered.scene.get("element-1")?.version).toBe(1);
    expect(socket.messages()[0]?.type).toBe("init");
    fixture.store.close();
  });

  test("broadcast validates and serializes once for multiple peers", () => {
    const fixture = roomFixture();
    for (let index = 0; index < 2; index += 1) {
      const socket = new FakeSocket();
      const peer = new SessionPeer(
        fixture.runtime.newId(),
        socket,
        fixture.peer.auth,
        fixture.pad.id,
      );
      fixture.room.join(peer);
      socket.clear();
    }
    serializeServerMessage({ type: "pong" });
    const stringify = spyOn(JSON, "stringify");
    serializeServerMessage({ type: "pong" });
    const singleSerializationCalls = stringify.mock.calls.length;
    stringify.mockClear();
    fixture.room.broadcast({ type: "pong" });
    const broadcastCalls = stringify.mock.calls.length;
    stringify.mockRestore();

    expect(broadcastCalls).toBe(singleSerializationCalls);
    fixture.store.close();
  });
});

test("an over-ceiling init rolls back membership, emits an error, and closes 1009", () => {
  const fixture = roomFixture();
  const errors: string[] = [];
  const logger: Logger = {
    info(): void {},
    warn(): void {},
    error(evt): void {
      errors.push(evt);
    },
  };
  const room = new Room(
    fixture.pad.id,
    fixture.store,
    fixture.runtime,
    fixture.clock,
    logger,
    () => [],
    () => {},
  );
  const observerSocket = new FakeSocket();
  const observer = new SessionPeer(
    fixture.runtime.newId(),
    observerSocket,
    fixture.peer.auth,
    fixture.pad.id,
  );
  expect(room.join(observer)).toBe(true);
  observerSocket.clear();
  for (const element of sceneAtLeastBytes(17 * 1_048_576)) {
    room.scene.set(element.id, element);
  }
  const socket = new FakeSocket();
  const peer = new SessionPeer(fixture.runtime.newId(), socket, fixture.peer.auth, fixture.pad.id);

  expect(room.join(peer)).toBe(false);
  expect(socket.messages()).toEqual([
    {
      type: "error",
      code: "invalid",
      message: "scene too large to initialize",
    },
  ]);
  expect(socket.closed).toMatchObject({ code: 1009 });
  expect(observerSocket.messages()).toEqual([]);
  expect(room.introspect()).toMatchObject({ principals: 1, connections: 1 });
  expect(errors).toContain("scene_state_exceeds_transport");
  fixture.store.close();
});
