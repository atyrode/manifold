import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActionOutcomeSchema,
  ContainerCensusResponseSchema,
  PROTOCOL_VERSION,
  ContainerResponseSchema,
  ROOT_TILE_ID,
  ServerToAgentMessageSchema,
  TerminalsResponseSchema,
  censusSolo,
  elementString,
  type Container,
  type SceneElement,
  type ServerMessageBody,
  type ServerToAgentMessage,
  type TerminalSummary,
} from "@manifold/protocol";
import {
  DEFAULT_TERMINAL_HEIGHT,
  DEFAULT_TERMINAL_WIDTH,
  LOCAL_ORIGIN,
  readElement,
  readElements,
  tileIdForRef,
  tileLeafIds,
  writeElement,
} from "@manifold/scene";
import { AuthService, type AuthContext } from "../src/auth.ts";
import { loadConfig } from "../src/config.ts";
import { HttpApp } from "../src/http.ts";
import { silentLogger } from "../src/log.ts";
import { MachineGateway } from "../src/machine-ws.ts";
import { PlaceExecutor, assemblyPlacementVocabulary, assemblyItemNouns } from "../src/placement.ts";
import { RoomManager, type Room } from "../src/room.ts";
import { SessionChannel } from "../src/session-channel.ts";
import type { ServerStore } from "../src/stores.ts";
import { TerminalBroker, type MachineChannel } from "../src/terminal-broker.ts";
import {
  composeOnCanvas,
  extractTile,
  FakeClock,
  FakeRuntime,
  FakeSocket,
  placeTile,
  testPluginHost,
  testStore,
  testTileTrees,
  unplaceElement,
  unplaceTerminal,
} from "./helpers.ts";

/**
 * THE lifecycle matrix. Every terminal lives in a composition, and these are the eight
 * rules that decide when a composition is born, when it is retired, and what happens to the
 * references pointing at it. One describe per rule, so a rule that stops holding names
 * itself in the failure output rather than being deduced from a broken expectation.
 *
 *   L1 BIRTH      a terminal and its home are created together; a canvas opener authors its
 *                 own portal and the server authors nothing on the canvas.
 *   L2 EXIT       a terminal that exited ON ITS OWN keeps its leaf, its home and every portal
 *                 onto that home, so the real exit code stays visible.
 *   L3 REAP       removing a terminal's last home leaf kills the PTY and forgets the row —
 *                 the leaf addressed as a tile, or the terminal addressed by identity, which
 *                 is what a DELIBERATE kill is. Killing is the only thing that destroys.
 *   L4 EMPTIED    a composition that just LOST its last item is deleted; one that never held
 *                 anything is not.
 *   L5 MERGE      a terminal joining another composition moves, and every reference to its
 *                 old home is repointed in place.
 *   L6 EXTRACT    a leaf leaving a multi-tile composition re-homes; leaving a solo one does
 *                 not, because that composition already IS the item.
 *   L7 UNPLACE    references go, the item stays. Zero removed is a legal answer.
 *   L8 DELETE     deleting a composition reaps what lives in it and removes what points at it.
 */

const OWNER_KEY = "c".repeat(64);
const MACHINE_NAME = "lifecycle machine";
const temporaryDirectories: string[] = [];

class FakeMachine implements MachineChannel {
  readonly sent: ServerToAgentMessage[] = [];
  readonly protocolVersion = PROTOCOL_VERSION;

  constructor(readonly machineId: string) {}

  send(message: ServerToAgentMessage): boolean {
    this.sent.push(ServerToAgentMessageSchema.parse(message));
    return true;
  }

  clear(): void {
    this.sent.length = 0;
  }
}

/**
 * The portal shape these tests author, named so a repoint assertion can spread one and
 * override its target. An element is a neutral ENVELOPE now (ADR 0013 §16), so this is a
 * local fixture type rather than a variant extracted from the union: `containerId` is a
 * payload field the canvas's own kind declares, and the floor's type no longer knows it.
 */
interface PortalElement extends SceneElement {
  readonly type: "portal";
  readonly containerId: string;
}

/**
 * How a canvas shows a terminal: a portal onto the composition the terminal lives in. There
 * is no `terminal` element kind any more, so this is the only shape a canvas ever holds for
 * one — and the opener authors it client-side, which is why these tests write it directly.
 */
function portalElement(
  id: string,
  containerId: string,
  x: number,
  y: number,
  zIndex = 0,
): PortalElement {
  return {
    id,
    type: "portal",
    containerId,
    x,
    y,
    width: DEFAULT_TERMINAL_WIDTH,
    height: DEFAULT_TERMINAL_HEIGHT,
    zIndex,
  };
}

/** Broker, room manager, placement executor and HTTP app over one store. */
interface LifecycleFixture {
  runtime: FakeRuntime;
  store: ServerStore;
  root: AuthContext;
  /** The canvas every opener in these tests spawns from; pinned resident by `opener`. */
  canvas: Container;
  rooms: RoomManager;
  broker: TerminalBroker;
  placement: PlaceExecutor;
  machine: FakeMachine;
  socket: FakeSocket;
  opener: SessionChannel;
  app: HttpApp;
}

