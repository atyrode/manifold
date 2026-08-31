import { describe, expect, test } from "bun:test";
import {
  CANVAS_OPS,
  CONTAINER_KINDS,
  DEFAULT_ELEMENT_PLACEMENT_TRAITS,
  DESTINATION_KINDS,
  DESTINATION_OPS,
  EXECUTION_ONLY_OPS,
  HOMING_MODES,
  ITEM_GUARD_NAMES,
  ITEM_KINDS,
  PLACEMENT_DENIAL_RULES,
  PLACEMENT_GROUPS,
  PLACEMENT_GUARDS,
  PLACEMENT_OPS,
  PlaceRequestSchema,
  PlaceResponseSchema,
  PlacementDenialSchema,
  PlacementDestinationSchema,
  PlacementSurfaceSchema,
  PlacementTraitsSchema,
  buildProtocolJsonSchema,
  canvasOpFor,
  itemTraitsFor,
  placementItemFor,
  placementRefusal,
  placementRefusalRule,
  resolvePlacement,
  type ContainerLayout,
  type DestinationKind,
  type ItemKind,
  type PlaceResponse,
  type PlacementDenialRule,
  type PlacementDestination,
  type PlacementItem,
  type PlacementLookup,
  type PlacementOp,
  type PlacementSurface,
  type PlacementTraits,
} from "@manifold/protocol";

/**
 * One small world, shared by every case: two canvases, a SOLO composition holding a
 * terminal, and two multi-tile compositions — two because "a composition into a different
 * composition" is a distinct answer from "a composition into itself", and one pad cannot
 * play both. The lookup is the whole state interface, so these maps are exactly what the
 * server's store and the browser's doc supply in production.
 */
const PAD_LAYOUTS: Readonly<Record<string, ContainerLayout>> = {
  "canvas-1": "canvas",
  "canvas-2": "canvas",
  "solo-1": "tiled",
  "multi-1": "tiled",
  "multi-2": "tiled",
};

/** Every terminal lives in a composition from birth, so nothing else answers here. */
const TERMINAL_HOMES: Readonly<Record<string, string>> = { "session-1": "solo-1" };

/** What a composition holds when it holds exactly one item; multi-tile pads are absent. */
const SOLO_OCCUPANTS: Readonly<Record<string, PlacementItem>> = {
  "solo-1": { kind: "terminal", containerId: "solo-1" },
};

/**
 * The elements of `canvas-1`. There is no terminal element: a canvas references a terminal
 * through a portal onto the composition it lives in, which is why the terminal's row here
 * is a portal whose container is `solo-1`.
 */
const ELEMENTS: Readonly<Record<string, PlacementItem>> = {
  "el-text": { kind: "text", containerId: null },
  "el-draw": { kind: "draw", containerId: null },
  "el-portal-solo": { kind: "view", containerId: "solo-1" },
  "el-portal-multi": { kind: "view", containerId: "multi-2" },
  "el-portal-canvas": { kind: "canvas-pad", containerId: "canvas-2" },
  /**
   * A panel item, reachable in this world only because the lookup says so: no wire SURFACE
   * form names a panel (workspace layouts are written whole by `core.layout.set`), and the
   * matrix still has to be able to ask the algebra what a panel does at every door.
   */
  "el-panel": { kind: "panel", containerId: null },
};

/**
 * The COMPOSED half of the algebra's vocabulary: the element kinds this world's plugins
 * contribute, with the traits their manifests declare (ADR 0013 §12). `text` is
 * `core.notes` declaring its own; `draw` is `core.draw` declaring nothing and taking the
 * engine's default; `chart` is nobody — a kind sitting in a document whose plugin is not in
 * this build.
 *
 * The floor table knows none of these names, which is the whole point: the matrix below
 * exercises contributed kinds through the same resolution floor kinds go through.
 */
const CONTRIBUTED_TRAITS: Readonly<Record<string, PlacementTraits>> = {
  text: { groups: ["tileable", "canvas-item"], guards: [], homed: "on-claim" },
  draw: DEFAULT_ELEMENT_PLACEMENT_TRAITS,
};

/** Every kind this world can place: the floor's own, plus what its plugins contribute. */
type WorldKind = ItemKind | "text" | "draw";

const lookup: PlacementLookup = {
  padLayout: (padId) => PAD_LAYOUTS[padId] ?? null,
  elementItem: (padId, elementId) =>
    PAD_LAYOUTS[padId] === undefined ? null : (ELEMENTS[elementId] ?? null),
  terminalHome: (sessionId) => TERMINAL_HOMES[sessionId] ?? null,
  soloOccupant: (padId) => SOLO_OCCUPANTS[padId] ?? null,
  itemTraits: (kind) => CONTRIBUTED_TRAITS[kind] ?? null,
};

/**
 * One surface per declared item kind. `Record<ItemKind, …>` is the point: adding an item
 * kind fails to compile until the matrix can exercise it. The `view` surface names a
 * MULTI-tile composition because a solo one is classified as its occupant instead — that
 * reclassification is what the focused tests below cover.
 */
