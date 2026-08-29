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
  resolvePlacement,
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
  tileLeafIds,
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
import { FakeClock, FakeRuntime, FakeSocket, parkSession, testStore } from "./helpers.ts";

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
 * One world, shaped so that EVERY declared item kind and destination has a real subject:
 * a canvas holding one of each element shape, a second canvas to reference, a tiled view
 * with an occupant, and a pooled terminal. The matrix below then exercises the algebra
 * against live server state rather than against a mock.
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
  /** Canvas under test; holds `el-term`, `el-text`, `el-draw` and both portals. */
  canvas: Pad;
  /** A different canvas, referenced as a portal and tiled as a surface. */
  other: Pad;
  /** A tiled container born from `canvas`, so extraction has a return address. */
  view: Pad;
  /** Session placed on `canvas` as `el-term`. */
  resident: string;
  /** Session in the pool, bound to nothing. */
  pooled: string;
  /** Session occupying the view's only leaf. */
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
  if (overrides.type === "terminal") {
    return { ...base, ...overrides, type: "terminal", sessionId: overrides.sessionId ?? "" };
  }
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
  const canvas: Pad = {
    id: runtime.newId(),
    name: "canvas",
    createdAt: runtime.now(),
    layout: "canvas",
    transient: false,
  };
  const other: Pad = { ...canvas, id: runtime.newId(), name: "other" };
  store.createPad(canvas);
  store.createPad(other);
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
  rooms.setEmptyHandler((padId) => placement.dissolveIfBubble(padId));
  const machines = new MachineGateway(
    auth,
    store,
    broker,
    clock,
    silentLogger,
    "server-epoch",
    runtime,
  );
  const enrollment = auth.enrollMachine("placement machine", root);
  const machine = new FakeMachine(enrollment.machine.id);
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
  const fixture: PlacementFixture = {
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
    // Filled in below; the view is created through the same path an expand uses so it
    // carries a return address.
    view: canvas,
    resident: "",
    pooled: "",
    occupant: "",
  };

  const resident = openSession(fixture);
  writeElement(
    room(fixture, canvas.id).doc,
    element({ id: "el-term", type: "terminal", sessionId: resident }),
    LOCAL_ORIGIN,
  );
  const occupant = openSession(fixture);
  writeElement(
    room(fixture, canvas.id).doc,
    element({ id: "el-occupant", type: "terminal", sessionId: occupant }),
    LOCAL_ORIGIN,
  );
  const expanded = broker.expand(occupant);
  if (typeof expanded === "string") throw new Error(`expand failed: ${expanded}`);
  const pooled = openSession(fixture);
  writeElement(
    room(fixture, canvas.id).doc,
    element({ id: "el-pooled", type: "terminal", sessionId: pooled }),
    LOCAL_ORIGIN,
  );
  if (parkSession(placement, canvas.id, "el-pooled") !== "ok") throw new Error("park failed");
  writeElement(
    room(fixture, canvas.id).doc,
    element({ id: "el-text", type: "text" }),
    LOCAL_ORIGIN,
  );
  writeElement(
    room(fixture, canvas.id).doc,
    element({ id: "el-draw", type: "draw" }),
    LOCAL_ORIGIN,
  );
  writeElement(
    room(fixture, canvas.id).doc,
    element({ id: "el-portal-canvas", type: "portal", containerId: other.id }),
    LOCAL_ORIGIN,
  );
  writeElement(
    room(fixture, canvas.id).doc,
    element({ id: "el-portal-view", type: "portal", containerId: expanded.viewId }),
    LOCAL_ORIGIN,
  );
  const view = store.getPad(expanded.viewId);
  if (view === null) throw new Error("missing view row");
  return { ...fixture, view, resident, pooled, occupant };
}

/** Opens one terminal and commits its create, returning the new session id. */
function openSession(fixture: PlacementFixture): string {
  fixture.broker.open(fixture.opener, {
    type: "terminal_open",
    elementId: `open-${fixture.machine.sent.length}`,
    cols: 80,
    rows: 24,
  });
  const create = fixture.machine.sent.filter((message) => message.type === "create").at(-1);
  if (create === undefined || create.type !== "create") throw new Error("missing create request");
  fixture.broker.onCreated(fixture.machine.machineId, create.sessionId);
  return create.sessionId;
}

function room(fixture: PlacementFixture, padId: string): Room {
  const found = fixture.rooms.get(padId);
  if (found === null) throw new Error(`missing room ${padId}`);
  return found;
}

function soleLeafId(fixture: PlacementFixture, padId: string): string {
  const leaves = tileLeafIds(room(fixture, padId).tileLayout() ?? {});
  const leafId = leaves[0];
  if (leafId === undefined) throw new Error(`no leaves in ${padId}`);
  return leafId;
}

