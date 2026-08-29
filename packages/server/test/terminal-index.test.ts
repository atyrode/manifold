import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PadSessionsResponseSchema,
  PadTreeResponseSchema,
  ServerToAgentMessageSchema,
  TerminalsResponseSchema,
  type Pad,
  type SceneElement,
  type ServerMessageBody,
  type ServerToAgentMessage,
} from "@manifold/protocol";
import {
  DEFAULT_TERMINAL_HEIGHT,
  DEFAULT_TERMINAL_WIDTH,
  LOCAL_ORIGIN,
  writeElement,
} from "@manifold/scene";
import { AuthService, type AuthContext } from "../src/auth.ts";
import { loadConfig } from "../src/config.ts";
import { HttpApp } from "../src/http.ts";
import { silentLogger } from "../src/log.ts";
import { MachineGateway } from "../src/machine-ws.ts";
import { PlaceExecutor } from "../src/placement.ts";
import { RoomManager, type Room } from "../src/room.ts";
import { SessionPeer } from "../src/session-peer.ts";
import type { ServerStore } from "../src/stores.ts";
import { TerminalBroker, type MachineChannel } from "../src/terminal-broker.ts";
import {
  FakeClock,
  FakeRuntime,
  FakeSocket,
  placeTile,
  testStore,
  unplaceTerminal,
} from "./helpers.ts";

/**
 * The terminal INDEX: what replaced the workspace pool.
 *
 * There is no pool. Every terminal lives in a composition from birth, so the index is one
 * flat listing of every terminal plus the container it lives in, and "not placed anywhere"
 * is DERIVED from the containment graph on each read rather than stored as a position in a
 * second list. Three consequences are what this file pins:
 *
 *   - `GET /api/terminals` lists EVERY terminal — running, exited, referenced or not — with
 *     its `homeId`, where the pool listed only the unbound ones and pruned the exited.
 *   - `unplaced` round-trips with nothing but the graph: place a terminal and it is false,
 *     release it and it is true again, with no state left over to go stale.
 *   - Reordering an unplaced terminal is not a terminal operation at all. It is
 *     `PUT /api/pad-tree` on that terminal's HOME, because the top level of the one index is
 *     where the unreferenced already live.
 */

const OWNER_KEY = "e".repeat(64);
const MACHINE_NAME = "index machine";
const temporaryDirectories: string[] = [];

class FakeMachine implements MachineChannel {
  readonly sent: ServerToAgentMessage[] = [];

  constructor(readonly machineId: string) {}

  send(message: ServerToAgentMessage): boolean {
    this.sent.push(ServerToAgentMessageSchema.parse(message));
    return true;
  }

  clear(): void {
    this.sent.length = 0;
  }
}

/** A canvas shows a terminal through a portal onto the composition it lives in. */
function portalElement(id: string, containerId: string): SceneElement {
  return {
    id,
    type: "portal",
    containerId,
    x: 0,
    y: 0,
    width: DEFAULT_TERMINAL_WIDTH,
    height: DEFAULT_TERMINAL_HEIGHT,
    zIndex: 0,
  };
}

interface IndexFixture {
  runtime: FakeRuntime;
  store: ServerStore;
  auth: AuthService;
  root: AuthContext;
  canvas: Pad;
  rooms: RoomManager;
  broker: TerminalBroker;
  placement: PlaceExecutor;
  machine: FakeMachine;
  opener: SessionPeer;
  app: HttpApp;
}

