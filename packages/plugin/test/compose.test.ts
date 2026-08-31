import { TileLayoutSchema, validateTileLayout, type PluginManifest } from "@manifold/protocol";
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  CompositionError,
  DEFAULT_WORKSPACE_LAYOUT,
  composeRoster,
  defineAction,
  type PluginDef,
} from "../src/index.ts";

const NONE = new Set<string>();

/** A manifest with every contribution list present, so a case only states what it is about. */
function manifest(fields: {
  id: string;
  capabilities?: PluginManifest["capabilities"];
  essential?: boolean;
  contributes?: Partial<PluginManifest["contributes"]>;
}): PluginManifest {
  const base: PluginManifest = {
    id: fields.id,
    version: "0.1.0",
    title: fields.id,
    description: "",
    capabilities: fields.capabilities ?? [],
    contributes: {
      panels: [],
      sections: [],
      elements: [],
      tools: [],
      events: [],
      ...fields.contributes,
    },
  };
  return fields.essential === undefined ? base : { ...base, essential: fields.essential };
}

const RENAME = defineAction({
  name: "rename",
  title: "Rename terminal",
  caps: ["pads:write"],
  input: z.strictObject({ sessionId: z.string(), name: z.string().nullable() }),
  result: z.strictObject({ ok: z.boolean() }),
});

const terminals: PluginDef = {
  manifest: manifest({
    id: "core.terminals",
    capabilities: ["pads:write"],
    contributes: { tools: [{ id: "terminal", title: "Terminal" }] },
  }),
  actions: [RENAME],
};

const shell: PluginDef = {
  manifest: manifest({
    id: "core.shell",
    essential: true,
    contributes: {
      panels: [
        { id: "sidebar", title: "Sidebar" },
        { id: "pad-view", title: "Pad" },
      ],
      sections: [{ id: "machines", title: "Machines", order: 20 }],
      elements: [{ type: "draw", title: "Drawing" }],
    },
  }),
  actions: [],
};

