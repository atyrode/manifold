import { describe, expect, test } from "bun:test";
import {
  ROOT_TILE_ID,
  type CarriedItem,
  type CarryAim,
  type PlacementItem,
  type PlacementSurface,
  type TileLayout,
  type TileNode,
  type TileSurface,
} from "@manifold/protocol";

import type { RemoteTileCarry } from "../src/carry.ts";
import type { ItemDropAssessment } from "../src/item-drop.ts";
import { createTileDropStore } from "../src/tile-drop-store.ts";
import { tileProspect, type TileAim } from "../src/tile-geometry.ts";
import { asTileTree } from "../src/tile-snap.ts";
import { previewFor, sameAim, wireCarryAim, type TileDropContext } from "../src/use-tile-drop.ts";

const terminal = (sessionId: string): TileSurface => ({ kind: "terminal", sessionId });

function leaf(id: string, surface: TileSurface | null = null): TileNode {
  return { id, dir: null, ratios: [], children: [], surface };
}

/** `A | B`: a root row of two occupied leaves. */
const ROW: TileLayout = {
  [ROOT_TILE_ID]: {
    id: ROOT_TILE_ID,
    dir: "row",
    ratios: [1, 1],
    children: ["a", "b"],
    surface: null,
  },
  a: leaf("a", terminal("s-a")),
  b: leaf("b", terminal("s-b")),
};

/** One occupied leaf: a solo container, which is what a canvas widget usually shows. */
const SOLO: TileLayout = { [ROOT_TILE_ID]: leaf(ROOT_TILE_ID, terminal("s-solo")) };

const UNITS = {
  dividers: { x: 0.01, y: 0.02 },
  ring: { x: 0.02, y: 0.03 },
  rect: { left: 0, top: 0, width: 1000, height: 500 },
} as const;

/** A lookup that legalises everything, so a test measures geometry and not policy. */
const ALLOW = (): ItemDropAssessment | null => null;

function context(overrides: Partial<TileDropContext> = {}): TileDropContext {
  return {
    layout: ROW,
    containerId: "view",
    widget: null,
    units: UNITS,
    assess: ALLOW,
    ...overrides,
  };
}

/** A sidebar carry as it reaches any renderer: the address AND what it names. */
const SIDEBAR_TERMINAL: CarriedItem = {
  surface: { kind: "terminal", sessionId: "s-new" },
  item: { kind: "terminal", containerId: "home-new" },
};
const carrying = (surface: PlacementSurface, item: PlacementItem): CarriedItem => ({
  surface,
  item,
});

