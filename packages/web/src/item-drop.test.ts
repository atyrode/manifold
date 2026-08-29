import { describe, expect, test } from "bun:test";
import {
  PLACEMENT_DENIAL_RULES,
  resolvePlacement,
  type Pad,
  type PlacementDenialRule,
  type PlacementDestination,
  type SceneElement,
} from "@manifold/protocol";
import { createPlacementLookup, denialMessage } from "./item-drop.ts";
import { envelopeSurface, type ItemEnvelope } from "./item-envelope.ts";

function pad(id: string, layout: Pad["layout"]): Pad {
  return { id, name: id, createdAt: 0, layout, transient: false };
}

const box = { x: 0, y: 0, width: 100, height: 100, zIndex: 1 };
const ELEMENTS: readonly SceneElement[] = [
  { ...box, id: "el-term", type: "terminal", sessionId: "s1" },
  { ...box, id: "el-note", type: "text", text: "hi", fontSize: 20, color: "#ffffff" },
  { ...box, id: "el-ink", type: "draw", points: [0, 0, 1, 1], strokeWidth: 2, color: "#ffffff" },
  { ...box, id: "el-widget", type: "portal", containerId: "comp-1" },
  { ...box, id: "el-board", type: "portal", containerId: "canvas-2" },
  { ...box, id: "el-ghost", type: "portal", containerId: "gone" },
];

const lookup = createPlacementLookup({
  pads: [pad("canvas-1", "canvas"), pad("canvas-2", "canvas"), pad("comp-1", "tiled")],
  self: { padId: "canvas-1", layout: "canvas" },
  elements: new Map(ELEMENTS.map((element) => [element.id, element] as const)),
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
    });
    expect(newborn.padLayout("comp-new")).toBe("tiled");
  });

  test("an element is classified by what it PLACES, portals included", () => {
    expect(lookup.elementItem("canvas-1", "el-term")).toEqual({
      kind: "terminal",
      containerId: null,
    });
    expect(lookup.elementItem("canvas-1", "el-note")).toEqual({ kind: "text", containerId: null });
    expect(lookup.elementItem("canvas-1", "el-ink")).toEqual({ kind: "draw", containerId: null });
    // A widget onto a composition places a composition; onto a canvas, a canvas.
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
    name: "a composition dropped on a composition leaf",
    envelope: { kind: "composition", padId: "comp-1" },
    destination: { kind: "tile", padId: "comp-1", targetTileId: "t1", edge: "right" },
    expected: "A composition does not go in a composition.",
  },
  {
    name: "a composition dropped on its own canvas widget",
    envelope: { kind: "element", padId: "canvas-1", elementId: "el-widget" },
    destination: { kind: "compose", padId: "canvas-1", targetElementId: "el-term", edge: "left" },
    expected: "A composition does not go in a composition.",
  },
  {
    name: "a canvas dropped into itself",
    envelope: { kind: "canvas", padId: "canvas-1" },
    destination: { kind: "canvas", padId: "canvas-1", x: 0, y: 0 },
    expected: "A canvas cannot be placed inside itself.",
  },
  {
    name: "a note dropped in the terminal pool",
    envelope: { kind: "element", padId: "canvas-1", elementId: "el-note" },
    destination: { kind: "pool" },
    expected: "A note does not go in the terminal pool.",
  },
  {
    name: "a stroke dropped on a composition leaf",
    envelope: { kind: "element", padId: "canvas-1", elementId: "el-ink" },
    destination: { kind: "tile", padId: "comp-1", targetTileId: "t1", edge: "top" },
    expected: "A stroke does not go in a composition.",
  },
  {
    name: "a tile dropped in the pool",
    envelope: { kind: "tile", containerId: "comp-1", tileId: "t1" },
    destination: { kind: "pool" },
    expected: "A tile does not go in the terminal pool.",
  },
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

  test("legal placements are the majority case and produce no prose at all", () => {
    const legal: readonly { readonly envelope: ItemEnvelope; readonly to: PlacementDestination }[] =
      [
        // The two gaps this pipeline closes: a container onto bare canvas authors a
        // portal, and a terminal onto a composition row lands as a tile.
        {
          envelope: { kind: "composition", padId: "comp-1" },
          to: { kind: "canvas", padId: "canvas-1", x: 10, y: 20 },
        },
        {
          envelope: { kind: "terminal", sessionId: "s1" },
          to: { kind: "tile", padId: "comp-1", targetTileId: null, edge: null },
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
      ];
    const ops = legal.map((entry) => {
      const resolution = resolvePlacement(envelopeSurface(entry.envelope), entry.to, lookup);
      return resolution.ok ? resolution.op : `denied:${resolution.denial.rule}`;
    });
    expect(ops).toEqual(["portal", "add_tile", "add_tile", "extract"]);
  });
});
