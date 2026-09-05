import { describe, expect, test } from "bun:test";
import { AssemblyError } from "@manifold/plugin";
import type { PluginManifest, PluginRoster, PluginRosterEntry } from "@manifold/protocol";
import { WEB_PLUGIN_DEFS } from "./assembly.ts";
import { buildBrowserAssembly, type WebPluginDef } from "./plugin-host.tsx";

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
const ContainerView = (): null => null;
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
      { id: "container-view", title: "Container" },
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

const URI = {
  id: "core.uri",
  title: "Links",
  contributes: { routes: [{ segment: "uri", title: "Deep links" }] },
} as const satisfies ManifestFields;

const DEFS: readonly WebPluginDef[] = [
  { id: "core.shell", panels: { sidebar: Sidebar, "container-view": ContainerView } },
  { id: "core.machines", sections: { machines: MachinesSection } },
  { id: "core.draw", elements: { draw: DrawNode } },
  { id: "core.uri", routes: { uri: UriRoute } },
];

describe("buildBrowserAssembly", () => {
  test("registrations attach to declared names, keyed the way each kind is addressed", () => {
    const assembly = buildBrowserAssembly([entry(SHELL), entry(MACHINES), entry(DRAW)], 3, DEFS);

    // Panels are keyed by FULL id, because that is the string a `panel` tile ref holds.
    expect([...assembly.panels.keys()]).toEqual([
      "core.shell.sidebar",
      "core.shell.container-view",
    ]);
    expect(assembly.panels.get("core.shell.sidebar")).toEqual({
      plugin: "core.shell",
      title: "Sidebar",
      Component: Sidebar,
      enabled: true,
    });
    // Sections are keyed globally: one sidebar, one slot per name.
    expect(assembly.sections.map((section) => section.id)).toEqual(["machines"]);
    expect(assembly.sections[0]?.Component).toBe(MachinesSection);
    // Elements are keyed by the WIRE type a scene document stores, not by a local name.
    expect(assembly.elements.get("draw")?.Component).toBe(DrawNode);
    // The MANIFEST owns the tool vocabulary outright: a tool is a NAME the ref holding
    // the toolbar switches on, so there is no registration to attach and nothing a web half
    // could use to rename what the roster declared.
    expect(assembly.tools).toEqual([
      { id: "draw", plugin: "core.draw", title: "Draw", toolbar: "canvas", enabled: true },
    ]);
    expect(assembly.revision).toBe(3);
    expect(assembly.roster).toHaveLength(3);
  });

  test("a declared name with no registration is PRESENT with a null component", () => {
    // The placeholder path (D4): the outlet needs the plugin's title to name what it is
    // waiting for, so dropping the entry would leave it with nothing to say.
    const assembly = buildBrowserAssembly([entry(SHELL), entry(DRAW)], 1, [
      { id: "core.shell", panels: { sidebar: Sidebar } },
    ]);

    expect(assembly.panels.get("core.shell.container-view")).toEqual({
      plugin: "core.shell",
      title: "Container",
      Component: null,
      enabled: true,
    });
    expect(assembly.elements.get("draw")?.Component).toBeNull();
    expect(assembly.tools[0]?.title).toBe("Draw");
    expect(assembly.pluginTitle("core.draw")).toBe("Drawing");
  });

  /**
   * THE SECOND SOURCE (ADR 0016 §1): a row that arrived through `install` with a web half
   * resolves every declared panel to the engine's isolated panel without anything in the tree
   * naming it — and the same component on every rebuild, or every roster change would remount
   * the tile and re-init the guest.
   */
  test("an installed plugin's declared panels resolve to the isolated panel, stably", () => {
    const installed = (web: boolean, install: boolean): PluginRosterEntry => {
      const row = entry({
        id: "acme.notes",
        title: "Notes",
        contributes: { panels: [{ id: "main", title: "Notes" }] },
      });
      return {
        ...row,
        source: "plugin",
        manifest: web ? { ...row.manifest, entry: { web: "web.js" } } : row.manifest,
        ...(install
          ? {
              install: {
                sha256: "a".repeat(64),
                source: "/uploads/acme.notes.manifold-plugin.json",
                grantedCaps: [],
                installedBy: "p1",
                installedAt: 1,
              },
            }
          : {}),
      };
    };
    const panelOf = (roster: PluginRoster, defs: readonly WebPluginDef[] = []) =>
      buildBrowserAssembly(roster, 1, defs).panels.get("acme.notes.main");

    const resolved = panelOf([installed(true, true)]);
    expect(resolved?.Component).not.toBeNull();
    expect(resolved?.enabled).toBe(true);
    expect(panelOf([installed(true, true)])?.Component).toBe(resolved?.Component ?? null);

    // Installed with no web half, or a web half that is not installed (first-party): no runner.
    expect(panelOf([installed(false, true)])?.Component).toBeNull();
    expect(panelOf([installed(true, false)])?.Component).toBeNull();
    // An in-tree registration for the same id still wins the slot.
    const inTree: WebPluginDef = { id: "acme.notes", panels: { main: Sidebar } };
    expect(panelOf([installed(true, true)], [inTree])?.Component).toBe(Sidebar);
  });

  test("a disabled plugin keeps every contribution, tagged enabled:false", () => {
    const assembly = buildBrowserAssembly(
      [entry(SHELL), entry(MACHINES, false), entry(DRAW, false), entry(URI, false)],
      1,
      DEFS,
    );

    // D4: a disable is not a deletion. The vocabulary stays so a stroke authored while the
    // plugin was on renders an inert ref NAMING the plugin, and enabling brings the ink
    // back with no reload — which is impossible if the entry vanished.
    expect(assembly.enabled("core.machines")).toBe(false);
    expect(assembly.enabled("core.shell")).toBe(true);
    expect(assembly.sections[0]).toEqual({
      id: "machines",
      plugin: "core.machines",
      title: "Machines",
      order: 20,
      // Resolved at the join, exactly as the server's `assembleRoster` resolves it: a manifest
      // that declares nothing gets the default, so no reader has to know what the default is.
      presentation: "disclosure",
      Component: MachinesSection,
      enabled: false,
    });
    expect(assembly.elements.get("draw")?.enabled).toBe(false);
    expect(assembly.tools[0]?.enabled).toBe(false);
    // A route's enablement is its CLAIMANT's, which is what keeps a disabled deep link
    // rendering a named placeholder instead of a dead end.
    expect(assembly.routes.get("uri")).toEqual({
      plugin: "core.uri",
      Component: UriRoute,
      enabled: false,
    });
    // And the title survives, because that is what the placeholder prints.
    expect(assembly.pluginTitle("core.draw")).toBe("Drawing");
  });

  test("the projection channels take their plugin's roster state", () => {
    // Container refs, overlays and the terminal facet are the channels with no manifest row —
    // their keys are the engine's own closed vocabularies, not names an author invents — so the
    // only thing that can gate them is the registering plugin's enablement. That is what makes
    // disabling a renderer paint the engine's named placeholder instead of a blank pane
    // (ADR 0013 §4).
    const defs: readonly WebPluginDef[] = [
      { id: "core.canvas", renderers: { canvas: ContainerView } },
      { id: "core.presence", overlays: { titlebar: UriRoute } },
      { id: "core.terminals", terminals: TERMINALS },
    ];
    const roster: PluginRoster = [
      entry({ id: "core.canvas", title: "Canvas" }),
      entry({ id: "core.presence", title: "Presence" }, false),
      entry({ id: "core.terminals", title: "Terminals" }, false),
    ];
    const assembly = buildBrowserAssembly(roster, 1, defs);

    expect(assembly.renderers.get("canvas")).toEqual({
      plugin: "core.canvas",
      title: "Canvas",
      Component: ContainerView,
      enabled: true,
    });
    // A registration for a discipline nobody registered is simply absent, and the outlet
    // reads that as "unknown" rather than guessing a renderer.
    expect(assembly.renderers.get("composition")).toBeUndefined();
    expect(assembly.overlays.get("titlebar")?.enabled).toBe(false);
    // The facet SURVIVES the disable, tagged, because the placeholder has to name the plugin
    // whose viewer is missing — and re-enabling must not need a re-registration.
    expect(assembly.terminals).toEqual({
      plugin: "core.terminals",
      title: "Terminals",
      enabled: false,
      facet: TERMINALS,
    });
  });

  test("an id the roster never published is unknown, and unknown is not enabled", () => {
    const assembly = buildBrowserAssembly([entry(SHELL)], 1, DEFS);

    // The two states a placeholder distinguishes: "disabled" (a row saying so) versus
    // "unknown" (no row at all — a layout naming a plugin this workspace does not have).
    expect(assembly.enabled("core.ghost")).toBe(false);
    expect(assembly.pluginTitle("core.ghost")).toBeNull();
  });

  test("a registration the server never published contributes NOTHING", () => {
    // The roster is the vocabulary, so a browser build cannot invent a plugin by shipping a
    // component for it — otherwise a stale bundle would show panels the server refuses to
    // dispatch for, and A2 parity (every principal sees the same workspace) would break.
    const assembly = buildBrowserAssembly([entry(SHELL), entry(URI)], 1, [
      { id: "core.shell", panels: { sidebar: Sidebar, "container-view": ContainerView } },
      { id: "core.smuggled", panels: { ghost: Sidebar }, routes: { ghost: UriRoute } },
      // A plugin the roster DOES carry, registering a path its own manifest never claimed:
      // the same smuggle one level in, and the same answer, because the declaration is the
      // vocabulary for routes exactly as it is for panels.
      { id: "core.uri", routes: { uri: UriRoute, smuggled: UriRoute } },
    ]);

    expect([...assembly.panels.keys()]).toEqual([
      "core.shell.sidebar",
      "core.shell.container-view",
    ]);
    expect(assembly.routes.has("ghost")).toBe(false);
    expect(assembly.routes.has("smuggled")).toBe(false);
    expect(assembly.routes.get("uri")?.Component).toBe(UriRoute);
    expect(assembly.enabled("core.smuggled")).toBe(false);
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
    // the same one the engine's `assembleRoster` gives server-side.
    expect(buildBrowserAssembly(roster, 1, []).sections.map((row) => row.id)).toEqual([
      "early",
      "tiedA",
      "tiedB",
      "late",
    ]);
  });

  test("an unrelated toggle leaves the ELEMENT registry byte-for-byte the same", () => {
    /*
      The remount hazard, defended at its source. React Flow remounts every node when its
      node-type map changes identity, and a remount destroys live PTYs on the canvas — so the
      canvas caches that map on a signature of (type, enabled, component) tuples. That cache
      is only sound if hiding a sidebar section cannot perturb the element registry.
     */
    const before = buildBrowserAssembly([entry(MACHINES), entry(DRAW)], 1, DEFS);
    const after = buildBrowserAssembly([entry(MACHINES, false), entry(DRAW)], 2, DEFS);

    const tuples = (registry: typeof before.elements): unknown[] =>
      [...registry].map(([type, element]) => [type, element.enabled, element.Component]);
    expect(tuples(after.elements)).toEqual(tuples(before.elements));
    // Identity, not equality: the SAME component object must arrive, or the signature would
    // be stable while the map behind it changed.
    expect(after.elements.get("draw")?.Component).toBe(before.elements.get("draw")?.Component);
    // Whereas the toggle that DOES concern elements moves the tuple, so the cache rebuilds.
    const drawOff = buildBrowserAssembly([entry(MACHINES, false), entry(DRAW, false)], 3, DEFS);
    expect(tuples(drawOff.elements)).not.toEqual(tuples(before.elements));
  });
});

