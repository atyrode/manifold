import { describe, expect, test } from "bun:test";
import {
  ISOLATE_CRASH_BUDGET,
  ISOLATE_CTX_METHODS,
  ISOLATE_DISPATCH_DEADLINE_MS,
  ISOLATE_IDLE_EVICT_MS,
  ISOLATE_MAX_ARTIFACT_BYTES,
  IsolateChildFrameSchema,
  IsolateHostFrameSchema,
  MAX_UI_DEPTH,
  MAX_UI_NODES,
  PLUGIN_INSTALL_REFUSALS,
  PluginBundleSchema,
  PluginRosterEntrySchema,
  TRACED_DENIAL_RULES,
  TRACE_OUTCOMES,
  UI_NODE_TYPES,
  UI_TONES,
  UiEventSchema,
  UiNodeSchema,
  WEB_HOST_METHODS,
  WebIsolateHostFrameSchema,
  WebIsolateWorkerFrameSchema,
  buildProtocolJsonSchema,
  type PluginInstall,
  type PluginBundle,
  type PluginRosterEntry,
  type UiNode,
} from "@manifold/protocol";

/**
 * THE ISOLATION VOCABULARY ON THE WIRE (ADR 0016).
 *
 * An installed plugin is a stranger's code, and everything it says to the engine crosses a
 * message boundary: a component tree from a Worker, an outcome from a child process, a bundle
 * from an install door. These tests pin what those messages may be and — more importantly —
 * what is refused, because every refusal here is a shape the engine can never be handed by a
 * party it does not trust.
 */

function box(children: readonly UiNode[]): UiNode {
  return { type: "box", children };
}

/** A tree of `depth` nested boxes ending in a divider: `depth` nodes deep, `depth` nodes wide. */
function nested(depth: number): UiNode {
  let tree: UiNode = { type: "divider" };
  for (let level = 1; level < depth; level++) tree = box([tree]);
  return tree;
}

function bundle(overrides: Partial<PluginBundle> = {}): PluginBundle {
  return {
    format: 1,
    manifest: {
      id: "vendor.thing",
      version: "1.0.0",
      title: "Thing",
      description: "",
      capabilities: ["containers:read"],
      contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
      entry: { server: true, web: "web.js" },
    },
    files: { "server.js": "aGVsbG8=", "web.js": "aGVsbG8=" },
    ...overrides,
  };
}

