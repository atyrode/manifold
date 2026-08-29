import { describe, expect, test } from "bun:test";
import { ROOT_TILE_ID, type TileLayout, type TileSurface } from "@manifold/protocol";
import {
  LOCAL_ORIGIN,
  SERVER_PLACE_ORIGIN,
  Y,
  createSceneDoc,
  emptyTileLayout,
  initTiledLayout,
  layoutMap,
  nextTileId,
  readTileLayout,
  removeTileLeaf,
  setTileRatios,
  tileLeaf,
  tileLeafIds,
  tileParentId,
  withTileLeaf,
  withTileRatios,
  withoutTileLeaf,
  writeTileLeaf,
} from "@manifold/scene";

const terminal = (sessionId: string): TileSurface => ({ kind: "terminal", sessionId });
const pad = (padId: string): TileSurface => ({ kind: "pad", padId });

/** Surfaces held by every leaf, keyed by tile id, for compact tree assertions. */
function surfaces(layout: TileLayout): Record<string, TileSurface | null> {
  const out: Record<string, TileSurface | null> = {};
  for (const id of tileLeafIds(layout)) out[id] = layout[id]?.surface ?? null;
  return out;
}

function tiledDoc(): Y.Doc {
  const doc = createSceneDoc();
  initTiledLayout(doc, SERVER_PLACE_ORIGIN);
  return doc;
}

