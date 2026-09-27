import { describe, expect, test } from "bun:test";
import type {
  AuthoredCap,
  Cap,
  PluginDependencyMap,
  PluginInstall,
  PluginLifecycleState,
  PluginRefusalReason,
  PluginRosterEntry,
  PluginSource,
  PluginUpdateMember,
  PluginUpdateReview,
} from "@manifold/protocol";
import {
  appliedMismatch,
  linkHost,
  needsAttention,
  permissionCount,
  pluginPermissions,
  pluginStatus,
  reviewStaleness,
  updateConsent,
  updateOwnership,
  updatePermissions,
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
    readonly releases?: string;
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
      ...(options.releases === undefined ? {} : { releases: options.releases }),
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
            sha256: SHA.old,
            source: "https://plugins.example/bundle.json",
            grantedCaps: [],
            installedBy: "alex",
            installedAt: 1,
            ...options.install,
          },
        }),
  };
}

const SHA = { old: "a".repeat(64), next: "b".repeat(64), other: "c".repeat(64) } as const;

function description(sha256: string, version: string): PluginUpdateMember["candidate"] {
  return {
    version,
    sha256,
    source: "https://plugins.example/bundle.json",
    capabilities: [],
    dependencies: {},
    entry: { web: "web.js" },
    machine: false,
    dataVersion: null,
  };
}

/** A reviewed part: installed at `SHA.old` unless `current` says otherwise, candidate `SHA.next`. */
function member(
  id: string,
  options: {
    readonly current?: string | null;
    readonly candidate?: string;
    readonly added?: readonly AuthoredCap[];
  } = {},
): PluginUpdateMember {
  const current = options.current === undefined ? SHA.old : options.current;
  return {
    id,
    title: id,
    current: current === null ? null : { ...description(current, "1.0.0"), enabled: true },
    candidate: description(options.candidate ?? SHA.next, "1.1.0"),
    enabled: true,
    hardened: false,
    storedDataVersion: null,
    capabilitiesAdded: [...(options.added ?? [])],
    capabilitiesRemoved: [],
    grantedCaps: [],
    migrationRequired: false,
    compatibility: { status: "compatible", issues: [] },
    changelog: null,
  };
}