describe("the one state constructor", () => {
  test("one wire aim, one surface, one label, one layout — one state, every time", () => {
    const wire: CarryAim = {
      containerId: "view",
      tileId: "b",
      edge: "bottom",
      action: "place",
    };
    const first = previewFor(context(), wire, SIDEBAR_TERMINAL, "build");
    const second = previewFor(context(), wire, SIDEBAR_TERMINAL, "build");
    expect(first).not.toBeNull();
    expect(second).toEqual(first);
    // The state's aim IS the wire form: nothing in it can be a value only one producer
    // could fill (a fabricated `depth` was exactly that).
    expect(first?.aim).toEqual(wire);
  });

  /*
    THE invariant of the whole pipeline. The local path resolves a KERNEL aim and
    normalises it to the wire before building anything; a viewer receives that same wire
    aim and builds from it. If these two states ever differ, a dragger and their
    collaborators are looking at different previews of one gesture — which is the defect
    class the inversion exists to make unrepresentable, so it is asserted rather than
    reasoned about.
  */
  test("normalising a local kernel aim yields the state a peer builds from the same bytes", () => {
    const kernel: TileAim = { tileId: "b", edge: "bottom", action: "place", depth: 1 };
    const wire = wireCarryAim("view", kernel);
    const producer = previewFor(context(), wire, SIDEBAR_TERMINAL, "build");
    const viewer = previewFor(context(), { ...wire }, SIDEBAR_TERMINAL, "build");
    expect(producer).not.toBeNull();
    expect(viewer).toEqual(producer);
  });

  test("a deep kernel aim survives normalisation with every field the wire has", () => {
    const kernel: TileAim = {
      tileId: "a",
      edge: "right",
      action: "place",
      depth: 3,
      between: true,
    };
    expect(wireCarryAim("view", kernel)).toEqual({
      containerId: "view",
      tileId: "a",
      edge: "right",
      action: "place",
      between: true,
    });
    // `between: false` is absence, on the wire and in every comparison.
    expect(
      wireCarryAim("view", { tileId: "a", edge: "right", action: "place", depth: 0 }),
    ).not.toHaveProperty("between");
  });

  test("an aim for another container is refused: a state names one area only", () => {
    const wire: CarryAim = {
      containerId: "elsewhere",
      tileId: "b",
      edge: "top",
      action: "place",
    };
    expect(previewFor(context(), wire, SIDEBAR_TERMINAL, "build")).toBeNull();
  });

  test("an aim naming a tile this tree no longer holds paints nothing", () => {
    const wire: CarryAim = { containerId: "view", tileId: "gone", edge: "top", action: "place" };
    expect(previewFor(context(), wire, SIDEBAR_TERMINAL, "build")).toBeNull();
  });

  test("the chip's fallback chain ends in the species name for both producers", () => {
    const wire: CarryAim = { containerId: "view", tileId: "b", edge: "left", action: "place" };
    // A host that can name the item (a route naming its own session).
    expect(previewFor(context(), wire, SIDEBAR_TERMINAL, "build")?.chip).toEqual({
      kind: "terminal",
      label: "build",
    });
    // A host that cannot — previously a bare icon locally and "view" for every viewer.
    expect(
      previewFor(
        context(),
        wire,
        carrying({ kind: "pad", padId: "p1" }, { kind: "view", containerId: "p1" }),
        null,
      )?.chip,
    ).toEqual({
      kind: "pad",
      label: "view",
    });
    expect(previewFor(context(), wire, null, null)?.chip).toBeNull();
  });

  test("a carried leaf of THIS container is named in the state, whoever is carrying it", () => {
    const wire: CarryAim = { containerId: "view", tileId: "b", edge: "top", action: "place" };
    const own = carrying(
      { kind: "tile", containerId: "view", tileId: "a" },
      { kind: "tile", containerId: null },
    );
    const foreign = carrying(
      { kind: "tile", containerId: "other", tileId: "a" },
      { kind: "tile", containerId: null },
    );
    expect(previewFor(context(), wire, own, null)?.carriedTileId).toBe("a");
    expect(previewFor(context(), wire, foreign, null)?.carriedTileId).toBeNull();
  });

  test("a peer's carry is judged, so a viewer paints the refusal the server would give", () => {
    const wire: CarryAim = { containerId: "view", tileId: "b", edge: "top", action: "place" };
    const judged: CarriedItem[] = [];
    const assess = (_destination: unknown, carried?: CarriedItem) => {
      if (carried !== undefined) judged.push(carried);
      return carried === undefined
        ? null
        : {
            surface: carried.surface,
            denial: {
              rule: "not_solo" as const,
              surface: carried.surface,
              container: { kind: "view" as const, padId: "view" },
            },
            message: "nope",
          };
    };
    const state = previewFor(
      context({ assess: assess as TileDropContext["assess"] }),
      wire,
      SIDEBAR_TERMINAL,
      null,
    );
    // The peer's own resolved carry is what was judged — not an address this viewer
    // re-classified against its own index.
    expect(judged).toEqual([SIDEBAR_TERMINAL]);
    expect(state?.assessment?.message).toBe("nope");
  });
});

describe("the canvas door", () => {
  /*
    Finding 3.1: the producer used to paint `unitZoneRect` — an exact half, no motion —
    while every viewer ran the same aim through the tile kernel and saw the existing pane
    glide into its share. The viewer's version is what `executeCompose` actually writes,
    so the producer was the wrong one. There is now no second prospect to be wrong with.
  */
  test("a solo widget edge aim previews the real root split, not a painted half", () => {
    const wire: CarryAim = {
      containerId: "view",
      tileId: ROOT_TILE_ID,
      edge: "left",
      action: "place",
    };
    const state = previewFor(
      context({ layout: SOLO, widget: { padId: "canvas", elementId: "el" } }),
      wire,
      SIDEBAR_TERMINAL,
      "build",
    );
    expect(state).not.toBeNull();
    const expected = tileProspect(
      SOLO,
      { tileId: ROOT_TILE_ID, edge: "left", action: "place", depth: 0 },
      null,
      UNITS.dividers,
    );
    expect(state?.slot).toEqual(expected?.slot);
    expect(state?.shifts).toEqual(expected?.shifts ?? []);
    // The existing occupant really moves: a bare half reported no motion at all.
    expect(state?.shifts.length).toBe(1);
    expect(state?.slot.width).toBeLessThan(0.5);
    // The COMMIT still goes through the canvas door, which is what preserves the
    // ratified "A + B" birth and in-place portal repointing.
    expect(state?.destination).toEqual({
      kind: "compose",
      padId: "canvas",
      targetElementId: "el",
      edge: "left",
    });
  });

  test("a widget whose tree has not arrived previews the one-leaf tree it visibly is", () => {
    const wire: CarryAim = {
      containerId: "view",
      tileId: ROOT_TILE_ID,
      edge: "top",
      action: "place",
    };
    const state = previewFor(
      context({ layout: null, widget: { padId: "canvas", elementId: "el" } }),
      wire,
      SIDEBAR_TERMINAL,
      "build",
    );
    const expected = tileProspect(
      asTileTree({ kind: "pad", padId: "view" }),
      { tileId: ROOT_TILE_ID, edge: "top", action: "place", depth: 0 },
      null,
      UNITS.dividers,
    );
    expect(state?.slot).toEqual(expected?.slot);
  });

  test("a multi-tile container aims at the leaf under the pointer, at any depth", () => {
    const wire: CarryAim = { containerId: "view", tileId: "b", edge: "bottom", action: "place" };
    const state = previewFor(
      context({ widget: { padId: "canvas", elementId: "el" } }),
      wire,
      SIDEBAR_TERMINAL,
      null,
    );
    expect(state?.destination).toEqual({
      kind: "tile",
      padId: "view",
      targetTileId: "b",
      edge: "bottom",
    });
  });
});

