import { describe, expect, test } from "bun:test";
import {
  ACTION_DENIAL_RULES,
  ActionOutcomeSchema,
  ActionSummarySchema,
  CONNECTION_BODIES,
  CONNECTION_LEVEL_MESSAGE_TYPES,
  CORE_NAMESPACE_PREFIX,
  DEFAULT_DORMANT_MODE,
  DEFAULT_ELEMENT_PLACEMENT_TRAITS,
  DEFAULT_SEAT_RATIO,
  ENGINE_NAMESPACE_PREFIX,
  PLUGIN_DEPENDENCY_TYPES,
  PLUGIN_DORMANT_MODES,
  PLUGIN_ID_PATTERN,
  PLUGIN_LIFECYCLE_STATES,
  PLUGIN_PURGE_TARGETS,
  PLUGIN_REFUSAL_REASONS,
  PLUGIN_RESIDUAL_MECHANISMS,
  PLUGIN_SOURCES,
  PanelDefSchema,
  PluginManifestSchema,
  PluginPurgeResultSchema,
  PluginRosterEntrySchema,
  PluginRosterSchema,
  SERVER_MESSAGE_TYPES,
  ServerMessageSchema,
  TileRefSchema,
  buildProtocolJsonSchema,
  pluginVocabulary,
  type PluginManifest,
  type PluginRosterEntry,
} from "@manifold/protocol";

/**
 * THE PLUGIN VOCABULARY ON THE WIRE.
 *
 * A manifest is inert DATA (D1): it declares a plugin's identity, its authority ceiling and
 * what it contributes, and nothing about it may be executable or open-ended. A roster is
 * SHARED STATE (D3), served over HTTP and pushed on a connection-level frame, so both its
 * shape and its delivery envelope are contracts a stranger's agent reads (A3). These tests
 * pin what the schemas accept and — more importantly — what they refuse, because every
 * refusal here is a class of plugin the engine can never be handed.
 */

/** A manifest with every list present, so a case states only what it is about. */
function manifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: "core.terminals",
    version: "0.1.0",
    title: "Terminals",
    description: "",
    capabilities: ["containers:write"],
    contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
    ...overrides,
  };
}

describe("plugin manifest", () => {
  test("a plugin id stops at one independently enabled part", () => {
    expect(PluginManifestSchema.safeParse(manifest({ id: "acme.product.part" })).success).toBe(
      true,
    );
    expect(
      PluginManifestSchema.safeParse(manifest({ id: "acme.product.part.detail" })).success,
    ).toBe(false);
  });

  test("the contribution lists default to empty, so a manifest declares only what it adds", () => {
    const parsed = PluginManifestSchema.parse({
      id: "core.space",
      version: "0.1.0",
      title: "Workspace layout",
      description: "One action door over the workspace tree.",
      capabilities: [],
      contributes: {},
    });

    // A plugin contributing nothing but actions (core.space is exactly that) must not have
    // to write five empty arrays to be composable.
    expect(parsed.contributes).toEqual({
      panels: [],
      sections: [],
      elements: [],
      tools: [],
      events: [],
    });
    expect(parsed.essential).toBeUndefined();
    expect(parsed.entry).toBeUndefined();
  });

  test("`entry` and `contributes.events` parse on an ordinary manifest", () => {
    // `entry` is the isolation seam (ADR 0016 §8 stage 2: which halves an installed bundle
    // runs) and `contributes.events` the event plane's (ADR 0012). Both were declared before
    // they were consumed, so a manifest written then validates unchanged now; `entry` is
    // optional here and REQUIRED by the bundle schema, which is where its halves are checked
    // against the files that carry them.
    const reserved = PluginManifestSchema.parse(
      manifest({
        id: "core.presence",
        capabilities: ["scenes:write"],
        contributes: {
          panels: [],
          sections: [],
          elements: [],
          tools: [],
          events: [{ id: "spotlighted", title: "Spotlight moved" }],
        },
        entry: { web: "web.js", server: true },
      }),
    );

    expect(reserved.contributes.events).toEqual([{ id: "spotlighted", title: "Spotlight moved" }]);
    expect(reserved.entry).toEqual({ web: "web.js", server: true });
  });

  test("a plugin id must be dotted and lowercase, because the id is half of every name", () => {
    // Every published name is `${pluginId}.${localName}`: an id that is not a namespace
    // would make `core.terminals.rename` ambiguous about where the plugin ends.
    for (const id of [
      "Core.Terminals", // uppercase
      "core", // single segment: no namespace at all
      "core.", // empty trailing segment
      ".terminals", // empty leading segment
      "core..terminals",
      "core.Terminals",
      "core_terminals",
      "1core.terminals",
      "core.terminals ",
      "",
      `core.${"x".repeat(64)}`, // over the 64-char bound
    ]) {
      expect(PluginManifestSchema.safeParse(manifest({ id })).success).toBe(false);
    }
    expect(PluginManifestSchema.safeParse(manifest({ id: "vendor.some-plugin.sub" })).success).toBe(
      true,
    );
  });

  test("a contribution id must be a LOCAL name: a dot there would forge a namespace", () => {
    const dotted = manifest({
      contributes: {
        panels: [{ id: "core.shell.sidebar", title: "Sidebar" }],
        sections: [],
        elements: [],
        tools: [],
        events: [],
      },
    });

    // `core.terminals` declaring a panel called `core.shell.sidebar` would compose to
    // `core.terminals.core.shell.sidebar` — or, if anyone ever trimmed, to a panel it does
    // not own. Refusing the dot at the schema is what makes the full id unforgeable (D5).
    expect(PluginManifestSchema.safeParse(dotted).success).toBe(false);
  });

  test("the authority ceiling names real capabilities, and is bounded", () => {
    // A manifest is auditable precisely because `capabilities` is the ceiling every action
    // is checked against (D1). A cap the system does not define could never be intersected
    // with a caller's, so it is refused rather than carried as decoration.
    expect(
      PluginManifestSchema.safeParse(
        manifest({ capabilities: ["containers:write", "plugins:invent"] as never }),
      ).success,
    ).toBe(false);
    expect(
      PluginManifestSchema.safeParse(
        manifest({ capabilities: Array.from({ length: 17 }, () => "containers:read" as const) }),
      ).success,
    ).toBe(false);
  });

  test("every contribution list is bounded, so one manifest cannot flood a registry", () => {
    const nine = Array.from({ length: 9 }, (_v, index) => ({
      id: `panel-${index}`,
      title: `Panel ${index}`,
    }));
    expect(
      PluginManifestSchema.safeParse(
        manifest({
          contributes: { panels: nine, sections: [], elements: [], tools: [], events: [] },
        }),
      ).success,
    ).toBe(false);
  });

  test("an unknown manifest field is REFUSED: a manifest is inert data, not a program", () => {
    // The trust model (D1) rests on manifests carrying no executable and no unreviewed
    // fields: contracts stay sandbox-shaped so an isolated runner can be dropped behind the
    // same manifest later. A silently-ignored extra key would be a place to smuggle one.
    for (const extra of [
      { onLoad: "console.log(1)" },
      { permissions: ["*"] },
      { capabilities2: [] },
    ]) {
      expect(PluginManifestSchema.safeParse({ ...manifest(), ...extra }).success).toBe(false);
    }
    // Nested strictness too: a contribution row is as inert as the manifest holding it.
    expect(
      PluginManifestSchema.safeParse(
        manifest({
          contributes: {
            panels: [{ id: "sidebar", title: "Sidebar", render: "x" }] as never,
            sections: [],
            elements: [],
            tools: [],
            events: [],
          },
        }),
      ).success,
    ).toBe(false);
  });
});