function review(rootId: string, members: readonly PluginUpdateMember[]): PluginUpdateReview {
  return {
    digest: "d".repeat(64),
    rootId,
    createdAt: 0,
    expiresAt: 600_000,
    members: [...members],
    blockers: [],
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

  test("an assembly hold retains the server reason and needs attention rather than looking disabled", () => {
    const held = {
      ...row("acme.x", { enabled: false, refusal: "dependency_disabled" }),
      held: { reason: "held_by_dependency:acme.base", by: "acme.base" },
    };
    expect(pluginStatus([held], held).why).toBe(held.held.reason);
    expect(needsAttention([held], held)).toBe(true);
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
    const draw = row("core.canvas.draw", {
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
      "developer_mode_off",
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
  });

  test("a governed capability reads as governed, never as one the installer withheld", () => {
    // The real shape that misled an operator: nine declared, three in the grant, and the six
    // absent ones every install is designed never to carry (#733).
    const babel = row("atyrode.babel", {
      capabilities: [
        "containers:read",
        "containers:write",
        "machines:read",
        "machines:run",
        "jobs:read",
        "jobs:input",
        "jobs:cancel",
        "locations:read",
        "locations:write",
      ],
      install: { grantedCaps: ["containers:read", "containers:write", "machines:read"] },
    });
    const states = new Map(pluginPermissions(babel).map((p) => [p.cap, p.state]));
    expect([...states.values()].filter((state) => state === "withheld")).toEqual([]);
    expect(states.get("machines:read")).toBe("granted");
    expect(states.get("machines:run")).toBe("governed");
    expect(states.get("locations:write")).toBe("governed");
    // Governed authority is not exercisable on the grant alone, so the chip still counts three.
    expect(permissionCount(babel)).toBe(3);
  });

  test("wildcard ceilings expose narrowed grants and preserve previously withheld authority", () => {
    const next = member("acme.code", { added: ["*"] });
    next.current!.capabilities = ["containers:read", "tokens:mint"];
    next.candidate.capabilities = ["*"];
    next.grantedCaps = ["containers:read", "machines:mint"];
    const reviewed = new Map(
      updatePermissions(next).map((permission) => [permission.cap, permission]),
    );
    expect(reviewed.get("containers:read")?.state).toBe("granted");
    expect(reviewed.get("machines:mint")?.state).toBe("granted");
    expect(reviewed.get("tokens:mint")?.state).toBe("withheld");
    expect(reviewed.get("jobs:read")?.state).toBe("governed");
    expect(reviewed.get("*")?.state).toBe("withheld");
    expect(reviewed.get("containers:read")?.added).toBe(false);
    expect(reviewed.get("machines:mint")?.added).toBe(true);
    expect(reviewed.get("tokens:mint")?.added).toBe(false);
    const installed = row(next.id, {
      capabilities: ["*"],
      install: { grantedCaps: next.grantedCaps },
    });
    expect(pluginPermissions(installed).map(({ cap, state }) => [cap, state])).toEqual(
      [...reviewed.values()].map(({ cap, state }) => [cap, state]),
    );
  });
});

describe("links", () => {
  test("a link shows its host and keeps a malformed URL as typed", () => {
    expect(linkHost("https://github.com/atyrode/code")).toBe("github.com");
    expect(linkHost("not a url")).toBe("not a url");
  });
});

describe("updates (#238)", () => {
  test("a family part routes to its installed root's release source, and only there", () => {
    const root = row("acme.code", { install: {}, releases: "https://acme.example/releases.json" });
    const part = row("acme.code.gen", { install: {} });
    const roster = [root, part];
    const feed = { kind: "feed", root, source: "https://acme.example/releases.json" } as const;
    expect(updateOwnership(roster, root)).toEqual(feed);
    expect(updateOwnership(roster, part)).toEqual(feed);

    // A part's own source never makes it independently updatable: the root owns the family.
    const bare = row("acme.code", { install: {} });
    const sourcedPart = row("acme.code.gen", {
      install: {},
      releases: "https://x.example/r.json",
    });
    expect(updateOwnership([bare, sourcedPart], sourcedPart)).toEqual({
      kind: "unsourced",
      root: bare,
    });
  });

  test("compiled, engine and unpacked rows name their owner and are never a feed", () => {
    const unpacked = row("acme.local", {
      install: { mode: "unpacked" },
      releases: "https://x.example/r.json",
    });
    const underUnpacked = row("acme.local.part", { install: {} });
    const roster = [
      row("core.canvas", { releases: "https://x.example/r.json" }),
      row("engine.plugins", { source: "builtin" }),
      unpacked,
      underUnpacked,
    ];
    expect(roster.map((entry) => updateOwnership(roster, entry).kind)).toEqual([
      "build",
      "engine",
      "unpacked",
      "unpacked",
    ]);
  });

  test("a held review goes stale exactly when the reviewed family moves", () => {
    const installed = [row("acme.code", { install: {} }), row("acme.code.gen", { install: {} })];
    const held = review("acme.code", [
      member("acme.code"),
      member("acme.code.gen"),
      member("acme.code.new", { current: null }),
    ]);
    expect(reviewStaleness(installed, held)).toEqual([]);
    // An unpacked row under the namespace is its source tree's, never a family member.
    const dev = row("acme.code.dev", { install: { mode: "unpacked" } });
    expect(reviewStaleness([...installed, dev], held)).toEqual([]);

    const [rootRow] = installed;
    const moved = [
      [rootRow!, row("acme.code.gen", { install: { sha256: SHA.other } })],
      [rootRow!, row("acme.code.gen", { install: {}, enabled: false })],
      [rootRow!],
    ];
    for (const roster of moved) {
      expect(reviewStaleness(roster, held).join("\n")).toContain("acme.code.gen");
    }
    const added = row("acme.code.new", { install: {} });
    expect(reviewStaleness([...installed, added], held).join("\n")).toContain("acme.code.new");
    const joined = row("acme.code.extra", { install: {} });
    expect(reviewStaleness([...installed, joined], held).join("\n")).toContain("acme.code.extra");
  });

  test("a held incumbent is reviewable until its effective state actually changes", () => {
    const next = member("acme.code");
    next.current!.enabled = false;
    const approved = review("acme.code", [next]);
    const incumbent = row("acme.code", { install: {}, enabled: false });
    expect(reviewStaleness([incumbent], approved)).toEqual([]);
    expect(reviewStaleness([{ ...incumbent, enabled: true }], approved)).toEqual([
      "acme.code was switched on",
    ]);
  });

  test("consent is exactly each expanding member's additions, and only once all are acknowledged", () => {
    const held = review("acme.code", [
      member("acme.code", { added: ["acme.code:admin"] }),
      member("acme.code.gen"),
      member("acme.code.net", { added: ["network:host", "machines:run"] }),
    ]);
    expect(updateConsent(held, new Set())).toBeNull();
    expect(updateConsent(held, new Set(["acme.code", "acme.code.gen"]))).toBeNull();
    expect(updateConsent(held, new Set(["acme.code", "acme.code.gen", "acme.code.net"]))).toEqual([
      { id: "acme.code", capabilities: ["acme.code:admin"] },
      { id: "acme.code.net", capabilities: ["network:host", "machines:run"] },
    ]);
    expect(updateConsent(review("acme.code", [member("acme.code")]), new Set())).toEqual([]);
  });

  test("an apply record is accepted only as exactly the reviewed candidates", () => {
    const held = review("acme.code", [
      member("acme.code"),
      member("acme.code.same", { candidate: SHA.old }),
    ]);
    const root = { id: "acme.code", version: "1.1.0", sha256: SHA.next };
    // A part whose pin does not move may be omitted from the record.
    expect(appliedMismatch(held, { rootId: "acme.code", installed: [root] })).toBeNull();
    const wrong = [
      { rootId: "acme.other", installed: [root] },
      { rootId: "acme.code", installed: [{ ...root, sha256: SHA.other }] },
      { rootId: "acme.code", installed: [{ ...root, version: "1.2.0" }] },
      {
        rootId: "acme.code",
        installed: [root, { id: "acme.code.x", version: "1.0.0", sha256: SHA.next }],
      },
    ];
    for (const record of wrong) expect(appliedMismatch(held, record)).not.toBeNull();
    const family = review("acme.code", [member("acme.code"), member("acme.code.gen")]);
    expect(appliedMismatch(family, { rootId: "acme.code", installed: [root] })).not.toBeNull();
  });
});
