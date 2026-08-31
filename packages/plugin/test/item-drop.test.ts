import { describe, expect, test } from "bun:test";
import {
  PLACEMENT_DENIAL_RULES,
  resolvePlacement,
  type Pad,
  type PlacementDenialRule,
  type PlacementDestination,
  type PlacementItem,
  type PlacementSurface,
  type SceneElement,
} from "@manifold/protocol";
import { createPlacementLookup, denialMessage } from "../src/item-drop.ts";
import { envelopeSurface, type ItemEnvelope } from "../src/item-envelope.ts";

function pad(id: string, layout: Pad["layout"]): Pad {
  return { id, name: id, createdAt: 0, layout };
}

const box = { x: 0, y: 0, width: 100, height: 100, zIndex: 1 };

/**
 * A terminal on a canvas is a PORTAL onto the composition it lives in — there is no terminal
 * element kind any more — so `el-term` here is exactly what the renderer holds for one.
 */
const ELEMENTS: readonly SceneElement[] = [
  { ...box, id: "el-term", type: "portal", containerId: "solo-1" },
  { ...box, id: "el-note", type: "text", text: "hi", fontSize: 20, color: "#ffffff" },
  { ...box, id: "el-ink", type: "draw", points: [0, 0, 1, 1], strokeWidth: 2, color: "#ffffff" },
  { ...box, id: "el-widget", type: "portal", containerId: "comp-1" },
  { ...box, id: "el-board", type: "portal", containerId: "canvas-2" },
  { ...box, id: "el-ghost", type: "portal", containerId: "gone" },
];

/** `solo-1` holds one terminal; `comp-1` and `comp-2` hold several, so neither is absorbable. */
const SOLO_OCCUPANTS: ReadonlyMap<string, PlacementItem> = new Map([
  ["solo-1", { kind: "terminal", containerId: "solo-1" } satisfies PlacementItem],
]);

const lookup = createPlacementLookup({
  pads: [
    pad("canvas-1", "canvas"),
    pad("canvas-2", "canvas"),
    pad("comp-1", "tiled"),
    pad("comp-2", "tiled"),
    pad("solo-1", "tiled"),
  ],
  self: { padId: "canvas-1", layout: "canvas" },
  elements: new Map(ELEMENTS.map((element) => [element.id, element] as const)),
  terminalHomes: new Map([["s1", "solo-1"]]),
  soloOccupants: SOLO_OCCUPANTS,
});

describe("props-backed lookup", () => {
  test("a container's discipline comes from the index the sidebar already holds", () => {
    expect(lookup.padLayout("canvas-2")).toBe("canvas");
    expect(lookup.padLayout("comp-1")).toBe("tiled");
    expect(lookup.padLayout("gone")).toBeNull();
  });

  test("the container being rendered answers for itself before its row arrives", () => {
    const newborn = createPlacementLookup({
      pads: [],
      self: { padId: "comp-new", layout: "tiled" },
      elements: new Map(),
      terminalHomes: new Map(),
      soloOccupants: new Map(),
    });
    expect(newborn.padLayout("comp-new")).toBe("tiled");
  });

  test("a terminal's home is where it lives, and an unknown session has none", () => {
    expect(lookup.terminalHome("s1")).toBe("solo-1");
    expect(lookup.terminalHome("gone")).toBeNull();
  });

  test("a composition of one reports its occupant; a composition of several reports nothing", () => {
    expect(lookup.soloOccupant("solo-1")).toEqual({ kind: "terminal", containerId: "solo-1" });
    expect(lookup.soloOccupant("comp-1")).toBeNull();
  });

  test("an element is classified by the container it POINTS AT, arity aside", () => {
    // Classification is per discipline; looking THROUGH a solo composition to the terminal in
    // it is resolution's job, proved in the merge case below.
    expect(lookup.elementItem("canvas-1", "el-term")).toEqual({
      kind: "view",
      containerId: "solo-1",
    });
    expect(lookup.elementItem("canvas-1", "el-note")).toEqual({ kind: "text", containerId: null });
    expect(lookup.elementItem("canvas-1", "el-ink")).toEqual({ kind: "draw", containerId: null });
    expect(lookup.elementItem("canvas-1", "el-widget")).toEqual({
      kind: "view",
      containerId: "comp-1",
    });
    expect(lookup.elementItem("canvas-1", "el-board")).toEqual({
      kind: "canvas-pad",
      containerId: "canvas-2",
    });
  });

  test("an unknown element, an unknown target and a foreign container all resolve to nothing", () => {
    expect(lookup.elementItem("canvas-1", "nope")).toBeNull();
    // A portal onto a container this renderer cannot see places nothing knowable.
    expect(lookup.elementItem("canvas-1", "el-ghost")).toBeNull();
    // Another container's document is not visible without a socket, and nothing addresses it.
    expect(lookup.elementItem("canvas-2", "el-term")).toBeNull();
  });
});

