import { describe, expect, spyOn, test } from "bun:test";
import {
  MAX_DOC_UPDATE_BYTES,
  type Pad,
  type Principal,
  type SceneElement,
} from "@manifold/protocol";
import {
  LOCAL_ORIGIN,
  Y,
  createSceneDoc,
  decodeUpdate,
  elementsMap,
  encodeUpdate,
  readElement,
  readElements,
  writeElement,
} from "@manifold/scene";
import type { AuthContext } from "../src/auth.ts";
import { openDatabase } from "../src/db.ts";
import { silentLogger } from "../src/log.ts";
import { Room, RoomManager } from "../src/room.ts";
import { SessionPeer } from "../src/session-peer.ts";
import { ServerStore, type DocRecord } from "../src/stores.ts";
import { FakeClock, FakeRuntime, FakeSocket, testStore } from "./helpers.ts";

interface CountRow {
  count: number;
}

class FailingDocStore extends ServerStore {
  readonly failingPads = new Set<string>();

  override saveDoc(
    padId: string,
    epoch: string,
    rev: number,
    ts: number,
    doc: Uint8Array,
  ): DocRecord {
    if (this.failingPads.has(padId)) throw new Error("injected document failure");
    return super.saveDoc(padId, epoch, rev, ts, doc);
  }
}

function terminal(id = "element-1", patch: Partial<SceneElement> = {}): SceneElement {
  return {
    id,
    type: "terminal",
    sessionId: `session-${id}`,
    x: 0,
    y: 0,
    width: 720,
    height: 480,
    zIndex: 0,
    ...patch,
  } as SceneElement;
}

function encodedElements(...elements: SceneElement[]): string {
  const doc = createSceneDoc();
  for (const element of elements) writeElement(doc, element, LOCAL_ORIGIN);
  return encodeUpdate(Y.encodeStateAsUpdate(doc));
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

describe("Room Yjs document consistency", () => {
  test("init carries a complete encoded document", () => {
    const store = testStore();
    const runtime = new FakeRuntime();
    const pad: Pad = { id: runtime.newId(), name: "persisted", createdAt: 0 };
    store.createPad(pad);
    const saved = createSceneDoc();
    writeElement(saved, terminal("persisted"), LOCAL_ORIGIN);
    store.saveDoc(pad.id, "epoch-saved", 4, 1, Y.encodeStateAsUpdate(saved));

    const principal: Principal = {
      id: runtime.newId(),
      kind: "human",
      name: "viewer",
      color: "#2563eb",
    };
    store.createPrincipal(principal, 0);
    const peer = new SessionPeer(
      runtime.newId(),
      new FakeSocket(),
      { principal, caps: ["*"], padScope: null, isRoot: true, tokenId: null },
      pad.id,
    );
    const socket = peer.socket as FakeSocket;
    const room = new Room(
      pad.id,
      store,
      runtime,
      new FakeClock(runtime),
      silentLogger,
      () => [],
      () => {},
    );
    room.join(peer);

    const init = socket.messages()[0];
    if (init?.type !== "init") throw new Error("missing init");
    const decoded = createSceneDoc();
    Y.applyUpdate(decoded, decodeUpdate(init.doc));
    expect(init.epoch).toBe("epoch-saved");
    expect(init.rev).toBe(4);
    expect(readElement(decoded, "persisted")).toEqual(terminal("persisted"));
    store.close();
  });

  test("accepted updates are echoed with server-stamped authorship", () => {
    const fixture = roomFixture();
    const update = encodedElements(terminal());
    expect(fixture.room.applyDocUpdate(fixture.peer, update)).toBeTrue();

    expect(fixture.room.rev).toBe(1);
    expect(readElement(fixture.room.doc, "element-1")).toEqual(terminal());
    const messages = fixture.socket.messages();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: "doc_update",
      by: fixture.peer.auth.principal.id,
    });

    fixture.socket.clear();
    fixture.room.applyDocUpdate(fixture.peer, update);
    expect(fixture.room.rev).toBe(1);
    expect(fixture.socket.messages()).toEqual([]);
    fixture.store.close();
  });

  test("schema-invalid records are accepted then repaired for every peer", () => {
    const fixture = roomFixture();
    const malicious = createSceneDoc();
    const invalid = new Y.Map<unknown>();
    invalid.set("id", "invalid");
    invalid.set("type", "terminal");
    elementsMap(malicious).set("invalid", invalid);
    const warned = spyOn(silentLogger, "warn");
    try {
      fixture.room.applyDocUpdate(fixture.peer, encodeUpdate(Y.encodeStateAsUpdate(malicious)));

      expect(elementsMap(fixture.room.doc).has("invalid")).toBeFalse();
      expect(fixture.room.rev).toBe(2);
      expect(fixture.socket.messages().map((message) => message.type)).toEqual([
        "doc_update",
        "doc_update",
      ]);
      expect(fixture.socket.messages()[1]).toMatchObject({ by: "server" });
      expect(warned).toHaveBeenCalledWith("scene_element_repaired", {
        padId: fixture.pad.id,
        id: "invalid",
      });
    } finally {
      warned.mockRestore();
      fixture.store.close();
    }
  });

  test("oversized and malformed updates are rejected without broadcast", () => {
    const fixture = roomFixture();
    fixture.room.applyDocUpdate(
      fixture.peer,
      encodeUpdate(new Uint8Array(MAX_DOC_UPDATE_BYTES + 1)),
    );
    fixture.room.applyDocUpdate(fixture.peer, encodeUpdate(Uint8Array.of(255, 255)));

    expect(fixture.room.rev).toBe(0);
    expect(readElements(fixture.room.doc).size).toBe(0);
    expect(fixture.socket.messages()).toEqual([
      { type: "error", code: "invalid", message: "doc update too large" },
      { type: "error", code: "invalid", message: "invalid doc update" },
    ]);
    fixture.store.close();
  });

  test("per-connection document update burst is bounded", () => {
    const fixture = roomFixture();
    const update = encodedElements(terminal());
    for (let index = 0; index < 241; index += 1) {
      fixture.room.applyDocUpdate(fixture.peer, update);
    }

    expect(fixture.socket.messages().at(-1)).toEqual({
      type: "error",
      code: "rate_limited",
      message: "doc update rate limit exceeded",
    });
    fixture.store.close();
  });

  test("terminal references are read from validated document elements", () => {
    const fixture = roomFixture();
    fixture.room.applyDocUpdate(fixture.peer, encodedElements(terminal("term")));
    expect(fixture.room.referencesSession("session-term")).toBeTrue();
    expect(fixture.room.referencesSession("missing")).toBeFalse();
    fixture.store.close();
  });
});

