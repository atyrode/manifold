import { describe, expect, test } from "bun:test";
import type { PluginManifest, PluginRosterEntry } from "@manifold/protocol";
import { nodeTypesFor } from "./flow-pad-view.tsx";
import { PortalNode } from "./flow-portal-node.tsx";
import { buildWebComposition, type WebPluginDef } from "./plugin-host.tsx";

/**
 * THE NODE-TYPE MAP IS A CACHE WITH TEETH.
 *
 * React Flow remounts every node on the board when its `nodeTypes` object changes identity,
 * and remounting a portal reattaches the PTY behind it. Hot enable/disable (D4) recomposes on
 * every roster change, so the map must be keyed on the ELEMENT vocabulary alone: an
 * administrator hiding a sidebar section may not disturb a single terminal.
 *
 * The path exercised here is the production one — roster → `buildWebComposition` → registry →
 * `nodeTypesFor` — because the contract only holds if the registry the composition builds is
 * itself stable under unrelated change.
 */

const DrawNode = (): null => null;
const OtherNode = (): null => null;

function entry(
  id: string,
  contributes: Partial<PluginManifest["contributes"]>,
  enabled = true,
): PluginRosterEntry {
  return {
    manifest: {
      id,
      version: "0.1.0",
      title: id,
      description: "",
      capabilities: [],
      contributes: {
        panels: [],
        sections: [],
        elements: [],
        tools: [],
        events: [],
        ...contributes,
      },
    },
    enabled,
    source: "builtin",
    actions: [],
  };
}

const DRAW = entry("core.draw", { elements: [{ type: "draw", title: "Drawing" }] });
const DRAW_OFF = entry("core.draw", { elements: [{ type: "draw", title: "Drawing" }] }, false);
const MACHINES = entry("core.machines", { sections: [{ id: "machines", title: "M", order: 1 }] });
const MACHINES_OFF = entry(
  "core.machines",
  { sections: [{ id: "machines", title: "M", order: 1 }] },
  false,
);

const DEFS: readonly WebPluginDef[] = [{ id: "core.draw", elements: { draw: DrawNode } }];

/** The registry as the canvas receives it: whatever the roster composed, nothing hand-built. */
function registry(roster: readonly PluginRosterEntry[], revision: number, defs = DEFS) {
  return buildWebComposition([...roster], revision, defs);
}

describe("nodeTypesFor", () => {
  test("an unrelated toggle returns the IDENTICAL map, so no live terminal is remounted", () => {
    const before = registry([DRAW, MACHINES], 1);
    const after = registry([DRAW, MACHINES_OFF], 2);

    // Two different compositions, two different registry objects, one node-type map: the
    // element vocabulary did not move, so React Flow is handed exactly what it already has.
    expect(after.elements).not.toBe(before.elements);
    expect(nodeTypesFor(after.elements, after.pluginTitle)).toBe(
      nodeTypesFor(before.elements, before.pluginTitle),
    );
  });

  test("the same vocabulary in a different ORDER is still the same vocabulary", () => {
    const sketch = entry("core.sketch", { elements: [{ type: "sketch", title: "Sketch" }] });
    const defs: readonly WebPluginDef[] = [
      { id: "core.draw", elements: { draw: DrawNode } },
      { id: "core.sketch", elements: { sketch: OtherNode } },
    ];

    const forward = registry([DRAW, sketch], 1, defs);
    const backward = registry([sketch, DRAW], 2, defs);

    // The registry's iteration order follows ROSTER order, which is composition bookkeeping
    // rather than a fact about what the canvas paints. Keying on it would mean a reordered
    // plugin list reattaches every live PTY on the board for no visible reason.
    expect([...backward.elements.keys()]).toEqual([...forward.elements.keys()].reverse());
    expect(nodeTypesFor(backward.elements, backward.pluginTitle)).toBe(
      nodeTypesFor(forward.elements, forward.pluginTitle),
    );
    // Both species are in that one map, whichever order built it.
    const map = nodeTypesFor(forward.elements, forward.pluginTitle);
    expect(Object.keys(map).sort()).toEqual(["draw", "portal", "sketch"]);
  });

  test("flipping an element plugin's enabled bit returns a FRESH map", () => {
    const on = registry([DRAW, MACHINES], 1);
    const off = registry([DRAW_OFF, MACHINES], 2);

    const enabledMap = nodeTypesFor(on.elements, on.pluginTitle);
    const disabledMap = nodeTypesFor(off.elements, off.pluginTitle);
    // A remount is exactly what SHOULD happen here: the ink must become a named placeholder
    // without a reload (D4/R3), and that means new renderers.
    expect(disabledMap).not.toBe(enabledMap);
    expect(disabledMap["draw"]).not.toBe(enabledMap["draw"]);
    // The wire type stays paintable either way — a scene holding a stroke authored while the
    // plugin was on must render SOMETHING that names the plugin, never nothing.
    expect(disabledMap["draw"]).toBeDefined();

    // ...and switching back returns the map from before, so the ink comes back unremounted
    // relative to its own earlier state.
    const again = registry([DRAW, MACHINES_OFF], 3);
    expect(nodeTypesFor(again.elements, again.pluginTitle)).toBe(enabledMap);
  });

  test("a different attached component is a different vocabulary", () => {
    const first = registry([DRAW], 1, [{ id: "core.draw", elements: { draw: DrawNode } }]);
    const second = registry([DRAW], 2, [{ id: "core.draw", elements: { draw: OtherNode } }]);

    // The signature keys on WHICH component is attached, not merely on the type name: a
    // hot-swapped renderer that reused the cached map would keep painting the old one.
    expect(nodeTypesFor(second.elements, second.pluginTitle)).not.toBe(
      nodeTypesFor(first.elements, first.pluginTitle),
    );
  });

  test("a declared element with no registered renderer is still a species", () => {
    const unattached = registry([DRAW], 1, []);

    const map = nodeTypesFor(unattached.elements, unattached.pluginTitle);
    // "Declared but unavailable" is a third state beside enabled and disabled (a bundle that
    // shipped without the web half), and it renders a named placeholder rather than crashing
    // React Flow with an unknown node type.
    expect(map["draw"]).toBeDefined();
    expect(map["draw"]).not.toBe(DrawNode);
  });

  test("the engine's own species are not overridable by a manifest that claims them", () => {
    const shadow = registry(
      [entry("core.rogue", { elements: [{ type: "portal", title: "Not a portal" }] })],
      1,
      [{ id: "core.rogue", elements: { portal: DrawNode } }],
    );

    const map = nodeTypesFor(shadow.elements, shadow.pluginTitle);
    // D5 refuses plugin-versus-plugin collisions in the composer; this is the one place a
    // plugin could otherwise shadow the ENGINE — floor renderers are applied last and win.
    // `portal` is the whole floor vocabulary now that `text` belongs to `core.notes`, which
    // is exactly why it is the case worth pinning: addressing is not contributable.
    expect(map["portal"]).toBe(PortalNode);
  });

  test("a plugin's renderer is never handed to the canvas raw", () => {
    const composed = registry([DRAW], 1);

    // Geometry, selection and the commit path stay engine business: the contributed
    // component is wrapped at the paint boundary, so a plugin never learns how a scene
    // document is written.
    const map = nodeTypesFor(composed.elements, composed.pluginTitle);
    expect(map["draw"]).toBeDefined();
    expect(map["draw"]).not.toBe(DrawNode);
  });
});
