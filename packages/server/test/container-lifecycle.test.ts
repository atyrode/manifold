import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ROOT_TILE_ID,
  ServerToAgentMessageSchema,
  type Pad,
  type SceneElement,
  type ServerToAgentMessage,
} from "@manifold/protocol";
import {
  DEFAULT_TERMINAL_HEIGHT,
  DEFAULT_TERMINAL_WIDTH,
  LOCAL_ORIGIN,
  readElement,
  readElements,
  removeElement,
  tileLeafIds,
  writeElement,
} from "@manifold/scene";
import { AuthService, type AuthContext } from "../src/auth.ts";
import { loadConfig } from "../src/config.ts";
import { HttpApp } from "../src/http.ts";
import { silentLogger } from "../src/log.ts";
import { MachineGateway } from "../src/machine-ws.ts";
import { RoomManager, type Room } from "../src/room.ts";
import { SessionPeer } from "../src/session-peer.ts";
import type { ServerStore } from "../src/stores.ts";
import { TerminalBroker, type MachineChannel } from "../src/terminal-broker.ts";
import { FakeClock, FakeRuntime, FakeSocket, testStore } from "./helpers.ts";

const OWNER_KEY = "c".repeat(64);
const temporaryDirectories: string[] = [];

class FakeMachine implements MachineChannel {
  readonly sent: ServerToAgentMessage[] = [];

  constructor(readonly machineId: string) {}

  send(message: ServerToAgentMessage): boolean {
    this.sent.push(ServerToAgentMessageSchema.parse(message));
    return true;
  }
}

function terminalElement(id: string, sessionId: string, x = 0, y = 0): SceneElement {
  return {
    id,
    type: "terminal",
    sessionId,
    x,
    y,
    width: DEFAULT_TERMINAL_WIDTH,
    height: DEFAULT_TERMINAL_HEIGHT,
    zIndex: 0,
  };
}

/** Bubble lifecycle under test: broker, room manager, and HTTP surface on one store. */
interface ContainerFixture {
  runtime: FakeRuntime;
  clock: FakeClock;
  store: ServerStore;
  auth: AuthService;
  root: AuthContext;
  pad: Pad;
  rooms: RoomManager;
  broker: TerminalBroker;
  machine: FakeMachine;
  socket: FakeSocket;
  opener: SessionPeer;
  app: HttpApp;
}