describe("published action summary", () => {
  const summary = {
    name: "core.terminals.rename",
    title: "Rename terminal",
    caps: ["containers:write"] as const,
    input: { type: "object" },
    result: { type: "object" },
  };

  test("the cleanup flag is optional, and absence means the action dies with a disable", () => {
    // D12: creation and administration die on disable, removal survives. The flag is
    // PUBLISHED so a client can tell which affordances outlive a toggle without asking —
    // and its absence has to be the ordinary case, or every action would claim survival.
    const plain = ActionSummarySchema.parse(summary);
    expect(plain.cleanup).toBeUndefined();

    const cleanup = ActionSummarySchema.parse({
      ...summary,
      name: "core.terminals.kill",
      cleanup: true,
    });
    expect(cleanup.cleanup).toBe(true);
  });

  test("a summary carries nothing beyond the vocabulary it publishes", () => {
    expect(ActionSummarySchema.safeParse({ ...summary, handler: "rename" }).success).toBe(false);
    expect(ActionSummarySchema.safeParse({ ...summary, caps: ["containers:invent"] }).success).toBe(
      false,
    );
    // The schemas are JSON Schema documents, not zod shapes: a reader is an agent, not this
    // process, so a non-object there would be unreadable at the far end.
    expect(ActionSummarySchema.safeParse({ ...summary, input: "object" }).success).toBe(false);
  });
});