const SURFACES: Readonly<Record<WorldKind, PlacementSurface>> = {
  terminal: { kind: "terminal", sessionId: "session-1" },
  "canvas-pad": { kind: "pad", padId: "canvas-2" },
  view: { kind: "pad", padId: "multi-2" },
  text: { kind: "element", padId: "canvas-1", elementId: "el-text" },
  draw: { kind: "element", padId: "canvas-1", elementId: "el-draw" },
  tile: { kind: "tile", containerId: "multi-1", tileId: "t1" },
  panel: { kind: "element", padId: "canvas-1", elementId: "el-panel" },
};

/** One destination per declared form, each aimed at a container the item is not. */
const DESTINATIONS: Readonly<Record<DestinationKind, PlacementDestination>> = {
  canvas: { kind: "canvas", padId: "canvas-1", x: 40, y: 80 },
  tile: { kind: "tile", padId: "multi-1", targetTileId: null, edge: null },
  compose: { kind: "compose", padId: "canvas-1", targetElementId: "el-portal-solo", edge: "right" },
  unplaced: { kind: "unplaced" },
};

/**
 * The golden algebra: what every declared item kind does at every declared destination.
 * The PAIRS are enumerated from the declarations below — this table only records the
 * expected answer, and a new kind or destination cannot compile without one.
 */
const MATRIX: Readonly<Record<WorldKind, Readonly<Record<DestinationKind, string>>>> = {
  // A terminal on a canvas is a PORTAL onto its home, never an element carrying the
  // session, and releasing it is `unplace` because there is no pool left to park in.
  terminal: { canvas: "portal", tile: "add_tile", compose: "compose", unplaced: "unplace" },
  "canvas-pad": {
    canvas: "portal",
    tile: "add_tile",
    compose: "compose",
    unplaced: "unplace",
  },
  // Compositions merge, never nest — and merging is the SOLO case, which never arrives here
  // as a `view` because it was reclassified as its occupant. So a composition still
  // reaching a composition holds several items or none, and `not_solo` names that refusal.
  view: {
    canvas: "portal",
    tile: "not_solo",
    compose: "not_solo",
    unplaced: "unplace",
  },
  // A note tiles: a composition owns the note's element in its own document, which is why
  // the surface form names an element id and not a cross-container pair. It is not
  // unplaceable, because until it is claimed its element IS its only existence.
  text: {
    canvas: "move_element",
    tile: "add_tile",
    compose: "compose",
    unplaced: "not_accepted",
  },
  // Ink stays canvas-only: a stroke is positioned in canvas coordinates, and a tile has
  // none to give it.
  draw: {
    canvas: "move_element",
    tile: "not_accepted",
    compose: "not_accepted",
    unplaced: "not_accepted",
  },
  /*
    A leaf is a re-placeable PLACEMENT, not a one-way trip onto a canvas. Both composition
    cells were `not_accepted` until the center-swap work, and the operator approved the
    flip: a denied `tile -> tile` made rearranging a composition by dragging impossible,
    which contradicts the one-grammar-everywhere rule the rest of the model is built on. An
    edge MOVES the leaf, the exact spot of an occupied leaf EXCHANGES the two, and the
    canvas door still extracts.

    `unplaced` flipped from `not_accepted` for the same reason, and it fixes a DEAD
    affordance: the fullscreen route's tile-minimize button sends exactly
    `{kind:"tile"} -> {kind:"unplaced"}`, which was refused here, so the button could only
    ever raise a toast. Unplacing a leaf re-homes its occupant — a terminal into a fresh
    solo composition — instead of destroying it, so "nowhere" is a place a leaf can go.
   */
  tile: {
    canvas: "extract",
    tile: "add_tile",
    compose: "compose",
    unplaced: "unplace",
  },
  /*
    A panel is `tileable` and nothing else: it composes into a tiled container (that is what
    the workspace shell IS) and a canvas refuses it by GROUP CONTAINMENT — `not_accepted`,
    decided before any op is consulted, which is why `CANVAS_OPS.panel` is unreachable
    bookkeeping rather than a rule. `unplaced` refuses it too: a panel is a rendering of a
    plugin contribution, so there is no object to leave lying around.
   */
  panel: {
    canvas: "not_accepted",
    tile: "add_tile",
    compose: "compose",
    unplaced: "not_accepted",
  },
};

const itemKinds = Object.keys(ITEM_KINDS) as ItemKind[];
const worldKinds = [...itemKinds, ...Object.keys(CONTRIBUTED_TRAITS)] as WorldKind[];
const destinationKinds = Object.keys(DESTINATION_KINDS) as DestinationKind[];
const ops: readonly string[] = PLACEMENT_OPS;
const denialRules: readonly string[] = PLACEMENT_DENIAL_RULES;

