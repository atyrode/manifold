import type { PluginManifest, PluginRoster, SettingDef } from "@manifold/protocol";
import { describe, expect, test } from "bun:test";
import { AssemblyError, assembleRoster, type PluginDef } from "../src/index.ts";
import {
  composeSettings,
  settingRefId,
  settingValue,
  settingWriteRefusal,
  visibleSections,
} from "../src/settings.ts";

function manifest(fields: {
  id: string;
  settings?: readonly SettingDef[];
  sections?: PluginManifest["contributes"]["sections"];
}): PluginManifest {
  return {
    id: fields.id,
    version: "1.0.0",
    title: fields.id,
    description: "",
    capabilities: [],
    contributes: {
      panels: [],
      sections: fields.sections ?? [],
      elements: [],
      tools: [],
      events: [],
      ...(fields.settings === undefined ? {} : { settings: [...fields.settings] }),
    },
  };
}

function roster(entries: readonly { manifest: PluginManifest; enabled?: boolean }[]): PluginRoster {
  return entries.map((entry) => ({
    manifest: entry.manifest,
    enabled: entry.enabled ?? true,
    source: "plugin" as const,
    actions: [],
  }));
}

const NEW_CANVAS: SettingDef = {
  id: "new-canvas",
  title: "New canvas",
  kind: "boolean",
  default: true,
};

/**
 * THE ROW RULE is the contract this whole wave rests on: a declared preference reading false
 * removes a sidebar row, and nothing else about the row's declaration may change what it does.
 */
describe("visibleSections", () => {
  const sections = [
    { id: "brand", plugin: "core.brand" },
    { id: "new-canvas", plugin: "core.canvas", setting: "new-canvas" },
    { id: "index", plugin: "core.index", setting: "index" },
  ];

  test("a setting reading false DROPS its row, and leaves every other row alone", () => {
    const settings = composeSettings(
      roster([
        { manifest: manifest({ id: "core.canvas", settings: [NEW_CANVAS] }) },
        {
          manifest: manifest({
            id: "core.index",
            settings: [{ id: "index", title: "Index", kind: "boolean", default: true }],
          }),
        },
      ]),
      { "core.canvas.new-canvas": false },
    );

    expect(visibleSections(sections, settings).map((section) => section.id)).toEqual([
      "brand",
      "index",
    ]);
  });

  test("a row with NO setting is unconditional: no value can drop it", () => {
    const settings = composeSettings(
      roster([{ manifest: manifest({ id: "core.brand", settings: [NEW_CANVAS] }) }]),
      { "core.brand.new-canvas": false },
    );

    expect(visibleSections([{ id: "brand", plugin: "core.brand" }], settings)).toHaveLength(1);
  });

  test("the declared default decides when the principal has expressed nothing", () => {
    const off: SettingDef = { ...NEW_CANVAS, default: false };
    const declared = composeSettings(
      roster([{ manifest: manifest({ id: "core.canvas", settings: [off] }) }]),
    );

    expect(visibleSections(sections, declared).map((section) => section.id)).toEqual([
      "brand",
      "index",
    ]);
  });

  test("a stored value the roster no longer declares cannot drop anything", () => {
    // The plugin left the build; its row went with it, and the stale delta must not reach
    // across and hide somebody else's row.
    const settings = composeSettings(roster([]), { "core.canvas.new-canvas": false });

    expect(visibleSections(sections, settings)).toHaveLength(3);
  });

  test("a row is gated by ITS OWN plugin's setting, never by a same-named one elsewhere", () => {
    const settings = composeSettings(
      roster([
        { manifest: manifest({ id: "core.canvas", settings: [NEW_CANVAS] }) },
        { manifest: manifest({ id: "core.notes", settings: [NEW_CANVAS] }) },
      ]),
      { "core.notes.new-canvas": false },
    );

    expect(visibleSections(sections, settings).map((section) => section.id)).toContain(
      "new-canvas",
    );
  });
});