function indexFixture(): IndexFixture {
  const cwd = mkdtempSync(join(tmpdir(), "manifold-terminal-index-test-"));
  temporaryDirectories.push(cwd);
  const config = loadConfig(
    {
      MANIFOLD_PORT: "0",
      MANIFOLD_DATA_DIR: "data",
      MANIFOLD_OWNER_KEY: OWNER_KEY,
      MANIFOLD_SPAWN_AGENT: "0",
    },
    cwd,
  );
  const runtime = new FakeRuntime();
  const clock = new FakeClock(runtime);
  const store = testStore();
  const auth = new AuthService(store, OWNER_KEY, runtime);
  const root = auth.authenticate(OWNER_KEY);
  const canvas: Pad = {
    id: runtime.newId(),
    name: "index canvas",
    createdAt: runtime.now(),
    layout: "canvas",
  };
  store.createPad(canvas);
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
  const placement = new PlaceExecutor(store, rooms, broker, runtime);
  broker.setPlacement(placement);
  const machines = new MachineGateway(
    auth,
    store,
    broker,
    clock,
    silentLogger,
    "server-epoch",
    runtime,
  );
  const machine = new FakeMachine(auth.enrollMachine(MACHINE_NAME, root).machine.id);
  broker.setMachineOnline(machine);
  const opener = new SessionPeer(runtime.newId(), new FakeSocket(), root, canvas.id, "c1");
  const app = new HttpApp(
    config,
    store,
    auth,
    rooms,
    broker,
    placement,
    machines,
    runtime,
    silentLogger,
  );
  const fixture: IndexFixture = {
    runtime,
    store,
    auth,
    root,
    canvas,
    rooms,
    broker,
    placement,
    machine,
    opener,
    app,
  };
  // The opener stays joined so the canvas is never evicted and the portals these tests write
  // are the ones the containment graph is read from.
  room(fixture, canvas.id).join(opener);
  return fixture;
}

function room(fixture: IndexFixture, padId: string): Room {
  const found = fixture.rooms.get(padId);
  if (found === null) throw new Error(`missing room ${padId}`);
  return found;
}

function homeOf(fixture: IndexFixture, sessionId: string): string {
  const padId = fixture.store.getSession(sessionId)?.padId;
  if (padId === undefined) throw new Error(`session ${sessionId} has no row`);
  return padId;
}

/** A terminal, born from the canvas into a solo composition of its own. */
interface Born {
  readonly sessionId: string;
  readonly homeId: string;
}

function openTerminal(fixture: IndexFixture): Born {
  fixture.broker.open(fixture.opener, {
    type: "terminal_open",
    elementId: `open-${fixture.machine.sent.length}`,
    cols: 80,
    rows: 24,
  });
  const create = fixture.machine.sent.filter((message) => message.type === "create").at(-1);
  if (create === undefined || create.type !== "create") throw new Error("missing create request");
  fixture.broker.onCreated(fixture.machine.machineId, create.sessionId);
  return { sessionId: create.sessionId, homeId: homeOf(fixture, create.sessionId) };
}

function tiledPad(fixture: IndexFixture, name: string): Pad {
  const pad: Pad = {
    id: fixture.runtime.newId(),
    name,
    createdAt: fixture.runtime.now(),
    layout: "tiled",
  };
  fixture.store.createPad(pad);
  return pad;
}

interface Witness {
  readonly peer: SessionPeer;
  readonly socket: FakeSocket;
}

function joinPeer(fixture: IndexFixture, padId: string): Witness {
  const socket = new FakeSocket();
  const peer = new SessionPeer(fixture.runtime.newId(), socket, fixture.root, padId, "c1");
  room(fixture, padId).join(peer);
  return { peer, socket };
}

function bodiesOfType(socket: FakeSocket, type: ServerMessageBody["type"]): ServerMessageBody[] {
  return socket.messages().filter((message) => message.type === type);
}

