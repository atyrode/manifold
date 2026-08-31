import { describe, expect, test } from "bun:test";
import type { PluginManifest, PluginRoster, PluginRosterEntry } from "@manifold/protocol";
import { buildWebComposition, type WebPluginDef } from "./plugin-host.tsx";

/**
 * THE JOIN: the server's vocabulary meets the browser's registrations.
 *
 * The roster decides WHAT exists and whether it is enabled (D3 — registration is shared
 * state); `WEB_PLUGIN_DEFS` only says who draws it. Everything below defends that split:
 * a registration for a name the server never published contributes nothing, and a declared
 * name with no registration is still PRESENT so the outlet can render a placeholder naming
 * the plugin it waits for rather than a blank tile (D4).
 *
 * Components are stand-ins here — nothing renders. What matters is which object arrives at
 * which key, because the canvas keys React Flow's node types off exactly these identities.
 */

const Sidebar = (): null => null;
const PadView = (): null => null;
const MachinesSection = (): null => null;
const DrawNode = (): null => null;
const UriRoute = (): null => null;
/** A stand-in facet: identity is all the join cares about. */
const TERMINALS = {
  View: (): null => null,
  defaultMachine: (): null => null,
  rememberMachine: (): void => undefined,
};

interface ManifestFields {
  readonly id: string;
  readonly title?: string;
  readonly contributes?: Partial<PluginManifest["contributes"]>;
}

function entry(fields: ManifestFields, enabled = true): PluginRosterEntry {
  return {
    manifest: {
      id: fields.id,
      version: "0.1.0",
      title: fields.title ?? fields.id,
      description: "",
      capabilities: [],
      contributes: {
        panels: [],
        sections: [],
        elements: [],
        tools: [],
        events: [],
        ...fields.contributes,
      },
    },
    enabled,
    source: "builtin",
    actions: [],
  };
}

const SHELL = {
  id: "core.shell",
  title: "Shell",
  contributes: {
    panels: [
      { id: "sidebar", title: "Sidebar" },
      { id: "pad-view", title: "Pad" },
    ],
  },
} as const satisfies ManifestFields;

const MACHINES = {
  id: "core.machines",
  title: "Machines",
  contributes: { sections: [{ id: "machines", title: "Machines", order: 20 }] },
} as const satisfies ManifestFields;

const DRAW = {
  id: "core.draw",
  title: "Drawing",
  contributes: {
    elements: [{ type: "draw", title: "Drawing" }],
    tools: [{ id: "draw", title: "Draw" }],
  },
} as const satisfies ManifestFields;

const DEFS: readonly WebPluginDef[] = [
  { id: "core.shell", panels: { sidebar: Sidebar, "pad-view": PadView } },
  { id: "core.machines", sections: { machines: MachinesSection } },
  { id: "core.draw", elements: { draw: DrawNode } },
  { id: "core.uri", routes: { uri: UriRoute } },
];

