import { describe, expect, test } from "bun:test";
import {
  MAX_PANEL_ARG_BYTES,
  MAX_PANEL_SECTIONS,
  MAX_TILE_CHILDREN,
  ROOT_TILE_ID,
  validateTileLayout,
  type SectionNode,
  type TileLayout,
} from "@manifold/protocol";
import { resolveTileAim, type TileAim } from "../src/tile-geometry.ts";
import {
  arrangedSections,
  clusteredSections,
  openedPanel,
  panelSections,
  projectSectionArrangement,
  releasedSectionArrangement,
  removedSectionStructure,
  sectionArrangementOf,
  withPanelSections,
  withSeatedPanels,
} from "../src/layout.ts";
import { releasedTileLayout } from "../src/tile-release.ts";

/**
 * THE SECTION ARRANGEMENT POLICY.
 *
 * The contract under test is a precedence rule with an escape hatch — manifest order is the
 * DEFAULT, a principal's stored arrangement overrides it, and neither side may quietly lose a
 * section the other one knows about — plus, since issue #104, the fact that the arrangement is
 * a TREE and that the rail resolves its own drops through the shared seam/zone kernel rather
 * than a hit test of its own.
 */

const SIDEBAR = "core.shell.sidebar";
const MAIN = "core.shell.container-view";

/**
 * A two-panel workspace tree, spelled here rather than composed: what the commit shape has to
 * survive is the SHAPE of a tree a principal is looking at — a split over two panel leaves —
 * and borrowing the default composer for it would tie this policy's cases to which plugins a
 * roster happens to seat.
 */
const shell = (): TileLayout => ({
  root: {
    id: "root",
    dir: "row",
    ratios: [0.22, 0.78],
    children: ["ws-sidebar", "ws-main"],
    ref: null,
  },
  "ws-sidebar": {
    id: "ws-sidebar",
    dir: null,
    ratios: [],
    children: [],
    ref: { kind: "panel", panelId: SIDEBAR },
  },
  "ws-main": {
    id: "ws-main",
    dir: null,
    ratios: [],
    children: [],
    ref: { kind: "panel", panelId: MAIN },
  },
});

describe("arrangedSections", () => {
  test("no arrangement is manifest order, and the declared list is returned as-is", () => {
    const declared = ["index", "machines", "plugins"];
    // Referential identity, deliberately: the sidebar renders this every frame, and "nobody
    // has arranged anything" must not allocate a new array for React to see as new props.
    expect(arrangedSections(declared, undefined)).toBe(declared);
    expect(arrangedSections(declared, [])).toBe(declared);
  });

  test("a stored arrangement overrides manifest order", () => {
    expect(arrangedSections(["index", "machines", "plugins"], ["plugins", "index"])).toEqual([
      "plugins",
      "index",
      "machines",
    ]);
  });

  test("a section the manifests stopped declaring leaves no gap, at any depth", () => {
    // `core.machines` was disabled or left the roster: its slot closes rather than holding a
    // hole open, and the row the principal stored is not the thing that changed. Inside a
    // split it is the same rule — the split keeps its other member and its direction.
    expect(
      arrangedSections(["index", "plugins"], [{ dir: "row", sections: ["plugins", "machines"] }]),
    ).toEqual([{ dir: "row", sections: ["plugins"] }, "index"]);
  });

  test("a split emptied by a roster change survives, because an empty split is a real state", () => {
    // It is also exactly what the palette's own drop produces, so "empty" can never be read
    // as "delete me" without the drop deleting itself before the reader can fill it.
    expect(arrangedSections(["index"], [{ dir: "row", sections: ["gone"] }, "index"])).toEqual([
      { dir: "row", sections: [] },
      "index",
    ]);
  });

  test("a newly declared section lands after the arrangement, at the TOP level", () => {
    // New information goes somewhere visible, never displacing a slot chosen on purpose —
    // and never buried inside a split the reader did not put it in.
    expect(
      arrangedSections(
        ["index", "notes", "machines"],
        [{ dir: "row", sections: ["index"] }, "notes"],
      ),
    ).toEqual([{ dir: "row", sections: ["index"] }, "notes", "machines"]);
  });

  test("an arrangement naming nothing declared falls all the way back to manifest order", () => {
    const declared = ["index", "plugins"];
    expect(arrangedSections(declared, ["gone", "also-gone"])).toBe(declared);
  });
});

