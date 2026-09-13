import { describe, expect, test } from "bun:test";
import {
  MAX_PANEL_ARG_BYTES,
  ROOT_TILE_ID,
  TileLayoutSchema,
  validPanelArg,
  validateTileLayout,
  type PanelArg,
  type Tile,
  type TileLayout,
  type TileRef,
} from "@manifold/protocol";

/**
 * A PANEL LEAF'S ARGUMENT ON THE WIRE (issue #516).
 *
 * The wire's claim is exactly three sentences, and each case below defends one of them: a
 * panel leaf MAY carry an opaque argument and a leaf written before the field existed is
 * still a legal leaf (absent ≡ none); the argument is meaningless anywhere a panel is not,
 * so the validator refuses it there; and what it carries must survive the round trip the
 * store promises — bounded, and JSON data all the way down, because a workspace tree is
 * persisted as JSON and read back as JSON.
 */

const PANEL: TileRef = { kind: "panel", panelId: "acme.feed.record" };

function leaf(id: string, ref: TileRef | null, arg?: PanelArg): Tile {
  return { id, dir: null, ratios: [], children: [], ref, ...(arg === undefined ? {} : { arg }) };
}

/** A one-leaf tree showing `ref`, carrying `arg` when one is given. */
function tree(ref: TileRef | null, arg?: PanelArg): TileLayout {
  return { [ROOT_TILE_ID]: leaf(ROOT_TILE_ID, ref, arg) };
}

describe("a panel leaf's argument", () => {
  test("a panel leaf is legal with an argument and legal without one", () => {
    const bare = TileLayoutSchema.safeParse(tree(PANEL));
    expect(bare.success).toBe(true);
    expect(validateTileLayout(bare.data ?? {})).toBe(true);
    // Absent ≡ none: the field is simply not there, which is what every tree written before
    // it existed looks like and what a parse of one produces.
    expect(bare.data?.[ROOT_TILE_ID]).not.toHaveProperty("arg");

    const opened = TileLayoutSchema.safeParse(tree(PANEL, { id: "r-7", peel: true }));
    expect(opened.success).toBe(true);
    expect(validateTileLayout(opened.data ?? {})).toBe(true);
    // Opaque: the keys and values are the panel's own, so a parse hands back what it got.
    expect(opened.data?.[ROOT_TILE_ID]?.arg).toEqual({ id: "r-7", peel: true });
  });

  test("an argument on anything but a panel leaf is refused", () => {
    const arg = { id: "r-7" };
    // A terminal, a container, a spacer and a vacant seat are not panels, and a SPLIT holds
    // structure rather than content — an argument on any of them names nothing.
    expect(validateTileLayout(tree({ kind: "terminal", terminalId: "t1" }, arg))).toBe(false);
    expect(validateTileLayout(tree({ kind: "container", containerId: "c1" }, arg))).toBe(false);
    expect(validateTileLayout(tree({ kind: "spacer" }, arg))).toBe(false);
    expect(validateTileLayout(tree(null, arg))).toBe(false);
    expect(
      validateTileLayout({
        [ROOT_TILE_ID]: {
          id: ROOT_TILE_ID,
          dir: "row",
          ratios: [1, 1],
          children: ["a", "b"],
          ref: null,
          arg,
        },
        a: leaf("a", PANEL),
        b: leaf("b", PANEL),
      }),
    ).toBe(false);
  });

  test("the bound is bytes of JSON, and the door refuses the tree that breaks it", () => {
    const fits = { id: "x".repeat(MAX_PANEL_ARG_BYTES - 20) };
    expect(JSON.stringify(fits).length).toBeLessThanOrEqual(MAX_PANEL_ARG_BYTES);
    expect(validPanelArg(fits)).toBe(true);
    expect(validateTileLayout(tree(PANEL, fits))).toBe(true);

    const over = { id: "x".repeat(MAX_PANEL_ARG_BYTES) };
    expect(validPanelArg(over)).toBe(false);
    // The SCHEMA accepts it — a record of unknowns cannot express a byte bound — so the
    // refusal has to come from the validator every writer passes through, which is what
    // keeps an oversized argument out of the store rather than merely out of one caller.
    expect(TileLayoutSchema.safeParse(tree(PANEL, over)).success).toBe(true);
    expect(validateTileLayout(tree(PANEL, over))).toBe(false);

    // BYTES, not code units: an argument that fits as UTF-16 and not as UTF-8 is refused.
    const wide = { id: "é".repeat(MAX_PANEL_ARG_BYTES - 100) };
    expect(JSON.stringify(wide).length).toBeLessThan(MAX_PANEL_ARG_BYTES);
    expect(validPanelArg(wide)).toBe(false);
  });

  test("only JSON data may ride a leaf, because JSON is what comes back", () => {
    expect(
      validPanelArg({ id: "r", n: 1, ok: false, none: null, list: [1, "a", { deep: [] }] }),
    ).toBe(true);
    // Each of these round-trips as something else — a dropped member, `null`, a string — so
    // the panel would be handed an argument it never wrote.
    expect(validPanelArg({ id: undefined })).toBe(false);
    expect(validPanelArg({ n: Number.NaN })).toBe(false);
    expect(validPanelArg({ n: Number.POSITIVE_INFINITY })).toBe(false);
    expect(validPanelArg({ at: new Date(0) })).toBe(false);
    expect(validPanelArg({ seen: new Set(["a"]) })).toBe(false);
    expect(validPanelArg({ run: () => undefined })).toBe(false);
    expect(validPanelArg({ tag: Symbol("x") })).toBe(false);

    // A cycle is a refusal rather than a throw: the validator is total over what a caller
    // can hand it, so the door answers instead of faulting.
    const cyclic: Record<string, unknown> = { id: "r" };
    cyclic["self"] = cyclic;
    expect(validPanelArg(cyclic)).toBe(false);
    // The same object reached TWICE is not a cycle — JSON copies it — so it stays legal.
    const shared = { id: "r" };
    expect(validPanelArg({ a: shared, b: shared })).toBe(true);
  });
});