describe("placement matrix", () => {
  test("every declared item kind x destination resolves to an op or a named denial", () => {
    const seen: string[] = [];
    for (const itemKind of worldKinds) {
      for (const destinationKind of destinationKinds) {
        const label = `${itemKind} -> ${destinationKind}`;
        seen.push(label);
        const expected = MATRIX[itemKind][destinationKind];
        const result = resolvePlacement(SURFACES[itemKind], DESTINATIONS[destinationKind], lookup);
        if (result.ok) {
          expect(ops).toContain(result.op);
          expect(`${label}=${result.op}`).toBe(`${label}=${expected}`);
          expect(result.item.kind).toBe(itemKind);
        } else {
          expect(denialRules).toContain(result.denial.rule);
          expect(`${label}=${result.denial.rule}`).toBe(`${label}=${expected}`);
          expect(PlacementDenialSchema.safeParse(result.denial).success).toBe(true);
        }
      }
    }
    // Exhaustive by construction: the declarations, not this file, decide the pair count.
    expect(seen).toHaveLength(worldKinds.length * destinationKinds.length);
    expect(seen.length).toBeGreaterThan(0);
  });

  test("acceptance follows group containment, so the table cannot drift from declarations", () => {
    for (const itemKind of worldKinds) {
      for (const destinationKind of destinationKinds) {
        const container = DESTINATION_KINDS[destinationKind].container;
        const accepts: readonly string[] = CONTAINER_KINDS[container].accepts;
        const overlaps = (itemTraitsFor(itemKind, lookup).groups as readonly string[]).some(
          (group) => accepts.includes(group),
        );
        const result = resolvePlacement(SURFACES[itemKind], DESTINATIONS[destinationKind], lookup);
        const refusedByContainment = !result.ok && result.denial.rule === "not_accepted";
        expect(`${itemKind}/${destinationKind}:${refusedByContainment}`).toBe(
          `${itemKind}/${destinationKind}:${!overlaps}`,
        );
      }
    }
  });

  test("a panel is refused by a canvas through containment, before any op is consulted", () => {
    const result = resolvePlacement(SURFACES.panel, DESTINATIONS.canvas, lookup);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // `not_accepted` and nothing else: a panel carries only `tileable`, and a canvas takes
    // none of the groups it would need. `CANVAS_OPS.panel` exists to keep the table total
    // and must stay unreachable — the day this denial changes rule, that entry has become a
    // real rule and has to be reviewed as one.
    expect(result.denial.rule).toBe("not_accepted" satisfies PlacementDenialRule);
    expect(result.denial.surface).toEqual(SURFACES.panel);
    expect(result.denial.container).toEqual({ kind: "canvas", padId: "canvas-1" });
    expect(CANVAS_OPS.panel).toBe("portal");
  });

  test("every op resolution can name is reachable, and only those", () => {
    const reached = new Set<PlacementOp>();
    for (const itemKind of worldKinds) {
      for (const destinationKind of destinationKinds) {
        const result = resolvePlacement(SURFACES[itemKind], DESTINATIONS[destinationKind], lookup);
        if (result.ok) reached.add(result.op);
      }
    }
    /*
      Every op EXCEPT the execution-only ones. `swap` is deliberately unreachable here:
      whether a center placement fills a spot or exchanges with what is in it depends on a
      document, not on a kind, so resolution answers `add_tile`/`compose` and the executor
      re-tags. Keeping that split enumerated — rather than written down in prose — is what
      stops a future op from quietly becoming unreachable by accident.
     */
    const resolvable = PLACEMENT_OPS.filter(
      (op) => !(EXECUTION_ONLY_OPS as readonly PlacementOp[]).includes(op),
    );
    expect([...reached].sort()).toEqual([...resolvable].sort());
    expect(EXECUTION_ONLY_OPS.length).toBeGreaterThan(0);
  });

  test("a center placement resolves without consulting occupancy", () => {
    // The lookup answers about kinds only — it has no way to say "that leaf is taken" —
    // so both center forms come back as the ordinary op and the executor owns the branch.
    const tiled = resolvePlacement(
      SURFACES.terminal,
      { kind: "tile", padId: "multi-1", targetTileId: "t1", edge: "center" },
      lookup,
    );
    expect(tiled.ok && tiled.op).toBe("add_tile");
    const composed = resolvePlacement(
      SURFACES.terminal,
      { kind: "compose", padId: "canvas-1", targetElementId: "el-portal-solo", edge: "center" },
      lookup,
    );
    expect(composed.ok && composed.op).toBe("compose");
  });
});