/**
 * THE RAIL AS A TILE TREE.
 *
 * The property worth defending is not the projection's shape but its ROUND TRIP: whatever the
 * shared kernel does to the projected tree has to come back out as an arrangement, or the rail
 * would be resolving drops in a space it cannot read its own answer out of.
 */

/** Every painted row is one unit tall in a rail of `count` rows; nothing is hidden. */
const evenExtents =
  (count: number) =>
  (path: string): number =>
    path.includes(".") ? 1 : 1 / count;

/** The aim a pointer at `(x, y)` in the rail's unit box resolves to, with no ring. */
function railAim(
  nodes: readonly SectionNode[],
  point: { readonly x: number; readonly y: number },
  carried: string | null,
): TileAim | null {
  const projection = projectSectionArrangement(nodes, evenExtents(nodes.length));
  return resolveTileAim(
    projection.layout,
    point,
    {
      carriedTileId: carried === null ? null : (projection.pathOf.get(carried) ?? null),
      holdsTileSeat: carried !== null,
    },
    { x: 0.01, y: 0.01 },
    { x: 0, y: 0 },
  );
}

describe("the rail's projection", () => {
  test("a flat arrangement projects to a column of leaves and reads back unchanged", () => {
    const nodes: readonly SectionNode[] = ["brand", "index", "identity"];
    const projection = projectSectionArrangement(nodes, evenExtents(3));
    expect(projection.layout[ROOT_TILE_ID]?.dir).toBe("column");
    expect(projection.layout[ROOT_TILE_ID]?.children).toEqual(["n0", "n1", "n2"]);
    expect(projection.pathOf.get("index")).toBe("n1");
    expect(sectionArrangementOf(projection.layout)).toEqual(nodes);
  });

  test("a nested split projects to a split and reads back with its direction", () => {
    const nodes: readonly SectionNode[] = [
      "brand",
      { dir: "row", sections: ["new-canvas", "new-composition"] },
    ];
    const projection = projectSectionArrangement(nodes, evenExtents(2));
    expect(projection.layout["n1"]?.dir).toBe("row");
    expect(projection.pathOf.get("new-composition")).toBe("n1.1");
    expect(sectionArrangementOf(projection.layout)).toEqual(nodes);
  });

  test("an empty split projects a seat to aim at and reads back still empty", () => {
    // Without the seat there would be no leaf under the pointer at all, and the kernel would
    // answer null — a dropped stack nobody could ever put anything into.
    const nodes: readonly SectionNode[] = ["brand", { dir: "row", sections: [] }];
    const projection = projectSectionArrangement(nodes, evenExtents(2));
    expect(projection.layout["n1.0"]?.ref).toBeNull();
    expect(sectionArrangementOf(projection.layout)).toEqual(nodes);
  });
});

