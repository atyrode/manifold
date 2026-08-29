import { describe, expect, test } from "bun:test";
import {
  CANVAS_OPS,
  CONTAINER_KINDS,
  DESTINATION_KINDS,
  DESTINATION_OPS,
  ITEM_KINDS,
  PLACEMENT_DENIAL_RULES,
  PLACEMENT_GROUPS,
  PLACEMENT_GUARDS,
  PLACEMENT_OPS,
  PlaceRequestSchema,
  PlacementDenialSchema,
  PlacementDestinationSchema,
  PlacementSurfaceSchema,
  buildProtocolJsonSchema,
  resolvePlacement,
  type ContainerLayout,
  type DestinationKind,
  type ItemKind,
  type PlacementDenialRule,
  type PlacementDestination,
  type PlacementItem,
  type PlacementLookup,
  type PlacementOp,
  type PlacementSurface,
} from "@manifold/protocol";

/**
 * One small world, shared by every case: two canvases, one view, and a canvas holding
 * every element shape a drag can grab. The lookup is the whole state interface, so these
 * maps are exactly what the server's store and the browser's doc supply in production.
 */
const PAD_LAYOUTS: Readonly<Record<string, ContainerLayout>> = {
  "canvas-1": "canvas",
  "canvas-2": "canvas",
  "view-1": "tiled",
};

const ELEMENTS: Readonly<Record<string, PlacementItem>> = {
  "el-term": { kind: "terminal", containerId: null },
  "el-text": { kind: "text", containerId: null },
  "el-draw": { kind: "draw", containerId: null },
  // A portal places the container it points at, which is why it carries that identity.
  "el-portal-canvas": { kind: "canvas-pad", containerId: "canvas-2" },
  "el-portal-view": { kind: "view", containerId: "view-1" },
};

const lookup: PlacementLookup = {
  padLayout: (padId) => PAD_LAYOUTS[padId] ?? null,
  elementItem: (padId, elementId) =>
    PAD_LAYOUTS[padId] === undefined ? null : (ELEMENTS[elementId] ?? null),
};

/**
 * One surface per declared item kind. `Record<ItemKind, …>` is the point: adding an item
 * kind fails to compile until the matrix can exercise it.
 */
const SURFACES: Readonly<Record<ItemKind, PlacementSurface>> = {
  terminal: { kind: "terminal", sessionId: "session-1" },
  "canvas-pad": { kind: "pad", padId: "canvas-2" },
  view: { kind: "pad", padId: "view-1" },
  text: { kind: "element", padId: "canvas-1", elementId: "el-text" },
  draw: { kind: "element", padId: "canvas-1", elementId: "el-draw" },
  tile: { kind: "tile", containerId: "view-1", tileId: "t1" },
};

/** One destination per declared form, each aimed at a container the item is not. */
const DESTINATIONS: Readonly<Record<DestinationKind, PlacementDestination>> = {
  canvas: { kind: "canvas", padId: "canvas-1", x: 40, y: 80 },
  tile: { kind: "tile", padId: "view-1", targetTileId: null, edge: null },
  compose: { kind: "compose", padId: "canvas-1", targetElementId: "el-term", edge: "right" },
  pool: { kind: "pool" },
};

/**
 * The golden algebra: what every declared item kind does at every declared destination.
 * The PAIRS are enumerated from the declarations below — this table only records the
 * expected answer, and a new kind or destination cannot compile without one.
 */
const MATRIX: Readonly<Record<ItemKind, Readonly<Record<DestinationKind, string>>>> = {
  terminal: { canvas: "bind", tile: "add_tile", compose: "compose", pool: "park" },
  "canvas-pad": {
    canvas: "portal",
    tile: "add_tile",
    compose: "compose",
    pool: "not_accepted",
  },
  // Views never nest: `view` simply is not `tileable`, so tile and compose refuse it.
  view: {
    canvas: "portal",
    tile: "not_accepted",
    compose: "not_accepted",
    pool: "not_accepted",
  },
  text: {
    canvas: "move_element",
    tile: "not_accepted",
    compose: "not_accepted",
    pool: "not_accepted",
  },
  draw: {
    canvas: "move_element",
    tile: "not_accepted",
    compose: "not_accepted",
    pool: "not_accepted",
  },
  // A tile is addressable for extraction only; moving or parking its occupant addresses
  // the occupant, never the leaf.
  tile: {
    canvas: "extract",
    tile: "not_accepted",
    compose: "not_accepted",
    pool: "not_accepted",
  },
};

const itemKinds = Object.keys(ITEM_KINDS) as ItemKind[];
const destinationKinds = Object.keys(DESTINATION_KINDS) as DestinationKind[];
const ops: readonly string[] = PLACEMENT_OPS;
const denialRules: readonly string[] = PLACEMENT_DENIAL_RULES;

