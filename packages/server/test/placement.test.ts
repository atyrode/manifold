import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DESTINATION_KINDS,
  ITEM_KINDS,
  PLACEMENT_DENIED_CODE,
  PlaceResponseSchema,
  PlacementDeniedResponseSchema,
  ServerToAgentMessageSchema,
  censusSolo,
  placementItemFor,
  resolvePlacement,
  type ContainerLayout,
  type DestinationKind,
  type ItemKind,
  type Pad,
  type PlacementDestination,
  type PlacementItem,
  type PlacementLookup,
  type PlacementSurface,
  type SceneElement,
  type ServerToAgentMessage,
} from "@manifold/protocol";
import {
  DEFAULT_TERMINAL_HEIGHT,
  DEFAULT_TERMINAL_WIDTH,
  LOCAL_ORIGIN,
  readElements,
  tileIdForSurface,
  tileLeafIds,
  writeElement,
} from "@manifold/scene";
import { AuthService, type AuthContext } from "../src/auth.ts";
import { loadConfig } from "../src/config.ts";
import { HttpApp } from "../src/http.ts";
import { silentLogger } from "../src/log.ts";
import { MachineGateway } from "../src/machine-ws.ts";
import { PlaceExecutor, type PlaceOutcome } from "../src/placement.ts";
import { RoomManager, type Room } from "../src/room.ts";
import { SessionPeer } from "../src/session-peer.ts";
import type { ServerStore } from "../src/stores.ts";
import { TerminalBroker, type MachineChannel } from "../src/terminal-broker.ts";
import { FakeClock, FakeRuntime, FakeSocket, placeTile, testStore } from "./helpers.ts";

const OWNER_KEY = "f".repeat(64);
const temporaryDirectories: string[] = [];

class FakeMachine implements MachineChannel {
  readonly sent: ServerToAgentMessage[] = [];

  constructor(readonly machineId: string) {}

  send(message: ServerToAgentMessage): boolean {
    this.sent.push(ServerToAgentMessageSchema.parse(message));
    return true;
  }
}

/**
 * One world, shaped so that EVERY declared item kind and destination has a real subject.
 *
 * The shapes that matter are the SOLO and MULTI compositions. A composition holding exactly
 * one item IS that item everywhere placement looks at it, so a solo composition can never
 * stand in for the `view` item kind — the lookup would classify it as its occupant and the
 * pair under test would silently become a different pair. Every composition here is
 * therefore multi on purpose, and the one solo composition is a terminal's home, reached
 * through the portal that references it.
 */
interface PlacementFixture {
  runtime: FakeRuntime;
  store: ServerStore;
  auth: AuthService;
  root: AuthContext;
  rooms: RoomManager;
  broker: TerminalBroker;
  placement: PlaceExecutor;
  machine: FakeMachine;
  opener: SessionPeer;
  app: HttpApp;
  /** Canvas under test; holds the notes, the ink and all three portals. */
  canvas: Pad;
  /** A different canvas, referenced by `el-portal-canvas` and embedded in `otherView`. */
  other: Pad;
  /** A second embeddable canvas, so both compositions can be MULTI without more terminals. */
  spare: Pad;
  /** MULTI composition used as the `tile` destination; holds `occupant` and `spare`. */
  view: Pad;
  /** MULTI composition used as the `view` item surface; referenced by `el-portal-view`. */
  otherView: Pad;
  /** Terminal in a SOLO home, referenced by `el-portal-solo`. */
  resident: string;
  /** The solo composition `resident` lives in. */
  residentHome: string;
  /** Terminal in a SOLO home nothing references. */
  loose: string;
  /** Terminal living in `view`, alongside the embedded `spare` canvas. */
  occupant: string;
}

function element(
  overrides: Partial<SceneElement> & Pick<SceneElement, "id" | "type">,
): SceneElement {
  const base = {
    x: 0,
    y: 0,
    width: DEFAULT_TERMINAL_WIDTH,
    height: DEFAULT_TERMINAL_HEIGHT,
    zIndex: 0,
  };
  if (overrides.type === "portal") {
    return { ...base, ...overrides, type: "portal", containerId: overrides.containerId ?? "" };
  }
  if (overrides.type === "text") {
    return { ...base, ...overrides, type: "text", text: "note", fontSize: 16, color: "#ffffff" };
  }
  return {
    ...base,
    ...overrides,
    type: "draw",
    points: [0, 0, 10, 10],
    strokeWidth: 2,
    color: "#ffffff",
  };
}