/**
 * THE ROUTE VOCABULARY. Routes were a registration-time convention: the browser's table was
 * keyed off whatever a web half happened to export, so the roster could not publish the paths
 * a build answers on and nothing checked the claim (issue #112). With a manifest row a route
 * reads exactly as a panel does — the manifest CLAIMS the segment, the web half only says who
 * draws it, and neither half alone puts a path in the table.
 */
describe("buildBrowserAssembly routes", () => {
  test("a claimed segment with no registration is PRESENT with a null component", () => {
    // The third answer `PluginRoute` already gave and could not previously reach: an
    // `unavailable` placeholder naming the plugin, rather than an unclaimed-prefix 404 that
    // reads as though the workspace had never heard of the path.
    const assembly = buildBrowserAssembly([entry(URI)], 1, []);

    expect(assembly.routes.get("uri")).toEqual({
      plugin: "core.uri",
      Component: null,
      enabled: true,
    });
  });

  test("the claim is the vocabulary: a registration alone contributes no path", () => {
    const assembly = buildBrowserAssembly([entry({ id: "core.uri", title: "Links" })], 1, DEFS);

    expect(assembly.routes.size).toBe(0);
  });
});

/**
 * COLLISIONS ON THE REGISTRATION-TIME CHANNELS (issue #112). Each of these used to be settled
 * by roster order — the second claimant of a discipline, a slot, a path or the terminal facet
 * silently replaced the first, and the loser was whoever happened to be composed earlier. Two
 * plugins claiming one thing is an authoring bug (D5), so the answer is the engine's own
 * refusal naming both offenders, in the engine's own words (`reportDuplicates`).
 *
 * The wording is asserted verbatim, deliberately: "duplicate <noun> \"<name>\" claimed by: …"
 * is one sentence for one concept wherever it is raised, and a browser-local paraphrase would
 * be a second answer to "what happened" (invariant 14).
 */