describe("what a rail release means", () => {
  const flat: readonly SectionNode[] = ["a", "b", "c"];

  const released = (
    nodes: readonly SectionNode[],
    release: Parameters<typeof releasedSectionArrangement>[1],
    aim: TileAim | null,
  ): readonly SectionNode[] | null => {
    if (aim === null) return null;
    return releasedSectionArrangement(
      projectSectionArrangement(nodes, evenExtents(nodes.length)),
      release,
      aim,
    );
  };

  test("a row dropped low in the stack lands where the pointer did", () => {
    // Bottom third, deep inside `c`'s own lower band: `a` comes to rest after it.
    const aim = railAim(flat, { x: 0.5, y: 0.95 }, "a");
    expect(released(flat, { kind: "section", id: "a" }, aim)).toEqual(["b", "c", "a"]);
  });

  test("a row dropped on another row's exact spot trades the two", () => {
    // Center means THIS EXACT SPOT everywhere in the application, and the rail is not an
    // exception to it — the kernel answers `swap` and the two seats exchange occupants.
    const aim = railAim(flat, { x: 0.5, y: 0.5 }, "a");
    expect(aim?.action).toBe("swap");
    expect(released(flat, { kind: "section", id: "a" }, aim)).toEqual(["b", "a", "c"]);
  });

  test("a dropped split arrives with two seats and holds the rows it is given", () => {
    const wedged = released(
      flat,
      { kind: "structure", structure: { kind: "split", dir: "row" } },
      railAim(flat, { x: 0.5, y: 0.95 }, null),
    );
    expect(wedged).not.toBeNull();
    const split = (wedged ?? []).find((node) => typeof node !== "string");
    expect(split).toEqual({ dir: "row", sections: [] });

    // ...and the first row dragged in seats itself, which is what makes two rows sit side by
    // Aimed at the middle of the empty split's own seat, which is what "into it" means: a
    // center release on a vacant leaf FILLS it, exactly as it does in any composition.
    const seated = released(
      wedged ?? [],
      { kind: "section", id: "a" },
      railAim(wedged ?? [], { x: 0.5, y: 0.875 }, "a"),
    );
    expect(seated).not.toBeNull();
    expect(seated?.some((node) => typeof node !== "string" && node.sections.includes("a"))).toBe(
      true,
    );
  });

  test("a spacer is refused: the rail has no room for it to hold open", () => {
    // Every other target takes all three palette shapes; the rail takes two, and says so by
    // refusing rather than by storing a row that renders nothing and can never be filled.
    expect(
      released(
        flat,
        { kind: "structure", structure: { kind: "spacer" } },
        railAim(flat, { x: 0.5, y: 0.95 }, null),
      ),
    ).toBeNull();
  });

  test("a release never loses or duplicates a row", () => {
    for (const y of [0.05, 0.2, 0.4, 0.6, 0.8, 0.95]) {
      const aim = railAim(flat, { x: 0.5, y }, "a");
      const next = released(flat, { kind: "section", id: "a" }, aim);
      if (next === null) continue;
      const ids = [...next].filter((node): node is string => typeof node === "string").sort();
      expect(ids).toEqual(["a", "b", "c"]);
    }
  });

  test("a row the arrangement does not hold moves nothing", () => {
    const aim = railAim(flat, { x: 0.5, y: 0.95 }, null);
    expect(released(flat, { kind: "section", id: "ghost" }, aim)).toBeNull();
  });
});

/**
 * WHAT A RAIL REMOVAL MEANS (issue #148): the split at a path dissolves into its members, in
 * place, through the same inverse the workspace tree's structures go through — so the two
 * legs cannot disagree about what "take the stack away, keep the rows" produces.
 */
