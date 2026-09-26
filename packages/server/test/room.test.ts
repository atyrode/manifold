import { describe, expect, spyOn, test } from "bun:test";
import {
  MAX_DOC_UPDATE_BYTES,
  ROOT_TILE_ID,
  censusSolo,
  type Container,
  type ContainerDiscipline,
  type LocationPath,
  type Principal,
  type SceneElement,
} from "@manifold/protocol";
import type { ElementPayloadRefusal } from "@manifold/plugin";
import {
  LOCAL_ORIGIN,
  Y,
  createSceneDoc,
  decodeUpdate,
  elementsMap,
  encodeUpdate,
  patchElement,
  readElement,
  readElements,
  writeElement,
} from "@manifold/scene";
import type { AuthContext } from "../src/auth.ts";
import { openDatabase } from "../src/db.ts";
import { silentLogger } from "../src/log.ts";
import { Room, RoomManager } from "../src/room.ts";
import { SessionChannel } from "../src/session-channel.ts";
import { ServerStore, type DocRecord } from "../src/stores.ts";
import { FakeClock, FakeRuntime, FakeSocket, testStore, testTileTrees } from "./helpers.ts";

interface CountRow {
  count: number;
}

class FailingDocStore extends ServerStore {
  readonly failingContainers = new Set<string>();

  override saveDoc(
    containerId: string,
    epoch: string,
    rev: number,
    ts: number,
    doc: Uint8Array,
  ): DocRecord {
    if (this.failingContainers.has(containerId)) throw new Error("injected document failure");
    return super.saveDoc(containerId, epoch, rev, ts, doc);
  }
}

/**
 * A canvas element referencing a container. Since the cutover this is the ONLY way a canvas
 * names anything that lives elsewhere — a terminal included, through the composition that
 * homes it — so it is also the element these transport tests carry around.
 */
function portal(id = "element-1", patch: Partial<SceneElement> = {}): SceneElement {
  return {
    id,
    type: "portal",
    containerId: `container-${id}`,
    x: 0,
    y: 0,
    width: 720,
    height: 480,
    zIndex: 0,
    ...patch,
  } as SceneElement;
}

/** Canvas furniture: an element that lives here rather than referencing something else. */
function note(id: string, patch: Partial<SceneElement> = {}): SceneElement {
  return {
    id,
    type: "text",
    text: "hello",
    fontSize: 16,
    color: "#2563eb",
    x: 0,
    y: 0,
    width: 200,
    height: 100,
    zIndex: 0,
    ...patch,
  } as SceneElement;
}

function encodedElements(...elements: SceneElement[]): string {
  const doc = createSceneDoc();
  for (const element of elements) writeElement(doc, element, LOCAL_ORIGIN);
  return encodeUpdate(Y.encodeStateAsUpdate(doc));
}

function roomFixture(
  store: ServerStore = testStore(),
  discipline: ContainerDiscipline = "canvas",
  /**
   * The element-payload boundary (ADR 0013 §16). Accept-all by default, because these fixtures
   * compose no plugins and nothing declares a payload schema — the same state a production room
   * is in before the assembly is wired. A case that is ABOUT the boundary supplies a real one.
   */
  payloadRefusal: (element: SceneElement) => ElementPayloadRefusal | null = () => null,
) {
  const runtime = new FakeRuntime();
  const clock = new FakeClock(runtime);
  const container: Container = {
    id: runtime.newId(),
    name: "test container",
    createdAt: runtime.now(),
    discipline,
  };
  store.createContainer(container);
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
    containerScope: null,
    tokenId: null,
    grantId: null,
  };
  const socket = new FakeSocket();
  const peer = new SessionChannel(runtime.newId(), socket, context, container.id, "c1");
  // The ninth argument is the element-payload boundary (ADR 0013 §16), the tenth is the
  // attendance announcement (ADR 0012) and the eleventh is whether this container holds a tile
  // tree (#125). These fixtures compose no plugins, so nothing declares a payload schema and
  // the honest stand-in accepts every record; the announcement writes straight to the durable
  // trail, which is what an unwired production room does until the assembly and the event
  // plane arrive. The tree question is answered by the SHIPPED declarations, because a
  // fixture that spelled it would seed roots the server does not.
  let joinOrder = 0;
  const room = new Room(
    container.id,
    container.discipline,
    store,
    runtime,
    clock,
    silentLogger,
    () => [],
    () => {},
    payloadRefusal,
    (containerId, principalId, kind) => {
      store.addEvent(containerId, runtime.now(), principalId, kind, {});
    },
    testTileTrees(discipline),
    () => ++joinOrder,
  );
  room.join(peer);
  socket.clear();
  return { runtime, clock, store, container, socket, peer, room };
}

