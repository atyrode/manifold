import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActionOutcomeSchema,
  ContainerTerminalsResponseSchema,
  IndexResponseSchema,
  ServerToAgentMessageSchema,
  TerminalsResponseSchema,
  type Container,
  type ContainerTerminalSummary,
  type IndexEntry,
  type SceneElement,
  type ServerMessageBody,
  type ServerToAgentMessage,
  type TerminalSummary,
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
import { PlaceExecutor, assemblyElementTraits, assemblyItemNouns } from "../src/placement.ts";
import { OUTSIDE_SCOPE_REFUSAL } from "../src/plugin-host.ts";
import { RoomManager, type Room } from "../src/room.ts";
import { SessionChannel } from "../src/session-channel.ts";
import type { ServerStore } from "../src/stores.ts";
import { TerminalBroker, type MachineChannel } from "../src/terminal-broker.ts";
import {
  FakeClock,
  FakeRuntime,
  FakeSocket,
  placeTile,
  testPluginHost,
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
 *     `core.index.moveEntry` on that terminal's HOME, because the top level of the one index
 *     is where the unreferenced already live.
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
  canvas: Container;
  rooms: RoomManager;
  broker: TerminalBroker;
  placement: PlaceExecutor;
  machine: FakeMachine;
  opener: SessionChannel;
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
  const canvas: Container = {
    id: runtime.newId(),
    name: "index canvas",
    createdAt: runtime.now(),
    discipline: "canvas",
  };
  store.createContainer(canvas);
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
  rooms.setTerminalProvider((containerId) => broker.listForContainer(containerId));
  rooms.setPendingOpenProvider((containerId) => broker.hasPendingOpenForContainer(containerId));
  // The assembly first: the executor resolves contributed element traits against it
  // (ADR 0013 §12), and the roster arrives as a thunk exactly as production wires it.
  const plugins = testPluginHost(store, auth, rooms, broker, runtime);
  const placement = new PlaceExecutor(
    store,
    rooms,
    broker,
    runtime,
    assemblyElementTraits(() => plugins.roster()),
    assemblyItemNouns(() => plugins.roster()),
  );
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
  const opener = new SessionChannel(runtime.newId(), new FakeSocket(), root, canvas.id, "c1");
  const app = new HttpApp(
    config,
    store,
    auth,
    rooms,
    broker,
    placement,
    machines,
    plugins,
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

function room(fixture: IndexFixture, containerId: string): Room {
  const found = fixture.rooms.get(containerId);
  if (found === null) throw new Error(`missing room ${containerId}`);
  return found;
}

function homeOf(fixture: IndexFixture, terminalId: string): string {
  const containerId = fixture.store.getTerminal(terminalId)?.containerId;
  if (containerId === undefined) throw new Error(`terminal ${terminalId} has no row`);
  return containerId;
}

/** The index an action answered with: the outcome envelope, then the entries inside it. */
function actionItems(payload: unknown): readonly IndexEntry[] {
  const outcome = ActionOutcomeSchema.parse(payload);
  if (!outcome.ok) throw new Error(`action refused: ${outcome.denial.message}`);
  return IndexResponseSchema.parse(outcome.result).items;
}

/** A terminal, born from the canvas into a solo composition of its own. */
interface Born {
  readonly terminalId: string;
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
  fixture.broker.onCreated(fixture.machine.machineId, create.terminalId);
  return { terminalId: create.terminalId, homeId: homeOf(fixture, create.terminalId) };
}

function compositionContainer(fixture: IndexFixture, name: string): Container {
  const container: Container = {
    id: fixture.runtime.newId(),
    name,
    createdAt: fixture.runtime.now(),
    discipline: "composition",
  };
  fixture.store.createContainer(container);
  return container;
}

interface Witness {
  readonly peer: SessionChannel;
  readonly socket: FakeSocket;
}

function joinPeer(fixture: IndexFixture, containerId: string): Witness {
  const socket = new FakeSocket();
  const peer = new SessionChannel(fixture.runtime.newId(), socket, fixture.root, containerId, "c1");
  room(fixture, containerId).join(peer);
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

/**
 * The index and the per-container listing, through their doors. Reads are actions too now,
 * so a test asking "what does the index say" asks it the way the browser and a stranger's
 * agent do — one door, one denial vocabulary, no route left to drift from it.
 */
async function indexRows(
  fixture: IndexFixture,
  token: string = OWNER_KEY,
): Promise<readonly TerminalSummary[]> {
  const response = await call(fixture, "POST", "/api/actions/core.terminals.listAll", token, {});
  expect(response.status).toBe(200);
  const outcome = ActionOutcomeSchema.parse(response.payload);
  if (!outcome.ok) throw new Error(`index refused: ${outcome.denial.message}`);
  return TerminalsResponseSchema.parse(outcome.result).terminals;
}

async function terminalRowsByContainer(
  fixture: IndexFixture,
  token: string = OWNER_KEY,
): Promise<readonly ContainerTerminalSummary[]> {
  const response = await call(
    fixture,
    "POST",
    "/api/actions/core.terminals.listByContainer",
    token,
    {},
  );
  expect(response.status).toBe(200);
  const outcome = ActionOutcomeSchema.parse(response.payload);
  if (!outcome.ok) throw new Error(`listing refused: ${outcome.denial.message}`);
  return ContainerTerminalsResponseSchema.parse(outcome.result).terminals;
}

function containerScopedToken(fixture: IndexFixture): string {
  return fixture.auth.mintToken(
    {
      principal: { name: "container guest", kind: "human" },
      caps: ["containers:read", "containers:write", "scenes:write", "terminals:write"],
      containerId: fixture.canvas.id,
    },
    fixture.root,
  ).token;
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("core.terminals.listAll", () => {
  test("the index lists every terminal with the composition it lives in", async () => {
    const fixture = indexFixture();
    const running = openTerminal(fixture);
    const exited = openTerminal(fixture);
    fixture.broker.onExited(fixture.machine.machineId, exited.terminalId, 3);

    const terminals = await indexRows(fixture);
    // The pool listed only the UNBOUND terminals and swept the exited ones. There is nothing
    // to be unbound from now, so this is simply every terminal — and an exited one is still a
    // terminal until somebody dismisses its last leaf.
    expect([...terminals.map((terminal) => terminal.id)].sort()).toEqual(
      [running.terminalId, exited.terminalId].sort(),
    );
    expect(terminals.find((terminal) => terminal.id === running.terminalId)).toEqual({
      id: running.terminalId,
      machineId: fixture.machine.machineId,
      name: null,
      createdAt: 0,
      status: "running",
      exitCode: null,
      homeId: running.homeId,
      unplaced: true,
    });
    expect(terminals.find((terminal) => terminal.id === exited.terminalId)).toEqual({
      id: exited.terminalId,
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
    const unplacedOf = async (): Promise<boolean[]> =>
      (await indexRows(fixture)).map((terminal) => terminal.unplaced);

    expect(await unplacedOf()).toEqual([true]);

    writeElement(
      room(fixture, fixture.canvas.id).doc,
      portalElement("portal-1", born.homeId),
      LOCAL_ORIGIN,
    );
    expect(await unplacedOf()).toEqual([false]);

    // Releasing it is subtractive: the reference goes and the terminal stays where it lives,
    // so the index reports it at top level again with nothing durable having changed.
    expect(unplaceTerminal(fixture.placement, born.terminalId)).toEqual({ removed: 1 });
    expect(await unplacedOf()).toEqual([true]);
    expect(homeOf(fixture, born.terminalId)).toBe(born.homeId);
  });

  test("a terminal merged into a referenced composition is placed through that composition", async () => {
    const fixture = indexFixture();
    const born = openTerminal(fixture);
    const composition = compositionContainer(fixture, "composition");
    writeElement(
      room(fixture, fixture.canvas.id).doc,
      portalElement("portal-1", composition.id),
      LOCAL_ORIGIN,
    );

    const added = placeTile(
      fixture.placement,
      composition.id,
      { kind: "terminal", terminalId: born.terminalId },
      null,
      null,
    );
    if (typeof added === "string") throw new Error(`placement failed: ${added}`);

    // `homeId` follows the terminal into the composition it joined, and `unplaced` is about
    // that composition being referenced — not about the terminal itself being pointed at.
    expect(await indexRows(fixture)).toEqual([
      expect.objectContaining({
        id: born.terminalId,
        homeId: composition.id,
        unplaced: false,
      }),
    ]);
    expect(fixture.store.getContainer(born.homeId)).toBeNull();
  });

  test("a container-scoped token cannot read the terminal index", async () => {
    const fixture = indexFixture();

    const response = await call(
      fixture,
      "POST",
      "/api/actions/core.terminals.listAll",
      containerScopedToken(fixture),
      {},
    );

    // The route answered 403; the door answers 200 with the rung that refused, which is the
    // same fact in the vocabulary every other caller already reads. Workspace-grade by
    // declaration: the INDEX is the workspace's, and a token scoped to one container has no
    // business enumerating it.
    expect(response.payload).toEqual({
      ok: false,
      denial: { rule: "forbidden", message: "scoped tokens cannot invoke workspace actions" },
    });
  });
});

describe("core.terminals.rename", () => {
  test("a rename is published into the terminal's home, not the canvas showing it", async () => {
    const fixture = indexFixture();
    const born = openTerminal(fixture);
    writeElement(
      room(fixture, fixture.canvas.id).doc,
      portalElement("portal-1", born.homeId),
      LOCAL_ORIGIN,
    );
    const onCanvas = joinPeer(fixture, fixture.canvas.id);
    const inHome = joinPeer(fixture, born.homeId);

    const renamed = await call(fixture, "POST", "/api/actions/core.terminals.rename", OWNER_KEY, {
      terminalId: born.terminalId,
      name: "  build  ",
    });

    expect(renamed.status).toBe(200);
    expect(renamed.payload).toEqual({ ok: true, result: {} });
    expect(fixture.store.getTerminal(born.terminalId)?.name).toBe("build");
    // A name is terminal state, so it is published where every viewer of the terminal is
    // already joined: its home. A canvas learns about it through the portal it renders.
    expect(bodiesOfType(inHome.socket, "terminal_event")).toEqual([
      { type: "terminal_event", terminalId: born.terminalId, kind: "renamed", name: "build" },
    ]);
    expect(bodiesOfType(onCanvas.socket, "terminal_event")).toEqual([]);
  });

  test("a blank name and an unknown terminal are refusals, not transport failures", async () => {
    const fixture = indexFixture();
    const born = openTerminal(fixture);

    const blank = await call(fixture, "POST", "/api/actions/core.terminals.rename", OWNER_KEY, {
      terminalId: born.terminalId,
      name: "   ",
    });
    const missing = await call(fixture, "POST", "/api/actions/core.terminals.rename", OWNER_KEY, {
      terminalId: "missing",
      name: "build",
    });

    // The door always answers 200: a denial is DATA about authority or state, and the rule
    // that refused travels with it instead of being flattened into a status code.
    expect([blank.status, missing.status]).toEqual([200, 200]);
    expect(blank.payload).toEqual({
      ok: false,
      denial: { rule: "refused", message: "name is empty" },
    });
    expect(missing.payload).toEqual({
      ok: false,
      denial: { rule: "refused", message: "terminal not found" },
    });
    expect(fixture.broker.rename("missing-terminal", "build")).toBe("not_found");
  });

  test("a rename survives into the advert a merge publishes", () => {
    const fixture = indexFixture();
    const born = openTerminal(fixture);
    expect(fixture.broker.rename(born.terminalId, "build")).toBe("ok");
    const composition = compositionContainer(fixture, "composition");
    const inside = joinPeer(fixture, composition.id);

    const added = placeTile(
      fixture.placement,
      composition.id,
      { kind: "terminal", terminalId: born.terminalId },
      null,
      null,
    );
    if (typeof added === "string") throw new Error(`placement failed: ${added}`);

    expect(bodiesOfType(inside.socket, "terminal_opened").at(-1)).toMatchObject({
      elementId: added.tileId,
      terminal: { id: born.terminalId, name: "build", containerId: composition.id },
    });
  });

  test("a container-scoped token can rename only inside its own container", async () => {
    const fixture = indexFixture();
    const born = openTerminal(fixture);
    const token = containerScopedToken(fixture);

    // Renaming is container-graded (`scope: "container"`), because a terminal belongs to a
    // container and the per-terminal agent token is scoped to one. What the scope rung cannot
    // check is WHICH container the named terminal lives in — this terminal is homed in its own
    // solo composition, not in the container this token is scoped to — so the handler refuses
    // it.
    const renamed = await call(fixture, "POST", "/api/actions/core.terminals.rename", token, {
      terminalId: born.terminalId,
      name: "build",
    });
    // Reordering a terminal IS moving its home in the one index, so the gate that refuses it
    // is the index's own door rather than a terminal-pool gate that no longer exists.
    const moved = await call(fixture, "POST", "/api/actions/core.index.moveEntry", token, {
      item: { kind: "container", id: born.homeId },
      parentId: null,
      index: 0,
    });

    expect(renamed.payload).toEqual({
      ok: false,
      denial: { rule: "refused", message: OUTSIDE_SCOPE_REFUSAL },
    });
    // Organizing the index stays workspace-grade: it moves things BETWEEN containers.
    expect(moved.payload).toEqual({
      ok: false,
      denial: { rule: "forbidden", message: "scoped tokens cannot invoke workspace actions" },
    });
    expect(fixture.store.getTerminal(born.terminalId)?.name).toBeNull();
  });
});

describe("core.terminals.kill", () => {
  test("killing a terminal drops its row and its home from the index at once", async () => {
    const fixture = indexFixture();
    const born = openTerminal(fixture);
    // Nothing on any canvas points at this terminal, and it is still reachable: the index
    // addresses a terminal by identity, never through a placement of it.
    expect(room(fixture, fixture.canvas.id).portalIdsTo(born.homeId)).toEqual([]);
    fixture.machine.clear();

    const killed = await call(fixture, "POST", "/api/actions/core.terminals.kill", OWNER_KEY, {
      terminalId: born.terminalId,
    });
    // The machine answers a kill by reporting the exit; the row it would have updated is
    // already gone, so this cannot resurrect it as an exited entry.
    fixture.broker.onExited(fixture.machine.machineId, born.terminalId, 0);
    const listed = await indexRows(fixture);
    const again = await call(fixture, "POST", "/api/actions/core.terminals.kill", OWNER_KEY, {
      terminalId: born.terminalId,
    });
    const missing = await call(fixture, "POST", "/api/actions/core.terminals.kill", OWNER_KEY, {
      terminalId: "missing",
    });

    expect(killed.payload).toEqual({ ok: true, result: {} });
    expect(fixture.machine.sent).toEqual([{ type: "kill", terminalId: born.terminalId }]);
    // A kill removes the terminal from the world, so the index has no row to show and the
    // home it lived in is gone with it. There is no tombstone state between the two.
    expect(listed).toEqual([]);
    expect(fixture.store.getTerminal(born.terminalId)).toBeNull();
    expect(fixture.store.getContainer(born.homeId)).toBeNull();
    // Gone is gone: a second kill and an id that never existed refuse identically.
    expect(again.payload).toEqual({
      ok: false,
      denial: { rule: "refused", message: "terminal not found" },
    });
    expect(missing.payload).toEqual(again.payload);
  });

  test("a container-scoped token cannot kill a terminal in another container", async () => {
    const fixture = indexFixture();
    const born = openTerminal(fixture);

    const response = await call(
      fixture,
      "POST",
      "/api/actions/core.terminals.kill",
      containerScopedToken(fixture),
      { terminalId: born.terminalId },
    );

    // Killing is container-graded — an agent must be able to clean up its own terminal — so
    // the refusal comes from the containment the handler owes rather than from the scope rung.
    expect(response.payload).toEqual({
      ok: false,
      denial: { rule: "refused", message: OUTSIDE_SCOPE_REFUSAL },
    });
    expect(fixture.store.getTerminal(born.terminalId)?.status).toBe("running");
  });
});

describe("core.index.moveEntry is how an unplaced terminal is reordered", () => {
  test("a solo composition moves into a folder and reads back under it", async () => {
    const fixture = indexFixture();
    const born = openTerminal(fixture);
    const created = await call(fixture, "POST", "/api/actions/core.index.createFolder", OWNER_KEY, {
      name: "machines",
    });
    expect(created.status).toBe(200);
    const folder = actionItems(created.payload).find((item) => item.kind === "folder");
    if (folder?.kind !== "folder") throw new Error("missing folder");

    const moved = await call(fixture, "POST", "/api/actions/core.index.moveEntry", OWNER_KEY, {
      item: { kind: "container", id: born.homeId },
      parentId: folder.id,
      index: 0,
    });
    const listed = await call(fixture, "POST", "/api/actions/core.index.read", OWNER_KEY, {});

    expect(moved.status).toBe(200);
    // The terminal was never reordered: its HOME was. That is the whole of what replaced the
    // pool's durable sort order, and it is why organizing terminals needs no terminal route.
    for (const payload of [moved.payload, listed.payload]) {
      const home = actionItems(payload).find(
        (item) => item.kind === "container" && item.container.id === born.homeId,
      );
      expect(home).toEqual({
        kind: "container",
        container: {
          id: born.homeId,
          name: MACHINE_NAME,
          createdAt: 0,
          discipline: "composition",
        },
        parentId: folder.id,
        sortOrder: 0,
      });
    }
    // Moving a container never touches where the terminal lives.
    expect(homeOf(fixture, born.terminalId)).toBe(born.homeId);
  });
});

describe("core.terminals.listByContainer", () => {
  test("the per-container listing reports each terminal under its home", async () => {
    const fixture = indexFixture();
    const solo = openTerminal(fixture);
    const merged = openTerminal(fixture);
    const composition = compositionContainer(fixture, "composition");
    const added = placeTile(
      fixture.placement,
      composition.id,
      { kind: "terminal", terminalId: merged.terminalId },
      null,
      null,
    );
    if (typeof added === "string") throw new Error(`placement failed: ${added}`);

    const terminals = await terminalRowsByContainer(fixture);
    // Every terminal has a container, so nothing is omitted here any more: the listing is a
    // join of terminals onto the containers they live in.
    expect([...terminals.map((terminal) => terminal.id)].sort()).toEqual(
      [solo.terminalId, merged.terminalId].sort(),
    );
    expect(terminals.find((terminal) => terminal.id === solo.terminalId)?.containerId).toBe(
      solo.homeId,
    );
    expect(terminals.find((terminal) => terminal.id === merged.terminalId)?.containerId).toBe(
      composition.id,
    );
  });
});
