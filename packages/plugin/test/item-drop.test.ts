import { describe, expect, test } from "bun:test";
import {
  PLACEMENT_DENIAL_RULES,
  resolvePlacement,
  type Container,
  type PlacementDenialRule,
  type PlacementDestination,
  type PlacementItem,
  type PlacementRef,
  type PluginManifest,
  type PluginRoster,
  type SceneElement,
} from "@manifold/protocol";
import { createPlacementLookup, denialMessage, itemDenialMessage } from "../src/item-drop.ts";
import { envelopeRef, type ItemEnvelope } from "../src/item-envelope.ts";

function container(id: string, discipline: Container["discipline"]): Container {
  return { id, name: id, createdAt: 0, discipline };
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
  { ...box, id: "el-portal", type: "portal", containerId: "comp-1" },
  { ...box, id: "el-canvas", type: "portal", containerId: "canvas-2" },
  { ...box, id: "el-ghost", type: "portal", containerId: "gone" },
];

/** `solo-1` holds one terminal; `comp-1` and `comp-2` hold several, so neither is absorbable. */
const SOLO_OCCUPANTS: ReadonlyMap<string, PlacementItem> = new Map([
  ["solo-1", { kind: "terminal", containerId: "solo-1" } satisfies PlacementItem],
]);

/**
 * The composition the renderer holds, as the roster publishes it: `text` declares its own
 * traits, `draw` declares none and takes the engine default. The lookup reads element
 * legality — and the noun a refusal calls the kind — from HERE rather than from a table in
 * the engine (ADR 0013 §12), so a preview judges a contributed kind by exactly what its
 * plugin said about it.
 */
function element(
  id: string,
  type: string,
  title: string,
  placement?: PluginManifest["contributes"]["elements"][number]["placement"],
): PluginRoster[number] {
  return {
    manifest: {
      id,
      version: "1.0.0",
      title: id,
      description: id,
      capabilities: [],
      contributes: {
        panels: [],
        sections: [],
        elements: [{ type, title, ...(placement === undefined ? {} : { placement }) }],
        tools: [],
        events: [],
      },
    },
    enabled: true,
    source: "builtin",
    actions: [],
  };
}

/**
 * The DISCIPLINE half of the same published roster (#110). `canvas` and `composition` are
 * contributions now, not floor rows, so a renderer that wants to judge a drop has to be
 * handed a roster that declares them — which is exactly what the browser holds in
 * production, and what makes an UNINSTALLED discipline distinguishable from a typo.
 */
function disciplineEntry(id: string, declaration: DisciplineDef): PluginRoster[number] {
  return {
    manifest: {
      id,
      version: "1.0.0",
      title: id,
      description: id,
      capabilities: [],
      contributes: {
        panels: [],
        sections: [],
        elements: [],
        disciplines: [declaration],
        tools: [],
        events: [],
      },
    },
    enabled: true,
    source: "builtin",
    actions: [],
  };
}

/** The declaration shape as a MANIFEST carries it: mutable arrays, exactly as zod infers. */
type DisciplineDef = NonNullable<PluginManifest["contributes"]["disciplines"]>[number];

const CANVAS_DISCIPLINE: DisciplineDef = {
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
};

const COMPOSITION_DISCIPLINE: DisciplineDef = {
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
};

const ROSTER: PluginRoster = [
  element("core.notes", "text", "Note", {
    groups: ["tileable", "canvas_item"],
    guards: [],
    homed: "on_claim",
  }),
  element("core.draw", "draw", "Stroke"),
  disciplineEntry("core.canvas", CANVAS_DISCIPLINE),
  disciplineEntry("core.compositions", COMPOSITION_DISCIPLINE),
];

const lookup = createPlacementLookup({
  containers: [
    container("canvas-1", "canvas"),
    container("canvas-2", "canvas"),
    container("comp-1", "composition"),
    container("comp-2", "composition"),
    container("solo-1", "composition"),
  ],
  self: { containerId: "canvas-1", discipline: "canvas" },
  elements: new Map(ELEMENTS.map((element) => [element.id, element] as const)),
  terminalHomes: new Map([["s1", "solo-1"]]),
  soloOccupants: SOLO_OCCUPANTS,
  roster: ROSTER,
});

