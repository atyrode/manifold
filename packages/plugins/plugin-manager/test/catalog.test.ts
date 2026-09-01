import { describe, expect, test } from "bun:test";
import type {
  PluginDependencyMap,
  PluginRosterEntry,
  PluginSource,
} from "@manifold/protocol";
import {
  pluginCatalog,
  pluginDependencies,
  PLUGIN_FILTERS,
  type PluginFilter,
} from "../src/catalog.ts";

/**
 * A roster row, as the server publishes one. `actions` and the optional attribution fields
 * are irrelevant to every contract below, so the fixture keeps them empty rather than
 * plausible: a test that fills a field it never asserts on invites the next reader to think
 * the field mattered.
 */
function row(
  id: string,
  title: string,
  options: {
    readonly source?: PluginSource;
    readonly enabled?: boolean;
    readonly description?: string;
    readonly dependencies?: PluginDependencyMap;
  } = {},
): PluginRosterEntry {
  return {
    manifest: {
      id,
      version: "1.0.0",
      title,
      description: options.description ?? "",
      capabilities: [],
      contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
      ...(options.dependencies === undefined ? {} : { dependencies: options.dependencies }),
    },
    enabled: options.enabled ?? true,
    source: options.source ?? "plugin",
    actions: [],
  };
}

const door = row("engine.plugins", "Plugin engine", { source: "builtin" });
const terminals = row("core.terminals", "Terminals", {
  description: "PTYs in the workspace",
  dependencies: { "core.space": { type: "required" } },
});
const canvas = row("core.canvas", "Canvas", {
  description: "The freeform discipline",
  dependencies: { "core.space": { type: "required" }, "core.draw": { type: "optional" } },
});
const space = row("core.space", "Space");
const notes = row("core.notes", "Notes", { enabled: false });
/** A stranger's plugin: neither an engine door nor a `core.` seat, which is the third kind. */
const guest = row("acme.charts", "Charts");
const roster: readonly PluginRosterEntry[] = [terminals, notes, door, canvas, space, guest];

const ids = (entries: readonly PluginRosterEntry[]): readonly string[] =>
  entries.map((entry) => entry.manifest.id);

describe("plugin catalog", () => {
  test("groups by kind — engine doors, then core seats, then installed — rows alphabetical by title", () => {
    const categories = pluginCatalog(roster, "", "all");
    expect(categories.map((category) => [category.kind, category.title])).toEqual([
      ["engine", "Engine doors"],
      ["core", "Core seats"],
      ["installed", "Installed plugins"],
    ]);
    expect(ids(categories[0]!.rows)).toEqual(["engine.plugins"]);
    // Canvas, Notes, Space, Terminals — by TITLE, which is not the roster's order or the ids'.
    expect(ids(categories[1]!.rows)).toEqual([
      "core.canvas",
      "core.notes",
      "core.space",
      "core.terminals",
    ]);
    // The shipped seats and a stranger's plugin do NOT share a heading, which is the whole
    // point of the kind axis: `source` alone puts both under "assembled by the composition".
    expect(ids(categories[2]!.rows)).toEqual(["acme.charts"]);
  });

  test("a category with no surviving row is dropped rather than drawn empty", () => {
    // Only `core.notes` is off, so asking for the disabled rows must leave exactly one
    // category behind — not empty "Engine doors" and "Installed plugins" headings.
    const categories = pluginCatalog(roster, "", "disabled");
    expect(categories.map((category) => category.kind)).toEqual(["core"]);
    expect(ids(categories[0]!.rows)).toEqual(["core.notes"]);
  });

  test("an empty roster is empty structure, under every filter", () => {
    for (const filter of PLUGIN_FILTERS) {
      expect(pluginCatalog([], "", filter)).toEqual([]);
      expect(pluginCatalog([], "canvas", filter)).toEqual([]);
    }
  });

  test("the empty query matches everything, and whitespace is not a query", () => {
    const all = ids(pluginCatalog(roster, "", "all").flatMap((category) => [...category.rows]));
    expect(all).toHaveLength(roster.length);
    expect(ids(pluginCatalog(roster, "   ", "all").flatMap((c) => [...c.rows]))).toEqual(all);
  });

  test("search reads id, title and description, case-insensitively", () => {
    // The id only: "engine." appears in no title or description.
    expect(ids(pluginCatalog(roster, "ENGINE.", "all").flatMap((c) => [...c.rows]))).toEqual([
      "engine.plugins",
    ]);
    // The title only, mid-word, so this is substring rather than prefix matching.
    expect(ids(pluginCatalog(roster, "erminal", "all").flatMap((c) => [...c.rows]))).toEqual([
      "core.terminals",
    ]);
    // The description only: "freeform" is nowhere in Canvas's id or title.
    expect(ids(pluginCatalog(roster, "FreeForm", "all").flatMap((c) => [...c.rows]))).toEqual([
      "core.canvas",
    ]);
    expect(pluginCatalog(roster, "no such plugin", "all")).toEqual([]);
  });

  test("the three filters partition the roster, and compose with the search", () => {
    const under = (filter: PluginFilter, query = ""): readonly string[] =>
      ids(pluginCatalog(roster, query, filter).flatMap((category) => [...category.rows]));
    expect(under("enabled")).toEqual([
      "engine.plugins",
      "core.canvas",
      "core.space",
      "core.terminals",
      "acme.charts",
    ]);
    expect(under("disabled")).toEqual(["core.notes"]);
    expect(under("all")).toHaveLength(under("enabled").length + under("disabled").length);
    // A row that matches the word but not the state is gone: the two narrowings are AND.
    expect(under("enabled", "notes")).toEqual([]);
    expect(under("disabled", "notes")).toEqual(["core.notes"]);
  });
});