describe("the closed component vocabulary", () => {
  test("every kind and every tone is exactly the published set", () => {
    // Closed on purpose (ADR 0016 §3, R2): each kind has one renderer in the engine painting
    // one CSS family the engine owns. A kind added here is a renderer added there.
    expect([...UI_NODE_TYPES]).toEqual([
      "box",
      "heading",
      "text",
      "code",
      "badge",
      "divider",
      "spinner",
      "button",
      "select",
      "input",
      "toggle",
      "list",
      "empty",
    ]);
    expect([...UI_TONES]).toEqual(["neutral", "accent", "muted", "danger", "success"]);
  });

  test("a kind the host does not know is refused, never rendered as unknown", () => {
    // The whole point of a closed vocabulary: `iframe`, `html`, `script` are not "unknown
    // components" a renderer falls back on, they are the DOM reaching in, and the schema is
    // where that stops.
    for (const type of ["iframe", "html", "script", "div", ""]) {
      expect(UiNodeSchema.safeParse({ type, text: "x" }).success).toBe(false);
    }
    expect(
      UiNodeSchema.safeParse({
        type: "box",
        children: [{ type: "text", text: "a" }, { type: "raw", html: "<b>" }],
      }).success,
    ).toBe(false);
  });

  test("every node is strict: a stray key is a refusal, not a hint the renderer ignores", () => {
    // `style`, `className`, `onClick` are exactly the keys a plugin would reach for if the
    // vocabulary were a DOM in disguise. Strictness is what makes it not one.
    expect(UiNodeSchema.safeParse({ type: "divider", style: "color:red" }).success).toBe(false);
    expect(UiNodeSchema.safeParse({ type: "text", text: "a", className: "x" }).success).toBe(
      false,
    );
    expect(
      UiNodeSchema.safeParse({ type: "button", label: "Go", event: "go", onClick: "alert(1)" })
        .success,
    ).toBe(false);
  });

  test("a tree is bounded in depth and in size, and refused past either rather than clipped", () => {
    expect(UiNodeSchema.safeParse(nested(MAX_UI_DEPTH)).success).toBe(true);
    const tooDeep = UiNodeSchema.safeParse(nested(MAX_UI_DEPTH + 1));
    expect(tooDeep.success).toBe(false);
    expect(tooDeep.error?.issues[0]?.message).toContain(`deeper than ${String(MAX_UI_DEPTH)}`);

    const leaves = (count: number): UiNode[] =>
      Array.from({ length: count }, (): UiNode => ({ type: "divider" }));
    // The root box is itself a node, so a full tree is the root plus MAX - 1 leaves.
    expect(UiNodeSchema.safeParse(box(leaves(MAX_UI_NODES - 1))).success).toBe(true);
    const tooMany = UiNodeSchema.safeParse(box(leaves(MAX_UI_NODES)));
    expect(tooMany.success).toBe(false);
    expect(tooMany.error?.issues[0]?.message).toContain(`more than ${String(MAX_UI_NODES)}`);
  });

  test("a button names the door it opens, so a stranger's affordance carries data-action too", () => {
    // Invariant 12 / S4: every mutating affordance names its action. `action` is the FULL
    // name; the renderer paints it verbatim as `data-action`.
    const parsed = UiNodeSchema.parse({
      type: "button",
      label: "Kill",
      event: "kill",
      payload: { id: "t1" },
      tone: "danger",
      action: "core.terminals.kill",
    });
    expect(parsed).toMatchObject({ type: "button", action: "core.terminals.kill" });
    expect(UiNodeSchema.safeParse({ type: "button", label: "Go", event: "go", tone: "red" }).success).toBe(
      false,
    );
  });

  test("a callback travels back as data naming an event, never as a DOM event", () => {
    expect(UiEventSchema.parse({ instance: "i1", event: "kill", payload: { id: "t1" } })).toEqual({
      instance: "i1",
      event: "kill",
      payload: { id: "t1" },
    });
    expect(UiEventSchema.safeParse({ instance: "i1", event: "" }).success).toBe(false);
    expect(UiEventSchema.safeParse({ instance: "i1", event: "kill", target: {} }).success).toBe(
      false,
    );
  });
});

describe("the served ctx slices and host methods", () => {
  test("the ctx methods a child may call are exactly the stage-1 set", () => {
    // Everything else in `ActionCtx` is NOT served (ADR 0016 §2): the guest maps the absence
    // to a named `refused`, so the list is the contract an out-of-tree author writes against.
    expect([...ISOLATE_CTX_METHODS]).toEqual([
      "storage.get",
      "storage.set",
      "storage.delete",
      "storage.keys",
      "auth.allows",
      "outsideScope",
      "newId",
      "machines.isOnline",
      "placement.place",
      "host.roster",
      "host.enabled",
    ]);
    expect(
      IsolateChildFrameSchema.safeParse({ t: "call", id: "1", method: "rooms.list", args: [] })
        .success,
    ).toBe(false);
  });

  test("the host methods a worker may call mirror SessionHandle's, and the token is never one", () => {
    // ADR 0016 §3: the worker calls the door THROUGH the host, which attaches the caller's
    // authority. There is no `token` method because there is no token to hand over.
    expect([...WEB_HOST_METHODS]).toEqual([
      "action",
      "place",
      "selfCaps",
      "machines",
      "resolve",
      "navigate",
      "openTerminal",
      "sendTerminalInput",
      "terminalsByContainer",
    ]);
    expect(
      WebIsolateWorkerFrameSchema.safeParse({ t: "call", id: "1", method: "token", args: [] })
        .success,
    ).toBe(false);
  });
});

