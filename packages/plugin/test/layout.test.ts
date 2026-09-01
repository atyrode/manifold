import { describe, expect, test } from "bun:test";
import { MAX_PANEL_SECTIONS, validateTileLayout, type TileLayout } from "@manifold/protocol";
import {
  SECTION_CROSS_MARGIN,
  arrangedSectionIds,
  clusteredSections,
  crossedSectionId,
  movedSectionIds,
  panelSections,
  withPanelSections,
  type SectionBox,
} from "../src/layout.ts";

/**
 * THE SECTION ARRANGEMENT POLICY.
 *
 * The contract under test is a precedence rule with an escape hatch: manifest order is the
 * DEFAULT, a principal's stored order overrides it, and neither side may quietly lose a
 * section the other one knows about. Those are the cases a roster change walks into — a
 * plugin disabled, a plugin added after you last arranged — and they are why this is a
 * tested module rather than a `sort` inside a sidebar callback.
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

describe("arrangedSectionIds", () => {
  test("no arrangement is manifest order, and the declared list is returned as-is", () => {
    const declared = ["index", "machines", "plugins"];
    // Referential identity, deliberately: the sidebar renders this every frame, and "nobody
    // has arranged anything" must not allocate a new array for React to see as new props.
    expect(arrangedSectionIds(declared, undefined)).toBe(declared);
    expect(arrangedSectionIds(declared, [])).toBe(declared);
  });

  test("a stored arrangement overrides manifest order", () => {
    expect(arrangedSectionIds(["index", "machines", "plugins"], ["plugins", "index"])).toEqual([
      "plugins",
      "index",
      "machines",
    ]);
  });

  test("a section the manifests stopped declaring leaves no gap", () => {
    // `core.machines` was disabled or left the roster: its slot closes rather than holding a
    // hole open, and the row the principal stored is not the thing that changed.
    expect(arrangedSectionIds(["index", "plugins"], ["plugins", "machines", "index"])).toEqual([
      "plugins",
      "index",
    ]);
  });

  test("a newly declared section lands after the arrangement, in manifest order", () => {
    // Two sections arrived since this principal last arranged the sidebar. New information
    // goes somewhere visible and never displaces a slot that was chosen on purpose.
    expect(
      arrangedSectionIds(["index", "notes", "machines", "uri", "plugins"], ["plugins", "index"]),
    ).toEqual(["plugins", "index", "notes", "machines", "uri"]);
  });

  test("an arrangement naming nothing declared falls all the way back to manifest order", () => {
    const declared = ["index", "plugins"];
    expect(arrangedSectionIds(declared, ["gone", "also-gone"])).toBe(declared);
  });

  test("the answer is always a permutation of the declared list", () => {
    const declared = ["a", "b", "c", "d"];
    const result = arrangedSectionIds(declared, ["d", "ghost", "b"]);
    expect([...result].sort()).toEqual([...declared].sort());
  });
});

describe("movedSectionIds", () => {
  test("dragging down lands the section where its target sat", () => {
    expect(movedSectionIds(["a", "b", "c", "d"], "a", "c")).toEqual(["b", "c", "a", "d"]);
  });

  test("dragging up lands the section where its target sat", () => {
    expect(movedSectionIds(["a", "b", "c", "d"], "d", "b")).toEqual(["a", "d", "b", "c"]);
  });

  test("a no-op move returns the same array, so nothing downstream sees a write", () => {
    const order = ["a", "b", "c"];
    // Same identity is the "nothing happened" signal the drag preview and the commit both read.
    expect(movedSectionIds(order, "b", "b")).toBe(order);
    expect(movedSectionIds(order, "b", "ghost")).toBe(order);
    expect(movedSectionIds(order, "ghost", "b")).toBe(order);
  });

  test("a move never loses or duplicates a section", () => {
    const order = ["a", "b", "c", "d", "e"];
    for (const moved of order) {
      for (const over of order) {
        const next = movedSectionIds(order, moved, over);
        expect([...next].sort()).toEqual([...order].sort());
        expect(new Set(next).size).toBe(next.length);
      }
    }
  });
});

/**
 * THE DRAG'S HIT TEST, which is a decision and not a lookup.
 *
 * Issue #94: the rule used to be "whichever row's box the pointer is in", and that rule has no
 * hysteresis — the swap it asks for slides the displaced neighbour straight back under the
 * pointer, and the next frame asks for the swap back. So what is tested here is the property
 * a lookup cannot have: that applying the answer moves the stack AWAY from the threshold that
 * would undo it, for every pointer position on a slow sweep in both directions.
 */

