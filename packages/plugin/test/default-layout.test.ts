import { describe, expect, test } from "bun:test";
import {
  MAX_TILE_CHILDREN,
  TileLayoutSchema,
  validateTileLayout,
  type PluginManifest,
  type PluginRoster,
  type SeatDef,
  type TileLayout,
} from "@manifold/protocol";
import {
  DEFAULT_LAYOUT_CONDITIONS,
  DEFAULT_LAYOUT_NOTICES,
  composeDefaultLayout,
} from "../src/index.ts";

/**
 * THE DEFAULT WORKSPACE, COMPOSED (ADR 0017 S17-B).
 *
 * The claim under test is a migration claim first and a composition claim second: the tree the
 * shipped roster composes must be the tree the deleted constant returned — same shape, same
 * refs, same ratios — because every principal who has never arranged a workspace is looking at
 * that constant right now. Then the properties the constant could not have: a disabled plugin
 * seats nothing, a roster that asks for nothing still yields a servable tree, and two
 * compositions of one roster are the same tree.
 *
 * The input is a ROSTER, not an assembly, which is why these cases build roster rows directly:
 * the composer reads the published document both halves hold, so a case that assembled first
 * would be testing the composer through a join it does not use.
 */

function row(fields: {
  id: string;
  enabled?: boolean;
  panels?: PluginManifest["contributes"]["panels"];
  seats?: readonly SeatDef[];
}): PluginRoster[number] {
  return {
    manifest: {
      id: fields.id,
      version: "0.1.0",
      title: fields.id,
      description: "",
      capabilities: [],
      contributes: {
        panels: fields.panels ?? [],
        sections: [],
        elements: [],
        tools: [],
        events: [],
        ...(fields.seats === undefined ? {} : { seats: [...fields.seats] }),
      },
    },
    enabled: fields.enabled ?? true,
    source: "plugin",
    actions: [],
  };
}

/**
 * `core.shell` as it ships: the two panels it contributes, and the two seats that reproduce
 * the classical workspace. Spelled from the same numbers the real manifest declares, because
 * the equality below is what makes this wave a refactor rather than a redesign.
 */
const shell = (enabled = true): PluginRoster[number] =>
  row({
    id: "core.shell",
    enabled,
    panels: [
      { id: "sidebar", title: "Sidebar" },
      { id: "container-view", title: "Container View" },
    ],
    seats: [
      { panel: "sidebar", order: 100, ratio: 0.22 },
      { panel: "container-view", order: 200, ratio: 0.78 },
    ],
  });

/** A stranger's panel plugin that asks for a place BETWEEN the shell's two. */
const dock = (enabled = true): PluginRoster[number] =>
  row({
    id: "vendor.dock",
    enabled,
    panels: [{ id: "rail", title: "Rail" }],
    seats: [{ panel: "rail", order: 150, ratio: 0.5 }],
  });

/** A plugin with a panel and no seat: present in the roster, absent from the default. */
const atlas = (): PluginRoster[number] =>
  row({ id: "vendor.atlas", panels: [{ id: "map", title: "Map" }] });

/** The panel each leaf shows, in the tree's own order, so a case can assert refs as data. */
function seatedPanels(layout: TileLayout): readonly string[] {
  const root = layout["root"];
  if (root === undefined) return [];
  const ids = root.children.length === 0 ? ["root"] : root.children;
  return ids.flatMap((id) => {
    const ref = layout[id]?.ref;
    return ref === undefined || ref === null || ref.kind !== "panel" ? [] : [ref.panelId];
  });
}