describe("the isolate frames", () => {
  test("a reply is exactly one of two shapes, on both boundaries", () => {
    // `ok: true` carries a result and nothing else; `ok: false` carries an error sentence and
    // nothing else. A frame that carries both is a guest that cannot be believed either way.
    for (const schema of [IsolateHostFrameSchema, WebIsolateHostFrameSchema]) {
      expect(schema.safeParse({ t: "reply", id: "1", ok: true, result: null }).success).toBe(true);
      expect(schema.safeParse({ t: "reply", id: "1", ok: false, error: "gone" }).success).toBe(true);
      expect(schema.safeParse({ t: "reply", id: "1", ok: true, error: "gone" }).success).toBe(
        false,
      );
      expect(schema.safeParse({ t: "reply", id: "1", ok: false, result: null }).success).toBe(
        false,
      );
    }
  });

  test("a child answers only the two rungs it can grade", () => {
    // `forbidden` is the host's: a child never saw the grants, so it must not be able to
    // claim it consulted them (ADR 0016 §5, the intersection happens at the door).
    const dispatched = (outcome: unknown): boolean =>
      IsolateChildFrameSchema.safeParse({ t: "dispatched", id: "1", outcome }).success;
    expect(dispatched({ ok: true, result: {}, emits: [] })).toBe(true);
    expect(dispatched({ ok: false, rule: "invalid_args", message: "name: expected string" })).toBe(
      true,
    );
    expect(dispatched({ ok: false, rule: "refused", message: "throttled" })).toBe(true);
    expect(dispatched({ ok: false, rule: "forbidden", message: "no" })).toBe(false);
    expect(dispatched({ ok: false, rule: "unavailable", message: "no" })).toBe(false);
  });

  test("a hung or crashed isolate is a traced refusal, never a stuck promise", () => {
    // ADR 0016 §6: the deadline expiring is a rung (`unavailable`), the LAST one, and the
    // ledger can say it like every rung but `unknown_action`.
    expect(TRACED_DENIAL_RULES).toContain("unavailable");
    expect([...TRACE_OUTCOMES]).toContain("unavailable");
    expect(ISOLATE_DISPATCH_DEADLINE_MS).toBe(10_000);
    expect(ISOLATE_CRASH_BUDGET).toEqual({ count: 3, windowMs: 300_000 });
    expect(ISOLATE_IDLE_EVICT_MS).toBe(600_000);
  });
});

describe("the install artifact", () => {
  test("format 1 is the only format this engine reads", () => {
    expect(PluginBundleSchema.safeParse(bundle()).success).toBe(true);
    for (const format of [0, 2, "1", undefined]) {
      expect(PluginBundleSchema.safeParse({ ...bundle(), format }).success).toBe(false);
    }
  });

  test("members are base64 of the file's bytes, under a flat name that cannot climb", () => {
    // The files are extracted beside the artifact (invariant 6): a name with a slash or a
    // leading dot is a path, not a member, and is refused before any extractor sees it.
    expect(PluginBundleSchema.safeParse(bundle({ files: { "server.js": "not base64!", "web.js": "aGk=" } })).success).toBe(false);
    for (const name of ["../server.js", "lib/server.js", ".env", "server.js/"]) {
      const files = { "server.js": "aGk=", "web.js": "aGk=", [name]: "aGk=" };
      expect(PluginBundleSchema.safeParse(bundle({ files })).success).toBe(false);
    }
    expect(ISOLATE_MAX_ARTIFACT_BYTES).toBe(16 * 1024 * 1024);
  });

  test("every half `entry` names must be a member, and it must name at least one", () => {
    // `entry.server: true` means `files["server.js"]`; `entry.web` is the member's key. A
    // bundle whose entry points at nothing would be discovered at enable time, in a child
    // process, as a stranger's crash — so it is refused here, naming the half.
    const manifest = bundle().manifest;
    const missingWeb = PluginBundleSchema.safeParse(bundle({ files: { "server.js": "aGk=" } }));
    expect(missingWeb.success).toBe(false);
    expect(missingWeb.error?.issues[0]?.path).toEqual(["manifest", "entry", "web"]);

    const missingServer = PluginBundleSchema.safeParse(bundle({ files: { "web.js": "aGk=" } }));
    expect(missingServer.success).toBe(false);
    expect(missingServer.error?.issues[0]?.path).toEqual(["manifest", "entry", "server"]);

    const nothing = PluginBundleSchema.safeParse(bundle({ manifest: { ...manifest, entry: {} } }));
    expect(nothing.success).toBe(false);
    expect(nothing.error?.issues[0]?.path).toEqual(["manifest", "entry"]);

    // The manifest schema leaves `entry` optional; the bundle does not.
    const { entry: _entry, ...withoutEntry } = manifest;
    expect(PluginBundleSchema.safeParse(bundle({ manifest: withoutEntry as never })).success).toBe(false);

    // Either half alone is a plugin.
    expect(
      PluginBundleSchema.safeParse(
        bundle({ manifest: { ...manifest, entry: { web: "web.js" } }, files: { "web.js": "aGk=" } }),
      ).success,
    ).toBe(true);
    expect(
      PluginBundleSchema.safeParse(
        bundle({ manifest: { ...manifest, entry: { server: true } }, files: { "server.js": "aGk=" } }),
      ).success,
    ).toBe(true);
  });
});

