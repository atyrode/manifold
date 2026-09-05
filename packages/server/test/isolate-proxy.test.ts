import { describe, expect, test } from "bun:test";
import type { LifecycleCtx, PluginStorage } from "@manifold/plugin";
import type { IsolateChildFrame, PluginManifest } from "@manifold/protocol";
import { z } from "zod";
import { IsolateDenial, IsolateLoadError } from "../src/isolate/contract.ts";
import {
  buildIsolateDef,
  serveCtxCall,
  type IsolateDispatchOutcome,
  type IsolateTransport,
} from "../src/isolate/proxy-def.ts";
import type { ActionCtx } from "../src/plugin-host.ts";
import { FakeRuntime, testStore } from "./helpers.ts";

/*
  The proxies against a SCRIPTED transport: what a handler the host assembles does with each
  verdict the child can give, and what a child's `call` reaches. The process boundary itself
  is `isolate-supervisor.test.ts`'s subject.
 */

const manifest: PluginManifest = {
  id: "test.proxy",
  version: "1.0.0",
  title: "Proxy",
  description: "",
  capabilities: [],
  contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
};

type Loaded = Extract<IsolateChildFrame, { t: "loaded" }>;

const inputSchema = {
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
};

function loaded(names: readonly string[], hooks: Partial<Loaded["hooks"]> = {}): Loaded {
  return {
    t: "loaded",
    actions: names.map((name) => ({
      name,
      title: name,
      caps: [],
      scope: "workspace",
      input: inputSchema,
      result: {},
    })),
    hooks: { onEnable: false, onDisable: false, onAssemblyChanged: false, ...hooks },
  };
}

const principal = { id: "p1", kind: "agent" as const, name: "Bot", color: "#abcdef" };

function scripted(outcome: IsolateDispatchOutcome): IsolateTransport & {
  readonly dispatches: { action: string; args: unknown }[];
  readonly hooks: { hook: string; delta: unknown }[];
} {
  const dispatches: { action: string; args: unknown }[] = [];
  const hooks: { hook: string; delta: unknown }[] = [];
  return {
    dispatches,
    hooks,
    dispatch: async (action, args) => {
      dispatches.push({ action, args });
      return outcome;
    },
    hook: async (hook, _ctx, delta) => {
      hooks.push({ hook, delta });
    },
  };
}

function ctxWith(
  storage: PluginStorage,
  runtime: FakeRuntime,
): {
  readonly ctx: ActionCtx;
  readonly emitted: unknown[];
  readonly allowed: unknown[];
} {
  const emitted: unknown[] = [];
  const allowed: unknown[] = [];
  const slice: Pick<
    ActionCtx,
    | "principal"
    | "auth"
    | "containerScope"
    | "outsideScope"
    | "storage"
    | "now"
    | "newId"
    | "emit"
    | "machines"
  > = {
    principal,
    auth: {
      principal,
      caps: ["scenes:write"],
      containerScope: "c1",
      isRoot: false,
      allows: (cap, containerId) => {
        allowed.push([cap, containerId]);
        return cap === "scenes:write";
      },
    },
    containerScope: "c1",
    outsideScope: (containerId) => (containerId === "c1" ? null : { refused: "outside" }),
    storage,
    now: () => runtime.now(),
    newId: () => runtime.newId(),
    emit: (ref, kind, payload) => {
      emitted.push({ ref, kind, payload });
    },
    machines: {
      isOnline: (machineId) => machineId === "m-online",
      drain: () => Promise.resolve({ ok: false, reason: "fixture has no terminal owner" }),
    },
  };
  return { ctx: slice as ActionCtx, emitted, allowed };
}

