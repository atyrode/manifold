import { DEFAULT_ELEMENT_PLACEMENT_TRAITS, type PluginManifest } from "@manifold/protocol";
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { AssemblyError, assembleRoster, defineAction, type PluginDef } from "../src/index.ts";

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
  caps: ["containers:write"],
  input: z.strictObject({ terminalId: z.string(), name: z.string().nullable() }),
  result: z.strictObject({ ok: z.boolean() }),
});

const terminals: PluginDef = {
  manifest: manifest({
    id: "core.terminals",
    capabilities: ["containers:write"],
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
        { id: "container-view", title: "Container" },
      ],
      sections: [{ id: "machines", title: "Machines", order: 20 }],
      elements: [{ type: "draw", title: "Drawing" }],
    },
  }),
  actions: [],
};

describe("assembleRoster", () => {
  test("composes a roster whose names, registries and published schemas are the vocabulary", () => {
    const assembly = assembleRoster([terminals, shell], NONE);

    expect(assembly.roster.map((entry) => entry.manifest.id)).toEqual([
      "core.terminals",
      "core.shell",
    ]);
    // `source` distinguishes rows the ENGINE published (its own builtin doors) from plugin
    // rows; nothing composed here is a builtin, so every row says so.
    expect(assembly.roster.every((entry) => entry.enabled && entry.source === "plugin")).toBe(true);

    // An action is published under its FULL name, and only there.
    expect([...assembly.actions.keys()]).toEqual(["core.terminals.rename"]);
    expect(assembly.actions.get("core.terminals.rename")?.plugin.id).toBe("core.terminals");
    expect(assembly.actions.get("core.terminals.rename")?.def).toBe(RENAME);
    expect(assembly.actions.has("rename")).toBe(false);

    const summary = assembly.roster[0]?.actions[0];
    expect(summary?.name).toBe("core.terminals.rename");
    expect(summary?.caps).toEqual(["containers:write"]);
    // An action that declares no scope is published as workspace-grade — the conservative
    // answer, stated rather than left for a reader to infer from an absent field.
    expect(summary?.scope).toBe("workspace");
    // The published schema is generated from the schema the door enforces.
    expect(summary?.input["type"]).toBe("object");
    expect(Object.keys((summary?.input["properties"] as Record<string, unknown>) ?? {})).toEqual([
      "terminalId",
      "name",
    ]);
    expect(summary?.result["type"]).toBe("object");

    expect([...assembly.panels.keys()]).toEqual([
      "core.shell.sidebar",
      "core.shell.container-view",
    ]);
    expect(assembly.panels.get("core.shell.sidebar")).toEqual({
      plugin: "core.shell",
      title: "Sidebar",
    });
    // `presentation` is RESOLVED like `placement` below: this manifest declared none, so the
    // registry publishes `disclosure` and no consumer has to know the default.
    expect(assembly.sections).toEqual([
      {
        id: "machines",
        plugin: "core.shell",
        title: "Machines",
        order: 20,
        presentation: "disclosure",
      },
    ]);
    // The manifest declared no placement traits, so the registry resolves the default (G1):
    // a reader sees traits, never an absence it would have to know the default for. The
    // registration declared no payload schema either, which is the other real declaration
    // (ADR 0013 §16): this kind's records carry nothing the engine should police.
    expect(assembly.elements.get("draw")).toEqual({
      plugin: "core.shell",
      title: "Drawing",
      placement: DEFAULT_ELEMENT_PLACEMENT_TRAITS,
      payload: null,
    });
    expect(assembly.tools).toEqual([
      { id: "terminal", plugin: "core.terminals", title: "Terminal" },
    ]);
    expect(assembly.enabled("core.shell")).toBe(true);
    expect(assembly.enabled("core.nothing")).toBe(false);
  });

  test("sections come out in declared order, whichever order their plugins registered in", () => {
    const late: PluginDef = {
      manifest: manifest({
        id: "core.views",
        contributes: { sections: [{ id: "views", title: "Views", order: 10 }] },
      }),
      actions: [],
    };
    // A plain row is a row of the SAME stack: one registry, one order. It interleaves by its
    // declared `order` alone, so nothing about presentation can promote or demote a row —
    // which is what makes chrome (a create strip, a status line) contributable at all.
    const plain: PluginDef = {
      manifest: manifest({
        id: "core.brand",
        contributes: {
          sections: [{ id: "brand", title: "Manifold", order: 15, presentation: "plain" }],
        },
      }),
      actions: [],
    };
    const assembly = assembleRoster([shell, late, plain], NONE);
    expect(assembly.sections.map((section) => [section.id, section.presentation])).toEqual([
      ["views", "disclosure"],
      ["brand", "plain"],
      ["machines", "disclosure"],
    ]);
  });

  test("a presentation nobody declared is refused with the manifest, not resolved away", () => {
    const rogue: PluginDef = {
      manifest: manifest({
        id: "core.rogue",
        contributes: {
          sections: [
            // The set is CLOSED: a stranger inventing a third way to draw a row would be
            // asking the shell for a renderer it has not got, so the manifest rung refuses.
            { id: "rogue", title: "Rogue", order: 1, presentation: "banner" } as never,
          ],
        },
      }),
      actions: [],
    };
    let thrown: unknown = null;
    try {
      assembleRoster([rogue], NONE);
    } catch (reason) {
      thrown = reason;
    }
    expect(thrown).toBeInstanceOf(AssemblyError);
    const problems = (thrown as AssemblyError).problems;
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('invalid manifest "core.rogue"');
    expect(problems[0]).toContain("sections.0.presentation");
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
      assembleRoster([shell, twin], NONE);
    } catch (reason) {
      thrown = reason;
    }
    expect(thrown).toBeInstanceOf(AssemblyError);
    const error = thrown as AssemblyError;
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
      manifest: manifest({ id: "core.a", capabilities: ["containers:write"] }),
      actions: [RENAME],
    };
    const b: PluginDef = {
      manifest: manifest({ id: "core.a", capabilities: ["containers:write"] }),
      actions: [RENAME],
    };
    expect(() => assembleRoster([a, b], NONE)).toThrow(
      /duplicate action "core\.a\.rename" claimed by: core\.a, core\.a/,
    );
  });

  test("an action may not require authority its manifest does not declare", () => {
    const overreach: PluginDef = {
      manifest: manifest({ id: "core.rogue", capabilities: ["containers:read"] }),
      actions: [RENAME],
    };
    expect(() => assembleRoster([overreach], NONE)).toThrow(
      /action "core\.rogue\.rename" requires cap "containers:write" outside its manifest capabilities \[containers:read\]/,
    );

    // A wildcard manifest is a ceiling of everything, so the same action composes.
    const wildcard: PluginDef = {
      manifest: manifest({ id: "core.admin", capabilities: ["*"] }),
      actions: [RENAME],
    };
    expect(assembleRoster([wildcard], NONE).actions.has("core.admin.rename")).toBe(true);
  });

  test("an action name that is not a local name refuses", () => {
    const qualified: PluginDef = {
      manifest: manifest({ id: "core.terminals", capabilities: ["containers:write"] }),
      actions: [{ ...RENAME, name: "core.terminals.rename" }],
    };
    expect(() => assembleRoster([qualified], NONE)).toThrow(/is not a local name/);
  });

  test("an invalid manifest refuses by name rather than throwing zod at the boot sequence", () => {
    const broken: PluginDef = { manifest: manifest({ id: "Core_Shell" }), actions: [] };
    let thrown: unknown = null;
    try {
      assembleRoster([broken], NONE);
    } catch (reason) {
      thrown = reason;
    }
    expect(thrown).toBeInstanceOf(AssemblyError);
    expect((thrown as AssemblyError).problems[0]).toContain('invalid manifest "Core_Shell"');
  });

  test("a disabled plugin keeps its contributions, and loses only enablement", () => {
    const assembly = assembleRoster([terminals, shell], new Set(["core.terminals"]));
    const entry = assembly.roster.find((row) => row.manifest.id === "core.terminals");

    expect(entry?.enabled).toBe(false);
    expect(assembly.enabled("core.terminals")).toBe(false);
    expect(assembly.enabled("core.shell")).toBe(true);

    // The point of keeping them: the server can say `plugin_disabled` instead of
    // `unknown_action`, and the browser can name the plugin a placeholder is waiting for.
    expect(entry?.actions).toHaveLength(1);
    expect(assembly.actions.has("core.terminals.rename")).toBe(true);
    expect(assembly.tools.map((tool) => tool.id)).toEqual(["terminal"]);
  });

  test("disabling never masks a collision the enablement flag would resurrect", () => {
    const twin: PluginDef = {
      manifest: manifest({
        id: "core.other",
        contributes: { elements: [{ type: "draw", title: "Other drawing" }] },
      }),
      actions: [],
    };
    expect(() => assembleRoster([shell, twin], new Set(["core.other"]))).toThrow(AssemblyError);
  });

  test("the essential flag reaches the roster, where a client must render a lock", () => {
    const assembly = assembleRoster([shell, terminals], NONE);
    expect(assembly.roster[0]?.manifest.essential).toBe(true);
    expect(assembly.roster[1]?.manifest.essential).toBeUndefined();
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
    expect(() => assembleRoster([unpublishable], NONE)).toThrow(
      /action "core\.void\.ping" result cannot be published as JSON Schema/,
    );
  });

  test("collisions between DIFFERENT plugins name every offender, of every kind, at once", () => {
    /*
      D5: a composition either exists or refuses, and the refusal is a review document. The
      same-id case above proves the mechanism; this one is the shape an operator actually
      hits — three strangers' plugins, each claiming one name another already holds. If the
      composer reported only the first, fixing a plugin list would be a guessing loop.
     */
    const alpha: PluginDef = {
      manifest: manifest({
        id: "vendor.alpha",
        capabilities: ["containers:write"],
        contributes: {
          sections: [{ id: "machines", title: "Machines", order: 5 }],
          tools: [{ id: "terminal", title: "Terminal" }],
          elements: [{ type: "draw", title: "Ink" }],
        },
      }),
      actions: [RENAME],
    };
    const beta: PluginDef = {
      manifest: manifest({
        id: "vendor.beta",
        contributes: {
          sections: [{ id: "machines", title: "Machines, again", order: 6 }],
          tools: [{ id: "terminal", title: "Terminal, again" }],
        },
      }),
      actions: [],
    };

    let thrown: unknown = null;
    try {
      assembleRoster([shell, alpha, beta, terminals], NONE);
    } catch (reason) {
      thrown = reason;
    }
    const error = thrown as AssemblyError;
    expect(error).toBeInstanceOf(AssemblyError);
    expect(error.problems).toEqual([
      'duplicate section "machines" claimed by: core.shell, vendor.alpha, vendor.beta',
      'duplicate element type "draw" claimed by: core.shell, vendor.alpha',
      'duplicate tool "terminal" claimed by: vendor.alpha, vendor.beta, core.terminals',
    ]);
    // THREE claimants on one name, all named: reporting a pair would hide the third.
    for (const id of ["core.shell", "vendor.alpha", "vendor.beta", "core.terminals"]) {
      expect(error.message).toContain(id);
    }
  });

  test("two plugins reserving the same EVENT topic refuse, before anything can consume it", () => {
    const alpha: PluginDef = {
      manifest: manifest({
        id: "vendor.alpha",
        contributes: { events: [{ id: "opened", title: "Opened" }] },
      }),
      actions: [],
    };
    const beta: PluginDef = {
      manifest: manifest({
        id: "vendor.beta",
        contributes: { events: [{ id: "opened", title: "Opened, differently" }] },
      }),
      actions: [],
    };

    /*
      `contributes.events` has no consumer this wave — ADR 0012 lands the plane in wave 2 —
      and that is exactly why uniqueness covers it NOW. An event id is a TOPIC a subscriber
      will address, so two plugins reserving one topic is D5's collision with its damage
      deferred rather than avoided: refusing while the namespace is still empty costs an
      author one rename, while refusing after the plane ships would break every subscriber
      already listening to whichever claimant happened to register first.
     */
    let thrown: unknown = null;
    try {
      assembleRoster([alpha, beta], NONE);
    } catch (reason) {
      thrown = reason;
    }
    const error = thrown as AssemblyError;
    expect(error).toBeInstanceOf(AssemblyError);
    expect(error.problems).toEqual([
      'duplicate event "opened" claimed by: vendor.alpha, vendor.beta',
    ]);
    // BOTH offenders named: an author shown one side of a collision cannot fix it.
    expect(error.message).toContain("vendor.alpha");
    expect(error.message).toContain("vendor.beta");
  });

  test("two plugins claiming one ROUTE SEGMENT refuse: there is one URL space", () => {
    const alpha: PluginDef = {
      manifest: manifest({
        id: "vendor.alpha",
        contributes: { routes: [{ segment: "links", title: "Links" }] },
      }),
      actions: [],
    };
    const beta: PluginDef = {
      manifest: manifest({
        id: "vendor.beta",
        contributes: { routes: [{ segment: "links", title: "Links, differently" }] },
      }),
      actions: [],
    };

    /*
      A route was a browser registration with no manifest row until wave F (issue #112), so
      `/links/` went to whichever web half the roster composed last and no half of the system
      could say who owned the path. The claim is refused HERE, where every other globally
      named contribution is refused, so a build that composes has exactly one answer per path
      and the browser's own join has a vocabulary to attach components to.
     */
    let thrown: unknown = null;
    try {
      assembleRoster([alpha, beta], NONE);
    } catch (reason) {
      thrown = reason;
    }
    const error = thrown as AssemblyError;
    expect(error).toBeInstanceOf(AssemblyError);
    expect(error.problems).toEqual([
      'duplicate route "links" claimed by: vendor.alpha, vendor.beta',
    ]);
  });

  test("every invalid manifest is reported in ONE refusal, alongside the collisions", () => {
    // A boot that threw on the first bad manifest would make a broken plugin list a
    // one-fix-per-restart crawl; the composer is a validator, so it reports the whole batch.
    const brokenId: PluginDef = { manifest: manifest({ id: "Core_Shell" }), actions: [] };
    const brokenCaps: PluginDef = {
      manifest: manifest({ id: "core.rogue", capabilities: ["containers:invent"] as never }),
      actions: [],
    };
    const twin: PluginDef = {
      manifest: manifest({
        id: "core.other",
        contributes: { elements: [{ type: "draw", title: "Other ink" }] },
      }),
      actions: [],
    };

    let thrown: unknown = null;
    try {
      assembleRoster([brokenId, shell, brokenCaps, twin], NONE);
    } catch (reason) {
      thrown = reason;
    }
    const error = thrown as AssemblyError;
    expect(error).toBeInstanceOf(AssemblyError);
    expect(error.problems).toHaveLength(3);
    expect(error.problems[0]).toContain('invalid manifest "Core_Shell"');
    expect(error.problems[1]).toContain('invalid manifest "core.rogue"');
    // An unparseable manifest drops out of the uniqueness pass rather than poisoning it, so
    // the collision between the two VALID plugins is still found in the same run.
    expect(error.problems[2]).toBe(
      'duplicate element type "draw" claimed by: core.shell, core.other',
    );
  });

  test("a manifest with no id at all is named by its position, not swallowed", () => {
    const anonymous: PluginDef = {
      manifest: { ...manifest({ id: "core.ok" }), id: "" } as PluginManifest,
      actions: [],
    };
    let thrown: unknown = null;
    try {
      assembleRoster([shell, anonymous], NONE);
    } catch (reason) {
      thrown = reason;
    }
    // "Something in your plugin list is broken" is not actionable; "index 1" is.
    expect((thrown as AssemblyError).problems[0]).toContain("invalid manifest at index 1");
  });

  test("the cleanup flag reaches the ROSTER, so a client knows which affordances outlive a toggle", () => {
    const kill = defineAction({
      name: "kill",
      title: "Kill terminal",
      caps: ["containers:write"],
      input: z.strictObject({ terminalId: z.string() }),
      result: z.strictObject({ killed: z.boolean() }),
      cleanup: true,
    });
    const assembly = assembleRoster(
      [{ manifest: terminals.manifest, actions: [RENAME, kill] }],
      new Set(["core.terminals"]),
    );

    const summaries = assembly.roster[0]?.actions ?? [];
    // D12: the browser has to render a kill control on a disabled plugin's terminals and
    // hide its rename control, and the roster is the only place it can learn which is which.
    expect(summaries.find((summary) => summary.name === "core.terminals.kill")?.cleanup).toBe(true);
    const rename = summaries.find((summary) => summary.name === "core.terminals.rename");
    expect("cleanup" in (rename ?? {})).toBe(false);
    // The flag is a dispatch property, not an enablement one: the registry still holds both.
    expect(assembly.actions.get("core.terminals.kill")?.def.cleanup).toBe(true);
    expect(assembly.enabled("core.terminals")).toBe(false);
  });

  test("sections with equal order keep roster order, so the sidebar never shuffles", () => {
    // Ties are inevitable once strangers pick numbers. An unstable sort would reorder a
    // user's sidebar on an unrelated toggle, since a recompose happens on every roster
    // change — so the tiebreak is the registration order, deterministically.
    const tied = (id: string): PluginDef => ({
      manifest: manifest({
        id,
        contributes: { sections: [{ id: id.split(".")[1] ?? id, title: id, order: 20 }] },
      }),
      actions: [],
    });
    const defs = [tied("core.aaa"), tied("core.bbb"), tied("core.ccc")];

    const forward = assembleRoster(defs, NONE).sections.map((section) => section.plugin);
    expect(forward).toEqual(["core.aaa", "core.bbb", "core.ccc"]);
    // Reversing the REGISTRATION reverses the result: nothing else (id, title) breaks ties.
    const backward = assembleRoster([...defs].reverse(), NONE).sections.map(
      (section) => section.plugin,
    );
    expect(backward).toEqual(["core.ccc", "core.bbb", "core.aaa"]);
  });

  test("two plugins claiming one EVENT id refuse, even though nothing consumes events yet", () => {
    const publisher = (id: string): PluginDef => ({
      manifest: manifest({
        id,
        contributes: { events: [{ id: "spotlighted", title: "Spotlight moved" }] },
      }),
      actions: [],
    });

    /*
      `contributes.events` is reserved for the wave-2 event plane (ADR 0012), so this refusal
      protects nothing that runs today — deliberately. An event id is a GLOBAL topic name the
      moment it is declared, and topics are nodes; letting two plugins register one now would
      mean the wave that starts delivering events has to break somebody to fix it. D5 refuses
      at declaration time, which is the only time it is free.
     */
    let thrown: unknown = null;
    try {
      assembleRoster([publisher("core.presence"), publisher("vendor.watcher")], NONE);
    } catch (reason) {
      thrown = reason;
    }
    expect(thrown).toBeInstanceOf(AssemblyError);
    expect((thrown as AssemblyError).problems).toEqual([
      'duplicate event "spotlighted" claimed by: core.presence, vendor.watcher',
    ]);

    // One plugin declaring the id is fine, and it stays purely declarative: an event
    // contributes no registry entry this wave, only the reservation.
    const solo = assembleRoster([publisher("core.presence")], NONE);
    expect(solo.roster[0]?.manifest.contributes.events).toEqual([
      { id: "spotlighted", title: "Spotlight moved" },
    ]);
  });
});