describe("solo compositions", () => {
  test("a pad surface naming a solo composition IS the item inside it", () => {
    expect(placementItemFor({ kind: "pad", padId: "solo-1" }, lookup)).toEqual({
      kind: "terminal",
      containerId: "solo-1",
    });

    // The consequence: it absorbs into another composition as an ordinary tileable
    // placement of the terminal, where the composition it arrived as would be refused.
    const absorbed = resolvePlacement({ kind: "pad", padId: "solo-1" }, DESTINATIONS.tile, lookup);
    expect(absorbed.ok && absorbed.op).toBe("add_tile");
    expect(absorbed.ok && absorbed.item.kind).toBe("terminal");
    expect(absorbed.ok && absorbed.item.containerId).toBe("solo-1");
  });

  test("a pad surface naming a multi-tile composition stays a composition", () => {
    expect(placementItemFor({ kind: "pad", padId: "multi-2" }, lookup)).toEqual({
      kind: "view",
      containerId: "multi-2",
    });
    const refused = resolvePlacement({ kind: "pad", padId: "multi-2" }, DESTINATIONS.tile, lookup);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.denial.rule).toBe(PLACEMENT_GUARDS["solo-only"].rule);
  });

  test("an element surface portalling onto a solo composition IS the item too", () => {
    const surface: PlacementSurface = {
      kind: "element",
      padId: "canvas-1",
      elementId: "el-portal-solo",
    };
    expect(placementItemFor(surface, lookup)).toEqual({ kind: "terminal", containerId: "solo-1" });

    // One door: a canvas terminal is released and merged through the same classification
    // a sidebar row uses, so no caller tests the arity of a composition for itself.
    const released = resolvePlacement(surface, DESTINATIONS.unplaced, lookup);
    expect(released.ok && released.op).toBe("unplace");
    const merged = resolvePlacement(surface, DESTINATIONS.tile, lookup);
    expect(merged.ok && merged.op).toBe("add_tile");
    expect(merged.ok && merged.item.kind).toBe("terminal");
  });

  test("an element surface portalling onto a multi-tile composition stays a composition", () => {
    const surface: PlacementSurface = {
      kind: "element",
      padId: "canvas-1",
      elementId: "el-portal-multi",
    };
    expect(placementItemFor(surface, lookup)).toEqual({ kind: "view", containerId: "multi-2" });
    const refused = resolvePlacement(surface, DESTINATIONS.tile, lookup);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.denial.rule).toBe(PLACEMENT_GUARDS["solo-only"].rule);
  });

  test("a terminal with no home is unknown, not homeless", () => {
    const surface: PlacementSurface = { kind: "terminal", sessionId: "ghost" };
    expect(placementItemFor(surface, lookup)).toBeNull();
    const result = resolvePlacement(surface, DESTINATIONS.canvas, lookup);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.denial.rule).toBe("unknown_surface");
  });
});

describe("placement homing", () => {
  test("every kind resolves a homing mode drawn from the vocabulary, or none at all", () => {
    const modes: readonly (string | null)[] = [...HOMING_MODES, null];
    for (const kind of worldKinds) {
      expect(modes).toContain(itemTraitsFor(kind, lookup).homed);
    }
  });

  test("the paradigm's three homing modes are pinned by name", () => {
    // Server-born: its composition exists before its first frame of output.
    expect(ITEM_KINDS.terminal.homed).toBe("eager");
    // Born inline in the document that created it; its home materialises on first claim —
    // declared by the plugin that owns notes, and read back through the same resolution.
    expect(itemTraitsFor("text", lookup).homed).toBe("on-claim");
    // Needs no home: a stroke exists in the document that holds it.
    expect(itemTraitsFor("draw", lookup).homed).toBe("inline");
    // A panel is a rendering of a plugin contribution, not an object with a document:
    // there is no composition for it to acquire, so the question does not apply.
    expect(ITEM_KINDS.panel.homed).toBeNull();
  });
});