describe("buildIsolateDef", () => {
  test("names are made local under the plugin's own namespace, or the load fails", () => {
    const transport = scripted({ ok: true, result: null, emits: [] });
    const { def } = buildIsolateDef(manifest, loaded(["test.proxy.echo"]), transport);
    expect(def.actions.map((action) => action.name)).toEqual(["echo"]);
    expect(() => buildIsolateDef(manifest, loaded(["other.plugin.echo"]), transport)).toThrow(
      IsolateLoadError,
    );
    expect(() => buildIsolateDef(manifest, loaded(["test.proxy.Not-Local"]), transport)).toThrow(
      IsolateLoadError,
    );
  });

  test("the roster publishes the child's own JSON Schema while the host grades nothing", () => {
    const { def } = buildIsolateDef(
      manifest,
      loaded(["test.proxy.echo"]),
      scripted({ ok: true, result: null, emits: [] }),
    );
    const input = def.actions[0]?.input;
    if (input === undefined) throw new Error("no action");
    expect(input.safeParse({ anything: true }).success).toBe(true);
    expect(z.toJSONSchema(input, { io: "input" })).toMatchObject(inputSchema);
  });

  test("a handler returns the child's result after re-staging its emits through the host's ctx", async () => {
    const runtime = new FakeRuntime();
    const { ctx, emitted } = ctxWith(testStore().pluginStorage(manifest.id), runtime);
    const emit = {
      ref: { kind: "plugin" as const, pluginId: manifest.id },
      kind: "changed",
      payload: { n: 1 },
    };
    const transport = scripted({ ok: true, result: { done: true }, emits: [emit] });
    const { def } = buildIsolateDef(manifest, loaded(["test.proxy.echo"]), transport);

    await expect(def.handlers.echo?.(ctx, { text: "x" } as never)).resolves.toEqual({ done: true });
    expect(transport.dispatches).toEqual([{ action: "echo", args: { text: "x" } }]);
    expect(emitted).toEqual([emit]);
  });

  test("invalid_args is thrown as the denial; refused returns as data", async () => {
    const runtime = new FakeRuntime();
    const { ctx } = ctxWith(testStore().pluginStorage(manifest.id), runtime);
    const invalid = buildIsolateDef(
      manifest,
      loaded(["test.proxy.echo"]),
      scripted({ ok: false, rule: "invalid_args", message: "text required" }),
    );
    const failure = await invalid.def.handlers
      .echo?.(ctx, {} as never)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(IsolateDenial);
    expect((failure as IsolateDenial).rule).toBe("invalid_args");
    expect((failure as IsolateDenial).message).toBe("text required");

    const refused = buildIsolateDef(
      manifest,
      loaded(["test.proxy.echo"]),
      scripted({ ok: false, rule: "refused", message: "no" }),
    );
    await expect(refused.def.handlers.echo?.(ctx, {} as never)).resolves.toEqual({ refused: "no" });
  });

  test("only the hooks the child declared exist, and a delta rides its hook", async () => {
    const transport = scripted({ ok: true, result: null, emits: [] });
    const { def, lifecycle } = buildIsolateDef(
      manifest,
      loaded([], { onAssemblyChanged: true }),
      transport,
    );
    expect(def.lifecycle).toBe(lifecycle);
    expect(lifecycle.onEnable).toBeUndefined();
    expect(lifecycle.onDisable).toBeUndefined();
    const lifecycleCtx: LifecycleCtx = {
      pluginId: manifest.id,
      storage: testStore().pluginStorage(manifest.id),
      now: () => 0,
      emit: () => {},
    };
    await lifecycle.onAssemblyChanged?.(lifecycleCtx, { enabled: ["a.b"], disabled: [] });
    expect(transport.hooks).toEqual([
      { hook: "onAssemblyChanged", delta: { enabled: ["a.b"], disabled: [] } },
    ]);
  });
});

describe("serveCtxCall", () => {
  test("a dispatch serves every slice from the caller's own ctx", async () => {
    const runtime = new FakeRuntime();
    const storage = testStore().pluginStorage(manifest.id);
    const { ctx, allowed } = ctxWith(storage, runtime);
    const served = { kind: "dispatch" as const, ctx };

    await serveCtxCall("storage.set", ["k", "v"], served);
    expect(await serveCtxCall("storage.get", ["k"], served)).toBe("v");
    expect(await serveCtxCall("storage.keys", [], served)).toEqual(["k"]);
    expect(await serveCtxCall("auth.allows", ["scenes:write", "c1"], served)).toBe(true);
    expect(await serveCtxCall("auth.allows", ["containers:read"], served)).toBe(false);
    expect(allowed).toEqual([
      ["scenes:write", "c1"],
      ["containers:read", undefined],
    ]);
    expect(await serveCtxCall("outsideScope", ["c2"], served)).toEqual({ refused: "outside" });
    expect(await serveCtxCall("outsideScope", ["c1"], served)).toBeNull();
    expect(await serveCtxCall("outsideScope", [null], served)).toEqual({ refused: "outside" });
    expect(await serveCtxCall("newId", [], served)).toBe("id-1");
    expect(await serveCtxCall("machines.isOnline", ["m-online"], served)).toBe(true);
  });

  test("root's wildcard and a wrong argument shape are errors the child hears, never grants", async () => {
    const runtime = new FakeRuntime();
    const { ctx, allowed } = ctxWith(testStore().pluginStorage(manifest.id), runtime);
    const served = { kind: "dispatch" as const, ctx };

    await expect(serveCtxCall("auth.allows", ["*"], served)).rejects.toThrow(
      'auth.allows: argument 0 must be a capability other than "*"',
    );
    await expect(serveCtxCall("storage.get", [7], served)).rejects.toThrow(
      "storage.get: argument 0 must be a string",
    );
    await expect(serveCtxCall("placement.place", [{ nonsense: true }], served)).rejects.toThrow(
      "placement.place: argument 0 is not a placement request",
    );
    expect(allowed).toEqual([]);
  });

  test("a hook serves storage and nothing else", async () => {
    const storage = testStore().pluginStorage(manifest.id);
    const served = {
      kind: "hook" as const,
      ctx: { pluginId: manifest.id, storage, now: () => 0, emit: () => {} },
    };
    await serveCtxCall("storage.set", ["seen", "1"], served);
    expect(await serveCtxCall("storage.get", ["seen"], served)).toBe("1");
    await expect(serveCtxCall("newId", [], served)).rejects.toThrow("slice_unavailable: newId");
    await expect(serveCtxCall("host.roster", [], served)).rejects.toThrow(
      "slice_unavailable: host.roster",
    );
  });
});