describe("seat legality", () => {
  /*
    Composition does not BUILD the default workspace — `composeDefaultLayout` does, from the
    published roster, and its own cases live beside it. What composition owns is the pair of
    claims the composer cannot check for itself: a plugin may only seat a panel it contributes,
    and one panel may be seated once. Both refuse by name at build time.
  */
  const seater = (id: string, seats: PluginManifest["contributes"]["seats"]): PluginDef => ({
    manifest: manifest({
      id,
      contributes: { panels: [{ id: "rail", title: "Rail" }], seats },
    }),
    actions: [],
  });

  test("a seat rides through on the manifest, and a manifest may declare none", () => {
    const assembly = assembleRoster(
      [seater("vendor.dock", [{ panel: "rail", order: 10 }]), shell],
      NONE,
    );

    // Published as declared, on the roster row every client reads: the roster IS the seat
    // registry, so composition adds no second copy for the composer to disagree with.
    expect(assembly.roster[0]?.manifest.contributes.seats).toEqual([{ panel: "rail", order: 10 }]);
    // Absence is a meaning, not a hole: the field is simply not there on a manifest with none.
    expect(assembly.roster[1]?.manifest.contributes.seats).toBeUndefined();
  });

  test("a plugin may only seat a panel it contributes itself", () => {
    let thrown: unknown;
    try {
      assembleRoster([shell, seater("vendor.squatter", [{ panel: "sidebar", order: 1 }])], NONE);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AssemblyError);
    // Named with the panel it asked for, NOT resolved against core.shell's registered
    // `sidebar`: a seat is checked against its own manifest, so legality cannot depend on
    // which plugins happen to be composed beside it.
    expect((thrown as AssemblyError).problems).toEqual([
      'plugin "vendor.squatter" seats panel "sidebar", which it does not contribute',
    ]);
  });

  test("two seats for one panel refuse, like every other claimed name", () => {
    let thrown: unknown;
    try {
      assembleRoster(
        [
          seater("vendor.twice", [
            { panel: "rail", order: 1 },
            { panel: "rail", order: 2 },
          ]),
        ],
        NONE,
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AssemblyError);
    expect((thrown as AssemblyError).problems).toEqual([
      'duplicate seat "vendor.twice.rail" claimed by: vendor.twice, vendor.twice',
    ]);
  });
});

/**
 * CONTRACT V2 in the ENGINE — dependencies, ordering, reservations and stored data.
 *
 * What composition refuses is deliberately narrow: STRUCTURAL truths no toggle can fix. The
 * cases below pin both halves of that line, because the failure mode of getting it wrong is
 * a workspace that will not boot over a plugin nobody is using.
 */
describe("assembleRoster dependencies and order", () => {
  function dep(id: string, dependencies: PluginManifest["dependencies"]): PluginDef {
    return { manifest: { ...manifest({ id }), dependencies }, actions: [] };
  }

  function after(id: string, targets: readonly string[]): PluginDef {
    return { manifest: { ...manifest({ id }), after: [...targets] }, actions: [] };
  }

  test("order is topological, and ties break lexicographically rather than by registration", () => {
    const assembly = assembleRoster(
      [
        after("core.zulu", ["core.mike"]),
        dep("core.mike", { "core.base": { type: "required" } }),
        dep("core.base", {}),
        dep("core.alpha", {}),
      ],
      NONE,
    );

    // Dependencies and `after` both order; among plugins nothing separates, the id decides.
    // Registration order deliberately DISAGREES with the answer, because an order that
    // happened to match the array would not prove anything.
    expect(assembly.order).toEqual(["core.alpha", "core.base", "core.mike", "core.zulu"]);

    // ...and the same defs in any other order compose to the same sequence: the lifecycle
    // fan-out rides this, so "deterministic" has to mean input-order-independent.
    const shuffled = assembleRoster(
      [
        dep("core.alpha", {}),
        dep("core.base", {}),
        after("core.zulu", ["core.mike"]),
        dep("core.mike", { "core.base": { type: "required" } }),
      ],
      NONE,
    );
    expect(shuffled.order).toEqual(assembly.order);
  });

  test("a required dependency nothing composed refuses, naming both plugins", () => {
    let thrown: unknown = null;
    try {
      assembleRoster(
        [dep("core.leaf", { "core.absent": { type: "required", reason: "needs its storage" } })],
        NONE,
      );
    } catch (reason) {
      thrown = reason;
    }

    // STRUCTURAL: no toggle produces a plugin that is not in the build, so this cannot be a
    // door refusal — there is nothing an administrator could do about it later.
    expect(thrown).toBeInstanceOf(AssemblyError);
    expect((thrown as AssemblyError).problems).toEqual([
      'plugin "core.leaf" requires plugin "core.absent", which is not composed (needs its storage)',
    ]);
  });

  test("a merely DISABLED dependency composes: the refusal belongs at the door", () => {
    const assembly = assembleRoster(
      [dep("core.base", {}), dep("core.leaf", { "core.base": { type: "required" } })],
      new Set(["core.base"]),
    );

    /*
      No cascade in either direction (ADR 0013 §5.4/§5.5). `core.leaf` stays enabled state-wise
      — `enabled` is the ADMINISTRATIVE truth and the only one — while the roster names the
      obstacle through `unmet`, and the enablement door refuses the moves that would break it.
      A cascade here would be other principals' refs vanishing without their consent.
     */
    expect(assembly.enabled("core.leaf")).toBe(true);
    expect(assembly.enabled("core.base")).toBe(false);
    expect(assembly.unmet("core.leaf")).toEqual(["core.base"]);
    expect(assembly.requiredBy("core.base")).toEqual(["core.leaf"]);
    // The disabled row advertises WHY it cannot simply be switched back on.
    const base = assembly.roster.find((entry) => entry.manifest.id === "core.base");
    expect(base?.refusal).toBeUndefined();
    const stranded = assembleRoster(
      [dep("core.base", {}), dep("core.leaf", { "core.base": { type: "required" } })],
      new Set(["core.base", "core.leaf"]),
    ).roster.find((entry) => entry.manifest.id === "core.leaf");
    expect(stranded?.refusal).toBe("dependency_disabled");
  });

  test("an optional dependency orders but never requires; a missing `after` is ignored", () => {
    const assembly = assembleRoster(
      [
        dep("core.late", {
          "core.early": { type: "optional" },
          "core.absent": { type: "optional" },
        }),
        dep("core.early", {}),
        after("core.wisher", ["core.nobody"]),
      ],
      NONE,
    );

    // Home Assistant's split: `dependencies` says what must BE there, `after` only what must
    // come first. An ordering wish about a plugin that legitimately does not exist is not an
    // error, and an optional dependency's absence is not either.
    expect(assembly.order.indexOf("core.early")).toBeLessThan(assembly.order.indexOf("core.late"));
    expect(assembly.unmet("core.late")).toEqual([]);
    expect(assembly.roster).toHaveLength(3);
  });

  test("incompatibility is symmetric and orders nothing", () => {
    const assembly = assembleRoster(
      [dep("core.rival", { "core.leaf": { type: "incompatible" } }), dep("core.leaf", {})],
      NONE,
    );

    expect(assembly.conflicts("core.leaf")).toEqual(["core.rival"]);
    expect(assembly.conflicts("core.rival")).toEqual(["core.leaf"]);
    // Two plugins that never run together have nothing to order, so the incompatibility adds
    // no edge — and a pair that declared each other incompatible would otherwise be a cycle.
    expect(assembly.order).toEqual(["core.leaf", "core.rival"]);
    // Composed with one off, the other is unencumbered.
    expect(
      assembleRoster(
        [dep("core.rival", { "core.leaf": { type: "incompatible" } }), dep("core.leaf", {})],
        new Set(["core.leaf"]),
      ).conflicts("core.rival"),
    ).toEqual([]);
  });

  test("a dependency cycle refuses, naming every plugin in it", () => {
    let thrown: unknown = null;
    try {
      assembleRoster(
        [
          dep("core.one", { "core.two": { type: "required" } }),
          dep("core.two", { "core.one": { type: "required" } }),
          dep("core.free", {}),
        ],
        NONE,
      );
    } catch (reason) {
      thrown = reason;
    }

    // A cycle has no total order, and the fan-out order is contract — so this is structural
    // and names the offenders rather than picking a winner by registration accident.
    expect(thrown).toBeInstanceOf(AssemblyError);
    expect((thrown as AssemblyError).problems).toEqual([
      "dependency cycle among: core.one, core.two",
    ]);
  });

  test("self-dependency refuses in both spellings", () => {
    let thrown: unknown = null;
    try {
      assembleRoster(
        [
          dep("core.narcissus", { "core.narcissus": { type: "required" } }),
          after("core.echo", ["core.echo"]),
        ],
        NONE,
      );
    } catch (reason) {
      thrown = reason;
    }
    expect((thrown as AssemblyError).problems).toEqual([
      'plugin "core.narcissus" declares a dependency on itself',
      'plugin "core.echo" declares itself in "after"',
    ]);
  });
});

describe("assembleRoster reservations, builtins and stored data", () => {
  const drawing: PluginDef = {
    manifest: manifest({
      id: "core.draw",
      contributes: { elements: [{ type: "draw", title: "Drawing" }] },
    }),
    actions: [],
  };

  test("an element type reserved by another plugin cannot be claimed, and names the owner", () => {
    const squatter: PluginDef = {
      manifest: manifest({
        id: "vendor.sketch",
        contributes: { elements: [{ type: "draw", title: "Sketching" }] },
      }),
      actions: [],
    };

    let thrown: unknown = null;
    try {
      assembleRoster([squatter], NONE, { elementOwners: new Map([["draw", "core.draw"]]) });
    } catch (reason) {
      thrown = reason;
    }

    /*
      The reservation is a tombstone that OUTLIVES its owner's presence in the build, which is
      the whole point: a canvas full of `draw` elements does not disappear when the plugin
      that wrote them goes dormant, so the type must not be reinterpreted by whatever ships
      next under that name. Duplicate-claim refusal only catches the case where both plugins
      are present.
     */
    expect(thrown).toBeInstanceOf(AssemblyError);
    expect((thrown as AssemblyError).problems).toEqual([
      'element type "draw" is reserved by "core.draw"; "vendor.sketch" cannot claim it',
    ]);

    // The rightful owner composes against its own reservation without complaint.
    expect(() =>
      assembleRoster([drawing], NONE, { elementOwners: new Map([["draw", "core.draw"]]) }),
    ).not.toThrow();
  });

  test("the engine namespace is reserved: only rows the engine registered may claim it", () => {
    const impostor: PluginDef = { manifest: manifest({ id: "engine.plugins" }), actions: [] };

    let thrown: unknown = null;
    try {
      assembleRoster([impostor], NONE);
    } catch (reason) {
      thrown = reason;
    }

    // A plugin under `engine.*` would publish a row indistinguishable from a builtin door —
    // the one row a client renders WITHOUT a toggle — so the squat is refused by name.
    expect(thrown).toBeInstanceOf(AssemblyError);
    expect((thrown as AssemblyError).problems).toEqual([
      'plugin "engine.plugins" claims the reserved "engine." namespace, which only the engine\'s own builtin doors may use',
    ]);

    // Registered BY the engine, the same manifest is legal and publishes as a builtin row
    // whose refusal class says there is nothing to toggle.
    const assembly = assembleRoster([impostor], NONE, {
      builtins: new Set(["engine.plugins"]),
    });
    const row = assembly.roster[0];
    expect(row?.source).toBe("builtin");
    expect(row?.refusal).toBe("builtin");
    expect(assembly.builtin("engine.plugins")).toBe(true);
  });

  test("the core namespace is reserved: only the shipped distribution's own ids may claim it", () => {
    // The distribution, as its registration file yields it: derived from what is registered,
    // never a hand-kept list of "our" plugins (invariant 14).
    const distribution = new Set([drawing.manifest.id]);
    const impostor: PluginDef = { manifest: manifest({ id: "core.impostor" }), actions: [] };

    let thrown: unknown = null;
    try {
      assembleRoster([impostor], NONE, { distribution });
    } catch (reason) {
      thrown = reason;
    }

    /*
      `core.` buys no privilege at dispatch — that is the point of the namespace — but an id is
      what a principal reads on the roster and what an agent reads over `GET /api/plugins`, so a
      stranger publishing `core.impostor` looks official to both. Refused by name, exactly like
      an `engine.` squat.
     */
    expect(thrown).toBeInstanceOf(AssemblyError);
    expect((thrown as AssemblyError).problems).toEqual([
      'plugin "core.impostor" claims the reserved "core." namespace, which only the shipped distribution\'s own plugins may use',
    ]);

    // The distribution's own seats compose against the same set, and a stranger's own
    // namespace is nobody's business but theirs.
    const vendor: PluginDef = { manifest: manifest({ id: "vendor.impostor" }), actions: [] };
    const assembly = assembleRoster([drawing, vendor], NONE, { distribution });
    expect(assembly.roster.map((entry) => entry.manifest.id)).toEqual([
      "core.draw",
      "vendor.impostor",
    ]);

    /*
      NO distribution declared means UNKNOWN rather than empty, and this case is why: the
      browser and every unit test assemble the same definitions with none of the durable facts,
      and refusing every `core.` id against a set nobody supplied would be a verdict invented
      from missing information. The production wiring (`main.ts`) is what makes it real.
     */
    expect(() => assembleRoster([impostor], NONE)).not.toThrow();
  });

  test("roster rows carry lifecycle state, attribution, and the essential refusal class", () => {
    // Deliberately WITHOUT the element contribution: `shell` already claims `draw`, and a
    // duplicate claim is its own refusal (D5) with nothing to say about roster fields.
    const bare: PluginDef = { manifest: manifest({ id: "core.draw" }), actions: [] };
    const assembly = assembleRoster([shell, bare], new Set(["core.draw"]), {
      lifecycle: new Map([["core.draw", "disable_failed" as const]]),
      attribution: new Map([["core.draw", { by: "principal-3", at: 42 }]]),
    });

    const draw = assembly.roster.find((entry) => entry.manifest.id === "core.draw");
    expect(draw?.lifecycle).toBe("disable_failed");
    expect(draw?.changedBy).toBe("principal-3");
    expect(draw?.changedAt).toBe(42);

    // `essential` is now one named refusal class among several rather than a special case:
    // the UI decides whether to draw a lever from the class, not from a flag it re-reads.
    const shellRow = assembly.roster.find((entry) => entry.manifest.id === "core.shell");
    expect(shellRow?.refusal).toBe("essential");
    // An ordinary enabled plugin advertises no obstacle at all.
    expect(assembleRoster([bare], NONE).roster[0]?.refusal).toBeUndefined();
  });

  test("stored data is judged for plugins that will SERVE, and only for those", () => {
    const versioned = (major: number): PluginDef => ({
      manifest: { ...manifest({ id: "core.store" }), dataVersion: { major, minor: 0 } },
      actions: [],
    });
    const dataState = new Map([["core.store", { version: { major: 3, minor: 1 }, applied: [] }]]);

    let thrown: unknown = null;
    try {
      assembleRoster([versioned(2)], NONE, { dataState });
    } catch (reason) {
      thrown = reason;
    }
    expect((thrown as AssemblyError).problems[0]).toContain("major downgrade is refused");

    // Disabled, the same data is RETAINED and untouched, so it endangers nobody and boot
    // proceeds: the refusal moves to the enablement door, where an actor is present to hear
    // it. Refusing here instead would mean one dormant plugin's old rows can stop a server.
    expect(() =>
      assembleRoster([versioned(2)], new Set(["core.store"]), { dataState }),
    ).not.toThrow();

    // A major bump forward with a declared, unapplied migration is a PLAN, not a refusal.
    const planned = assembleRoster(
      [
        {
          ...versioned(4),
          migrations: [{ name: "to-4", to: { major: 4, minor: 0 }, migrate: () => undefined }],
        },
      ],
      NONE,
      { dataState },
    );
    expect(planned.pendingMigrations.get("core.store")?.map((step) => step.name)).toEqual(["to-4"]);
  });

  test("migrations must be named once, and may not claim to reach past their own code", () => {
    const bad: PluginDef = {
      manifest: { ...manifest({ id: "core.store" }), dataVersion: { major: 2, minor: 0 } },
      actions: [],
      migrations: [
        { name: "same", to: { major: 1, minor: 0 }, migrate: () => undefined },
        { name: "same", to: { major: 2, minor: 0 }, migrate: () => undefined },
        { name: "ahead", to: { major: 3, minor: 0 }, migrate: () => undefined },
      ],
    };
    const unversioned: PluginDef = {
      manifest: manifest({ id: "core.loose" }),
      actions: [],
      migrations: [{ name: "orphan", to: { major: 1, minor: 0 }, migrate: () => undefined }],
    };

    let thrown: unknown = null;
    try {
      assembleRoster([bad, unversioned], NONE);
    } catch (reason) {
      thrown = reason;
    }

    // The ledger records NAMES, so a duplicate name would make "did this already run?"
    // unanswerable; a migration reaching past the declared version would leave data its own
    // code cannot read; and a migration with no version to reach is a transformation nobody
    // can decide to run.
    expect((thrown as AssemblyError).problems).toEqual([
      'plugin "core.store" migration "ahead" targets 3.0, past the 2.0 its code declares',
      'duplicate migration in "core.store" "same" claimed by: core.store, core.store',
      'plugin "core.loose" declares migration "orphan" without a manifest dataVersion to reach',
    ]);
  });
});

describe("assembleRoster action scope", () => {
  test("a declared container scope is published, and an undeclared one defaults to workspace", () => {
    const containerGraded = defineAction({
      name: "read",
      title: "Read this container's index",
      caps: ["containers:read"],
      scope: "container",
      input: z.strictObject({}),
      result: z.strictObject({}),
    });
    const assembly = assembleRoster(
      [
        {
          manifest: manifest({
            id: "core.index",
            capabilities: ["containers:read", "containers:write"],
          }),
          actions: [
            containerGraded,
            defineAction({
              name: "createContainer",
              title: "Create a container",
              caps: ["containers:write"],
              input: z.strictObject({}),
              result: z.strictObject({}),
            }),
          ],
        },
      ],
      NONE,
    );

    /*
      `scope` is vocabulary, not an implementation detail: a client holding a container-scoped token
      decides which affordances to render from the published roster, so "may my token call
      this?" has to be answerable without asking the server and being refused. Both rows carry
      a value — the default is resolved by the engine, never by the reader.
     */
    const published = new Map(
      (assembly.roster[0]?.actions ?? []).map((action) => [action.name, action.scope]),
    );
    expect(published.get("core.index.read")).toBe("container");
    expect(published.get("core.index.createContainer")).toBe("workspace");
    // The registry keeps the DEFINITION, so the dispatcher reads the declared scope directly.
    expect(assembly.actions.get("core.index.read")?.def.scope).toBe("container");
    expect(assembly.actions.get("core.index.createContainer")?.def.scope).toBeUndefined();
  });
});