describe("placement guards", () => {
  test("no-self-embed refuses a container placed into itself, however it is addressed", () => {
    const cases: readonly {
      readonly surface: PlacementSurface;
      readonly to: PlacementDestination;
    }[] = [
      // The pad itself, dropped on its own canvas as a portal.
      {
        surface: { kind: "pad", padId: "canvas-1" },
        to: { kind: "canvas", padId: "canvas-1", x: 0, y: 0 },
      },
      // The same pad, composed onto one of its own elements.
      {
        surface: { kind: "pad", padId: "canvas-1" },
        to: { kind: "compose", padId: "canvas-1", targetElementId: "el-portal-solo", edge: "left" },
      },
      // Addressed through a portal element that lives on a different canvas.
      {
        surface: { kind: "element", padId: "canvas-1", elementId: "el-portal-canvas" },
        to: { kind: "compose", padId: "canvas-2", targetElementId: "el-text", edge: "top" },
      },
      // Identity is answered before arity: a composition into ITSELF is self-embedding,
      // not a merge that failed for want of a single occupant.
      {
        surface: { kind: "pad", padId: "multi-2" },
        to: { kind: "tile", padId: "multi-2", targetTileId: null, edge: null },
      },
    ];
    for (const { surface, to } of cases) {
      const result = resolvePlacement(surface, to, lookup);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.denial.rule).toBe(PLACEMENT_GUARDS["no-self-embed"].rule);
      expect(result.denial.surface).toEqual(surface);
    }
  });

  test("a container is placeable into a DIFFERENT container of the same kind", () => {
    const result = resolvePlacement(
      { kind: "pad", padId: "canvas-2" },
      { kind: "compose", padId: "canvas-1", targetElementId: "el-text", edge: "left" },
      lookup,
    );
    expect(result.ok && result.op).toBe("compose");
  });

  test("discipline-match refuses a destination form its container cannot honour", () => {
    const mismatched: readonly PlacementDestination[] = [
      { kind: "canvas", padId: "multi-1", x: 0, y: 0 },
      { kind: "tile", padId: "canvas-1", targetTileId: null, edge: null },
      { kind: "compose", padId: "multi-1", targetElementId: "t1", edge: "left" },
    ];
    for (const to of mismatched) {
      const result = resolvePlacement({ kind: "terminal", sessionId: "session-1" }, to, lookup);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.denial.rule).toBe(PLACEMENT_GUARDS["discipline-match"].rule);
    }
  });

  test("nowhere has no discipline, so an unplaceable item always lands there", () => {
    for (const surface of [
      SURFACES.terminal,
      {
        kind: "element",
        padId: "canvas-1",
        elementId: "el-portal-solo",
      } satisfies PlacementSurface,
    ]) {
      const result = resolvePlacement(surface, { kind: "unplaced" }, lookup);
      expect(result.ok && result.op).toBe("unplace");
    }
  });

  test("unresolvable ids are denials, never silent successes", () => {
    const unknownContainer = resolvePlacement(
      SURFACES.terminal,
      { kind: "tile", padId: "ghost", targetTileId: null, edge: null },
      lookup,
    );
    expect(unknownContainer.ok).toBe(false);
    if (!unknownContainer.ok) expect(unknownContainer.denial.rule).toBe("unknown_container");

    const unknownPadSurface = resolvePlacement(
      { kind: "pad", padId: "ghost" },
      DESTINATIONS.canvas,
      lookup,
    );
    expect(unknownPadSurface.ok).toBe(false);
    if (!unknownPadSurface.ok) expect(unknownPadSurface.denial.rule).toBe("unknown_surface");

    const unknownElement = resolvePlacement(
      { kind: "element", padId: "canvas-1", elementId: "ghost" },
      DESTINATIONS.unplaced,
      lookup,
    );
    expect(unknownElement.ok).toBe(false);
    if (!unknownElement.ok) expect(unknownElement.denial.rule).toBe("unknown_surface");
  });

  test("an element surface is resolved by what it places, not by how it is addressed", () => {
    const asElement = resolvePlacement(
      { kind: "element", padId: "canvas-1", elementId: "el-portal-multi" },
      DESTINATIONS.tile,
      lookup,
    );
    const asPad = resolvePlacement({ kind: "pad", padId: "multi-2" }, DESTINATIONS.tile, lookup);
    expect(asElement.ok).toBe(false);
    expect(asPad.ok).toBe(false);
    if (!asElement.ok && !asPad.ok) {
      expect(asElement.denial.rule).toBe(asPad.denial.rule);
    }

    const terminalCopy = resolvePlacement(
      { kind: "element", padId: "canvas-1", elementId: "el-portal-solo" },
      DESTINATIONS.tile,
      lookup,
    );
    expect(terminalCopy.ok && terminalCopy.op).toBe("add_tile");
  });
});

