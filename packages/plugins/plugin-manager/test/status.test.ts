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
  latestVersion,
  linkHost,
  manifestLinks,
  needsAttention,
  permissionCount,
  permissionSummary,
  pluginPermissions,
  pluginStatus,
  type RosterInstall,
} from "../src/status.ts";

function row(
  id: string,
  options: {
    readonly source?: PluginSource;
    readonly enabled?: boolean;
    readonly dependencies?: PluginDependencyMap;
    readonly capabilities?: readonly Cap[];
    readonly lifecycle?: PluginLifecycleState;
    readonly refusal?: PluginRefusalReason;
    readonly install?: Partial<PluginInstall>;
    readonly essential?: boolean;
  } = {},
): PluginRosterEntry {
  return {
    manifest: {
      id,
      version: "1.0.0",
      title: id,
      description: "",
      capabilities: [...(options.capabilities ?? [])],
      contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
      ...(options.dependencies === undefined ? {} : { dependencies: options.dependencies }),
      ...(options.essential === undefined ? {} : { essential: options.essential }),
    },
    enabled: options.enabled ?? true,
    source: options.source ?? "plugin",
    actions: [],
    ...(options.lifecycle === undefined ? {} : { lifecycle: options.lifecycle }),
    ...(options.refusal === undefined ? {} : { refusal: options.refusal }),
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

describe("pluginStatus", () => {
  test("the plain on/off answer, with no reason when nothing is in the way", () => {
    expect(pluginStatus([], row("core.a"))).toEqual({ word: "On", tone: "on", why: null });
    expect(pluginStatus([], row("core.a", { enabled: false }))).toEqual({
      word: "Off",
      tone: "off",
      why: null,
    });
  });

  test("a refused bundle says so in words and names the consequence, whatever else the row says", () => {
    const tampered = row("acme.x", {
      enabled: false,
      lifecycle: "enable_failed",
      install: { refusal: "hash_mismatch" },
    });
    expect(pluginStatus([], tampered)).toEqual({
      word: "Refused",
      tone: "attention",
      why: "its bundle no longer matches its hash, so nothing from it was loaded",
    });
    expect(needsAttention([], tampered)).toBe(true);
  });

  test("the isolate states are Crashed and Starting; the hook failures are Not ready and Off", () => {
    expect(
      pluginStatus([], row("acme.x", { install: {}, lifecycle: "isolate_crashed" })),
    ).toMatchObject({
      word: "Crashed",
      tone: "attention",
    });
    expect(
      pluginStatus([], row("acme.x", { install: {}, lifecycle: "isolate_starting" })),
    ).toMatchObject({
      word: "Starting",
      tone: "busy",
    });
    expect(pluginStatus([], row("core.a", { lifecycle: "enable_failed" }))).toMatchObject({
      word: "Not ready",
      tone: "attention",
    });
    const off = pluginStatus([], row("core.a", { enabled: false, lifecycle: "disable_failed" }));
    expect(off.word).toBe("Off");
    expect(off.tone).toBe("attention");
    expect(off.why).toContain("shutdown hook failed");
  });

  test("a disabled row whose requirement is off names it, and is Off rather than red", () => {
    const canvas = row("core.canvas", { enabled: false });
    const draw = row("core.draw", {
      enabled: false,
      refusal: "dependency_disabled",
      dependencies: { "core.canvas": { type: "required" } },
    });
    expect(pluginStatus([canvas, draw], draw)).toEqual({
      word: "Off",
      tone: "off",
      why: "needs core.canvas on",
    });
    expect(needsAttention([canvas, draw], draw)).toBe(false);
    // Two requirements off read as a sentence, not a list.
    const both = row("core.both", {
      enabled: false,
      refusal: "dependency_disabled",
      dependencies: { "core.canvas": { type: "required" }, "core.space": { type: "required" } },
    });
    const space = row("core.space", { enabled: false });
    expect(pluginStatus([canvas, space, both], both).why).toBe(
      "needs core.canvas and core.space on",
    );
  });

  test("an enabled row sharing the workspace with an incompatible peer needs attention and names it", () => {
    const a = row("core.a", { refusal: "incompatible_dependency" });
    const b = row("core.b", { dependencies: { "core.a": { type: "incompatible" } } });
    expect(pluginStatus([a, b], a)).toEqual({
      word: "On",
      tone: "attention",
      why: "shares the workspace with core.b, which declares it incompatible",
    });
  });

  test("essential and engine rows are On with the reason their toggle is inert", () => {
    expect(pluginStatus([], row("core.shell", { refusal: "essential", essential: true }))).toEqual({
      word: "On",
      tone: "on",
      why: "essential: the workspace cannot be drawn without it",
    });
    expect(
      pluginStatus([], row("engine.plugins", { source: "builtin", refusal: "builtin" })).why,
    ).toBe("an engine door: the thing that would switch it off is itself");
  });

  test("no status ever prints a class name", () => {
    const classes: readonly PluginRefusalReason[] = [
      "essential",
      "builtin",
      "unknown_plugin",
      "missing_dependency",
      "incompatible_dependency",
      "dependency_disabled",
      "data_downgrade",
      "data_migration_missing",
      "element_type_owned",
      "still_enabled",
    ];
    for (const refusal of classes) {
      for (const enabled of [true, false]) {
        const status = pluginStatus([], row("core.a", { refusal, enabled }));
        expect(status.why ?? "").not.toContain("_");
        expect(status.word).not.toContain("_");
      }
    }
  });
});

describe("permissions", () => {
  test("a first-party row holds what it declares", () => {
    const canvas = row("core.canvas", { capabilities: ["scenes:write", "containers:read"] });
    expect(pluginPermissions(canvas).map((p) => [p.cap, p.granted])).toEqual([
      ["scenes:write", true],
      ["containers:read", true],
    ]);
    expect(permissionCount(canvas)).toBe(2);
    expect(permissionSummary(canvas)).toBe("Declares scenes:write, containers:read");
    expect(permissionSummary(row("core.a"))).toBe("Declares no capabilities");
  });

  test("an installed row holds its grant, and the card greys what the installer withheld", () => {
    const code = row("atyrode.code", {
      capabilities: ["containers:read", "tokens:mint"],
      install: { grantedCaps: ["containers:read"] },
    });
    expect(pluginPermissions(code).map((p) => [p.cap, p.granted])).toEqual([
      ["containers:read", true],
      ["tokens:mint", false],
    ]);
    expect(permissionCount(code)).toBe(1);
    expect(permissionSummary(code)).toBe(
      "Granted 1 of 2 declared: containers:read; withheld tokens:mint",
    );
    const nothing = row("atyrode.none", {
      capabilities: ["tokens:mint"],
      install: { grantedCaps: [] },
    });
    expect(permissionSummary(nothing)).toBe(
      "Granted 0 of 1 declared: nothing; withheld tokens:mint",
    );
  });

  test("every permission carries a meaning in words, never the bare cap", () => {
    const everything = row("acme.all", {
      capabilities: [
        "*",
        "containers:read",
        "containers:write",
        "scenes:write",
        "terminals:spawn",
        "terminals:write",
        "tokens:mint",
        "machines:mint",
        "plugins:manage",
      ],
    });
    for (const permission of pluginPermissions(everything)) {
      expect(permission.meaning.length).toBeGreaterThan(10);
      expect(permission.meaning).not.toBe(permission.cap);
    }
  });
});

describe("links and updates (#238)", () => {
  test("a manifest without links renders none, and no update chip appears without a latest", () => {
    const plain = row("acme.x", { install: {} });
    expect(manifestLinks(plain.manifest)).toEqual({});
    expect(latestVersion(plain)).toBeNull();
  });

  test("a latest equal to the installed version is not an update", () => {
    const current = row("acme.x", { install: {} });
    const same: RosterInstall = { ...current.install!, latest: "1.0.0" };
    expect(latestVersion({ ...current, install: same })).toBeNull();
    const newer: RosterInstall = { ...same, latest: "1.1.0" };
    expect(latestVersion({ ...current, install: newer })).toBe("1.1.0");
  });

  test("a link shows its host and keeps a malformed URL as typed", () => {
    expect(linkHost("https://github.com/atyrode/code")).toBe("github.com");
    expect(linkHost("not a url")).toBe("not a url");
  });
});
