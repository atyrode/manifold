import { describe, expect, test } from "bun:test";
import {
  CANVAS_OPS,
  CONTAINER_GUARD_NAMES,
  CONTAINER_KINDS,
  ContainerDisciplineSchema,
  DEFAULT_ELEMENT_PLACEMENT_TRAITS,
  DESTINATION_KINDS,
  DESTINATION_OPS,
  DisciplineDefSchema,
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
  PlacementRefSchema,
  PlacementTraitsSchema,
  buildProtocolJsonSchema,
  canvasOpFor,
  itemTraitsFor,
  placementItemFor,
  placementRefusal,
  placementRefusalRule,
  resolvePlacement,
  type ContainerDiscipline,
  type DestinationKind,
  type DisciplineDeclaration,
  type ItemKind,
  type PlaceResponse,
  type PlacementDenialRule,
  type PlacementDestination,
  type PlacementItem,
  type PlacementLookup,
  type PlacementOp,
  type PlacementRef,
  type PlacementTraits,
} from "@manifold/protocol";

/**
 * One small world, shared by every case: two canvases, a SOLO composition holding a
 * terminal, and two multi-tile compositions — two because "a composition into a different
 * composition" is a distinct answer from "a composition into itself", and one container
 * cannot play both. The lookup is the whole state interface, so these maps are exactly what
 * the server's store and the browser's doc supply in production.
 */
const DISCIPLINES: Readonly<Record<string, ContainerDiscipline>> = {
  "canvas-1": "canvas",
  "canvas-2": "canvas",
  "solo-1": "composition",
  "multi-1": "composition",
  "multi-2": "composition",
  "orphan-1": "grid",
};

/** Every terminal lives in a composition from birth, so nothing else answers here. */
const TERMINAL_HOMES: Readonly<Record<string, string>> = { "terminal-1": "solo-1" };

/** What a composition holds when it holds exactly one item; multi-tile ones are absent. */
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
  "el-portal-solo": { kind: "composition", containerId: "solo-1" },
  "el-portal-multi": { kind: "composition", containerId: "multi-2" },
  "el-portal-canvas": { kind: "canvas", containerId: "canvas-2" },
  /**
   * A panel item, reachable in this world only because the lookup says so: no wire REF
   * form names a panel (workspace layouts are written whole by `core.space.setLayout`), and
   * the matrix still has to be able to ask the algebra what a panel does at every door.
   */
  "el-panel": { kind: "panel", containerId: null },
};

/**
 * The COMPOSED half of the algebra's vocabulary: the element kinds this world's plugins
 * contribute, with the traits their manifests declare (ADR 0013 §12). `text` is
 * `core.notes` declaring its own; `draw` is `core.canvas.draw` declaring nothing and taking the
 * engine's default; `chart` is nobody — a kind sitting in a document whose plugin is not in
 * this build.
 *
 * The floor table knows none of these names, which is the whole point: the matrix below
 * exercises contributed kinds through the same resolution floor kinds go through.
 */
const CONTRIBUTED_TRAITS: Readonly<Record<string, PlacementTraits>> = {
  text: { groups: ["tileable", "canvas_item"], guards: [], homed: "on_claim" },
  draw: DEFAULT_ELEMENT_PLACEMENT_TRAITS,
};

/**
 * The DISCIPLINE half of the same contributed vocabulary (#110). `canvas` and
 * `composition` are no longer floor rows: they are what `core.canvas` and
 * `core.compositions` declare in their manifests, so this world declares them too — and
 * `packages/server/test/discipline-roster.test.ts` pins that these values are the shipped
 * manifests' verbatim, which is what makes this fixture a statement about the algebra
 * rather than a private universe.
 *
 * `grid` is deliberately absent: it is the discipline of `orphan-1` below, the container
 * whose plugin this build does not have.
 */
const CONTRIBUTED_DISCIPLINES: Readonly<Record<string, DisciplineDeclaration>> = {
  canvas: {
    id: "canvas",
    title: "Canvas",
    item: {
      groups: ["tileable", "embeddable", "unplaceable", "canvas_item_as_portal"],
      guards: ["no_self_embed"],
      homed: "inline",
    },
    accepts: ["canvas_item", "canvas_item_as_portal", "extractable"],
    guards: ["discipline_match"],
    destinations: ["canvas", "compose"],
  },
  composition: {
    id: "composition",
    title: "Composition",
    item: {
      groups: ["mergeable", "unplaceable", "canvas_item_as_portal"],
      guards: ["no_self_embed", "solo_only"],
      homed: "inline",
    },
    accepts: ["tileable", "mergeable"],
    guards: ["discipline_match"],
    destinations: ["tile"],
  },
};

/**
 * Every kind this world can place: the floor's own STRUCTURAL kinds, the two disciplines
 * its plugins declare, and the element types they contribute. `canvas` and `composition`
 * are listed explicitly because they are contributions now (#110) rather than members of
 * `ITEM_KINDS` — the matrix still has to exercise every one of them at every door.
 */
type WorldKind = ItemKind | "canvas" | "composition" | "text" | "draw";