/**
 * The SAME two questions the executor asks its store, asked here from the test's side.
 * `PlacementLookup` being pure is what lets this file predict the executor's answer without
 * reaching into it — and what lets the browser predict it during a drag.
 */
function lookupFor(fixture: PlacementFixture): PlacementLookup {
  return {
    padLayout: (padId) => fixture.store.getPad(padId)?.layout ?? null,
    elementItem: (padId, elementId): PlacementItem | null => {
      const found = fixture.rooms.get(padId)?.element(elementId) ?? null;
      if (found === null) return null;
      if (found.type === "terminal") return { kind: "terminal", containerId: null };
      if (found.type === "portal") {
        const layout = fixture.store.getPad(found.containerId)?.layout ?? null;
        if (layout === null) return null;
        return {
          kind: layout === "canvas" ? "canvas-pad" : "view",
          containerId: found.containerId,
        };
      }
      return { kind: found.type, containerId: null };
    },
  };
}

function surfaces(fixture: PlacementFixture): Readonly<Record<ItemKind, PlacementSurface>> {
  return {
    terminal: { kind: "terminal", sessionId: fixture.pooled },
    "canvas-pad": { kind: "pad", padId: fixture.other.id },
    view: { kind: "pad", padId: fixture.view.id },
    text: { kind: "element", padId: fixture.canvas.id, elementId: "el-text" },
    draw: { kind: "element", padId: fixture.canvas.id, elementId: "el-draw" },
    tile: {
      kind: "tile",
      containerId: fixture.view.id,
      tileId: soleLeafId(fixture, fixture.view.id),
    },
  };
}

function destinations(
  fixture: PlacementFixture,
): Readonly<Record<DestinationKind, PlacementDestination>> {
  return {
    canvas: { kind: "canvas", padId: fixture.canvas.id, x: 320, y: 240 },
    tile: { kind: "tile", padId: fixture.view.id, targetTileId: null, edge: null },
    compose: {
      kind: "compose",
      padId: fixture.canvas.id,
      targetElementId: "el-term",
      edge: "right",
    },
    pool: { kind: "pool" },
  };
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
      "terminal -> canvas=bind",
      "terminal -> tile=add_tile",
      "terminal -> compose=compose",
      "terminal -> pool=park",
      "canvas-pad -> canvas=portal",
      "canvas-pad -> tile=add_tile",
      "canvas-pad -> compose=compose",
      "canvas-pad -> pool=denied:not_accepted",
      "view -> canvas=portal",
      "view -> tile=denied:not_accepted",
      "view -> compose=denied:not_accepted",
      "view -> pool=denied:not_accepted",
      "text -> canvas=move_element",
      // A note is tileable now: `TileSurface` carries a `text` form, so a note joins a
      // composition as a leaf and composes a view around a terminal like any other surface.
      "text -> tile=add_tile",
      "text -> compose=compose",
      "text -> pool=denied:not_accepted",
      "draw -> canvas=move_element",
      "draw -> tile=denied:not_accepted",
      "draw -> compose=denied:not_accepted",
      "draw -> pool=denied:not_accepted",
      "tile -> canvas=extract",
      "tile -> tile=denied:not_accepted",
      "tile -> compose=denied:not_accepted",
      "tile -> pool=denied:not_accepted",
    ]);
  });

  test("the current location comes from identity, never from the caller", () => {
    const fixture = placementFixture();
    // The occupant lives in the view (its expand rebound it); nothing in the request says
    // so, and the request cannot claim otherwise.
    const outcome = fixture.placement.place({
      surface: { kind: "terminal", sessionId: fixture.occupant },
      destination: { kind: "canvas", padId: fixture.other.id, x: 12, y: 34 },
    });
    expect(outcome.status).toBe("placed");
    expect(tileLeafIds(room(fixture, fixture.view.id).tileLayout() ?? {})).toHaveLength(1);
    expect(room(fixture, fixture.view.id).referencesSession(fixture.occupant)).toBe(false);
    expect(fixture.store.getSession(fixture.occupant)?.padId).toBe(fixture.other.id);
    const placed = [...readElements(room(fixture, fixture.other.id).doc).values()];
    expect(placed).toHaveLength(1);
    expect(placed[0]).toMatchObject({
      type: "terminal",
      sessionId: fixture.occupant,
      x: 12,
      y: 34,
    });
  });

  test("an id that names nothing fails instead of quietly doing nothing", () => {
    const fixture = placementFixture();
    const unknownSession = fixture.placement.place({
      surface: { kind: "terminal", sessionId: "ghost" },
      destination: { kind: "canvas", padId: fixture.canvas.id, x: 0, y: 0 },
    });
    const unknownTile = fixture.placement.place({
      surface: { kind: "tile", containerId: fixture.view.id, tileId: "t99" },
      destination: { kind: "canvas", padId: fixture.canvas.id, x: 0, y: 0 },
    });
    const unknownElement = fixture.placement.place({
      surface: { kind: "element", padId: fixture.canvas.id, elementId: "ghost" },
      destination: { kind: "pool" },
    });
    expect([unknownSession, unknownTile].map((outcome) => outcome.status)).toEqual([
      "failed",
      "failed",
    ]);
    // An element that does not exist places nothing at all, so the algebra itself refuses:
    // the lookup answers null and the denial names the surface.
    expect(unknownElement.status).toBe("denied");
    if (unknownElement.status === "denied") {
      expect(unknownElement.denial.rule).toBe("unknown_surface");
    }
  });
});