describe("aim equality", () => {
  const base: CarryAim = { containerId: "view", tileId: "t1", edge: "left", action: "place" };

  test("every wire field counts, including the two a compose destination drops", () => {
    expect(sameAim(base, { ...base })).toBe(true);
    expect(sameAim(base, { ...base, containerId: "other" })).toBe(false);
    expect(sameAim(base, { ...base, tileId: "t2" })).toBe(false);
    // `edge` and `between` are the two the store's own copy of this comparison omitted.
    expect(sameAim(base, { ...base, edge: "right" })).toBe(false);
    expect(sameAim(base, { ...base, between: true })).toBe(false);
    expect(sameAim(base, { ...base, action: "swap" })).toBe(false);
    // Absent and false are the same absence.
    expect(sameAim({ ...base, between: false }, base)).toBe(true);
  });
});

/*
  The store's equality is `sameAim`'s only other consumer, and it lives here rather than
  in a store test file because what is being pinned is that the store does NOT keep a
  second, weaker copy of this comparison — the bug was the copy, not the store.
*/
describe("the drop signal", () => {
  const aim: CarryAim = { containerId: "view", tileId: "t1", edge: "left", action: "place" };
  const carry = (updatedAt: number, overrides: Partial<RemoteTileCarry> = {}): RemoteTileCarry => ({
    connId: "peer",
    principalId: "p",
    aim,
    ...SIDEBAR_TERMINAL,
    label: "build",
    updatedAt,
    ...overrides,
  });

  test("an aim change inside one clock tick still repaints", () => {
    const store = createTileDropStore();
    let notices = 0;
    store.subscribe(() => {
      notices += 1;
    });
    // Two frames from one peer, one receipt timestamp, different aims: comparing
    // `updatedAt` alone swallowed the second one.
    store.setRemote("room", new Map([["view", carry(7)]]));
    store.setRemote("room", new Map([["view", carry(7, { aim: { ...aim, edge: "right" } })]]));
    expect(notices).toBe(2);
    expect(store.get().remote.get("view")?.aim.edge).toBe("right");

    // The identical frame republished is inert, which is what keeps the publish effect
    // from looping at 60 Hz in the drag hot path.
    store.setRemote("room", new Map([["view", carry(7, { aim: { ...aim, edge: "right" } })]]));
    expect(notices).toBe(2);
  });

  test("feeds merge per container, freshest wins, and retiring one keeps the others", () => {
    const store = createTileDropStore();
    // The canvas's own room hears an older aim at this container than the widget's
    // socket does — the widget's is the one that must show (4.2's cheap half).
    store.setRemote("canvas", new Map([["view", carry(10, { connId: "stale" })]]));
    store.setRemote("widget:view", new Map([["view", carry(20, { connId: "fresh" })]]));
    expect(store.get().remote.get("view")?.connId).toBe("fresh");

    store.setRemote("canvas", new Map([["other", carry(1, { connId: "elsewhere" })]]));
    expect(store.get().remote.size).toBe(2);

    // A widget unmounting retires only its own feed.
    store.setRemote("widget:view", new Map());
    expect(store.get().remote.get("view")).toBeUndefined();
    expect(store.get().remote.get("other")?.connId).toBe("elsewhere");
  });

  test("a transport's write cannot clobber a peer-aim feed it knows nothing about", () => {
    const store = createTileDropStore();
    store.setRemote("widget:view", new Map([["view", carry(5)]]));
    store.set({ pointer: { clientX: 3, clientY: 4 }, armedElementId: null, aim: null });
    expect(store.get().pointer).toEqual({ clientX: 3, clientY: 4 });
    expect(store.get().remote.get("view")?.connId).toBe("peer");
  });
});