describe("composeDefaultLayout", () => {
  test("the shipped roster composes exactly the tree the deleted constant returned", () => {
    const { layout, condition } = composeDefaultLayout([shell()]);
    expect(condition).toBe("seated");

    /*
      THE MIGRATION ASSERTION, spelled as the whole tree rather than as properties of it: two
      panel leaves in a row at [0.22, 0.78] under `root`, sidebar first. Only the SEAT tile ids
      differ from the old constant's `ws-sidebar`/`ws-main`, because a composer that seats N
      plugins cannot name a leaf after a role only two of them had — the ids are positional
      engine grammar now, and nothing outside a tree reads them.
    */
    expect(layout).toEqual({
      root: {
        id: "root",
        dir: "row",
        ratios: [0.22, 0.78],
        children: ["ws-seat-1", "ws-seat-2"],
        ref: null,
      },
      "ws-seat-1": {
        id: "ws-seat-1",
        dir: null,
        ratios: [],
        children: [],
        ref: { kind: "panel", panelId: "core.shell.sidebar" },
      },
      "ws-seat-2": {
        id: "ws-seat-2",
        dir: null,
        ratios: [],
        children: [],
        ref: { kind: "panel", panelId: "core.shell.container-view" },
      },
    });
    // A tree the wire accepts and the door may serve, not merely an object of the right shape.
    expect(validateTileLayout(TileLayoutSchema.parse(layout))).toBe(true);
  });

  test("seat order is the composition order, across plugins", () => {
    const { layout } = composeDefaultLayout([shell(), dock()]);
    // `vendor.dock` declared 150, between the shell's 100 and 200 — so an unrelated plugin
    // lands BETWEEN two of core.shell's panels without anybody editing core.shell.
    expect(seatedPanels(layout)).toEqual([
      "core.shell.sidebar",
      "vendor.dock.rail",
      "core.shell.container-view",
    ]);
    expect(layout["root"]?.ratios).toEqual([0.22, 0.5, 0.78]);
    expect(validateTileLayout(TileLayoutSchema.parse(layout))).toBe(true);
  });

  test("a tie on order falls through to the panel id, and a missing ratio resolves", () => {
    const { layout } = composeDefaultLayout([
      row({
        id: "vendor.late",
        panels: [{ id: "rail", title: "R" }],
        seats: [{ panel: "rail", order: 5 }],
      }),
      row({
        id: "vendor.early",
        panels: [{ id: "rail", title: "R" }],
        seats: [{ panel: "rail", order: 5 }],
      }),
    ]);

    // Roster order is late-then-early, so this ordering can only come from the tiebreak.
    expect(seatedPanels(layout)).toEqual(["vendor.early.rail", "vendor.late.rail"]);
    // Neither declared a weight, so both take the engine's default and the split is even.
    expect(layout["root"]?.ratios).toEqual([1, 1]);
  });

  test("disabling a seat-contributing plugin removes its seat, and the rest still validates", () => {
    const roster = [shell(), dock(false)];
    const { layout, condition } = composeDefaultLayout(roster);

    expect(condition).toBe("seated");
    expect(seatedPanels(layout)).toEqual(["core.shell.sidebar", "core.shell.container-view"]);
    expect(layout["root"]?.ratios).toEqual([0.22, 0.78]);
    expect(validateTileLayout(TileLayoutSchema.parse(layout))).toBe(true);
    // The seat is still DECLARED on the published row — only the composition skipped it, so
    // re-enabling restores its place with no manifest and no stored tree touched (D4′).
    expect(roster[1]?.manifest.contributes.seats).toHaveLength(1);
  });

  test("a plugin that seats nothing is in the roster and not in the default", () => {
    const { layout } = composeDefaultLayout([shell(), atlas()]);
    expect(seatedPanels(layout)).toEqual(["core.shell.sidebar", "core.shell.container-view"]);
  });

  test("a roster that asks for nothing yields an empty-but-valid tree, named", () => {
    const { layout, condition } = composeDefaultLayout([atlas()]);

    expect(condition).toBe("unseated");
    // A vacant root leaf: legal on the wire, servable by the layout door, and rendered as the
    // named empty pane every tree renderer already draws. Never a crash, never a missing tree.
    expect(layout).toEqual({
      root: { id: "root", dir: null, ratios: [], children: [], ref: null },
    });
    expect(validateTileLayout(TileLayoutSchema.parse(layout))).toBe(true);
    // The same answer for a roster whose every seater is switched off, which is the case a
    // shipped build can actually reach.
    expect(composeDefaultLayout([shell(false)]).condition).toBe("unseated");
  });

  test("a lone seat IS the root, because a split may not hold one child", () => {
    const { layout, condition } = composeDefaultLayout([dock()]);

    expect(condition).toBe("seated");
    expect(layout["root"]?.ref).toEqual({ kind: "panel", panelId: "vendor.dock.rail" });
    expect(layout["root"]?.dir).toBeNull();
    expect(validateTileLayout(TileLayoutSchema.parse(layout))).toBe(true);
  });

  test("more seats than a split may hold is a NAMED condition, not an unservable tree", () => {
    const crowd = Array.from({ length: MAX_TILE_CHILDREN + 2 }, (_, index) =>
      row({
        id: `vendor.p${String(index).padStart(2, "0")}`,
        panels: [{ id: "rail", title: "Rail" }],
        seats: [{ panel: "rail", order: index }],
      }),
    );
    const { layout, condition } = composeDefaultLayout(crowd);

    expect(condition).toBe("crowded");
    expect(layout["root"]?.children).toHaveLength(MAX_TILE_CHILDREN);
    // The bound is the WIRE's own fan-out bound, so the overflow is answered by being unseated
    // rather than by making the whole default unparseable for everyone.
    expect(validateTileLayout(TileLayoutSchema.parse(layout))).toBe(true);
    expect(seatedPanels(layout)[0]).toBe("vendor.p00.rail");
  });

  test("composition is deterministic: one roster, one tree, whatever the row order", () => {
    const first = composeDefaultLayout([shell(), dock(), atlas()]);
    const second = composeDefaultLayout([atlas(), dock(), shell()]);

    // Identical, not merely equivalent — including the ids and their order, since a default
    // that renamed or reshuffled its tiles between two boots would make the tree a principal
    // arranged unreadable against the one they were given.
    expect(second).toEqual(first);
    expect(JSON.stringify(second.layout)).toBe(JSON.stringify(first.layout));
  });

  test("every condition a composition can report has a sentence, and only the odd ones do", () => {
    /*
      The vocabulary↔sentence join, asserted rather than trusted: a condition the shell cannot
      say is a condition a reader meets as an unexplained empty pane. `seated` is the ordinary
      case and therefore says nothing, which is the one absence this table is allowed.
    */
    for (const condition of DEFAULT_LAYOUT_CONDITIONS) {
      const notice = DEFAULT_LAYOUT_NOTICES[condition];
      if (condition === "seated") expect(notice).toBeNull();
      else expect(notice?.length ?? 0).toBeGreaterThan(0);
    }
    expect(Object.keys(DEFAULT_LAYOUT_NOTICES).sort()).toEqual(
      [...DEFAULT_LAYOUT_CONDITIONS].sort(),
    );
  });
});