describe("action outcome", () => {
  test("a denial is a successful ANSWER carrying a named rung", () => {
    // The door answers 200 with `ok: false`, exactly as `POST /api/place` answers a refused
    // placement: a refusal is a fact about authority or state, never a transport failure.
    for (const rule of ACTION_DENIAL_RULES) {
      const parsed = ActionOutcomeSchema.parse({ ok: false, denial: { rule, message: "why" } });
      expect(parsed.ok).toBe(false);
    }
    expect(
      ActionOutcomeSchema.safeParse({ ok: false, denial: { rule: "nope", message: "why" } })
        .success,
    ).toBe(false);
    // A message is mandatory: an unexplained refusal is one a caller cannot act on.
    expect(ActionOutcomeSchema.safeParse({ ok: false, denial: { rule: "refused" } }).success).toBe(
      false,
    );
  });

  test("the two outcomes never blend, so a caller cannot read one as the other", () => {
    expect(ActionOutcomeSchema.parse({ ok: true, result: { renamed: true } })).toEqual({
      ok: true,
      result: { renamed: true },
    });
    // `result` is `unknown`, which includes null — an action whose answer is "done".
    expect(ActionOutcomeSchema.safeParse({ ok: true, result: null }).success).toBe(true);
    expect(
      ActionOutcomeSchema.safeParse({
        ok: true,
        result: {},
        denial: { rule: "refused", message: "why" },
      }).success,
    ).toBe(false);
    expect(ActionOutcomeSchema.safeParse({ ok: false, result: {} }).success).toBe(false);
  });

  test("the denial vocabulary is the whole ladder, published in the order it is walked", () => {
    // Agents read this list from `/api/protocol` to know what a door can answer. A new rung
    // is a deliberate protocol change, not an incidental addition, so the list is pinned.
    // `unavailable` is last: the isolate holding the handler did not answer (ADR 0016 §6),
    // which is only knowable after every other rung has passed.
    expect([...ACTION_DENIAL_RULES]).toEqual([
      "unknown_action",
      "plugin_disabled",
      "forbidden",
      "invalid_args",
      "refused",
      "unavailable",
    ]);
  });
});

describe("the plugin roster", () => {
  const entry: PluginRosterEntry = {
    manifest: manifest(),
    enabled: false,
    source: "plugin",
    actions: [
      {
        name: "core.terminals.kill",
        title: "Kill terminal",
        caps: ["containers:write"],
        cleanup: true,
        // A cleanup door confined to one container: `scope` is required on the OUTPUT type
        // because the schema defaults it, so a summary always states its authority grade.
        scope: "container",
        input: { type: "object" },
        result: { type: "object" },
      },
    ],
  };

  test("a disabled plugin is a roster row with enabled:false, never an absent one", () => {
    // D4: a client must be able to NAME the plugin a placeholder is waiting for, and the
    // server must be able to answer `plugin_disabled` instead of `unknown_action`. Both
    // require the row to survive the disable.
    const roster = PluginRosterSchema.parse([entry]);
    expect(roster[0]?.enabled).toBe(false);
    expect(roster[0]?.actions[0]?.cleanup).toBe(true);
    expect(PluginRosterSchema.parse([])).toEqual([]);
  });

  test("`source` tells an ENGINE door from a plugin, and admits nothing else", () => {
    // The mechanism that turns plugins on cannot be a plugin that can be turned off, so
    // enablement is published as a builtin row: same manifest, same action schemas, same
    // ladder, no toggle. Every core plugin is `plugin` — which is what makes "core is not
    // privileged" checkable rather than merely claimed — and a distributed plugin will be
    // `plugin` too, so the marketplace wave needs no new roster shape (D8).
    expect([...PLUGIN_SOURCES]).toEqual(["builtin", "plugin"]);
    for (const source of PLUGIN_SOURCES) {
      expect(PluginRosterEntrySchema.safeParse({ ...entry, source }).success).toBe(true);
    }
    expect(PluginRosterEntrySchema.safeParse({ ...entry, source: "remote" }).success).toBe(false);
    // `enabled` is not optional: "unknown enablement" is not a state a client can render.
    expect(
      PluginRosterEntrySchema.safeParse({
        manifest: entry.manifest,
        source: entry.source,
        actions: entry.actions,
      }).success,
    ).toBe(false);
  });

  test("a failed teardown is a STATE on the row, never a wedged workspace", () => {
    // Hot-toggling trusted in-process code means teardown can throw or hang, and this is a
    // SHARED workspace: the disable always completes and the roster says what happened, to
    // everyone at once. Absence is the ordinary case, so a row says "ok" by saying nothing.
    // The two `isolate_` states are the runner's (ADR 0016 §6): a crashed isolate is a
    // degraded row every principal sees, not a log line somebody greps.
    expect([...PLUGIN_LIFECYCLE_STATES]).toEqual([
      "ok",
      "enable_failed",
      "disable_failed",
      "isolate_starting",
      "isolate_crashed",
    ]);
    expect(PluginRosterEntrySchema.parse(entry).lifecycle).toBeUndefined();
    for (const lifecycle of PLUGIN_LIFECYCLE_STATES) {
      expect(PluginRosterEntrySchema.safeParse({ ...entry, lifecycle }).success).toBe(true);
    }
    expect(PluginRosterEntrySchema.safeParse({ ...entry, lifecycle: "wedged" }).success).toBe(
      false,
    );
  });

  test("a refusal is a named CLASS, so a client renders a lock instead of parsing prose", () => {
    expect([...PLUGIN_REFUSAL_REASONS]).toEqual([
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
      "stylesheet_unscoped",
    ]);
    for (const refusal of PLUGIN_REFUSAL_REASONS) {
      expect(PluginRosterEntrySchema.safeParse({ ...entry, refusal }).success).toBe(true);
    }
    expect(PluginRosterEntrySchema.safeParse({ ...entry, refusal: "because" }).success).toBe(false);
    expect(PluginRosterEntrySchema.parse(entry).refusal).toBeUndefined();
  });

  test("a toggle is ATTRIBUTED, because it changes what other people are looking at", () => {
    // Enablement is workspace-global and hot: one principal's click empties another's
    // canvas. Attribution rides the row already being broadcast — no event plane needed —
    // so a placeholder can say who, and when, rather than reading as a glitch.
    const attributed = PluginRosterEntrySchema.parse({
      ...entry,
      changedBy: "principal-1",
      changedAt: 1_700_000_000_000,
    });
    expect(attributed.changedBy).toBe("principal-1");
    expect(attributed.changedAt).toBe(1_700_000_000_000);
    // Never toggled: absent from a composed row, null from a store row that has no value.
    expect(PluginRosterEntrySchema.parse(entry).changedBy).toBeUndefined();
    expect(
      PluginRosterEntrySchema.safeParse({ ...entry, changedBy: null, changedAt: null }).success,
    ).toBe(true);
    for (const changedAt of [-1, 1.5]) {
      expect(PluginRosterEntrySchema.safeParse({ ...entry, changedAt }).success).toBe(false);
    }
    expect(PluginRosterEntrySchema.safeParse({ ...entry, changedBy: "" }).success).toBe(false);
  });
});