const lookup: PlacementLookup = {
  disciplineOf: (containerId) => DISCIPLINES[containerId] ?? null,
  elementItem: (containerId, elementId) =>
    DISCIPLINES[containerId] === undefined ? null : (ELEMENTS[elementId] ?? null),
  terminalHome: (terminalId) => TERMINAL_HOMES[terminalId] ?? null,
  soloOccupant: (containerId) => SOLO_OCCUPANTS[containerId] ?? null,
  discipline: (id) => CONTRIBUTED_DISCIPLINES[id] ?? null,
  itemTraits: (kind) => CONTRIBUTED_TRAITS[kind] ?? null,
};

/**
 * One ref per declared item kind. `Record<ItemKind, …>` is the point: adding an item
 * kind fails to compile until the matrix can exercise it. The `composition` ref names a
 * MULTI-tile composition because a solo one is classified as its occupant instead — that
 * reclassification is what the focused tests below cover.
 */
const REFS: Readonly<Record<WorldKind, PlacementRef>> = {
  terminal: { kind: "terminal", terminalId: "terminal-1" },
  canvas: { kind: "container", containerId: "canvas-2" },
  composition: { kind: "container", containerId: "multi-2" },
  text: { kind: "element", containerId: "canvas-1", elementId: "el-text" },
  draw: { kind: "element", containerId: "canvas-1", elementId: "el-draw" },
  tile: { kind: "tile", containerId: "multi-1", tileId: "t1" },
  panel: { kind: "element", containerId: "canvas-1", elementId: "el-panel" },
  structure: { kind: "structure", structure: { kind: "split", dir: "row" } },
};

/** One destination per declared form, each aimed at a container the item is not. */
const DESTINATIONS: Readonly<Record<DestinationKind, PlacementDestination>> = {
  canvas: { kind: "canvas", containerId: "canvas-1", x: 40, y: 80 },
  tile: { kind: "tile", containerId: "multi-1", targetTileId: null, edge: null },
  compose: {
    kind: "compose",
    containerId: "canvas-1",
    targetElementId: "el-portal-solo",
    edge: "right",
  },
  unplaced: { kind: "unplaced" },
};

/**
 * The golden algebra: what every declared item kind does at every declared destination.
 * The PAIRS are enumerated from the declarations below — this table only records the
 * expected answer, and a new kind or destination cannot compile without one.
 */