/** The pairs the sidebar, the canvas and the composition renderer actually offer. */
const CASES: readonly {
  readonly name: string;
  readonly envelope: ItemEnvelope;
  readonly destination: PlacementDestination;
  readonly expected: string;
}[] = [
  {
    name: "a composition dropped on its own leaf",
    envelope: { kind: "composition", padId: "comp-1" },
    destination: { kind: "tile", padId: "comp-1", targetTileId: "t1", edge: "right" },
    expected: "A composition cannot be placed inside itself.",
  },
  {
    // "Compositions merge, never nest": what refuses is arity, not identity.
    name: "a composition of several dropped into another composition",
    envelope: { kind: "composition", padId: "comp-1" },
    destination: { kind: "tile", padId: "comp-2", targetTileId: "t1", edge: "right" },
    expected: "A composition holds more than one item, so it cannot merge into another.",
  },
  {
    name: "a composition widget composed onto a canvas node",
    envelope: { kind: "element", padId: "canvas-1", elementId: "el-widget" },
    destination: { kind: "compose", padId: "canvas-1", targetElementId: "el-term", edge: "left" },
    expected: "A composition holds more than one item, so it cannot merge into another.",
  },
  {
    name: "a canvas dropped into itself",
    envelope: { kind: "canvas", padId: "canvas-1" },
    destination: { kind: "canvas", padId: "canvas-1", x: 0, y: 0 },
    expected: "A canvas cannot be placed inside itself.",
  },
  {
    name: "a note released on the index",
    envelope: { kind: "element", padId: "canvas-1", elementId: "el-note" },
    destination: { kind: "unplaced" },
    expected: "A note does not go in the index.",
  },
  {
    name: "a stroke dropped on a composition leaf",
    envelope: { kind: "element", padId: "canvas-1", elementId: "el-ink" },
    destination: { kind: "tile", padId: "comp-1", targetTileId: "t1", edge: "top" },
    expected: "A stroke does not go in a composition.",
  },
  // `tile → unplaced` is deliberately absent: the cell flipped to LEGAL when `tile`
  // became `unplaceable` (the fullscreen tile-minimize now re-homes instead of toasting).
  {
    name: "a terminal tiled into a canvas",
    envelope: { kind: "terminal", sessionId: "s1" },
    destination: { kind: "tile", padId: "canvas-1", targetTileId: null, edge: null },
    expected: "A terminal cannot be placed that way in a composition.",
  },
  {
    name: "a terminal dropped into a container that is gone",
    envelope: { kind: "terminal", sessionId: "s1" },
    destination: { kind: "canvas", padId: "gone", x: 0, y: 0 },
    expected: "That container no longer exists.",
  },
  {
    name: "a terminal whose session is gone",
    envelope: { kind: "terminal", sessionId: "vanished" },
    destination: { kind: "canvas", padId: "canvas-2", x: 0, y: 0 },
    expected: "That item no longer exists.",
  },
  {
    name: "an item that vanished mid-drag",
    envelope: { kind: "element", padId: "canvas-1", elementId: "nope" },
    destination: { kind: "canvas", padId: "canvas-2", x: 0, y: 0 },
    expected: "That item no longer exists.",
  },
];