describe("placement wire shapes", () => {
  test("every surface form round-trips and nothing else parses", () => {
    const surfaces: readonly PlacementSurface[] = [
      { kind: "terminal", sessionId: "s1" },
      { kind: "pad", padId: "p1" },
      { kind: "tile", containerId: "v1", tileId: "t1" },
      { kind: "element", padId: "p1", elementId: "e1" },
    ];
    for (const surface of surfaces) {
      expect(PlacementSurfaceSchema.parse(surface)).toEqual(surface);
    }
    expect(PlacementSurfaceSchema.safeParse({ kind: "browser", url: "x" }).success).toBe(false);
    expect(PlacementSurfaceSchema.safeParse({ kind: "terminal", sessionId: "" }).success).toBe(
      false,
    );
    expect(
      PlacementSurfaceSchema.safeParse({ kind: "tile", containerId: "v1", tileId: "t1", x: 1 })
        .success,
    ).toBe(false);
  });

  test("every destination form round-trips with its required geometry", () => {
    for (const destination of Object.values(DESTINATIONS)) {
      expect(PlacementDestinationSchema.parse(destination)).toEqual(destination);
    }
    expect(
      PlacementDestinationSchema.safeParse({ kind: "canvas", padId: "p1", x: Infinity, y: 0 })
        .success,
    ).toBe(false);
    expect(
      PlacementDestinationSchema.safeParse({
        kind: "compose",
        padId: "p1",
        targetElementId: "e1",
        edge: null,
      }).success,
    ).toBe(false);
    expect(
      PlacementDestinationSchema.safeParse({
        kind: "tile",
        padId: "p1",
        targetTileId: null,
        edge: "middle",
      }).success,
    ).toBe(false);
    // Nowhere carries no fields: there is no order left for a position to index into.
    expect(PlacementDestinationSchema.safeParse({ kind: "unplaced", index: 0 }).success).toBe(
      false,
    );
  });

  test("the place envelope carries exactly a surface and a destination", () => {
    const request = { surface: SURFACES.terminal, destination: DESTINATIONS.canvas };
    expect(PlaceRequestSchema.parse(request)).toEqual(request);
    expect(PlaceRequestSchema.safeParse({ ...request, force: true }).success).toBe(false);
    expect(PlaceRequestSchema.safeParse({ surface: SURFACES.terminal }).success).toBe(false);
  });

  test("every declared op has exactly one response form", () => {
    const responses: readonly PlaceResponse[] = [
      { op: "portal", elementId: "e1" },
      { op: "extract", elementId: "e2" },
      { op: "move_element", elementId: "e3" },
      { op: "unplace", removed: 2 },
      { op: "add_tile", tileId: "t1" },
      { op: "compose", viewId: "v1", tileId: "t2" },
      // An exchange names both seats it moved between, so a caller can repaint the pair
      // without diffing a document to find out what the second one was.
      { op: "swap", placementId: "t3", withPlacementId: "t4" },
      // A displacement names the leaf the carry took and the home its occupant was moved
      // to, so a caller can reveal where the thing it pushed aside actually went.
      { op: "replace", tileId: "t1", displacedContainerId: "pad-1" },
    ];
    for (const response of responses) {
      expect(PlaceResponseSchema.parse(response)).toEqual(response);
    }
    // Exhaustive against the declarations: a new op with no response form fails here.
    expect(responses.map((response) => response.op).sort()).toEqual([...PLACEMENT_OPS].sort());
    // Zero references removed is a legal answer — "it was already unplaced" — which is why
    // the count is required rather than omitted when nothing moved.
    expect(PlaceResponseSchema.parse({ op: "unplace", removed: 0 })).toEqual({
      op: "unplace",
      removed: 0,
    });
    expect(PlaceResponseSchema.safeParse({ op: "unplace" }).success).toBe(false);
    expect(PlaceResponseSchema.safeParse({ op: "unplace", elementId: "e1" }).success).toBe(false);
    expect(PlaceResponseSchema.safeParse({ op: "swap", placementId: "t1" }).success).toBe(false);
    expect(PlaceResponseSchema.safeParse({ op: "portal" }).success).toBe(false);
    // An embedded canvas needed no new home — the pad already lives in the index — so the
    // null is a real answer, not a missing field.
    expect(
      PlaceResponseSchema.parse({ op: "replace", tileId: "t1", displacedContainerId: null }),
    ).toEqual({ op: "replace", tileId: "t1", displacedContainerId: null });
    expect(PlaceResponseSchema.safeParse({ op: "replace", tileId: "t1" }).success).toBe(false);
  });

  test("a denial survives the action door's one string, rule first", () => {
    /*
      `core.layout.place` refuses on the `refused` rung, which carries a message and nothing
      else — so the message LEADS with the algebra's rule, and reading it back is a lookup in
      the published closed set rather than prose-parsing. The surface and container do not
      travel: the caller sent one and can derive the other.
     */
    for (const rule of PLACEMENT_DENIAL_RULES) {
      const message = placementRefusal({
        rule,
        surface: SURFACES.view,
        container: { kind: "view", padId: "multi-1" },
      });
      expect(message.startsWith(`${rule}:`)).toBe(true);
      expect(placementRefusalRule(message)).toBe(rule);
    }
    // A refusal from any other door is not a placement's, and must not be read as one.
    expect(placementRefusalRule("dependencies: core.terminals")).toBeNull();
    expect(placementRefusalRule("essential")).toBeNull();
    expect(placementRefusalRule("")).toBeNull();
    // The offenders name what was offered and what refused it, for a log line and a toast.
    expect(
      placementRefusal({
        rule: "not_accepted",
        surface: SURFACES.terminal,
        container: { kind: "canvas", padId: "canvas-1" },
      }),
    ).toBe("not_accepted: terminal -> canvas");
  });

  test("a denial names a declared rule, the surface offered, and the container refusing", () => {
    for (const rule of PLACEMENT_DENIAL_RULES) {
      const denial = {
        rule,
        surface: SURFACES.terminal,
        container: { kind: "view" as const, padId: "multi-1" },
      };
      expect(PlacementDenialSchema.parse(denial)).toEqual(denial);
    }
    expect(
      PlacementDenialSchema.safeParse({
        rule: "because_i_said_so",
        surface: SURFACES.terminal,
        container: { kind: "unplaced" },
      }).success,
    ).toBe(false);
    expect(
      PlacementDenialSchema.safeParse({
        rule: "not_accepted" satisfies PlacementDenialRule,
        surface: SURFACES.terminal,
        container: { kind: "unplaced" },
      }).success,
    ).toBe(true);
  });
});

