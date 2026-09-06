import { describe, expect, test } from "bun:test";
import type {
  Cap,
  PluginDependencyMap,
  PluginInstall,
  PluginLifecycleState,
  PluginRefusalReason,
  PluginRosterEntry,
  PluginSource,
} from "@manifold/protocol";
import {
  PLUGIN_FILTERS,
  childrenOf,
  familySummary,
  parentOf,
  pluginCatalog,
  pluginRelations,
  publisherOf,
  type CatalogQuery,
  type PluginFilter,
  type PluginSort,
} from "../src/catalog.ts";

/**
 * A roster row, as the server publishes one. Fields a contract below never asserts on stay
 * empty rather than plausible: a test that fills a field it never asserts on invites the next
 * reader to think the field mattered.
 */
function row(
  id: string,
  title: string,
  options: {
    readonly source?: PluginSource;
    readonly enabled?: boolean;
    readonly description?: string;
    readonly dependencies?: PluginDependencyMap;
    readonly capabilities?: readonly Cap[];
    readonly lifecycle?: PluginLifecycleState;
    readonly refusal?: PluginRefusalReason;
    readonly changedAt?: number;
    readonly install?: Partial<PluginInstall>;
    readonly doors?: readonly string[];
  } = {},
): PluginRosterEntry {
  return {
    manifest: {
      id,
      version: "1.0.0",
      title,
      description: options.description ?? "",
      capabilities: [...(options.capabilities ?? [])],
      contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
      ...(options.dependencies === undefined ? {} : { dependencies: options.dependencies }),
    },
    enabled: options.enabled ?? true,
    source: options.source ?? "plugin",
    actions: (options.doors ?? []).map((name) => ({
      name: `${id}.${name}`,
      title: name,
      caps: [],
      scope: "workspace",
      input: {},
      result: {},
    })),
    ...(options.lifecycle === undefined ? {} : { lifecycle: options.lifecycle }),
    ...(options.refusal === undefined ? {} : { refusal: options.refusal }),
    ...(options.changedAt === undefined ? {} : { changedAt: options.changedAt }),
    ...(options.install === undefined
      ? {}
      : {
          install: {
            sha256: "a".repeat(64),
            source: "https://plugins.example/bundle.json",
            grantedCaps: [],
            installedBy: "alex",
            installedAt: 1,
            ...options.install,
          },
        }),
  };
}

const door = row("engine.plugins", "Plugin engine", { source: "builtin" });
const terminals = row("core.terminals", "Terminals", {
  description: "PTYs in the workspace",
  dependencies: { "core.space": { type: "required" } },
  doors: ["open", "rename"],
});
const canvas = row("core.canvas", "Canvas", {
  description: "The freeform discipline",
  dependencies: { "core.space": { type: "required" } },
  capabilities: ["scenes:write"],
});
const space = row("core.space", "Space");
const notes = row("core.notes", "Notes", { enabled: false, changedAt: 500 });
/** The canvas's nested drawing contribution. */
const draw = row("core.canvas.draw", "Draw", {
  dependencies: { "core.canvas": { type: "required" } },
});
/** A stranger's family: the baseline, and a part that requires it. */
const code = row("atyrode.code", "Code", {
  capabilities: ["containers:read", "containers:write", "tokens:mint"],
  install: { grantedCaps: ["containers:read", "containers:write"] },
  changedAt: 900,
});
const generator = row("atyrode.code.generator", "Code generator", {
  dependencies: { "atyrode.code": { type: "required" } },
  install: {},
  changedAt: 700,
});
/** Another vendor, so the Installed band has a publisher boundary to draw. */
const charts = row("acme.charts", "Charts", { install: {}, capabilities: ["containers:read"] });
const roster: readonly PluginRosterEntry[] = [
  terminals,
  notes,
  door,
  canvas,
  space,
  draw,
  generator,
  code,
  charts,
];

const ids = (entries: readonly { readonly entry: PluginRosterEntry }[]): readonly string[] =>
  entries.map(({ entry }) => entry.manifest.id);

function ask(
  overrides: { query?: string; sort?: PluginSort; filters?: readonly PluginFilter[] } = {},
): CatalogQuery {
  return {
    query: overrides.query ?? "",
    sort: overrides.sort ?? "name",
    filters: new Set(overrides.filters ?? []),
  };
}

describe("parentOf", () => {
  test("a three-segment id whose parent is composed and declared required is a child", () => {
    expect(parentOf(roster, generator)).toBe("atyrode.code");
    expect(ids(childrenOf(roster, "atyrode.code").map((entry) => ({ entry })))).toEqual([
      "atyrode.code.generator",
    ]);
  });

  test("a peer with a required dependency stays a peer: two segments claim nothing", () => {
    expect(parentOf(roster, draw)).toBeNull();
    expect(childrenOf(roster, "core.canvas")).toEqual([]);
  });

  test("a three-segment id without a registered parent stays a peer", () => {
    const orphan = row("vendor.tool.part", "Part", {
      dependencies: { "vendor.tool": { type: "required" } },
    });
    expect(parentOf([...roster, orphan], orphan)).toBeNull();
  });

  test("a three-segment id whose parent is composed but not declared required stays a peer", () => {
    // The id is the claim and the edge is the proof: a claim without the proof is a peer
    // (ADR 0023 §2), because the door would not enforce a hierarchy nobody declared.
    const claimant = row("atyrode.code.usage", "Usage");
    expect(parentOf([...roster, claimant], claimant)).toBeNull();
    const optional = row("atyrode.code.accounts", "Accounts", {
      dependencies: { "atyrode.code": { type: "optional" } },
    });
    expect(parentOf([...roster, optional], optional)).toBeNull();
  });
});