describe("the connection-level plugins frame", () => {
  const roster = PluginRosterSchema.parse([
    { manifest: manifest(), enabled: true, source: "plugin", actions: [] },
  ]);

  test("a roster frame addresses the SOCKET: it parses with no channel at all", () => {
    // D3: registration is shared state and workspace-global. Until v14 every server frame
    // was channelized; tagging the roster with one room's channel would be an id pun, and
    // fanning it per channel would send one fact N times.
    const parsed = ServerMessageSchema.parse({ type: "plugins", roster });
    expect(parsed.type).toBe("plugins");
    expect(parsed).not.toHaveProperty("ch");
    expect(CONNECTION_BODIES.plugins.safeParse({ type: "plugins", roster }).success).toBe(true);
  });

  test("a roster frame with a channel is REFUSED, so it cannot be smuggled as room traffic", () => {
    expect(ServerMessageSchema.safeParse({ type: "plugins", roster, ch: "c1" }).success).toBe(
      false,
    );
  });

  test("a room frame still REQUIRES its channel, which is what makes `plugins` the exception", () => {
    // The contrast is the point: routing tells the two categories apart by the presence of
    // `ch`, and a client's channel handle is never handed a connection frame.
    const errorBody = { type: "error", code: "forbidden", message: "no" };
    expect(ServerMessageSchema.safeParse(errorBody).success).toBe(false);
    expect(ServerMessageSchema.safeParse({ ...errorBody, ch: "c1" }).success).toBe(true);
  });

  test("the inventories classify the frame, in both directions", () => {
    // A pool that demuxes by `ch` needs the classification as DATA, not as a hand-kept list
    // beside the schemas: an unclassified connection frame would be dropped as unknown-ch.
    expect(CONNECTION_LEVEL_MESSAGE_TYPES).toContain("plugins");
    for (const type of Object.keys(CONNECTION_BODIES)) {
      expect(CONNECTION_LEVEL_MESSAGE_TYPES as readonly string[]).toContain(type);
      // It is still a server frame: an inventory that forgot it would make it "unknown".
      expect(SERVER_MESSAGE_TYPES as readonly string[]).toContain(type);
    }
    // The liveness pair are connection-level too, and neither has a body to parse; the event
    // plane's three join them, because a topic is a NODE and a node is not a room.
    expect([...CONNECTION_LEVEL_MESSAGE_TYPES]).toEqual([
      "ping",
      "pong",
      "plugins",
      "subscribe",
      "unsubscribe",
      "event",
    ]);
  });
});

describe("the panel tile ref", () => {
  test("a panel is a leaf ref like any other, so the workspace is one tree vocabulary", () => {
    // D2: the shell is a composition, not a second node system. The workspace layout is a
    // TileLayout whose leaves are plugin panels, rendered by the SAME TileTree component
    // every container uses.
    const parsed = TileRefSchema.parse({ kind: "panel", panelId: "core.shell.sidebar" });
    expect(parsed).toEqual({ kind: "panel", panelId: "core.shell.sidebar" });
  });

  test("a panel ref names exactly one panel, with nothing else attached", () => {
    expect(TileRefSchema.safeParse({ kind: "panel", panelId: "" }).success).toBe(false);
    expect(TileRefSchema.safeParse({ kind: "panel" }).success).toBe(false);
    // No props, no config, no component: a ref is an ADDRESS the outlet resolves
    // against the live composition, which is what lets a disable render a placeholder.
    expect(
      TileRefSchema.safeParse({
        kind: "panel",
        panelId: "core.shell.sidebar",
        props: { collapsed: true },
      }).success,
    ).toBe(false);
  });
});