describe("composeSettings", () => {
  test("applies the principal's delta over the declaration and keeps the declared value beside it", () => {
    const [row] = composeSettings(
      roster([{ manifest: manifest({ id: "core.canvas", settings: [NEW_CANVAS] }) }]),
      { "core.canvas.new-canvas": false },
    );

    expect(row?.declared).toBe(true);
    expect(row?.value).toBe(false);
  });

  test("a DISABLED plugin's declarations stay in the table", () => {
    // Unlike its key bindings: a preference answers nobody while the plugin is off, so nothing
    // can misfire, and the manager lists its pane exactly while somebody decides to turn it on.
    const settings = composeSettings(
      roster([
        { manifest: manifest({ id: "core.canvas", settings: [NEW_CANVAS] }), enabled: false },
      ]),
    );

    expect(settings).toHaveLength(1);
    expect(settings[0]?.value).toBe(true);
  });

  test("is sorted by ref rather than by roster order", () => {
    const settings = composeSettings(
      roster([
        { manifest: manifest({ id: "core.notes", settings: [NEW_CANVAS] }) },
        { manifest: manifest({ id: "core.canvas", settings: [NEW_CANVAS] }) },
      ]),
    );

    expect(settings.map((row) => row.ref)).toEqual([
      "core.canvas.new-canvas",
      "core.notes.new-canvas",
    ]);
  });
});

describe("settingValue", () => {
  const settings = composeSettings(
    roster([{ manifest: manifest({ id: "core.canvas", settings: [NEW_CANVAS] }) }]),
    { "core.canvas.new-canvas": false },
  );

  test("answers the effective value for a declared setting", () => {
    expect(settingValue(settings, "core.canvas", "new-canvas")).toBe(false);
  });

  test("answers null — not false — for a setting nothing declares", () => {
    expect(settingValue(settings, "core.canvas", "nope")).toBeNull();
    expect(settingValue(settings, "core.notes", "new-canvas")).toBeNull();
  });
});

/**
 * THE DOOR'S OWN RULE. `engine.plugins.setSetting` stores a value only where a declaration
 * answers it, so the refusal is the whole of the door's legality and it names both halves of
 * what it could not find.
 */
describe("settingWriteRefusal", () => {
  const composed = roster([
    { manifest: manifest({ id: "core.canvas", settings: [NEW_CANVAS] }) },
    { manifest: manifest({ id: "core.notes" }) },
  ]);

  test("permits a write to a declared setting", () => {
    expect(settingWriteRefusal(composed, "core.canvas", "new-canvas")).toBeNull();
  });

  test("refuses a setting the named plugin does not declare, naming both", () => {
    const refusal = settingWriteRefusal(composed, "core.canvas", "compact");
    expect(refusal).toContain("core.canvas");
    expect(refusal).toContain("compact");
  });

  test("refuses a plugin that declares nothing at all, naming both", () => {
    const refusal = settingWriteRefusal(composed, "core.notes", "new-canvas");
    expect(refusal).toContain("core.notes");
    expect(refusal).toContain("new-canvas");
  });

  test("refuses a plugin the roster does not carry, naming both", () => {
    const refusal = settingWriteRefusal(composed, "core.ghost", "new-canvas");
    expect(refusal).toContain("core.ghost");
    expect(refusal).toContain("new-canvas");
  });

  test("a write may not reach across plugins to another's declaration", () => {
    expect(settingWriteRefusal(composed, "core.notes", "new-canvas")).not.toBeNull();
  });
});

describe("settingRefId", () => {
  test("is the pair rule and nothing else", () => {
    expect(settingRefId("core.canvas", "new-canvas")).toBe("core.canvas.new-canvas");
  });
});

/**
 * ASSEMBLY REFUSES what the composition seam would otherwise have to guess about: a row gated
 * on a setting its own manifest never declared.
 */