describe("buildBrowserAssembly collisions", () => {
  /** The refusal's own reasons, or a failure — an assembly that composed is the bug here. */
  function refusal(build: () => unknown): readonly string[] {
    try {
      build();
    } catch (error) {
      if (error instanceof AssemblyError) return error.problems;
      throw error;
    }
    throw new Error("expected a refusal, got an assembly");
  }

  test("two manifests claiming one route segment are refused, both named", () => {
    const squatter = {
      id: "acme.links",
      contributes: { routes: [{ segment: "uri", title: "Links" }] },
    } as const satisfies ManifestFields;

    expect(refusal(() => buildBrowserAssembly([entry(URI), entry(squatter)], 1, DEFS))).toEqual([
      'duplicate route "uri" claimed by: core.uri, acme.links',
    ]);
  });

  test("two plugins drawing one container discipline are refused, both named", () => {
    const roster: PluginRoster = [
      entry({ id: "core.canvas", title: "Canvas" }),
      entry({ id: "acme.canvas", title: "Acme canvas" }),
    ];
    const defs: readonly WebPluginDef[] = [
      { id: "core.canvas", renderers: { canvas: ContainerView } },
      { id: "acme.canvas", renderers: { canvas: ContainerView } },
    ];

    expect(refusal(() => buildBrowserAssembly(roster, 1, defs))).toEqual([
      'duplicate renderer "canvas" claimed by: core.canvas, acme.canvas',
    ]);
  });

  test("two plugins painting one container overlay slot are refused, both named", () => {
    const roster: PluginRoster = [
      entry({ id: "core.presence", title: "Presence" }),
      entry({ id: "acme.presence", title: "Acme presence" }),
    ];
    const defs: readonly WebPluginDef[] = [
      { id: "core.presence", overlays: { titlebar: UriRoute } },
      { id: "acme.presence", overlays: { titlebar: UriRoute } },
    ];

    expect(refusal(() => buildBrowserAssembly(roster, 1, defs))).toEqual([
      'duplicate overlay "titlebar" claimed by: core.presence, acme.presence',
    ]);
  });

  test("two plugins painting one workspace overlay slot are refused, both named", () => {
    const roster: PluginRoster = [
      entry({ id: "core.debug", title: "Diagnostics" }),
      entry({ id: "acme.debug", title: "Acme diagnostics" }),
    ];
    const defs: readonly WebPluginDef[] = [
      { id: "core.debug", workspaceOverlays: { inspector: UriRoute } },
      { id: "acme.debug", workspaceOverlays: { inspector: UriRoute } },
    ];

    expect(refusal(() => buildBrowserAssembly(roster, 1, defs))).toEqual([
      'duplicate workspace overlay "inspector" claimed by: core.debug, acme.debug',
    ]);
  });

  test("two plugins publishing the terminal facet are refused, both named", () => {
    // The facet is ONE registration for the whole workspace, so a second publisher is the
    // same event as a second overlay — not a handover the last-composed plugin wins.
    const roster: PluginRoster = [
      entry({ id: "core.terminals", title: "Terminals" }),
      entry({ id: "acme.terminals", title: "Acme terminals" }),
    ];
    const defs: readonly WebPluginDef[] = [
      { id: "core.terminals", terminals: TERMINALS },
      { id: "acme.terminals", terminals: TERMINALS },
    ];

    expect(refusal(() => buildBrowserAssembly(roster, 1, defs))).toEqual([
      'duplicate facet "terminals" claimed by: core.terminals, acme.terminals',
    ]);
  });

  test("a DISABLED plugin's claim still collides", () => {
    // The same rule `assembleRoster` applies to sections and element types: turning a plugin
    // off may never mask a collision that turning it back on would resurrect, or a workspace
    // would compose only until somebody re-enabled the plugin that shadowed the renderer.
    const roster: PluginRoster = [
      entry({ id: "core.canvas", title: "Canvas" }),
      entry({ id: "acme.canvas", title: "Acme canvas" }, false),
    ];
    const defs: readonly WebPluginDef[] = [
      { id: "core.canvas", renderers: { canvas: ContainerView } },
      { id: "acme.canvas", renderers: { canvas: ContainerView } },
    ];

    expect(refusal(() => buildBrowserAssembly(roster, 1, defs))).toEqual([
      'duplicate renderer "canvas" claimed by: core.canvas, acme.canvas',
    ]);
  });

  test("every collision is named at once, not one per rebuild", () => {
    // A refusal that reported the first problem would make fixing a composition an
    // n-round guessing game, which is why `AssemblyError` carries every reason.
    const roster: PluginRoster = [
      entry(URI),
      entry({
        id: "acme.everything",
        contributes: { routes: [{ segment: "uri", title: "Links" }] },
      }),
    ];
    const defs: readonly WebPluginDef[] = [
      { id: "core.uri", routes: { uri: UriRoute }, overlays: { "container-spotlight": UriRoute } },
      {
        id: "acme.everything",
        routes: { uri: UriRoute },
        overlays: { "container-spotlight": UriRoute },
      },
    ];

    expect(refusal(() => buildBrowserAssembly(roster, 1, defs))).toEqual([
      'duplicate route "uri" claimed by: core.uri, acme.everything',
      'duplicate overlay "container-spotlight" claimed by: core.uri, acme.everything',
    ]);
  });
});