const MATRIX: Readonly<Record<WorldKind, Readonly<Record<DestinationKind, string>>>> = {
  // A terminal on a canvas is a PORTAL onto its home, never an element carrying the
  // terminal, and releasing it is `unplace` because there is no pool left to park in.
  terminal: { canvas: "portal", tile: "add_tile", compose: "compose", unplaced: "unplace" },
  canvas: {
    canvas: "portal",
    tile: "add_tile",
    compose: "compose",
    unplaced: "unplace",
  },
  // Compositions merge, never nest — and merging is the SOLO case, which never arrives here
  // as a `composition` because it was reclassified as its occupant. So a composition still
  // reaching a composition holds several items or none, and `not_solo` names that refusal.
  composition: {
    canvas: "portal",
    tile: "not_solo",
    compose: "not_solo",
    unplaced: "unplace",
  },
  // A note tiles: a composition owns the note's element in its own document, which is why
  // the ref form names an element id and not a cross-container pair. It is not
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
    ever raise a notice. Unplacing a leaf re-homes its occupant — a terminal into a fresh
    solo composition — instead of destroying it, so "nowhere" is a place a leaf can go.
   */
  tile: {
    canvas: "extract",
    tile: "add_tile",
    compose: "compose",
    unplaced: "unplace",
  },
  /*
    A panel is `tileable` and nothing else: it composes into a composition (that is what
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
  /*
    NEW STRUCTURE enters an existing tree and nothing else (issue #104). `tile` is the one
    destination that points into one, so it is the one cell with an op; a canvas refuses it
    on groups, and `compose` is refused BY NAME (`no_tree`) rather than on groups, because a
    composition is exactly what that form builds — the guard is what says an empty split is
    not something you compose a container out of. `unplaced` never reaches the guard: a
    structure is not `unplaceable`, so group containment answers first.
   */
  structure: {
    canvas: "not_accepted",
    tile: "add_tile",
    compose: "no_tree",
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
        const result = resolvePlacement(REFS[itemKind], DESTINATIONS[destinationKind], lookup);
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

  /**
   * Where a destination's acceptance rows come from, spelled the way the resolver reads
   * them (#110): a form that ENTERS a container is judged by that container's DISCIPLINE,
   * and the two forms that do not — `compose`, which authors one, and `unplaced`, which
   * names none — carry their own.
   */
  function destinationAccepts(kind: DestinationKind): readonly string[] {
    const form = DESTINATION_KINDS[kind];
    if (form.declaration !== null) return form.declaration.accepts;
    const destination = DESTINATIONS[kind];
    if (!("containerId" in destination)) return [];
    const discipline = DISCIPLINES[destination.containerId] ?? "";
    return CONTRIBUTED_DISCIPLINES[discipline]?.accepts ?? [];
  }

  test("acceptance follows group containment, so the table cannot drift from declarations", () => {
    for (const itemKind of worldKinds) {
      for (const destinationKind of destinationKinds) {
        const accepts = destinationAccepts(destinationKind);
        const overlaps = (itemTraitsFor(itemKind, lookup).groups as readonly string[]).some(
          (group) => accepts.includes(group),
        );
        const result = resolvePlacement(REFS[itemKind], DESTINATIONS[destinationKind], lookup);
        const refusedByContainment = !result.ok && result.denial.rule === "not_accepted";
        expect(`${itemKind}/${destinationKind}:${refusedByContainment}`).toBe(
          `${itemKind}/${destinationKind}:${!overlaps}`,
        );
      }
    }
  });

  test("a panel is refused by a canvas through containment, before any op is consulted", () => {
    const result = resolvePlacement(REFS.panel, DESTINATIONS.canvas, lookup);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // `not_accepted` and nothing else: a panel carries only `tileable`, and a canvas takes
    // none of the groups it would need. `CANVAS_OPS.panel` exists to keep the table total
    // and must stay unreachable — the day this denial changes rule, that entry has become a
    // real rule and has to be reviewed as one.
    expect(result.denial.rule).toBe("not_accepted" satisfies PlacementDenialRule);
    expect(result.denial.ref).toEqual(REFS.panel);
    expect(result.denial.container).toEqual({ kind: "canvas", containerId: "canvas-1" });
    expect(CANVAS_OPS.panel).toBe("portal");
  });

  test("every op resolution can name is reachable, and only those", () => {
    const reached = new Set<PlacementOp>();
    for (const itemKind of worldKinds) {
      for (const destinationKind of destinationKinds) {
        const result = resolvePlacement(REFS[itemKind], DESTINATIONS[destinationKind], lookup);
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
    const tileDrop = resolvePlacement(
      REFS.terminal,
      { kind: "tile", containerId: "multi-1", targetTileId: "t1", edge: "center" },
      lookup,
    );
    expect(tileDrop.ok && tileDrop.op).toBe("add_tile");
    const composed = resolvePlacement(
      REFS.terminal,
      {
        kind: "compose",
        containerId: "canvas-1",
        targetElementId: "el-portal-solo",
        edge: "center",
      },
      lookup,
    );
    expect(composed.ok && composed.op).toBe("compose");
  });
});

describe("solo compositions", () => {
  test("a container ref naming a solo composition IS the item inside it", () => {
    expect(placementItemFor({ kind: "container", containerId: "solo-1" }, lookup)).toEqual({
      kind: "terminal",
      containerId: "solo-1",
    });

    // The consequence: it absorbs into another composition as an ordinary tileable
    // placement of the terminal, where the composition it arrived as would be refused.
    const absorbed = resolvePlacement(
      { kind: "container", containerId: "solo-1" },
      DESTINATIONS.tile,
      lookup,
    );
    expect(absorbed.ok && absorbed.op).toBe("add_tile");
    expect(absorbed.ok && absorbed.item.kind).toBe("terminal");
    expect(absorbed.ok && absorbed.item.containerId).toBe("solo-1");
  });

  test("a container ref naming a multi-tile composition stays a composition", () => {
    expect(placementItemFor({ kind: "container", containerId: "multi-2" }, lookup)).toEqual({
      kind: "composition",
      containerId: "multi-2",
    });
    const refused = resolvePlacement(
      { kind: "container", containerId: "multi-2" },
      DESTINATIONS.tile,
      lookup,
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.denial.rule).toBe(PLACEMENT_GUARDS.solo_only.rule);
  });

  test("an element ref portalling onto a solo composition IS the item too", () => {
    const ref: PlacementRef = {
      kind: "element",
      containerId: "canvas-1",
      elementId: "el-portal-solo",
    };
    expect(placementItemFor(ref, lookup)).toEqual({ kind: "terminal", containerId: "solo-1" });

    // One door: a canvas terminal is released and merged through the same classification
    // a sidebar row uses, so no caller tests the arity of a composition for itself.
    const released = resolvePlacement(ref, DESTINATIONS.unplaced, lookup);
    expect(released.ok && released.op).toBe("unplace");
    const merged = resolvePlacement(ref, DESTINATIONS.tile, lookup);
    expect(merged.ok && merged.op).toBe("add_tile");
    expect(merged.ok && merged.item.kind).toBe("terminal");
  });

  test("an element ref portalling onto a multi-tile composition stays a composition", () => {
    const ref: PlacementRef = {
      kind: "element",
      containerId: "canvas-1",
      elementId: "el-portal-multi",
    };
    expect(placementItemFor(ref, lookup)).toEqual({ kind: "composition", containerId: "multi-2" });
    const refused = resolvePlacement(ref, DESTINATIONS.tile, lookup);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.denial.rule).toBe(PLACEMENT_GUARDS.solo_only.rule);
  });

  test("a terminal with no home is unknown, not homeless", () => {
    const ref: PlacementRef = { kind: "terminal", terminalId: "ghost" };
    expect(placementItemFor(ref, lookup)).toBeNull();
    const result = resolvePlacement(ref, DESTINATIONS.canvas, lookup);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.denial.rule).toBe("unknown_ref");
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
    expect(itemTraitsFor("text", lookup).homed).toBe("on_claim");
    // Needs no home: a stroke exists in the document that holds it.
    expect(itemTraitsFor("draw", lookup).homed).toBe("inline");
    // A panel is a rendering of a plugin contribution, not an object with a document:
    // there is no composition for it to acquire, so the question does not apply.
    expect(ITEM_KINDS.panel.homed).toBeNull();
  });
});

