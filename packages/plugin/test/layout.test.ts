import { describe, expect, test } from "bun:test";
import { MAX_PANEL_SECTIONS, validateTileLayout, type TileLayout } from "@manifold/protocol";
import {
  arrangedSectionIds,
  movedSectionIds,
  panelSections,
  withPanelSections,
  workspaceLayout,
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

/** The real default tree, so the commit shape is exercised against the shape it will meet. */
const shell = (): TileLayout => workspaceLayout({ sidebar: SIDEBAR, main: MAIN });

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