describe("Room congested recipients", () => {
  function joinRecipient(fixture: ReturnType<typeof roomFixture>, socket = new FakeSocket()) {
    const peer = new SessionChannel(
      fixture.runtime.newId(),
      socket,
      fixture.peer.auth,
      fixture.container.id,
      "recipient",
    );
    fixture.room.join(peer);
    socket.clear();
    return { peer, socket };
  }

  test("one recovery converges the document and interleaved presence without losing local edits", () => {
    const fixture = roomFixture();
    const { room, peer, socket, store } = fixture;
    const tab = joinRecipient(fixture);
    const slow = joinRecipient(fixture);
    const local = createSceneDoc();
    const healthy = createSceneDoc();
    try {
      Y.applyUpdate(local, Y.encodeStateAsUpdate(room.doc));
      writeElement(local, note("unsent-local"), LOCAL_ORIGIN);
      socket.clear();
      slow.socket.bufferedAmount = 1;
      room.updatePresence(peer, { status: "active", cursor: { x: 1, y: 1 } });
      room.updatePresence(tab.peer, { status: "done", cursor: { x: 2, y: 2 } });
      room.applyDocUpdate(peer, encodedElements(note("canonical")));
      for (let index = 0; index < 400; index += 1) {
        patchElement(room.doc, "canonical", { x: index }, LOCAL_ORIGIN);
        room.updatePresence(peer, { selection: [`selection-${index}`] });
      }
      room.updatePresence(peer, { cursor: null });
      expect(slow.peer.isClosed).toBe(false);
      expect(slow.socket.messages()).toEqual([]);

      // A healthy recipient continues to consume ordinary deltas, with no scene resets.
      for (const message of socket.messages()) {
        expect(message.type).not.toBe("resync");
        if (message.type === "doc_update") Y.applyUpdate(healthy, decodeUpdate(message.update));
      }
      expect(readElement(healthy, "canonical")?.x).toBe(399);
      slow.socket.bufferedAmount = 0;
      slow.peer.drain();
      const messages = slow.socket.messages();
      expect(messages.map((message) => message.type)).toEqual([
        "doc_update",
        "presence",
        "presence",
        "presence",
      ]);
      const delta = messages[0];
      if (delta?.type !== "doc_update") throw new Error("missing incremental recovery");
      Y.applyUpdate(local, decodeUpdate(delta.update));
      expect(readElement(local, "canonical")).toEqual(readElement(room.doc, "canonical"));
      expect(readElement(local, "unsent-local")?.text).toBe("hello");
      expect(messages[3]).toMatchObject({
        payload: { status: "done", selection: ["selection-399"] },
      });
      expect(messages.slice(1, 3)).toEqual([
        {
          type: "presence",
          principalId: peer.auth.principal.id,
          connId: tab.peer.id,
          payload: { cursor: { x: 2, y: 2 } },
        },
        {
          type: "presence",
          principalId: peer.auth.principal.id,
          connId: peer.id,
          payload: { cursor: null },
        },
      ]);
    } finally {
      room.closeAll(1000, "test complete");
      local.destroy();
      healthy.destroy();
      store.close();
    }
  });

  test("repeated congestion respects recovery cadence and motion cannot overtake retained state", () => {
    const fixture = roomFixture();
    const { room, peer, clock, store } = fixture;
    const slow = joinRecipient(fixture);
    try {
      slow.socket.bufferedAmount = 1;
      room.updatePresence(peer, { selection: ["first"] });
      slow.socket.bufferedAmount = 0;
      slow.peer.drain();
      expect(slow.socket.messages()).toEqual([
        {
          type: "presence",
          principalId: peer.auth.principal.id,
          connId: peer.id,
          payload: { selection: ["first"] },
        },
      ]);
      slow.socket.clear();

      slow.socket.bufferedAmount = 1;
      room.updatePresence(peer, { selection: ["second"], cursor: null });
      slow.socket.bufferedAmount = 0;
      slow.peer.drain();
      const gesture = {
        type: "gesture",
        kind: "move",
        phase: "end",
        elementId: "moving",
        x: 9,
        y: 4,
      } as const;
      room.relayCursor(peer, {
        x: 8,
        y: 3,
        type: "cursor",
      });
      room.relayGesture(peer, gesture);
      clock.advance(99);
      expect(slow.socket.messages()).toEqual([]);
      clock.advance(1);
      expect(slow.socket.messages().map((message) => message.type)).toEqual([
        "presence",
        "presence",
      ]);
      slow.socket.clear();
      room.relayCursor(peer, {
        x: 10,
        y: 5,
        type: "cursor",
      });
      room.relayGesture(peer, gesture);
      expect(slow.socket.messages()).toEqual([
        { type: "cursor", principalId: peer.auth.principal.id, connId: peer.id, x: 10, y: 5 },
        { principalId: peer.auth.principal.id, connId: peer.id, ...gesture },
      ]);

      slow.socket.clear();
      slow.socket.bufferedAmount = 1;
      room.updatePresence(peer, { selection: ["never-after-leave"] });
      slow.socket.bufferedAmount = 0;
      slow.peer.drain();
      room.leave(slow.peer);
      clock.advance(100);
      slow.peer.drain();
      expect(slow.socket.messages()).toEqual([]);
    } finally {
      room.closeAll(1000, "test complete");
      store.close();
    }
  });

  test("live retraction and latest spotlight are not starved by continuously dirty snapshots", () => {
    class RecoverySocket extends FakeSocket {
      override send(data: string): number {
        const result = super.send(data);
        const message: unknown = JSON.parse(data);
        if (
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "resync"
        ) {
          this.bufferedAmount = 1;
          return -1;
        }
        return result;
      }
    }
    const fixture = roomFixture();
    const { room, peer, clock, store } = fixture;
    const slow = joinRecipient(fixture, new RecoverySocket());
    try {
      slow.socket.bufferedAmount = 1;
      room.updatePresence(peer, { cursor: null });
      room.writeSpotlight(peer.auth.principal.id, { uri: "first-target", from: "requester" });
      for (let index = 0; index < 40; index += 1) {
        room.applyDocUpdate(
          peer,
          encodedElements(note(`large-${index}`, { text: "x".repeat(20_000) })),
        );
      }
      expect(readElements(room.doc).size).toBe(40);
      slow.socket.bufferedAmount = 0;
      slow.peer.drain();
      expect(slow.socket.messages().map((message) => message.type)).toEqual(["resync"]);
      room.writeSpotlight(peer.auth.principal.id, { uri: "latest-target", from: "requester" });
      room.applyDocUpdate(peer, encodedElements(note("during-resync")));
      clock.advance(100);
      slow.socket.bufferedAmount = 0;
      slow.peer.drain();
      const messages = slow.socket.messages();
      expect(messages.map((message) => message.type)).toEqual([
        "resync",
        "presence",
        "presence",
        "doc_update",
      ]);
      expect(messages[1]).toMatchObject({ connId: peer.id, payload: { cursor: null } });
      expect(messages[2]).toMatchObject({
        payload: { spotlight: { uri: "latest-target", from: "requester" } },
      });
      const initial = messages[0];
      const delta = messages[3];
      if (initial?.type !== "resync" || delta?.type !== "doc_update") {
        throw new Error("missing full fallback followed by incremental recovery");
      }
      const received = createSceneDoc();
      try {
        Y.applyUpdate(received, decodeUpdate(initial.doc));
        Y.applyUpdate(received, decodeUpdate(delta.update));
        expect(readElements(received)).toEqual(readElements(room.doc));
      } finally {
        received.destroy();
      }
    } finally {
      room.closeAll(1000, "test complete");
      store.close();
    }
  });

  test("oversized catch-up is paced separately without delaying later small deltas", () => {
    const fixture = roomFixture();
    const { room, peer, clock, store } = fixture;
    const slow = joinRecipient(fixture);
    const received = createSceneDoc();
    try {
      for (let batch = 0; batch < 2; batch += 1) {
        slow.socket.clear();
        slow.socket.bufferedAmount = 1;
        for (let index = 0; index < 40; index += 1) {
          room.applyDocUpdate(
            peer,
            encodedElements(note(`large-${batch}-${index}`, { text: "x".repeat(20_000) })),
          );
        }
        expect(readElements(room.doc).size).toBe((batch + 1) * 40);
        slow.socket.bufferedAmount = 0;
        slow.peer.drain();
        if (batch === 1) {
          clock.advance(999);
          expect(slow.socket.messages()).toEqual([]);
          clock.advance(1);
        }
        const messages = slow.socket.messages();
        expect(messages.map((message) => message.type)).toEqual(["resync"]);
        const snapshot = messages[0];
        if (snapshot?.type !== "resync") throw new Error("missing full catch-up");
        Y.applyUpdate(received, decodeUpdate(snapshot.doc));
      }
      slow.socket.clear();
      slow.socket.bufferedAmount = 1;
      patchElement(room.doc, "large-0-0", { x: 77 }, LOCAL_ORIGIN);
      slow.socket.bufferedAmount = 0;
      slow.peer.drain();
      clock.advance(100);
      const messages = slow.socket.messages();
      expect(messages.map((message) => message.type)).toEqual(["doc_update"]);
      const delta = messages[0];
      if (delta?.type !== "doc_update") throw new Error("missing small catch-up");
      Y.applyUpdate(received, decodeUpdate(delta.update));
      expect(readElement(received, "large-0-0")?.x).toBe(77);
    } finally {
      room.closeAll(1000, "test complete");
      received.destroy();
      store.close();
    }
  });

  test("vantage replacement stays connection-scoped despite interleaved principal facets", () => {
    const fixture = roomFixture();
    const { room, peer, clock, container, store } = fixture;
    const tab = joinRecipient(fixture);
    const slow = joinRecipient(fixture);
    const left: LocationPath = [{ kind: "container", containerId: container.id }];
    const right: LocationPath = [
      ...left,
      { kind: "element", containerId: container.id, elementId: "right" },
    ];
    try {
      slow.socket.bufferedAmount = 1;
      room.updatePresence(peer, { vantage: { tool: "select", locationPath: left } });
      room.updatePresence(tab.peer, { vantage: { tool: "draw", locationPath: right } });
      room.updatePresence(peer, { status: "done" });
      slow.socket.bufferedAmount = 0;
      slow.peer.drain();
      expect(slow.socket.messages()).toEqual([
        {
          type: "presence",
          principalId: peer.auth.principal.id,
          connId: peer.id,
          payload: { vantage: { tool: "select", locationPath: left } },
        },
        {
          type: "presence",
          principalId: peer.auth.principal.id,
          connId: tab.peer.id,
          payload: { vantage: { tool: "draw", locationPath: right } },
        },
        {
          type: "presence",
          principalId: peer.auth.principal.id,
          connId: peer.id,
          payload: { status: "done" },
        },
      ]);
      slow.socket.clear();
      slow.socket.bufferedAmount = 1;
      room.updatePresence(peer, { vantage: { tool: "text" } });
      slow.socket.bufferedAmount = 0;
      slow.peer.drain();
      clock.advance(100);
      expect(slow.socket.messages()).toEqual([
        {
          type: "presence",
          principalId: peer.auth.principal.id,
          connId: peer.id,
          payload: { vantage: { tool: "text" } },
        },
      ]);
    } finally {
      room.closeAll(1000, "test complete");
      store.close();
    }
  });

  test("deletion-only recovery carries tombstones without resetting a large document", () => {
    const fixture = roomFixture();
    const { room, peer, store } = fixture;
    const received = createSceneDoc();
    try {
      for (let index = 0; index < 40; index += 1) {
        room.applyDocUpdate(
          peer,
          encodedElements(note(`large-${index}`, { text: "x".repeat(20_000) })),
        );
      }
      expect(readElements(room.doc).size).toBe(40);
      const slow = joinRecipient(fixture);
      Y.applyUpdate(received, Y.encodeStateAsUpdate(room.doc));
      slow.socket.bufferedAmount = 1;
      elementsMap(room.doc).delete("large-0");
      slow.socket.bufferedAmount = 0;
      slow.peer.drain();
      const messages = slow.socket.messages();
      expect(messages.map((message) => message.type)).toEqual(["doc_update"]);
      const delta = messages[0];
      if (delta?.type !== "doc_update") throw new Error("missing deletion recovery");
      Y.applyUpdate(received, decodeUpdate(delta.update));
      expect(readElements(received).has("large-0")).toBe(false);
      expect(readElements(received)).toEqual(readElements(room.doc));
    } finally {
      room.closeAll(1000, "test complete");
      received.destroy();
      store.close();
    }
  });

  test("departed sources cannot replay stale cursors and a closed room cannot emit deferred state", () => {
    const fixture = roomFixture();
    const { room, peer, clock, store } = fixture;
    const tab = joinRecipient(fixture);
    const slow = joinRecipient(fixture);
    try {
      slow.socket.bufferedAmount = 1;
      room.updatePresence(tab.peer, { cursor: { x: 1, y: 2 } });
      room.leave(tab.peer);
      slow.socket.bufferedAmount = 0;
      slow.peer.drain();
      expect(slow.socket.messages().map((message) => message.type)).toEqual(["attendance"]);
      const snapshot = slow.socket.messages()[0];
      if (snapshot?.type !== "attendance") throw new Error("missing departure attendance");
      expect(snapshot.joined?.connIds).toEqual([peer.id, slow.peer.id]);

      slow.socket.clear();
      slow.socket.bufferedAmount = 1;
      room.updatePresence(peer, { selection: ["pending-close"] });
      room.closeAll(1000, "test complete");
      slow.socket.bufferedAmount = 0;
      slow.peer.drain();
      clock.advance(200);
      expect(slow.socket.messages().map((message) => message.type)).toEqual(["channel_closed"]);
    } finally {
      room.closeAll(1000, "test complete");
      store.close();
    }
  });
});