describe("props-backed lookup", () => {
  test("a container's discipline comes from the index the sidebar already holds", () => {
    expect(lookup.disciplineOf("canvas-2")).toBe("canvas");
    expect(lookup.disciplineOf("comp-1")).toBe("composition");
    expect(lookup.disciplineOf("gone")).toBeNull();
  });

  test("the container being rendered answers for itself before its row arrives", () => {
    const newborn = createPlacementLookup({
      containers: [],
      self: { containerId: "comp-new", discipline: "composition" },
      elements: new Map(),
      terminalHomes: new Map(),
      soloOccupants: new Map(),
      roster: ROSTER,
    });
    expect(newborn.disciplineOf("comp-new")).toBe("composition");
  });

  test("a terminal's home is where it lives, and an unknown terminal has none", () => {
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
      kind: "composition",
      containerId: "solo-1",
    });
    expect(lookup.elementItem("canvas-1", "el-note")).toEqual({ kind: "text", containerId: null });
    expect(lookup.elementItem("canvas-1", "el-ink")).toEqual({ kind: "draw", containerId: null });
    expect(lookup.elementItem("canvas-1", "el-portal")).toEqual({
      kind: "composition",
      containerId: "comp-1",
    });
    expect(lookup.elementItem("canvas-1", "el-canvas")).toEqual({
      kind: "canvas",
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
    envelope: { kind: "composition", containerId: "comp-1" },
    destination: { kind: "tile", containerId: "comp-1", targetTileId: "t1", edge: "right" },
    expected: "A composition cannot be placed inside itself.",
  },
  {
    // "Compositions merge, never nest": what refuses is arity, not identity.
    name: "a composition of several dropped into another composition",
    envelope: { kind: "composition", containerId: "comp-1" },
    destination: { kind: "tile", containerId: "comp-2", targetTileId: "t1", edge: "right" },
    expected: "A composition holds more than one item, so it cannot merge into another.",
  },
  {
    name: "a composition portal composed onto a canvas node",
    envelope: { kind: "element", containerId: "canvas-1", elementId: "el-portal" },
    destination: {
      kind: "compose",
      containerId: "canvas-1",
      targetElementId: "el-term",
      edge: "left",
    },
    expected: "A composition holds more than one item, so it cannot merge into another.",
  },
  {
    name: "a canvas dropped into itself",
    envelope: { kind: "canvas", containerId: "canvas-1" },
    destination: { kind: "canvas", containerId: "canvas-1", x: 0, y: 0 },
    expected: "A canvas cannot be placed inside itself.",
  },
  {
    name: "a note released on the index",
    envelope: { kind: "element", containerId: "canvas-1", elementId: "el-note" },
    destination: { kind: "unplaced" },
    expected: "A note does not go in the index.",
  },
  {
    name: "a stroke dropped on a composition leaf",
    envelope: { kind: "element", containerId: "canvas-1", elementId: "el-ink" },
    destination: { kind: "tile", containerId: "comp-1", targetTileId: "t1", edge: "top" },
    expected: "A stroke does not go in a composition.",
  },
  // `tile → unplaced` is deliberately absent: the cell flipped to LEGAL when `tile`
  // became `unplaceable` (the fullscreen tile-minimize now re-homes instead of notifying).
  {
    /*
      The sentence names the container the drop AIMED AT, not the family the destination
      form belongs to (#110): `canvas-1` is a canvas, and a `tile` drop on it is refused
      because a canvas's declaration does not admit that form. Before the discipline roster
      opened this read "in a composition" — the form's family — which named a container
      nobody was pointing at.
    */
    name: "a terminal placed into a canvas",
    envelope: { kind: "terminal", terminalId: "s1" },
    destination: { kind: "tile", containerId: "canvas-1", targetTileId: null, edge: null },
    expected: "A terminal cannot be placed that way in a canvas.",
  },
  {
    name: "a terminal whose terminal is gone",
    envelope: { kind: "terminal", terminalId: "vanished" },
    destination: { kind: "canvas", containerId: "canvas-2", x: 0, y: 0 },
    expected: "That item no longer exists.",
  },
  {
    name: "an item that vanished mid-drag",
    envelope: { kind: "element", containerId: "canvas-1", elementId: "nope" },
    destination: { kind: "canvas", containerId: "canvas-2", x: 0, y: 0 },
    expected: "That item no longer exists.",
  },
];

describe("denial prose", () => {
  test("every refused pair the UI offers reads as a sentence about the two nouns", () => {
    for (const { name, envelope, destination, expected } of CASES) {
      const resolution = resolvePlacement(envelopeRef(envelope), destination, lookup);
      expect(`${name}: ${String(resolution.ok)}`).toBe(`${name}: false`);
      if (resolution.ok) continue;
      expect(`${name}: ${denialMessage(resolution.denial, lookup)}`).toBe(`${name}: ${expected}`);
    }
  });

  test("an unknown container denial names the id without inventing a discipline", () => {
    const ref: PlacementRef = { kind: "terminal", terminalId: "s1" };
    const destination: PlacementDestination = {
      kind: "tile",
      containerId: "gone",
      targetTileId: null,
      edge: null,
    };
    const resolution = resolvePlacement(ref, destination, lookup);
    if (resolution.ok) throw new Error("refusal expected");
    expect(resolution.denial.rule).toBe("unknown_container");
    const message = denialMessage(resolution.denial, lookup);
    expect(itemDenialMessage(resolution.denial, { kind: "terminal", containerId: null }, lookup)).toBe(
      message,
    );
    expect(message).toContain("gone");
    expect(message).toContain("not known to this workspace");
    expect(message).not.toContain("composition");
    expect(message).not.toContain("canvas");
  });

  test("every declared rule has prose, so no refusal can render blank", () => {
    for (const rule of PLACEMENT_DENIAL_RULES satisfies readonly PlacementDenialRule[]) {
      const message = denialMessage(
        {
          rule,
          ref: { kind: "terminal", terminalId: "s1" },
          container: { kind: "composition", containerId: "comp-1" },
        },
        lookup,
      );
      expect(message.length).toBeGreaterThan(0);
      expect(message.endsWith(".")).toBe(true);
    }
  });

  /*
   * The claim behind widening `assess(destination, ref?)`: legality is a question
   * about a REF, never about who happens to be dragging. A viewer holding a peer's
   * ref and its own lookup reaches the same verdict the peer's own browser does,
   * which is what lets a collaborator's preview wear the refusal instead of painting a
   * legal-looking cue over a drop the server will reject.
   */
  test("a ref nobody here is carrying is judged exactly as the carrier's own is", () => {
    const foreign: PlacementRef = { kind: "container", containerId: "comp-2" };
    const intoComposition: PlacementDestination = {
      kind: "tile",
      containerId: "comp-1",
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
      resolvePlacement({ kind: "terminal", terminalId: "s1" }, intoComposition, lookup).ok,
    ).toBe(true);
  });

  test("legal placements are the majority case and produce no prose at all", () => {
    const legal: readonly { readonly envelope: ItemEnvelope; readonly to: PlacementDestination }[] =
      [
        // A container onto bare canvas authors a portal — and so does a terminal, which is
        // the same op now that a canvas terminal IS a portal onto its home.
        {
          envelope: { kind: "composition", containerId: "comp-1" },
          to: { kind: "canvas", containerId: "canvas-1", x: 10, y: 20 },
        },
        {
          envelope: { kind: "terminal", terminalId: "s1" },
          to: { kind: "canvas", containerId: "canvas-2", x: 10, y: 20 },
        },
        {
          envelope: { kind: "terminal", terminalId: "s1" },
          to: { kind: "tile", containerId: "comp-1", targetTileId: null, edge: null },
        },
        // MERGE: the canvas node dragged is a portal onto a solo composition, and resolution
        // looks through it to the terminal — so the same drop that would refuse a real
        // composition absorbs this one as an ordinary tile placement.
        {
          envelope: { kind: "element", containerId: "canvas-1", elementId: "el-term" },
          to: { kind: "tile", containerId: "comp-1", targetTileId: "t1", edge: "right" },
        },
        // Notes tile as of this wave.
        {
          envelope: { kind: "element", containerId: "canvas-1", elementId: "el-note" },
          to: { kind: "tile", containerId: "comp-1", targetTileId: "t1", edge: "bottom" },
        },
        {
          envelope: { kind: "tile", containerId: "comp-1", tileId: "t1" },
          to: { kind: "canvas", containerId: "canvas-1", x: 0, y: 0 },
        },
        // Unplacing a terminal is legal from anywhere: it is the one item that goes nowhere.
        { envelope: { kind: "terminal", terminalId: "s1" }, to: { kind: "unplaced" } },
      ];
    const ops = legal.map((entry) => {
      const resolution = resolvePlacement(envelopeRef(entry.envelope), entry.to, lookup);
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