/**
 * THE KEY TABLE, joined: bindings are the one registry with no manifest half — the declaration
 * IS the registration — so this is where "who owns F9" gets decided for the browser, and where
 * the real rows are checked against the composition the app actually builds.
 */
describe("buildBrowserAssembly bindings", () => {
  const zoneProbe = {
    id: "core.debug.zone-probe",
    key: "F9",
    label: "Drop-zone probe",
    run: (): void => undefined,
  };
  const grid = {
    id: "core.canvas.grid",
    key: "F7",
    label: "Grid",
    when: "canvas",
    run: (): void => undefined,
  } as const;

  test("registered rows compose into the table with their owner", () => {
    const assembly = buildBrowserAssembly(
      [entry({ id: "core.debug" }), entry({ id: "core.canvas" })],
      1,
      [
        { id: "core.debug", bindings: [zoneProbe] },
        { id: "core.canvas", bindings: [grid] },
      ],
    );

    expect(assembly.bindings.map((binding) => [binding.key, binding.plugin])).toEqual([
      ["F7", "core.canvas"],
      ["F9", "core.debug"],
    ]);
    expect(assembly.bindings[1]?.run).toBe(zoneProbe.run);
  });

  test("a disabled plugin's keys DROP, unlike its panels and elements", () => {
    const assembly = buildBrowserAssembly(
      [entry(SHELL), entry({ id: "core.debug" }), entry({ id: "core.canvas" }, false)],
      1,
      [
        { id: "core.shell", panels: { sidebar: Sidebar } },
        { id: "core.debug", bindings: [zoneProbe] },
        { id: "core.canvas", bindings: [grid] },
      ],
    );

    // A panel stays, tagged, so an outlet can name what it waits for; a key has no surface to
    // paint an absence on, so the row is gone and nothing answers F7.
    expect(assembly.bindings.map((binding) => binding.id)).toEqual(["core.debug.zone-probe"]);
    expect(assembly.panels.get("core.shell.sidebar")?.enabled).toBe(true);
  });

  test("the composition the app builds carries the diagnostics' two keys, and the shell none", () => {
    const roster: PluginRoster = WEB_PLUGIN_DEFS.map((def) => entry({ id: def.id }));
    const assembly = buildBrowserAssembly(roster, 1, WEB_PLUGIN_DEFS);

    /*
      THE RELOCATION, asserted where it can actually be observed: F9 answered to `core.shell`
      until the diagnostic seat existed (issue #90), and a probe was never the shell's to own.
      Both of `core.debug`'s keys are here, once each, and the shell claims nothing.

      F10 comes FIRST because the table is sorted by key as a STRING, and "F10" sorts before
      "F9". That is the composition's own order, so it is the order asserted rather than the
      order the rows were declared in.
    */
    const rows = assembly.bindings.filter((binding) => binding.plugin === "core.debug");
    expect(rows.map((binding) => [binding.id, binding.key, binding.when])).toEqual([
      ["core.debug.inspect", "F10", "always"],
      ["core.debug.zone-probe", "F9", "always"],
    ]);
    expect(assembly.bindings.filter((binding) => binding.plugin === "core.shell")).toEqual([]);
    // Every registered plugin's rows go through one refusal-checking composition, so a second
    // plugin claiming F9 or F10 would fail this build rather than shadow the diagnostics.
    expect(assembly.bindings.filter((binding) => binding.key === "F10")).toHaveLength(1);
  });
});