describe("tile layout pure math", () => {
  test("center fills an empty leaf and refuses an occupied one", () => {
    const empty = emptyTileLayout();
    const filled = withTileLeaf(empty, terminal("s1"), ROOT_TILE_ID, "center");
    expect(filled?.tileId).toBe(ROOT_TILE_ID);
    expect(filled?.layout).toEqual({ root: tileLeaf(ROOT_TILE_ID, terminal("s1")) });
    expect(
      withTileLeaf(filled?.layout ?? empty, terminal("s2"), ROOT_TILE_ID, "center"),
    ).toBeNull();
    expect(withTileLeaf(empty, terminal("s2"), "missing", "center")).toBeNull();
  });

  test("splitting the root keeps the root id and moves its content into a fresh leaf", () => {
    const seeded = withTileLeaf(emptyTileLayout(), terminal("s1"), ROOT_TILE_ID, "center");
    const split = withTileLeaf(seeded?.layout ?? {}, terminal("s2"), ROOT_TILE_ID, "right");
    const layout = split?.layout ?? {};
    const root = layout[ROOT_TILE_ID];
    expect(root?.dir).toBe("row");
    expect(root?.ratios).toEqual([0.5, 0.5]);
    expect(root?.surface).toBeNull();
    // The dropped surface is second on a "right" drop; the incumbent keeps the leading slot.
    expect(root?.children[1]).toBe(split?.tileId);
    expect(tileLeafIds(layout).map((id) => layout[id]?.surface)).toEqual([
      terminal("s1"),
      terminal("s2"),
    ]);
    expect(tileParentId(layout, split?.tileId ?? "")).toBe(ROOT_TILE_ID);
    expect(tileParentId(layout, ROOT_TILE_ID)).toBeNull();
  });

  test("edges pick the axis and the insertion side", () => {
    const seeded = withTileLeaf(emptyTileLayout(), terminal("s1"), ROOT_TILE_ID, "center")?.layout;
    const top = withTileLeaf(seeded ?? {}, terminal("s2"), ROOT_TILE_ID, "top");
    expect(top?.layout[ROOT_TILE_ID]?.dir).toBe("column");
    expect(top?.layout[ROOT_TILE_ID]?.children[0]).toBe(top?.tileId);
    const bottom = withTileLeaf(seeded ?? {}, terminal("s2"), ROOT_TILE_ID, "bottom");
    expect(bottom?.layout[ROOT_TILE_ID]?.dir).toBe("column");
    expect(bottom?.layout[ROOT_TILE_ID]?.children[1]).toBe(bottom?.tileId);
    const left = withTileLeaf(seeded ?? {}, terminal("s2"), ROOT_TILE_ID, "left");
    expect(left?.layout[ROOT_TILE_ID]?.dir).toBe("row");
    expect(left?.layout[ROOT_TILE_ID]?.children[0]).toBe(left?.tileId);
  });

  test("splitting a non-root tile keeps that tile's id and wraps it in a new split", () => {
    const seeded = withTileLeaf(emptyTileLayout(), terminal("s1"), ROOT_TILE_ID, "center")?.layout;
    const first = withTileLeaf(seeded ?? {}, terminal("s2"), ROOT_TILE_ID, "right");
    const target = first?.tileId ?? "";
    const second = withTileLeaf(first?.layout ?? {}, pad("p1"), target, "bottom");
    const layout = second?.layout ?? {};
    expect(layout[target]?.surface).toEqual(terminal("s2"));
    const wrapper = tileParentId(layout, target);
    expect(wrapper).not.toBeNull();
    expect(wrapper).not.toBe(ROOT_TILE_ID);
    expect(layout[wrapper ?? ""]?.dir).toBe("column");
    expect(layout[ROOT_TILE_ID]?.children).toContain(wrapper ?? "");
    expect(Object.values(surfaces(layout))).toEqual([terminal("s1"), terminal("s2"), pad("p1")]);
  });

  test("removing a leaf collapses the split it leaves behind", () => {
    const seeded = withTileLeaf(emptyTileLayout(), terminal("s1"), ROOT_TILE_ID, "center")?.layout;
    const split = withTileLeaf(seeded ?? {}, terminal("s2"), ROOT_TILE_ID, "right");
    const collapsed = withoutTileLeaf(split?.layout ?? {}, split?.tileId ?? "");
    // The survivor is promoted into the root id, and the dead nodes are gone.
    expect(collapsed).toEqual({ root: tileLeaf(ROOT_TILE_ID, terminal("s1")) });
  });

  test("a deep collapse replaces the thinned split inside its grandparent", () => {
    const seeded = withTileLeaf(emptyTileLayout(), terminal("s1"), ROOT_TILE_ID, "center")?.layout;
    const first = withTileLeaf(seeded ?? {}, terminal("s2"), ROOT_TILE_ID, "right");
    const second = withTileLeaf(first?.layout ?? {}, pad("p1"), first?.tileId ?? "", "bottom");
    const layout = second?.layout ?? {};
    const wrapper = tileParentId(layout, first?.tileId ?? "");
    const pruned = withoutTileLeaf(layout, second?.tileId ?? "");
    expect(pruned).not.toBeNull();
    expect(pruned?.[wrapper ?? ""]).toBeUndefined();
    const expected = first?.layout[ROOT_TILE_ID]?.children ?? [];
    expect(pruned?.[ROOT_TILE_ID]?.children).toEqual([...expected]);
    expect(Object.values(surfaces(pruned ?? {}))).toEqual([terminal("s1"), terminal("s2")]);
  });

  test("removing the root leaf empties it instead of deleting the root", () => {
    const seeded = withTileLeaf(emptyTileLayout(), terminal("s1"), ROOT_TILE_ID, "center")?.layout;
    expect(withoutTileLeaf(seeded ?? {}, ROOT_TILE_ID)).toEqual(emptyTileLayout());
    // An already empty root has nothing to remove.
    expect(withoutTileLeaf(emptyTileLayout(), ROOT_TILE_ID)).toBeNull();
  });

  test("removal refuses splits and unknown ids", () => {
    const seeded = withTileLeaf(emptyTileLayout(), terminal("s1"), ROOT_TILE_ID, "center")?.layout;
    const split = withTileLeaf(seeded ?? {}, terminal("s2"), ROOT_TILE_ID, "right")?.layout ?? {};
    expect(withoutTileLeaf(split, ROOT_TILE_ID)).toBeNull();
    expect(withoutTileLeaf(split, "missing")).toBeNull();
  });

  test("removal drops the departing tile's own ratio out of a wide split", () => {
    // The ops only ever build two-child splits; wide splits arrive from ratio
    // edits and older trees, and their ratios must stay index-parallel.
    const wide: TileLayout = {
      root: {
        id: ROOT_TILE_ID,
        dir: "row",
        ratios: [0.2, 0.3, 0.5],
        children: ["a", "b", "c"],
        surface: null,
      },
      a: tileLeaf("a", terminal("s1")),
      b: tileLeaf("b", terminal("s2")),
      c: tileLeaf("c", pad("p1")),
    };
    const pruned = withoutTileLeaf(wide, "b");
    expect(pruned?.[ROOT_TILE_ID]?.children).toEqual(["a", "c"]);
    expect(pruned?.[ROOT_TILE_ID]?.ratios).toEqual([0.2, 0.5]);
    expect(pruned?.["b"]).toBeUndefined();
  });

  test("ratios must be positive and parallel to a split's children", () => {
    const seeded = withTileLeaf(emptyTileLayout(), terminal("s1"), ROOT_TILE_ID, "center")?.layout;
    const split = withTileLeaf(seeded ?? {}, terminal("s2"), ROOT_TILE_ID, "right")?.layout ?? {};
    expect(withTileRatios(split, ROOT_TILE_ID, [0.3, 0.7])?.[ROOT_TILE_ID]?.ratios).toEqual([
      0.3, 0.7,
    ]);
    expect(withTileRatios(split, ROOT_TILE_ID, [1])).toBeNull();
    expect(withTileRatios(split, ROOT_TILE_ID, [0, 1])).toBeNull();
    expect(withTileRatios(split, ROOT_TILE_ID, [Number.NaN, 1])).toBeNull();
    expect(withTileRatios(split, split[ROOT_TILE_ID]?.children[0] ?? "", [1])).toBeNull();
    expect(withTileRatios(split, "missing", [1, 1])).toBeNull();
  });

  test("tile ids fill the smallest free slot and honour reservations", () => {
    expect(nextTileId(emptyTileLayout())).toBe("t1");
    expect(nextTileId(emptyTileLayout(), new Set(["t1"]))).toBe("t2");
    expect(nextTileId({ root: tileLeaf(ROOT_TILE_ID, null), t1: tileLeaf("t1", null) })).toBe("t2");
  });
});