describe("placement guards", () => {
  test("no_self_embed refuses a container placed into itself, however it is addressed", () => {
    const cases: readonly {
      readonly ref: PlacementRef;
      readonly to: PlacementDestination;
    }[] = [
      // The container itself, dropped on its own canvas as a portal.
      {
        ref: { kind: "container", containerId: "canvas-1" },
        to: { kind: "canvas", containerId: "canvas-1", x: 0, y: 0 },
      },
      // The same container, composed onto one of its own elements.
      {
        ref: { kind: "container", containerId: "canvas-1" },
        to: {
          kind: "compose",
          containerId: "canvas-1",
          targetElementId: "el-portal-solo",
          edge: "left",
        },
      },
      // Addressed through a portal element that lives on a different canvas.
      {
        ref: { kind: "element", containerId: "canvas-1", elementId: "el-portal-canvas" },
        to: { kind: "compose", containerId: "canvas-2", targetElementId: "el-text", edge: "top" },
      },
      // Identity is answered before arity: a composition into ITSELF is self-embedding,
      // not a merge that failed for want of a single occupant.
      {
        ref: { kind: "container", containerId: "multi-2" },
        to: { kind: "tile", containerId: "multi-2", targetTileId: null, edge: null },
      },
    ];
    for (const { ref, to } of cases) {
      const result = resolvePlacement(ref, to, lookup);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.denial.rule).toBe(PLACEMENT_GUARDS.no_self_embed.rule);
      expect(result.denial.ref).toEqual(ref);
    }
  });

  test("a container is placeable into a DIFFERENT container of the same kind", () => {
    const result = resolvePlacement(
      { kind: "container", containerId: "canvas-2" },
      { kind: "compose", containerId: "canvas-1", targetElementId: "el-text", edge: "left" },
      lookup,
    );
    expect(result.ok && result.op).toBe("compose");
  });

  test("discipline_match refuses a destination form its container cannot honour", () => {
    const mismatched: readonly PlacementDestination[] = [
      { kind: "canvas", containerId: "multi-1", x: 0, y: 0 },
      { kind: "tile", containerId: "canvas-1", targetTileId: null, edge: null },
      { kind: "compose", containerId: "multi-1", targetElementId: "t1", edge: "left" },
    ];
    for (const to of mismatched) {
      const result = resolvePlacement({ kind: "terminal", terminalId: "terminal-1" }, to, lookup);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.denial.rule).toBe(PLACEMENT_GUARDS.discipline_match.rule);
    }
  });

  test("nowhere has no discipline, so an unplaceable item always lands there", () => {
    for (const ref of [
      REFS.terminal,
      {
        kind: "element",
        containerId: "canvas-1",
        elementId: "el-portal-solo",
      } satisfies PlacementRef,
    ]) {
      const result = resolvePlacement(ref, { kind: "unplaced" }, lookup);
      expect(result.ok && result.op).toBe("unplace");
    }
  });

  test("unresolvable ids are denials, never silent successes", () => {
    const unknownContainer = resolvePlacement(
      REFS.terminal,
      { kind: "tile", containerId: "ghost", targetTileId: null, edge: null },
      lookup,
    );
    expect(unknownContainer.ok).toBe(false);
    if (!unknownContainer.ok) expect(unknownContainer.denial.rule).toBe("unknown_container");

    const unknownContainerRef = resolvePlacement(
      { kind: "container", containerId: "ghost" },
      DESTINATIONS.canvas,
      lookup,
    );
    expect(unknownContainerRef.ok).toBe(false);
    if (!unknownContainerRef.ok) expect(unknownContainerRef.denial.rule).toBe("unknown_ref");

    const unknownElement = resolvePlacement(
      { kind: "element", containerId: "canvas-1", elementId: "ghost" },
      DESTINATIONS.unplaced,
      lookup,
    );
    expect(unknownElement.ok).toBe(false);
    if (!unknownElement.ok) expect(unknownElement.denial.rule).toBe("unknown_ref");
  });

  test("an element ref is resolved by what it places, not by how it is addressed", () => {
    const asElement = resolvePlacement(
      { kind: "element", containerId: "canvas-1", elementId: "el-portal-multi" },
      DESTINATIONS.tile,
      lookup,
    );
    const asContainer = resolvePlacement(
      { kind: "container", containerId: "multi-2" },
      DESTINATIONS.tile,
      lookup,
    );
    expect(asElement.ok).toBe(false);
    expect(asContainer.ok).toBe(false);
    if (!asElement.ok && !asContainer.ok) {
      expect(asElement.denial.rule).toBe(asContainer.denial.rule);
    }

    const terminalCopy = resolvePlacement(
      { kind: "element", containerId: "canvas-1", elementId: "el-portal-solo" },
      DESTINATIONS.tile,
      lookup,
    );
    expect(terminalCopy.ok && terminalCopy.op).toBe("add_tile");
  });
});