describe("placement introspection", () => {
  test("GET /api/protocol publishes the whole vocabulary", () => {
    const placement = buildProtocolJsonSchema()["placement"];
    expect(placement).toBeDefined();
    const published = placement as Record<string, unknown>;
    expect(Object.keys(published).sort()).toEqual(
      [
        "groups",
        "homingModes",
        "guards",
        "items",
        "containers",
        "destinations",
        "ops",
        "executionOnlyOps",
        "canvasOps",
        "destinationOps",
        "denialRules",
        "request",
        "response",
        "denial",
        "traits",
      ].sort(),
    );
    expect(Object.keys(published["items"] as object)).toEqual(itemKinds);
    expect(Object.keys(published["containers"] as object)).toEqual(Object.keys(CONTAINER_KINDS));
    expect(published["groups"]).toEqual(PLACEMENT_GROUPS);
    // Homing belongs to the published algebra: where a kind LIVES decides whether placing
    // it moves something or births its home.
    expect(published["homingModes"]).toEqual(HOMING_MODES);
    expect(published["denialRules"]).toEqual(PLACEMENT_DENIAL_RULES);
    /*
      An agent has to be able to learn, from the vocabulary alone, that a placement it
      resolved as `add_tile` can come back tagged `swap` or `replace`. Publishing the split
      is what makes the center rule discoverable instead of folklore.
     */
    expect(published["executionOnlyOps"]).toEqual(EXECUTION_ONLY_OPS);
    for (const op of EXECUTION_ONLY_OPS) expect(ops).toContain(op);
    // The generated payload is the source: a mod reads legality without reading prose.
    expect(JSON.stringify(published["items"])).toContain("tileable");
    expect(JSON.stringify(published["items"])).toContain("eager");
  });

  test("the denial rules are one per guard plus identity, containment and the two center refusals", () => {
    const guardRules = Object.values(PLACEMENT_GUARDS).map((guard) => guard.rule);
    // Two guards sharing a rule would make a rendered refusal ambiguous.
    expect(new Set(guardRules).size).toBe(guardRules.length);
    const expected: readonly string[] = [
      ...guardRules,
      "not_accepted",
      "unknown_surface",
      "unknown_container",
      /*
        Not a guard: a guard is a property of a KIND, and this one is a property of the
        gesture — whether the surface offered is a placement with a seat to trade, or an
        identity form that names an item and nothing else. Only the executor can see the
        occupancy that makes the question arise, so the rule lives here and is raised there.
       */
      "not_swappable",
      /*
        Also not a guard, and about neither the carry nor the destination's kind: it is
        about what happens to be SITTING in the spot. A note has nowhere but this
        composition's document to live, so displacing it is refused by name.
       */
      "not_displaceable",
    ];
    expect([...denialRules].sort()).toEqual([...expected].sort());
  });

  test("the declarations are internally closed", () => {
    const groups: readonly string[] = PLACEMENT_GROUPS;
    for (const declaration of Object.values(ITEM_KINDS)) {
      for (const group of declaration.groups) expect(groups).toContain(group);
      for (const guard of declaration.guards) {
        expect(PLACEMENT_GUARDS[guard].site).toBe("item");
      }
    }
    for (const declaration of Object.values(CONTAINER_KINDS)) {
      for (const group of declaration.accepts) expect(groups).toContain(group);
      for (const guard of declaration.guards) {
        expect(PLACEMENT_GUARDS[guard].site).toBe("container");
      }
    }
    for (const guard of Object.values(PLACEMENT_GUARDS)) {
      expect(denialRules).toContain(guard.rule);
    }
    for (const op of Object.values(CANVAS_OPS)) expect(ops).toContain(op);
    for (const op of Object.values(DESTINATION_OPS)) expect(ops).toContain(op);
    for (const declaration of Object.values(DESTINATION_KINDS)) {
      expect(Object.keys(CONTAINER_KINDS)).toContain(declaration.container);
    }
    // Groups only matter if something accepts them, except `embeddable`, which declares a
    // rendering capability (live depth-2 embedding) rather than a placement.
    const accepted = new Set<string>(
      Object.values(CONTAINER_KINDS).flatMap((declaration) => [...declaration.accepts]),
    );
    const unaccepted = PLACEMENT_GROUPS.filter((group) => !accepted.has(group));
    expect(unaccepted).toEqual(["embeddable"]);
  });
});

/**
 * THE TRAITS ARE THE KIND (G1).
 *
 * A plugin that contributes an element kind declares its placement behavior as manifest
 * data, and the algebra has to be able to consume that declaration without learning a new
 * concept. That is only true if the traits describe a kind COMPLETELY — so these cases
 * hold the schema against the closed table itself: every shipped kind must be expressible,
 * and nothing outside the vocabulary may be.
 */