describe("buildWebComposition", () => {
  test("registrations attach to declared names, keyed the way each kind is addressed", () => {
    const composition = buildWebComposition([entry(SHELL), entry(MACHINES), entry(DRAW)], 3, DEFS);

    // Panels are keyed by FULL id, because that is the string a `panel` tile surface holds.
    expect([...composition.panels.keys()]).toEqual(["core.shell.sidebar", "core.shell.pad-view"]);
    expect(composition.panels.get("core.shell.sidebar")).toEqual({
      plugin: "core.shell",
      title: "Sidebar",
      Component: Sidebar,
      enabled: true,
    });
    // Sections are keyed globally: one sidebar, one slot per name.
    expect(composition.sections.map((section) => section.id)).toEqual(["machines"]);
    expect(composition.sections[0]?.Component).toBe(MachinesSection);
    // Elements are keyed by the WIRE type a scene document stores, not by a local name.
    expect(composition.elements.get("draw")?.Component).toBe(DrawNode);
    // The MANIFEST owns the tool vocabulary outright: a tool is a NAME the surface holding
    // the toolbar switches on, so there is no registration to attach and nothing a web half
    // could use to rename what the roster declared.
    expect(composition.tools).toEqual([
      { id: "draw", plugin: "core.draw", title: "Draw", enabled: true },
    ]);
    expect(composition.revision).toBe(3);
    expect(composition.roster).toHaveLength(3);
  });

  test("a declared name with no registration is PRESENT with a null component", () => {
    // The placeholder path (D4): the outlet needs the plugin's title to name what it is
    // waiting for, so dropping the entry would leave it with nothing to say.
    const composition = buildWebComposition([entry(SHELL), entry(DRAW)], 1, [
      { id: "core.shell", panels: { sidebar: Sidebar } },
    ]);

    expect(composition.panels.get("core.shell.pad-view")).toEqual({
      plugin: "core.shell",
      title: "Pad",
      Component: null,
      enabled: true,
    });
    expect(composition.elements.get("draw")?.Component).toBeNull();
    expect(composition.tools[0]?.title).toBe("Draw");
    expect(composition.pluginTitle("core.draw")).toBe("Drawing");
  });

  test("a disabled plugin keeps every contribution, tagged enabled:false", () => {
    const composition = buildWebComposition(
      [entry(SHELL), entry(MACHINES, false), entry(DRAW, false), entry({ id: "core.uri" }, false)],
      1,
      DEFS,
    );

    // D4: a disable is not a deletion. The vocabulary stays so a stroke authored while the
    // plugin was on renders an inert surface NAMING the plugin, and enabling brings the ink
    // back with no reload — which is impossible if the entry vanished.
    expect(composition.enabled("core.machines")).toBe(false);
    expect(composition.enabled("core.shell")).toBe(true);
    expect(composition.sections[0]).toEqual({
      id: "machines",
      plugin: "core.machines",
      title: "Machines",
      order: 20,
      Component: MachinesSection,
      enabled: false,
    });
    expect(composition.elements.get("draw")?.enabled).toBe(false);
    expect(composition.tools[0]?.enabled).toBe(false);
    // Routes have no manifest row, so their enablement can only come from the roster entry
    // of the plugin that registered them — a disabled deep link renders the same placeholder.
    expect(composition.routes.get("uri")).toEqual({
      plugin: "core.uri",
      Component: UriRoute,
      enabled: false,
    });
    // And the title survives, because that is what the placeholder prints.
    expect(composition.pluginTitle("core.draw")).toBe("Drawing");
  });

  test("the three projection channels take their plugin's roster state", () => {
    // Pad surfaces, overlays and the terminal facet have no manifest row — like routes, they
    // are not surfaces the WORKSPACE composes — so the only thing that can gate them is the
    // registering plugin's enablement. That is what makes disabling a renderer paint the
    // engine's named placeholder instead of leaving a blank pane (ADR 0013 §4).
    const defs: readonly WebPluginDef[] = [
      { id: "core.canvas", padSurfaces: { canvas: PadView } },
      { id: "core.presence", overlays: { "pad-roster": UriRoute } },
      { id: "core.terminals", terminals: TERMINALS },
    ];
    const roster: PluginRoster = [
      entry({ id: "core.canvas", title: "Canvas" }),
      entry({ id: "core.presence", title: "Presence" }, false),
      entry({ id: "core.terminals", title: "Terminals" }, false),
    ];
    const composition = buildWebComposition(roster, 1, defs);

    expect(composition.padSurfaces.get("canvas")).toEqual({
      plugin: "core.canvas",
      title: "Canvas",
      Component: PadView,
      enabled: true,
    });
    // A registration for a discipline nobody registered is simply absent, and the outlet
    // reads that as "unknown" rather than guessing a renderer.
    expect(composition.padSurfaces.get("tiled")).toBeUndefined();
    expect(composition.overlays.get("pad-roster")?.enabled).toBe(false);
    // The facet SURVIVES the disable, tagged, because the placeholder has to name the plugin
    // whose viewer is missing — and re-enabling must not need a re-registration.
    expect(composition.terminals).toEqual({
      plugin: "core.terminals",
      title: "Terminals",
      enabled: false,
      facet: TERMINALS,
    });
  });

  test("an id the roster never published is unknown, and unknown is not enabled", () => {
    const composition = buildWebComposition([entry(SHELL)], 1, DEFS);

    // The two states a placeholder distinguishes: "disabled" (a row saying so) versus
    // "unknown" (no row at all — a layout naming a plugin this workspace does not have).
    expect(composition.enabled("core.ghost")).toBe(false);
    expect(composition.pluginTitle("core.ghost")).toBeNull();
  });

  test("a registration the server never published contributes NOTHING", () => {
    // The roster is the vocabulary, so a browser build cannot invent a plugin by shipping a
    // component for it — otherwise a stale bundle would show panels the server refuses to
    // dispatch for, and A2 parity (every principal sees the same workspace) would break.
    const composition = buildWebComposition([entry(SHELL)], 1, [
      ...DEFS,
      { id: "core.smuggled", panels: { ghost: Sidebar }, routes: { ghost: UriRoute } },
    ]);

    expect([...composition.panels.keys()]).toEqual(["core.shell.sidebar", "core.shell.pad-view"]);
    expect(composition.routes.has("ghost")).toBe(false);
    expect(composition.routes.has("uri")).toBe(false);
    expect(composition.enabled("core.smuggled")).toBe(false);
  });

  test("sections sort by declared order, and equal orders keep roster order", () => {
    const section = (id: string, order: number): ManifestFields => ({
      id: `core.${id}`,
      contributes: { sections: [{ id, title: id, order }] },
    });
    const roster: PluginRoster = [
      entry(section("late", 30)),
      entry(section("tiedA", 10)),
      entry(section("early", 1)),
      entry(section("tiedB", 10)),
    ];

    // An unstable tiebreak would reshuffle a user's sidebar on any unrelated toggle, since
    // every roster change rebuilds this list. Registration order is the deterministic answer,
    // the same one the engine's `composeRoster` gives server-side.
    expect(buildWebComposition(roster, 1, []).sections.map((row) => row.id)).toEqual([
      "early",
      "tiedA",
      "tiedB",
      "late",
    ]);
  });

  test("an unrelated toggle leaves the ELEMENT registry byte-for-byte the same", () => {
    /*
      The remount hazard, defended at its source. React Flow remounts every node when its
      node-type map changes identity, and a remount destroys live PTYs on the board — so the
      canvas caches that map on a signature of (type, enabled, component) tuples. That cache
      is only sound if hiding a sidebar section cannot perturb the element registry.
     */
    const before = buildWebComposition([entry(MACHINES), entry(DRAW)], 1, DEFS);
    const after = buildWebComposition([entry(MACHINES, false), entry(DRAW)], 2, DEFS);

    const tuples = (registry: typeof before.elements): unknown[] =>
      [...registry].map(([type, element]) => [type, element.enabled, element.Component]);
    expect(tuples(after.elements)).toEqual(tuples(before.elements));
    // Identity, not equality: the SAME component object must arrive, or the signature would
    // be stable while the map behind it changed.
    expect(after.elements.get("draw")?.Component).toBe(before.elements.get("draw")?.Component);
    // Whereas the toggle that DOES concern elements moves the tuple, so the cache rebuilds.
    const drawOff = buildWebComposition([entry(MACHINES, false), entry(DRAW, false)], 3, DEFS);
    expect(tuples(drawOff.elements)).not.toEqual(tuples(before.elements));
  });
});