/**
 * ARRANGING IS SCOPED, AND THE SCOPES ARE PUBLISHED BY THE PLUGINS THAT HOLD THEM.
 *
 * The workspace's arrange mode makes panels grabbable inside the tree. A panel that stacks
 * parts of its own can offer a second arrangement to step into — and the engine may not know
 * which panels those are, because knowing would mean the floor holding a list of favourite
 * plugins. So the panel DECLARES it, here, in the same inert manifest that declares the panel.
 */
describe("a panel that arranges something inside itself", () => {
  test("the declaration is the panel's own word for what is in there", () => {
    const parsed = PluginManifestSchema.parse(
      manifest({
        contributes: {
          panels: [{ id: "sidebar", title: "Sidebar", arranges: { title: "Sidebar rows" } }],
          sections: [],
          elements: [],
          tools: [],
          events: [],
        },
      }),
    );
    expect(parsed.contributes.panels[0]?.arranges).toEqual({ title: "Sidebar rows" });
  });

  test("ABSENT means the panel arranges nothing, which is every panel written before it", () => {
    // Additive-optional, and the whole point of the field: a v18 manifest parses unchanged
    // and reproduces exactly the pre-change semantics — no inner arrangement, no way in.
    const parsed = PanelDefSchema.parse({ id: "container-view", title: "Container View" });
    expect(parsed).toEqual({ id: "container-view", title: "Container View" });
    expect(parsed.arranges).toBeUndefined();
  });

  test("the declaration is a NAME and nothing else, so it can never smuggle behaviour", () => {
    // A title is all the floor may learn: what the arrangement contains, how it reorders and
    // where it commits stay the panel's. A shape carrying more would be the manifest telling
    // the engine how to draw somebody else's rows.
    expect(
      PanelDefSchema.safeParse({ id: "sidebar", title: "Sidebar", arranges: {} }).success,
    ).toBe(false);
    expect(
      PanelDefSchema.safeParse({
        id: "sidebar",
        title: "Sidebar",
        arranges: { title: "Sidebar rows", sections: ["index"] },
      }).success,
    ).toBe(false);
  });
});

/**
 * THE BEHAVIORAL CONTRACT, ON THE WIRE.
 *
 * A plugin owns what happens to it and to its creations when it is composed, ordered,
 * disabled or purged — and every one of those declarations is inert DATA in the manifest,
 * because the plugin whose code may not be loaded cannot be the thing asked to describe
 * its own absence. Each case below pins a declaration the engine acts on, and — more
 * importantly — the shapes it must refuse for the contract to mean anything.
 */
describe("declared dependencies and ordering", () => {
  test("dependencies are KEYED by the plugin depended on, so a duplicate is unsayable", () => {
    const parsed = PluginManifestSchema.parse(
      manifest({ dependencies: { "core.shell": { type: "required", reason: "hosts my panel" } } }),
    );
    expect(parsed.dependencies?.["core.shell"]).toEqual({
      type: "required",
      reason: "hosts my panel",
    });
  });

  test("the three relations are the whole vocabulary, and a key is a real plugin id", () => {
    // Requirement is one axis with exactly three answers: refuse without it, tolerate its
    // absence, refuse WITH it. Anything else (a "recommended" tier, a version range) would
    // parse as decoration and go silently unenforced, which is worse than being refused.
    expect([...PLUGIN_DEPENDENCY_TYPES]).toEqual(["required", "optional", "incompatible"]);
    for (const type of PLUGIN_DEPENDENCY_TYPES) {
      expect(
        PluginManifestSchema.safeParse(manifest({ dependencies: { "core.shell": { type } } }))
          .success,
      ).toBe(true);
    }
    for (const dependencies of [
      { "core.shell": { type: "recommended" } },
      { "core.shell": { type: "required", versionRange: ">=1.0.0" } },
      { "core.shell": { type: "required", reason: "" } },
      { "core.shell": { type: "required", reason: "x".repeat(201) } },
      { shell: { type: "required" } }, // not a namespaced id: no roster row could answer for it
    ]) {
      expect(
        PluginManifestSchema.safeParse(manifest({ dependencies } as never)).success,
        JSON.stringify(dependencies),
      ).toBe(false);
    }
  });

  test("`after` is ordering ONLY, which is why it is not a dependency", () => {
    // "Compose me after X" and "I need X" are different sentences. Fused, an author has to
    // invent a requirement to get a sequence — and then a missing optional peer refuses a
    // composition that would have been fine.
    const parsed = PluginManifestSchema.parse(manifest({ after: ["core.shell", "core.presence"] }));
    expect(parsed.after).toEqual(["core.shell", "core.presence"]);
    expect(PluginManifestSchema.safeParse(manifest({ after: ["shell"] })).success).toBe(false);
    expect(
      PluginManifestSchema.safeParse(
        manifest({ after: Array.from({ length: 17 }, (_v, index) => `core.p${index}`) }),
      ).success,
    ).toBe(false);
  });
});