describe("Room document persistence", () => {
  test("quiet cadence saves the complete Yjs document and broadcasts saved", () => {
    const fixture = roomFixture();
    fixture.room.applyDocUpdate(fixture.peer, encodedElements(terminal("quiet")));
    expect(
      fixture.store.db.query<CountRow, []>("SELECT COUNT(*) AS count FROM scene_docs").get()?.count,
    ).toBe(0);

    fixture.clock.advance(1_500);
    const record = fixture.store.latestDoc(fixture.pad.id);
    expect(record?.rev).toBe(1);
    const restored = createSceneDoc();
    Y.applyUpdate(restored, record?.doc ?? new Uint8Array());
    expect(readElement(restored, "quiet")).toEqual(terminal("quiet"));
    expect(fixture.socket.messages().at(-1)?.type).toBe("saved");
    fixture.store.close();
  });

  test("a failed debounced save stays isolated and retries", () => {
    const store = new FailingDocStore(openDatabase(":memory:"));
    const fixture = roomFixture(store);
    store.failingPads.add(fixture.pad.id);
    fixture.room.applyDocUpdate(fixture.peer, encodedElements(terminal("retry")));

    expect(() => fixture.clock.advance(1_500)).not.toThrow();
    expect(store.latestDoc(fixture.pad.id)).toBeNull();
    store.failingPads.delete(fixture.pad.id);
    fixture.clock.advance(1_500);
    expect(store.latestDoc(fixture.pad.id)?.rev).toBe(1);
    store.close();
  });

  test("last leave flushes and evicts an idle managed room", () => {
    const runtime = new FakeRuntime();
    const clock = new FakeClock(runtime);
    const store = testStore();
    const pad: Pad = { id: runtime.newId(), name: "evict", createdAt: 0 };
    store.createPad(pad);
    const principal: Principal = {
      id: runtime.newId(),
      kind: "human",
      name: "evictor",
      color: "#2563eb",
    };
    store.createPrincipal(principal, 0);
    const manager = new RoomManager(store, runtime, clock, silentLogger);
    const room = manager.get(pad.id);
    if (room === null) throw new Error("missing room");
    const peer = new SessionPeer(
      runtime.newId(),
      new FakeSocket(),
      { principal, caps: ["*"], padScope: null, isRoot: true, tokenId: null },
      pad.id,
    );
    room.join(peer);
    room.applyDocUpdate(peer, encodedElements(terminal("before-leave")));

    room.leave(peer);
    expect(manager.introspect()).toHaveLength(0);
    expect(store.latestDoc(pad.id)?.rev).toBe(1);
    store.close();
  });
});