describe("Room connection locations", () => {
  test("snapshot replacement and closing one tab preserve the sibling path and legacy focus", () => {
    const { runtime, room, peer, socket, store, container } = roomFixture();
    const sibling = new SessionChannel(
      runtime.newId(),
      new FakeSocket(),
      peer.auth,
      container.id,
      "c2",
    );
    const left: LocationPath = [
      { kind: "container", containerId: container.id },
      { kind: "element", containerId: container.id, elementId: "left" },
    ];
    const right: LocationPath = [
      { kind: "container", containerId: container.id },
      { kind: "element", containerId: container.id, elementId: "right" },
    ];
    try {
      room.join(sibling);
      room.updatePresence(peer, {
        vantage: { locationPath: left },
        focus: { elementId: "terminal" },
      });
      room.updatePresence(sibling, { vantage: { locationPath: right } });
      room.sendResync(peer);
      const snapshot = socket.messages().at(-1);
      if (snapshot?.type !== "resync") throw new Error("missing resync");
      expect(snapshot.attendance[0]?.connectionLocations).toEqual([
        { connId: peer.id, locationPath: left },
        { connId: sibling.id, locationPath: right },
      ]);
      room.updatePresence(sibling, { vantage: { locationPath: left } });
      room.leave(sibling);
      const departed = socket.messages().at(-1);
      if (departed?.type !== "attendance") throw new Error("missing departure attendance");
      expect(departed.joined?.connectionLocations).toEqual([
        { connId: peer.id, locationPath: left },
      ]);
      expect(departed.joined?.payload.focus).toEqual({ elementId: "terminal" });
      room.updatePresence(peer, { vantage: {} });
      room.sendResync(peer);
      const cleared = socket.messages().at(-1);
      if (cleared?.type !== "resync") throw new Error("missing cleared resync");
      expect(cleared.attendance[0]?.connectionLocations).toEqual([
        { connId: peer.id, locationPath: null },
      ]);
    } finally {
      room.closeAll(1000, "test complete");
      store.close();
    }
  });
});