describe("plugin data versioning", () => {
  test("the data version is not the code version, and absence means unversioned", () => {
    // A plugin ships many releases against one storage shape; conflating the two would make
    // every release a migration question. Absent ≡ nothing to migrate and nothing to refuse,
    // which is every manifest written before this field existed.
    expect(PluginManifestSchema.parse(manifest()).dataVersion).toBeUndefined();
    const parsed = PluginManifestSchema.parse(
      manifest({ version: "2.4.1", dataVersion: { major: 2, minor: 0 } }),
    );
    expect(parsed.dataVersion).toEqual({ major: 2, minor: 0 });
  });

  test("a version is two non-negative integers and nothing else", () => {
    for (const dataVersion of [
      { major: 1 },
      { major: 1, minor: -1 },
      { major: 1.5, minor: 0 },
      { major: 1, minor: 0, patch: 3 }, // a third number nothing in the rule reads
    ]) {
      expect(
        PluginManifestSchema.safeParse(manifest({ dataVersion } as never)).success,
        JSON.stringify(dataVersion),
      ).toBe(false);
    }
  });
});

describe("dormancy is declarative", () => {
  test("the manifest names a MODE; it never supplies the thing that draws it", () => {
    // The residual renderer for a disabled plugin cannot live inside that plugin: the day
    // `entry.web` means "code that may not be loaded", a component here is a circular
    // dependency. So the engine owns the placeholder and reads only data from the manifest.
    expect([...PLUGIN_DORMANT_MODES]).toEqual(["ghost", "hide"]);
    expect(PluginManifestSchema.parse(manifest({ dormant: { mode: "hide" } })).dormant).toEqual({
      mode: "hide",
    });
    for (const dormant of [
      { mode: "ghost", render: "GhostNode" },
      { mode: "ghost", component: "./dormant.tsx" },
      { mode: "collapse" },
      { label: "Drawing" }, // a label without a mode says nothing about how to paint
    ]) {
      expect(
        PluginManifestSchema.safeParse(manifest({ dormant } as never)).success,
        JSON.stringify(dormant),
      ).toBe(false);
    }
  });

  test("`ghost` is the default, so absence keeps a user's work visible and named", () => {
    // The default has to be the one that loses nothing: a node holding work stays in the
    // document, inert, naming the plugin it is waiting for. `hide` is opt-in, for chrome.
    expect(DEFAULT_DORMANT_MODE).toBe("ghost");
    expect(PluginManifestSchema.parse(manifest()).dormant).toBeUndefined();
    expect(
      PluginManifestSchema.parse(manifest({ dormant: { mode: "ghost", label: "Drawing" } })).dormant
        ?.label,
    ).toBe("Drawing");
    expect(
      PluginManifestSchema.safeParse(manifest({ dormant: { mode: "ghost", label: "" } })).success,
    ).toBe(false);
  });
});

describe("the residual carve-out and the purge verb", () => {
  test("the residual mechanisms are a CLOSED three, one per plane", () => {
    // Disable gates a plugin's ACTIVE contributions; these are the declared carve-outs that
    // outlive it. Closed, so the carve-out cannot grow quietly: a fourth is a protocol
    // change reviewed as one.
    expect([...PLUGIN_RESIDUAL_MECHANISMS]).toEqual(["cleanup", "dormant", "retain"]);
    // "erase" and "reset" are deliberately absent. Disable is reversible, permission-gated
    // and workspace-global — binding destruction to it would let one click irreversibly
    // delete another principal's work. Destruction is its own verb, and it refuses while
    // the plugin is still on.
    const mechanisms: readonly string[] = PLUGIN_RESIDUAL_MECHANISMS;
    expect(mechanisms).not.toContain("erase");
    expect(mechanisms).not.toContain("reset");
    expect(PLUGIN_REFUSAL_REASONS as readonly string[]).toContain("still_enabled");
  });

  test("a manifest DECLARES what a purge would destroy, from a closed target set", () => {
    expect([...PLUGIN_PURGE_TARGETS]).toEqual(["storage", "elements", "ownership"]);
    expect(PluginManifestSchema.parse(manifest()).purges).toBeUndefined();
    expect(
      PluginManifestSchema.parse(manifest({ purges: ["storage", "elements"] })).purges,
    ).toEqual(["storage", "elements"]);
    // The declaration is a DESCRIPTION, never a trigger, and it cannot name a target the
    // engine has no verb for.
    expect(
      PluginManifestSchema.safeParse(manifest({ purges: ["sessions"] } as never)).success,
    ).toBe(false);
  });

  test("a purge report accounts for every target, zeros included", () => {
    const report = PluginPurgeResultSchema.parse({
      id: "core.canvas.draw",
      removed: { storage: 3, elements: 0, ownership: 1 },
    });
    expect(report.removed.elements).toBe(0);
    // "nothing was there" and "that target was skipped" must not read the same to someone
    // who just authorised a deletion, so a partial report is refused rather than defaulted.
    for (const removed of [
      { storage: 3 },
      { storage: 0, elements: 0, ownership: 0, sessions: 1 },
      { storage: -1, elements: 0, ownership: 0 },
    ]) {
      expect(
        PluginPurgeResultSchema.safeParse({ id: "core.canvas.draw", removed }).success,
        JSON.stringify(removed),
      ).toBe(false);
    }
  });
});