function containerFixture(): ContainerFixture {
  const cwd = mkdtempSync(join(tmpdir(), "manifold-container-test-"));
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
  const pad: Pad = {
    id: runtime.newId(),
    name: "canvas pad",
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
  rooms.setEmptyHandler((padId) => broker.dissolveIfBubble(padId));
  const machines = new MachineGateway(
    auth,
    store,
    broker,
    clock,
    silentLogger,
    "server-epoch",
    runtime,
  );
  const enrollment = auth.enrollMachine("container machine", root);
  const machine = new FakeMachine(enrollment.machine.id);
  broker.setMachineOnline(machine);
  const socket = new FakeSocket();
  const opener = new SessionPeer(runtime.newId(), socket, root, pad.id);
  const app = new HttpApp(config, store, auth, rooms, broker, machines, runtime, silentLogger);
  return { runtime, clock, store, auth, root, pad, rooms, broker, machine, socket, opener, app };
}

/** Opens one terminal, commits its create, and authors its canvas element. */
function placedTerminal(fixture: ContainerFixture, elementId: string, x = 0): string {
  fixture.broker.open(fixture.opener, { type: "terminal_open", elementId, cols: 80, rows: 24 });
  const create = fixture.machine.sent.filter((message) => message.type === "create").at(-1);
  if (create === undefined || create.type !== "create") throw new Error("missing create request");
  fixture.broker.onCreated(fixture.machine.machineId, create.sessionId);
  const room = canvasRoom(fixture);
  writeElement(room.doc, terminalElement(elementId, create.sessionId, x), LOCAL_ORIGIN);
  return create.sessionId;
}

/** Materializes the canvas room with the opener joined so broadcasts are observable. */
function canvasRoom(fixture: ContainerFixture): Room {
  const room = fixture.rooms.get(fixture.pad.id);
  if (room === null) throw new Error("missing canvas room");
  return room;
}

function room(fixture: ContainerFixture, padId: string): Room {
  const found = fixture.rooms.get(padId);
  if (found === null) throw new Error(`missing room ${padId}`);
  return found;
}

/** Joins a fresh connection to a container so leaving it fires the room-empty hook. */
function occupy(fixture: ContainerFixture, padId: string): { leave: () => void } {
  const peer = new SessionPeer(fixture.runtime.newId(), new FakeSocket(), fixture.root, padId);
  const target = room(fixture, padId);
  target.join(peer);
  return {
    leave: () => {
      target.leave(peer);
    },
  };
}

/**
 * Joins the read-only socket a collaborator's widget preview opens onto a container.
 * Watching must never be participation: the bubble rule has to ignore this peer.
 */
function watch(
  fixture: ContainerFixture,
  padId: string,
): { socket: FakeSocket; leave: () => void } {
  const socket = new FakeSocket();
  const peer = new SessionPeer(fixture.runtime.newId(), socket, fixture.root, padId, true);
  const target = room(fixture, padId);
  target.join(peer);
  return {
    socket,
    leave: () => {
      target.leave(peer);
    },
  };
}

function expanded(fixture: ContainerFixture, sessionId: string): string {
  const result = fixture.broker.expand(sessionId);
  if (typeof result === "string") throw new Error(`expand failed: ${result}`);
  return result.viewId;
}

/** Parks a placed terminal into the workspace pool. */
function pooled(fixture: ContainerFixture, elementId: string, sessionId: string): string {
  if (fixture.broker.park(sessionId, elementId) !== "ok") throw new Error("park failed");
  return sessionId;
}

async function call(
  fixture: ContainerFixture,
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

function padScopedToken(fixture: ContainerFixture): string {
  return fixture.auth.mintToken(
    {
      principal: { name: "pad guest", kind: "human" },
      caps: ["pads:read", "pads:write", "scene:write", "terminal:write"],
      padId: fixture.pad.id,
    },
    fixture.root,
  ).token;
}

/** The only surface a single-leaf container shows, for bubble assertions. */
function soleSurface(fixture: ContainerFixture, padId: string): unknown {
  const layout = room(fixture, padId).tileLayout();
  if (layout === null) throw new Error("missing layout");
  const leaves = tileLeafIds(layout);
  if (leaves.length !== 1) throw new Error(`expected one leaf, saw ${leaves.length}`);
  const leafId = leaves[0];
  return leafId === undefined ? null : (layout[leafId]?.surface ?? null);
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("TerminalBroker expand", () => {
  test("a canvas terminal becomes a portal while its session rebinds into a bubble", () => {
    const fixture = containerFixture();
    const sessionId = placedTerminal(fixture, "terminal-1");
    const canvas = canvasRoom(fixture);
    canvas.join(fixture.opener);
    fixture.socket.clear();

    const viewId = expanded(fixture, sessionId);

    expect(fixture.store.getPad(viewId)).toMatchObject({ layout: "tiled", transient: true });
    expect(fixture.store.padOriginPadId(viewId)).toBe(fixture.pad.id);
    expect(readElement(canvas.doc, "terminal-1")).toEqual({
      id: "terminal-1",
      type: "portal",
      containerId: viewId,
      x: 0,
      y: 0,
      width: DEFAULT_TERMINAL_WIDTH,
      height: DEFAULT_TERMINAL_HEIGHT,
      zIndex: 0,
    });
    expect(fixture.store.getSession(sessionId)?.padId).toBe(viewId);
    expect(soleSurface(fixture, viewId)).toEqual({ kind: "terminal", sessionId });
    expect(fixture.broker.listForPad(fixture.pad.id)).toEqual([]);
    expect(fixture.broker.listForPad(viewId).map((session) => session.id)).toEqual([sessionId]);
    expect(
      fixture.socket
        .messages()
        .filter((message) => message.type === "session_event")
        .at(-1),
    ).toEqual({ type: "session_event", sessionId, kind: "parked" });
  });

  test("a pooled terminal expands into a bubble with no return address", () => {
    const fixture = containerFixture();
    const sessionId = pooled(fixture, "terminal-1", placedTerminal(fixture, "terminal-1"));
    const canvas = canvasRoom(fixture);

    const viewId = expanded(fixture, sessionId);

    expect(fixture.store.getPad(viewId)).toMatchObject({ layout: "tiled", transient: true });
    expect(fixture.store.padOriginPadId(viewId)).toBeNull();
    expect(fixture.store.getSession(sessionId)?.padId).toBe(viewId);
    expect(fixture.store.listParkedSessions()).toEqual([]);
    expect(readElements(canvas.doc).size).toBe(0);
    expect(soleSurface(fixture, viewId)).toEqual({ kind: "terminal", sessionId });
  });

  test("expanding an unknown or exited terminal never creates a container", () => {
    const fixture = containerFixture();
    const sessionId = placedTerminal(fixture, "terminal-1");
    fixture.broker.onExited(fixture.machine.machineId, sessionId, 0);

    expect(fixture.broker.expand("missing-session")).toBe("not_found");
    expect(fixture.broker.expand(sessionId)).toBe("exited");
    expect(fixture.store.listPads().map((pad) => pad.id)).toEqual([fixture.pad.id]);
  });

  test("a tiled container reports its tile leaves as session references", () => {
    const fixture = containerFixture();
    const sessionId = placedTerminal(fixture, "terminal-1");

    const viewId = expanded(fixture, sessionId);

    expect(room(fixture, viewId).referencesSession(sessionId)).toBe(true);
    expect(room(fixture, viewId).referencesSession("other-session")).toBe(false);
    expect(canvasRoom(fixture).referencesSession(sessionId)).toBe(false);
  });

  test("the expand endpoint answers with the new view id under the terminal auth gates", async () => {
    const fixture = containerFixture();
    const sessionId = placedTerminal(fixture, "terminal-1");
    const exitedId = placedTerminal(fixture, "terminal-2");
    fixture.broker.onExited(fixture.machine.machineId, exitedId, 0);

    const scoped = await call(
      fixture,
      "POST",
      `/api/terminals/${sessionId}/expand`,
      padScopedToken(fixture),
    );
    const response = await call(fixture, "POST", `/api/terminals/${sessionId}/expand`, OWNER_KEY);
    const exited = await call(fixture, "POST", `/api/terminals/${exitedId}/expand`, OWNER_KEY);
    const missing = await call(fixture, "POST", "/api/terminals/missing/expand", OWNER_KEY);

    expect(scoped.status).toBe(403);
    expect(response.status).toBe(200);
    const payload = response.payload;
    if (typeof payload !== "object" || payload === null || !("viewId" in payload)) {
      throw new Error("missing viewId in expand response");
    }
    const viewId = payload.viewId;
    if (typeof viewId !== "string") throw new Error("viewId must be a string");
    expect(fixture.store.getPad(viewId)).toMatchObject({ layout: "tiled", transient: true });
    expect(fixture.store.getSession(sessionId)?.padId).toBe(viewId);
    expect(exited.status).toBe(409);
    expect(missing.status).toBe(404);
  });
});

describe("TerminalBroker bubble dissolve", () => {
  test("the last occupant leaving pops the bubble back into its canvas slot", () => {
    const fixture = containerFixture();
    const sessionId = placedTerminal(fixture, "terminal-1", 40);
    const viewId = expanded(fixture, sessionId);
    const occupant = occupy(fixture, viewId);

    occupant.leave();

    expect(fixture.store.getPad(viewId)).toBeNull();
    expect(fixture.store.getSession(sessionId)?.padId).toBe(fixture.pad.id);
    expect(readElement(canvasRoom(fixture).doc, "terminal-1")).toEqual(
      terminalElement("terminal-1", sessionId, 40),
    );
    expect(fixture.store.listParkedSessions()).toEqual([]);
  });

  test("a collaborator watching the widget cannot keep the bubble from popping", () => {
    const fixture = containerFixture();
    const sessionId = placedTerminal(fixture, "terminal-1", 40);
    const viewId = expanded(fixture, sessionId);
    const occupant = occupy(fixture, viewId);
    // The origin canvas paints a live view widget, which holds a real socket into this
    // room for as long as anyone is looking at it.
    const watcher = watch(fixture, viewId);

    occupant.leave();

    expect(fixture.store.getPad(viewId)).toBeNull();
    expect(readElement(canvasRoom(fixture).doc, "terminal-1")).toEqual(
      terminalElement("terminal-1", sessionId, 40),
    );
    // The watched container is gone, so its watcher is fenced exactly like any other
    // socket on a deleted pad — the preview tears down instead of reading a dead room.
    expect(watcher.socket.closed).toEqual({ code: 4404, reason: "pad deleted" });
  });

  test("a watcher joining and hanging up never pops the bubble it previewed", () => {
    const fixture = containerFixture();
    const sessionId = placedTerminal(fixture, "terminal-1");
    const viewId = expanded(fixture, sessionId);

    // The newborn-expand window: both canvases open previews into the view while its
    // expander is still walking in, and the expander's own preview leaves as it
    // navigates. Neither joining nor leaving may be read as occupancy changing.
    const watcher = watch(fixture, viewId);
    expect(fixture.rooms.presence().map((entry) => entry.padId)).not.toContain(viewId);

    watcher.leave();

    expect(fixture.store.getPad(viewId)).not.toBeNull();
    expect(readElement(canvasRoom(fixture).doc, "terminal-1")?.type).toBe("portal");
    expect(fixture.store.getSession(sessionId)?.padId).toBe(viewId);
  });

  test("a portal deleted mid-focus sends the popped terminal to the pool instead", () => {
    const fixture = containerFixture();
    const sessionId = placedTerminal(fixture, "terminal-1");
    const viewId = expanded(fixture, sessionId);
    const occupant = occupy(fixture, viewId);
    removeElement(canvasRoom(fixture).doc, "terminal-1", LOCAL_ORIGIN);

    occupant.leave();

    expect(fixture.store.getPad(viewId)).toBeNull();
    expect(fixture.store.getSession(sessionId)?.padId).toBeNull();
    expect(fixture.store.listParkedSessions().map((session) => session.id)).toEqual([sessionId]);
    expect(readElements(canvasRoom(fixture).doc).size).toBe(0);
  });

  test("a split view survives its last occupant and keeps both tiles", () => {
    const fixture = containerFixture();
    const first = placedTerminal(fixture, "terminal-1");
    const second = pooled(fixture, "terminal-2", placedTerminal(fixture, "terminal-2"));
    const viewId = expanded(fixture, first);
    const added = fixture.broker.addTile(
      viewId,
      { kind: "terminal", sessionId: second },
      null,
      null,
    );
    if (typeof added === "string") throw new Error(`addTile failed: ${added}`);
    const occupant = occupy(fixture, viewId);

    occupant.leave();

    const view = fixture.store.getPad(viewId);
    expect(view).toMatchObject({ layout: "tiled", transient: false });
    const layout = room(fixture, viewId).tileLayout();
    expect(layout === null ? [] : tileLeafIds(layout)).toHaveLength(2);
    expect(fixture.store.getSession(first)?.padId).toBe(viewId);
    expect(fixture.store.getSession(second)?.padId).toBe(viewId);
  });

  test("a canvas pad is never dissolved by the room-empty hook", () => {
    const fixture = containerFixture();
    placedTerminal(fixture, "terminal-1");
    const occupant = occupy(fixture, fixture.pad.id);

    occupant.leave();

    expect(fixture.store.getPad(fixture.pad.id)).not.toBeNull();
  });
});

describe("TerminalBroker container hardening", () => {
  test("a second tile hardens the bubble without giving up its return address", () => {
    const fixture = containerFixture();
    const first = placedTerminal(fixture, "terminal-1");
    const second = pooled(fixture, "terminal-2", placedTerminal(fixture, "terminal-2"));
    const viewId = expanded(fixture, first);

    fixture.broker.addTile(viewId, { kind: "terminal", sessionId: second }, null, null);

    expect(fixture.store.getPad(viewId)?.transient).toBe(false);
    expect(fixture.store.padOriginPadId(viewId)).toBe(fixture.pad.id);
  });

  test("renaming a bubble claims it: hardened, return address cleared, never popped", async () => {
    const fixture = containerFixture();
    const sessionId = placedTerminal(fixture, "terminal-1");
    const viewId = expanded(fixture, sessionId);
    const occupant = occupy(fixture, viewId);

    const renamed = await call(fixture, "PATCH", `/api/pads/${viewId}`, OWNER_KEY, {
      name: "deploy view",
    });
    occupant.leave();

    expect(renamed.status).toBe(200);
    expect(renamed.payload).toEqual({
      pad: {
        id: viewId,
        name: "deploy view",
        createdAt: 0,
        layout: "tiled",
        transient: false,
      },
    });
    expect(fixture.store.padOriginPadId(viewId)).toBeNull();
    expect(fixture.store.getPad(viewId)).not.toBeNull();
    expect(fixture.store.getSession(sessionId)?.padId).toBe(viewId);
  });

  test("pinning a bubble keeps it after its last occupant leaves", async () => {
    const fixture = containerFixture();
    const sessionId = placedTerminal(fixture, "terminal-1");
    const viewId = expanded(fixture, sessionId);
    const occupant = occupy(fixture, viewId);

    const pinned = await call(fixture, "POST", `/api/pads/${viewId}/pin`, OWNER_KEY);
    const missing = await call(fixture, "POST", "/api/pads/missing-pad/pin", OWNER_KEY);
    const scoped = await call(fixture, "POST", `/api/pads/${viewId}/pin`, padScopedToken(fixture));
    occupant.leave();

    expect(pinned.status).toBe(200);
    expect(pinned.payload).toEqual({ ok: true });
    expect(missing.status).toBe(404);
    expect(scoped.status).toBe(403);
    expect(fixture.store.getPad(viewId)).toMatchObject({ transient: false });
    expect(fixture.store.padOriginPadId(viewId)).toBeNull();
  });
});

describe("terminal_open into a tiled container", () => {
  /** Joins a peer to a container so its own socket observes the replies it earns. */
  function viewPeer(
    fixture: ContainerFixture,
    padId: string,
  ): { peer: SessionPeer; socket: FakeSocket } {
    const socket = new FakeSocket();
    const peer = new SessionPeer(fixture.runtime.newId(), socket, fixture.root, padId);
    room(fixture, padId).join(peer);
    return { peer, socket };
  }

  test("the Machines + inside a view births a terminal the server places as a tile", () => {
    const fixture = containerFixture();
    const viewId = expanded(fixture, placedTerminal(fixture, "terminal-1"));
    const inView = viewPeer(fixture, viewId);

    fixture.broker.open(inView.peer, {
      type: "terminal_open",
      elementId: "open-ref-1",
      cols: 100,
      rows: 30,
      placement: "tile",
    });
    const create = fixture.machine.sent.filter((message) => message.type === "create").at(-1);
    if (create === undefined || create.type !== "create") throw new Error("missing create request");
    // A tiled birth has no placement id at create time: the leaf is authored on commit,
    // so the PTY learns its container and nothing more.
    expect(create.env.MANIFOLD_PAD).toBe(viewId);
    expect(create.env.MANIFOLD_ELEMENT).toBeUndefined();
    fixture.broker.onCreated(fixture.machine.machineId, create.sessionId);

    const opened = inView.socket
      .messages()
      .filter((message) => message.type === "terminal_opened")
      .at(-1);
    if (opened?.type !== "terminal_opened") throw new Error("missing terminal_opened");
    // The opener never chose a tile id, so the reply echoes the ref it did choose.
    expect(opened.ref).toBe("open-ref-1");
    expect(opened.session).toMatchObject({
      id: create.sessionId,
      padId: viewId,
      elementId: opened.elementId,
      cols: 100,
      rows: 30,
      // Opening earns the lease exactly as it does on a canvas.
      controllerId: fixture.root.principal.id,
    });
    const layout = room(fixture, viewId).tileLayout();
    expect(layout?.[opened.elementId]?.surface).toEqual({
      kind: "terminal",
      sessionId: create.sessionId,
    });
    expect(tileLeafIds(layout ?? {})).toHaveLength(2);
    expect(fixture.store.getSession(create.sessionId)).toMatchObject({
      padId: viewId,
      elementId: opened.elementId,
      machineId: fixture.machine.machineId,
    });
    // Two leaves are a composition, not a bubble: the container it grew out of is durable.
    expect(fixture.store.getPad(viewId)?.transient).toBe(false);
  });

  test("a view open targets the machine the sidebar row named", () => {
    const fixture = containerFixture();
    const viewId = expanded(fixture, placedTerminal(fixture, "terminal-1"));
    const inView = viewPeer(fixture, viewId);
    const second = new FakeMachine(
      fixture.auth.enrollMachine("second machine", fixture.root).machine.id,
    );
    fixture.broker.setMachineOnline(second);

    fixture.broker.open(inView.peer, {
      type: "terminal_open",
      elementId: "open-ref-ambiguous",
      cols: 80,
      rows: 24,
      placement: "tile",
    });
    fixture.broker.open(inView.peer, {
      type: "terminal_open",
      elementId: "open-ref-2",
      cols: 80,
      rows: 24,
      placement: "tile",
      machineId: second.machineId,
    });
    const create = second.sent.filter((message) => message.type === "create").at(-1);
    if (create === undefined || create.type !== "create") throw new Error("missing create request");
    fixture.broker.onCreated(second.machineId, create.sessionId);

    expect(inView.socket.messages().filter((message) => message.type === "error")).toMatchObject([
      { code: "no_machine", ref: "open-ref-ambiguous" },
    ]);
    expect(fixture.machine.sent.filter((message) => message.type === "create")).toHaveLength(1);
    expect(fixture.store.getSession(create.sessionId)).toMatchObject({
      padId: viewId,
      machineId: second.machineId,
    });
    expect(tileLeafIds(room(fixture, viewId).tileLayout() ?? {})).toHaveLength(2);
  });

  test("a discipline mismatch is refused before any PTY is spawned", () => {
    const fixture = containerFixture();
    const viewId = expanded(fixture, placedTerminal(fixture, "terminal-1"));
    const inView = viewPeer(fixture, viewId);
    const creates = fixture.machine.sent.filter((message) => message.type === "create").length;

    // A view has no canvas to author on: an element-placing open would strand the PTY.
    fixture.broker.open(inView.peer, {
      type: "terminal_open",
      elementId: "canvas-shaped",
      cols: 80,
      rows: 24,
    });
    // A canvas has no layout tree: the server has nowhere to author a leaf.
    fixture.broker.open(fixture.opener, {
      type: "terminal_open",
      elementId: "tile-shaped",
      cols: 80,
      rows: 24,
      placement: "tile",
    });

    expect(inView.socket.messages().filter((message) => message.type === "error")).toMatchObject([
      { code: "conflict", ref: "canvas-shaped" },
    ]);
    expect(fixture.socket.messages().filter((message) => message.type === "error")).toMatchObject([
      { code: "conflict", ref: "tile-shaped" },
    ]);
    expect(fixture.machine.sent.filter((message) => message.type === "create")).toHaveLength(
      creates,
    );
    expect(tileLeafIds(room(fixture, viewId).tileLayout() ?? {})).toHaveLength(1);
  });
});

describe("pad tiles HTTP routes", () => {
  test("binding a pooled terminal to a view places a tile and returns its tile id", async () => {
    const fixture = containerFixture();
    const resident = placedTerminal(fixture, "terminal-1");
    const pooledId = pooled(fixture, "terminal-2", placedTerminal(fixture, "terminal-2"));
    const viewId = expanded(fixture, resident);

    const response = await call(fixture, "POST", `/api/terminals/${pooledId}/bind`, OWNER_KEY, {
      padId: viewId,
      x: 10,
      y: 20,
    });

    expect(response.status).toBe(200);
    const payload = response.payload;
    if (typeof payload !== "object" || payload === null || !("elementId" in payload)) {
      throw new Error("missing elementId in bind response");
    }
    const tileId = payload.elementId;
    if (typeof tileId !== "string") throw new Error("elementId must be a string");
    const layout = room(fixture, viewId).tileLayout();
    expect(layout?.[tileId]?.surface).toEqual({ kind: "terminal", sessionId: pooledId });
    // A tiled container has no coordinates to honour, so nothing lands on a canvas.
    expect(readElement(canvasRoom(fixture).doc, tileId)).toBeNull();
    expect(fixture.store.getSession(pooledId)?.padId).toBe(viewId);
  });

  test("a pooled terminal tiles into a view and rebinds to it", async () => {
    const fixture = containerFixture();
    const resident = placedTerminal(fixture, "terminal-1");
    const pooledId = pooled(fixture, "terminal-2", placedTerminal(fixture, "terminal-2"));
    const viewId = expanded(fixture, resident);

    const response = await call(fixture, "POST", `/api/pads/${viewId}/tiles`, OWNER_KEY, {
      surface: { kind: "terminal", sessionId: pooledId },
      targetTileId: ROOT_TILE_ID,
      edge: "right",
    });

    expect(response.status).toBe(200);
    expect(response.payload).toMatchObject({ tileId: expect.any(String) });
    expect(fixture.store.getSession(pooledId)?.padId).toBe(viewId);
    expect(fixture.store.listParkedSessions()).toEqual([]);
    const layout = room(fixture, viewId).tileLayout();
    expect(layout === null ? [] : tileLeafIds(layout)).toHaveLength(2);
  });

  test("a canvas pad tiles in as an embedded surface", async () => {
    const fixture = containerFixture();
    const sessionId = placedTerminal(fixture, "terminal-1");
    const viewId = expanded(fixture, sessionId);
    const embedded: Pad = {
      id: fixture.runtime.newId(),
      name: "embedded canvas",
      createdAt: fixture.runtime.now(),
      layout: "canvas",
      transient: false,
    };
    fixture.store.createPad(embedded);

    const response = await call(fixture, "POST", `/api/pads/${viewId}/tiles`, OWNER_KEY, {
      surface: { kind: "pad", padId: embedded.id },
      targetTileId: null,
      edge: null,
    });

    expect(response.status).toBe(200);
    const layout = room(fixture, viewId).tileLayout();
    const surfaces = Object.values(layout ?? {}).map((node) => node.surface);
    expect(surfaces).toContainEqual({ kind: "pad", padId: embedded.id });
  });

  test("the tiles endpoint rejects every illegal surface without mutating the tree", async () => {
    const fixture = containerFixture();
    const resident = placedTerminal(fixture, "terminal-1");
    const boundElsewhere = placedTerminal(fixture, "terminal-2");
    const viewId = expanded(fixture, resident);
    const otherViewId = expanded(fixture, boundElsewhere);

    const canvasTarget = await call(
      fixture,
      "POST",
      `/api/pads/${fixture.pad.id}/tiles`,
      OWNER_KEY,
      {
        surface: { kind: "terminal", sessionId: resident },
        targetTileId: null,
        edge: null,
      },
    );
    const selfReference = await call(fixture, "POST", `/api/pads/${viewId}/tiles`, OWNER_KEY, {
      surface: { kind: "pad", padId: viewId },
      targetTileId: null,
      edge: null,
    });
    const tiledSurface = await call(fixture, "POST", `/api/pads/${viewId}/tiles`, OWNER_KEY, {
      surface: { kind: "pad", padId: otherViewId },
      targetTileId: null,
      edge: null,
    });
    const foreignTerminal = await call(fixture, "POST", `/api/pads/${viewId}/tiles`, OWNER_KEY, {
      surface: { kind: "terminal", sessionId: boundElsewhere },
      targetTileId: null,
      edge: null,
    });
    const missingPadSurface = await call(fixture, "POST", `/api/pads/${viewId}/tiles`, OWNER_KEY, {
      surface: { kind: "pad", padId: "missing-pad" },
      targetTileId: null,
      edge: null,
    });
    const missingTerminal = await call(fixture, "POST", `/api/pads/${viewId}/tiles`, OWNER_KEY, {
      surface: { kind: "terminal", sessionId: "missing-session" },
      targetTileId: null,
      edge: null,
    });
    const missingContainer = await call(fixture, "POST", "/api/pads/missing-pad/tiles", OWNER_KEY, {
      surface: { kind: "terminal", sessionId: resident },
      targetTileId: null,
      edge: null,
    });
    const unknownTarget = await call(fixture, "POST", `/api/pads/${viewId}/tiles`, OWNER_KEY, {
      surface: { kind: "terminal", sessionId: resident },
      targetTileId: "t99",
      edge: "right",
    });
    const scoped = await call(
      fixture,
      "POST",
      `/api/pads/${viewId}/tiles`,
      padScopedToken(fixture),
      {
        surface: { kind: "terminal", sessionId: resident },
        targetTileId: null,
        edge: null,
      },
    );

    expect([
      canvasTarget.status,
      selfReference.status,
      tiledSurface.status,
      foreignTerminal.status,
      missingPadSurface.status,
      missingTerminal.status,
      missingContainer.status,
      unknownTarget.status,
      scoped.status,
    ]).toEqual([409, 409, 409, 409, 404, 404, 404, 409, 403]);
    expect(soleSurface(fixture, viewId)).toEqual({ kind: "terminal", sessionId: resident });
    expect(fixture.store.getPad(viewId)?.transient).toBe(true);
  });

  test("deleting a terminal tile parks its session when it was the last placement", async () => {
    const fixture = containerFixture();
    const sessionId = placedTerminal(fixture, "terminal-1");
    const viewId = expanded(fixture, sessionId);
    const tileId = ROOT_TILE_ID;

    const removed = await call(fixture, "DELETE", `/api/pads/${viewId}/tiles/${tileId}`, OWNER_KEY);
    const missing = await call(fixture, "DELETE", `/api/pads/${viewId}/tiles/t42`, OWNER_KEY);

    expect(removed.status).toBe(200);
    expect(removed.payload).toEqual({ ok: true });
    expect(fixture.store.getSession(sessionId)?.padId).toBeNull();
    expect(fixture.store.listParkedSessions().map((session) => session.id)).toEqual([sessionId]);
    expect(soleSurface(fixture, viewId)).toBeNull();
    expect(missing.status).toBe(404);
  });

  test("an emptied bubble takes its widget with it when the last occupant leaves", async () => {
    const fixture = containerFixture();
    const sessionId = placedTerminal(fixture, "terminal-1");
    const viewId = expanded(fixture, sessionId);
    const occupant = occupy(fixture, viewId);
    await call(fixture, "DELETE", `/api/pads/${viewId}/tiles/${ROOT_TILE_ID}`, OWNER_KEY);

    occupant.leave();

    expect(fixture.store.getPad(viewId)).toBeNull();
    // The portal would otherwise point at a container that no longer exists.
    expect(readElements(canvasRoom(fixture).doc).size).toBe(0);
    expect(fixture.store.listParkedSessions().map((session) => session.id)).toEqual([sessionId]);
  });
});

describe("TerminalBroker composeOnCanvas", () => {
  test("dropping one terminal on another births a hardened view named after both", async () => {
    const fixture = containerFixture();
    const target = placedTerminal(fixture, "terminal-1", 200);
    const dragged = placedTerminal(fixture, "terminal-2", 600);
    fixture.broker.rename(target, "alpha");
    fixture.broker.rename(dragged, "beta");
    const canvas = canvasRoom(fixture);

    const response = await call(fixture, "POST", `/api/pads/${fixture.pad.id}/compose`, OWNER_KEY, {
      targetElementId: "terminal-1",
      surface: { kind: "terminal", sessionId: dragged },
      edge: "right",
    });

    expect(response.status).toBe(200);
    const payload = response.payload;
    if (typeof payload !== "object" || payload === null || !("viewId" in payload)) {
      throw new Error("missing viewId in compose response");
    }
    const viewId = payload.viewId;
    if (typeof viewId !== "string") throw new Error("viewId must be a string");
    expect(fixture.store.getPad(viewId)).toMatchObject({
      name: "alpha + beta",
      layout: "tiled",
      transient: false,
    });
    // Composition keeps the return address: the view is durable but not yet claimed.
    expect(fixture.store.padOriginPadId(viewId)).toBe(fixture.pad.id);
    expect(readElement(canvas.doc, "terminal-1")).toEqual({
      id: "terminal-1",
      type: "portal",
      containerId: viewId,
      x: 200,
      y: 0,
      width: DEFAULT_TERMINAL_WIDTH,
      height: DEFAULT_TERMINAL_HEIGHT,
      zIndex: 0,
    });
    expect(readElement(canvas.doc, "terminal-2")).toBeNull();
    expect(fixture.store.getSession(target)?.padId).toBe(viewId);
    expect(fixture.store.getSession(dragged)?.padId).toBe(viewId);
    const layout = room(fixture, viewId).tileLayout();
    const surfaces = Object.values(layout ?? {})
      .map((node) => node.surface)
      .filter((surface) => surface !== null);
    expect(surfaces).toContainEqual({ kind: "terminal", sessionId: target });
    expect(surfaces).toContainEqual({ kind: "terminal", sessionId: dragged });
  });

  test("composing onto a view widget adds a tile instead of nesting views", async () => {
    const fixture = containerFixture();
    const resident = placedTerminal(fixture, "terminal-1");
    const dragged = pooled(fixture, "terminal-2", placedTerminal(fixture, "terminal-2"));
    const viewId = expanded(fixture, resident);

    const response = await call(fixture, "POST", `/api/pads/${fixture.pad.id}/compose`, OWNER_KEY, {
      targetElementId: "terminal-1",
      surface: { kind: "terminal", sessionId: dragged },
      edge: "bottom",
    });

    expect(response.status).toBe(200);
    expect(response.payload).toEqual({ viewId });
    expect(
      fixture.store
        .listPads()
        .map((pad) => pad.id)
        .sort(),
    ).toEqual([fixture.pad.id, viewId].sort());
    const layout = room(fixture, viewId).tileLayout();
    expect(layout === null ? [] : tileLeafIds(layout)).toHaveLength(2);
    expect(fixture.store.getSession(dragged)?.padId).toBe(viewId);
  });

  test("compose rejects tiled surfaces, itself, and unknown targets with no new container", async () => {
    const fixture = containerFixture();
    const target = placedTerminal(fixture, "terminal-1");
    const other = placedTerminal(fixture, "terminal-2");
    const tiledId = expanded(fixture, other);

    const tiledSurface = await call(
      fixture,
      "POST",
      `/api/pads/${fixture.pad.id}/compose`,
      OWNER_KEY,
      {
        targetElementId: "terminal-1",
        surface: { kind: "pad", padId: tiledId },
        edge: "right",
      },
    );
    const selfDrop = await call(fixture, "POST", `/api/pads/${fixture.pad.id}/compose`, OWNER_KEY, {
      targetElementId: "terminal-1",
      surface: { kind: "terminal", sessionId: target },
      edge: "right",
    });
    const missingElement = await call(
      fixture,
      "POST",
      `/api/pads/${fixture.pad.id}/compose`,
      OWNER_KEY,
      {
        targetElementId: "missing-element",
        surface: { kind: "pad", padId: fixture.pad.id },
        edge: "right",
      },
    );
    const onTiledContainer = await call(
      fixture,
      "POST",
      `/api/pads/${tiledId}/compose`,
      OWNER_KEY,
      {
        targetElementId: "terminal-1",
        surface: { kind: "terminal", sessionId: target },
        edge: "right",
      },
    );

    expect([
      tiledSurface.status,
      selfDrop.status,
      missingElement.status,
      onTiledContainer.status,
    ]).toEqual([409, 409, 404, 409]);
    expect(
      fixture.store
        .listPads()
        .map((pad) => pad.id)
        .sort(),
    ).toEqual([fixture.pad.id, tiledId].sort());
    expect(readElement(canvasRoom(fixture).doc, "terminal-1")).toMatchObject({ type: "terminal" });
  });
});

describe("pad tile extraction", () => {
  test("extracting a tile returns it to the canvas while an occupant keeps the view alive", async () => {
    const fixture = containerFixture();
    const first = placedTerminal(fixture, "terminal-1");
    const second = pooled(fixture, "terminal-2", placedTerminal(fixture, "terminal-2"));
    const viewId = expanded(fixture, first);
    const added = fixture.broker.addTile(
      viewId,
      { kind: "terminal", sessionId: second },
      null,
      null,
    );
    if (typeof added === "string") throw new Error(`addTile failed: ${added}`);
    occupy(fixture, viewId);

    const response = await call(
      fixture,
      "POST",
      `/api/pads/${viewId}/tiles/${added.tileId}/extract`,
      OWNER_KEY,
      { x: 320, y: 240 },
    );

    expect(response.status).toBe(200);
    const payload = response.payload;
    if (typeof payload !== "object" || payload === null || !("elementId" in payload)) {
      throw new Error("missing elementId in extract response");
    }
    const elementId = payload.elementId;
    if (typeof elementId !== "string") throw new Error("elementId must be a string");
    expect(readElement(canvasRoom(fixture).doc, elementId)).toMatchObject({
      type: "terminal",
      sessionId: second,
      x: 320,
      y: 240,
      width: DEFAULT_TERMINAL_WIDTH,
      height: DEFAULT_TERMINAL_HEIGHT,
    });
    expect(fixture.store.getSession(second)?.padId).toBe(fixture.pad.id);
    // The widget's own viewers hold the room open, so the leftover single tile stays.
    expect(fixture.store.getPad(viewId)).not.toBeNull();
    expect(soleSurface(fixture, viewId)).toEqual({ kind: "terminal", sessionId: first });
  });

  test("extracting the second-to-last tile of an unwatched view pops the whole widget", () => {
    const fixture = containerFixture();
    const first = placedTerminal(fixture, "terminal-1", 80);
    const second = pooled(fixture, "terminal-2", placedTerminal(fixture, "terminal-2"));
    const viewId = expanded(fixture, first);
    const added = fixture.broker.addTile(
      viewId,
      { kind: "terminal", sessionId: second },
      null,
      null,
    );
    if (typeof added === "string") throw new Error(`addTile failed: ${added}`);

    const extracted = fixture.broker.extractTile(viewId, added.tileId, 500, 300);
    if (typeof extracted === "string") throw new Error(`extract failed: ${extracted}`);

    expect(fixture.store.getPad(viewId)).toBeNull();
    expect(fixture.store.getSession(second)?.padId).toBe(fixture.pad.id);
    // The bubble popped: the remaining tile transmuted back into its original slot.
    expect(fixture.store.getSession(first)?.padId).toBe(fixture.pad.id);
    expect(readElement(canvasRoom(fixture).doc, "terminal-1")).toEqual(
      terminalElement("terminal-1", first, 80),
    );
  });

  test("a claimed view can no longer be decomposed onto a canvas", async () => {
    const fixture = containerFixture();
    const sessionId = placedTerminal(fixture, "terminal-1");
    const viewId = expanded(fixture, sessionId);
    await call(fixture, "POST", `/api/pads/${viewId}/pin`, OWNER_KEY);

    const response = await call(
      fixture,
      "POST",
      `/api/pads/${viewId}/tiles/${ROOT_TILE_ID}/extract`,
      OWNER_KEY,
      { x: 10, y: 20 },
    );

    expect(response.status).toBe(409);
    expect(fixture.store.getSession(sessionId)?.padId).toBe(viewId);
    expect(soleSurface(fixture, viewId)).toEqual({ kind: "terminal", sessionId });
  });
});