describe("Room Yjs document consistency", () => {
  test("init carries a complete encoded document", () => {
    const store = testStore();
    const runtime = new FakeRuntime();
    const container: Container = {
      id: runtime.newId(),
      name: "persisted",
      createdAt: 0,
      discipline: "canvas",
    };
    store.createContainer(container);
    const saved = createSceneDoc();
    writeElement(saved, portal("persisted"), LOCAL_ORIGIN);
    store.saveDoc(container.id, "epoch-saved", 4, 1, Y.encodeStateAsUpdate(saved));

    const principal: Principal = {
      id: runtime.newId(),
      kind: "human",
      name: "viewer",
      color: "#2563eb",
    };
    store.createPrincipal(principal, 0);
    const peer = new SessionChannel(
      runtime.newId(),
      new FakeSocket(),
      { principal, caps: ["*"], containerScope: null, tokenId: null, grantId: null },
      container.id,
      "c1",
    );
    const socket = peer.socket as FakeSocket;
    let joinOrder = 0;
    const room = new Room(
      container.id,
      container.discipline,
      store,
      runtime,
      new FakeClock(runtime),
      silentLogger,
      () => [],
      () => {},
      () => null,
      (containerId, principalId, kind) => {
        store.addEvent(containerId, runtime.now(), principalId, kind, {});
      },
      testTileTrees(container.discipline),
      () => ++joinOrder,
    );
    room.join(peer);

    const init = socket.messages()[0];
    if (init?.type !== "init") throw new Error("missing init");
    const decoded = createSceneDoc();
    Y.applyUpdate(decoded, decodeUpdate(init.doc));
    expect(init.epoch).toBe("epoch-saved");
    expect(init.rev).toBe(4);
    expect(readElement(decoded, "persisted")).toEqual(portal("persisted"));
    store.close();
  });

  test("accepted updates are echoed with server-stamped authorship", () => {
    const fixture = roomFixture();
    const update = encodedElements(portal());
    expect(fixture.room.applyDocUpdate(fixture.peer, update)).toBeTrue();

    expect(fixture.room.rev).toBe(2);
    expect(readElement(fixture.room.doc, "element-1")).toEqual(
      portal("element-1", {
        lastEditedBy: fixture.peer.auth.principal.id,
        lastEditedAt: 0,
      }),
    );
    const messages = fixture.socket.messages();
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      type: "doc_update",
      by: fixture.peer.auth.principal.id,
    });
    expect(messages[1]).toMatchObject({ type: "doc_update", by: "server" });
    fixture.socket.clear();
    fixture.room.applyDocUpdate(fixture.peer, update);
    expect(fixture.room.rev).toBe(2);
    expect(fixture.socket.messages()).toEqual([]);
    fixture.store.close();
  });

  test("server acceptance order stamps whole changed elements with one update time", () => {
    const fixture = roomFixture();
    fixture.runtime.time = 10;
    fixture.room.applyDocUpdate(fixture.peer, encodedElements(portal("first"), note("second")));
    expect(readElement(fixture.room.doc, "first")).toMatchObject({
      lastEditedBy: fixture.peer.auth.principal.id,
      lastEditedAt: 10,
    });
    expect(readElement(fixture.room.doc, "second")).toMatchObject({
      lastEditedBy: fixture.peer.auth.principal.id,
      lastEditedAt: 10,
    });

    const principal: Principal = {
      id: fixture.runtime.newId(),
      kind: "agent",
      name: "second editor",
      color: "#dc2626",
    };
    fixture.store.createPrincipal(principal, fixture.runtime.now());
    const peer = new SessionChannel(
      fixture.runtime.newId(),
      new FakeSocket(),
      { ...fixture.peer.auth, principal },
      fixture.container.id,
      "c2",
    );
    const replica = createSceneDoc();
    Y.applyUpdate(replica, Y.encodeStateAsUpdate(fixture.room.doc));
    const before = Y.encodeStateVector(replica);
    patchElement(replica, "first", { x: 99 }, LOCAL_ORIGIN);
    fixture.runtime.time = 20;
    fixture.room.applyDocUpdate(peer, encodeUpdate(Y.encodeStateAsUpdate(replica, before)));

    expect(readElement(fixture.room.doc, "first")).toMatchObject({
      x: 99,
      lastEditedBy: principal.id,
      lastEditedAt: 20,
    });
    expect(readElement(fixture.room.doc, "second")).toMatchObject({
      lastEditedBy: fixture.peer.auth.principal.id,
      lastEditedAt: 10,
    });
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
        containerId: fixture.container.id,
        id: "invalid",
      });
    } finally {
      warned.mockRestore();
      fixture.store.close();
    }
  });

  test("a malformed payload for a KNOWN element type is repaired at the scene boundary", () => {
    /*
      THE other half of the envelope (ADR 0013 §16 clause 5). The record below passes the
      protocol's schema completely — the geometry is valid and the payload is inside every bound
      — so nothing in the wire vocabulary can object to it. What refuses it is its OWNING
      PLUGIN's payload schema, consulted here through the guard the assembly supplies, and the
      repair is the same accept-then-repair pass a schema-invalid record already took: a Yjs
      update is not divisible, so the update has merged by the time anything can read it.

      The log line carries the owner, which is the point of refusing at a door rather than in a
      schema: a reader learns which plugin to go and ask.
    */
    const fixture = roomFixture(testStore(), "canvas", (element) =>
      element.type === "acme.chart"
        ? {
            elementId: element.id,
            type: element.type,
            plugin: "acme.charts",
            problems: ["series Expected array"],
          }
        : null,
    );
    const warned = spyOn(silentLogger, "warn");
    try {
      fixture.room.applyDocUpdate(
        fixture.peer,
        encodedElements({
          id: "chart-1",
          type: "acme.chart",
          series: "not-an-array",
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          zIndex: 0,
        }),
      );

      expect(elementsMap(fixture.room.doc).has("chart-1")).toBeFalse();
      expect(warned).toHaveBeenCalledWith("scene_element_repaired", {
        containerId: fixture.container.id,
        id: "chart-1",
        type: "acme.chart",
        plugin: "acme.charts",
        problems: "series Expected array",
      });
    } finally {
      warned.mockRestore();
      fixture.store.close();
    }
  });

  test("a STRANGER element type survives the boundary, payload and all", () => {
    // The property the opening exists for: with no schema to fail, a record whose plugin is
    // absent from this build keeps its place in the document instead of being deleted by a
    // reader that never heard of it.
    const fixture = roomFixture();
    fixture.room.applyDocUpdate(
      fixture.peer,
      encodedElements({
        id: "gantt-1",
        type: "vendor.gantt",
        lanes: ["design", "build"],
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        zIndex: 0,
      }),
    );

    expect(readElement(fixture.room.doc, "gantt-1")).toMatchObject({
      type: "vendor.gantt",
      lanes: ["design", "build"],
    });
    fixture.store.close();
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
    const update = encodedElements(portal());
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
});