describe("composeRoster", () => {
  test("composes a roster whose names, registries and published schemas are the vocabulary", () => {
    const composition = composeRoster([terminals, shell], NONE);

    expect(composition.roster.map((entry) => entry.manifest.id)).toEqual([
      "core.terminals",
      "core.shell",
    ]);
    expect(composition.roster.every((entry) => entry.enabled && entry.source === "builtin")).toBe(
      true,
    );

    // An action is published under its FULL name, and only there.
    expect([...composition.actions.keys()]).toEqual(["core.terminals.rename"]);
    expect(composition.actions.get("core.terminals.rename")?.plugin.id).toBe("core.terminals");
    expect(composition.actions.get("core.terminals.rename")?.def).toBe(RENAME);
    expect(composition.actions.has("rename")).toBe(false);

    const summary = composition.roster[0]?.actions[0];
    expect(summary?.name).toBe("core.terminals.rename");
    expect(summary?.caps).toEqual(["pads:write"]);
    // The published schema is generated from the schema the door enforces.
    expect(summary?.input["type"]).toBe("object");
    expect(Object.keys((summary?.input["properties"] as Record<string, unknown>) ?? {})).toEqual([
      "sessionId",
      "name",
    ]);
    expect(summary?.result["type"]).toBe("object");

    expect([...composition.panels.keys()]).toEqual(["core.shell.sidebar", "core.shell.pad-view"]);
    expect(composition.panels.get("core.shell.sidebar")).toEqual({
      plugin: "core.shell",
      title: "Sidebar",
    });
    expect(composition.sections).toEqual([
      { id: "machines", plugin: "core.shell", title: "Machines", order: 20 },
    ]);
    expect(composition.elements.get("draw")).toEqual({ plugin: "core.shell", title: "Drawing" });
    expect(composition.tools).toEqual([
      { id: "terminal", plugin: "core.terminals", title: "Terminal" },
    ]);
    expect(composition.enabled("core.shell")).toBe(true);
    expect(composition.enabled("core.nothing")).toBe(false);
  });

  test("sections come out in declared order, whichever order their plugins registered in", () => {
    const late: PluginDef = {
      manifest: manifest({
        id: "core.views",
        contributes: { sections: [{ id: "views", title: "Views", order: 10 }] },
      }),
      actions: [],
    };
    const composition = composeRoster([shell, late], NONE);
    expect(composition.sections.map((section) => section.id)).toEqual(["views", "machines"]);
  });

  test("collisions refuse the whole composition and name every offender", () => {
    const twin: PluginDef = {
      manifest: manifest({
        id: "core.shell",
        contributes: {
          panels: [{ id: "sidebar", title: "Other sidebar" }],
          elements: [{ type: "draw", title: "Other drawing" }],
        },
      }),
      actions: [],
    };
    let thrown: unknown = null;
    try {
      composeRoster([shell, twin], NONE);
    } catch (reason) {
      thrown = reason;
    }
    expect(thrown).toBeInstanceOf(CompositionError);
    const error = thrown as CompositionError;
    // Every collision at once: a composition never reports the first and hides the rest.
    expect(error.problems).toEqual([
      'duplicate plugin id "core.shell" claimed by: core.shell, core.shell',
      'duplicate panel "core.shell.sidebar" claimed by: core.shell, core.shell',
      'duplicate element type "draw" claimed by: core.shell, core.shell',
    ]);
    expect(error.message).toContain("core.shell.sidebar");
    expect(error.message).toContain("draw");
  });

  test("two plugins claiming one action name refuse, and both are named", () => {
    const a: PluginDef = {
      manifest: manifest({ id: "core.a", capabilities: ["pads:write"] }),
      actions: [RENAME],
    };
    const b: PluginDef = {
      manifest: manifest({ id: "core.a", capabilities: ["pads:write"] }),
      actions: [RENAME],
    };
    expect(() => composeRoster([a, b], NONE)).toThrow(
      /duplicate action "core\.a\.rename" claimed by: core\.a, core\.a/,
    );
  });

  test("an action may not require authority its manifest does not declare", () => {
    const overreach: PluginDef = {
      manifest: manifest({ id: "core.rogue", capabilities: ["pads:read"] }),
      actions: [RENAME],
    };
    expect(() => composeRoster([overreach], NONE)).toThrow(
      /action "core\.rogue\.rename" requires cap "pads:write" outside its manifest capabilities \[pads:read\]/,
    );

    // A wildcard manifest is a ceiling of everything, so the same action composes.
    const wildcard: PluginDef = {
      manifest: manifest({ id: "core.admin", capabilities: ["*"] }),
      actions: [RENAME],
    };
    expect(composeRoster([wildcard], NONE).actions.has("core.admin.rename")).toBe(true);
  });

  test("an action name that is not a local name refuses", () => {
    const qualified: PluginDef = {
      manifest: manifest({ id: "core.terminals", capabilities: ["pads:write"] }),
      actions: [{ ...RENAME, name: "core.terminals.rename" }],
    };
    expect(() => composeRoster([qualified], NONE)).toThrow(/is not a local name/);
  });

  test("an invalid manifest refuses by name rather than throwing zod at the boot sequence", () => {
    const broken: PluginDef = { manifest: manifest({ id: "Core_Shell" }), actions: [] };
    let thrown: unknown = null;
    try {
      composeRoster([broken], NONE);
    } catch (reason) {
      thrown = reason;
    }
    expect(thrown).toBeInstanceOf(CompositionError);
    expect((thrown as CompositionError).problems[0]).toContain('invalid manifest "Core_Shell"');
  });

  test("a disabled plugin keeps its contributions, and loses only enablement", () => {
    const composition = composeRoster([terminals, shell], new Set(["core.terminals"]));
    const entry = composition.roster.find((row) => row.manifest.id === "core.terminals");

    expect(entry?.enabled).toBe(false);
    expect(composition.enabled("core.terminals")).toBe(false);
    expect(composition.enabled("core.shell")).toBe(true);

    // The point of keeping them: the server can say `plugin_disabled` instead of
    // `unknown_action`, and the browser can name the plugin a placeholder is waiting for.
    expect(entry?.actions).toHaveLength(1);
    expect(composition.actions.has("core.terminals.rename")).toBe(true);
    expect(composition.tools.map((tool) => tool.id)).toEqual(["terminal"]);
  });

  test("disabling never masks a collision the enablement flag would resurrect", () => {
    const twin: PluginDef = {
      manifest: manifest({
        id: "core.other",
        contributes: { elements: [{ type: "draw", title: "Other drawing" }] },
      }),
      actions: [],
    };
    expect(() => composeRoster([shell, twin], new Set(["core.other"]))).toThrow(CompositionError);
  });

  test("the essential flag reaches the roster, where a client must render a lock", () => {
    const composition = composeRoster([shell, terminals], NONE);
    expect(composition.roster[0]?.manifest.essential).toBe(true);
    expect(composition.roster[1]?.manifest.essential).toBeUndefined();
  });

  test("an unpublishable action schema is an authoring refusal, not a boot crash", () => {
    const unpublishable: PluginDef = {
      manifest: manifest({ id: "core.void" }),
      actions: [
        defineAction({
          name: "ping",
          title: "Ping",
          caps: [],
          input: z.strictObject({}),
          result: z.void(),
        }),
      ],
    };
    expect(() => composeRoster([unpublishable], NONE)).toThrow(
      /action "core\.void\.ping" result cannot be published as JSON Schema/,
    );
  });
});

describe("DEFAULT_WORKSPACE_LAYOUT", () => {
  test("is a valid tile layout whose leaves are the shell's two panels", () => {
    const parsed = TileLayoutSchema.parse(DEFAULT_WORKSPACE_LAYOUT);
    expect(validateTileLayout(parsed)).toBe(true);

    // Every leaf surface, so a non-panel leaf sneaking into the default would show up here.
    const panelIds = Object.values(parsed).flatMap((node) =>
      node.surface === null ? [] : [node.surface.kind === "panel" ? node.surface.panelId : "?"],
    );
    expect(panelIds).toEqual(["core.shell.sidebar", "core.shell.pad-view"]);
  });

  test("every panel it names is one the shell composes", () => {
    const composition = composeRoster([shell], NONE);
    for (const node of Object.values(DEFAULT_WORKSPACE_LAYOUT)) {
      if (node.surface === null || node.surface.kind !== "panel") continue;
      expect(composition.panels.has(node.surface.panelId)).toBe(true);
    }
  });
});