describe("plugin dependencies", () => {
  test("names what a plugin needs and what needs it", () => {
    expect(pluginDependencies(roster, "core.terminals")).toEqual({
      needs: ["core.space"],
      neededBy: [],
    });
    // The reverse direction exists in no manifest: it is only knowable by asking every row.
    expect(pluginDependencies(roster, "core.space")).toEqual({
      needs: [],
      neededBy: ["core.canvas", "core.terminals"],
    });
  });

  test("only `required` is a need: optional and incompatible are not", () => {
    // Canvas declares core.space required and core.draw optional; only the first is a need.
    expect(pluginDependencies(roster, "core.canvas").needs).toEqual(["core.space"]);
    expect(pluginDependencies(roster, "core.draw").neededBy).toEqual([]);
    const hostile = [
      row("core.a", "A", { dependencies: { "core.b": { type: "incompatible" } } }),
      row("core.b", "B"),
    ];
    expect(pluginDependencies(hostile, "core.a")).toEqual({ needs: [], neededBy: [] });
    expect(pluginDependencies(hostile, "core.b")).toEqual({ needs: [], neededBy: [] });
  });

  test("a required id no row carries is still named — that is the missing dependency", () => {
    const orphan = [row("core.a", "A", { dependencies: { "core.gone": { type: "required" } } })];
    expect(pluginDependencies(orphan, "core.a").needs).toEqual(["core.gone"]);
    // And the absent plugin's own answer is total, not a throw.
    expect(pluginDependencies(orphan, "core.gone")).toEqual({
      needs: [],
      neededBy: ["core.a"],
    });
  });

  test("an id the roster never heard of, and an empty roster, both answer emptily", () => {
    expect(pluginDependencies(roster, "core.nobody")).toEqual({ needs: [], neededBy: [] });
    expect(pluginDependencies([], "core.terminals")).toEqual({ needs: [], neededBy: [] });
  });

  test("both directions are sorted, so the block never reorders between renders", () => {
    const many = [
      row("core.z", "Z", {
        dependencies: { "core.m": { type: "required" }, "core.a": { type: "required" } },
      }),
      row("core.y", "Y", { dependencies: { "core.m": { type: "required" } }, enabled: false }),
      row("core.b", "B", { dependencies: { "core.m": { type: "required" } } }),
      row("core.m", "M"),
    ];
    expect(pluginDependencies(many, "core.z").needs).toEqual(["core.a", "core.m"]);
    expect(pluginDependencies(many, "core.m").neededBy).toEqual(["core.b", "core.y", "core.z"]);
  });
});