describe("what a rail removal means", () => {
  const removed = (nodes: readonly SectionNode[], path: string): readonly SectionNode[] | null =>
    removedSectionStructure(
      projectSectionArrangement(nodes, () => 1),
      path,
    );

  test("a stack dissolves into its rows where it stood, in their order", () => {
    expect(removed(["a", { dir: "row", sections: ["b", "c"] }, "d"], "n1")).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  test("a vacant stack leaves nothing behind, and a lone member joins the rail flat", () => {
    expect(removed(["a", { dir: "row", sections: [] }, "b"], "n1")).toEqual(["a", "b"]);
    expect(removed(["a", { dir: "column", sections: ["b"] }], "n1")).toEqual(["a", "b"]);
  });

  test("a stack inside a stack dissolves into the outer one, which keeps its own shape", () => {
    const nested: readonly SectionNode[] = [
      "a",
      { dir: "row", sections: ["b", { dir: "column", sections: ["c", "d"] }, "e"] },
    ];
    expect(removed(nested, "n1.1")).toEqual(["a", { dir: "row", sections: ["b", "c", "d", "e"] }]);
    // The outer stack goes too, and the inner one is promoted whole: it is structure of its own.
    expect(removed(nested, "n1")).toEqual(["a", "b", { dir: "column", sections: ["c", "d"] }, "e"]);
  });

  test("a row is not structure, the root is not removable, and a ghost path is nothing", () => {
    const flat: readonly SectionNode[] = ["a", "b"];
    expect(removed(flat, "n0")).toBeNull();
    expect(removed(flat, ROOT_TILE_ID)).toBeNull();
    expect(removed(flat, "n7")).toBeNull();
  });
});

describe("the commit shape", () => {
  test("an arrangement rides the panel's own leaf and nothing else moves", () => {
    const next = withPanelSections(shell(), SIDEBAR, ["plugins", "index"]);
    expect(next).not.toBeNull();
    expect(next?.["ws-sidebar"]?.sections).toEqual(["plugins", "index"]);
    // The tree it commits is a tree the door will accept.
    expect(validateTileLayout(next ?? {})).toBe(true);
    // Structure, ratios and the OTHER leaf are untouched: this is an arrangement write, not
    // a layout write that happens to carry one.
    expect(next?.["ws-sidebar"]?.ref).toEqual({ kind: "panel", panelId: SIDEBAR });
    expect(next?.["ws-main"]).toEqual(shell()["ws-main"]);
    expect(next?.root).toEqual(shell().root);
  });

  test("a nested arrangement commits and validates like a flat one", () => {
    const nested: SectionNode[] = [
      "brand",
      { dir: "row", sections: ["new-canvas", "new-composition"] },
    ];
    const next = withPanelSections(shell(), SIDEBAR, nested);
    expect(next?.["ws-sidebar"]?.sections).toEqual(nested);
    expect(validateTileLayout(next ?? {})).toBe(true);
    expect(panelSections(next, SIDEBAR)).toEqual(nested);
  });

  test("it reads back through panelSections, and only for the panel that holds it", () => {
    const next = withPanelSections(shell(), SIDEBAR, ["plugins", "index"]);
    expect(panelSections(next, SIDEBAR)).toEqual(["plugins", "index"]);
    expect(panelSections(next, MAIN)).toBeUndefined();
    expect(panelSections(shell(), SIDEBAR)).toBeUndefined();
    expect(panelSections(null, SIDEBAR)).toBeUndefined();
  });

  test("an empty arrangement clears the field rather than storing an empty one", () => {
    const arranged = withPanelSections(shell(), SIDEBAR, ["plugins", "index"]) ?? {};
    const reset = withPanelSections(arranged, SIDEBAR, []);
    expect(reset).not.toBeNull();
    // "I have no arrangement" and "my arrangement is nothing" are one state with one
    // representation: a reset tree is indistinguishable from one nobody ever arranged.
    expect(reset?.["ws-sidebar"]).not.toHaveProperty("sections");
    expect(reset).toEqual(shell());
    expect(panelSections(reset, SIDEBAR)).toBeUndefined();
  });

  test("a write the door would refuse is refused before it reaches the wire", () => {
    // A duplicate makes "the order" ambiguous — the same rule `validateTileLayout` applies,
    // and it applies ACROSS the tree, not just among siblings.
    expect(withPanelSections(shell(), SIDEBAR, ["index", "index"])).toBeNull();
    expect(
      withPanelSections(shell(), SIDEBAR, ["index", { dir: "row", sections: ["index"] }]),
    ).toBeNull();
    // Past the wire bound.
    const wide = Array.from({ length: MAX_PANEL_SECTIONS + 1 }, (_unused, i) => `s${String(i)}`);
    expect(withPanelSections(shell(), SIDEBAR, wide)).toBeNull();
    expect(withPanelSections(shell(), SIDEBAR, wide.slice(1))).not.toBeNull();
    // Nested past the depth a rail can honestly paint.
    let deep: SectionNode = "index";
    for (let level = 0; level < 8; level += 1) deep = { dir: "row", sections: [deep] };
    expect(withPanelSections(shell(), SIDEBAR, [deep])).toBeNull();
    // A panel this tree does not show has no leaf to arrange, so there is nothing to write.
    expect(withPanelSections(shell(), "core.notes.panel", ["index"])).toBeNull();
  });

  test("the stored arrangement survives the round trip the sidebar actually makes", () => {
    // The full loop: declared order in, one release, commit, read back, render order out.
    const declared = ["index", "machines", "plugins"];
    const start = arrangedSections(declared, undefined);
    const projection = projectSectionArrangement(start, evenExtents(start.length));
    const aim = railAim(start, { x: 0.5, y: 0.95 }, "index");
    expect(aim).not.toBeNull();
    const moved = releasedSectionArrangement(projection, { kind: "section", id: "index" }, aim!);
    expect(moved).not.toBeNull();
    const committed = withPanelSections(shell(), SIDEBAR, moved ?? []);
    expect(arrangedSections(declared, panelSections(committed, SIDEBAR))).toEqual([
      "machines",
      "plugins",
      "index",
    ]);
  });
});

/**
 * THE CLUSTER POLICY.
 *
 * The contract is two sentences of the manifest field's meaning, and both are about a cluster
 * being DECLARED rather than positional: members paint as one unit wherever the earliest of
 * them sits, and a stack cannot half-honour membership. It stays orthogonal to the
 * arrangement tree above — a cluster is a manifest word, a split is this principal's own
 * arrangement — and the cases worth pinning are the ones a roster change walks into.
 */
describe("section clusters", () => {
  interface Row {
    readonly id: string;
    readonly cluster?: string;
  }
  const row = (id: string, cluster?: string): Row =>
    cluster === undefined ? { id } : { id, cluster };
  const units = (rows: readonly Row[]): readonly (readonly string[])[] =>
    clusteredSections(rows, (candidate) => candidate.cluster).map((unit) =>
      unit.rows.map((member) => member.id),
    );

  test("an unclustered stack comes back one unit per row, in order", () => {
    expect(units([row("brand"), row("index"), row("identity")])).toEqual([
      ["brand"],
      ["index"],
      ["identity"],
    ]);
  });

  test("members of one word paint as one unit where the earliest of them sits", () => {
    expect(
      units([row("status"), row("keys", "utility"), row("plugins", "utility"), row("identity")]),
    ).toEqual([["status"], ["keys", "plugins"], ["identity"]]);
  });

  test("a member arranged away from its neighbour is pulled back beside it", () => {
    // The reader dragged `plugins` to the top of the rail: the whole cluster moves with it,
    // because the cluster sits where its earliest member does.
    expect(
      units([row("plugins", "utility"), row("status"), row("keys", "utility"), row("identity")]),
    ).toEqual([["plugins", "keys"], ["status"], ["identity"]]);
  });

  test("two words interleave without merging, each at its own earliest member", () => {
    expect(
      units([row("a", "left"), row("b", "right"), row("c", "left"), row("d", "right")]),
    ).toEqual([
      ["a", "c"],
      ["b", "d"],
    ]);
  });

  test("a word with one live member is a one-row unit, exactly like an unclustered row", () => {
    // What a disabled plugin's cluster partner leaves behind: the caller filtered it out
    // upstream (`railRows`), so the policy sees one member and must not draw an empty cluster.
    expect(units([row("keys", "utility"), row("identity")])).toEqual([["keys"], ["identity"]]);
  });

  test("an empty stack has no units", () => {
    expect(units([])).toEqual([]);
  });
});

/**
 * OPENING A PANEL FOR A THING (issue #516).
 *
 * The contract is one sentence with a fork in it: asking for a panel of one's own plugin
 * with an argument means one more seat beside the caller carrying that argument — UNLESS a
 * seat already shows the same thing, in which case it means that seat and no write at all.
 * What the cases defend is the fork, where the new seat lands, and that the argument follows
 * the PANEL rather than the seat when a reader rearranges afterwards.
 */
describe("opening a panel with an argument", () => {
  const RECORD = "acme.feed.record";
  const R1 = { kind: "record", id: "r-1" };

  /** The workspace above with the record panel open on `r-1` in the main seat. */
  const reading = (): TileLayout => {
    const layout = shell();
    return {
      ...layout,
      "ws-main": { ...layout["ws-main"]!, ref: { kind: "panel", panelId: RECORD }, arg: R1 },
    };
  };

  test("an opening joins the caller's own row, carrying its argument", () => {
    const opening = openedPanel(shell(), RECORD, R1, "ws-main");
    expect(opening).not.toBeNull();
    expect(opening?.placed).toBe(true);
    const tileId = opening?.tileId ?? "";
    const next = opening?.layout ?? {};
    expect(next[tileId]?.ref).toEqual({ kind: "panel", panelId: RECORD });
    expect(next[tileId]?.arg).toEqual(R1);
    // FLAT, and after the caller: the workspace is a row, so it grows one more pane to the
    // right rather than nesting a split inside the seat that asked.
    expect(next[ROOT_TILE_ID]?.children).toEqual(["ws-sidebar", "ws-main", tileId]);
    // And it is a tree the door will accept, argument and all.
    expect(validateTileLayout(next)).toBe(true);
    // The caller's own seat is untouched — an opening is not a navigation.
    expect(next["ws-main"]).toEqual(shell()["ws-main"]);
  });

  test("a seat already showing the same thing is the answer, and nothing is written", () => {
    const layout = reading();
    const again = openedPanel(layout, RECORD, R1, "ws-sidebar");
    expect(again).toEqual({ layout, tileId: "ws-main", placed: false });
    // The tree comes back UNCHANGED by identity, so a caller committing it is a no-op.
    expect(again?.layout).toBe(layout);
    // Key order is how a caller happened to build the record, not part of what it names.
    const reordered = openedPanel(layout, RECORD, { id: "r-1", kind: "record" }, "ws-sidebar");
    expect(reordered?.placed).toBe(false);
    expect(reordered?.tileId).toBe("ws-main");
  });

  test("a different thing is a second seat, which is the whole point", () => {
    const opening = openedPanel(reading(), RECORD, { kind: "record", id: "r-2" }, "ws-main");
    expect(opening?.placed).toBe(true);
    const next = opening?.layout ?? {};
    const showing = Object.values(next)
      .filter((tile) => tile.ref?.kind === "panel" && tile.ref.panelId === RECORD)
      .map((tile) => tile.arg);
    expect(showing).toHaveLength(2);
    expect(showing).toContainEqual(R1);
    expect(showing).toContainEqual({ kind: "record", id: "r-2" });
    // An argument-free seat of the same panel is a THIRD state, not a match for either.
    const bare = openedPanel(next, RECORD, undefined, "ws-main");
    expect(bare?.placed).toBe(true);
    expect(bare?.layout[bare.tileId]).not.toHaveProperty("arg");
    // ...and asking for it again now dedups onto it.
    expect(openedPanel(bare?.layout ?? {}, RECORD, undefined, "ws-main")?.tileId).toBe(
      bare?.tileId,
    );
  });

  test("a column grows downward, and a lone root leaf is split into a row", () => {
    const stacked: TileLayout = { ...shell(), root: { ...shell().root!, dir: "column" } };
    const below = openedPanel(stacked, RECORD, R1, "ws-main");
    expect(below?.layout[ROOT_TILE_ID]?.children).toEqual([
      "ws-sidebar",
      "ws-main",
      below?.tileId ?? "",
    ]);
    expect(below?.layout[ROOT_TILE_ID]?.dir).toBe("column");

    const solo: TileLayout = {
      [ROOT_TILE_ID]: {
        id: ROOT_TILE_ID,
        dir: null,
        ratios: [],
        children: [],
        ref: { kind: "panel", panelId: RECORD },
      },
    };
    const beside = openedPanel(solo, RECORD, R1, ROOT_TILE_ID);
    expect(beside?.layout[ROOT_TILE_ID]?.dir).toBe("row");
    expect(validateTileLayout(beside?.layout ?? {})).toBe(true);
  });

  test("a write the door would refuse is refused before it reaches the wire", () => {
    // Past the wire's own bound on an argument, and not JSON data: both are the rules
    // `validateTileLayout` would reject the committed tree by.
    expect(
      openedPanel(shell(), RECORD, { id: "x".repeat(MAX_PANEL_ARG_BYTES) }, "ws-main"),
    ).toBeNull();
    expect(openedPanel(shell(), RECORD, { at: new Date(0) }, "ws-main")).toBeNull();
    // A seat that is not in this tree is nothing to open beside.
    expect(openedPanel(shell(), RECORD, R1, "ws-ghost")).toBeNull();
  });

  test("the argument travels with the panel when the reader rearranges", () => {
    const layout = reading();
    const aim: TileAim = { tileId: "ws-sidebar", edge: "bottom", action: "place", depth: 1 };
    const moved = releasedTileLayout(layout, { kind: "seat", tileId: "ws-main" }, aim);
    expect(moved).not.toBeNull();
    const seat = Object.values(moved ?? {}).find(
      (tile) => tile.ref?.kind === "panel" && tile.ref.panelId === RECORD,
    );
    // The reader moved the tile showing `r-1`; it still shows `r-1`.
    expect(seat?.arg).toEqual(R1);
    expect(seat?.id).not.toBe("ws-main");
    expect(validateTileLayout(moved ?? {})).toBe(true);
  });
});

describe("seating workspace panels", () => {
  test("appends every absent panel flat without disturbing the arranged tree", () => {
    const next = withSeatedPanels(shell(), [MAIN, "example.notes.main", "example.notes.search"]);
    expect(next).not.toBeNull();
    expect(next?.[ROOT_TILE_ID]?.children).toHaveLength(4);
    expect(
      Object.values(next ?? {})
        .filter((tile) => tile.ref?.kind === "panel")
        .map((tile) => tile.ref?.kind === "panel" && tile.ref.panelId),
    ).toEqual([SIDEBAR, MAIN, "example.notes.main", "example.notes.search"]);
    expect(next?.["ws-sidebar"]).toEqual(shell()["ws-sidebar"]);
    expect(validateTileLayout(next ?? {})).toBe(true);
  });

  test("duplicate requests and panels already present are a referential no-op", () => {
    const current = shell();
    expect(withSeatedPanels(current, [MAIN, SIDEBAR, MAIN])).toBe(current);
  });

  test("a batch that exceeds the root fan-out refuses atomically", () => {
    const children = Array.from(
      { length: MAX_TILE_CHILDREN },
      (_, index) => `seat-${String(index)}`,
    );
    const full: TileLayout = {
      [ROOT_TILE_ID]: {
        id: ROOT_TILE_ID,
        dir: "row",
        ratios: children.map(() => 1),
        children,
        ref: null,
      },
      ...Object.fromEntries(
        children.map((id) => [
          id,
          {
            id,
            dir: null,
            ratios: [],
            children: [],
            ref: { kind: "panel" as const, panelId: `example.full.${id}` },
          },
        ]),
      ),
    };
    expect(withSeatedPanels(full, ["example.extra.one", "example.extra.two"])).toBeNull();
    expect(full[ROOT_TILE_ID]?.children).toEqual(children);
  });
});