describe("familySummary", () => {
  test("names a single part, counts several", () => {
    expect(familySummary([generator])).toBe("generator on");
    expect(familySummary([{ ...generator, enabled: false }])).toBe("generator off");
    const usage = row("atyrode.code.usage", "Usage", { enabled: false });
    expect(familySummary([generator, usage])).toBe("1 of 2 parts on");
    expect(familySummary([])).toBe("");
  });
});

describe("pluginCatalog", () => {
  test("four sections, always present, in Unpacked / Installed / Built-in / Engine order", () => {
    const sections = pluginCatalog(roster, ask());
    expect(sections.map((section) => section.def.kind)).toEqual([
      "unpacked",
      "installed",
      "core",
      "engine",
    ]);
    expect(
      pluginCatalog([], ask()).map((section) => [section.def.kind, section.rows.length]),
    ).toEqual([
      ["unpacked", 0],
      ["installed", 0],
      ["core", 0],
      ["engine", 0],
    ]);
    // An unpacked row (ADR 0025 §4) lands in the first band, never among the bundles.
    const mine = row("alex.hello", "Hello", { install: { mode: "unpacked" } });
    const [unpacked, installed] = pluginCatalog([...roster, mine], ask());
    expect(ids(unpacked!.rows)).toEqual(["alex.hello"]);
    expect(ids(installed!.rows)).toEqual(["acme.charts", "atyrode.code"]);
  });

  test("a child is lifted out of the top level and nested under its parent", () => {
    const [, installed] = pluginCatalog(roster, ask());
    expect(ids(installed!.rows)).toEqual(["acme.charts", "atyrode.code"]);
    const family = installed!.rows.find((candidate) => candidate.entry === code);
    expect(family?.children.map((child) => child.manifest.id)).toEqual(["atyrode.code.generator"]);
    expect(family?.viaChild).toBe(false);
    // The count on the band still counts the child: it is a row here, only nested.
    expect(installed!.size).toBe(3);
    expect(installed!.on).toBe(3);
  });

  test("canvas is one family while peers with required edges remain independent", () => {
    const [, , core] = pluginCatalog(roster, ask());
    expect(ids(core!.rows)).toEqual(["core.canvas", "core.notes", "core.space", "core.terminals"]);
    expect(core!.rows.find((candidate) => candidate.entry === canvas)?.children).toEqual([draw]);
    expect(core!.rows.find((candidate) => candidate.entry === terminals)?.children).toEqual([]);
  });

  test("installed rows group by publisher before the sort applies", () => {
    const [, installed] = pluginCatalog(roster, ask({ sort: "changed" }));
    // By time alone `atyrode.code` (900) would lead; the publisher boundary keeps acme first.
    expect(ids(installed!.rows)).toEqual(["acme.charts", "atyrode.code"]);
    expect(publisherOf("atyrode.code.generator")).toBe("atyrode");
  });

  test("a family survives a search through a child, and is marked as opened via the child", () => {
    const [, installed] = pluginCatalog(roster, ask({ query: "generator" }));
    expect(ids(installed!.rows)).toEqual(["atyrode.code"]);
    expect(installed!.rows[0]!.viaChild).toBe(true);
    expect(installed!.rows[0]!.children.map((child) => child.manifest.id)).toEqual([
      "atyrode.code.generator",
    ]);
    // A parent that matches itself carries its whole family, unnarrowed.
    const [, byParent] = pluginCatalog(roster, ask({ query: "atyrode.code" }));
    expect(byParent!.rows[0]!.viaChild).toBe(false);
    expect(byParent!.rows[0]!.children.length).toBe(1);
  });

  test("search reads id, title, description and door names, case-insensitively", () => {
    const flat = (query: string): readonly string[] =>
      pluginCatalog(roster, ask({ query })).flatMap((section) => ids(section.rows));
    expect(flat("ENGINE.")).toEqual(["engine.plugins"]);
    expect(flat("erminal")).toEqual(["core.terminals"]);
    expect(flat("FreeForm")).toEqual(["core.canvas"]);
    // The door only: "rename" is nowhere in Terminals' id, title or description.
    expect(flat("rename")).toEqual(["core.terminals"]);
    expect(flat("no such plugin")).toEqual([]);
    expect(flat("   ")).toHaveLength(flat("").length);
  });

  test("filter chips are AND, and compose with the search", () => {
    const flat = (filters: readonly PluginFilter[], query = ""): readonly string[] =>
      pluginCatalog(roster, ask({ filters, query })).flatMap((section) => ids(section.rows));
    expect(flat(["disabled"])).toEqual(["core.notes"]);
    expect(flat(["installed"])).toEqual(["acme.charts", "atyrode.code"]);
    expect(flat(["builtin"])).toEqual([
      "core.canvas",
      "core.notes",
      "core.space",
      "core.terminals",
    ]);
    expect(flat(["installed", "disabled"])).toEqual([]);
    expect(flat(["enabled", "disabled"])).toEqual([]);
    expect(flat(["disabled"], "canvas")).toEqual([]);
    expect(flat(["attention"])).toEqual([]);
    for (const filter of PLUGIN_FILTERS) {
      expect(pluginCatalog([], ask({ filters: [filter] })).every((s) => s.rows.length === 0)).toBe(
        true,
      );
    }
  });

  test("the attention filter keeps only rows whose status needs acting on", () => {
    const crashed = row("acme.broken", "Broken", { install: {}, lifecycle: "isolate_crashed" });
    const refused = row("acme.tampered", "Tampered", {
      install: { refusal: "hash_mismatch" },
      lifecycle: "enable_failed",
      enabled: false,
    });
    const [, installed] = pluginCatalog(
      [...roster, crashed, refused],
      ask({ filters: ["attention"] }),
    );
    expect(ids(installed!.rows)).toEqual(["acme.broken", "acme.tampered"]);
  });

  test("sorts: name, status (attention first), changed (newest first, untouched last), permissions (desc)", () => {
    const crashed = row("core.crash", "Crash", { lifecycle: "isolate_crashed" });
    const many = [...roster, crashed];
    const core = (sort: PluginSort): readonly string[] =>
      ids(pluginCatalog(many, ask({ sort }))[2]!.rows);
    expect(core("name")).toEqual([
      "core.canvas",
      "core.crash",
      "core.notes",
      "core.space",
      "core.terminals",
    ]);
    expect(core("status")).toEqual([
      "core.crash",
      "core.canvas",
      "core.space",
      "core.terminals",
      "core.notes",
    ]);
    // Only Notes was ever toggled; everything else ties and falls back to name order.
    expect(core("changed")[0]).toBe("core.notes");
    expect(core("changed").slice(1)).toEqual([
      "core.canvas",
      "core.crash",
      "core.space",
      "core.terminals",
    ]);
    expect(core("permissions")[0]).toBe("core.canvas");
    // An installed row counts its GRANT, not its declaration: two of Code's three caps.
    const [, installed] = pluginCatalog(many, ask({ sort: "permissions" }));
    expect(ids(installed!.rows)).toEqual(["acme.charts", "atyrode.code"]);
  });
});