describe("placement traits", () => {
  test("every closed item kind IS a traits value, which is what lets the union open later", () => {
    for (const [kind, declaration] of Object.entries(ITEM_KINDS)) {
      const parsed = PlacementTraitsSchema.parse(declaration);
      // Round-trip, not merely acceptance: a traits value that dropped `homed` or reordered
      // groups would still parse while describing a different kind.
      expect(parsed, kind).toEqual({
        groups: [...declaration.groups],
        guards: [...declaration.guards],
        homed: declaration.homed,
      });
    }
  });

  test("traits are bounded BY the vocabulary: no invented group, guard or homing mode", () => {
    const draw = { groups: ["canvas-item"], guards: [], homed: "inline" };
    expect(PlacementTraitsSchema.safeParse(draw).success).toBe(true);
    expect(PlacementTraitsSchema.safeParse({ ...draw, groups: ["floaty"] }).success).toBe(false);
    expect(PlacementTraitsSchema.safeParse({ ...draw, homed: "later" }).success).toBe(false);
    // A container-site guard on an ITEM is the one subtle mistake the site split exists to
    // catch: `discipline-match` is asked of the destination, and an item claiming it would
    // declare a rule nothing ever evaluates.
    expect(PlacementTraitsSchema.safeParse({ ...draw, guards: ["discipline-match"] }).success).toBe(
      false,
    );
    expect(PlacementTraitsSchema.safeParse({ ...draw, guards: ["solo-only"] }).success).toBe(true);
    // Traits are the WHOLE description; a fourth field would be behavior living outside it.
    expect(PlacementTraitsSchema.safeParse({ ...draw, render: "DrawNode" }).success).toBe(false);
    for (const field of ["groups", "guards", "homed"]) {
      const partial: Record<string, unknown> = { ...draw };
      delete partial[field];
      expect(PlacementTraitsSchema.safeParse(partial).success, field).toBe(false);
    }
  });

  test("the item-guard tuple tracks the guard table, so a schema cannot fall behind it", () => {
    const itemGuards = Object.entries(PLACEMENT_GUARDS)
      .filter(([, guard]) => guard.site === "item")
      .map(([name]) => name);
    const named: readonly string[] = [...ITEM_GUARD_NAMES].sort();
    expect(named).toEqual(itemGuards.sort());
  });

  test("the default a manifest omitting traits gets is free-floating canvas furniture", () => {
    // `core.draw` declares no `placement` block, so this default IS how ink places — the
    // row the floor table used to carry, now arriving through the composition instead.
    expect(itemTraitsFor("draw", lookup)).toEqual(DEFAULT_ELEMENT_PLACEMENT_TRAITS);
    expect(DEFAULT_ELEMENT_PLACEMENT_TRAITS).toEqual({
      groups: ["canvas-item"],
      guards: [],
      homed: "inline",
    });
  });

  test("a kind is resolved floor first, then the composition, then the default", () => {
    // A floor kind can never be redefined by a manifest: the table wins by order.
    const shadowed: PlacementLookup = {
      ...lookup,
      itemTraits: () => ({ groups: ["canvas-item"], guards: [], homed: "inline" }),
    };
    expect(itemTraitsFor("terminal", shadowed)).toEqual(ITEM_KINDS.terminal);
    // A contributed kind resolves to what its manifest declared.
    expect(itemTraitsFor("text", lookup)).toEqual({
      groups: ["tileable", "canvas-item"],
      guards: [],
      homed: "on-claim",
    });
    // A kind no composition claims is ordinary canvas furniture rather than a refusal
    // about who is installed: the element is sitting in a document either way.
    expect(itemTraitsFor("chart", lookup)).toEqual(DEFAULT_ELEMENT_PLACEMENT_TRAITS);
  });

  test("a contributed kind places by its declared traits, floor kinds untouched", () => {
    // `text` is tileable BECAUSE core.notes said so — the engine has no row for it — and a
    // canvas MOVES an element it holds, which is a floor ruling about canvases (§12).
    const tiled = resolvePlacement(SURFACES.text, DESTINATIONS.tile, lookup);
    expect(tiled.ok && tiled.op).toBe("add_tile");
    const moved = resolvePlacement(SURFACES.text, DESTINATIONS.canvas, lookup);
    expect(moved.ok && moved.op).toBe("move_element");
    // Take the declaration away and the same gesture is refused by group containment: the
    // traits, not the engine, are what made it legal.
    const unclaimed: PlacementLookup = { ...lookup, itemTraits: () => null };
    const refused = resolvePlacement(SURFACES.text, DESTINATIONS.tile, unclaimed);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.denial.rule).toBe("not_accepted");
    expect(canvasOpFor("text")).toBe("move_element");
    expect(canvasOpFor("chart")).toBe("move_element");
    expect(canvasOpFor("terminal")).toBe("portal");
  });
});