describe("contributed element placement traits", () => {
  const withElement = (element: Record<string, unknown>): PluginManifest =>
    manifest({
      contributes: {
        panels: [],
        sections: [],
        elements: [element] as never,
        tools: [],
        events: [],
      },
    });

  test("an element kind declares how the algebra must treat it, as data (G1)", () => {
    const parsed = PluginManifestSchema.parse(
      withElement({
        type: "draw",
        title: "Drawing",
        placement: { groups: ["canvas_item"], guards: [], homed: "inline" },
      }),
    );
    expect(parsed.contributes.elements[0]?.placement).toEqual({
      groups: ["canvas_item"],
      guards: [],
      homed: "inline",
    });
  });

  test("absence is the canvas_item default, so a v14 element row still means what it meant", () => {
    const parsed = PluginManifestSchema.parse(withElement({ type: "draw", title: "Drawing" }));
    expect(parsed.contributes.elements[0]?.placement).toBeUndefined();
    expect(DEFAULT_ELEMENT_PLACEMENT_TRAITS).toEqual({
      groups: ["canvas_item"],
      guards: [],
      homed: "inline",
    });
  });

  test("traits are the ALGEBRA's vocabulary; a manifest cannot invent placement behavior", () => {
    for (const placement of [
      { groups: ["floaty"], guards: [], homed: "inline" },
      { groups: ["canvas_item"], guards: ["discipline_match"], homed: "inline" }, // container-site
      { groups: ["canvas_item"], guards: [], homed: "whenever" },
      { groups: ["canvas_item"], guards: [] }, // homing is not optional: null is the answer
      { groups: ["canvas_item"], guards: [], homed: null, accepts: ["tileable"] },
    ]) {
      expect(
        PluginManifestSchema.safeParse(withElement({ type: "draw", title: "Drawing", placement }))
          .success,
        JSON.stringify(placement),
      ).toBe(false);
    }
  });
});

describe("the engine's own doors", () => {
  test("`engine.` is a RESERVED namespace whose ids are ordinary plugin ids", () => {
    // Enablement is a door like any other — same manifest, same action schemas, same
    // dispatch ladder — so it needs no relaxed id rule and no privileged second shape.
    expect(ENGINE_NAMESPACE_PREFIX).toBe("engine.");
    expect(PLUGIN_ID_PATTERN.test("engine.plugins")).toBe(true);
    expect(`${ENGINE_NAMESPACE_PREFIX}plugins`).toBe("engine.plugins");

    const door = PluginRosterEntrySchema.parse({
      manifest: manifest({ id: "engine.plugins", title: "Plugins", capabilities: [] }),
      enabled: true,
      source: "builtin",
      actions: [
        {
          name: "engine.plugins.setEnabled",
          title: "Enable or disable a plugin",
          caps: ["plugins:manage"],
          input: { type: "object" },
          result: { type: "object" },
        },
      ],
      refusal: "builtin",
    });
    // The row is what tells a client there is no toggle to draw: a named class, not a
    // special case the UI has to know by heart.
    expect(door.source).toBe("builtin");
    expect(door.refusal).toBe("builtin");
    expect(door.actions[0]?.name.startsWith(ENGINE_NAMESPACE_PREFIX)).toBe(true);
  });
});

describe("a v14 manifest is a v15 manifest", () => {
  test("every field the behavioral contract added is optional", () => {
    // The wire is session-side and additive-optional: a manifest written before any of this
    // existed must still parse, and every absent field must mean what the engine did before
    // the field existed. Anything else would be a migration billed to every plugin author.
    const parsed = PluginManifestSchema.parse({
      id: "core.terminals",
      version: "0.1.0",
      title: "Terminals",
      description: "",
      capabilities: ["containers:write"],
      contributes: { elements: [{ type: "draw", title: "Drawing" }] },
    });
    expect(parsed.dependencies).toBeUndefined();
    expect(parsed.after).toBeUndefined();
    expect(parsed.dataVersion).toBeUndefined();
    expect(parsed.dormant).toBeUndefined();
    expect(parsed.purges).toBeUndefined();
    expect(parsed.contributes.elements[0]?.placement).toBeUndefined();

    const row = PluginRosterEntrySchema.parse({
      manifest: parsed,
      enabled: true,
      source: "builtin",
      actions: [],
    });
    expect(row.lifecycle).toBeUndefined();
    expect(row.refusal).toBeUndefined();
    expect(row.changedBy).toBeUndefined();
    expect(row.changedAt).toBeUndefined();
  });
});