function placementFixture(): PlacementFixture {
  const cwd = mkdtempSync(join(tmpdir(), "manifold-placement-test-"));
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
  const newPad = (name: string, layout: ContainerLayout): Pad => {
    const pad: Pad = { id: runtime.newId(), name, createdAt: runtime.now(), layout };
    store.createPad(pad);
    return pad;
  };
  const canvas = newPad("canvas", "canvas");
  const other = newPad("other", "canvas");
  const spare = newPad("spare", "canvas");
  const view = newPad("view", "tiled");
  const otherView = newPad("other view", "tiled");
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
  const machine = new FakeMachine(auth.enrollMachine("placement machine", root).machine.id);
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
  const partial = {
    runtime,
    store,
    auth,
    root,
    rooms,
    broker,
    placement,
    machine,
    opener,
    app,
    canvas,
    other,
    spare,
    view,
    otherView,
  };

  // The opener stays joined so the canvas is never evicted mid-test and every element these
  // tests write lands in the document the executor reads.
  roomFor(partial, canvas.id).join(opener);
  const resident = openOnCanvas(partial);
  const loose = openOnCanvas(partial);
  const occupant = openInComposition(partial, view.id);
  // Both compositions must hold at least two items, or the lookup would look THROUGH them
  // and every pair naming one would test the occupant instead.
  fill(partial, view.id, spare.id);
  fill(partial, otherView.id, other.id);
  fill(partial, otherView.id, spare.id);

  const canvasDoc = roomFor(partial, canvas.id).doc;
  writeElement(canvasDoc, element({ id: "el-text", type: "text" }), LOCAL_ORIGIN);
  writeElement(canvasDoc, element({ id: "el-draw", type: "draw" }), LOCAL_ORIGIN);
  writeElement(
    canvasDoc,
    element({ id: "el-portal-canvas", type: "portal", containerId: other.id }),
    LOCAL_ORIGIN,
  );
  writeElement(
    canvasDoc,
    element({ id: "el-portal-view", type: "portal", containerId: otherView.id }),
    LOCAL_ORIGIN,
  );
  const residentHome = homeOf(partial, resident);
  writeElement(
    canvasDoc,
    element({ id: "el-portal-solo", type: "portal", containerId: residentHome }),
    LOCAL_ORIGIN,
  );
  return { ...partial, resident, residentHome, loose, occupant };
}

/** The store/room slice every fixture helper needs, so they run during construction too. */
type FixtureCore = Pick<
  PlacementFixture,
  "runtime" | "store" | "rooms" | "broker" | "placement" | "machine" | "opener" | "root"
>;

function roomFor(fixture: FixtureCore, padId: string): Room {
  const found = fixture.rooms.get(padId);
  if (found === null) throw new Error(`missing room ${padId}`);
  return found;
}

function homeOf(fixture: FixtureCore, sessionId: string): string {
  const padId = fixture.store.getSession(sessionId)?.padId;
  if (padId === undefined) throw new Error(`session ${sessionId} has no row`);
  return padId;
}

function lastSession(fixture: FixtureCore): string {
  const create = fixture.machine.sent.filter((message) => message.type === "create").at(-1);
  if (create === undefined || create.type !== "create") throw new Error("missing create request");
  return create.sessionId;
}

/** Opens one terminal from the canvas: it is born into a solo composition of its own. */
function openOnCanvas(fixture: FixtureCore): string {
  fixture.broker.open(fixture.opener, {
    type: "terminal_open",
    elementId: `open-${fixture.machine.sent.length}`,
    cols: 80,
    rows: 24,
  });
  const sessionId = lastSession(fixture);
  fixture.broker.onCreated(fixture.machine.machineId, sessionId);
  return sessionId;
}

/**
 * Opens one terminal INSIDE a composition, which is how an occupant gets into a view now:
 * `expand` is gone, and there is no pool to move one out of.
 */
