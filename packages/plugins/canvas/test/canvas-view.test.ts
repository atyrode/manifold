import { describe, expect, test } from "bun:test";
import type { RegisteredElement } from "@manifold/plugin/hooks";
import { nodeTypesFor } from "../src/canvas-view.tsx";
import { PortalNode } from "../src/portal-element.tsx";

/**
 * THE NODE-TYPE MAP IS A CACHE WITH TEETH.
 *
 * React Flow remounts every node on the canvas when its `nodeTypes` object changes identity,
 * and remounting a portal reattaches the PTY behind it. Hot enable/disable (D4) recomposes on
 * every roster change and hands this ref a FRESH element registry each time, so the map
 * must be keyed on the ELEMENT VOCABULARY alone — the set of wire types, each type's enabled
 * bit, and which component is attached. An administrator hiding a sidebar section may not
 * disturb a single terminal.
 *
 * The input here is exactly what the canvas receives: `ProjectionRegistry.elements`, a fresh
 * `ReadonlyMap` per revision. That the ENGINE builds those maps correctly from a roster is
 * the engine's own contract, proven in `packages/web/test/plugin-host.test.ts`; what is proven
 * here is the half a plugin owns — that equal vocabularies in unequal maps collapse to one
 * object, and unequal vocabularies do not.
 */

const DrawNode = (): null => null;
const OtherNode = (): null => null;
/** Stands in for the engine's inert-contribution chrome, which the registry injects. */
const Placeholder = (): null => null;

function element(
  plugin: string,
  title: string,
  Component: (() => null) | null,
  enabled = true,
): RegisteredElement {
  return { plugin, title, enabled, Component };
}

/** One revision's element registry: a fresh map object every time, as the engine hands it. */
function registry(
  ...rows: readonly (readonly [string, RegisteredElement])[]
): ReadonlyMap<string, RegisteredElement> {
  return new Map(rows);
}

const DRAW = ["draw", element("core.draw", "Drawing", DrawNode)] as const;
const DRAW_OFF = ["draw", element("core.draw", "Drawing", DrawNode, false)] as const;
const SKETCH = ["sketch", element("core.sketch", "Sketch", OtherNode)] as const;

describe("nodeTypesFor", () => {
  test("an unrelated toggle returns the IDENTICAL map, so no live terminal is remounted", () => {
    // Toggling `core.machines` recomposes the whole registry — a new map object — while the
    // ELEMENT vocabulary is untouched, because that plugin contributes no element.
    const before = registry(DRAW);
    const after = registry(DRAW);

    expect(nodeTypesFor(after, Placeholder)).toBe(nodeTypesFor(before, Placeholder));
  });

  test("the same vocabulary in a different ORDER is still the same vocabulary", () => {
    const forward = registry(DRAW, SKETCH);
    const backward = registry(SKETCH, DRAW);

    // The registry's iteration order follows ROSTER order, which is composition bookkeeping
    // rather than a fact about what the canvas paints. Keying on it would mean a reordered
    // plugin list reattaches every live PTY on the canvas for no visible reason.
    expect(nodeTypesFor(backward, Placeholder)).toBe(nodeTypesFor(forward, Placeholder));
  });

  test("flipping an element plugin's enabled bit returns a FRESH map", () => {
    const enabledMap = nodeTypesFor(registry(DRAW), Placeholder);
    const disabledMap = nodeTypesFor(registry(DRAW_OFF), Placeholder);

    // A remount is exactly what SHOULD happen here: the ink must become a named placeholder
    // without a reload (D4/R3), and that means new renderers.
    expect(disabledMap).not.toBe(enabledMap);
    expect(disabledMap["draw"]).not.toBe(enabledMap["draw"]);
    // The wire type stays paintable either way — a scene holding a stroke authored while the
    // plugin was on must render SOMETHING that names the plugin, never nothing.
    expect(disabledMap["draw"]).toBeDefined();

    // ...and switching back returns the map from before, so the ink comes back unremounted
    // relative to its own earlier state.
    expect(nodeTypesFor(registry(DRAW), Placeholder)).toBe(enabledMap);
  });

  test("a different attached component is a different vocabulary", () => {
    const first = registry(["draw", element("core.draw", "Drawing", DrawNode)]);
    const second = registry(["draw", element("core.draw", "Drawing", OtherNode)]);

    // The signature keys on WHICH component is attached, not merely on the type name: a
    // hot-swapped renderer that reused the cached map would keep painting the old one.
    expect(nodeTypesFor(second, Placeholder)).not.toBe(nodeTypesFor(first, Placeholder));
  });

  test("a declared element with no registered renderer is still a species", () => {
    const map = nodeTypesFor(
      registry(["draw", element("core.draw", "Drawing", null)]),
      Placeholder,
    );

    // "Declared but unavailable" is a third state beside enabled and disabled (a bundle that
    // shipped without the web half), and it renders a named placeholder rather than crashing
    // React Flow with an unknown node type.
    expect(map["draw"]).toBeDefined();
    expect(map["draw"]).not.toBe(DrawNode);
  });

  test("this ref's own species is not overridable by a manifest that claims it", () => {
    const map = nodeTypesFor(
      registry(["portal", element("core.rogue", "Not a portal", DrawNode)]),
      Placeholder,
    );

    // D5 refuses plugin-versus-plugin collisions in the composer; this is the one place a
    // stranger could otherwise shadow the ref's OWN species — `portal` is applied last
    // and wins. Addressing is not contributable: a canvas that cannot paint a reference
    // cannot paint anything.
    expect(map["portal"]).toBe(PortalNode);
  });

  test("a plugin's renderer is never handed to the canvas raw", () => {
    // Geometry, selection and the commit path stay engine business: the contributed
    // component is wrapped at the paint boundary, so a plugin never learns how a scene
    // document is written.
    const map = nodeTypesFor(registry(DRAW), Placeholder);
    expect(map["draw"]).toBeDefined();
    expect(map["draw"]).not.toBe(DrawNode);
  });
});