describe("POST /api/place", () => {
  test("serves the op-tagged result for every executed placement", async () => {
    const fixture = placementFixture();
    const bound = await call(fixture, "POST", "/api/place", OWNER_KEY, {
      surface: { kind: "terminal", sessionId: fixture.pooled },
      destination: { kind: "canvas", padId: fixture.canvas.id, x: 44, y: 55 },
    });
    expect(bound.status).toBe(200);
    const result = PlaceResponseSchema.parse(bound.payload);
    expect(result.op).toBe("bind");
    if (result.op !== "bind") throw new Error("bind response expected");
    expect(room(fixture, fixture.canvas.id).element(result.elementId)).toMatchObject({
      type: "terminal",
      sessionId: fixture.pooled,
      x: 44,
      y: 55,
    });

    const parked = await call(fixture, "POST", "/api/place", OWNER_KEY, {
      surface: { kind: "element", padId: fixture.canvas.id, elementId: result.elementId },
      destination: { kind: "pool", index: 0 },
    });
    expect(parked.status).toBe(200);
    expect(PlaceResponseSchema.parse(parked.payload)).toEqual({ op: "park" });
    expect(fixture.store.getSession(fixture.pooled)?.padId).toBeNull();
  });

  test("serves a denial as data: 409 with the rule that refused it", async () => {
    const fixture = placementFixture();
    const nested = await call(fixture, "POST", "/api/place", OWNER_KEY, {
      surface: { kind: "pad", padId: fixture.view.id },
      destination: { kind: "tile", padId: fixture.view.id, targetTileId: null, edge: null },
    });
    expect(nested.status).toBe(409);
    const denied = PlacementDeniedResponseSchema.parse(nested.payload);
    expect(denied.error.code).toBe(PLACEMENT_DENIED_CODE);
    // Views never nest, and the wire says WHY in a machine-readable way.
    expect(denied.error.denial).toEqual({
      rule: "not_accepted",
      surface: { kind: "pad", padId: fixture.view.id },
      container: { kind: "view", padId: fixture.view.id },
    });

    const selfEmbed = await call(fixture, "POST", "/api/place", OWNER_KEY, {
      surface: { kind: "pad", padId: fixture.canvas.id },
      destination: { kind: "canvas", padId: fixture.canvas.id, x: 0, y: 0 },
    });
    const discipline = await call(fixture, "POST", "/api/place", OWNER_KEY, {
      surface: { kind: "terminal", sessionId: fixture.pooled },
      destination: { kind: "canvas", padId: fixture.view.id, x: 0, y: 0 },
    });
    const unknownContainer = await call(fixture, "POST", "/api/place", OWNER_KEY, {
      surface: { kind: "terminal", sessionId: fixture.pooled },
      destination: { kind: "tile", padId: "ghost", targetTileId: null, edge: null },
    });
    expect([selfEmbed.status, discipline.status, unknownContainer.status]).toEqual([409, 409, 409]);
    expect(
      [selfEmbed, discipline, unknownContainer].map(
        (response) => PlacementDeniedResponseSchema.parse(response.payload).error.denial.rule,
      ),
    ).toEqual(["self_embed", "discipline", "unknown_container"]);
  });

  test("rejects malformed envelopes and tokens that cannot place", async () => {
    const fixture = placementFixture();
    const malformed = await call(fixture, "POST", "/api/place", OWNER_KEY, {
      surface: { kind: "terminal", sessionId: fixture.pooled },
      destination: { kind: "canvas", padId: fixture.canvas.id },
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
      surface: { kind: "terminal", sessionId: fixture.pooled },
      destination: { kind: "canvas", padId: fixture.canvas.id, x: 0, y: 0 },
    });
    const readOnly = fixture.auth.mintToken(
      { principal: { name: "reader", kind: "human" }, caps: ["pads:read"] },
      fixture.root,
    ).token;
    const readOnlyPlace = await call(fixture, "POST", "/api/place", readOnly, {
      surface: { kind: "terminal", sessionId: fixture.pooled },
      destination: { kind: "canvas", padId: fixture.canvas.id, x: 0, y: 0 },
    });
    expect([malformed.status, scopedPlace.status, readOnlyPlace.status]).toEqual([400, 403, 403]);
  });
});