function openInComposition(fixture: FixtureCore, padId: string): string {
  const peer = new SessionPeer(
    fixture.runtime.newId(),
    new FakeSocket(),
    fixture.root,
    padId,
    "c1",
  );
  roomFor(fixture, padId).join(peer);
  fixture.broker.open(peer, {
    type: "terminal_open",
    elementId: `open-${fixture.machine.sent.length}`,
    cols: 80,
    rows: 24,
    placement: "tile",
  });
  const sessionId = lastSession(fixture);
  fixture.broker.onCreated(fixture.machine.machineId, sessionId);
  roomFor(fixture, padId).leave(peer);
  return sessionId;
}

/** Embeds a canvas in a composition, the cheapest way to make one MULTI. */
function fill(fixture: FixtureCore, padId: string, embeddedPadId: string): void {
  const added = placeTile(
    fixture.placement,
    padId,
    { kind: "pad", padId: embeddedPadId },
    null,
    null,
  );
  if (typeof added === "string") throw new Error(`placement failed: ${added}`);
}

function terminalLeafId(fixture: PlacementFixture, padId: string, sessionId: string): string {
  const tileId = tileIdForSurface(roomFor(fixture, padId).tileLayout(), {
    kind: "terminal",
    sessionId,
  });
  if (tileId === null) throw new Error(`${padId} holds no leaf for ${sessionId}`);
  return tileId;
}

/**
 * The SAME four questions the executor asks its state, asked here from the test's side.
 * `PlacementLookup` being pure is what lets this file predict the executor's answer without
 * reaching into it — and what lets the browser predict it during a drag.
 */
function lookupFor(fixture: PlacementFixture): PlacementLookup {
  return {
    padLayout: (padId) => fixture.store.getPad(padId)?.layout ?? null,
    terminalHome: (sessionId) => fixture.broker.placedSession(sessionId)?.padId ?? null,
    elementItem: (padId, elementId): PlacementItem | null => {
      const found = fixture.rooms.get(padId)?.element(elementId) ?? null;
      if (found === null) return null;
      if (found.type !== "portal") return { kind: found.type, containerId: null };
      const layout = fixture.store.getPad(found.containerId)?.layout ?? null;
      if (layout === null) return null;
      return {
        kind: layout === "canvas" ? "canvas-pad" : "view",
        containerId: found.containerId,
      };
    },
    soloOccupant: (padId): PlacementItem | null => {
      const room = fixture.rooms.get(padId);
      if (room === null) return null;
      const census = room.census();
      if (census.layout !== "tiled") return null;
      const solo = censusSolo(census);
      if (solo === null) return null;
      // A terminal's container IS its home: the two are one thing addressed from opposite
      // sides, and every op that moves it needs exactly that id.
      return {
        kind: solo.kind,
        containerId: solo.kind === "terminal" ? padId : solo.containerId,
      };
    },
  };
}

function surfaces(fixture: PlacementFixture): Readonly<Record<ItemKind, PlacementSurface>> {
  return {
    terminal: { kind: "terminal", sessionId: fixture.loose },
    "canvas-pad": { kind: "pad", padId: fixture.other.id },
    view: { kind: "pad", padId: fixture.otherView.id },
    text: { kind: "element", padId: fixture.canvas.id, elementId: "el-text" },
    draw: { kind: "element", padId: fixture.canvas.id, elementId: "el-draw" },
    tile: {
      kind: "tile",
      containerId: fixture.view.id,
      tileId: terminalLeafId(fixture, fixture.view.id, fixture.occupant),
    },
  };
}

function destinations(
  fixture: PlacementFixture,
): Readonly<Record<DestinationKind, PlacementDestination>> {
  return {
    canvas: { kind: "canvas", padId: fixture.canvas.id, x: 320, y: 240 },
    tile: { kind: "tile", padId: fixture.view.id, targetTileId: null, edge: null },
    // Composing lands on a REFERENCE, and only a reference to a solo composition merges:
    // the target is the portal onto `resident`'s home.
    compose: {
      kind: "compose",
      padId: fixture.canvas.id,
      targetElementId: "el-portal-solo",
      edge: "right",
    },
    unplaced: { kind: "unplaced" },
  };
}