describe("RoomManager shared room recency", () => {
  test("orders shared rooms by the caller's latest live successful channel join", () => {
    const runtime = new FakeRuntime();
    const clock = new FakeClock(runtime);
    const store = testStore();
    const containers: Container[] = [
      { id: "alpha-room", name: "Alpha", createdAt: 0, discipline: "canvas" },
      { id: "zulu-room", name: "Zulu", createdAt: 0, discipline: "canvas" },
    ];
    for (const container of containers) store.createContainer(container);
    const caller: Principal = {
      id: "caller",
      kind: "human",
      name: "Caller",
      color: "#2563eb",
    };
    const target: Principal = {
      id: "target",
      kind: "human",
      name: "Target",
      color: "#dc2626",
    };
    store.createPrincipal(caller, 0);
    store.createPrincipal(target, 0);
    const manager = new RoomManager(store, runtime, clock, silentLogger, testTileTrees);
    const alpha = manager.get("alpha-room");
    const zulu = manager.get("zulu-room");
    if (alpha === null || zulu === null) throw new Error("missing managed rooms");
    const channel = (
      principal: Principal,
      containerId: string,
      id: string,
      spectator = false,
    ): SessionChannel =>
      new SessionChannel(
        id,
        new FakeSocket(),
        {
          principal,
          caps: ["*"],
          containerScope: null,
          tokenId: null,
          grantId: null,
        },
        containerId,
        id,
        spectator,
      );

    const callerAlpha = channel(caller, "alpha-room", "caller-alpha");
    const callerZulu = channel(caller, "zulu-room", "caller-zulu");
    alpha.join(callerAlpha);
    alpha.join(channel(target, "alpha-room", "target-alpha"));
    zulu.join(callerZulu);
    zulu.join(channel(target, "zulu-room", "target-zulu"));

    // The newest caller join wins even though lexical and room materialization order say alpha.
    expect(manager.sharedContainerIds(caller.id, target.id)).toEqual(["zulu-room", "alpha-room"]);

    // Target activity, a duplicate join, a spectator, and a failed closed-channel join are not
    // new caller memberships and therefore cannot perturb the caller's preference.
    alpha.join(channel(target, "alpha-room", "target-alpha-sibling"));
    alpha.join(callerAlpha);
    alpha.join(channel(caller, "alpha-room", "caller-spectator", true));
    const failed = channel(caller, "alpha-room", "caller-failed");
    failed.dispose();
    expect(alpha.join(failed)).toBeFalse();
    expect(manager.sharedContainerIds(caller.id, target.id)).toEqual(["zulu-room", "alpha-room"]);

    const callerAlphaSibling = channel(caller, "alpha-room", "caller-alpha-sibling");
    alpha.join(callerAlphaSibling);
    expect(manager.sharedContainerIds(caller.id, target.id)).toEqual(["alpha-room", "zulu-room"]);

    // Closing a sibling keeps the principal membership's recency; only the final tab removes it.
    alpha.leave(callerAlphaSibling);
    expect(manager.sharedContainerIds(caller.id, target.id)).toEqual(["alpha-room", "zulu-room"]);
    alpha.leave(callerAlpha);
    expect(manager.sharedContainerIds(caller.id, target.id)).toEqual(["zulu-room"]);
    const callerAlphaRejoined = channel(caller, "alpha-room", "caller-alpha-rejoined");
    alpha.join(callerAlphaRejoined);
    expect(manager.sharedContainerIds(caller.id, target.id)).toEqual(["alpha-room", "zulu-room"]);
    store.close();
  });
});