describe("placement matrix", () => {
  test("every declared item kind x destination resolves to an op or a named denial", () => {
    const seen: string[] = [];
    for (const itemKind of itemKinds) {
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
    expect(seen).toHaveLength(itemKinds.length * destinationKinds.length);
    expect(seen.length).toBeGreaterThan(0);
  });

  test("acceptance follows group containment, so the table cannot drift from declarations", () => {
    for (const itemKind of itemKinds) {
      for (const destinationKind of destinationKinds) {
        const container = DESTINATION_KINDS[destinationKind].container;
        const accepts: readonly string[] = CONTAINER_KINDS[container].accepts;
        const overlaps = (ITEM_KINDS[itemKind].groups as readonly string[]).some((group) =>
          accepts.includes(group),
        );
        const result = resolvePlacement(SURFACES[itemKind], DESTINATIONS[destinationKind], lookup);
        const refusedByContainment = !result.ok && result.denial.rule === "not_accepted";
        expect(`${itemKind}/${destinationKind}:${refusedByContainment}`).toBe(
          `${itemKind}/${destinationKind}:${!overlaps}`,
        );
      }
    }
  });

  test("every declared op is reachable from some declared pair", () => {
    const reached = new Set<PlacementOp>();
    for (const itemKind of itemKinds) {
      for (const destinationKind of destinationKinds) {
        const result = resolvePlacement(SURFACES[itemKind], DESTINATIONS[destinationKind], lookup);
        if (result.ok) reached.add(result.op);
      }
    }
    expect([...reached].sort()).toEqual([...PLACEMENT_OPS].sort());
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
      // The same pad, composed onto one of its own terminals.
      {
        surface: { kind: "pad", padId: "canvas-1" },
        to: { kind: "compose", padId: "canvas-1", targetElementId: "el-term", edge: "left" },
      },
      // Addressed through a portal element that lives on a different canvas.
      {
        surface: { kind: "element", padId: "canvas-1", elementId: "el-portal-canvas" },
        to: { kind: "compose", padId: "canvas-2", targetElementId: "el-term", edge: "top" },
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
      { kind: "compose", padId: "canvas-1", targetElementId: "el-term", edge: "left" },
      lookup,
    );
    expect(result.ok && result.op).toBe("compose");
  });

  test("discipline-match refuses a destination form its container cannot honour", () => {
    const mismatched: readonly PlacementDestination[] = [
      { kind: "canvas", padId: "view-1", x: 0, y: 0 },
      { kind: "tile", padId: "canvas-1", targetTileId: null, edge: null },
      { kind: "compose", padId: "view-1", targetElementId: "el-term", edge: "left" },
    ];
    for (const to of mismatched) {
      const result = resolvePlacement({ kind: "terminal", sessionId: "session-1" }, to, lookup);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.denial.rule).toBe(PLACEMENT_GUARDS["discipline-match"].rule);
    }
  });

  test("the pool has no discipline, so a parkable item always lands there", () => {
    for (const surface of [
      SURFACES.terminal,
      { kind: "element", padId: "canvas-1", elementId: "el-term" } satisfies PlacementSurface,
    ]) {
      const result = resolvePlacement(surface, { kind: "pool", index: 2 }, lookup);
      expect(result.ok && result.op).toBe("park");
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
      DESTINATIONS.pool,
      lookup,
    );
    expect(unknownElement.ok).toBe(false);
    if (!unknownElement.ok) expect(unknownElement.denial.rule).toBe("unknown_surface");
  });

  test("an element surface is resolved by what it places, not by how it is addressed", () => {
    const asElement = resolvePlacement(
      { kind: "element", padId: "canvas-1", elementId: "el-portal-view" },
      DESTINATIONS.tile,
      lookup,
    );
    const asPad = resolvePlacement({ kind: "pad", padId: "view-1" }, DESTINATIONS.tile, lookup);
    expect(asElement.ok).toBe(false);
    expect(asPad.ok).toBe(false);
    if (!asElement.ok && !asPad.ok) {
      expect(asElement.denial.rule).toBe(asPad.denial.rule);
    }

    const terminalCopy = resolvePlacement(
      { kind: "element", padId: "canvas-1", elementId: "el-term" },
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
    expect(PlacementDestinationSchema.parse({ kind: "pool", index: 0 })).toEqual({
      kind: "pool",
      index: 0,
    });
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
    expect(PlacementDestinationSchema.safeParse({ kind: "pool", index: -1 }).success).toBe(false);
  });

  test("the place envelope carries exactly a surface and a destination", () => {
    const request = { surface: SURFACES.terminal, destination: DESTINATIONS.canvas };
    expect(PlaceRequestSchema.parse(request)).toEqual(request);
    expect(PlaceRequestSchema.safeParse({ ...request, force: true }).success).toBe(false);
    expect(PlaceRequestSchema.safeParse({ surface: SURFACES.terminal }).success).toBe(false);
  });

  test("a denial names a declared rule, the surface offered, and the container refusing", () => {
    for (const rule of PLACEMENT_DENIAL_RULES) {
      const denial = {
        rule,
        surface: SURFACES.terminal,
        container: { kind: "view" as const, padId: "view-1" },
      };
      expect(PlacementDenialSchema.parse(denial)).toEqual(denial);
    }
    expect(
      PlacementDenialSchema.safeParse({
        rule: "because_i_said_so",
        surface: SURFACES.terminal,
        container: { kind: "pool" },
      }).success,
    ).toBe(false);
    expect(
      PlacementDenialSchema.safeParse({
        rule: "not_accepted" satisfies PlacementDenialRule,
        surface: SURFACES.terminal,
        container: { kind: "pool" },
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
        "guards",
        "items",
        "containers",
        "destinations",
        "ops",
        "canvasOps",
        "destinationOps",
        "denialRules",
        "request",
        "denial",
      ].sort(),
    );
    expect(Object.keys(published["items"] as object)).toEqual(itemKinds);
    expect(Object.keys(published["containers"] as object)).toEqual(Object.keys(CONTAINER_KINDS));
    expect(published["groups"]).toEqual(PLACEMENT_GROUPS);
    expect(published["denialRules"]).toEqual(PLACEMENT_DENIAL_RULES);
    // The generated payload is the source: a mod reads legality without reading prose.
    expect(JSON.stringify(published["items"])).toContain("tileable");
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