/** An outcome as one comparable token, so a denial's RULE is what a failure prints. */
function ruleOrStatus(outcome: PlaceOutcome): string {
  return outcome.status === "denied" ? `denied:${outcome.denial.rule}` : outcome.status;
}

async function call(
  fixture: PlacementFixture,
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

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("the placement algebra, executed", () => {
  test("every declared item kind x destination is executed or refused by a named rule", () => {
    const itemKinds = Object.keys(ITEM_KINDS) as ItemKind[];
    const destinationKinds = Object.keys(DESTINATION_KINDS) as DestinationKind[];
    const answers: string[] = [];
    for (const itemKind of itemKinds) {
      for (const destinationKind of destinationKinds) {
        // A fresh world per pair: an executed placement mutates state, and the next pair
        // must be judged against the same starting position as the last.
        const fixture = placementFixture();
        const surface = surfaces(fixture)[itemKind];
        const destination = destinations(fixture)[destinationKind];
        const predicted = resolvePlacement(surface, destination, lookupFor(fixture));
        const outcome = fixture.placement.place({ surface, destination });
        const label = `${itemKind} -> ${destinationKind}`;
        if (predicted.ok) {
          // No silent no-ops and no operational excuses: a pair the declarations allow
          // must actually be carried out here.
          expect(`${label}=${outcome.status}`).toBe(`${label}=placed`);
          if (outcome.status !== "placed") continue;
          expect(`${label}=${outcome.result.op}`).toBe(`${label}=${predicted.op}`);
          answers.push(`${label}=${outcome.result.op}`);
        } else {
          expect(`${label}=${outcome.status}`).toBe(`${label}=denied`);
          if (outcome.status !== "denied") continue;
          expect(`${label}=${outcome.denial.rule}`).toBe(`${label}=${predicted.denial.rule}`);
          expect(outcome.denial.surface).toEqual(surface);
          answers.push(`${label}=denied:${outcome.denial.rule}`);
        }
      }
    }
    // Exhaustive by construction: the declarations decide the pair count, not this file.
    expect(answers).toHaveLength(itemKinds.length * destinationKinds.length);
    expect(answers).toEqual([
      // A terminal landing on a canvas authors a PORTAL onto the composition it lives in.
      // That is the whole of what `bind` became: one op, shared with every container.
      "terminal -> canvas=portal",
      "terminal -> tile=add_tile",
      "terminal -> compose=compose",
      // And `park` became `unplace`: there is nowhere to park TO, so releasing is
      // subtractive and the terminal stays in the composition it lives in.
      "terminal -> unplaced=unplace",
      "canvas-pad -> canvas=portal",
      "canvas-pad -> tile=add_tile",
      "canvas-pad -> compose=compose",
      // An embedded canvas is `unplaceable` too: the pad outlives every reference to it.
      "canvas-pad -> unplaced=unplace",
      "view -> canvas=portal",
      // "Compositions merge, never nest" is now the `solo-only` guard rather than a missing
      // group: a composition still classified AS a composition holds several items, so
      // there is nothing for another composition to absorb.
      "view -> tile=denied:not_solo",
      "view -> compose=denied:not_solo",
      "view -> unplaced=unplace",
      "text -> canvas=move_element",
      "text -> tile=add_tile",
      "text -> compose=compose",
      "text -> unplaced=denied:not_accepted",
      "draw -> canvas=move_element",
      "draw -> tile=denied:not_accepted",
      "draw -> compose=denied:not_accepted",
      "draw -> unplaced=denied:not_accepted",
      "tile -> canvas=extract",
      "tile -> tile=denied:not_accepted",
      "tile -> compose=denied:not_accepted",
      "tile -> unplaced=denied:not_accepted",
    ]);
  });

  test("an element naming a portal onto a SOLO composition places the TERMINAL inside it", () => {
    const fixture = placementFixture();
    const surface: PlacementSurface = {
      kind: "element",
      padId: fixture.canvas.id,
      elementId: "el-portal-solo",
    };

    // The solo look-through, server side: a composition of one IS the item it holds, so the
    // widget the operator grabbed classifies as a terminal without any caller testing arity.
    expect(placementItemFor(surface, lookupFor(fixture))).toEqual({
      kind: "terminal",
      containerId: fixture.residentHome,
    });

    const outcome = fixture.placement.place({
      surface,
      destination: { kind: "tile", padId: fixture.view.id, targetTileId: null, edge: null },
    });

    expect(outcome.status).toBe("placed");
    if (outcome.status !== "placed") return;
    expect(outcome.result.op).toBe("add_tile");
    // The terminal moved, its emptied home retired, and the reference the drag consumed went
    // with the drop — an ordinary merge, reached through a portal.
    expect(homeOf(fixture, fixture.resident)).toBe(fixture.view.id);
    expect(fixture.store.getPad(fixture.residentHome)).toBeNull();
    expect(roomFor(fixture, fixture.canvas.id).element("el-portal-solo")).toBeNull();
  });

  test("an element naming a portal onto a MULTI composition is denied not_solo at a tile", () => {
    const fixture = placementFixture();
    const surface: PlacementSurface = {
      kind: "element",
      padId: fixture.canvas.id,
      elementId: "el-portal-view",
    };

    expect(placementItemFor(surface, lookupFor(fixture))).toEqual({
      kind: "view",
      containerId: fixture.otherView.id,
    });

    const outcome = fixture.placement.place({
      surface,
      destination: { kind: "tile", padId: fixture.view.id, targetTileId: null, edge: null },
    });

    expect(outcome.status).toBe("denied");
    if (outcome.status !== "denied") return;
    expect(outcome.denial).toEqual({
      rule: "not_solo",
      surface,
      container: { kind: "view", padId: fixture.view.id },
    });
    // A refused placement mutates nothing on either side.
    expect(tileLeafIds(roomFor(fixture, fixture.otherView.id).tileLayout() ?? {})).toHaveLength(2);
    expect(tileLeafIds(roomFor(fixture, fixture.view.id).tileLayout() ?? {})).toHaveLength(2);
    expect(roomFor(fixture, fixture.canvas.id).element("el-portal-view")).not.toBeNull();
  });

  test("the current location comes from identity, never from the caller", () => {
    const fixture = placementFixture();

    // The occupant lives in `view`. Nothing in this request says so, and no request could:
    // the only pad id it carries is the destination.
    const outcome = fixture.placement.place({
      surface: { kind: "terminal", sessionId: fixture.occupant },
      destination: { kind: "tile", padId: fixture.otherView.id, targetTileId: null, edge: null },
    });

    expect(outcome.status).toBe("placed");
    expect(homeOf(fixture, fixture.occupant)).toBe(fixture.otherView.id);
    expect(roomFor(fixture, fixture.view.id).homesSession(fixture.occupant)).toBe(false);
    expect(roomFor(fixture, fixture.otherView.id).homesSession(fixture.occupant)).toBe(true);
    // `view` still holds its embedded canvas, so losing an occupant did not empty it.
    expect(fixture.store.getPad(fixture.view.id)).not.toBeNull();
  });

  test("placing an addressed reference again MOVES it instead of authoring a second one", () => {
    const fixture = placementFixture();
    const canvas = roomFor(fixture, fixture.canvas.id);

    const repositioned = fixture.placement.place({
      surface: { kind: "element", padId: fixture.canvas.id, elementId: "el-portal-canvas" },
      destination: { kind: "canvas", padId: fixture.canvas.id, x: 12, y: 34 },
    });

    // Reposition-as-placement: the SAME element id comes back, so an already-placed
    // reference has no "already bound" refusal to earn — it changes seats.
    expect(repositioned.status).toBe("placed");
    if (repositioned.status !== "placed") return;
    expect(repositioned.result).toEqual({ op: "portal", elementId: "el-portal-canvas" });
    expect(canvas.element("el-portal-canvas")).toMatchObject({ x: 12, y: 34 });
    expect(readElements(canvas.doc).size).toBe(5);

    // Landing on a DIFFERENT canvas moves the element between documents, still keeping its
    // id, so no collaborator's reference to it breaks.
    const travelled = fixture.placement.place({
      surface: { kind: "element", padId: fixture.canvas.id, elementId: "el-portal-view" },
      destination: { kind: "canvas", padId: fixture.other.id, x: 90, y: 90 },
    });

    expect(travelled.status).toBe("placed");
    expect(canvas.element("el-portal-view")).toBeNull();
    expect(roomFor(fixture, fixture.other.id).element("el-portal-view")).toMatchObject({
      type: "portal",
      containerId: fixture.otherView.id,
      x: 90,
      y: 90,
    });
  });

  test("an id that names nothing is refused by rule or fails, never a silent no-op", () => {
    const fixture = placementFixture();
    const unknownSession = fixture.placement.place({
      surface: { kind: "terminal", sessionId: "ghost" },
      destination: { kind: "canvas", padId: fixture.canvas.id, x: 0, y: 0 },
    });
    const unknownElement = fixture.placement.place({
      surface: { kind: "element", padId: fixture.canvas.id, elementId: "ghost" },
      destination: { kind: "unplaced" },
    });
    const unknownTile = fixture.placement.place({
      surface: { kind: "tile", containerId: fixture.view.id, tileId: "t99" },
      destination: { kind: "canvas", padId: fixture.canvas.id, x: 0, y: 0 },
    });

    // A surface the lookup cannot classify places NOTHING, so the algebra itself refuses and
    // the denial names the surface. A leaf is classified without a lookup — every leaf is a
    // `tile` — so a leaf id that names nothing is an operational failure instead.
    expect([unknownSession, unknownElement, unknownTile].map(ruleOrStatus)).toEqual([
      "denied:unknown_surface",
      "denied:unknown_surface",
      "failed",
    ]);
  });
});

describe("POST /api/place", () => {
  test("serves the op-tagged result for every executed placement", async () => {
    const fixture = placementFixture();
    const portaled = await call(fixture, "POST", "/api/place", OWNER_KEY, {
      surface: { kind: "terminal", sessionId: fixture.loose },
      destination: { kind: "canvas", padId: fixture.canvas.id, x: 44, y: 55 },
    });
    expect(portaled.status).toBe(200);
    const result = PlaceResponseSchema.parse(portaled.payload);
    expect(result.op).toBe("portal");
    if (result.op !== "portal") throw new Error("portal response expected");
    const looseHome = homeOf(fixture, fixture.loose);
    // A canvas holds a REFERENCE to the composition the terminal lives in; the element kind
    // that carried a session id does not exist any more.
    expect(roomFor(fixture, fixture.canvas.id).element(result.elementId)).toMatchObject({
      type: "portal",
      containerId: looseHome,
      x: 44,
      y: 55,
    });

    const unplaced = await call(fixture, "POST", "/api/place", OWNER_KEY, {
      surface: { kind: "element", padId: fixture.canvas.id, elementId: result.elementId },
      destination: { kind: "unplaced" },
    });
    expect(unplaced.status).toBe(200);
    // The op reports HOW MANY references it removed; the terminal itself never moved.
    expect(PlaceResponseSchema.parse(unplaced.payload)).toEqual({ op: "unplace", removed: 1 });
    expect(homeOf(fixture, fixture.loose)).toBe(looseHome);
    expect(fixture.store.getPad(looseHome)).not.toBeNull();
  });

  test("an unplace that removes nothing is a 200 carrying zero, not an error", async () => {
    const fixture = placementFixture();

    const response = await call(fixture, "POST", "/api/place", OWNER_KEY, {
      surface: { kind: "terminal", sessionId: fixture.loose },
      destination: { kind: "unplaced" },
    });

    expect(response.status).toBe(200);
    expect(PlaceResponseSchema.parse(response.payload)).toEqual({ op: "unplace", removed: 0 });
  });

  test("serves a denial as data: 409 with the rule that refused it", async () => {
    const fixture = placementFixture();
    const nested = await call(fixture, "POST", "/api/place", OWNER_KEY, {
      surface: { kind: "pad", padId: fixture.otherView.id },
      destination: { kind: "tile", padId: fixture.view.id, targetTileId: null, edge: null },
    });
    expect(nested.status).toBe(409);
    const denied = PlacementDeniedResponseSchema.parse(nested.payload);
    expect(denied.error.code).toBe(PLACEMENT_DENIED_CODE);
    // Compositions merge, never nest, and the wire says WHY in a machine-readable way.
    expect(denied.error.denial).toEqual({
      rule: "not_solo",
      surface: { kind: "pad", padId: fixture.otherView.id },
      container: { kind: "view", padId: fixture.view.id },
    });

    const selfEmbed = await call(fixture, "POST", "/api/place", OWNER_KEY, {
      surface: { kind: "pad", padId: fixture.canvas.id },
      destination: { kind: "canvas", padId: fixture.canvas.id, x: 0, y: 0 },
    });
    const discipline = await call(fixture, "POST", "/api/place", OWNER_KEY, {
      surface: { kind: "terminal", sessionId: fixture.loose },
      destination: { kind: "canvas", padId: fixture.view.id, x: 0, y: 0 },
    });
    const unknownContainer = await call(fixture, "POST", "/api/place", OWNER_KEY, {
      surface: { kind: "terminal", sessionId: fixture.loose },
      destination: { kind: "tile", padId: "ghost", targetTileId: null, edge: null },
    });
    const unknownSurface = await call(fixture, "POST", "/api/place", OWNER_KEY, {
      surface: { kind: "terminal", sessionId: "ghost" },
      destination: { kind: "unplaced" },
    });
    expect([
      selfEmbed.status,
      discipline.status,
      unknownContainer.status,
      unknownSurface.status,
    ]).toEqual([409, 409, 409, 409]);
    expect(
      [selfEmbed, discipline, unknownContainer, unknownSurface].map(
        (response) => PlacementDeniedResponseSchema.parse(response.payload).error.denial.rule,
      ),
    ).toEqual(["self_embed", "discipline", "unknown_container", "unknown_surface"]);
  });

  test("a leaf that names nothing is the one operational 404 left", async () => {
    const fixture = placementFixture();

    const response = await call(fixture, "POST", "/api/place", OWNER_KEY, {
      surface: { kind: "tile", containerId: fixture.view.id, tileId: "t99" },
      destination: { kind: "canvas", padId: fixture.canvas.id, x: 0, y: 0 },
    });

    expect(response.status).toBe(404);
    expect(response.payload).toMatchObject({ error: { code: "not_found" } });
  });

  test("rejects malformed envelopes and tokens that cannot place", async () => {
    const fixture = placementFixture();
    const malformed = await call(fixture, "POST", "/api/place", OWNER_KEY, {
      surface: { kind: "terminal", sessionId: fixture.loose },
      destination: { kind: "canvas", padId: fixture.canvas.id },
    });
    const retired = await call(fixture, "POST", "/api/place", OWNER_KEY, {
      surface: { kind: "terminal", sessionId: fixture.loose },
      destination: { kind: "pool", index: 0 },
    });
    const scoped = fixture.auth.mintToken(
      {
        principal: { name: "pad guest", kind: "human" },
        caps: ["pads:read", "pads:write", "scene:write"],
        padId: fixture.canvas.id,
      },
      fixture.root,
    ).token;
    const scopedPlace = await call(fixture, "POST", "/api/place", scoped, {
      surface: { kind: "terminal", sessionId: fixture.loose },
      destination: { kind: "canvas", padId: fixture.canvas.id, x: 0, y: 0 },
    });
    const readOnly = fixture.auth.mintToken(
      { principal: { name: "reader", kind: "human" }, caps: ["pads:read"] },
      fixture.root,
    ).token;
    const readOnlyPlace = await call(fixture, "POST", "/api/place", readOnly, {
      surface: { kind: "terminal", sessionId: fixture.loose },
      destination: { kind: "canvas", padId: fixture.canvas.id, x: 0, y: 0 },
    });

    // A retired destination kind is a schema rejection, not a 409: `pool` is not a place the
    // algebra can refuse by rule any more, it is a word the wire no longer knows.
    expect([malformed.status, retired.status, scopedPlace.status, readOnlyPlace.status]).toEqual([
      400, 400, 403, 403,
    ]);
    expect(readElements(roomFor(fixture, fixture.canvas.id).doc).size).toBe(5);
  });
});
