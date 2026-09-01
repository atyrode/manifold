import { describe, expect, spyOn, test } from "bun:test";
import {
  MAX_DOC_UPDATE_BYTES,
  ROOT_TILE_ID,
  censusSolo,
  type Container,
  type ContainerDiscipline,
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
    isRoot: true,
    tokenId: null,
    grantId: null,
  };
  const socket = new FakeSocket();
  const peer = new SessionChannel(runtime.newId(), socket, context, container.id, "c1");
  // The eighth argument is the element-payload boundary (ADR 0013 §16), the ninth is the
  // attendance announcement (ADR 0012) and the tenth is whether this container holds a tile
  // tree (#125). These fixtures compose no plugins, so nothing declares a payload schema and
  // the honest stand-in accepts every record; the announcement writes straight to the durable
  // trail, which is what an unwired production room does until the assembly and the event
  // plane arrive. The tree question is answered by the SHIPPED declarations, because a
  // fixture that spelled it would seed roots the server does not.
  const room = new Room(
    container.id,
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
  );
  room.join(peer);
  socket.clear();
  return { runtime, clock, store, container, socket, peer, room };
}

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
      { principal, caps: ["*"], containerScope: null, isRoot: true, tokenId: null, grantId: null },
      container.id,
      "c1",
    );
    const socket = peer.socket as FakeSocket;
    const room = new Room(
      container.id,
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

    expect(fixture.room.rev).toBe(1);
    expect(readElement(fixture.room.doc, "element-1")).toEqual(portal());
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

describe("Room document persistence", () => {
  test("quiet cadence saves the complete Yjs document and broadcasts saved", () => {
    const fixture = roomFixture();
    fixture.room.applyDocUpdate(fixture.peer, encodedElements(portal("quiet")));
    expect(
      fixture.store.db.query<CountRow, []>("SELECT COUNT(*) AS count FROM scene_docs").get()?.count,
    ).toBe(0);

    fixture.clock.advance(1_500);
    const record = fixture.store.latestDoc(fixture.container.id);
    expect(record?.rev).toBe(1);
    const restored = createSceneDoc();
    Y.applyUpdate(restored, record?.doc ?? new Uint8Array());
    expect(readElement(restored, "quiet")).toEqual(portal("quiet"));
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
    expect(store.latestDoc(fixture.container.id)?.rev).toBe(1);
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
      { principal, caps: ["*"], containerScope: null, isRoot: true, tokenId: null, grantId: null },
      container.id,
      "c1",
    );
    room.join(peer);
    room.applyDocUpdate(peer, encodedElements(portal("before-leave")));

    room.leave(peer);
    expect(manager.introspect()).toHaveLength(0);
    expect(store.latestDoc(container.id)?.rev).toBe(1);
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
      { principal, caps: ["*"], containerScope: null, isRoot: true, tokenId: null, grantId: null },
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
    // A merge repoints instead of re-authoring precisely so nothing observable moves: same
    // id, same geometry, same z-order, so no portal blinks and no selection is lost.
    expect(fixture.room.element("mirror")).toEqual(
      portal("mirror", { containerId: "new-home", ...geometry }),
    );
    expect(fixture.room.rev).toBe(revAfterAuthoring + 1);

    // Already pointing there: reported done, without spending a revision on nothing.
    expect(fixture.room.repointPortal("mirror", "new-home")).toBeTrue();
    expect(fixture.room.rev).toBe(revAfterAuthoring + 1);

    // Only a REFERENCE can be repointed. Furniture has no target to change.
    expect(fixture.room.repointPortal("caption", "new-home")).toBeFalse();
    expect(fixture.room.repointPortal("absent", "new-home")).toBeFalse();
    expect(fixture.room.element("caption")).toEqual(note("caption"));
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
