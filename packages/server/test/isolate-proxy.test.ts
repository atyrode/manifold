import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobSettledCtx, LifecycleCtx, PluginStorage } from "@manifold/plugin";
import { PluginDatabaseError } from "@manifold/plugin-kit";
import { attachServerGuest } from "@manifold/plugin-kit/server";
import { openPluginDatabase } from "../src/plugin-database.ts";
import type { IsolateChildFrame, PluginManifest, SettledJob } from "@manifold/protocol";
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
    hooks: {
      onEnable: false,
      onDisable: false,
      onAssemblyChanged: false,
      onJobSettled: false,
      ...hooks,
    },
  };
}

const principal = { id: "p1", kind: "agent" as const, name: "Bot", color: "#abcdef" };

function scripted(outcome: IsolateDispatchOutcome): IsolateTransport & {
  readonly dispatches: { action: string; args: unknown }[];
  readonly hooks: { hook: string; payload: unknown }[];
} {
  const dispatches: { action: string; args: unknown }[] = [];
  const hooks: { hook: string; payload: unknown }[] = [];
  return {
    dispatches,
    hooks,
    dispatch: async (action, args) => {
      dispatches.push({ action, args });
      return outcome;
    },
    hook: async (hook, _ctx, delta) => {
      hooks.push({ hook, payload: delta });
    },
    settled: async (_ctx, job) => {
      hooks.push({ hook: "onJobSettled", payload: job });
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
      allows: (cap, ref) => {
        allowed.push([cap, ref]);
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
      getTerminalExecution: () => null,
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

  test("only the hooks the child declared exist, and a delta or a settled job rides its hook", async () => {
    const transport = scripted({ ok: true, result: null, emits: [] });
    const { def, lifecycle } = buildIsolateDef(
      manifest,
      loaded([], { onAssemblyChanged: true, onJobSettled: true }),
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
    const job: SettledJob = {
      jobId: "j1",
      machineId: "m1",
      operationId: "a.b.run",
      pluginId: manifest.id,
      state: "exited",
      exitCode: 0,
      reason: null,
      finishedAt: 4,
      outputs: [{ outputId: "o1", name: "report", sha256: "c".repeat(64), bytes: 12, files: 1 }],
    };
    await lifecycle.onAssemblyChanged?.(lifecycleCtx, { enabled: ["a.b"], disabled: [] });
    await lifecycle.onJobSettled?.(
      { ...lifecycleCtx, jobs: {} as JobSettledCtx["jobs"] },
      job,
    );
    expect(transport.hooks).toEqual([
      { hook: "onAssemblyChanged", payload: { enabled: ["a.b"], disabled: [] } },
      { hook: "onJobSettled", payload: job },
    ]);
  });
});

describe("serveCtxCall", () => {
  test("the guest runtime commits through native storage and distinguishes a stale comparison", async () => {
    const store = testStore();
    try {
      const storage = store.pluginStorage(manifest.id);
      const served = {
        kind: "hook" as const,
        ctx: { pluginId: manifest.id, storage, now: () => 0, emit: () => {} },
      };
      let receive: (frame: unknown) => void = () => {};
      const completed = Promise.withResolvers<Extract<IsolateChildFrame, { t: "hooked" }>>();
      attachServerGuest(
        {
          manifest,
          actions: [],
          handlers: {},
          lifecycle: {
            async onEnable(ctx) {
              if (!(await ctx.storage.compareAndSet("choice", null, "first"))) {
                throw new Error("could not create absent choice");
              }
              if (!(await ctx.storage.compareAndSet("choice", "first", "updated"))) {
                throw new Error("could not replace matching choice");
              }
              if (await ctx.storage.compareAndSet("choice", "first", "lost-update")) {
                throw new Error("stale choice overwrote committed value");
              }
            },
          },
        },
        {
          onMessage: (listener) => {
            receive = listener;
          },
          send: (frame) => {
            if (frame.t === "call") {
              void serveCtxCall(frame.method, frame.args, served).then(
                (result) => receive({ t: "reply", id: frame.id, ok: true, result }),
                (error: unknown) =>
                  receive({
                    t: "reply",
                    id: frame.id,
                    ok: false,
                    error: error instanceof Error ? error.message : String(error),
                  }),
              );
            } else if (frame.t === "hooked") {
              completed.resolve(frame);
            }
          },
          warn: () => {},
          exit: () => {},
        },
      );
      receive({ t: "load", pluginId: manifest.id, manifest, dir: "/unused" });
      receive({ t: "hook", id: "commit", hook: "onEnable" });
      expect(await completed.promise).toMatchObject({ ok: true });
      expect(await storage.get("choice")).toBe("updated");
    } finally {
      store.close();
    }
  });

  test("compare-and-set enforces namespace and operand validation for dispatches and hooks", async () => {
    const store = testStore();
    try {
      const storage = store.pluginStorage(manifest.id);
      const other = store.pluginStorage("other.plugin");
      await other.set("choice", "private");
      const { ctx } = ctxWith(storage, new FakeRuntime());
      const dispatch = { kind: "dispatch" as const, ctx };
      const hook = {
        kind: "hook" as const,
        ctx: { pluginId: manifest.id, storage, now: () => 0, emit: () => {} },
      };
      expect(
        await serveCtxCall("storage.compareAndSet", ["choice", "private", "stolen"], dispatch),
      ).toBe(false);
      expect(await serveCtxCall("storage.compareAndSet", ["choice", null, "mine"], hook)).toBe(
        true,
      );
      expect(
        await serveCtxCall("storage.compareAndSet", ["choice", "mine", "updated"], dispatch),
      ).toBe(true);
      expect(await serveCtxCall("storage.compareAndSet", ["choice", "mine", "stale"], hook)).toBe(
        false,
      );
      for (const args of [
        ["$version", null, "9.9"],
        ["bad key", null, "value"],
        ["choice", 7, "value"],
        ["choice", undefined, "value"],
        ["choice", null, 7],
        ["choice", "é".repeat(32 * 1024 + 1), "value"],
        ["choice", "stale", "é".repeat(32 * 1024 + 1)],
      ]) {
        await expect(serveCtxCall("storage.compareAndSet", args, dispatch)).rejects.toThrow();
      }
      expect(await storage.get("choice")).toBe("updated");
      expect(await storage.dataVersion()).toBeNull();
      expect(await other.get("choice")).toBe("private");
    } finally {
      store.close();
    }
  });

  test("a dispatch serves every slice from the caller's own ctx", async () => {
    const runtime = new FakeRuntime();
    const storage = testStore().pluginStorage(manifest.id);
    const { ctx, allowed } = ctxWith(storage, runtime);
    const served = { kind: "dispatch" as const, ctx };

    await serveCtxCall("storage.set", ["k", "v"], served);
    expect(await serveCtxCall("storage.get", ["k"], served)).toBe("v");
    expect(await serveCtxCall("storage.keys", [], served)).toEqual(["k"]);
    expect(
      await serveCtxCall(
        "auth.allows",
        ["scenes:write", { kind: "container", containerId: "c1" }],
        served,
      ),
    ).toBe(true);
    expect(await serveCtxCall("auth.allows", ["containers:read"], served)).toBe(false);
    expect(allowed).toEqual([
      ["scenes:write", { kind: "container", containerId: "c1" }],
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
    await expect(serveCtxCall("auth.allows", ["scenes:write", "c1"], served)).rejects.toThrow();
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
    for (const method of [
      "jobs.describe",
      "services.describe",
      "services.readConfiguration",
      "services.configureConfiguration",
      "services.read",
      "services.invoke",
    ] as const) {
      await expect(serveCtxCall(method, [{ machineId: "machine" }], served)).rejects.toThrow(
        "slice_unavailable",
      );
    }
  });

  test("the three database verbs round-trip, and a refusal arrives as PluginDatabaseError", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "manifold-proxy-db-"));
    const database = openPluginDatabase({ dataDir, pluginId: manifest.id });
    const storage = testStore().pluginStorage(manifest.id);
    /*
      The whole conversation in one process: the guest's `ctx.database` posts `call` frames, a
      scripted host answers each from `serveCtxCall` against the engine's real file, and what
      the plugin sees is the same three verbs an in-realm handler sees (ADR 0016 §4 — one
      contract). The hook slice is served too, because a hook orders its own durable state.
     */
    const served = {
      kind: "hook" as const,
      ctx: { pluginId: manifest.id, storage, database, now: () => 0, emit: () => {} },
    };
    const seen: unknown[] = [];
    let receive: (frame: unknown) => void = () => {};
    const completed = Promise.withResolvers<Extract<IsolateChildFrame, { t: "hooked" }>>();
    attachServerGuest(
      {
        manifest: { ...manifest, database: { maxBytes: 4 * 1024 * 1024 } },
        actions: [],
        handlers: {},
        lifecycle: {
          async onEnable(ctx) {
            const db = ctx.database;
            if (db === undefined) throw new Error("a declaring plugin got no database");
            await db.run("CREATE TABLE records(id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
            const written = await db.run("INSERT INTO records(body) VALUES (?)", ["first"]);
            seen.push(written.changes);
            seen.push(await db.query("SELECT body FROM records"));
            // A batch is the transaction: the second statement violates NOT NULL, so the
            // first must not survive it — the rollback is what the plugin is promised.
            await db
              .batch([
                { sql: "INSERT INTO records(body) VALUES (?)", params: ["second"] },
                { sql: "INSERT INTO records(body) VALUES (NULL)" },
              ])
              .then(
                () => seen.push("committed"),
                (error: unknown) => {
                  seen.push(error instanceof PluginDatabaseError ? error.name : String(error));
                },
              );
            seen.push(await db.query("SELECT body FROM records"));
          },
        },
      },
      {
        onMessage: (listener) => {
          receive = listener;
        },
        send: (frame) => {
          if (frame.t === "call") {
            void serveCtxCall(frame.method, frame.args, served).then(
              (result) => receive({ t: "reply", id: frame.id, ok: true, result }),
              (error: unknown) =>
                receive({
                  t: "reply",
                  id: frame.id,
                  ok: false,
                  error: error instanceof Error ? error.message : String(error),
                }),
            );
          } else if (frame.t === "hooked") {
            completed.resolve(frame);
          }
        },
        warn: () => {},
        exit: () => {},
      },
    );
    try {
      receive({ t: "load", pluginId: manifest.id, manifest, dir: "/unused" });
      receive({ t: "hook", id: "rows", hook: "onEnable" });
      expect(await completed.promise).toMatchObject({ ok: true });
      expect(seen).toEqual([1, [{ body: "first" }], "PluginDatabaseError", [{ body: "first" }]]);
    } finally {
      database.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("a plugin that declared no database has no slice on either side of the boundary", async () => {
    const storage = testStore().pluginStorage(manifest.id);
    const served = {
      kind: "hook" as const,
      ctx: { pluginId: manifest.id, storage, now: () => 0, emit: () => {} },
    };
    // The host's answer to a forged call frame: the word the guest runtime already uses for a
    // member it does not carry, so an absent slice is a named refusal rather than a TypeError.
    for (const method of ["database.query", "database.run", "database.batch"] as const) {
      await expect(serveCtxCall(method, ["SELECT 1"], served)).rejects.toThrow(
        `slice_unavailable: ${method}`,
      );
    }
  });
});