/** A stack laid out top to bottom from a row order and a height per row. */
function stack(order: readonly string[], heights: Readonly<Record<string, number>>): SectionBox[] {
  let top = 0;
  return order.map((id) => {
    const box = { id, top, bottom: top + (heights[id] ?? 0) };
    top = box.bottom;
    return box;
  });
}

/** Four 40px rows: a at 0–40, b at 40–80, c at 80–120, d at 120–160. */
const EVEN: Readonly<Record<string, number>> = { a: 40, b: 40, c: 40, d: 40 };

describe("crossedSectionId", () => {
  test("entering a neighbour's box is not crossing it — the midpoint is", () => {
    const boxes = stack(["a", "b", "c", "d"], EVEN);
    // Inside `b` (40–80) but above its midpoint: the old rule's swap point, and now nothing.
    expect(crossedSectionId(boxes, "a", 45)).toBeNull();
    expect(crossedSectionId(boxes, "a", 60)).toBeNull();
    expect(crossedSectionId(boxes, "a", 60 + SECTION_CROSS_MARGIN)).toBeNull();
    expect(crossedSectionId(boxes, "a", 61 + SECTION_CROSS_MARGIN)).toBe("b");
  });

  test("crossing upward is the same rule mirrored", () => {
    const boxes = stack(["a", "b", "c", "d"], EVEN);
    expect(crossedSectionId(boxes, "d", 115)).toBeNull();
    expect(crossedSectionId(boxes, "d", 100 - SECTION_CROSS_MARGIN)).toBeNull();
    expect(crossedSectionId(boxes, "d", 99 - SECTION_CROSS_MARGIN)).toBe("c");
  });

  test("the row in hand is never the answer, wherever the pointer sits inside it", () => {
    const boxes = stack(["a", "b", "c", "d"], EVEN);
    for (let y = 40; y <= 80; y++) expect(crossedSectionId(boxes, "b", y)).not.toBe("b");
    expect(crossedSectionId(boxes, "b", 60)).toBeNull();
  });

  test("a pointer that outran the frames lands where it IS, not one row behind it", () => {
    const boxes = stack(["a", "b", "c", "d"], EVEN);
    // Past b's midpoint and c's, short of d's: two rows crossed, and the far one is the seat.
    expect(crossedSectionId(boxes, "a", 110)).toBe("c");
    expect(crossedSectionId(boxes, "a", 155)).toBe("d");
    expect(crossedSectionId(boxes, "d", 5)).toBe("a");
  });

  test("a row the stack does not hold moves nothing", () => {
    expect(crossedSectionId(stack(["a", "b"], EVEN), "ghost", 60)).toBeNull();
    expect(crossedSectionId([], "a", 60)).toBeNull();
  });

  test("a slow sweep down and back crosses each boundary exactly once", () => {
    /*
      The oscillation, reproduced as arithmetic: sweep the pointer one pixel at a time, apply
      every answer the way the drag does, and re-measure. Each boundary may be crossed once
      going down and once coming back — 6 for three boundaries — and a stack that rings would
      count dozens.
    */
    const heights: Readonly<Record<string, number>> = { a: 40, b: 24, c: 64, d: 40 };
    let order: readonly string[] = ["a", "b", "c", "d"];
    const seen: string[] = [order.join(" ")];
    const sweep = [
      ...Array.from({ length: 169 }, (_, step) => 1 + step),
      ...Array.from({ length: 169 }, (_, step) => 169 - step),
    ];
    for (const y of sweep) {
      const over = crossedSectionId(stack(order, heights), "a", y);
      if (over === null) continue;
      const next = movedSectionIds(order, "a", over);
      if (next === order) continue;
      order = next;
      seen.push(order.join(" "));
    }
    expect(seen.length - 1).toBe(6);
    // And it came home: a sweep that ends where it started ends in the order it started in.
    expect(order).toEqual(["a", "b", "c", "d"]);
  });

  test("a zero-height row in hand still has a band to cross back over", () => {
    /*
      `core.shell.status` reports nothing and draws no box, so the held row's own height —
      which is what separates a swap from its own undo everywhere else — is zero. The margin
      is the floor under that, and this is the case that needs it: crossing `c` must not be
      undone by the very next pixel back.
    */
    const heights: Readonly<Record<string, number>> = { a: 40, status: 0, c: 40 };
    const order = ["a", "status", "c"];
    const crossing = crossedSectionId(stack(order, heights), "status", 61 + SECTION_CROSS_MARGIN);
    expect(crossing).toBe("c");
    const next = movedSectionIds(order, "status", crossing ?? "");
    expect(next).toEqual(["a", "c", "status"]);
    // Same pointer, new layout: `c` now sits at 40–80 with its midpoint at 60, and the pointer
    // is a whole margin past it in the direction it came from. Nothing is asked for.
    expect(crossedSectionId(stack(next, heights), "status", 61 + SECTION_CROSS_MARGIN)).toBeNull();
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

  test("it reads back through panelSections, and only for the panel that holds it", () => {
    const next = withPanelSections(shell(), SIDEBAR, ["plugins", "index"]);
    expect(panelSections(next, SIDEBAR)).toEqual(["plugins", "index"]);
    expect(panelSections(next, MAIN)).toBeUndefined();
    expect(panelSections(shell(), SIDEBAR)).toBeUndefined();
    expect(panelSections(null, SIDEBAR)).toBeUndefined();
  });

  test("an empty order clears the field rather than storing an empty arrangement", () => {
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
    // A duplicate makes "the order" ambiguous — the same rule `validateTileLayout` applies.
    expect(withPanelSections(shell(), SIDEBAR, ["index", "index"])).toBeNull();
    // Past the wire bound.
    const wide = Array.from({ length: MAX_PANEL_SECTIONS + 1 }, (_unused, i) => `s${String(i)}`);
    expect(withPanelSections(shell(), SIDEBAR, wide)).toBeNull();
    expect(withPanelSections(shell(), SIDEBAR, wide.slice(1))).not.toBeNull();
    // A panel this tree does not show has no leaf to arrange, so there is nothing to write.
    expect(withPanelSections(shell(), "core.notes.panel", ["index"])).toBeNull();
  });

  test("re-arranging replaces the stored order instead of accumulating one", () => {
    const first = withPanelSections(shell(), SIDEBAR, ["plugins", "index"]) ?? {};
    const second = withPanelSections(first, SIDEBAR, ["index", "plugins"]);
    expect(second?.["ws-sidebar"]?.sections).toEqual(["index", "plugins"]);
  });

  test("the stored order survives the round trip the sidebar actually makes", () => {
    // The full loop: declared order in, one grab, commit, read back, render order out.
    const declared = ["index", "machines", "plugins"];
    const grabbed = movedSectionIds(arrangedSectionIds(declared, undefined), "plugins", "index");
    const committed = withPanelSections(shell(), SIDEBAR, grabbed);
    expect(arrangedSectionIds(declared, panelSections(committed, SIDEBAR))).toEqual([
      "plugins",
      "index",
      "machines",
    ]);
  });
});

/**
 * THE CLUSTER POLICY.
 *
 * The contract is two sentences of the manifest field's meaning, and both are about a cluster
 * being DECLARED rather than positional: members paint as one unit wherever the earliest of
 * them sits, and a stack cannot half-honour membership. The cases worth pinning are the ones an
 * arrangement or a roster change walks into — a member dragged away from its neighbour, a
 * member whose plugin is off and never reaches the stack, a word with one live member.
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
      units([
        row("status"),
        row("keys", "utility"),
        row("plugins", "utility"),
        row("identity"),
      ]),
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
      units([
        row("a", "left"),
        row("b", "right"),
        row("c", "left"),
        row("d", "right"),
      ]),
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