describe("the published plugin vocabulary", () => {
  test("every closed set a refusal can name is PUBLISHED, not merely documented", () => {
    // A3: a stranger's agent learns the contract from `GET /api/protocol`. A closed set
    // that lives only in prose is a set that drifts from the code enforcing it.
    const vocabulary = pluginVocabulary();
    expect(vocabulary["sources"]).toEqual(PLUGIN_SOURCES);
    expect(vocabulary["dependencyTypes"]).toEqual(PLUGIN_DEPENDENCY_TYPES);
    expect(vocabulary["dormantModes"]).toEqual(PLUGIN_DORMANT_MODES);
    expect(vocabulary["defaultDormantMode"]).toBe(DEFAULT_DORMANT_MODE);
    expect(vocabulary["residualMechanisms"]).toEqual(PLUGIN_RESIDUAL_MECHANISMS);
    expect(vocabulary["purgeTargets"]).toEqual(PLUGIN_PURGE_TARGETS);
    expect(vocabulary["lifecycleStates"]).toEqual(PLUGIN_LIFECYCLE_STATES);
    expect(vocabulary["refusalReasons"]).toEqual(PLUGIN_REFUSAL_REASONS);
    expect(vocabulary["denialRules"]).toEqual(ACTION_DENIAL_RULES);
    expect(vocabulary["defaultElementPlacement"]).toEqual(DEFAULT_ELEMENT_PLACEMENT_TRAITS);
    expect(vocabulary["engineNamespace"]).toBe(ENGINE_NAMESPACE_PREFIX);
    /*
      Published for the same reason: an author choosing an id has to learn which prefixes are
      taken from the wire rather than from a source tree they may not have. `core.` reads as
      official on a roster, which is the whole of what it means and the whole of what the
      assembly's reservation defends.
    */
    expect(vocabulary["coreNamespace"]).toBe(CORE_NAMESPACE_PREFIX);
    expect(CORE_NAMESPACE_PREFIX).toBe("core.");
    expect(PLUGIN_ID_PATTERN.test("core.shell")).toBe(true);
  });

  test("the manifest SHAPE is published, so the new fields are discoverable without source", () => {
    const schema = pluginVocabulary()["manifest"] as { properties: Record<string, unknown> };
    for (const field of ["dependencies", "after", "dataVersion", "dormant", "purges"]) {
      expect(Object.keys(schema.properties), field).toContain(field);
    }
    expect(pluginVocabulary()["rosterEntry"]).toBeDefined();
    expect(pluginVocabulary()["purgeResult"]).toBeDefined();
  });

  test("the SEAT intent is published, so a stranger's panel can ask for a place", () => {
    /*
      The default workspace is composed from this field (ADR 0017 S17-B), which makes it the one
      manifest declaration deciding what a fresh principal SEES. An agent writing a plugin has
      to learn the shape — and the resolved default for the ratio it may omit — from
      `GET /api/protocol` rather than from the engine's source.
    */
    const vocabulary = pluginVocabulary();
    expect(vocabulary["defaultSeatRatio"]).toBe(DEFAULT_SEAT_RATIO);
    // A generated JSON Schema, produced two lines up by `z.toJSONSchema`: in-process output of
    // a known shape, not input, which is why reading it is an assertion and not a parse.
    const seat = vocabulary["seat"] as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(seat.properties).sort()).toEqual(["order", "panel", "ratio"]);
    // `ratio` is the only optional half: a seat that cannot say WHERE is not a seat.
    expect([...seat.required].sort()).toEqual(["order", "panel"]);

    // Same provenance, same reason.
    const manifestSchema = vocabulary["manifest"] as {
      properties: { contributes: { properties: Record<string, unknown> } };
    };
    expect(Object.keys(manifestSchema.properties.contributes.properties)).toContain("seats");
  });

  test("a panel's inner arrangement is PUBLISHED, and adding it required nothing new", () => {
    /*
      A stranger writing a panel plugin learns from `GET /api/protocol` that a panel may say
      what it arranges inside itself — and an agent driving the mode learns the same shape
      from the same place. It rides the manifest schema rather than a new vocabulary key: one
      door onto "what a manifest may declare".
    */
    const manifestSchema = pluginVocabulary()["manifest"] as {
      properties: {
        contributes: { properties: { panels: { items: Record<string, unknown> } } };
      };
    };
    const panel = manifestSchema.properties.contributes.properties.panels.items as {
      properties: Record<string, unknown>;
      required: readonly string[];
    };
    expect(Object.keys(panel.properties).sort()).toEqual(["arranges", "id", "title"]);
    // ADDITIVE-OPTIONAL, pinned where a reader would notice: the required set is exactly what
    // it was before the field existed, so no manifest anywhere becomes invalid.
    expect([...panel.required].sort()).toEqual(["id", "title"]);
  });

  test("the vocabulary describes SHAPES; the composition names inhabitants", () => {
    // Two different questions with two different answers: what a plugin may be (always
    // true) and which plugins this server ran (true right now). Collapsing them into one
    // key would make a schema dump depend on a live registry.
    const bare = buildProtocolJsonSchema();
    expect(bare["pluginContract"]).toBeDefined();
    expect(bare["plugins"]).toBeUndefined();

    const described = buildProtocolJsonSchema({ actions: [], plugins: [] });
    expect(described["plugins"]).toEqual([]);
    expect(described["pluginContract"]).toEqual(bare["pluginContract"]);
  });
});