describe("an installed row", () => {
  const entry: PluginRosterEntry = {
    manifest: bundle().manifest,
    enabled: true,
    source: "plugin",
    actions: [],
  };
  const install: PluginInstall = {
    sha256: "a".repeat(64),
    source: "https://example.test/vendor.thing.manifold-plugin.json",
    grantedCaps: ["containers:read"],
    installedBy: "principal-1",
    installedAt: 1_700_000_000_000,
  };

  test("`install` is present iff installed, and it is what the installer consented to", () => {
    // ADR 0016 §5: the grant is data on the roster, so an agent sees exactly what a human
    // sees; §1: presence of the block is what selects the runner, so `source` stays two-valued.
    expect(PluginRosterEntrySchema.parse(entry).install).toBeUndefined();
    expect(PluginRosterEntrySchema.parse({ ...entry, install }).install).toEqual(install);
    expect(PluginRosterEntrySchema.safeParse({ ...entry, source: "installed" }).success).toBe(false);
    // The hash is a hex digest or it is nothing; a grant is drawn from the cap vocabulary.
    expect(PluginRosterEntrySchema.safeParse({ ...entry, install: { ...install, sha256: "abc" } }).success).toBe(false);
    expect(
      PluginRosterEntrySchema.safeParse({ ...entry, install: { ...install, grantedCaps: ["files:write"] } }).success,
    ).toBe(false);
  });

  test("the install refusals are a closed class list, and the row can carry one", () => {
    expect([...PLUGIN_INSTALL_REFUSALS]).toEqual([
      "artifact_unreadable",
      "artifact_invalid",
      "hash_mismatch",
      "already_installed",
      "not_installed",
      "namespace_reserved",
      "still_enabled",
      "no_entry",
    ]);
    // A bundle that stopped hashing to its pin is fail-closed (R8): `hash_mismatch` on the
    // install block, `enable_failed` on the row, never loaded.
    const tampered = PluginRosterEntrySchema.parse({
      ...entry,
      enabled: true,
      lifecycle: "enable_failed",
      install: { ...install, refusal: "hash_mismatch" },
    });
    expect(tampered.install?.refusal).toBe("hash_mismatch");
    expect(
      PluginRosterEntrySchema.safeParse({ ...entry, install: { ...install, refusal: "because" } })
        .success,
    ).toBe(false);
  });
});

describe("the published isolation contract", () => {
  test("an out-of-tree author reads the whole target from GET /api/protocol", () => {
    // Issue #151: the closed component vocabulary ships as data. The frame pairs ride beside
    // it, as the instance channel's do, so the kit's guest runtimes are written against a
    // document rather than this tree.
    const contract = buildProtocolJsonSchema()["isolateContract"] as Record<string, unknown>;
    expect(contract["uiNodeTypes"]).toEqual(UI_NODE_TYPES);
    expect(contract["ctxMethods"]).toEqual(ISOLATE_CTX_METHODS);
    expect(contract["hostMethods"]).toEqual(WEB_HOST_METHODS);
    expect(contract["crashBudget"]).toEqual(ISOLATE_CRASH_BUDGET);
    for (const key of ["uiNode", "bundle", "serverHost", "serverChild", "webHost", "webWorker"]) {
      expect(contract[key]).toBeDefined();
    }
  });
});