describe("Room document persistence", () => {
  test("quiet cadence saves the complete Yjs document and broadcasts saved", () => {
    const fixture = roomFixture();
    fixture.room.applyDocUpdate(fixture.peer, encodedElements(portal("quiet")));
    expect(
      fixture.store.db.query<CountRow, []>("SELECT COUNT(*) AS count FROM scene_docs").get()?.count,
    ).toBe(0);

    fixture.clock.advance(1_500);
    const record = fixture.store.latestDoc(fixture.container.id);
    expect(record?.rev).toBe(2);
    const restored = createSceneDoc();
    Y.applyUpdate(restored, record?.doc ?? new Uint8Array());
    expect(readElement(restored, "quiet")).toEqual(
      portal("quiet", {
        lastEditedBy: fixture.peer.auth.principal.id,
        lastEditedAt: 0,
      }),
    );
    expect(fixture.socket.messages().at(-1)?.type).toBe("saved");
    fixture.store.close();
  });

  test("a failed debounced save stays isolated and retries", () => {
    const store = new FailingDocStore(openDatabase(":memory:"));
    const fixture = roomFixture(store);
    store.failingContainers.add(fixture.container.id);
    fixture.room.applyDocUpdate(fixture.peer, encodedElements(portal("retry")));

    expect(() => fixture.clock.advance(1_500)).not.toThrow();
    expect(store.latestDoc(fixture.container.id)).toBeNull();
    store.failingContainers.delete(fixture.container.id);
    fixture.clock.advance(1_500);
    expect(store.latestDoc(fixture.container.id)?.rev).toBe(2);
    store.close();
  });

  test("last leave flushes and evicts an idle managed room", () => {
    const runtime = new FakeRuntime();
    const clock = new FakeClock(runtime);
    const store = testStore();
    const container: Container = {
      id: runtime.newId(),
      name: "evict",
      createdAt: 0,
      discipline: "canvas",
    };
    store.createContainer(container);
    const principal: Principal = {
      id: runtime.newId(),
      kind: "human",
      name: "evictor",
      color: "#2563eb",
    };
    store.createPrincipal(principal, 0);
    const manager = new RoomManager(store, runtime, clock, silentLogger, testTileTrees);
    const room = manager.get(container.id);
    if (room === null) throw new Error("missing room");
    const peer = new SessionChannel(
      runtime.newId(),
      new FakeSocket(),
      { principal, caps: ["*"], containerScope: null, tokenId: null, grantId: null },
      container.id,
      "c1",
    );
    room.join(peer);
    room.applyDocUpdate(peer, encodedElements(portal("before-leave")));

    room.leave(peer);
    expect(manager.introspect()).toHaveLength(0);
    expect(store.latestDoc(container.id)?.rev).toBe(2);
    store.close();
  });

  test("dropping a container fences each member's channel without publishing departures", () => {
    const runtime = new FakeRuntime();
    const clock = new FakeClock(runtime);
    const store = testStore();
    const container: Container = {
      id: runtime.newId(),
      name: "dropped",
      createdAt: 0,
      discipline: "canvas",
    };
    store.createContainer(container);
    const principal: Principal = {
      id: runtime.newId(),
      kind: "human",
      name: "occupant",
      color: "#2563eb",
    };
    store.createPrincipal(principal, 0);
    const manager = new RoomManager(store, runtime, clock, silentLogger, testTileTrees);
    const room = manager.get(container.id);
    if (room === null) throw new Error("missing room");
    const socket = new FakeSocket();
    const peer = new SessionChannel(
      runtime.newId(),
      socket,
      { principal, caps: ["*"], containerScope: null, tokenId: null, grantId: null },
      container.id,
      "c1",
    );
    room.join(peer);
    socket.clear();

    manager.drop(container.id);

    // The room is gone for this member, but the tab's socket keeps whatever else it holds.
    expect(socket.frames()).toEqual([
      { type: "channel_closed", ch: "c1", code: 4404, reason: "container deleted" },
    ]);
    expect(socket.closed).toBeNull();
    // A demolished room never announces a departure to the members it just fenced.
    expect(manager.introspect()).toHaveLength(0);
    store.close();
  });
});