describe("pluginRelations", () => {
  test("names what a plugin requires, what requires it, and what it cannot share with", () => {
    expect(pluginRelations(roster, "core.terminals")).toEqual({
      requires: ["core.space"],
      requiredBy: [],
      incompatible: [],
    });
    // The reverse direction exists in no manifest: it is only knowable by asking every row.
    expect(pluginRelations(roster, "core.space").requiredBy).toEqual([
      "core.canvas",
      "core.terminals",
    ]);
  });

  test("only `required` is a requirement; `incompatible` is read in both directions", () => {
    expect(pluginRelations(roster, "core.canvas").requires).toEqual(["core.space"]);
    const hostile = [
      row("core.a", "A", { dependencies: { "core.b": { type: "incompatible" } } }),
      row("core.b", "B"),
    ];
    expect(pluginRelations(hostile, "core.a")).toEqual({
      requires: [],
      requiredBy: [],
      incompatible: ["core.b"],
    });
    expect(pluginRelations(hostile, "core.b").incompatible).toEqual(["core.a"]);
  });

  test("a required id no row carries is still named — that is the missing dependency", () => {
    const orphan = [row("core.a", "A", { dependencies: { "core.gone": { type: "required" } } })];
    expect(pluginRelations(orphan, "core.a").requires).toEqual(["core.gone"]);
    expect(pluginRelations(orphan, "core.gone").requiredBy).toEqual(["core.a"]);
    expect(pluginRelations([], "core.terminals")).toEqual({
      requires: [],
      requiredBy: [],
      incompatible: [],
    });
  });

  test("every direction is sorted, so the card never reorders between renders", () => {
    const many = [
      row("core.z", "Z", {
        dependencies: { "core.m": { type: "required" }, "core.a": { type: "required" } },
      }),
      row("core.y", "Y", { dependencies: { "core.m": { type: "required" } }, enabled: false }),
      row("core.b", "B", { dependencies: { "core.m": { type: "required" } } }),
      row("core.m", "M"),
    ];
    expect(pluginRelations(many, "core.z").requires).toEqual(["core.a", "core.m"]);
    expect(pluginRelations(many, "core.m").requiredBy).toEqual(["core.b", "core.y", "core.z"]);
  });
});
