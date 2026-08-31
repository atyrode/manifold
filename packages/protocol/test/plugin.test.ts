import { describe, expect, test } from "bun:test";
import {
  ACTION_DENIAL_RULES,
  ActionOutcomeSchema,
  ActionSummarySchema,
  CONNECTION_BODIES,
  CONNECTION_LEVEL_MESSAGE_TYPES,
  PluginManifestSchema,
  PluginRosterEntrySchema,
  PluginRosterSchema,
  SERVER_MESSAGE_TYPES,
  ServerMessageSchema,
  TileSurfaceSchema,
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
    capabilities: ["pads:write"],
    contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
    ...overrides,
  };
}

describe("plugin manifest", () => {
  test("the contribution lists default to empty, so a manifest declares only what it adds", () => {
    const parsed = PluginManifestSchema.parse({
      id: "core.layout",
      version: "0.1.0",
      title: "Workspace layout",
      description: "One action door over the workspace tree.",
      capabilities: [],
      contributes: {},
    });

    // A plugin contributing nothing but actions (core.layout is exactly that) must not have
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

  test("the reserved fields parse today so the waves that use them need no new shape", () => {
    // `entry` is the dynamic-distribution seam and `contributes.events` the event plane's
    // (ADR 0012). Both are declared NOW and consumed later: a manifest written this wave
    // must still validate when those waves land, or every plugin author pays a migration.
    const reserved = PluginManifestSchema.parse(
      manifest({
        id: "core.presence",
        capabilities: ["scene:write"],
        contributes: {
          panels: [],
          sections: [],
          elements: [],
          tools: [],
          events: [{ id: "spotlighted", title: "Spotlight moved" }],
        },
        entry: { web: "./web.tsx", server: true },
      }),
    );

    expect(reserved.contributes.events).toEqual([{ id: "spotlighted", title: "Spotlight moved" }]);
    expect(reserved.entry).toEqual({ web: "./web.tsx", server: true });
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
        manifest({ capabilities: ["pads:write", "plugins:invent"] as never }),
      ).success,
    ).toBe(false);
    expect(
      PluginManifestSchema.safeParse(
        manifest({ capabilities: Array.from({ length: 17 }, () => "pads:read" as const) }),
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
    caps: ["pads:write"] as const,
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
    expect(ActionSummarySchema.safeParse({ ...summary, caps: ["pads:invent"] }).success).toBe(
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
    expect([...ACTION_DENIAL_RULES]).toEqual([
      "unknown_action",
      "plugin_disabled",
      "forbidden",
      "invalid_args",
      "refused",
    ]);
  });
});

describe("the plugin roster", () => {
  const entry: PluginRosterEntry = {
    manifest: manifest(),
    enabled: false,
    source: "builtin",
    actions: [
      {
        name: "core.terminals.kill",
        title: "Kill terminal",
        caps: ["pads:write"],
        cleanup: true,
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

  test("`source` tells compiled-in code from distributed code, and admits only the former", () => {
    // The field exists this wave so the marketplace wave needs no new roster shape (D8);
    // until then `builtin` is the only truth the server may claim.
    expect(PluginRosterEntrySchema.safeParse({ ...entry, source: "remote" }).success).toBe(false);
    expect(PluginRosterEntrySchema.safeParse({ ...entry, source: "builtin" }).success).toBe(true);
    // `enabled` is not optional: "unknown enablement" is not a state a client can render.
    expect(
      PluginRosterEntrySchema.safeParse({
        manifest: entry.manifest,
        source: entry.source,
        actions: entry.actions,
      }).success,
    ).toBe(false);
  });
});

describe("the connection-level plugins frame", () => {
  const roster = PluginRosterSchema.parse([
    { manifest: manifest(), enabled: true, source: "builtin", actions: [] },
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
    // The liveness pair are connection-level too, and neither has a body to parse.
    expect([...CONNECTION_LEVEL_MESSAGE_TYPES]).toEqual(["ping", "pong", "plugins"]);
  });
});

describe("the panel tile surface", () => {
  test("a panel is a leaf surface like any other, so the workspace is one tree vocabulary", () => {
    // D2: the shell is a composition, not a second node system. The workspace layout is a
    // TileLayout whose leaves are plugin panels, rendered by the SAME TileTree component
    // every container uses.
    const parsed = TileSurfaceSchema.parse({ kind: "panel", panelId: "core.shell.sidebar" });
    expect(parsed).toEqual({ kind: "panel", panelId: "core.shell.sidebar" });
  });

  test("a panel surface names exactly one panel, with nothing else attached", () => {
    expect(TileSurfaceSchema.safeParse({ kind: "panel", panelId: "" }).success).toBe(false);
    expect(TileSurfaceSchema.safeParse({ kind: "panel" }).success).toBe(false);
    // No props, no config, no component: a surface is an ADDRESS the outlet resolves
    // against the live composition, which is what lets a disable render a placeholder.
    expect(
      TileSurfaceSchema.safeParse({
        kind: "panel",
        panelId: "core.shell.sidebar",
        props: { collapsed: true },
      }).success,
    ).toBe(false);
  });
});