describe("tile layout document", () => {
  test("a fresh doc has no layout until it is initialised", () => {
    const doc = createSceneDoc();
    expect(readTileLayout(doc)).toBeNull();
    initTiledLayout(doc, SERVER_PLACE_ORIGIN);
    expect(readTileLayout(doc)).toEqual(emptyTileLayout());
  });

  test("initialisation is idempotent and never disturbs live tiles", () => {
    const doc = tiledDoc();
    writeTileLeaf(doc, terminal("s1"), ROOT_TILE_ID, "center", SERVER_PLACE_ORIGIN);
    initTiledLayout(doc, SERVER_PLACE_ORIGIN);
    expect(readTileLayout(doc)).toEqual({ root: tileLeaf(ROOT_TILE_ID, terminal("s1")) });
  });

  test("initialisation replaces an unusable tree so the room is never stranded", () => {
    const doc = createSceneDoc();
    doc.transact(() => {
      layoutMap(doc).set("junk", new Y.Map<unknown>());
    }, SERVER_PLACE_ORIGIN);
    expect(readTileLayout(doc)).toBeNull();
    initTiledLayout(doc, SERVER_PLACE_ORIGIN);
    expect(readTileLayout(doc)).toEqual(emptyTileLayout());
  });

  test("writes carry their origin so fan-out can classify them", () => {
    const doc = tiledDoc();
    const origins: unknown[] = [];
    doc.on("update", (_update: Uint8Array, origin: unknown) => {
      origins.push(origin);
    });
    writeTileLeaf(doc, terminal("s1"), ROOT_TILE_ID, "center", SERVER_PLACE_ORIGIN);
    writeTileLeaf(doc, terminal("s2"), ROOT_TILE_ID, "right", SERVER_PLACE_ORIGIN);
    expect(setTileRatios(doc, ROOT_TILE_ID, [0.4, 0.6], LOCAL_ORIGIN)).toBe(true);
    expect(origins).toEqual([SERVER_PLACE_ORIGIN, SERVER_PLACE_ORIGIN, LOCAL_ORIGIN]);
  });

  test("placement returns the new tile id and rejects impossible drops", () => {
    const doc = tiledDoc();
    expect(writeTileLeaf(doc, terminal("s1"), ROOT_TILE_ID, "center", SERVER_PLACE_ORIGIN)).toBe(
      ROOT_TILE_ID,
    );
    const second = writeTileLeaf(doc, terminal("s2"), ROOT_TILE_ID, "right", SERVER_PLACE_ORIGIN);
    expect(second).not.toBeNull();
    expect(writeTileLeaf(doc, pad("p1"), "missing", "left", SERVER_PLACE_ORIGIN)).toBeNull();
    const layout = readTileLayout(doc);
    expect(layout).not.toBeNull();
    expect(tileLeafIds(layout ?? {})).toHaveLength(2);
    expect(layout?.[second ?? ""]?.surface).toEqual(terminal("s2"));
  });

  test("removal collapses through the doc and reports unknown tiles", () => {
    const doc = tiledDoc();
    writeTileLeaf(doc, terminal("s1"), ROOT_TILE_ID, "center", SERVER_PLACE_ORIGIN);
    const second = writeTileLeaf(doc, terminal("s2"), ROOT_TILE_ID, "right", SERVER_PLACE_ORIGIN);
    expect(removeTileLeaf(doc, second ?? "", SERVER_PLACE_ORIGIN)).toBe(true);
    expect(readTileLayout(doc)).toEqual({ root: tileLeaf(ROOT_TILE_ID, terminal("s1")) });
    expect(layoutMap(doc).has(second ?? "")).toBe(false);
    expect(removeTileLeaf(doc, "missing", SERVER_PLACE_ORIGIN)).toBe(false);
    expect(removeTileLeaf(doc, ROOT_TILE_ID, SERVER_PLACE_ORIGIN)).toBe(true);
    expect(readTileLayout(doc)).toEqual(emptyTileLayout());
  });

  test("a ratio drag touches one node and leaves the tiles it resizes untouched", () => {
    const doc = tiledDoc();
    writeTileLeaf(doc, terminal("s1"), ROOT_TILE_ID, "center", SERVER_PLACE_ORIGIN);
    const second = writeTileLeaf(doc, terminal("s2"), ROOT_TILE_ID, "right", SERVER_PLACE_ORIGIN);
    const leafBefore = layoutMap(doc).get(second ?? "");
    const rootBefore = layoutMap(doc).get(ROOT_TILE_ID);
    expect(setTileRatios(doc, ROOT_TILE_ID, [0.25, 0.75], LOCAL_ORIGIN)).toBe(true);
    // Identity is the contract Phase 3 leans on: resizing must never reparent a live PTY.
    expect(layoutMap(doc).get(second ?? "")).toBe(leafBefore);
    expect(layoutMap(doc).get(ROOT_TILE_ID)).toBe(rootBefore);
    expect(readTileLayout(doc)?.[ROOT_TILE_ID]?.ratios).toEqual([0.25, 0.75]);
    expect(setTileRatios(doc, ROOT_TILE_ID, [0.25], LOCAL_ORIGIN)).toBe(false);
    expect(setTileRatios(doc, second ?? "", [1], LOCAL_ORIGIN)).toBe(false);
  });

  test("mutations refuse an uninitialised document except for placement", () => {
    const doc = createSceneDoc();
    expect(removeTileLeaf(doc, ROOT_TILE_ID, SERVER_PLACE_ORIGIN)).toBe(false);
    expect(setTileRatios(doc, ROOT_TILE_ID, [1], SERVER_PLACE_ORIGIN)).toBe(false);
    // A bind must never silently vanish: placement seeds the tree it needs.
    expect(writeTileLeaf(doc, terminal("s1"), ROOT_TILE_ID, "center", SERVER_PLACE_ORIGIN)).toBe(
      ROOT_TILE_ID,
    );
    expect(readTileLayout(doc)).toEqual({ root: tileLeaf(ROOT_TILE_ID, terminal("s1")) });
  });

  test("a self-tiling container reads as unusable for its own room", () => {
    const doc = tiledDoc();
    writeTileLeaf(doc, pad("view-1"), ROOT_TILE_ID, "center", SERVER_PLACE_ORIGIN);
    expect(readTileLayout(doc, "view-1")).toBeNull();
    expect(readTileLayout(doc, "view-2")).not.toBeNull();
  });

  test("two docs converge on the same tree through Yjs updates", () => {
    const server = tiledDoc();
    writeTileLeaf(server, terminal("s1"), ROOT_TILE_ID, "center", SERVER_PLACE_ORIGIN);
    writeTileLeaf(server, terminal("s2"), ROOT_TILE_ID, "right", SERVER_PLACE_ORIGIN);
    const client = createSceneDoc();
    Y.applyUpdate(client, Y.encodeStateAsUpdate(server));
    expect(readTileLayout(client)).toEqual(readTileLayout(server));
  });
});