async function call(
  fixture: IndexFixture,
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; payload: unknown }> {
  const request = new Request(
    `http://localhost${path}`,
    body === undefined
      ? { method, headers: { authorization: `Bearer ${token}` } }
      : {
          method,
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const response = await fixture.app.fetch(request);
  return { status: response.status, payload: await response.json() };
}

function padScopedToken(fixture: IndexFixture): string {
  return fixture.auth.mintToken(
    {
      principal: { name: "pad guest", kind: "human" },
      caps: ["pads:read", "pads:write", "scene:write", "terminal:write"],
      padId: fixture.canvas.id,
    },
    fixture.root,
  ).token;
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("GET /api/terminals", () => {
  test("the index lists every terminal with the composition it lives in", async () => {
    const fixture = indexFixture();
    const running = openTerminal(fixture);
    const exited = openTerminal(fixture);
    fixture.broker.onExited(fixture.machine.machineId, exited.sessionId, 3);

    const response = await call(fixture, "GET", "/api/terminals", OWNER_KEY);

    expect(response.status).toBe(200);
    const terminals = TerminalsResponseSchema.parse(response.payload).terminals;
    // The pool listed only the UNBOUND terminals and swept the exited ones. There is nothing
    // to be unbound from now, so this is simply every terminal — and an exited one is still a
    // terminal until somebody dismisses its last leaf.
    expect([...terminals.map((terminal) => terminal.id)].sort()).toEqual(
      [running.sessionId, exited.sessionId].sort(),
    );
    expect(terminals.find((terminal) => terminal.id === running.sessionId)).toEqual({
      id: running.sessionId,
      machineId: fixture.machine.machineId,
      name: null,
      createdAt: 0,
      status: "running",
      exitCode: null,
      homeId: running.homeId,
      unplaced: true,
    });
    expect(terminals.find((terminal) => terminal.id === exited.sessionId)).toEqual({
      id: exited.sessionId,
      machineId: fixture.machine.machineId,
      name: null,
      createdAt: 0,
      status: "exited",
      exitCode: 3,
      homeId: exited.homeId,
      unplaced: true,
    });
  });

  test("unplaced round-trips off the containment graph, leaving no state behind", async () => {
    const fixture = indexFixture();
    const born = openTerminal(fixture);
    const unplacedOf = async (): Promise<boolean[]> => {
      const response = await call(fixture, "GET", "/api/terminals", OWNER_KEY);
      return TerminalsResponseSchema.parse(response.payload).terminals.map(
        (terminal) => terminal.unplaced,
      );
    };

    expect(await unplacedOf()).toEqual([true]);

    writeElement(
      room(fixture, fixture.canvas.id).doc,
      portalElement("widget-1", born.homeId),
      LOCAL_ORIGIN,
    );
    expect(await unplacedOf()).toEqual([false]);

    // Releasing it is subtractive: the reference goes and the terminal stays where it lives,
    // so the index reports it at top level again with nothing durable having changed.
    expect(unplaceTerminal(fixture.placement, born.sessionId)).toEqual({ removed: 1 });
    expect(await unplacedOf()).toEqual([true]);
    expect(homeOf(fixture, born.sessionId)).toBe(born.homeId);
  });

  test("a terminal merged into a referenced composition is placed through that composition", async () => {
    const fixture = indexFixture();
    const born = openTerminal(fixture);
    const composition = tiledPad(fixture, "composition");
    writeElement(
      room(fixture, fixture.canvas.id).doc,
      portalElement("widget-1", composition.id),
      LOCAL_ORIGIN,
    );

    const added = placeTile(
      fixture.placement,
      composition.id,
      { kind: "terminal", sessionId: born.sessionId },
      null,
      null,
    );
    if (typeof added === "string") throw new Error(`placement failed: ${added}`);

    const response = await call(fixture, "GET", "/api/terminals", OWNER_KEY);
    // `homeId` follows the terminal into the composition it joined, and `unplaced` is about
    // that composition being referenced — not about the terminal itself being pointed at.
    expect(TerminalsResponseSchema.parse(response.payload).terminals).toEqual([
      expect.objectContaining({
        id: born.sessionId,
        homeId: composition.id,
        unplaced: false,
      }),
    ]);
    expect(fixture.store.getPad(born.homeId)).toBeNull();
  });

  test("a pad-scoped token cannot read the terminal index", async () => {
    const fixture = indexFixture();

    const response = await call(fixture, "GET", "/api/terminals", padScopedToken(fixture));

    expect(response.status).toBe(403);
    expect(response.payload).toMatchObject({ error: { code: "forbidden" } });
  });
});

describe("PATCH /api/terminals/:id", () => {
  test("a rename is published into the terminal's home, not the canvas showing it", async () => {
    const fixture = indexFixture();
    const born = openTerminal(fixture);
    writeElement(
      room(fixture, fixture.canvas.id).doc,
      portalElement("widget-1", born.homeId),
      LOCAL_ORIGIN,
    );
    const onCanvas = joinPeer(fixture, fixture.canvas.id);
    const inHome = joinPeer(fixture, born.homeId);

    const renamed = await call(fixture, "PATCH", `/api/terminals/${born.sessionId}`, OWNER_KEY, {
      name: "  build  ",
    });

    expect(renamed.status).toBe(200);
    expect(renamed.payload).toEqual({ ok: true });
    expect(fixture.store.getSession(born.sessionId)?.name).toBe("build");
    // A name is session state, so it is published where every viewer of the terminal is
    // already joined: its home. A canvas learns about it through the widget it renders.
    expect(bodiesOfType(inHome.socket, "session_event")).toEqual([
      { type: "session_event", sessionId: born.sessionId, kind: "renamed", name: "build" },
    ]);
    expect(bodiesOfType(onCanvas.socket, "session_event")).toEqual([]);
  });

  test("a blank name is invalid and an unknown terminal is not found", async () => {
    const fixture = indexFixture();
    const born = openTerminal(fixture);

    const blank = await call(fixture, "PATCH", `/api/terminals/${born.sessionId}`, OWNER_KEY, {
      name: "   ",
    });
    const missing = await call(fixture, "PATCH", "/api/terminals/missing", OWNER_KEY, {
      name: "build",
    });

    expect(blank.status).toBe(400);
    expect(blank.payload).toMatchObject({ error: { code: "invalid" } });
    expect(missing.status).toBe(404);
    expect(missing.payload).toMatchObject({ error: { code: "not_found" } });
    expect(fixture.broker.rename("missing-session", "build")).toBe("not_found");
  });

  test("a rename survives into the advert a merge publishes", () => {
    const fixture = indexFixture();
    const born = openTerminal(fixture);
    expect(fixture.broker.rename(born.sessionId, "build")).toBe("ok");
    const composition = tiledPad(fixture, "composition");
    const inside = joinPeer(fixture, composition.id);

    const added = placeTile(
      fixture.placement,
      composition.id,
      { kind: "terminal", sessionId: born.sessionId },
      null,
      null,
    );
    if (typeof added === "string") throw new Error(`placement failed: ${added}`);

    expect(bodiesOfType(inside.socket, "terminal_opened").at(-1)).toMatchObject({
      elementId: added.tileId,
      session: { id: born.sessionId, name: "build", padId: composition.id },
    });
  });

  test("a pad-scoped token cannot rename a terminal or organize the index", async () => {
    const fixture = indexFixture();
    const born = openTerminal(fixture);
    const token = padScopedToken(fixture);

    const renamed = await call(fixture, "PATCH", `/api/terminals/${born.sessionId}`, token, {
      name: "build",
    });
    // Reordering a terminal IS moving its home in the one index, so the gate that refuses it
    // is the pad-tree gate rather than a terminal-pool gate that no longer exists.
    const moved = await call(fixture, "PUT", "/api/pad-tree", token, {
      item: { kind: "pad", id: born.homeId },
      parentId: null,
      index: 0,
    });

    expect([renamed.status, moved.status]).toEqual([403, 403]);
    expect(fixture.store.getSession(born.sessionId)?.name).toBeNull();
  });
});

describe("DELETE /api/terminals/:id", () => {
  test("killing a terminal drops its row and its home from the index at once", async () => {
    const fixture = indexFixture();
    const born = openTerminal(fixture);
    // Nothing on any canvas points at this terminal, and it is still reachable: the index
    // addresses a terminal by identity, never through a placement of it.
    expect(room(fixture, fixture.canvas.id).portalIdsTo(born.homeId)).toEqual([]);
    fixture.machine.clear();

    const killed = await call(fixture, "DELETE", `/api/terminals/${born.sessionId}`, OWNER_KEY);
    // The machine answers a kill by reporting the exit; the row it would have updated is
    // already gone, so this cannot resurrect it as an exited entry.
    fixture.broker.onExited(fixture.machine.machineId, born.sessionId, 0);
    const listed = await call(fixture, "GET", "/api/terminals", OWNER_KEY);
    const again = await call(fixture, "DELETE", `/api/terminals/${born.sessionId}`, OWNER_KEY);
    const missing = await call(fixture, "DELETE", "/api/terminals/missing", OWNER_KEY);

    expect(killed.status).toBe(200);
    expect(killed.payload).toEqual({ ok: true });
    expect(fixture.machine.sent).toEqual([{ type: "kill", sessionId: born.sessionId }]);
    // A kill removes the terminal from the world, so the index has no row to show and the
    // home it lived in is gone with it. There is no tombstone state between the two.
    expect(TerminalsResponseSchema.parse(listed.payload).terminals).toEqual([]);
    expect(fixture.store.getSession(born.sessionId)).toBeNull();
    expect(fixture.store.getPad(born.homeId)).toBeNull();
    expect([again.status, missing.status]).toEqual([404, 404]);
    expect(again.payload).toMatchObject({ error: { code: "not_found" } });
    expect(missing.payload).toMatchObject({ error: { code: "not_found" } });
  });

  test("a pad-scoped token cannot kill a terminal", async () => {
    const fixture = indexFixture();
    const born = openTerminal(fixture);

    const response = await call(
      fixture,
      "DELETE",
      `/api/terminals/${born.sessionId}`,
      padScopedToken(fixture),
    );

    expect(response.status).toBe(403);
    expect(fixture.store.getSession(born.sessionId)?.status).toBe("running");
  });
});

describe("PUT /api/pad-tree is how an unplaced terminal is reordered", () => {
  test("a solo composition moves into a folder and reads back under it", async () => {
    const fixture = indexFixture();
    const born = openTerminal(fixture);
    const created = await call(fixture, "POST", "/api/pad-folders", OWNER_KEY, {
      name: "machines",
    });
    expect(created.status).toBe(200);
    const folder = PadTreeResponseSchema.parse(created.payload).items.find(
      (item) => item.kind === "folder",
    );
    if (folder?.kind !== "folder") throw new Error("missing folder");

    const moved = await call(fixture, "PUT", "/api/pad-tree", OWNER_KEY, {
      item: { kind: "pad", id: born.homeId },
      parentId: folder.id,
      index: 0,
    });
    const listed = await call(fixture, "GET", "/api/pad-tree", OWNER_KEY);

    expect(moved.status).toBe(200);
    // The terminal was never reordered: its HOME was. That is the whole of what replaced the
    // pool's durable sort order, and it is why organizing terminals needs no terminal route.
    for (const payload of [moved.payload, listed.payload]) {
      const home = PadTreeResponseSchema.parse(payload).items.find(
        (item) => item.kind === "pad" && item.pad.id === born.homeId,
      );
      expect(home).toEqual({
        kind: "pad",
        pad: { id: born.homeId, name: MACHINE_NAME, createdAt: 0, layout: "tiled" },
        parentId: folder.id,
        sortOrder: 0,
      });
    }
    // Moving a container never touches where the terminal lives.
    expect(homeOf(fixture, born.sessionId)).toBe(born.homeId);
  });
});

describe("GET /api/pad-sessions", () => {
  test("the pad session listing reports each terminal under its home", async () => {
    const fixture = indexFixture();
    const solo = openTerminal(fixture);
    const merged = openTerminal(fixture);
    const composition = tiledPad(fixture, "composition");
    const added = placeTile(
      fixture.placement,
      composition.id,
      { kind: "terminal", sessionId: merged.sessionId },
      null,
      null,
    );
    if (typeof added === "string") throw new Error(`placement failed: ${added}`);

    const response = await call(fixture, "GET", "/api/pad-sessions", OWNER_KEY);

    expect(response.status).toBe(200);
    const sessions = PadSessionsResponseSchema.parse(response.payload).sessions;
    // Every session has a pad, so nothing is omitted here any more: the listing is a join of
    // terminals onto the containers they live in.
    expect([...sessions.map((session) => session.id)].sort()).toEqual(
      [solo.sessionId, merged.sessionId].sort(),
    );
    expect(sessions.find((session) => session.id === solo.sessionId)?.padId).toBe(solo.homeId);
    expect(sessions.find((session) => session.id === merged.sessionId)?.padId).toBe(composition.id);
  });
});
