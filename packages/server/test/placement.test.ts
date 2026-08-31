import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActionOutcomeSchema,
  DEFAULT_ELEMENT_PLACEMENT_TRAITS,
  DESTINATION_KINDS,
  ITEM_KINDS,
  PlaceResponseSchema,
  ServerToAgentMessageSchema,
  censusSolo,
  placementContainerFor,
  placementItemFor,
  placementRefusalRule,
  resolvePlacement,
  type ActionOutcome,
  type Container,
  type ContainerDiscipline,
  type DestinationKind,
  type PlacementDenial,
  type PlacementDestination,
  type PlacementItem,
  type PlacementLookup,
  type PlacementRef,
  type SceneElement,
  type ServerToAgentMessage,
  type TileRef,
} from "@manifold/protocol";
import { rosterElementTraits } from "@manifold/plugin";
import {
  DEFAULT_TERMINAL_HEIGHT,
  DEFAULT_TERMINAL_WIDTH,
  LOCAL_ORIGIN,
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
import { assemblyElementTraits, PlaceExecutor, type PlaceOutcome } from "../src/placement.ts";
import type { PluginHost } from "../src/plugin-host.ts";
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
} from "./helpers.ts";

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
 * stand in for the `composition` item kind — the lookup would classify it as its occupant
 * and the pair under test would silently become a different pair. Every composition here is
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
  /** The real assembly, so a test can read the traits the algebra resolves against. */
  plugins: PluginHost;
  machine: FakeMachine;
  opener: SessionChannel;
  app: HttpApp;
  /** Canvas under test; holds the notes, the ink and all three portals. */
  canvas: Container;
  /** A different canvas, referenced by `el-portal-canvas` and embedded in `otherComposition`. */
  other: Container;
  /** A second embeddable canvas, so both compositions can be MULTI without more terminals. */
  spare: Container;
  /** MULTI composition used as the `tile` destination; holds `occupant` and `spare`. */
  composition: Container;
  /**
   * MULTI composition used as the `composition` item ref; referenced by
   * `el-portal-composition`.
   */
  otherComposition: Container;
  /** Terminal in a SOLO home, referenced by `el-portal-solo`. */
  resident: string;
  /** The solo composition `resident` lives in. */
  residentHome: string;
  /** Terminal in a SOLO home nothing references. */
  loose: string;
  /** Terminal living in `composition`, alongside the embedded `spare` canvas. */
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
  const newContainer = (name: string, discipline: ContainerDiscipline): Container => {
    const container: Container = {
      id: runtime.newId(),
      name,
      createdAt: runtime.now(),
      discipline,
    };
    store.createContainer(container);
    return container;
  };
  const canvas = newContainer("canvas", "canvas");
  const other = newContainer("other", "canvas");
  const spare = newContainer("spare", "canvas");
  const composition = newContainer("composition", "composition");
  const otherComposition = newContainer("other composition", "composition");
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
  /*
    The assembly first, because the executor resolves CONTRIBUTED element traits against
    it (ADR 0013 §12): `text` and `draw` have no rows in `ITEM_KINDS` any more, so a fixture
    that skipped this would judge a note by the engine's default instead of core.notes'
    declaration. The roster arrives as a thunk, exactly as production wires it.
   */
  const plugins = testPluginHost(store, auth, rooms, broker, runtime);
  const placement = new PlaceExecutor(
    store,
    rooms,
    broker,
    runtime,
    assemblyElementTraits(() => plugins.roster()),
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
  const machine = new FakeMachine(auth.enrollMachine("placement machine", root).machine.id);
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
  const partial = {
    runtime,
    store,
    auth,
    root,
    rooms,
    broker,
    placement,
    plugins,
    machine,
    opener,
    app,
    canvas,
    other,
    spare,
    composition,
    otherComposition,
  };

  // The opener stays joined so the canvas is never evicted mid-test and every element these
  // tests write lands in the document the executor reads.
  roomFor(partial, canvas.id).join(opener);
  const resident = openOnCanvas(partial);
  const loose = openOnCanvas(partial);
  const occupant = openInComposition(partial, composition.id);
  // Both compositions must hold at least two items, or the lookup would look THROUGH them
  // and every pair naming one would test the occupant instead.
  fill(partial, composition.id, spare.id);
  fill(partial, otherComposition.id, other.id);
  fill(partial, otherComposition.id, spare.id);

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
    element({ id: "el-portal-composition", type: "portal", containerId: otherComposition.id }),
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

function roomFor(fixture: FixtureCore, containerId: string): Room {
  const found = fixture.rooms.get(containerId);
  if (found === null) throw new Error(`missing room ${containerId}`);
  return found;
}

function homeOf(fixture: FixtureCore, terminalId: string): string {
  const containerId = fixture.store.getTerminal(terminalId)?.containerId;
  if (containerId === undefined) throw new Error(`terminal ${terminalId} has no row`);
  return containerId;
}

function lastTerminal(fixture: FixtureCore): string {
  const create = fixture.machine.sent.filter((message) => message.type === "create").at(-1);
  if (create === undefined || create.type !== "create") throw new Error("missing create request");
  return create.terminalId;
}

/** Opens one terminal from the canvas: it is born into a solo composition of its own. */
function openOnCanvas(fixture: FixtureCore): string {
  fixture.broker.open(fixture.opener, {
    type: "terminal_open",
    elementId: `open-${fixture.machine.sent.length}`,
    cols: 80,
    rows: 24,
  });
  const terminalId = lastTerminal(fixture);
  fixture.broker.onCreated(fixture.machine.machineId, terminalId);
  return terminalId;
}

/**
 * Opens one terminal INSIDE a composition, which is how an occupant gets into one now:
 * `expand` is gone, and there is no pool to move one out of.
 */
function openInComposition(fixture: FixtureCore, containerId: string): string {
  const channel = new SessionChannel(
    fixture.runtime.newId(),
    new FakeSocket(),
    fixture.root,
    containerId,
    "c1",
  );
  roomFor(fixture, containerId).join(channel);
  fixture.broker.open(channel, {
    type: "terminal_open",
    elementId: `open-${fixture.machine.sent.length}`,
    cols: 80,
    rows: 24,
    placement: "tile",
  });
  const terminalId = lastTerminal(fixture);
  fixture.broker.onCreated(fixture.machine.machineId, terminalId);
  roomFor(fixture, containerId).leave(channel);
  return terminalId;
}

/** Embeds a canvas in a composition, the cheapest way to make one MULTI. */
function fill(fixture: FixtureCore, containerId: string, embeddedContainerId: string): void {
  const added = placeTile(
    fixture.placement,
    containerId,
    { kind: "container", containerId: embeddedContainerId },
    null,
    null,
  );
  if (typeof added === "string") throw new Error(`placement failed: ${added}`);
}

function terminalLeafId(
  fixture: PlacementFixture,
  containerId: string,
  terminalId: string,
): string {
  const tileId = tileIdForRef(roomFor(fixture, containerId).tileLayout(), {
    kind: "terminal",
    terminalId,
  });
  if (tileId === null) throw new Error(`${containerId} holds no leaf for ${terminalId}`);
  return tileId;
}

/**
 * The SAME five questions the executor asks its state, asked here from the test's side.
 * `PlacementLookup` being pure is what lets this file predict the executor's answer without
 * reaching into it — and what lets the browser predict it during a drag. The fifth question
 * is the assembly's: which traits a CONTRIBUTED element kind declared (ADR 0013 §12).
 */
function lookupFor(fixture: PlacementFixture): PlacementLookup {
  return {
    disciplineOf: (containerId) => fixture.store.getContainer(containerId)?.discipline ?? null,
    terminalHome: (terminalId) => fixture.broker.placedTerminal(terminalId)?.containerId ?? null,
    elementItem: (containerId, elementId): PlacementItem | null => {
      const found = fixture.rooms.get(containerId)?.element(elementId) ?? null;
      if (found === null) return null;
      if (found.type !== "portal") return { kind: found.type, containerId: null };
      const discipline = fixture.store.getContainer(found.containerId)?.discipline ?? null;
      if (discipline === null) return null;
      return { kind: discipline, containerId: found.containerId };
    },
    soloOccupant: (containerId): PlacementItem | null => {
      const room = fixture.rooms.get(containerId);
      if (room === null) return null;
      const census = room.census();
      if (census.discipline !== "composition") return null;
      const solo = censusSolo(census);
      if (solo === null) return null;
      // A terminal's container IS its home: the two are one thing addressed from opposite
      // sides, and every op that moves it needs exactly that id.
      return {
        kind: solo.kind,
        containerId: solo.kind === "terminal" ? containerId : solo.containerId,
      };
    },
    itemTraits: (kind) => rosterElementTraits(fixture.plugins.roster()).get(kind) ?? null,
  };
}

/**
 * One ref per placeable kind: the floor's own, plus the element kinds this assembly
 * contributes. The keys are asserted against the declarations below, so a kind that appears
 * on either side without a ref here fails the matrix rather than going unexercised.
 */
function refs(fixture: PlacementFixture): Readonly<Record<string, PlacementRef>> {
  return {
    terminal: { kind: "terminal", terminalId: fixture.loose },
    canvas: { kind: "container", containerId: fixture.other.id },
    composition: { kind: "container", containerId: fixture.otherComposition.id },
    text: { kind: "element", containerId: fixture.canvas.id, elementId: "el-text" },
    draw: { kind: "element", containerId: fixture.canvas.id, elementId: "el-draw" },
    tile: {
      kind: "tile",
      containerId: fixture.composition.id,
      tileId: terminalLeafId(fixture, fixture.composition.id, fixture.occupant),
    },
    // Deliberately an address that resolves to nothing: no element is ever a panel, and no
    // other ref form names one either (see the golden rows below).
    panel: { kind: "element", containerId: fixture.canvas.id, elementId: "el-panel" },
  };
}

function destinations(
  fixture: PlacementFixture,
): Readonly<Record<DestinationKind, PlacementDestination>> {
  return {
    canvas: { kind: "canvas", containerId: fixture.canvas.id, x: 320, y: 240 },
    tile: {
      kind: "tile",
      containerId: fixture.composition.id,
      targetTileId: null,
      edge: null,
    },
    // Composing lands on a REFERENCE, and only a reference to a solo composition merges:
    // the target is the portal onto `resident`'s home.
    compose: {
      kind: "compose",
      containerId: fixture.canvas.id,
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
  test("every placeable kind x destination is executed or refused by a named rule", () => {
    /*
      The kinds come from BOTH halves of the vocabulary now: the floor's structural kinds and
      the element kinds the real assembly contributes (ADR 0013 §12). Deriving them rather
      than listing them is what keeps this matrix exhaustive as plugins take ownership of
      kinds — a contributed kind with no ref above fails here.
     */
    const contributed = [...rosterElementTraits(placementFixture().plugins.roster()).keys()];
    const itemKinds = [...Object.keys(ITEM_KINDS), ...contributed];
    const destinationKinds = Object.keys(DESTINATION_KINDS) as DestinationKind[];
    const answers: string[] = [];
    for (const itemKind of itemKinds) {
      for (const destinationKind of destinationKinds) {
        // A fresh world per pair: an executed placement mutates state, and the next pair
        // must be judged against the same starting position as the last.
        const fixture = placementFixture();
        const ref = refs(fixture)[itemKind];
        const destination = destinations(fixture)[destinationKind];
        if (ref === undefined) throw new Error(`no ref for ${itemKind}`);
        if (destination === undefined) throw new Error(`no destination for ${destinationKind}`);
        const predicted = resolvePlacement(ref, destination, lookupFor(fixture));
        const outcome = fixture.placement.place({ ref, destination });
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
          expect(outcome.denial.ref).toEqual(ref);
          answers.push(`${label}=denied:${outcome.denial.rule}`);
        }
      }
    }
    // Exhaustive by construction: the declarations decide the pair count, not this file. The
    // ORDER is the vocabulary's, which is the roster's for contributed kinds, so the golden
    // rows are compared as a set — the pairs are the contract, not their sequence.
    expect(answers).toHaveLength(itemKinds.length * destinationKinds.length);
    expect([...answers].sort()).toEqual(
      [
        // A terminal landing on a canvas authors a PORTAL onto the composition it lives in.
        // That is the whole of what `bind` became: one op, shared with every container.
        "terminal -> canvas=portal",
        "terminal -> tile=add_tile",
        "terminal -> compose=compose",
        // And `park` became `unplace`: there is nowhere to park TO, so releasing is
        // subtractive and the terminal stays in the composition it lives in.
        "terminal -> unplaced=unplace",
        "canvas -> canvas=portal",
        "canvas -> tile=add_tile",
        "canvas -> compose=compose",
        // An embedded canvas is `unplaceable` too: the container outlives every reference
        // to it.
        "canvas -> unplaced=unplace",
        "composition -> canvas=portal",
        // "Compositions merge, never nest" is now the `solo_only` guard rather than a
        // missing group: a composition still classified AS a composition holds several
        // items, so there is nothing for another composition to absorb.
        "composition -> tile=denied:not_solo",
        "composition -> compose=denied:not_solo",
        "composition -> unplaced=unplace",
        "text -> canvas=move_element",
        "text -> tile=add_tile",
        "text -> compose=compose",
        "text -> unplaced=denied:not_accepted",
        "draw -> canvas=move_element",
        "draw -> tile=denied:not_accepted",
        "draw -> compose=denied:not_accepted",
        "draw -> unplaced=denied:not_accepted",
        "tile -> canvas=extract",
        // A leaf is a re-placeable PLACEMENT: both composition cells were
        // `denied:not_accepted` until the center-swap work, and the operator approved the
        // flip. An edge MOVES the leaf into the destination, the exact spot of an occupied
        // leaf EXCHANGES or DISPLACES, and merging onto a canvas portal is that same move
        // reached through the compose door.
        "tile -> tile=add_tile",
        "tile -> compose=compose",
        // And releasing a leaf re-homes its occupant instead of destroying it, which is what
        // makes the fullscreen tile-minimize button do something at last.
        "tile -> unplaced=unplace",
        /*
        A panel has no wire REF form at all: a principal's workspace layout is written
        whole by `core.space.setLayout`, so the placement door can never be handed one. The
        matrix still has to ask, and the honest answer from THIS side is that the address
        resolves to nothing — the algebra's own panel rules are exercised in
        `packages/protocol/test/placement.test.ts`, where a lookup can produce a panel item.
       */
        "panel -> canvas=denied:unknown_ref",
        "panel -> tile=denied:unknown_ref",
        "panel -> compose=denied:unknown_ref",
        "panel -> unplaced=denied:unknown_ref",
      ].sort(),
    );
  });

  test("an element naming a portal onto a SOLO composition places the TERMINAL inside it", () => {
    const fixture = placementFixture();
    const ref: PlacementRef = {
      kind: "element",
      containerId: fixture.canvas.id,
      elementId: "el-portal-solo",
    };

    // The solo look-through, server side: a composition of one IS the item it holds, so the
    // portal the operator grabbed classifies as a terminal without any caller testing arity.
    expect(placementItemFor(ref, lookupFor(fixture))).toEqual({
      kind: "terminal",
      containerId: fixture.residentHome,
    });

    const outcome = fixture.placement.place({
      ref,
      destination: {
        kind: "tile",
        containerId: fixture.composition.id,
        targetTileId: null,
        edge: null,
      },
    });

    expect(outcome.status).toBe("placed");
    if (outcome.status !== "placed") return;
    expect(outcome.result.op).toBe("add_tile");
    // The terminal moved, its emptied home retired, and the reference the drag consumed went
    // with the drop — an ordinary merge, reached through a portal.
    expect(homeOf(fixture, fixture.resident)).toBe(fixture.composition.id);
    expect(fixture.store.getContainer(fixture.residentHome)).toBeNull();
    expect(roomFor(fixture, fixture.canvas.id).element("el-portal-solo")).toBeNull();
  });

  test("an element naming a portal onto a MULTI composition is denied not_solo at a tile", () => {
    const fixture = placementFixture();
    const ref: PlacementRef = {
      kind: "element",
      containerId: fixture.canvas.id,
      elementId: "el-portal-composition",
    };

    expect(placementItemFor(ref, lookupFor(fixture))).toEqual({
      kind: "composition",
      containerId: fixture.otherComposition.id,
    });

    const outcome = fixture.placement.place({
      ref,
      destination: {
        kind: "tile",
        containerId: fixture.composition.id,
        targetTileId: null,
        edge: null,
      },
    });

    expect(outcome.status).toBe("denied");
    if (outcome.status !== "denied") return;
    expect(outcome.denial).toEqual({
      rule: "not_solo",
      ref,
      container: { kind: "composition", containerId: fixture.composition.id },
    });
    // A refused placement mutates nothing on either side.
    expect(
      tileLeafIds(roomFor(fixture, fixture.otherComposition.id).tileLayout() ?? {}),
    ).toHaveLength(2);
    expect(tileLeafIds(roomFor(fixture, fixture.composition.id).tileLayout() ?? {})).toHaveLength(
      2,
    );
    expect(roomFor(fixture, fixture.canvas.id).element("el-portal-composition")).not.toBeNull();
  });

  test("the current location comes from identity, never from the caller", () => {
    const fixture = placementFixture();

    // The occupant lives in `composition`. Nothing in this request says so, and no request
    // could: the only container id it carries is the destination.
    const outcome = fixture.placement.place({
      ref: { kind: "terminal", terminalId: fixture.occupant },
      destination: {
        kind: "tile",
        containerId: fixture.otherComposition.id,
        targetTileId: null,
        edge: null,
      },
    });

    expect(outcome.status).toBe("placed");
    expect(homeOf(fixture, fixture.occupant)).toBe(fixture.otherComposition.id);
    expect(roomFor(fixture, fixture.composition.id).homesTerminal(fixture.occupant)).toBe(false);
    expect(roomFor(fixture, fixture.otherComposition.id).homesTerminal(fixture.occupant)).toBe(
      true,
    );
    // `composition` still holds its embedded canvas, so losing an occupant did not empty it.
    expect(fixture.store.getContainer(fixture.composition.id)).not.toBeNull();
  });

  test("placing an addressed reference again MOVES it instead of authoring a second one", () => {
    const fixture = placementFixture();
    const canvas = roomFor(fixture, fixture.canvas.id);

    const repositioned = fixture.placement.place({
      ref: { kind: "element", containerId: fixture.canvas.id, elementId: "el-portal-canvas" },
      destination: { kind: "canvas", containerId: fixture.canvas.id, x: 12, y: 34 },
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
      ref: { kind: "element", containerId: fixture.canvas.id, elementId: "el-portal-composition" },
      destination: { kind: "canvas", containerId: fixture.other.id, x: 90, y: 90 },
    });

    expect(travelled.status).toBe("placed");
    expect(canvas.element("el-portal-composition")).toBeNull();
    expect(roomFor(fixture, fixture.other.id).element("el-portal-composition")).toMatchObject({
      type: "portal",
      containerId: fixture.otherComposition.id,
      x: 90,
      y: 90,
    });
  });

  test("an id that names nothing is refused by rule or fails, never a silent no-op", () => {
    const fixture = placementFixture();
    const unknownTerminal = fixture.placement.place({
      ref: { kind: "terminal", terminalId: "ghost" },
      destination: { kind: "canvas", containerId: fixture.canvas.id, x: 0, y: 0 },
    });
    const unknownElement = fixture.placement.place({
      ref: { kind: "element", containerId: fixture.canvas.id, elementId: "ghost" },
      destination: { kind: "unplaced" },
    });
    const unknownTile = fixture.placement.place({
      ref: { kind: "tile", containerId: fixture.composition.id, tileId: "t99" },
      destination: { kind: "canvas", containerId: fixture.canvas.id, x: 0, y: 0 },
    });

    // A ref the lookup cannot classify places NOTHING, so the algebra itself refuses and the
    // denial names the ref. A leaf is classified without a lookup — every leaf is a `tile` —
    // so a leaf id that names nothing is an operational failure instead.
    expect([unknownTerminal, unknownElement, unknownTile].map(ruleOrStatus)).toEqual([
      "denied:unknown_ref",
      "denied:unknown_ref",
      "failed",
    ]);
  });
});

/** The leaf showing an embedded canvas, so a swap has a second species to trade with. */
function containerLeafId(fixture: PlacementFixture, containerId: string, embedded: string): string {
  const tileId = tileIdForRef(roomFor(fixture, containerId).tileLayout(), {
    kind: "container",
    containerId: embedded,
  });
  if (tileId === null) throw new Error(`${containerId} holds no leaf for ${embedded}`);
  return tileId;
}

/** Every leaf's occupant keyed by tile id, so an exchange can be read as one value. */
function occupants(fixture: PlacementFixture, containerId: string): Record<string, TileRef | null> {
  const layout = roomFor(fixture, containerId).tileLayout() ?? {};
  const held: Record<string, TileRef | null> = {};
  for (const tileId of tileLeafIds(layout)) held[tileId] = layout[tileId]?.ref ?? null;
  return held;
}

describe("center means this exact spot", () => {
  test("center on an EMPTY leaf still fills it, and says so", () => {
    const fixture = placementFixture();
    const empty: Container = {
      id: fixture.runtime.newId(),
      name: "empty",
      createdAt: fixture.runtime.now(),
      discipline: "composition",
    };
    fixture.store.createContainer(empty);
    expect(occupants(fixture, empty.id)).toEqual({ root: null });

    const outcome = fixture.placement.place({
      ref: { kind: "terminal", terminalId: fixture.loose },
      destination: { kind: "tile", containerId: empty.id, targetTileId: "root", edge: "center" },
    });

    // Unchanged behaviour, and deliberately NOT a swap: an empty seat has nothing to trade.
    expect(outcome.status).toBe("placed");
    if (outcome.status !== "placed") return;
    expect(outcome.result).toEqual({ op: "add_tile", tileId: "root" });
    expect(occupants(fixture, empty.id)).toEqual({
      root: { kind: "terminal", terminalId: fixture.loose },
    });
  });

  test("two leaves of ONE composition exchange occupants, keeping their seats", () => {
    const fixture = placementFixture();
    const terminalTile = terminalLeafId(fixture, fixture.composition.id, fixture.occupant);
    const canvasTile = containerLeafId(fixture, fixture.composition.id, fixture.spare.id);

    const outcome = fixture.placement.place({
      ref: { kind: "tile", containerId: fixture.composition.id, tileId: terminalTile },
      destination: {
        kind: "tile",
        containerId: fixture.composition.id,
        targetTileId: canvasTile,
        edge: "center",
      },
    });

    expect(outcome.status).toBe("placed");
    if (outcome.status !== "placed") return;
    // The op the executor RAN, not the one resolution predicted (`add_tile`).
    expect(outcome.result).toEqual({
      op: "swap",
      placementId: canvasTile,
      withPlacementId: terminalTile,
    });
    expect(occupants(fixture, fixture.composition.id)).toEqual({
      [terminalTile]: { kind: "container", containerId: fixture.spare.id },
      [canvasTile]: { kind: "terminal", terminalId: fixture.occupant },
    });
    // Nothing about where the terminal LIVES changed: it never left the container.
    expect(homeOf(fixture, fixture.occupant)).toBe(fixture.composition.id);
  });

  test("leaves of two DIFFERENT compositions exchange, and the terminal's home follows", () => {
    const fixture = placementFixture();
    const terminalTile = terminalLeafId(fixture, fixture.composition.id, fixture.occupant);
    const foreignTile = containerLeafId(fixture, fixture.otherComposition.id, fixture.other.id);

    const outcome = fixture.placement.place({
      ref: { kind: "tile", containerId: fixture.composition.id, tileId: terminalTile },
      destination: {
        kind: "tile",
        containerId: fixture.otherComposition.id,
        targetTileId: foreignTile,
        edge: "center",
      },
    });

    expect(outcome.status).toBe("placed");
    if (outcome.status !== "placed") return;
    expect(outcome.result).toEqual({
      op: "swap",
      placementId: foreignTile,
      withPlacementId: terminalTile,
    });
    // Each container kept its seats and swapped what sits in them.
    expect(occupants(fixture, fixture.composition.id)[terminalTile]).toEqual({
      kind: "container",
      containerId: fixture.other.id,
    });
    expect(occupants(fixture, fixture.otherComposition.id)[foreignTile]).toEqual({
      kind: "terminal",
      terminalId: fixture.occupant,
    });
    // A terminal lives in exactly one composition, so the exchange rebound it.
    expect(homeOf(fixture, fixture.occupant)).toBe(fixture.otherComposition.id);
    expect(roomFor(fixture, fixture.composition.id).homesTerminal(fixture.occupant)).toBe(false);
    expect(roomFor(fixture, fixture.otherComposition.id).homesTerminal(fixture.occupant)).toBe(
      true,
    );
    // Both containers survive the trade, so neither is retired and no portal is repointed.
    expect(fixture.store.getContainer(fixture.composition.id)).not.toBeNull();
    expect(fixture.store.getContainer(fixture.otherComposition.id)).not.toBeNull();
    expect(roomFor(fixture, fixture.canvas.id).element("el-portal-composition")).toMatchObject({
      containerId: fixture.otherComposition.id,
    });
  });

  test("two canvas elements exchange rectangles and nothing else about them", () => {
    const fixture = placementFixture();
    const canvas = roomFor(fixture, fixture.canvas.id);
    writeElement(
      canvas.doc,
      element({
        id: "el-portal-canvas",
        type: "portal",
        containerId: fixture.other.id,
        x: 10,
        y: 20,
      }),
      LOCAL_ORIGIN,
    );
    writeElement(
      canvas.doc,
      element({
        id: "el-portal-composition",
        type: "portal",
        containerId: fixture.otherComposition.id,
        x: 400,
        y: 300,
        width: 200,
        height: 150,
      }),
      LOCAL_ORIGIN,
    );

    const outcome = fixture.placement.place({
      ref: { kind: "element", containerId: fixture.canvas.id, elementId: "el-portal-canvas" },
      destination: {
        kind: "compose",
        containerId: fixture.canvas.id,
        targetElementId: "el-portal-composition",
        edge: "center",
      },
    });

    expect(outcome.status).toBe("placed");
    if (outcome.status !== "placed") return;
    // The exact spot on a canvas IS the target's rectangle, so this is a trade of seats,
    // never the merge an edge would have made.
    expect(outcome.result).toEqual({
      op: "swap",
      placementId: "el-portal-canvas",
      withPlacementId: "el-portal-composition",
    });
    expect(canvas.element("el-portal-canvas")).toMatchObject({
      containerId: fixture.other.id,
      x: 400,
      y: 300,
      width: 200,
      height: 150,
    });
    expect(canvas.element("el-portal-composition")).toMatchObject({
      containerId: fixture.otherComposition.id,
      x: 10,
      y: 20,
      width: DEFAULT_TERMINAL_WIDTH,
      height: DEFAULT_TERMINAL_HEIGHT,
    });
    // No composition was born, and no element was authored or removed.
    expect(readElements(canvas.doc).size).toBe(5);
  });

  test("a carry with no CANVAS seat of its own is refused by name, not coerced", () => {
    const fixture = placementFixture();
    const canvas = roomFor(fixture, fixture.canvas.id);

    // A sidebar row names an ITEM. On a canvas an element IS its rectangle, so there is no
    // seat anywhere to give the target's occupant back and the exchange is refused by rule
    // rather than quietly becoming a merge. The tile door answers differently — see the
    // displacement suite below — because a composition can re-home what it pushes aside.
    const identityAtPortal = fixture.placement.place({
      ref: { kind: "terminal", terminalId: fixture.loose },
      destination: {
        kind: "compose",
        containerId: fixture.canvas.id,
        targetElementId: "el-portal-solo",
        edge: "center",
      },
    });

    expect(ruleOrStatus(identityAtPortal)).toBe("denied:not_swappable");
    if (identityAtPortal.status !== "denied") return;
    expect(identityAtPortal.denial).toEqual({
      rule: "not_swappable",
      ref: { kind: "terminal", terminalId: fixture.loose },
      container: { kind: "composition", containerId: fixture.canvas.id },
    });
    // A refusal mutates nothing on either side.
    expect(canvas.element("el-portal-solo")).toMatchObject({ containerId: fixture.residentHome });
    expect(homeOf(fixture, fixture.loose)).not.toBe(fixture.residentHome);
  });

  test("an EDGE release moves the leaf instead of trading it", () => {
    const fixture = placementFixture();
    const terminalTile = terminalLeafId(fixture, fixture.composition.id, fixture.occupant);
    const foreignTile = containerLeafId(fixture, fixture.otherComposition.id, fixture.other.id);

    const outcome = fixture.placement.place({
      ref: { kind: "tile", containerId: fixture.composition.id, tileId: terminalTile },
      destination: {
        kind: "tile",
        containerId: fixture.otherComposition.id,
        targetTileId: foreignTile,
        edge: "right",
      },
    });

    expect(outcome.status).toBe("placed");
    if (outcome.status !== "placed") return;
    expect(outcome.result.op).toBe("add_tile");
    // The old seat is GONE: re-placing a placement moves it rather than copying it.
    expect(roomFor(fixture, fixture.composition.id).homesTerminal(fixture.occupant)).toBe(false);
    expect(Object.keys(occupants(fixture, fixture.composition.id))).toHaveLength(1);
    expect(homeOf(fixture, fixture.occupant)).toBe(fixture.otherComposition.id);
    expect(
      tileLeafIds(roomFor(fixture, fixture.otherComposition.id).tileLayout() ?? {}),
    ).toHaveLength(3);
  });

  test("a leaf released on a canvas portal merges through the same move", () => {
    const fixture = placementFixture();
    const terminalTile = terminalLeafId(fixture, fixture.composition.id, fixture.occupant);
    const canvas = roomFor(fixture, fixture.canvas.id);

    // The compose door, reached by a LEAF rather than by a canvas element. It was denied
    // `not_accepted` before the center-swap work; it has to be carried out fully now.
    const outcome = fixture.placement.place({
      ref: { kind: "tile", containerId: fixture.composition.id, tileId: terminalTile },
      destination: {
        kind: "compose",
        containerId: fixture.canvas.id,
        targetElementId: "el-portal-solo",
        edge: "right",
      },
    });

    expect(outcome.status).toBe("placed");
    if (outcome.status !== "placed" || outcome.result.op !== "compose") return;
    const bornId = outcome.result.containerId;
    // Both terminals live in the newborn, which is named after what went into it — the
    // leaf is named for what it HOLDS, never for the gesture that carried it.
    expect(homeOf(fixture, fixture.occupant)).toBe(bornId);
    expect(homeOf(fixture, fixture.resident)).toBe(bornId);
    expect(fixture.store.getContainer(bornId)?.name).toContain(" + ");
    expect(fixture.store.getContainer(bornId)?.name).not.toContain("ref");
    // The portal keeps its element id and now points at the composition it grew into.
    expect(canvas.element("el-portal-solo")).toMatchObject({ containerId: bornId });
    // The leaf's old seat is gone, and its container survives because it still holds the
    // embedded canvas — a departure only absorbs a container it left holding nothing.
    expect(roomFor(fixture, fixture.composition.id).homesTerminal(fixture.occupant)).toBe(false);
    expect(fixture.store.getContainer(fixture.composition.id)).not.toBeNull();
    expect(fixture.store.getContainer(fixture.residentHome)).toBeNull();
  });
});

/** A note, moved out of the canvas and into a leaf of `containerId`, so it can be a target. */
function noteLeafId(fixture: PlacementFixture, containerId: string): string {
  const added = fixture.placement.place({
    ref: { kind: "element", containerId: fixture.canvas.id, elementId: "el-text" },
    destination: { kind: "tile", containerId, targetTileId: null, edge: null },
  });
  if (added.status !== "placed" || added.result.op !== "add_tile") {
    throw new Error(`the note did not tile: ${ruleOrStatus(added)}`);
  }
  return added.result.tileId;
}

describe("the seam distinguishes wedging between from splitting one pane (#60)", () => {
  test("`between` takes thirds from both neighbors; its absence splits the target alone", () => {
    const fixture = placementFixture();
    const container: Container = {
      id: fixture.runtime.newId(),
      name: "seam",
      createdAt: fixture.runtime.now(),
      discipline: "composition",
    };
    fixture.store.createContainer(container);
    // Seed `A | B`: the loose terminal fills the root, the canvas container splits it right.
    fixture.placement.place({
      ref: { kind: "terminal", terminalId: fixture.loose },
      destination: {
        kind: "tile",
        containerId: container.id,
        targetTileId: "root",
        edge: "center",
      },
    });
    fixture.placement.place({
      ref: { kind: "container", containerId: fixture.other.id },
      destination: {
        kind: "tile",
        containerId: container.id,
        targetTileId: "root",
        edge: "right",
      },
    });
    const room = roomFor(fixture, container.id);
    const seeded = room.tileLayout() ?? {};
    const aId = Object.entries(occupants(fixture, container.id)).find(
      ([, ref]) => ref?.kind === "terminal",
    )?.[0];
    if (aId === undefined) throw new Error("seeded terminal leaf missing");
    expect(seeded["root"]?.ratios).toEqual([0.5, 0.5]);

    // WITHOUT `between`, an interior insert splits the TARGET's own share: A cedes
    // half, B is untouched — the `(A|C)|B` shape dev.14 had regressed away.
    const split = fixture.placement.place({
      ref: { kind: "element", containerId: fixture.canvas.id, elementId: "el-text" },
      destination: { kind: "tile", containerId: container.id, targetTileId: aId, edge: "right" },
    });
    expect(split.status).toBe("placed");
    if (split.status !== "placed" || split.result.op !== "add_tile") return;
    const afterSplit = room.tileLayout() ?? {};
    expect(afterSplit["root"]?.children).toHaveLength(3);
    expect(afterSplit["root"]?.ratios).toEqual([0.25, 0.25, 0.5]);

    // WITH `between`, the newcomer wedges into the seam: BOTH neighbors cede a third.
    const wedged = fixture.placement.place({
      ref: { kind: "container", containerId: fixture.canvas.id },
      destination: {
        kind: "tile",
        containerId: container.id,
        targetTileId: split.result.tileId,
        edge: "right",
        between: true,
      },
    });
    expect(wedged.status).toBe("placed");
    const ratios = (room.tileLayout() ?? {})["root"]?.ratios ?? [];
    expect(ratios).toHaveLength(4);
    expect(ratios[0]).toBeCloseTo(0.25, 10);
    expect(ratios[1]).toBeCloseTo(1 / 6, 10);
    expect(ratios[2]).toBeCloseTo(0.25, 10);
    expect(ratios[3]).toBeCloseTo(1 / 3, 10);
  });
});

describe("a center drop with nothing to trade displaces instead", () => {
  test("the occupant is re-homed into a fresh solo composition and keeps running", () => {
    const fixture = placementFixture();
    const occupied = terminalLeafId(fixture, fixture.composition.id, fixture.occupant);
    const composition = roomFor(fixture, fixture.composition.id);
    const itemsBefore = composition.census().items.length;
    const looseHome = homeOf(fixture, fixture.loose);

    // A sidebar row holds no leaf to trade back, so the exact spot is GIVEN to it and what
    // was there moves out — the refusal the tile door used to answer with is gone.
    const outcome = fixture.placement.place({
      ref: { kind: "terminal", terminalId: fixture.loose },
      destination: {
        kind: "tile",
        containerId: fixture.composition.id,
        targetTileId: occupied,
        edge: "center",
      },
    });

    expect(outcome.status).toBe("placed");
    if (outcome.status !== "placed" || outcome.result.op !== "replace") {
      throw new Error(`expected a displacement: ${ruleOrStatus(outcome)}`);
    }
    expect(outcome.result.tileId).toBe(occupied);
    const displaced = outcome.result.displacedContainerId;
    if (displaced === null) throw new Error("a displaced terminal needs a home of its own");
    // Nothing was destroyed: the terminal is alive and now lives in a composition that is
    // its own, which is a top-level row of the index like any other unreferenced container.
    expect(fixture.broker.placedTerminal(fixture.occupant)).not.toBeNull();
    expect(homeOf(fixture, fixture.occupant)).toBe(displaced);
    expect(fixture.store.getContainer(displaced)).toMatchObject({ discipline: "composition" });
    expect(roomFor(fixture, displaced).homesTerminal(fixture.occupant)).toBe(true);
    // The leaf was RE-SEATED, never removed: the target held something at every moment, so
    // its census never dipped and no reaping or retiring could fire on this side.
    expect(occupants(fixture, fixture.composition.id)[occupied]).toEqual({
      kind: "terminal",
      terminalId: fixture.loose,
    });
    expect(composition.census().items.length).toBe(itemsBefore);
    // The carry is bookkept exactly as an ordinary add: its solo home was absorbed.
    expect(homeOf(fixture, fixture.loose)).toBe(fixture.composition.id);
    expect(fixture.store.getContainer(looseHome)).toBeNull();
  });

  test("displacing an EMBEDDED CANVAS needs no new home, and says so with a null", () => {
    const fixture = placementFixture();
    const embedded = containerLeafId(fixture, fixture.composition.id, fixture.spare.id);

    const outcome = fixture.placement.place({
      ref: { kind: "terminal", terminalId: fixture.loose },
      destination: {
        kind: "tile",
        containerId: fixture.composition.id,
        targetTileId: embedded,
        edge: "center",
      },
    });

    expect(outcome.status).toBe("placed");
    if (outcome.status !== "placed" || outcome.result.op !== "replace") {
      throw new Error(`expected a displacement: ${ruleOrStatus(outcome)}`);
    }
    // A leaf holding a canvas is a REFERENCE: the container it points at already lives in
    // the index on its own, so losing the leaf costs it nothing and no home is born for it.
    expect(outcome.result.displacedContainerId).toBeNull();
    expect(fixture.store.getContainer(fixture.spare.id)).not.toBeNull();
    expect(occupants(fixture, fixture.composition.id)[embedded]).toEqual({
      kind: "terminal",
      terminalId: fixture.loose,
    });
  });

  test("a CANVAS TERMINAL carry trades instead: its portal starts showing the occupant (#62)", () => {
    const fixture = placementFixture();
    const occupied = terminalLeafId(fixture, fixture.composition.id, fixture.occupant);
    const composition = roomFor(fixture, fixture.composition.id);
    const itemsBefore = composition.census().items.length;
    const containersBefore = fixture.store.listContainers().length;

    // The element is a window onto the resident's solo home — a seat the occupant can
    // move into the instant the resident merges away — so this carry is SEATED and the
    // exact spot trades rather than displacing anyone to the top of the index.
    const outcome = fixture.placement.place({
      ref: { kind: "element", containerId: fixture.canvas.id, elementId: "el-portal-solo" },
      destination: {
        kind: "tile",
        containerId: fixture.composition.id,
        targetTileId: occupied,
        edge: "center",
      },
    });

    expect(outcome.status).toBe("placed");
    if (outcome.status !== "placed" || outcome.result.op !== "swap") {
      throw new Error(`expected a trade: ${ruleOrStatus(outcome)}`);
    }
    expect(outcome.result.placementId).toBe(occupied);
    // The carried terminal took the exact spot it was released on…
    expect(occupants(fixture, fixture.composition.id)[occupied]).toEqual({
      kind: "terminal",
      terminalId: fixture.resident,
    });
    expect(homeOf(fixture, fixture.resident)).toBe(fixture.composition.id);
    // …and the occupant took the seat the carry came from: the portal's own home.
    expect(homeOf(fixture, fixture.occupant)).toBe(fixture.residentHome);
    expect(roomFor(fixture, fixture.residentHome).homesTerminal(fixture.occupant)).toBe(true);
    // The canvas element never moved or repointed: same id, same target, and the
    // container it shows now holds the displaced terminal — the portal just changed face.
    expect(roomFor(fixture, fixture.canvas.id).element("el-portal-solo")).toMatchObject({
      containerId: fixture.residentHome,
    });
    // Nothing was born, nothing destroyed, and the target never dipped empty.
    expect(fixture.store.listContainers()).toHaveLength(containersBefore);
    expect(composition.census().items.length).toBe(itemsBefore);
  });

  test("a NOTE cannot be displaced, and the refusal moves nothing", () => {
    const fixture = placementFixture();
    const noteTile = noteLeafId(fixture, fixture.composition.id);
    const before = occupants(fixture, fixture.composition.id);
    const containersBefore = fixture.store.listContainers().length;

    const outcome = fixture.placement.place({
      ref: { kind: "terminal", terminalId: fixture.loose },
      destination: {
        kind: "tile",
        containerId: fixture.composition.id,
        targetTileId: noteTile,
        edge: "center",
      },
    });

    // A note's element lives in this composition's own document, so there is nowhere to
    // put it and the exchange is refused BY NAME instead of deleting it.
    expect(ruleOrStatus(outcome)).toBe("denied:not_displaceable");
    if (outcome.status !== "denied") return;
    expect(outcome.denial).toEqual({
      rule: "not_displaceable",
      ref: { kind: "terminal", terminalId: fixture.loose },
      container: { kind: "composition", containerId: fixture.composition.id },
    });
    // Refused BEFORE anything moved: no leaf changed hands and no home was born.
    expect(occupants(fixture, fixture.composition.id)).toEqual(before);
    expect(fixture.store.listContainers()).toHaveLength(containersBefore);
    expect(roomFor(fixture, fixture.composition.id).element("el-text")).not.toBeNull();
    expect(homeOf(fixture, fixture.loose)).not.toBe(fixture.composition.id);
  });

  test("a carry that DOES hold a leaf still trades, so nothing is displaced", () => {
    const fixture = placementFixture();
    const occupied = terminalLeafId(fixture, fixture.composition.id, fixture.occupant);
    const foreignTile = containerLeafId(fixture, fixture.otherComposition.id, fixture.other.id);
    const containersBefore = fixture.store.listContainers().length;

    const outcome = fixture.placement.place({
      ref: { kind: "tile", containerId: fixture.otherComposition.id, tileId: foreignTile },
      destination: {
        kind: "tile",
        containerId: fixture.composition.id,
        targetTileId: occupied,
        edge: "center",
      },
    });

    expect(outcome.status).toBe("placed");
    if (outcome.status !== "placed") return;
    // The dispatch turns on what the GESTURE holds: a seated carry has a seat to give back,
    // so the two exchange and no composition is born to catch a displaced occupant.
    expect(outcome.result.op).toBe("swap");
    expect(fixture.store.listContainers()).toHaveLength(containersBefore);
    expect(homeOf(fixture, fixture.occupant)).toBe(fixture.otherComposition.id);
  });
});

describe("releasing a leaf re-homes its occupant", () => {
  test("a terminal leaf of a MULTI composition survives being unplaced", () => {
    const fixture = placementFixture();
    const occupied = terminalLeafId(fixture, fixture.composition.id, fixture.occupant);

    // The fullscreen route's tile-minimize, on the wire. It was refused `not_accepted`
    // before the leaf became `unplaceable`, so the button could only ever raise a notice.
    const outcome = fixture.placement.place({
      ref: { kind: "tile", containerId: fixture.composition.id, tileId: occupied },
      destination: { kind: "unplaced" },
    });

    expect(outcome.status).toBe("placed");
    if (outcome.status !== "placed") return;
    expect(outcome.result).toEqual({ op: "unplace", removed: 1 });
    // Re-homed, not reaped: releasing a leaf is subtractive about the PLACEMENT and says
    // nothing at all about the item.
    const home = homeOf(fixture, fixture.occupant);
    expect(home).not.toBe(fixture.composition.id);
    expect(fixture.broker.placedTerminal(fixture.occupant)).not.toBeNull();
    expect(fixture.store.getContainer(home)).toMatchObject({ discipline: "composition" });
    expect(roomFor(fixture, home).homesTerminal(fixture.occupant)).toBe(true);
    // The old container let the leaf go and survives on what it still holds.
    expect(roomFor(fixture, fixture.composition.id).homesTerminal(fixture.occupant)).toBe(false);
    expect(Object.keys(occupants(fixture, fixture.composition.id))).toHaveLength(1);
    expect(fixture.store.getContainer(fixture.composition.id)).not.toBeNull();
  });

  test("a leaf holding an embedded canvas releases the leaf and keeps the container", () => {
    const fixture = placementFixture();
    const embedded = containerLeafId(fixture, fixture.composition.id, fixture.spare.id);
    const containersBefore = fixture.store.listContainers().length;

    const outcome = fixture.placement.place({
      ref: { kind: "tile", containerId: fixture.composition.id, tileId: embedded },
      destination: { kind: "unplaced" },
    });

    expect(outcome.status).toBe("placed");
    if (outcome.status !== "placed") return;
    expect(outcome.result).toEqual({ op: "unplace", removed: 1 });
    // No home had to be born: the canvas already lives in the index on its own.
    expect(fixture.store.listContainers()).toHaveLength(containersBefore);
    expect(fixture.store.getContainer(fixture.spare.id)).not.toBeNull();
    expect(Object.keys(occupants(fixture, fixture.composition.id))).toHaveLength(1);
  });

  test("the ONLY leaf of a solo composition releases the composition, re-homing nothing", () => {
    const fixture = placementFixture();
    const leafId = terminalLeafId(fixture, fixture.residentHome, fixture.resident);
    const containersBefore = fixture.store.listContainers().length;

    const outcome = fixture.placement.place({
      ref: { kind: "tile", containerId: fixture.residentHome, tileId: leafId },
      destination: { kind: "unplaced" },
    });

    expect(outcome.status).toBe("placed");
    if (outcome.status !== "placed") return;
    // A composition of ONE is that item, so its portal is the reference that goes — the
    // terminal stays exactly where it lives and no second home is invented for it.
    expect(outcome.result).toEqual({ op: "unplace", removed: 1 });
    expect(homeOf(fixture, fixture.resident)).toBe(fixture.residentHome);
    expect(fixture.store.listContainers()).toHaveLength(containersBefore);
    expect(roomFor(fixture, fixture.canvas.id).element("el-portal-solo")).toBeNull();
  });

  test("a NOTE leaf is refused by the same rule a displacement is", () => {
    const fixture = placementFixture();
    const noteTile = noteLeafId(fixture, fixture.composition.id);
    const before = occupants(fixture, fixture.composition.id);

    const outcome = fixture.placement.place({
      ref: { kind: "tile", containerId: fixture.composition.id, tileId: noteTile },
      destination: { kind: "unplaced" },
    });

    // Releasing a note's leaf would strand its element, which is the one thing re-homing
    // cannot do for it, so both doors answer with the same named refusal.
    expect(ruleOrStatus(outcome)).toBe("denied:not_displaceable");
    expect(occupants(fixture, fixture.composition.id)).toEqual(before);
  });
});

/**
 * THE PLACEMENT DOOR (ADR 0013 §14). The algebra is mechanism and stays floor; the verb is
 * `core.space.place`, so placing a thing answers through the same published vocabulary,
 * capability declaration and denial ladder as every other mutation. There is no
 * `POST /api/place` any more, and these cases are the old route's cases carried over rung by
 * rung — same caps, same refusals, same results — which is what makes this a move rather
 * than a rewrite.
 */
describe("core.space.place", () => {
  const dispatch = async (
    fixture: PlacementFixture,
    token: string,
    args: unknown,
    action = "core.space.place",
  ): Promise<ActionOutcome> => {
    const response = await call(fixture, "POST", `/api/actions/${action}`, token, args);
    // Every rung answers 200: a refusal is DATA, never a transport failure.
    expect(response.status).toBe(200);
    return ActionOutcomeSchema.parse(response.payload);
  };

  test("serves the op-tagged result for every executed placement", async () => {
    const fixture = placementFixture();
    const portaled = await dispatch(fixture, OWNER_KEY, {
      ref: { kind: "terminal", terminalId: fixture.loose },
      destination: { kind: "canvas", containerId: fixture.canvas.id, x: 44, y: 55 },
    });
    expect(portaled.ok).toBe(true);
    if (!portaled.ok) throw new Error("portal expected");
    const result = PlaceResponseSchema.parse(portaled.result);
    expect(result.op).toBe("portal");
    if (result.op !== "portal") throw new Error("portal response expected");
    const looseHome = homeOf(fixture, fixture.loose);
    // A canvas holds a REFERENCE to the composition the terminal lives in; the element kind
    // that carried a terminal id does not exist any more.
    expect(roomFor(fixture, fixture.canvas.id).element(result.elementId)).toMatchObject({
      type: "portal",
      containerId: looseHome,
      x: 44,
      y: 55,
    });

    const unplaced = await dispatch(fixture, OWNER_KEY, {
      ref: { kind: "element", containerId: fixture.canvas.id, elementId: result.elementId },
      destination: { kind: "unplaced" },
    });
    expect(unplaced.ok).toBe(true);
    if (!unplaced.ok) throw new Error("unplace expected");
    // The op reports HOW MANY references it removed; the terminal itself never moved.
    expect(PlaceResponseSchema.parse(unplaced.result)).toEqual({ op: "unplace", removed: 1 });
    expect(homeOf(fixture, fixture.loose)).toBe(looseHome);
    expect(fixture.store.getContainer(looseHome)).not.toBeNull();
  });

  test("an unplace that removes nothing is a success carrying zero, not a refusal", async () => {
    const fixture = placementFixture();

    const outcome = await dispatch(fixture, OWNER_KEY, {
      ref: { kind: "terminal", terminalId: fixture.loose },
      destination: { kind: "unplaced" },
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(PlaceResponseSchema.parse(outcome.result)).toEqual({ op: "unplace", removed: 0 });
  });

  /**
   * THE DENIAL ROUND TRIP. The `refused` rung carries one string, so the string leads with
   * the algebra's own rule and the caller rebuilds the denial it was sent: it holds the ref
   * (it sent it) and derives the container from the destination. That is exactly what
   * `client.place()` does, which is why `not_accepted` has one wording on the wire.
   */
  test("a refused placement carries the algebra's rule, and rebuilds into the same denial", async () => {
    const fixture = placementFixture();
    const ref: PlacementRef = { kind: "container", containerId: fixture.otherComposition.id };
    const destination: PlacementDestination = {
      kind: "tile",
      containerId: fixture.composition.id,
      targetTileId: null,
      edge: null,
    };

    const outcome = await dispatch(fixture, OWNER_KEY, { ref, destination });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.denial.rule).toBe("refused");
    // Compositions merge, never nest — and the rule the algebra named survives the rung.
    const rule = placementRefusalRule(outcome.denial.message);
    expect(rule).toBe("not_solo");
    if (rule === null) return;
    const rebuilt: PlacementDenial = {
      rule,
      ref,
      container: placementContainerFor(destination),
    };
    const predicted = resolvePlacement(ref, destination, lookupFor(fixture));
    expect(predicted.ok).toBe(false);
    if (predicted.ok) return;
    expect(rebuilt).toEqual(predicted.denial);
  });

  test("every refusal the algebra can name reaches the caller by name", async () => {
    const fixture = placementFixture();
    const cases: readonly { readonly args: unknown; readonly rule: string }[] = [
      {
        args: {
          ref: { kind: "container", containerId: fixture.canvas.id },
          destination: { kind: "canvas", containerId: fixture.canvas.id, x: 0, y: 0 },
        },
        rule: "self_embed",
      },
      {
        args: {
          ref: { kind: "terminal", terminalId: fixture.loose },
          destination: { kind: "canvas", containerId: fixture.composition.id, x: 0, y: 0 },
        },
        rule: "discipline",
      },
      {
        args: {
          ref: { kind: "terminal", terminalId: fixture.loose },
          destination: { kind: "tile", containerId: "ghost", targetTileId: null, edge: null },
        },
        rule: "unknown_container",
      },
      {
        args: {
          ref: { kind: "terminal", terminalId: "ghost" },
          destination: { kind: "unplaced" },
        },
        rule: "unknown_ref",
      },
    ];
    const seen: string[] = [];
    for (const { args } of cases) {
      const outcome = await dispatch(fixture, OWNER_KEY, args);
      if (outcome.ok) throw new Error("refusal expected");
      expect(outcome.denial.rule).toBe("refused");
      seen.push(placementRefusalRule(outcome.denial.message) ?? "unnamed");
    }
    expect(seen).toEqual(cases.map((entry) => entry.rule));
  });

  test("a legal placement that cannot be carried out refuses by the failure's name", async () => {
    const fixture = placementFixture();

    const outcome = await dispatch(fixture, OWNER_KEY, {
      ref: { kind: "tile", containerId: fixture.composition.id, tileId: "t99" },
      destination: { kind: "canvas", containerId: fixture.canvas.id, x: 0, y: 0 },
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // Not a statement about what composes, so NOT a placement rule: a caller reading the
    // class learns this was operational, and `client.place()` throws on it exactly as it
    // threw on the 404 this replaces.
    expect(outcome.denial.rule).toBe("refused");
    expect(outcome.denial.message).toBe("not_found: placement ref or container not found");
    expect(placementRefusalRule(outcome.denial.message)).toBeNull();
  });

  /**
   * THE FUSION, THROUGH THE DOOR (ADR 0013 §12). Neither `text` nor `draw` has a row in
   * `ITEM_KINDS`: their traits are manifest data resolved onto the assembly, and the
   * resolver reads them from there. So these two placements prove a contributed element kind
   * places — one by traits its plugin declared (`text` is `tileable`), one by the engine's
   * default for a contribution that declares none (`draw` is canvas furniture).
   */
  test("a contributed element kind places by the traits its manifest declared", async () => {
    const fixture = placementFixture();
    const contributed = rosterElementTraits(fixture.plugins.roster());
    expect(Object.keys(ITEM_KINDS)).not.toContain("text");
    expect(Object.keys(ITEM_KINDS)).not.toContain("draw");
    expect(contributed.get("text")?.groups).toContain("tileable");
    expect(contributed.get("draw")).toEqual(DEFAULT_ELEMENT_PLACEMENT_TRAITS);

    const added = await dispatch(fixture, OWNER_KEY, {
      ref: { kind: "element", containerId: fixture.canvas.id, elementId: "el-text" },
      destination: {
        kind: "tile",
        containerId: fixture.composition.id,
        targetTileId: null,
        edge: null,
      },
    });
    expect(added.ok).toBe(true);
    if (!added.ok) throw new Error("add_tile expected");
    expect(PlaceResponseSchema.parse(added.result).op).toBe("add_tile");

    const moved = await dispatch(fixture, OWNER_KEY, {
      ref: { kind: "element", containerId: fixture.canvas.id, elementId: "el-draw" },
      destination: { kind: "canvas", containerId: fixture.other.id, x: 12, y: 34 },
    });
    expect(moved.ok).toBe(true);
    if (!moved.ok) throw new Error("move_element expected");
    const result = PlaceResponseSchema.parse(moved.result);
    expect(result.op).toBe("move_element");
    if (result.op !== "move_element") return;
    expect(roomFor(fixture, fixture.other.id).element(result.elementId)).toMatchObject({
      type: "draw",
      x: 12,
      y: 34,
    });
  });

  test("the whole ladder, in order: unknown, disabled, scope, caps, args, then the handler", async () => {
    const fixture = placementFixture();
    const legal = {
      ref: { kind: "terminal", terminalId: fixture.loose },
      destination: { kind: "canvas", containerId: fixture.canvas.id, x: 0, y: 0 },
    };

    const unknown = await dispatch(fixture, OWNER_KEY, legal, "core.space.plaice");
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.denial.rule).toBe("unknown_action");

    // A container-scoped token is refused for its SCOPE before any cap is considered — the
    // exact gate the deleted route carried, now one rung of the shared ladder (D11).
    const scoped = fixture.auth.mintToken(
      {
        principal: { name: "container guest", kind: "human" },
        caps: ["containers:read", "containers:write", "scenes:write"],
        containerId: fixture.canvas.id,
      },
      fixture.root,
    ).token;
    const scopedPlace = await dispatch(fixture, scoped, legal);
    expect(scopedPlace.ok).toBe(false);
    if (!scopedPlace.ok) {
      expect(scopedPlace.denial.rule).toBe("forbidden");
      expect(scopedPlace.denial.message).toBe("scoped tokens cannot invoke workspace actions");
    }

    // `containers:write` is the cap the route required, declared by the action now.
    const readOnly = fixture.auth.mintToken(
      { principal: { name: "reader", kind: "human" }, caps: ["containers:read"] },
      fixture.root,
    ).token;
    const readOnlyPlace = await dispatch(fixture, readOnly, legal);
    expect(readOnlyPlace.ok).toBe(false);
    if (!readOnlyPlace.ok) {
      expect(readOnlyPlace.denial.rule).toBe("forbidden");
      expect(readOnlyPlace.denial.message).toBe("containers:write capability required");
    }

    const malformed = await dispatch(fixture, OWNER_KEY, {
      ref: { kind: "terminal", terminalId: fixture.loose },
      destination: { kind: "canvas", containerId: fixture.canvas.id },
    });
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.denial.rule).toBe("invalid_args");

    // A retired destination kind is an argument rejection, not a rule: `pool` is not a place
    // the algebra can refuse by name any more, it is a word the wire no longer knows.
    const retired = await dispatch(fixture, OWNER_KEY, {
      ref: { kind: "terminal", terminalId: fixture.loose },
      destination: { kind: "pool", index: 0 },
    });
    expect(retired.ok).toBe(false);
    if (!retired.ok) expect(retired.denial.rule).toBe("invalid_args");

    // Nothing above the handler's rung wrote anything.
    expect(readElements(roomFor(fixture, fixture.canvas.id).doc).size).toBe(5);

    // And with the plugin off, the door is gone rather than silent: a disabled plugin's
    // action reports `plugin_disabled`, which is a different truth from a wrong name.
    const disabled = await dispatch(
      fixture,
      OWNER_KEY,
      { id: "core.space", enabled: false },
      "engine.plugins.setEnabled",
    );
    expect(disabled.ok).toBe(true);
    const afterDisable = await dispatch(fixture, OWNER_KEY, legal);
    expect(afterDisable.ok).toBe(false);
    if (!afterDisable.ok) expect(afterDisable.denial.rule).toBe("plugin_disabled");
  });
});
