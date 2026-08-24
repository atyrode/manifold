import { describe, expect, test } from "bun:test";
import type { Pad, Principal, SceneElement } from "@manifold/protocol";
import type { AuthContext } from "../src/auth.ts";
import { silentLogger } from "../src/log.ts";
import { Room } from "../src/room.ts";
import { SessionPeer } from "../src/session-peer.ts";
import { FakeClock, FakeRuntime, FakeSocket, testStore } from "./helpers.ts";

interface CountRow {
  count: number;
}

function roomFixture() {
  const runtime = new FakeRuntime();
  const clock = new FakeClock(runtime);
  const store = testStore();
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
  const room = new Room(pad.id, store, runtime, clock, silentLogger, () => []);
  room.join(peer);
  socket.clear();
  return { runtime, clock, store, pad, socket, peer, room };
}

function element(version: number): SceneElement {
  return { id: "element-1", version, versionNonce: 7, isDeleted: false };
}

describe("Room scene consistency", () => {
  test("epoch fence emits epoch_mismatch plus resync without mutation", () => {
    const fixture = roomFixture();
    fixture.room.applyUpdate(fixture.peer, {
      type: "scene_update",
      updateId: "wrong-epoch",
      epoch: "stale",
      baseRev: 0,
      elements: [element(1)],
    });

    expect(fixture.room.rev).toBe(0);
    expect(fixture.room.scene.size).toBe(0);
    const messages = fixture.socket.messages();
    expect(messages.map((message) => message.type)).toEqual(["error", "resync"]);
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