/**
 * A composition and a canvas over one store, which is the pair every element rule is about:
 * the composition is where an item LIVES, the canvas only points at it.
 */
function containerPair() {
  const runtime = new FakeRuntime();
  const clock = new FakeClock(runtime);
  const store = testStore();
  const home: Container = {
    id: runtime.newId(),
    name: "solo",
    createdAt: 0,
    discipline: "composition",
  };
  const container: Container = {
    id: runtime.newId(),
    name: "container",
    createdAt: 0,
    discipline: "canvas",
  };
  store.createContainer(home);
  store.createContainer(container);
  const manager = new RoomManager(store, runtime, clock, silentLogger, testTileTrees);
  const homeRoom = manager.get(home.id);
  const containerRoom = manager.get(container.id);
  if (homeRoom === null || containerRoom === null) throw new Error("missing room");
  return { runtime, clock, store, home, container, manager, homeRoom, containerRoom };
}

describe("Room element rules", () => {
  test("portalIdsTo lists every portal onto one container in paint order", () => {
    const fixture = roomFixture();
    fixture.room.applyDocUpdate(
      fixture.peer,
      encodedElements(
        portal("late", { containerId: "home-a", zIndex: 9 }),
        portal("early", { containerId: "home-a", zIndex: 1 }),
        portal("middle", { containerId: "home-a", zIndex: 4 }),
        portal("elsewhere", { containerId: "home-b", zIndex: 2 }),
        note("caption", { zIndex: 3 }),
      ),
    );

    // One canvas may reference one container several times — mirrors of the same item — and
    // releasing the ITEM has to reach all of them, in the order they paint.
    expect(fixture.room.portalIdsTo("home-a")).toEqual(["early", "middle", "late"]);
    expect(fixture.room.portalIdsTo("home-b")).toEqual(["elsewhere"]);
    expect(fixture.room.portalIdsTo("home-never")).toEqual([]);
    // Furniture is not a reference, whatever it is painted between.
    expect(fixture.room.elements().map((element) => element.id)).toEqual([
      "early",
      "elsewhere",
      "caption",
      "middle",
      "late",
    ]);
    fixture.store.close();
  });

  test("repointPortal keeps the element id and geometry while changing its target", () => {
    const fixture = roomFixture();
    const geometry = { x: 40, y: 60, width: 300, height: 210, zIndex: 7 } as const;
    const mirror = portal("mirror", { containerId: "old-home", ...geometry });
    fixture.room.applyDocUpdate(fixture.peer, encodedElements(mirror, note("caption")));
    const revAfterAuthoring = fixture.room.rev;

    expect(fixture.room.repointPortal("mirror", "new-home")).toBeTrue();
    // A merge repoints instead of re-authoring: geometry, z-order, and the last human edit
    // summary survive the server-origin rewrite, so it invents no editor.
    expect(fixture.room.element("mirror")).toEqual(
      portal("mirror", {
        containerId: "new-home",
        ...geometry,
        lastEditedBy: fixture.peer.auth.principal.id,
        lastEditedAt: 0,
      }),
    );
    expect(fixture.room.rev).toBe(revAfterAuthoring + 1);

    // Already pointing there: reported done, without spending a revision on nothing.
    expect(fixture.room.repointPortal("mirror", "new-home")).toBeTrue();
    expect(fixture.room.rev).toBe(revAfterAuthoring + 1);

    // Only a REFERENCE can be repointed. Furniture has no target to change.
    expect(fixture.room.repointPortal("caption", "new-home")).toBeFalse();
    expect(fixture.room.repointPortal("absent", "new-home")).toBeFalse();
    expect(fixture.room.element("caption")).toEqual(
      note("caption", {
        lastEditedBy: fixture.peer.auth.principal.id,
        lastEditedAt: 0,
      }),
    );
    fixture.store.close();
  });

  test("removePortalsTo removes every reference to one container and counts them", () => {
    const fixture = roomFixture();
    fixture.room.applyDocUpdate(
      fixture.peer,
      encodedElements(
        portal("first", { containerId: "gone", zIndex: 1 }),
        portal("second", { containerId: "gone", zIndex: 2 }),
        portal("survivor", { containerId: "kept", zIndex: 3 }),
        note("caption", { zIndex: 4 }),
      ),
    );

    // A container that stops existing takes ALL of its references with it: a portal onto a
    // deleted container is a state the workspace must not be able to reach.
    expect(fixture.room.removePortalsTo("gone")).toBe(2);
    expect(fixture.room.elements().map((element) => element.id)).toEqual(["survivor", "caption"]);
    // Nothing to remove is an answer, not a failure.
    expect(fixture.room.removePortalsTo("gone")).toBe(0);
    expect(fixture.room.removePortalsTo("never-referenced")).toBe(0);
    fixture.store.close();
  });

  test("only the composition holding a terminal's leaf homes it, never a canvas onto it", () => {
    const fixture = containerPair();
    expect(fixture.homeRoom.placeTerminalTile("terminal-1", null, null)).toBe(ROOT_TILE_ID);
    const reference = fixture.containerRoom.placePortalElement(fixture.home.id, 10, 20);

    /*
      This distinction IS the model. The canvas shows the terminal and can be navigated into
      it, but it does not hold it: the composition does, through the leaf. Confusing the two
      is how a terminal ends up with two homes, or none.
     */
    expect(fixture.homeRoom.homesTerminal("terminal-1")).toBeTrue();
    expect(fixture.containerRoom.homesTerminal("terminal-1")).toBeFalse();
    expect(fixture.containerRoom.portalIdsTo(fixture.home.id)).toEqual([reference]);
    expect(fixture.homeRoom.homesTerminal("terminal-other")).toBeFalse();

    // The leaf is the whole claim: removing it un-homes the terminal even though the
    // composition and the canvas reference both still exist.
    expect(fixture.homeRoom.removeTileLeafById(ROOT_TILE_ID)).toBeTrue();
    expect(fixture.homeRoom.homesTerminal("terminal-1")).toBeFalse();
    fixture.store.close();
  });

  test("composition census resolves element refs to their contributed payload kinds", () => {
    const fixture = containerPair();
    const noteElement = note("caption");
    const ink: SceneElement = {
      id: "ink",
      type: "acme-ink",
      x: 0,
      y: 0,
      width: 100,
      height: 80,
      zIndex: 1,
      points: [0, 0, 30, 40],
    };
    for (const element of [noteElement, ink]) {
      writeElement(fixture.homeRoom.doc, element, LOCAL_ORIGIN);
      fixture.homeRoom.placeTile({ kind: "element", elementId: element.id }, null, null);
    }
    expect(
      fixture.homeRoom
        .census()
        .items.map((item) => item.kind)
        .sort(),
    ).toEqual(["acme-ink", "text"]);
    fixture.store.close();
  });

  test("census reports items and references in both disciplines, solo only at arity one", () => {
    const fixture = containerPair();
    const homeLeaf = fixture.homeRoom.placeTerminalTile("terminal-1", null, null);
    expect(homeLeaf).toBe(ROOT_TILE_ID);

    // A solo composition: exactly one item, so `censusSolo` answers with it — that answer is
    // what lets the index draw a composition of one AS the terminal it holds.
    const solo = fixture.homeRoom.census();
    expect(solo).toEqual({
      containerId: fixture.home.id,
      discipline: "composition",
      items: [{ kind: "terminal", containerId: null, terminalId: "terminal-1" }],
      references: [],
    });
    expect(censusSolo(solo)).toEqual({
      kind: "terminal",
      containerId: null,
      terminalId: "terminal-1",
    });

    // Two mirrors of one home plus furniture: a canvas is counted by its elements, and each
    // portal contributes BOTH an item and a reference.
    for (const element of [
      portal("mirror-a", { containerId: fixture.home.id, zIndex: 1 }),
      portal("mirror-b", { containerId: fixture.home.id, zIndex: 2 }),
      note("caption", { zIndex: 3 }),
    ]) {
      writeElement(fixture.containerRoom.doc, element, LOCAL_ORIGIN);
    }
    const canvas = fixture.containerRoom.census();
    expect(canvas).toEqual({
      containerId: fixture.container.id,
      discipline: "canvas",
      items: [
        { kind: "composition", containerId: fixture.home.id, terminalId: null },
        { kind: "composition", containerId: fixture.home.id, terminalId: null },
        { kind: "text", containerId: null, terminalId: null },
      ],
      references: [fixture.home.id, fixture.home.id],
    });
    expect(censusSolo(canvas)).toBeNull();

    // A composition that grew past one stops being solo, and an embedded canvas is a
    // reference exactly like a portal is.
    expect(
      fixture.homeRoom.placeTile(
        { kind: "container", containerId: fixture.container.id },
        null,
        null,
      ),
    ).not.toBeNull();
    const grown = fixture.homeRoom.census();
    expect(grown.items).toHaveLength(2);
    expect(grown.items).toContainEqual({
      kind: "canvas",
      containerId: fixture.container.id,
      terminalId: null,
    });
    expect(grown.references).toEqual([fixture.container.id]);
    expect(censusSolo(grown)).toBeNull();

    // Losing its references does not change what a container HOLDS: those are the two halves
    // of a census, and the index needs them apart.
    expect(fixture.containerRoom.removePortalsTo(fixture.home.id)).toBe(2);
    const stripped = fixture.containerRoom.census();
    expect(stripped.references).toEqual([]);
    expect(stripped.items).toEqual([{ kind: "text", containerId: null, terminalId: null }]);
    // Arity one, and only one: an emptied container is not solo either.
    expect(
      censusSolo({
        containerId: fixture.home.id,
        discipline: "composition",
        items: [],
        references: [],
      }),
    ).toBeNull();
    fixture.store.close();
  });
});