describe("denial prose", () => {
  test("every refused pair the UI offers reads as a sentence about the two nouns", () => {
    for (const { name, envelope, destination, expected } of CASES) {
      const resolution = resolvePlacement(envelopeSurface(envelope), destination, lookup);
      expect(`${name}: ${String(resolution.ok)}`).toBe(`${name}: false`);
      if (resolution.ok) continue;
      expect(`${name}: ${denialMessage(resolution.denial, lookup)}`).toBe(`${name}: ${expected}`);
    }
  });

  test("every declared rule has prose, so no refusal can render blank", () => {
    for (const rule of PLACEMENT_DENIAL_RULES satisfies readonly PlacementDenialRule[]) {
      const message = denialMessage(
        {
          rule,
          surface: { kind: "terminal", sessionId: "s1" },
          container: { kind: "view", padId: "comp-1" },
        },
        lookup,
      );
      expect(message.length).toBeGreaterThan(0);
      expect(message.endsWith(".")).toBe(true);
    }
  });

  /*
   * The claim behind widening `assess(destination, surface?)`: legality is a question
   * about a SURFACE, never about who happens to be dragging. A viewer holding a peer's
   * surface and its own lookup reaches the same verdict the peer's own browser does,
   * which is what lets a collaborator's preview wear the refusal instead of painting a
   * legal-looking cue over a drop the server will reject.
   */
  test("a surface nobody here is carrying is judged exactly as the carrier's own is", () => {
    const foreign: PlacementSurface = { kind: "pad", padId: "comp-2" };
    const intoComposition: PlacementDestination = {
      kind: "tile",
      padId: "comp-1",
      targetTileId: "t1",
      edge: "right",
    };
    const resolution = resolvePlacement(foreign, intoComposition, lookup);
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(denialMessage(resolution.denial, lookup)).toBe(
      "A composition holds more than one item, so it cannot merge into another.",
    );
    // And a legal one stays legal: absence of a cue, not a fabricated denial.
    expect(
      resolvePlacement({ kind: "terminal", sessionId: "s1" }, intoComposition, lookup).ok,
    ).toBe(true);
  });

  test("legal placements are the majority case and produce no prose at all", () => {
    const legal: readonly { readonly envelope: ItemEnvelope; readonly to: PlacementDestination }[] =
      [
        // A container onto bare canvas authors a portal — and so does a terminal, which is
        // the same op now that a canvas terminal IS a portal onto its home.
        {
          envelope: { kind: "composition", padId: "comp-1" },
          to: { kind: "canvas", padId: "canvas-1", x: 10, y: 20 },
        },
        {
          envelope: { kind: "terminal", sessionId: "s1" },
          to: { kind: "canvas", padId: "canvas-2", x: 10, y: 20 },
        },
        {
          envelope: { kind: "terminal", sessionId: "s1" },
          to: { kind: "tile", padId: "comp-1", targetTileId: null, edge: null },
        },
        // MERGE: the canvas node dragged is a portal onto a solo composition, and resolution
        // looks through it to the terminal — so the same drop that would refuse a real
        // composition absorbs this one as an ordinary tile placement.
        {
          envelope: { kind: "element", padId: "canvas-1", elementId: "el-term" },
          to: { kind: "tile", padId: "comp-1", targetTileId: "t1", edge: "right" },
        },
        // Notes tile as of this wave.
        {
          envelope: { kind: "element", padId: "canvas-1", elementId: "el-note" },
          to: { kind: "tile", padId: "comp-1", targetTileId: "t1", edge: "bottom" },
        },
        {
          envelope: { kind: "tile", containerId: "comp-1", tileId: "t1" },
          to: { kind: "canvas", padId: "canvas-1", x: 0, y: 0 },
        },
        // Unplacing a terminal is legal from anywhere: it is the one item that goes nowhere.
        { envelope: { kind: "terminal", sessionId: "s1" }, to: { kind: "unplaced" } },
      ];
    const ops = legal.map((entry) => {
      const resolution = resolvePlacement(envelopeSurface(entry.envelope), entry.to, lookup);
      return resolution.ok ? resolution.op : `denied:${resolution.denial.rule}`;
    });
    expect(ops).toEqual([
      "portal",
      "portal",
      "add_tile",
      "add_tile",
      "add_tile",
      "extract",
      "unplace",
    ]);
  });
});