describe("assembleRoster settings", () => {
  function def(fields: Parameters<typeof manifest>[0]): PluginDef {
    return { manifest: manifest(fields), actions: [] };
  }

  test("refuses enum defaults outside the closed values at manifest admission", () => {
    expect(() => assembleRoster([def({ id: "core.example", settings: [{
      id: "mode", title: "Mode", kind: "enum", values: [{ id: "one", title: "One" }],
      default: "missing",
    }] })], new Set())).toThrow("invalid_setting_enum");
  });

  test("refuses duplicate enum values at manifest admission", () => {
    expect(() => assembleRoster([def({ id: "core.example", settings: [{
      id: "mode", title: "Mode", kind: "enum",
      values: [{ id: "one", title: "One" }, { id: "one", title: "Also one" }],
      default: "one",
    }] })], new Set())).toThrow("invalid_setting_enum");
  });

  test("refuses an enum as a boolean sidebar gate", () => {
    expect(() => assembleRoster([def({
      id: "core.example",
      settings: [{ id: "mode", title: "Mode", kind: "enum",
        values: [{ id: "one", title: "One" }], default: "one" }],
      sections: [{ id: "row", title: "Row", order: 1, setting: "mode" }],
    })], new Set())).toThrow("as a boolean");
  });
  test("refuses a section gating on an undeclared setting, naming the plugin and the setting", () => {
    let thrown: unknown = null;
    try {
      assembleRoster(
        [
          def({
            id: "core.canvas",
            sections: [{ id: "new-canvas", title: "New canvas", order: 2, setting: "ghost" }],
          }),
        ],
        new Set<string>(),
      );
    } catch (reason: unknown) {
      thrown = reason;
    }

    expect(thrown).toBeInstanceOf(AssemblyError);
    const problems = (thrown as AssemblyError).problems;
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(`"core.canvas"`);
    expect(problems[0]).toContain(`"ghost"`);
    expect(problems[0]).toContain(`"new-canvas"`);
  });

  test("refuses a row gated on ANOTHER plugin's setting: a reference is local or it is nothing", () => {
    let thrown: unknown = null;
    try {
      assembleRoster(
        [
          def({ id: "core.index", settings: [NEW_CANVAS] }),
          def({
            id: "core.canvas",
            sections: [{ id: "new-canvas", title: "New canvas", order: 2, setting: "new-canvas" }],
          }),
        ],
        new Set<string>(),
      );
    } catch (reason: unknown) {
      thrown = reason;
    }

    expect(thrown).toBeInstanceOf(AssemblyError);
  });

  test("composes a legally gated row and publishes the reference on it", () => {
    const assembly = assembleRoster(
      [
        def({
          id: "core.canvas",
          settings: [NEW_CANVAS],
          sections: [{ id: "new-canvas", title: "New canvas", order: 2, setting: "new-canvas" }],
        }),
      ],
      new Set<string>(),
    );

    expect(assembly.sections[0]?.setting).toBe("new-canvas");
    expect(assembly.settings.get("core.canvas.new-canvas")?.declaration).toEqual(NEW_CANVAS);
  });

  test("an ungated row carries no reference at all", () => {
    const assembly = assembleRoster(
      [def({ id: "core.brand", sections: [{ id: "brand", title: "Manifold", order: 1 }] })],
      new Set<string>(),
    );

    expect(assembly.sections[0]).not.toHaveProperty("setting");
  });

  test("refuses one plugin declaring a setting id twice", () => {
    let thrown: unknown = null;
    try {
      assembleRoster([def({ id: "core.canvas", settings: [NEW_CANVAS, NEW_CANVAS] })], new Set());
    } catch (reason: unknown) {
      thrown = reason;
    }

    expect(thrown).toBeInstanceOf(AssemblyError);
    expect((thrown as AssemblyError).problems[0]).toContain("core.canvas.new-canvas");
  });

  test("two plugins may declare the SAME local setting id: a preference is namespaced", () => {
    const assembly = assembleRoster(
      [
        def({ id: "core.canvas", settings: [NEW_CANVAS] }),
        def({ id: "core.notes", settings: [NEW_CANVAS] }),
      ],
      new Set<string>(),
    );

    expect(assembly.settings.size).toBe(2);
  });
});