function lifecycleFixture(): LifecycleFixture {
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
  const canvas: Container = {
    id: runtime.newId(),
    name: "canvas container",
    createdAt: runtime.now(),
    discipline: "canvas",
  };
  store.createContainer(canvas);
  const rooms = new RoomManager(store, runtime, clock, silentLogger, testTileTrees);
  const broker = new TerminalBroker(
    store,
    auth,
    rooms,
    runtime,
    clock,
    silentLogger,
    () => "http://localhost:7777",
    testTileTrees,
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
    assemblyPlacementVocabulary(() => plugins.roster()),
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
  const socket = new FakeSocket();
  const opener = new SessionChannel(runtime.newId(), socket, root, canvas.id, "c1");
  const app = new HttpApp(config, store, auth, rooms, broker, machines, plugins, silentLogger);
  const fixture: LifecycleFixture = {
    runtime,
    store,
    root,
    canvas,
    rooms,
    broker,
    placement,
    machine,
    socket,
    opener,
    app,
  };
  // The opener stays joined, so the canvas room is never evicted mid-test and a `Room`
  // handle taken once stays the live document these tests keep writing to.
  room(fixture, canvas.id).join(opener);
  return fixture;
}

function room(fixture: LifecycleFixture, containerId: string): Room {
  const found = fixture.rooms.get(containerId);
  if (found === null) throw new Error(`missing room ${containerId}`);
  return found;
}

function canvasDoc(fixture: LifecycleFixture): Room["doc"] {
  return room(fixture, fixture.canvas.id).doc;
}

function leafIds(fixture: LifecycleFixture, containerId: string): string[] {
  return tileLeafIds(room(fixture, containerId).tileLayout() ?? {});
}

/**
 * The leaf a composition currently holds a terminal under. Splitting the root MOVES the
 * root's own content into a fresh leaf, so any leaf id a caller remembered from before
 * another placement is stale — which is exactly why the executor resolves one from identity.
 */
function leafForTerminal(
  fixture: LifecycleFixture,
  containerId: string,
  terminalId: string,
): string {
  const tileId = tileIdForRef(room(fixture, containerId).tileLayout(), {
    kind: "terminal",
    terminalId,
  });
  if (tileId === null) throw new Error(`${containerId} holds no leaf for ${terminalId}`);
  return tileId;
}

/** The only ref a composition of one holds; null when its single leaf is vacant. */
function soleRef(fixture: LifecycleFixture, containerId: string): unknown {
  const layout = room(fixture, containerId).tileLayout();
  if (layout === null) throw new Error(`missing layout for ${containerId}`);
  const leaves = tileLeafIds(layout);
  if (leaves.length !== 1) {
    throw new Error(`expected one leaf in ${containerId}, saw ${leaves.length}`);
  }
  const leafId = leaves[0];
  return leafId === undefined ? null : (layout[leafId]?.ref ?? null);
}

function soleLeafId(fixture: LifecycleFixture, containerId: string): string {
  const leaves = leafIds(fixture, containerId);
  const leafId = leaves[0];
  if (leafId === undefined || leaves.length !== 1) {
    throw new Error(`expected one leaf in ${containerId}, saw ${leaves.length}`);
  }
  return leafId;
}

function compositionContainer(fixture: LifecycleFixture, name: string): Container {
  const container: Container = {
    id: fixture.runtime.newId(),
    name,
    createdAt: fixture.runtime.now(),
    discipline: "composition",
  };
  fixture.store.createContainer(container);
  return container;
}

function canvasContainer(fixture: LifecycleFixture, name: string): Container {
  const container: Container = {
    id: fixture.runtime.newId(),
    name,
    createdAt: fixture.runtime.now(),
    discipline: "canvas",
  };
  fixture.store.createContainer(container);
  return container;
}

type CreateFrame = Extract<ServerToAgentMessage, { type: "create" }>;
type OpenedFrame = Extract<ServerMessageBody, { type: "terminal_opened" }>;

function lastCreate(machine: FakeMachine): CreateFrame {
  const create = machine.sent.filter((message) => message.type === "create").at(-1);
  if (create === undefined || create.type !== "create") throw new Error("missing create request");
  return create;
}

function openedFrames(socket: FakeSocket): OpenedFrame[] {
  const frames: OpenedFrame[] = [];
  for (const message of socket.messages()) {
    if (message.type === "terminal_opened") frames.push(message);
  }
  return frames;
}

function bodiesOfType(socket: FakeSocket, type: ServerMessageBody["type"]): ServerMessageBody[] {
  return socket.messages().filter((message) => message.type === type);
}

/** A channel joined to one container, so its own socket witnesses that room's fan-out. */
interface Witness {
  readonly peer: SessionChannel;
  readonly socket: FakeSocket;
}

function joinPeer(fixture: LifecycleFixture, containerId: string): Witness {
  const socket = new FakeSocket();
  const peer = new SessionChannel(fixture.runtime.newId(), socket, fixture.root, containerId, "c1");
  room(fixture, containerId).join(peer);
  return { peer, socket };
}

/** A terminal, its home composition, and the leaf that makes the home hold it. */
interface Born {
  readonly terminalId: string;
  readonly homeId: string;
  readonly leafId: string;
}

/** Where a terminal says it lives; the one durable answer to "which composition". */
function homeOf(fixture: LifecycleFixture, terminalId: string): string {
  const homeId = fixture.store.getTerminal(terminalId)?.containerId;
  if (homeId === undefined) throw new Error(`terminal ${terminalId} has no row`);
  return homeId;
}

/** L1 from a canvas: the server births a solo composition and authors nothing on the canvas. */
function bornOnCanvas(fixture: LifecycleFixture, ref: string): Born {
  fixture.broker.open(fixture.opener, {
    type: "terminal_open",
    elementId: ref,
    cols: 80,
    rows: 24,
  });
  const create = lastCreate(fixture.machine);
  fixture.broker.onCreated(fixture.machine.machineId, create.terminalId);
  const homeId = homeOf(fixture, create.terminalId);
  return { terminalId: create.terminalId, homeId, leafId: soleLeafId(fixture, homeId) };
}

/** L1 from a composition: the opener IS the home, so the server writes it a leaf. */
function bornInComposition(fixture: LifecycleFixture, inside: Witness, ref: string): Born {
  fixture.broker.open(inside.peer, {
    type: "terminal_open",
    elementId: ref,
    cols: 80,
    rows: 24,
    placement: "tile",
  });
  const create = lastCreate(fixture.machine);
  fixture.broker.onCreated(fixture.machine.machineId, create.terminalId);
  const opened = openedFrames(inside.socket).at(-1);
  if (opened === undefined) throw new Error("missing terminal_opened reply");
  return {
    terminalId: create.terminalId,
    homeId: homeOf(fixture, create.terminalId),
    leafId: opened.elementId,
  };
}

async function call(
  fixture: LifecycleFixture,
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

/** The container an action answered with: the outcome envelope, then the row inside it. */
function actionContainer(payload: unknown): Container {
  const outcome = ActionOutcomeSchema.parse(payload);
  if (!outcome.ok) throw new Error(`action refused: ${outcome.denial.message}`);
  return ContainerResponseSchema.parse(outcome.result).container;
}

/**
 * Leaf removal, through the door that owns it (`core.space.removeTile`). It was a bespoke
 * `DELETE /api/containers/:id/tiles/:tileId` until issue #114 — the one mutation that committed
 * workspace state without passing the dispatch ladder — and these cases are that route's cases
 * rung for rung. The two state failures now read as `refused` denials rather than HTTP 404/409,
 * which is the move `core.space.place` already made: a refusal is data, so every outcome is 200.
 */
async function removeTile(
  fixture: LifecycleFixture,
  containerId: string,
  tileId: string,
  token = OWNER_KEY,
): Promise<{ status: number; payload: unknown }> {
  return await call(fixture, "POST", "/api/actions/core.space.removeTile", token, {
    containerId,
    tileId,
  });
}

/** The terminal index, through the door that owns it (`core.terminals.listAll`). */
async function indexRows(fixture: LifecycleFixture): Promise<readonly TerminalSummary[]> {
  const response = await call(
    fixture,
    "POST",
    "/api/actions/core.terminals.listAll",
    OWNER_KEY,
    {},
  );
  expect(response.status).toBe(200);
  const outcome = ActionOutcomeSchema.parse(response.payload);
  if (!outcome.ok) throw new Error(`index refused: ${outcome.denial.message}`);
  return TerminalsResponseSchema.parse(outcome.result).terminals;
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("L1 birth: a terminal and its home are created together", () => {
  test("a canvas opener births a solo composition and the server authors no element", () => {
    const fixture = lifecycleFixture();

    const born = bornOnCanvas(fixture, "ref-1");

    // The home is a container of its own, never the canvas the gesture happened on.
    expect(born.homeId).not.toBe(fixture.canvas.id);
    expect(fixture.store.getContainer(born.homeId)).toEqual({
      id: born.homeId,
      name: MACHINE_NAME,
      createdAt: 0,
      discipline: "composition",
    });
    expect(leafIds(fixture, born.homeId)).toEqual([ROOT_TILE_ID]);
    expect(soleRef(fixture, born.homeId)).toEqual({
      kind: "terminal",
      terminalId: born.terminalId,
    });
    // The opener authors its own portal, client-side, under the ref it sent. A server-side
    // element here would silently double up with the client's: this zero is the contract.
    expect(readElements(canvasDoc(fixture)).size).toBe(0);
    // A program inside the terminal asking where it is must be told the container it LIVES
    // in. The canvas is never that, and the agent token is scoped to the same id.
    const create = lastCreate(fixture.machine);
    expect(create.env.MANIFOLD_CONTAINER).toBe(born.homeId);
    expect(create.env.MANIFOLD_CONTAINER).not.toBe(fixture.canvas.id);
    expect(create.env.MANIFOLD_ELEMENT).toBe("ref-1");
  });

  test("the canvas opener's reply names the element it authored, not the home's leaf", () => {
    const fixture = lifecycleFixture();

    const born = bornOnCanvas(fixture, "ref-1");

    // The pair that IS the canvas-birth contract: which element id is the opener's own, and
    // which container to portal it onto. Conflating the two hangs every canvas spawn.
    const opened = openedFrames(fixture.socket).at(-1);
    expect(opened?.elementId).toBe("ref-1");
    expect(opened?.ref).toBeUndefined();
    expect(opened?.terminal.containerId).toBe(born.homeId);

    // The mirror image, and the reason the field is polymorphic at all: a composition opener
    // authors nothing, so it is told the leaf the server wrote and its ref is echoed back.
    const composition = compositionContainer(fixture, "composition");
    const inside = joinPeer(fixture, composition.id);
    const inComposition = bornInComposition(fixture, inside, "ref-2");
    const compositionOpened = openedFrames(inside.socket).at(-1);
    expect(compositionOpened?.elementId).toBe(inComposition.leafId);
    expect(compositionOpened?.ref).toBe("ref-2");
    expect(compositionOpened?.terminal.containerId).toBe(composition.id);
  });

  test("a terminal's lifecycle is published in its home, never in the canvas that opened it", () => {
    const fixture = lifecycleFixture();
    const onCanvas = joinPeer(fixture, fixture.canvas.id);

    const born = bornOnCanvas(fixture, "ref-1");
    const inHome = joinPeer(fixture, born.homeId);
    fixture.broker.onExited(fixture.machine.machineId, born.terminalId, 0);

    // Nothing about a terminal is canvas state after the cutover: a canvas learns about the
    // terminal the same way it learns about anything else, through its own document.
    expect(bodiesOfType(onCanvas.socket, "terminal_opened")).toEqual([]);
    expect(bodiesOfType(onCanvas.socket, "terminal_event")).toEqual([]);
    expect(bodiesOfType(inHome.socket, "terminal_event")).toEqual([
      { type: "terminal_event", terminalId: born.terminalId, kind: "exited", exitCode: 0 },
    ]);
  });

  test("a composition opener IS the home: one leaf is written and no second composition is born", () => {
    const fixture = lifecycleFixture();
    const composition = compositionContainer(fixture, "composition");
    const inside = joinPeer(fixture, composition.id);
    const containersBefore = fixture.store.listContainers().map((container) => container.id);

    const born = bornInComposition(fixture, inside, "ref-1");

    expect(fixture.store.listContainers().map((container) => container.id)).toEqual(
      containersBefore,
    );
    expect(born.homeId).toBe(composition.id);
    expect(soleRef(fixture, composition.id)).toEqual({
      kind: "terminal",
      terminalId: born.terminalId,
    });
    const create = lastCreate(fixture.machine);
    expect(create.env.MANIFOLD_CONTAINER).toBe(composition.id);
    // A composition opener authors no element, so there is no element id to hand the PTY.
    expect(create.env.MANIFOLD_ELEMENT).toBeUndefined();
  });
});

describe("L2 exit: an exited terminal keeps its leaf and its home", () => {
  test("a natural exit deletes nothing, so the real code stays visible where the terminal lives", () => {
    const fixture = lifecycleFixture();
    const born = bornOnCanvas(fixture, "ref-1");
    // Two canvases point at the home, because "an exit deletes nothing" has to hold for
    // EVERY reference and not merely for the one the opener happened to author.
    const other = canvasContainer(fixture, "second canvas");
    writeElement(canvasDoc(fixture), portalElement("portal-a", born.homeId, 40, 40), LOCAL_ORIGIN);
    writeElement(
      room(fixture, other.id).doc,
      portalElement("portal-b", born.homeId, 10, 10),
      LOCAL_ORIGIN,
    );

    // The PTY stopped on its own. Nobody asked for it, so this is information, not a request.
    fixture.broker.onExited(fixture.machine.machineId, born.terminalId, 3);

    expect(fixture.store.getContainer(born.homeId)).not.toBeNull();
    expect(soleRef(fixture, born.homeId)).toEqual({
      kind: "terminal",
      terminalId: born.terminalId,
    });
    const stored = fixture.store.getTerminal(born.terminalId);
    expect(stored?.status).toBe("exited");
    // The REAL code. A natural exit never invents one and never loses one.
    expect(stored?.exitCode).toBe(3);
    expect(stored?.containerId).toBe(born.homeId);
    expect(room(fixture, fixture.canvas.id).portalIdsTo(born.homeId)).toEqual(["portal-a"]);
    expect(room(fixture, other.id).portalIdsTo(born.homeId)).toEqual(["portal-b"]);
  });

  test("an agent-disconnected exit keeps a null code internally and still deletes nothing", () => {
    const fixture = lifecycleFixture();
    const born = bornOnCanvas(fixture, "ref-1");

    // No code was observed, so none is reported. Null is the honest answer and it is not a
    // third lifecycle state: the terminal exited, and what it exited with is unknown.
    fixture.broker.onExited(fixture.machine.machineId, born.terminalId, null);

    expect(fixture.store.getTerminal(born.terminalId)).toMatchObject({
      status: "exited",
      exitCode: null,
      containerId: born.homeId,
    });
    expect(fixture.store.getContainer(born.homeId)).not.toBeNull();
  });

  test("the prune that collects unhomed exits never fires on a natural exit", () => {
    const fixture = lifecycleFixture();
    const born = bornOnCanvas(fixture, "ref-1");
    writeElement(canvasDoc(fixture), portalElement("portal-a", born.homeId, 40, 40), LOCAL_ORIGIN);

    fixture.broker.onExited(fixture.machine.machineId, born.terminalId, 7);
    // The reaper's whole predicate is "exited AND its home holds no leaf for it". A natural
    // exit touches no leaf, so running the prune on both the home and the canvas that
    // references it must be a no-op — otherwise dying would quietly mean being deleted.
    fixture.broker.pruneExitedUnhomedForContainer(born.homeId);
    fixture.broker.pruneExitedUnhomedForContainer(fixture.canvas.id);

    expect(fixture.store.getTerminal(born.terminalId)?.exitCode).toBe(7);
    expect(fixture.store.getContainer(born.homeId)).not.toBeNull();
    expect(room(fixture, fixture.canvas.id).portalIdsTo(born.homeId)).toEqual(["portal-a"]);
  });
});

describe("L3 reap: a terminal's last home leaf IS the terminal", () => {
  test("removing a running terminal's only leaf kills the PTY and forgets the terminal", async () => {
    const fixture = lifecycleFixture();
    const born = bornOnCanvas(fixture, "ref-1");
    fixture.machine.clear();

    const removed = await removeTile(fixture, born.homeId, born.leafId);

    expect(removed.status).toBe(200);
    expect(removed.payload).toEqual({ ok: true, result: {} });
    // There is no pool to fall back into: the operator who closed the last leaf closed the
    // terminal, and nothing about that is recoverable state.
    expect(fixture.machine.sent).toEqual([{ type: "kill", terminalId: born.terminalId }]);
    expect(fixture.store.getTerminal(born.terminalId)).toBeNull();
    expect(fixture.broker.introspect()).toEqual([]);
  });

  test("removing one of two leaves for the same terminal keeps it alive", async () => {
    const fixture = lifecycleFixture();
    const born = bornOnCanvas(fixture, "ref-1");
    const second = room(fixture, born.homeId).placeTerminalTile(born.terminalId, null, null);
    if (second === null) throw new Error("second leaf refused");
    fixture.machine.clear();

    const removed = await removeTile(fixture, born.homeId, second);

    expect(removed.status).toBe(200);
    expect(fixture.machine.sent).toEqual([]);
    expect(fixture.store.getTerminal(born.terminalId)?.containerId).toBe(born.homeId);
  });

  test("killing a terminal by identity removes its home and every portal onto it at once", async () => {
    const fixture = lifecycleFixture();
    const born = bornOnCanvas(fixture, "ref-1");
    // Three mirrors across two canvases, one of which is not resident when the kill lands:
    // "kill means poof" is a claim about the whole workspace, not about the open tab.
    const other = canvasContainer(fixture, "second canvas");
    writeElement(canvasDoc(fixture), portalElement("portal-a", born.homeId, 10, 10), LOCAL_ORIGIN);
    writeElement(canvasDoc(fixture), portalElement("portal-b", born.homeId, 20, 20), LOCAL_ORIGIN);
    writeElement(
      room(fixture, other.id).doc,
      portalElement("portal-c", born.homeId, 30, 30),
      LOCAL_ORIGIN,
    );
    fixture.rooms.evictIfIdle(other.id);
    fixture.machine.clear();

    const killed = await call(fixture, "POST", "/api/actions/core.terminals.kill", OWNER_KEY, {
      terminalId: born.terminalId,
    });

    expect(killed.status).toBe(200);
    expect(killed.payload).toEqual({ ok: true, result: {} });
    expect(fixture.machine.sent).toEqual([{ type: "kill", terminalId: born.terminalId }]);
    // The terminal, its home, and every reference to that home. No exited row survives the
    // request, so there is nothing left for anybody to dismiss.
    expect(fixture.store.getTerminal(born.terminalId)).toBeNull();
    expect(fixture.store.getContainer(born.homeId)).toBeNull();
    expect(fixture.broker.introspect()).toEqual([]);
    expect(room(fixture, fixture.canvas.id).portalIdsTo(born.homeId)).toEqual([]);
    expect(room(fixture, other.id).portalIdsTo(born.homeId)).toEqual([]);
    expect(await indexRows(fixture)).toEqual([]);
  });

  test("an exit frame arriving after a kill finds nothing, so no exited row comes back", async () => {
    const fixture = lifecycleFixture();
    const born = bornOnCanvas(fixture, "ref-1");

    await call(fixture, "POST", "/api/actions/core.terminals.kill", OWNER_KEY, {
      terminalId: born.terminalId,
    });
    // The machine answers the kill the only way it can: by reporting the exit. That frame is
    // how the two halves of the lifecycle predicate could quietly become one, and the whole
    // reason the predicate is structural — a killed terminal is gone before it can arrive.
    fixture.broker.onExited(fixture.machine.machineId, born.terminalId, 0);

    expect(fixture.store.getTerminal(born.terminalId)).toBeNull();
    expect(fixture.store.getContainer(born.homeId)).toBeNull();
    expect(fixture.broker.introspect()).toEqual([]);
  });

  test("killing a terminal that already exited on its own sweeps it the same way", async () => {
    const fixture = lifecycleFixture();
    const born = bornOnCanvas(fixture, "ref-1");
    writeElement(canvasDoc(fixture), portalElement("portal-a", born.homeId, 10, 10), LOCAL_ORIGIN);
    fixture.broker.onExited(fixture.machine.machineId, born.terminalId, 5);
    fixture.machine.clear();

    const killed = await call(fixture, "POST", "/api/actions/core.terminals.kill", OWNER_KEY, {
      terminalId: born.terminalId,
    });
    const again = await call(fixture, "POST", "/api/actions/core.terminals.kill", OWNER_KEY, {
      terminalId: born.terminalId,
    });

    // Dismissing a dead terminal and killing a live one are ONE verb, so an exited terminal
    // is no conflict — and there is no PTY left to ask anything of.
    expect(killed.payload).toEqual({ ok: true, result: {} });
    expect(fixture.machine.sent).toEqual([]);
    expect(fixture.store.getTerminal(born.terminalId)).toBeNull();
    expect(fixture.store.getContainer(born.homeId)).toBeNull();
    expect(room(fixture, fixture.canvas.id).portalIdsTo(born.homeId)).toEqual([]);
    // Gone is gone: the second request finds no terminal rather than a tombstone.
    expect(again.payload).toEqual({
      ok: false,
      denial: { rule: "refused", message: "terminal not found" },
    });
  });

  test("killing one occupant of a composition takes its tile and leaves the composition", async () => {
    const fixture = lifecycleFixture();
    const composition = compositionContainer(fixture, "composition");
    const inside = joinPeer(fixture, composition.id);
    const first = bornInComposition(fixture, inside, "ref-1");
    const second = bornInComposition(fixture, inside, "ref-2");
    writeElement(
      canvasDoc(fixture),
      portalElement("portal-composition", composition.id, 40, 40),
      LOCAL_ORIGIN,
    );
    fixture.machine.clear();

    const killed = await call(fixture, "POST", "/api/actions/core.terminals.kill", OWNER_KEY, {
      terminalId: first.terminalId,
    });

    expect(killed.payload).toEqual({ ok: true, result: {} });
    expect(fixture.machine.sent).toEqual([{ type: "kill", terminalId: first.terminalId }]);
    expect(fixture.store.getTerminal(first.terminalId)).toBeNull();
    // The composition is shared with whatever else lives in it, so killing an occupant is
    // never permission to delete the place — nor the portal the workspace shows it through.
    expect(fixture.store.getContainer(composition.id)).not.toBeNull();
    expect(soleRef(fixture, composition.id)).toEqual({
      kind: "terminal",
      terminalId: second.terminalId,
    });
    expect(room(fixture, fixture.canvas.id).portalIdsTo(composition.id)).toEqual([
      "portal-composition",
    ]);
  });

  test("closing a terminal's last tile and killing it by identity are the same write", async () => {
    const byTile = lifecycleFixture();
    const tileBorn = bornOnCanvas(byTile, "ref-1");
    writeElement(
      canvasDoc(byTile),
      portalElement("portal-a", tileBorn.homeId, 10, 10),
      LOCAL_ORIGIN,
    );
    byTile.machine.clear();
    const byIdentity = lifecycleFixture();
    const identityBorn = bornOnCanvas(byIdentity, "ref-1");
    writeElement(
      canvasDoc(byIdentity),
      portalElement("portal-a", identityBorn.homeId, 10, 10),
      LOCAL_ORIGIN,
    );
    byIdentity.machine.clear();

    const closed = await removeTile(byTile, tileBorn.homeId, tileBorn.leafId);
    const identityKilled = await call(
      byIdentity,
      "POST",
      "/api/actions/core.terminals.kill",
      OWNER_KEY,
      { terminalId: identityBorn.terminalId },
    );

    // Two doors, one rule. If these ever diverge, closing a tile and pressing X stop meaning
    // the same thing, which is exactly the friction the one-rule model exists to remove.
    const observed = (
      fixture: LifecycleFixture,
      born: Born,
      response: { status: number; payload: unknown },
    ): unknown => ({
      status: response.status,
      kills: fixture.machine.sent,
      terminal: fixture.store.getTerminal(born.terminalId),
      home: fixture.store.getContainer(born.homeId),
      portals: room(fixture, fixture.canvas.id).portalIdsTo(born.homeId),
      live: fixture.broker.introspect(),
    });
    expect(observed(byTile, tileBorn, closed)).toEqual(
      observed(byIdentity, identityBorn, identityKilled),
    );
    expect(byTile.store.getContainer(tileBorn.homeId)).toBeNull();
    expect(byTile.machine.sent).toEqual([{ type: "kill", terminalId: tileBorn.terminalId }]);
  });
});

describe("L4 emptied: departure retires a composition, emptiness never does", () => {
  test("the home a reaped terminal left behind is deleted with it", async () => {
    const fixture = lifecycleFixture();
    const born = bornOnCanvas(fixture, "ref-1");

    await removeTile(fixture, born.homeId, born.leafId);

    expect(fixture.store.getContainer(born.homeId)).toBeNull();
    expect(fixture.store.listContainers().map((container) => container.id)).toEqual([
      fixture.canvas.id,
    ]);
  });

  test("a composition that never held anything survives having its empty root removed", async () => {
    const fixture = lifecycleFixture();
    const created = await call(
      fixture,
      "POST",
      "/api/actions/core.index.createContainer",
      OWNER_KEY,
      {
        name: "new composition",
        discipline: "composition",
      },
    );
    expect(created.status).toBe(200);
    const emptyId = actionContainer(created.payload).id;
    expect(leafIds(fixture, emptyId)).toEqual([ROOT_TILE_ID]);

    const refused = await removeTile(fixture, emptyId, ROOT_TILE_ID);

    // Nothing ever LEFT this container, so nothing retires it: the root of an empty
    // composition is not removable and the row stays in the index. This asymmetry is what
    // replaced the stored `transient` flag — it is the departure that deletes, not the
    // emptiness, and only the call site right after a removal may apply the rule.
    expect(refused.payload).toEqual({
      ok: false,
      denial: { rule: "refused", message: "conflict: tile is not removable" },
    });
    expect(fixture.store.getContainer(emptyId)).not.toBeNull();

    // The other half of the asymmetry, in the same world: a home emptied BY a departure goes.
    const born = bornOnCanvas(fixture, "ref-1");
    const reaped = await removeTile(fixture, born.homeId, born.leafId);
    expect(reaped.status).toBe(200);
    expect(fixture.store.getContainer(born.homeId)).toBeNull();
    expect(fixture.store.getContainer(emptyId)).not.toBeNull();
  });
});

describe("L5 merge: a terminal joining a composition takes its references with it", () => {
  test("a tile drop moves the terminal, retires its old home, and repoints references in place", () => {
    const fixture = lifecycleFixture();
    const born = bornOnCanvas(fixture, "ref-1");
    // The canvas shows the terminal the way a canvas always does: a portal onto its home,
    // with whatever geometry the operator gave it.
    const portal = portalElement("portal-1", born.homeId, 210, 320, 7);
    writeElement(canvasDoc(fixture), portal, LOCAL_ORIGIN);
    const composition = compositionContainer(fixture, "composition");
    const inside = joinPeer(fixture, composition.id);
    const first = bornInComposition(fixture, inside, "ref-2");
    const secondBorn = bornInComposition(fixture, inside, "ref-3");

    const added = placeTile(
      fixture.placement,
      composition.id,
      { kind: "terminal", terminalId: born.terminalId },
      null,
      null,
    );
    if (typeof added === "string") throw new Error(`placement failed: ${added}`);

    expect(fixture.store.getTerminal(born.terminalId)?.containerId).toBe(composition.id);
    expect(fixture.store.getContainer(born.homeId)).toBeNull();
    // `repointPortal`, and it is the load-bearing detail: the SAME element id with the SAME
    // geometry now points at the composition. Re-authoring under a fresh id would still
    // "show the composition" while losing every collaborator's selection and blinking the
    // portal across the canvas.
    expect(readElement(canvasDoc(fixture), "portal-1")).toEqual({
      ...portal,
      containerId: composition.id,
    });
    expect(readElements(canvasDoc(fixture)).size).toBe(1);
    const layout = room(fixture, composition.id).tileLayout();
    expect(tileLeafIds(layout ?? {})).toHaveLength(3);
    expect(layout?.[added.tileId]?.ref).toEqual({
      kind: "terminal",
      terminalId: born.terminalId,
    });
    expect([first.terminalId, secondBorn.terminalId].map((id) => homeOf(fixture, id))).toEqual([
      composition.id,
      composition.id,
    ]);
  });

  test("composing two canvas references births one composition named after both", () => {
    const fixture = lifecycleFixture();
    const alpha = bornOnCanvas(fixture, "ref-1");
    const beta = bornOnCanvas(fixture, "ref-2");
    fixture.broker.rename(alpha.terminalId, "alpha");
    fixture.broker.rename(beta.terminalId, "beta");
    const target = portalElement("portal-alpha", alpha.homeId, 200, 100, 3);
    const dragged = portalElement("portal-beta", beta.homeId, 900, 100, 4);
    writeElement(canvasDoc(fixture), target, LOCAL_ORIGIN);
    writeElement(canvasDoc(fixture), dragged, LOCAL_ORIGIN);

    const composed = composeOnCanvas(
      fixture.placement,
      fixture.canvas.id,
      "portal-alpha",
      { kind: "element", containerId: fixture.canvas.id, elementId: "portal-beta" },
      "right",
    );
    if (typeof composed === "string") throw new Error(`placement failed: ${composed}`);

    expect(fixture.store.getContainer(composed.containerId)).toEqual({
      id: composed.containerId,
      name: "alpha + beta",
      createdAt: 0,
      discipline: "composition",
    });
    // ONE composition is born and BOTH solo homes retire into it: a merge never nests.
    expect([...fixture.store.listContainers().map((container) => container.id)].sort()).toEqual(
      [fixture.canvas.id, composed.containerId].sort(),
    );
    expect(fixture.store.getContainer(alpha.homeId)).toBeNull();
    expect(fixture.store.getContainer(beta.homeId)).toBeNull();
    // The target keeps its id and geometry and points at the newborn; the reference the drag
    // consumed is gone, because the drop consumed exactly that one.
    expect(readElement(canvasDoc(fixture), "portal-alpha")).toEqual({
      ...target,
      containerId: composed.containerId,
    });
    expect(readElement(canvasDoc(fixture), "portal-beta")).toBeNull();
    expect(readElements(canvasDoc(fixture)).size).toBe(1);
    const layout = room(fixture, composed.containerId).tileLayout();
    expect(tileLeafIds(layout ?? {}).map((id) => layout?.[id]?.ref)).toEqual([
      { kind: "terminal", terminalId: alpha.terminalId },
      { kind: "terminal", terminalId: beta.terminalId },
    ]);
    expect(homeOf(fixture, alpha.terminalId)).toBe(composed.containerId);
    expect(homeOf(fixture, beta.terminalId)).toBe(composed.containerId);
  });

  test("composing onto a reference to a MULTI composition joins it instead of nesting", () => {
    const fixture = lifecycleFixture();
    const composition = compositionContainer(fixture, "composition");
    const inside = joinPeer(fixture, composition.id);
    bornInComposition(fixture, inside, "ref-1");
    bornInComposition(fixture, inside, "ref-2");
    const joining = bornOnCanvas(fixture, "ref-3");
    writeElement(
      canvasDoc(fixture),
      portalElement("portal-composition", composition.id, 40, 40),
      LOCAL_ORIGIN,
    );
    writeElement(
      canvasDoc(fixture),
      portalElement("portal-joining", joining.homeId, 500, 40),
      LOCAL_ORIGIN,
    );

    const composed = composeOnCanvas(
      fixture.placement,
      fixture.canvas.id,
      "portal-composition",
      { kind: "element", containerId: fixture.canvas.id, elementId: "portal-joining" },
      "bottom",
    );
    if (typeof composed === "string") throw new Error(`placement failed: ${composed}`);

    // No container is born: the portal already points at a composition, so this is a plain
    // merge into it and the answer names that same composition.
    expect(composed.containerId).toBe(composition.id);
    expect([...fixture.store.listContainers().map((container) => container.id)].sort()).toEqual(
      [fixture.canvas.id, composition.id].sort(),
    );
    expect(leafIds(fixture, composition.id)).toHaveLength(3);
    expect(homeOf(fixture, joining.terminalId)).toBe(composition.id);
    expect(fixture.store.getContainer(joining.homeId)).toBeNull();
    expect(readElement(canvasDoc(fixture), "portal-joining")).toBeNull();
  });
});

describe("L6 extract: leaving a composition re-homes, unless it was already alone", () => {
  test("extracting from a multi-tile composition re-homes the terminal into a fresh solo one", () => {
    const fixture = lifecycleFixture();
    const composition = compositionContainer(fixture, "composition");
    const inside = joinPeer(fixture, composition.id);
    const stays = bornInComposition(fixture, inside, "ref-1");
    const leaving = bornInComposition(fixture, inside, "ref-2");

    const extracted = extractTile(
      fixture.placement,
      composition.id,
      leaving.leafId,
      fixture.canvas.id,
      320,
      240,
    );
    if (typeof extracted === "string") throw new Error(`placement failed: ${extracted}`);

    // A canvas references a terminal through the composition it lives in; the element kind
    // that carried a terminal id does not exist any more.
    const element = readElement(canvasDoc(fixture), extracted.elementId);
    if (element === null || element.type !== "portal") throw new Error("portal element expected");
    const rehomed = elementString(element, "containerId");
    if (rehomed === null) throw new Error("portal element carries no container reference");
    expect(element).toEqual({
      id: extracted.elementId,
      type: "portal",
      containerId: rehomed,
      x: 320,
      y: 240,
      width: DEFAULT_TERMINAL_WIDTH,
      height: DEFAULT_TERMINAL_HEIGHT,
      zIndex: 0,
    });
    expect(rehomed).not.toBe(composition.id);
    expect(fixture.store.getContainer(rehomed)).toMatchObject({ discipline: "composition" });
    expect(soleRef(fixture, rehomed)).toEqual({
      kind: "terminal",
      terminalId: leaving.terminalId,
    });
    expect(homeOf(fixture, leaving.terminalId)).toBe(rehomed);
    // The composition it left survives, holding what is still in it.
    expect(soleRef(fixture, composition.id)).toEqual({
      kind: "terminal",
      terminalId: stays.terminalId,
    });
  });

  test("extracting the only leaf of a solo composition portals onto that same composition", () => {
    const fixture = lifecycleFixture();
    const born = bornOnCanvas(fixture, "ref-1");
    const containersBefore = [
      ...fixture.store.listContainers().map((container) => container.id),
    ].sort();

    const extracted = extractTile(
      fixture.placement,
      born.homeId,
      born.leafId,
      fixture.canvas.id,
      90,
      110,
    );
    if (typeof extracted === "string") throw new Error(`placement failed: ${extracted}`);

    // That composition already IS the item, so there is nothing to re-home: no new row, no
    // new id, and the terminal does not move.
    expect(readElement(canvasDoc(fixture), extracted.elementId)).toMatchObject({
      type: "portal",
      containerId: born.homeId,
      x: 90,
      y: 110,
    });
    expect([...fixture.store.listContainers().map((container) => container.id)].sort()).toEqual(
      containersBefore,
    );
    expect(homeOf(fixture, born.terminalId)).toBe(born.homeId);
    expect(soleRef(fixture, born.homeId)).toEqual({
      kind: "terminal",
      terminalId: born.terminalId,
    });
  });

  test("a composition emptied by an extraction is deleted", () => {
    const fixture = lifecycleFixture();
    const embedded = canvasContainer(fixture, "embedded canvas");
    const composition = compositionContainer(fixture, "composition");
    const inside = joinPeer(fixture, composition.id);
    const born = bornInComposition(fixture, inside, "ref-1");
    const embeddedTile = placeTile(
      fixture.placement,
      composition.id,
      { kind: "container", containerId: embedded.id },
      null,
      null,
    );
    if (typeof embeddedTile === "string") throw new Error(`placement failed: ${embeddedTile}`);

    const terminal = extractTile(
      fixture.placement,
      composition.id,
      leafForTerminal(fixture, composition.id, born.terminalId),
      fixture.canvas.id,
      10,
      20,
    );
    if (typeof terminal === "string") throw new Error(`placement failed: ${terminal}`);
    expect(fixture.store.getContainer(composition.id)).not.toBeNull();

    // The collapse promoted the survivor into the root id, so the remaining leaf is looked
    // up rather than remembered — a placement never trusts an id the caller cached.
    const surviving = extractTile(
      fixture.placement,
      composition.id,
      soleLeafId(fixture, composition.id),
      fixture.canvas.id,
      30,
      40,
    );
    if (typeof surviving === "string") throw new Error(`placement failed: ${surviving}`);

    expect(fixture.store.getContainer(composition.id)).toBeNull();
    expect(readElement(canvasDoc(fixture), surviving.elementId)).toMatchObject({
      type: "portal",
      containerId: embedded.id,
    });
    // The re-homed terminal's portal points at its NEW home, so retiring the emptied
    // composition leaves it alone.
    expect(readElements(canvasDoc(fixture)).size).toBe(2);
    expect(homeOf(fixture, born.terminalId)).not.toBe(composition.id);
  });
});

describe("L7 unplace: references go, the item stays", () => {
  test("unplacing one element removes that reference only and leaves the terminal homed", () => {
    const fixture = lifecycleFixture();
    const born = bornOnCanvas(fixture, "ref-1");
    writeElement(canvasDoc(fixture), portalElement("portal-a", born.homeId, 10, 10), LOCAL_ORIGIN);
    writeElement(canvasDoc(fixture), portalElement("portal-b", born.homeId, 20, 20), LOCAL_ORIGIN);

    expect(unplaceElement(fixture.placement, fixture.canvas.id, "portal-a")).toEqual({
      removed: 1,
    });

    expect([...readElements(canvasDoc(fixture)).keys()]).toEqual(["portal-b"]);
    expect(homeOf(fixture, born.terminalId)).toBe(born.homeId);
    expect(soleRef(fixture, born.homeId)).toEqual({
      kind: "terminal",
      terminalId: born.terminalId,
    });
  });

  test("unplacing a terminal by identity removes its references from every canvas at once", () => {
    const fixture = lifecycleFixture();
    const born = bornOnCanvas(fixture, "ref-1");
    const elsewhere = canvasContainer(fixture, "second canvas");
    writeElement(canvasDoc(fixture), portalElement("portal-a", born.homeId, 10, 10), LOCAL_ORIGIN);
    writeElement(
      room(fixture, elsewhere.id).doc,
      portalElement("portal-b", born.homeId, 20, 20),
      LOCAL_ORIGIN,
    );

    expect(unplaceTerminal(fixture.placement, born.terminalId)).toEqual({ removed: 2 });

    expect(readElements(canvasDoc(fixture)).size).toBe(0);
    expect(readElements(room(fixture, elsewhere.id).doc).size).toBe(0);
    // Unplaced is not a place: the terminal stays exactly where it lives.
    expect(homeOf(fixture, born.terminalId)).toBe(born.homeId);
    expect(soleRef(fixture, born.homeId)).toEqual({
      kind: "terminal",
      terminalId: born.terminalId,
    });
  });

  test("unplacing an already-unplaced terminal removes nothing and is not an error", () => {
    const fixture = lifecycleFixture();
    const born = bornOnCanvas(fixture, "ref-1");
    writeElement(canvasDoc(fixture), portalElement("portal-a", born.homeId, 10, 10), LOCAL_ORIGIN);

    expect(unplaceTerminal(fixture.placement, born.terminalId)).toEqual({ removed: 1 });
    // Zero is a legal, meaningful answer: it says the item was already unplaced, which is
    // the difference between that and the silent no-op the algebra refuses to have.
    expect(unplaceTerminal(fixture.placement, born.terminalId)).toEqual({ removed: 0 });
    expect(homeOf(fixture, born.terminalId)).toBe(born.homeId);
  });
});

describe("L8 delete container: reaps what lives there, removes what points at it", () => {
  test("deleting a composition kills its terminals and deletes the portals onto it", async () => {
    const fixture = lifecycleFixture();
    const composition = compositionContainer(fixture, "composition");
    const inside = joinPeer(fixture, composition.id);
    const first = bornInComposition(fixture, inside, "ref-1");
    const secondBorn = bornInComposition(fixture, inside, "ref-2");
    writeElement(
      canvasDoc(fixture),
      portalElement("portal-1", composition.id, 40, 50),
      LOCAL_ORIGIN,
    );
    fixture.machine.clear();

    const deleted = await call(
      fixture,
      "POST",
      "/api/actions/core.index.deleteContainer",
      OWNER_KEY,
      {
        containerId: composition.id,
      },
    );

    expect(deleted.payload).toEqual({ ok: true, result: {} });
    expect(fixture.store.getContainer(composition.id)).toBeNull();
    const killed: string[] = [];
    for (const message of fixture.machine.sent) {
      if (message.type === "kill") killed.push(message.terminalId);
    }
    expect(killed.sort()).toEqual([first.terminalId, secondBorn.terminalId].sort());
    expect(fixture.store.getTerminal(first.terminalId)).toBeNull();
    expect(fixture.store.getTerminal(secondBorn.terminalId)).toBeNull();
    expect(fixture.broker.introspect()).toEqual([]);
    // A portal onto a container that no longer exists is a state the workspace cannot reach.
    // This assertion is what catches a route reimplementing the rule instead of calling it.
    expect(readElements(canvasDoc(fixture)).size).toBe(0);
  });
});

describe("the container index reads the same containment graph placement does", () => {
  test("a census names what a container holds and what it points at", async () => {
    const fixture = lifecycleFixture();
    const born = bornOnCanvas(fixture, "ref-1");
    writeElement(canvasDoc(fixture), portalElement("portal-1", born.homeId, 10, 20), LOCAL_ORIGIN);

    const response = await call(fixture, "GET", "/api/containers", OWNER_KEY);

    expect(response.status).toBe(200);
    const containers = ContainerCensusResponseSchema.parse(response.payload).containers;
    expect(containers.find((census) => census.containerId === fixture.canvas.id)).toEqual({
      containerId: fixture.canvas.id,
      discipline: "canvas",
      items: [{ kind: "composition", containerId: born.homeId, terminalId: null }],
      references: [born.homeId],
    });
    const home = containers.find((census) => census.containerId === born.homeId);
    if (home === undefined) throw new Error("missing home census");
    expect(home.references).toEqual([]);
    // A composition of ONE is the item it holds, for the index exactly as for placement.
    expect(censusSolo(home)).toEqual({
      kind: "terminal",
      containerId: null,
      terminalId: born.terminalId,
    });
  });

  test("the terminal index reports each home and derives whether anything references it", async () => {
    const fixture = lifecycleFixture();
    const born = bornOnCanvas(fixture, "ref-1");

    expect(await indexRows(fixture)).toEqual([
      {
        id: born.terminalId,
        machineId: fixture.machine.machineId,
        name: null,
        createdAt: 0,
        status: "running",
        exitCode: null,
        homeId: born.homeId,
        unplaced: true,
      },
    ]);

    writeElement(canvasDoc(fixture), portalElement("portal-1", born.homeId, 0, 0), LOCAL_ORIGIN);

    // `unplaced` is derived from the containment graph on every read, so placing and
    // releasing a terminal leaves no state behind that could go stale.
    expect((await indexRows(fixture)).map((terminal) => terminal.unplaced)).toEqual([false]);
  });
});