describe("placement wire shapes", () => {
  test("every ref form round-trips and nothing else parses", () => {
    const refs: readonly PlacementRef[] = [
      { kind: "terminal", terminalId: "s1" },
      { kind: "container", containerId: "p1" },
      { kind: "tile", containerId: "v1", tileId: "t1" },
      { kind: "element", containerId: "p1", elementId: "e1" },
    ];
    for (const ref of refs) {
      expect(PlacementRefSchema.parse(ref)).toEqual(ref);
    }
    expect(PlacementRefSchema.safeParse({ kind: "browser", url: "x" }).success).toBe(false);
    expect(PlacementRefSchema.safeParse({ kind: "terminal", terminalId: "" }).success).toBe(false);
    expect(
      PlacementRefSchema.safeParse({ kind: "tile", containerId: "v1", tileId: "t1", x: 1 }).success,
    ).toBe(false);
  });

  test("every destination form round-trips with its required geometry", () => {
    for (const destination of Object.values(DESTINATIONS)) {
      expect(PlacementDestinationSchema.parse(destination)).toEqual(destination);
    }
    expect(
      PlacementDestinationSchema.safeParse({ kind: "canvas", containerId: "p1", x: Infinity, y: 0 })
        .success,
    ).toBe(false);
    expect(
      PlacementDestinationSchema.safeParse({
        kind: "compose",
        containerId: "p1",
        targetElementId: "e1",
        edge: null,
      }).success,
    ).toBe(false);
    expect(
      PlacementDestinationSchema.safeParse({
        kind: "tile",
        containerId: "p1",
        targetTileId: null,
        edge: "middle",
      }).success,
    ).toBe(false);
    // Nowhere carries no fields: there is no order left for a position to index into.
    expect(PlacementDestinationSchema.safeParse({ kind: "unplaced", index: 0 }).success).toBe(
      false,
    );
  });

  test("the place envelope carries exactly a ref and a destination", () => {
    const request = { ref: REFS.terminal, destination: DESTINATIONS.canvas };
    expect(PlaceRequestSchema.parse(request)).toEqual(request);
    expect(PlaceRequestSchema.safeParse({ ...request, force: true }).success).toBe(false);
    expect(PlaceRequestSchema.safeParse({ ref: REFS.terminal }).success).toBe(false);
  });

  test("every declared op has exactly one response form", () => {
    const responses: readonly PlaceResponse[] = [
      { op: "portal", elementId: "e1" },
      { op: "extract", elementId: "e2" },
      { op: "move_element", elementId: "e3" },
      { op: "unplace", removed: 2 },
      { op: "add_tile", tileId: "t1" },
      { op: "compose", containerId: "v1", tileId: "t2" },
      // An exchange names both seats it moved between, so a caller can repaint the pair
      // without diffing a document to find out what the second one was.
      { op: "swap", placementId: "t3", withPlacementId: "t4" },
      // A displacement names the leaf the carry took and the home its occupant was moved
      // to, so a caller can reveal where the thing it pushed aside actually went.
      { op: "replace", tileId: "t1", displacedContainerId: "container-1" },
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
    // An embedded canvas needed no new home — the container already lives in the index — so
    // null is a real answer, not a missing field.
    expect(
      PlaceResponseSchema.parse({ op: "replace", tileId: "t1", displacedContainerId: null }),
    ).toEqual({ op: "replace", tileId: "t1", displacedContainerId: null });
    expect(PlaceResponseSchema.safeParse({ op: "replace", tileId: "t1" }).success).toBe(false);
  });

  test("a denial survives the action door's one string, rule first", () => {
    /*
      `core.space.place` refuses on the `refused` rung, which carries a message and nothing
      else — so the message LEADS with the algebra's rule, and reading it back is a lookup in
      the published closed set rather than prose-parsing. The ref and container do not
      travel: the caller sent one and can derive the other.
     */
    for (const rule of PLACEMENT_DENIAL_RULES) {
      const message = placementRefusal({
        rule,
        ref: REFS.composition,
        container: { kind: "composition", containerId: "multi-1" },
      });
      expect(message.startsWith(`${rule}:`)).toBe(true);
      expect(placementRefusalRule(message)).toBe(rule);
    }
    // A refusal from any other door is not a placement's, and must not be read as one.
    expect(placementRefusalRule("dependencies: core.terminals")).toBeNull();
    expect(placementRefusalRule("essential")).toBeNull();
    expect(placementRefusalRule("")).toBeNull();
    // The offenders name what was offered and what refused it, for a log line and a notice.
    expect(
      placementRefusal({
        rule: "not_accepted",
        ref: REFS.terminal,
        container: { kind: "canvas", containerId: "canvas-1" },
      }),
    ).toBe("not_accepted: terminal -> canvas");
  });

  test("a denial names a declared rule, the ref offered, and the container refusing", () => {
    for (const rule of PLACEMENT_DENIAL_RULES) {
      const denial = {
        rule,
        ref: REFS.terminal,
        container: { kind: "composition" as const, containerId: "multi-1" },
      };
      expect(PlacementDenialSchema.parse(denial)).toEqual(denial);
    }
    expect(
      PlacementDenialSchema.safeParse({
        rule: "because_i_said_so",
        ref: REFS.terminal,
        container: { kind: "unplaced" },
      }).success,
    ).toBe(false);
    expect(
      PlacementDenialSchema.safeParse({
        rule: "not_accepted" satisfies PlacementDenialRule,
        ref: REFS.terminal,
        container: { kind: "unplaced" },
      }).success,
    ).toBe(true);
  });
});

/**
 * THE ROSTER IS OPEN (#110, building the ruling ratified on #86).
 *
 * Four things have to be true at once for that to be more than a loosened parse: a
 * discipline nobody declares is refused BY NAME on both sides of a placement rather than
 * crashing or degrading to `canvas`; a discipline somebody declares composes without the
 * floor learning its name; the legality rows really do come from the declaration; and the
 * two shipped disciplines mean exactly what they meant when they were literals.
 */
describe("open discipline roster", () => {
  /** A container of the `grid` discipline, which this world's roster does not declare. */
  const ORPHAN = "orphan-1";

  test("a bounded string is the wire form, and existence is not the parse's question", () => {
    // Every id a plugin could legally declare parses. Whether one EXISTS is the roster's
    // answer, asked at the doors below, and a stored row must survive its plugin leaving.
    expect(ContainerDisciplineSchema.parse("canvas")).toBe("canvas");
    expect(ContainerDisciplineSchema.parse("spreadsheet")).toBe("spreadsheet");
    expect(ContainerDisciplineSchema.parse("acme-grid")).toBe("acme-grid");
    // Bounded, though: a discipline id appears in an index row, a placeholder and a
    // `manifold://` path, so it wears the same grammar every other published name does.
    expect(ContainerDisciplineSchema.safeParse("Canvas").success).toBe(false);
    expect(ContainerDisciplineSchema.safeParse("core.canvas").success).toBe(false);
    expect(ContainerDisciplineSchema.safeParse("").success).toBe(false);
    expect(ContainerDisciplineSchema.safeParse("x".repeat(33)).success).toBe(false);
  });

  test("placement INTO an undeclared discipline is refused by name, never downgraded", () => {
    /*
      The exact case #86's second question asked about: the plugin is uninstalled, not
      merely disabled. The container row is fine, so `unknown_container` would be a lie a
      principal would act on by recreating something they already have — and treating the
      undeclared discipline as ordinary furniture would let a terminal land in it as if it
      were a canvas, which is the silent downgrade the ratification forbade.
    */
    const dropped = resolvePlacement(
      REFS.terminal,
      { kind: "canvas", containerId: ORPHAN, x: 0, y: 0 },
      lookup,
    );
    expect(dropped.ok).toBe(false);
    if (!dropped.ok) expect(dropped.denial.rule).toBe("unknown_discipline");
    // Every form that names a container asks the same question and gets the same answer.
    const intoTree = resolvePlacement(
      REFS.terminal,
      { kind: "tile", containerId: ORPHAN, targetTileId: null, edge: null },
      lookup,
    );
    expect(intoTree.ok).toBe(false);
    if (!intoTree.ok) expect(intoTree.denial.rule).toBe("unknown_discipline");
    // And it is distinct from the container simply not being there.
    const missing = resolvePlacement(
      REFS.terminal,
      { kind: "canvas", containerId: "nope", x: 0, y: 0 },
      lookup,
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.denial.rule).toBe("unknown_container");
  });

  test("placing the orphaned container ITSELF is refused by name too", () => {
    /*
      The other side of the same truth. A container's item kind IS its discipline, so
      dragging `orphan-1` onto a canvas would otherwise resolve through
      `DEFAULT_ELEMENT_PLACEMENT_TRAITS` and author a portal onto a container nothing can
      paint. The refusal is the same word, because it is the same missing renderer.
    */
    const carried = resolvePlacement(
      { kind: "container", containerId: ORPHAN },
      DESTINATIONS.canvas,
      lookup,
    );
    expect(carried.ok).toBe(false);
    if (!carried.ok) expect(carried.denial.rule).toBe("unknown_discipline");
    // `unplaced` names no container, so the DESTINATION check never runs — and the item
    // check still does, which is exactly why the item side is checked separately.
    const released = resolvePlacement(
      { kind: "container", containerId: ORPHAN },
      DESTINATIONS.unplaced,
      lookup,
    );
    expect(released.ok).toBe(false);
    if (!released.ok) expect(released.denial.rule).toBe("unknown_discipline");
  });

  test("a THIRD-PARTY discipline composes without the floor learning its name", () => {
    /*
      The acceptance criterion in one assertion: `spreadsheet` appears in no table in
      `packages/protocol`, and a terminal tiles into it because its declaration says
      `tileable` is accepted and the `tile` form addresses it.
    */
    const spreadsheet: DisciplineDeclaration = {
      id: "spreadsheet",
      title: "Spreadsheet",
      item: { groups: ["tileable", "unplaceable"], guards: ["no_self_embed"], homed: "inline" },
      accepts: ["tileable"],
      guards: ["discipline_match"],
      destinations: ["tile"],
    };
    const withSheets: PlacementLookup = {
      ...lookup,
      disciplineOf: (id) => (id === "sheet-1" ? "spreadsheet" : (DISCIPLINES[id] ?? null)),
      discipline: (id) =>
        id === "spreadsheet" ? spreadsheet : (CONTRIBUTED_DISCIPLINES[id] ?? null),
    };
    const intoTree = resolvePlacement(
      REFS.terminal,
      { kind: "tile", containerId: "sheet-1", targetTileId: null, edge: null },
      withSheets,
    );
    expect(intoTree.ok && intoTree.op).toBe("add_tile");
    // Its own legality rows are enforced, not the canvas's: it declared only the `tile`
    // form, so a coordinate drop is the `discipline` refusal and not a silent success.
    const dropped = resolvePlacement(
      REFS.terminal,
      { kind: "canvas", containerId: "sheet-1", x: 0, y: 0 },
      withSheets,
    );
    expect(dropped.ok).toBe(false);
    if (!dropped.ok) expect(dropped.denial.rule).toBe("discipline");
    // And a spreadsheet CONTAINER places by the traits it declared: no `canvas_item_as_portal`,
    // so a canvas refuses it on containment rather than authoring a portal it cannot paint.
    const onCanvas = resolvePlacement(
      { kind: "container", containerId: "sheet-1" },
      DESTINATIONS.canvas,
      withSheets,
    );
    expect(onCanvas.ok).toBe(false);
    if (!onCanvas.ok) expect(onCanvas.denial.rule).toBe("not_accepted");
  });

  test("a discipline's OWN rows decide, so changing one changes the answer", () => {
    /*
      The rows are data, and this is what proves it: the same canvas, with `compose` removed
      from its declared destinations, refuses the merge it accepted a line earlier — no
      floor edit, no version bump, one field.
    */
    const merge = resolvePlacement(REFS.text, DESTINATIONS.compose, lookup);
    expect(merge.ok && merge.op).toBe("compose");
    const canvasDeclaration = CONTRIBUTED_DISCIPLINES["canvas"];
    if (canvasDeclaration === undefined) throw new Error("fixture lost its canvas");
    const noMerging: PlacementLookup = {
      ...lookup,
      discipline: (id) =>
        id === "canvas"
          ? { ...canvasDeclaration, destinations: ["canvas"] }
          : (CONTRIBUTED_DISCIPLINES[id] ?? null),
    };
    const refused = resolvePlacement(REFS.text, DESTINATIONS.compose, noMerging);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.denial.rule).toBe("discipline");
  });

  test("the floor holds no discipline row: the two shipped ones are contributions", () => {
    // The blast radius #110's probe named, asserted as absence. All four tables, plus the
    // guard, which SURVIVES — it is a discipline's declaration now, not a container kind's.
    expect(Object.keys(ITEM_KINDS)).toEqual(["terminal", "tile", "panel", "structure"]);
    expect(Object.keys(CANVAS_OPS)).toEqual(["terminal", "tile", "panel", "structure"]);
    expect(CONTAINER_KINDS).toEqual(["canvas", "composition", "unplaced"]);
    for (const form of Object.values(DESTINATION_KINDS)) {
      expect(Object.keys(form)).toEqual(["container", "declaration"]);
    }
    expect(PLACEMENT_GUARDS.discipline_match.site).toBe("container");
    expect([...CONTAINER_GUARD_NAMES]).toEqual(["discipline_match"]);
  });

  test("a declaration is bounded by the algebra's own vocabulary", () => {
    const sheets = {
      id: "spreadsheet",
      title: "Spreadsheet",
      item: { groups: ["tileable"], guards: [], homed: "inline" },
      accepts: ["tileable"],
      guards: ["discipline_match"],
      destinations: ["tile"],
    };
    expect(DisciplineDefSchema.safeParse(sheets).success).toBe(true);
    expect(DisciplineDefSchema.safeParse({ ...sheets, accepts: ["floaty"] }).success).toBe(false);
    expect(DisciplineDefSchema.safeParse({ ...sheets, destinations: ["sideways"] }).success).toBe(
      false,
    );
    // An ITEM-site guard in the container slot is the mistake the site split exists to
    // catch, and its mirror is already covered for traits.
    expect(DisciplineDefSchema.safeParse({ ...sheets, guards: ["solo_only"] }).success).toBe(false);
    // A declaration is the WHOLE description; a fifth field would be behavior outside it.
    expect(DisciplineDefSchema.safeParse({ ...sheets, render: "SheetView" }).success).toBe(false);
    // And the id obeys the wire grammar, so a declaration cannot name an unaddressable one.
    expect(DisciplineDefSchema.safeParse({ ...sheets, id: "Spread Sheet" }).success).toBe(false);
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
        /*
          The discipline vocabulary, both halves (#110): the SHAPE a plugin declares one
          with, and the composed roster this build holds. A reader that learned the
          `discipline` field from `Container` learns what its values can be from the same
          document, so there is no second door onto "what disciplines exist" (A2).
        */
        "discipline",
        "disciplines",
      ].sort(),
    );
    expect(Object.keys(published["items"] as object)).toEqual(itemKinds);
    expect(published["containers"]).toEqual(CONTAINER_KINDS);
    // No assembly was handed in, so the roster is the honest empty rather than a guess.
    expect(published["disciplines"]).toEqual([]);
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
      "unknown_ref",
      "unknown_container",
      /*
        The third identity rule, and the one the OPEN discipline roster made necessary
        (#110): the container row resolves, and nothing in the composed roster declares the
        discipline it wears. It is distinct from `unknown_container` — the container is
        there — and it is a refusal rather than a fallback, because resolving an undeclared
        discipline through the element default would silently turn every such container into
        a canvas, which is what #86's ratification forbade.
      */
      "unknown_discipline",
      /*
        Not a guard: a guard is a property of a KIND, and this one is a property of the
        gesture — whether the ref offered is a placement with a seat to trade, or an
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
    /*
      The container half is DECLARED now, so closure is checked against the declarations a
      roster can carry rather than against a floor table (#110): a discipline's item traits
      are item-site, its acceptance is group vocabulary, and its guards are container-site.
      The same three checks the floor rows used to get, applied to every contributor.
    */
    for (const discipline of Object.values(CONTRIBUTED_DISCIPLINES)) {
      for (const group of discipline.item.groups) expect(groups).toContain(group);
      for (const guard of discipline.item.guards) {
        expect(PLACEMENT_GUARDS[guard].site).toBe("item");
      }
      for (const group of discipline.accepts) expect(groups).toContain(group);
      for (const guard of discipline.guards) {
        expect(PLACEMENT_GUARDS[guard].site).toBe("container");
      }
      for (const form of discipline.destinations) {
        expect(Object.keys(DESTINATION_KINDS)).toContain(form);
      }
    }
    for (const guard of Object.values(PLACEMENT_GUARDS)) {
      expect(denialRules).toContain(guard.rule);
    }
    for (const op of Object.values(CANVAS_OPS)) expect(ops).toContain(op);
    for (const op of Object.values(DESTINATION_OPS)) expect(ops).toContain(op);
    const families: readonly string[] = CONTAINER_KINDS;
    for (const form of Object.values(DESTINATION_KINDS)) {
      expect(families).toContain(form.container);
      for (const group of form.declaration?.accepts ?? []) expect(groups).toContain(group);
    }
    /*
      Groups only matter if something accepts them, except `embeddable`, which declares a
      rendering capability (live depth-2 embedding) rather than a placement. The accepting
      side is now the disciplines plus the two self-declaring forms, which is exactly the
      set `CONTAINER_KINDS` used to be a table of.
    */
    const accepted = new Set<string>([
      ...Object.values(CONTRIBUTED_DISCIPLINES).flatMap((discipline) => [...discipline.accepts]),
      ...Object.values(DESTINATION_KINDS).flatMap((form) => [...(form.declaration?.accepts ?? [])]),
    ]);
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
    const draw = { groups: ["canvas_item"], guards: [], homed: "inline" };
    expect(PlacementTraitsSchema.safeParse(draw).success).toBe(true);
    expect(PlacementTraitsSchema.safeParse({ ...draw, groups: ["floaty"] }).success).toBe(false);
    expect(PlacementTraitsSchema.safeParse({ ...draw, homed: "later" }).success).toBe(false);
    // A container-site guard on an ITEM is the one subtle mistake the site split exists to
    // catch: `discipline_match` is asked of the destination, and an item claiming it would
    // declare a rule nothing ever evaluates.
    expect(PlacementTraitsSchema.safeParse({ ...draw, guards: ["discipline_match"] }).success).toBe(
      false,
    );
    expect(PlacementTraitsSchema.safeParse({ ...draw, guards: ["solo_only"] }).success).toBe(true);
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
    // An element contribution without a placement block takes the engine's default.
    expect(itemTraitsFor("draw", lookup)).toEqual(DEFAULT_ELEMENT_PLACEMENT_TRAITS);
    expect(DEFAULT_ELEMENT_PLACEMENT_TRAITS).toEqual({
      groups: ["canvas_item"],
      guards: [],
      homed: "inline",
    });
  });

  test("a kind is resolved floor first, then the composition, then the default", () => {
    // A floor kind can never be redefined by a manifest: the table wins by order.
    const shadowed: PlacementLookup = {
      ...lookup,
      itemTraits: () => ({ groups: ["canvas_item"], guards: [], homed: "inline" }),
    };
    expect(itemTraitsFor("terminal", shadowed)).toEqual(ITEM_KINDS.terminal);
    // A contributed kind resolves to what its manifest declared.
    expect(itemTraitsFor("text", lookup)).toEqual({
      groups: ["tileable", "canvas_item"],
      guards: [],
      homed: "on_claim",
    });
    // A kind no composition claims is ordinary canvas furniture rather than a refusal
    // about who is installed: the element is sitting in a document either way.
    expect(itemTraitsFor("chart", lookup)).toEqual(DEFAULT_ELEMENT_PLACEMENT_TRAITS);
  });

  test("a contributed kind places by its declared traits, floor kinds untouched", () => {
    // `text` is tileable BECAUSE core.notes said so — the engine has no row for it — and a
    // canvas MOVES an element it holds, which is a floor ruling about canvases (§12).
    const tileDrop = resolvePlacement(REFS.text, DESTINATIONS.tile, lookup);
    expect(tileDrop.ok && tileDrop.op).toBe("add_tile");
    const moved = resolvePlacement(REFS.text, DESTINATIONS.canvas, lookup);
    expect(moved.ok && moved.op).toBe("move_element");
    // Take the declaration away and the same gesture is refused by group containment: the
    // traits, not the engine, are what made it legal.
    const unclaimed: PlacementLookup = { ...lookup, itemTraits: () => null };
    const refused = resolvePlacement(REFS.text, DESTINATIONS.tile, unclaimed);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.denial.rule).toBe("not_accepted");
    expect(canvasOpFor("text", lookup)).toBe("move_element");
    expect(canvasOpFor("chart", lookup)).toBe("move_element");
    expect(canvasOpFor("terminal", lookup)).toBe("portal");
    /*
      A CONTAINER landing on a canvas is a portal whatever discipline it wears, and that is
      one floor ruling now rather than a `canvas:`/`composition:` pair in `CANVAS_OPS`
      (#110). The table holds neither name; the answer comes from the roster.
    */
    expect(canvasOpFor("composition", lookup)).toBe("portal");
    expect(canvasOpFor("canvas", lookup)).toBe("portal");
    expect(Object.keys(CANVAS_OPS)).not.toContain("composition");
  });
});
