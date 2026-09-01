import { describe, expect, test } from "bun:test";
import type { ComposedSection } from "@manifold/plugin";
import { railRows } from "../src/rail-rows.ts";

/**
 * THE RAIL'S TWO ASSERTIONS ABOUT THE PRODUCT, without a browser.
 *
 * D4′ (ADR 0013): CHROME RENDERS ABSENCE. A disabled plugin's row leaves the sidebar
 * entirely — no tombstone, no inert body, no gap — while the Plugins section stays the one
 * ledger of what is off, and re-enabling puts the row back in the exact seat the principal
 * arranged it into. That contract used to be provable only for the three disclosure sections,
 * because everything else in the rail was hand-written floor JSX that no roster could touch.
 * Now the creators, the brand line, the status line, the key-table door and the identity footer
 * are rows too, so "disable `core.canvas`" has an observable answer about the sidebar, and it
 * is asserted here rather than only in the browser gate.
 *
 * THE COLLAPSED RAIL is the second: it keeps every PLAIN row (they draw themselves icon-only)
 * and exactly one body, the absorber. That is what makes the icon rail the same stack rather
 * than a second layout.
 *
 * The ORDER is not tested here — it is `arrangedSectionIds`' own contract, tested in
 * `packages/plugin/test/layout.test.ts`. This module is handed a live order and answers which
 * of those rows paint.
 */

function section(
  id: string,
  plugin: string,
  presentation: "disclosure" | "plain",
  enabled = true,
  order = 0,
): ComposedSection {
  return { id, plugin, title: id, order, presentation, enabled };
}

/** The shipped rail, in its default (manifest) order. */
const BRAND = section("brand", "core.brand", "plain", true, 1);
const NEW_CANVAS = section("new-canvas", "core.canvas", "plain", true, 2);
const NEW_COMPOSITION = section("new-composition", "core.compositions", "plain", true, 3);
const NEW_FOLDER = section("new-folder", "core.index", "plain", true, 4);
const INDEX = section("index", "core.index", "disclosure", true, 10);
const MACHINES = section("machines", "core.machines", "disclosure", true, 20);
const PLUGINS = section("plugins", "core.plugins", "disclosure", true, 30);
const STATUS = section("status", "core.shell", "plain", true, 40);
const KEYS = section("keys", "core.keys", "plain", true, 50);
const IDENTITY = section("identity", "core.shell", "plain", true, 60);

const RAIL: readonly ComposedSection[] = [
  BRAND,
  NEW_CANVAS,
  NEW_COMPOSITION,
  NEW_FOLDER,
  INDEX,
  MACHINES,
  PLUGINS,
  STATUS,
  KEYS,
  IDENTITY,
];

const DEFAULT_ORDER = RAIL.map((row) => row.id);

function painted(
  declared: readonly ComposedSection[],
  order: readonly string[] = DEFAULT_ORDER,
  sidebarOpen = true,
): readonly string[] {
  return railRows(declared, order, sidebarOpen).map((row) => row.section.id);
}

function absorber(
  declared: readonly ComposedSection[],
  order: readonly string[] = DEFAULT_ORDER,
  sidebarOpen = true,
): string | undefined {
  return railRows(declared, order, sidebarOpen).find((row) => row.grow)?.section.id;
}

describe("railRows", () => {
  test("the shipped rail paints every row in the given order", () => {
    expect(painted(RAIL)).toEqual([
      "brand",
      "new-canvas",
      "new-composition",
      "new-folder",
      "index",
      "machines",
      "plugins",
      "status",
      "keys",
      "identity",
    ]);
  });

  test("disabling core.canvas VANISHES its creator and nothing else (D4′)", () => {
    const off = RAIL.map((row) =>
      row.plugin === "core.canvas" ? { ...row, enabled: false } : row,
    );

    expect(painted(off)).toEqual([
      "brand",
      "new-composition",
      "new-folder",
      "index",
      "machines",
      "plugins",
      "status",
      "keys",
      "identity",
    ]);
    // No tombstone: the row is not present-and-marked, it is gone from the stack.
    expect(painted(off)).not.toContain("new-canvas");
  });

  test("re-enabling restores the exact seat the principal arranged it into", () => {
    // This reader dragged the canvas creator below the composition creator; the arrangement
    // is stored per principal and survives the plugin being off, because the ORDER is data
    // and only the PAINTING is filtered.
    const arranged = [
      "brand",
      "new-composition",
      "new-canvas",
      "new-folder",
      "index",
      "machines",
      "plugins",
      "status",
      "keys",
      "identity",
    ];
    const off = RAIL.map((row) =>
      row.plugin === "core.canvas" ? { ...row, enabled: false } : row,
    );

    expect(painted(off, arranged)).toEqual([
      "brand",
      "new-composition",
      "new-folder",
      "index",
      "machines",
      "plugins",
      "status",
      "keys",
      "identity",
    ]);
    expect(painted(RAIL, arranged)).toEqual(arranged);
  });

  test("a disabled DISCLOSURE owner hands the absorber to the next body", () => {
    // The same rule the three sections have always had, now read off the live order: the
    // leftover height goes to the first row WITH a body, whichever plugin that is.
    expect(absorber(RAIL)).toBe("index");

    const indexOff = RAIL.map((row) => (row.id === "index" ? { ...row, enabled: false } : row));
    expect(absorber(indexOff)).toBe("machines");
  });

  test("a plain row never absorbs the rail's height, even in first place", () => {
    // Otherwise the brand line — first in the default order — would be stretched to fill the
    // sidebar, which is how a plain row would have broken the old `sections[0]` rule.
    expect(absorber(RAIL)).toBe("index");
    const plainOnly = RAIL.filter((row) => row.presentation === "plain");
    expect(
      absorber(
        plainOnly,
        plainOnly.map((row) => row.id),
      ),
    ).toBeUndefined();
  });

  test("an order naming a row the roster does not carry drops it, and paints the rest", () => {
    // A plugin the principal once arranged has been purged; their stored order still names it.
    expect(painted(RAIL, ["brand", "core.stranger.rows", "index"])).toEqual(["brand", "index"]);
  });

  test("the COLLAPSED rail keeps every plain row and exactly one body", () => {
    expect(painted(RAIL, DEFAULT_ORDER, false)).toEqual([
      "brand",
      "new-canvas",
      "new-composition",
      "new-folder",
      "index",
      "status",
      "keys",
      "identity",
    ]);
    expect(absorber(RAIL, DEFAULT_ORDER, false)).toBe("index");
  });

  test("a collapsed rail whose bodies are all off is the icon strip alone", () => {
    const bodiesOff = RAIL.map((row) =>
      row.presentation === "disclosure" ? { ...row, enabled: false } : row,
    );

    expect(painted(bodiesOff, DEFAULT_ORDER, false)).toEqual([
      "brand",
      "new-canvas",
      "new-composition",
      "new-folder",
      "status",
      "keys",
      "identity",
    ]);
    expect(absorber(bodiesOff, DEFAULT_ORDER, false)).toBeUndefined();
  });

  test("an empty roster paints nothing rather than throwing", () => {
    expect(painted([], [])).toEqual([]);
    expect(painted([], DEFAULT_ORDER)).toEqual([]);
  });
});
