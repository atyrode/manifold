import "../src/shared-modules.ts";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { packPlugin } from "@manifold/plugin-kit/pack";
import { defineAction, type PluginStorage } from "@manifold/plugin";
import { formatManifoldUri, type ActionOutcome, type PluginManifest } from "@manifold/protocol";
import { z } from "zod";
import { AuthService } from "../src/auth.ts";
import { IsolateSupervisor } from "../src/isolate/supervisor.ts";
import { silentLogger } from "../src/log.ts";
import { PLUGIN_UPLOADS_DIR } from "../src/plugin-installs.ts";
import { openPluginDatabase } from "../src/plugin-database.ts";
import type { ActionCtx, ServerPluginDef } from "../src/plugin-host.ts";
import { RoomManager } from "../src/room.ts";
import { SessionChannel } from "../src/session-channel.ts";
import { TerminalBroker } from "../src/terminal-broker.ts";
import {
  FakeClock,
  FakeRuntime,
  FakeSocket,
  testPluginHost,
  testStore,
  testTileTrees,
} from "./helpers.ts";

const OWNER_KEY = "f".repeat(64);
const PLUGIN_ID = "test.action-fence";
const manifest: PluginManifest = {
  id: PLUGIN_ID,
  version: "1.0.0",
  title: "Action fence",
  description: "",
  capabilities: ["machines:mint", "machines:read", "containers:read", "tokens:mint"],
  dataVersion: { major: 1, minor: 0 },
  purges: ["storage"],
  database: {},
  entry: { server: true },
  contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
};

async function fixture(hardened: boolean, dispatchDeadlineMs?: number) {
  const dataDir = mkdtempSync(join(tmpdir(), "manifold-action-fence-"));
  mkdirSync(join(dataDir, PLUGIN_UPLOADS_DIR), { recursive: true });
  const runtime = new FakeRuntime();
  const clock = new FakeClock(runtime);
  const store = testStore();
  const auth = new AuthService(store, OWNER_KEY, runtime);
  const owner = auth.authenticate(OWNER_KEY);
  const rooms = new RoomManager(store, runtime, clock, silentLogger, testTileTrees);
  const broker = new TerminalBroker(
    store,
    auth,
    rooms,
    runtime,
    clock,
    silentLogger,
    () => "http://localhost:7777",
    testTileTrees,
  );
  const runner = new IsolateSupervisor({
    logger: silentLogger,
    runtime,
    ...(dispatchDeadlineMs === undefined ? {} : { dispatchDeadlineMs }),
  });
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const storage = store.pluginStorage(PLUGIN_ID);
  const pluginStorage = store.pluginStorage.bind(store);
  let armed = true;
  store.pluginStorage = (id) => {
    const slice = pluginStorage(id);
    return {
      ...slice,
      get: async (key) => {
        const value = await slice.get(key);
        if (id === PLUGIN_ID && key === "value" && armed) {
          armed = false;
          entered.resolve();
          await resume.promise;
        }
        return value;
      },
    };
  };
  const host = await testPluginHost(store, auth, rooms, broker, runtime, {
    isolates: { runner, dataDir },
  });
  const authorDir = join(dataDir, "author");
  mkdirSync(authorDir);
  async function bundle(version: string) {
    const declaration = { ...manifest, version };
    writeFileSync(join(authorDir, "manifest.json"), JSON.stringify(declaration));
    writeFileSync(
      join(authorDir, "server.ts"),
      `
    import { z } from ${JSON.stringify(fileURLToPath(import.meta.resolve("zod")))};
    import { defineServerAction, defineServerPlugin } from ${JSON.stringify(fileURLToPath(import.meta.resolve("@manifold/plugin-kit/server")))};
    const def = {
      manifest: ${JSON.stringify(declaration)},
      actions: [
        defineServerAction({ name: "seed", title: "Seed", caps: ["machines:mint"],
          input: z.strictObject({}), result: z.strictObject({}) }),
        defineServerAction({ name: "mutate", title: "Mutate", caps: ["machines:mint", "tokens:mint"],
          input: z.strictObject({}), result: z.unknown() }),
        defineServerAction({ name: "targeted", title: "Targeted", caps: ["machines:read"],
          requirements: [{ cap: "machines:read", target: ["target"] }],
          input: z.strictObject({ target: z.strictObject({ kind: z.literal("machine"), machineId: z.string() }) }),
          result: z.unknown() }),
        defineServerAction({ name: "probe", title: "Probe", caps: ["containers:read"],
          input: z.strictObject({}), result: z.strictObject({}) })
      ],
      handlers: {
        async seed(ctx) {
          await ctx.database.run("CREATE TABLE records(body TEXT NOT NULL)");
          await ctx.database.run("INSERT INTO records VALUES ('before')");
          await ctx.storage.set("value", "before");
          return {};
        },
        async mutate(ctx) {
          const before = await ctx.storage.get("value");
          const failures = [];
          for (const effect of [
            () => ctx.storage.set("value", "set"),
            () => ctx.storage.compareAndSet("value", before, "cas"),
            () => ctx.storage.delete("value"),
            () => ctx.database.run("INSERT INTO records VALUES ('run')"),
            () => ctx.database.batch([{ sql: "INSERT INTO records VALUES ('batch')" }]),
          ]) {
            try { await effect(); } catch (error) { failures.push(error.message); }
          }
          return failures.length ? { refused: failures.join("; ") } : { changed: true };
        },
        async targeted(ctx) {
          const before = await ctx.storage.get("value");
          await ctx.storage.compareAndSet("value", before, "targeted");
          return { changed: true };
        },
        async probe() { return {}; }
      }
    };
    defineServerPlugin(def);
    export default def;
  `,
    );
    const source = join(dataDir, PLUGIN_UPLOADS_DIR, `fence-${version}.manifold-plugin.json`);
    const packed = await packPlugin(authorDir, source);
    return { source, sha256: packed.sha256, hardened };
  }
  const request = await bundle("1.0.0");
  expect(
    await host.install(
      { ...request, grant: ["tokens:mint"] },
      owner.principal.id,
      auth.credentialReference(owner),
    ),
  ).toMatchObject({
    id: PLUGIN_ID,
  });
  expect(await host.dispatch(owner, `${PLUGIN_ID}.seed`, {})).toEqual({ ok: true, result: {} });
  const token = auth.mintToken(
    {
      principal: { name: "fleet admin", kind: "human" },
      caps: ["machines:mint", "machines:read", "containers:read", "tokens:mint"],
    },
    owner,
  );
  const actor = auth.authenticate(token.token);
  async function records() {
    const database = openPluginDatabase({ dataDir, pluginId: PLUGIN_ID });
    try {
      return await database.query("SELECT body FROM records");
    } finally {
      database.close();
    }
  }
  return {
    store,
    auth,
    owner,
    actor,
    host,
    runtime,
    token,
    storage,
    entered,
    resume,
    request,
    bundle,
    records,
    async unchanged() {
      expect(await storage.get("value")).toBe("before");
      expect(await records()).toEqual([{ body: "before" }]);
    },
    async close() {
      resume.resolve();
      host.close();
      await runner.close();
      store.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

for (const hardened of [false, true]) {
  describe(`action durable authority (hardened: ${String(hardened)})`, () => {
    test.each([
      "cap withdrawn",
      "credential revoked",
      "credential expired",
      "disabled",
      "shutdown",
    ])("%s after an awaited read fences every next durable effect", async (withdrawal) => {
      const f = await fixture(hardened);
      const invocation = f.host.dispatch(f.actor, `${PLUGIN_ID}.mutate`, {});
      try {
        await f.entered.promise;
        switch (withdrawal) {
          case "cap withdrawn":
            f.auth.grant(
              {
                principal: { kind: "principal", id: f.actor.principal.id },
                node: "manifold://",
                caps: ["machines:mint"],
                effect: "deny",
                reach: "subtree",
              },
              f.owner,
            );
            break;
          case "credential revoked":
            f.auth.revokePrincipal(f.actor.principal.id, f.owner);
            break;
          case "credential expired":
            f.runtime.time = f.token.expiresAt!;
            break;
          case "disabled":
            expect(await f.host.setEnabled(PLUGIN_ID, false, f.owner.principal.id)).toEqual({
              ok: true,
            });
            break;
          case "shutdown":
            f.host.close();
            break;
        }
        f.resume.resolve();
        const outcome = await invocation.catch(() => null);
        expect(outcome?.ok ?? false).toBe(false);
        await f.unchanged();
      } finally {
        f.resume.resolve();
        await invocation.catch(() => {});
        await f.close();
      }
    });

    test("fixed target authority is re-evaluated without flattening it to a context cap", async () => {
      const f = await fixture(hardened);
      const machineId = f.auth.enrollMachine("target account", f.owner).machine.id;
      const invocation = f.host.dispatch(f.actor, `${PLUGIN_ID}.targeted`, {
        target: { kind: "machine", machineId },
      });
      try {
        await f.entered.promise;
        f.auth.grant(
          {
            principal: { kind: "principal", id: f.actor.principal.id },
            node: formatManifoldUri({ kind: "machine", machineId }),
            caps: ["machines:read"],
            effect: "deny",
            reach: "node",
          },
          f.owner,
        );
        expect(f.auth.allows(f.actor, "machines:read")).toBe(true);
        f.resume.resolve();
        expect((await invocation).ok).toBe(false);
        await f.unchanged();
      } finally {
        f.resume.resolve();
        await invocation.catch(() => {});
        await f.close();
      }
    });

    test("an unchanged installation drains admitted work before replacement retires its binding", async () => {
      const f = await fixture(hardened);
      let invocation: ReturnType<typeof f.host.dispatch> | undefined;
      let replacement: Promise<unknown> | undefined;
      try {
        const candidate = await f.bundle("2.0.0");
        invocation = f.host.dispatch(f.actor, `${PLUGIN_ID}.mutate`, {});
        await f.entered.promise;
        replacement = f.host.install(
          { ...candidate, replace: true, grant: ["containers:read"] },
          f.owner.principal.id,
          f.auth.credentialReference(f.owner),
        );
        const deadline = Date.now() + 3000;
        while (true) {
          const probe = await f.host.dispatch(f.owner, `${PLUGIN_ID}.probe`, {});
          if (!probe.ok && probe.denial.rule === "unavailable") break;
          if (Date.now() >= deadline) throw new Error("replacement did not begin draining");
          const tick = Promise.withResolvers<void>();
          setImmediate(tick.resolve);
          await tick.promise;
        }
        f.resume.resolve();
        expect(await invocation).toEqual({ ok: true, result: { changed: true } });
        expect(await replacement).toMatchObject({ id: PLUGIN_ID });
        expect(await f.storage.get("value")).toBeNull();
        expect(f.host.roster().find((row) => row.manifest.id === PLUGIN_ID)?.manifest.version).toBe(
          "2.0.0",
        );
        expect(await f.host.dispatch(f.actor, `${PLUGIN_ID}.mutate`, {})).toMatchObject({
          ok: false,
          denial: { rule: "forbidden" },
        });
        expect(await f.records()).toEqual([{ body: "before" }, { body: "run" }, { body: "batch" }]);
      } finally {
        f.resume.resolve();
        await invocation?.catch(() => {});
        await replacement?.catch(() => {});
        await f.close();
      }
    }, 30_000); // Two real packs each have a bounded ten-second registration inspector.
  });
}

test("a real isolate deadline retires data authority before the delayed read returns", async () => {
  // This exercises the supervisor's real process deadline/IPC retirement, not a simulated
  // timer callback; await its outcome rather than sleeping for a guessed duration.
  const f = await fixture(true, 1500);
  const invocation = f.host.dispatch(f.actor, `${PLUGIN_ID}.mutate`, {});
  try {
    await f.entered.promise;
    expect((await invocation).ok).toBe(false);
    f.resume.resolve();
    await f.unchanged();
  } finally {
    f.resume.resolve();
    await invocation.catch(() => {});
    await f.close();
  }
});

// An in-realm action definition and its handler record are the existing mutable registration
// seam. Changing either while the handler awaits must not leave the old admitted data live.
test.each(["parser", "handler", "before admission"])(
  "durable data respects the %s boundary",
  async (binding) => {
    const runtime = new FakeRuntime();
    const clock = new FakeClock(runtime);
    const store = testStore();
    const auth = new AuthService(store, OWNER_KEY, runtime);
    const owner = auth.authenticate(OWNER_KEY);
    const rooms = new RoomManager(store, runtime, clock, silentLogger, testTileTrees);
    const broker = new TerminalBroker(
      store,
      auth,
      rooms,
      runtime,
      clock,
      silentLogger,
      () => "http://localhost:7777",
      testTileTrees,
    );
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let retained: PluginStorage | undefined;
    const action = {
      ...defineAction({
        name: "write",
        title: "Write",
        caps: ["machines:mint"],
        input: z.strictObject({}),
        result: z.strictObject({}),
      }),
    };
    const handlers = {
      write: async (ctx: ActionCtx) => {
        retained = ctx.storage;
        if (binding === "before admission") {
          await ctx.storage.compareAndSet("value", null, "forbidden");
          ctx.admitPrepared!([]);
          return {};
        }
        await ctx.storage.get("value");
        entered.resolve();
        await resume.promise;
        await ctx.storage.compareAndSet("value", null, "forbidden");
        return {};
      },
    };
    const storageManifest: PluginManifest = { ...manifest };
    delete storageManifest.database;
    const def: ServerPluginDef = {
      manifest: { ...storageManifest, id: "test.action-binding" },
      ...(binding === "before admission" ? { inputValidation: "guest" as const } : {}),
      actions: [action],
      handlers,
    };
    const host = await testPluginHost(store, auth, rooms, broker, runtime, {
      settingsPlugins: [def],
    });
    const invocation = host.dispatch(owner, "test.action-binding.write", {});
    try {
      if (binding !== "before admission") {
        await entered.promise;
        if (binding === "parser") action.input = z.strictObject({});
        else handlers.write = async () => ({});
        resume.resolve();
      }
      expect(await invocation).toMatchObject({ ok: false, denial: { rule: "forbidden" } });
      expect(await store.pluginStorage("test.action-binding").get("value")).toBeNull();
      await expect(retained!.set("value", "late")).rejects.toThrow();
    } finally {
      resume.resolve();
      await invocation.catch(() => {});
      host.close();
      store.close();
    }
  },
);

test.each(["parser", "preparer"] as const)(
  "%s cannot spend a retained admitted context, including its later asynchronous descendants",
  async (phase) => {
    const dataDir = mkdtempSync(join(tmpdir(), "manifold-preparation-custody-"));
    const runtime = new FakeRuntime();
    const clock = new FakeClock(runtime);
    const store = testStore();
    const auth = new AuthService(store, OWNER_KEY, runtime);
    const owner = auth.authenticate(OWNER_KEY);
    const rooms = new RoomManager(store, runtime, clock, silentLogger, testTileTrees);
    const broker = new TerminalBroker(
      store,
      auth,
      rooms,
      runtime,
      clock,
      silentLogger,
      () => "http://localhost:7777",
      testTileTrees,
    );
    const runner = new IsolateSupervisor({ logger: silentLogger, runtime });
    const held = Promise.withResolvers<ActionCtx>();
    const finishHandler = Promise.withResolvers<void>();
    const preparing = Promise.withResolvers<void>();
    const finishPreparation = Promise.withResolvers<void>();
    const releaseDescendant = Promise.withResolvers<void>();
    let attempts: Promise<boolean[]> | undefined;
    let descendant: Promise<boolean> | undefined;
    let retained: ActionCtx;
    const denied = async (effect: () => unknown): Promise<boolean> => {
      try {
        await effect();
        return false;
      } catch {
        return true;
      }
    };
    const attemptEffects = () => {
      attempts = Promise.all([
        denied(() => retained.storage.set("forbidden-set", "changed")),
        denied(() => retained.storage.compareAndSet("forbidden-cas", null, "changed")),
        denied(() => retained.storage.delete("preserved")),
        denied(() => retained.database!.run("INSERT INTO records VALUES ('forbidden-run')")),
        denied(() =>
          retained.database!.batch([{ sql: "INSERT INTO records VALUES ('forbidden-batch')" }]),
        ),
        Promise.resolve(
          retained.identity.mintToken({
            principal: { kind: "human", name: "forbidden preparation" },
            caps: ["containers:read"],
          }),
        ).then((result) => !result.ok),
      ]);
      descendant = releaseDescendant.promise.then(() =>
        denied(() => retained.storage.set("forbidden-descendant", "changed")),
      );
    };
    const def: ServerPluginDef = {
      manifest: { ...manifest, id: "test.preparation-custody" },
      actions: [
        defineAction({
          name: "hold",
          title: "Hold",
          caps: ["machines:mint", "tokens:mint"],
          input: z.strictObject({}),
          result: z.strictObject({}),
        }),
        defineAction({
          name: "review",
          title: "Review",
          caps: ["containers:read"],
          input: z.preprocess((args) => {
            if (phase === "parser" && attempts === undefined) attemptEffects();
            return args;
          }, z.strictObject({})),
          result: z.strictObject({}),
        }),
      ],
      prepareActions: {
        review: {
          caps: [],
          prepare: async (_ctx, args) => {
            if (phase === "preparer") attemptEffects();
            await attempts;
            preparing.resolve();
            await finishPreparation.promise;
            return { args, targets: [] };
          },
        },
      },
      handlers: {
        hold: async (ctx: ActionCtx) => {
          await ctx.database!.run("CREATE TABLE records(body TEXT NOT NULL)");
          await ctx.database!.run("INSERT INTO records VALUES ('before')");
          await ctx.storage.set("preserved", "before");
          held.resolve(ctx);
          await finishHandler.promise;
          await ctx.storage.set("legitimate", "committed");
          return {};
        },
        review: async () => {
          throw new Error("review must not admit a handler");
        },
      },
    };
    const host = await testPluginHost(store, auth, rooms, broker, runtime, {
      settingsPlugins: [def],
      isolates: { runner, dataDir },
    });
    const holding = host.dispatch(owner, "test.preparation-custody.hold", {});
    let review: Promise<ActionOutcome> | undefined;
    try {
      retained = await held.promise;
      const credentials = auth.listCredentialsV2(owner);
      review = host.prepareActionInput(owner, "test.preparation-custody.review", {});
      await preparing.promise;
      // This continuation is outside preparation, while the preparer is still awaiting.
      await retained.storage.set("concurrent", "admitted");
      finishPreparation.resolve();
      expect((await review).ok).toBe(false);
      expect(await attempts).toEqual([true, true, true, true, true, true]);
      releaseDescendant.resolve();
      expect(await descendant).toBe(true);
      expect(auth.listCredentialsV2(owner)).toEqual(credentials);
      expect(await retained.storage.keys()).toEqual(["concurrent", "preserved"]);
      expect(await retained.storage.get("preserved")).toBe("before");
      expect(await retained.database!.query("SELECT body FROM records")).toEqual([
        { body: "before" },
      ]);
      finishHandler.resolve();
      expect(await holding).toEqual({ ok: true, result: {} });
      expect(await store.pluginStorage("test.preparation-custody").get("legitimate")).toBe(
        "committed",
      );
    } finally {
      finishPreparation.resolve();
      releaseDescendant.resolve();
      finishHandler.resolve();
      await review?.catch(() => {});
      await holding.catch(() => {});
      host.close();
      await runner.close();
      store.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  },
);

async function rawHostPreparationFixture(phase: "parser" | "preparer") {
  const runtime = new FakeRuntime();
  const clock = new FakeClock(runtime);
  const store = testStore();
  const auth = new AuthService(store, OWNER_KEY, runtime);
  const owner = auth.authenticate(OWNER_KEY);
  const rooms = new RoomManager(store, runtime, clock, silentLogger, testTileTrees);
  const broker = new TerminalBroker(
    store,
    auth,
    rooms,
    runtime,
    clock,
    silentLogger,
    () => "http://localhost:7777",
    testTileTrees,
  );
  for (const [id, discipline] of [
    ["canvas", "canvas"],
    ["composition", "composition"],
    ["cold-composition", "composition"],
  ] as const)
    store.createContainer({ id, name: id, createdAt: 0, discipline });
  const canvas = rooms.get("canvas")!;
  const composition = rooms.get("composition")!;
  rooms.flushAll();
  const socket = new FakeSocket();
  const peer = new SessionChannel(runtime.newId(), socket, owner, "canvas", "c1");
  canvas.join(peer);
  const held = Promise.withResolvers<ActionCtx>();
  const finishHandler = Promise.withResolvers<void>();
  let retained: ActionCtx;
  let attempt: () => void | Promise<void> = () => {};
  let attempted = false;
  let pending: void | Promise<void>;
  let handlerAdmissions = 0;
  let disabled = 0;
  const invokeAttempt = () => {
    if (attempted) return;
    attempted = true;
    pending = attempt();
  };
  const def: ServerPluginDef = {
    manifest: {
      id: "test.raw-preparation",
      version: "1.0.0",
      title: "Raw preparation",
      description: "",
      capabilities: ["containers:read"],
      contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
    },
    actions: [
      defineAction({
        name: "hold",
        title: "Hold",
        caps: ["containers:read"],
        input: z.strictObject({}),
        result: z.strictObject({}),
      }),
      defineAction({
        name: "review",
        title: "Review",
        caps: ["containers:read"],
        input: z.preprocess((args) => {
          if (phase === "parser") invokeAttempt();
          return args;
        }, z.strictObject({})),
        result: z.strictObject({}),
      }),
    ],
    prepareActions: {
      review: {
        caps: [],
        prepare: async (_ctx, args) => {
          if (phase === "preparer") invokeAttempt();
          await pending;
          return { args, targets: [] };
        },
      },
    },
    handlers: {
      hold: async (ctx) => {
        held.resolve(ctx);
        await finishHandler.promise;
        ctx.store.createContainer({
          id: "legitimate",
          name: "Admitted handler",
          createdAt: 0,
          discipline: "canvas",
        });
        return {};
      },
      review: async () => {
        handlerAdmissions++;
        return {};
      },
    },
  };
  const host = await testPluginHost(store, auth, rooms, broker, runtime, {
    settingsPlugins: [
      def,
      {
        manifest: { ...def.manifest, id: "test.raw-bystander" },
        actions: [],
        handlers: {},
        lifecycle: {
          onDisable: () => {
            disabled++;
          },
        },
      },
    ],
  });
  const holding = host.dispatch(owner, "test.raw-preparation.hold", {});
  retained = await held.promise;
  socket.clear();
  return {
    store,
    rooms,
    canvas,
    composition,
    peer,
    socket,
    host,
    owner,
    retained,
    holding,
    finishHandler,
    handlerAdmissions: () => handlerAdmissions,
    disabled: () => disabled,
    invoke(effect: () => void | Promise<void>, mode: "review" | "dispatch" = "review") {
      attempt = effect;
      attempted = false;
      pending = undefined;
      return mode === "review"
        ? host.prepareActionInput(owner, "test.raw-preparation.review", {})
        : host.dispatch(owner, "test.raw-preparation.review", {});
    },
    async close() {
      finishHandler.resolve();
      await holding.catch(() => {});
      host.close();
      rooms.drop("canvas");
      rooms.flushAll();
      store.close();
    },
  };
}

test.each(["parser", "preparer"] as const)(
  "%s refuses direct retained raw store writes before review or handler admission",
  async (phase) => {
    const f = await rawHostPreparationFixture(phase);
    try {
      for (const mode of ["review", "dispatch"] as const) {
        const result = await f.invoke(() => {
          f.retained.store.createContainer({
            id: `forbidden-${mode}`,
            name: "Forbidden",
            createdAt: 0,
            discipline: "canvas",
          });
        }, mode);
        expect(f.store.getContainer(`forbidden-${mode}`)).toBeNull();
        expect(result).toMatchObject({ ok: false, denial: { rule: "refused" } });
        expect(f.handlerAdmissions()).toBe(0);
      }
      f.finishHandler.resolve();
      expect(await f.holding).toEqual({ ok: true, result: {} });
      expect(f.store.getContainer("legitimate")?.name).toBe("Admitted handler");
    } finally {
      await f.close();
    }
  },
);

test.each(["parser", "preparer"] as const)(
  "%s cannot swallow retained raw host effects or lend them to asynchronous descendants",
  async (phase) => {
    const f = await rawHostPreparationFixture(phase);
    const preparing = Promise.withResolvers<void>();
    const releasePreparation = Promise.withResolvers<void>();
    const releaseDescendant = Promise.withResolvers<void>();
    let descendant: Promise<boolean[]> | undefined;
    let attempts: boolean[] = [];
    let committed = 0;
    const storage = f.retained.store.pluginStorage("test.raw-preparation");
    const canvasBefore = f.canvas.elements();
    const layoutBefore = f.composition.tileLayout();
    const eventsBefore = f.store.listEvents({ type: "container_created", limit: 100 });
    const denied = async (effect: () => unknown): Promise<boolean> => {
      try {
        await effect();
        return false;
      } catch {
        return true;
      }
    };
    const attemptEffects = (suffix: string) =>
      Promise.all([
        denied(() =>
          f.retained.store.createContainer({
            id: `forbidden-${suffix}`,
            name: "Forbidden",
            createdAt: 0,
            discipline: "canvas",
          }),
        ),
        denied(() =>
          f.retained.store.createGrant({
            id: `forbidden-${suffix}`,
            principal: { kind: "principal", id: f.owner.principal.id },
            node: "manifold://",
            caps: ["*"],
            effect: "allow",
            reach: "subtree",
            createdBy: f.owner.principal.id,
            createdAt: 0,
          }),
        ),
        denied(() => storage.set(`forbidden-${suffix}`, "changed")),
        denied(() => storage.compareAndSet(`cas-${suffix}`, null, "changed")),
        denied(() =>
          f.retained.store.addEvent("canvas", 0, null, "container_created", { suffix }),
        ),
        denied(() => f.retained.store.afterCommit(() => committed++)),
        denied(() => f.canvas.broadcast({ type: "saved", rev: 999, at: 0 })),
        denied(() => f.canvas.leave(f.peer)),
        denied(() => f.retained.rooms.get("canvas")!.placePortalElement("composition", 1, 2)),
        denied(() =>
          f.retained.rooms.get("composition")!.placeTile(
            { kind: "container", containerId: "canvas" },
            null,
            null,
          ),
        ),
        denied(() => f.retained.rooms.drop("canvas")),
        denied(() =>
          f.retained.placement.place({
            ref: { kind: "container", containerId: "composition" },
            destination: { kind: "canvas", containerId: "canvas", x: 3, y: 4 },
          }),
        ),
        denied(() => f.retained.placement.createHome(`home-${suffix}`, "terminal", "Forbidden")),
        denied(() =>
          f.retained.host.setEnabled("test.raw-bystander", false, f.owner.principal.id),
        ),
      ]);
    const review = f.invoke(async () => {
      attempts = await attemptEffects("direct");
      attempts.push(...(await Promise.resolve().then(() => attemptEffects("microtask"))));
      descendant = releaseDescendant.promise.then(() => attemptEffects("late"));
      preparing.resolve();
      await releasePreparation.promise;
    }, "dispatch");
    try {
      await preparing.promise;
      // A separately admitted continuation is not poisoned by somebody else's preparation.
      f.retained.store.createContainer({
        id: "independent",
        name: "Independent",
        createdAt: 0,
        discipline: "canvas",
      });
      releasePreparation.resolve();
      const outcome = await review;
      releaseDescendant.resolve();
      const later = await descendant!;
      for (const suffix of ["direct", "microtask", "late"]) {
        expect(f.store.getContainer(`forbidden-${suffix}`)).toBeNull();
        expect(f.store.getContainer(`home-${suffix}`)).toBeNull();
        expect(f.store.getGrant(`forbidden-${suffix}`)).toBeNull();
      }
      expect(await storage.keys()).toEqual([]);
      expect(f.store.listEvents({ type: "container_created", limit: 100 })).toEqual(eventsBefore);
      expect(committed).toBe(0);
      expect(f.rooms.live("canvas")).toBe(f.canvas);
      expect(f.canvas.elements()).toEqual(canvasBefore);
      expect(f.canvas.hasPrincipal(f.owner.principal.id)).toBe(true);
      expect(f.socket.messages()).toEqual([]);
      expect(f.socket.closed).toBeNull();
      expect(f.composition.tileLayout()).toEqual(layoutBefore);
      expect(f.host.enabled("test.raw-bystander")).toBe(true);
      expect(f.disabled()).toBe(0);
      expect(attempts).toEqual(Array(28).fill(true));
      expect(later).toEqual(Array(14).fill(true));
      expect(outcome).toMatchObject({ ok: false, denial: { rule: "refused" } });
      expect(f.handlerAdmissions()).toBe(0);
      expect(f.store.getContainer("independent")?.name).toBe("Independent");
      const swallowedReview = await f.invoke(async () => {
        expect(
          await denied(() => f.retained.store.renameContainer("canvas", "Forbidden rename")),
        ).toBe(true);
      });
      expect(swallowedReview).toMatchObject({ ok: false, denial: { rule: "refused" } });
      expect(f.store.getContainer("canvas")?.name).toBe("canvas");
      expect(f.handlerAdmissions()).toBe(0);
      f.finishHandler.resolve();
      expect(await f.holding).toEqual({ ok: true, result: {} });
      expect(f.store.getContainer("legitimate")?.name).toBe("Admitted handler");
    } finally {
      releasePreparation.resolve();
      releaseDescendant.resolve();
      await review.catch(() => {});
      await descendant;
      await f.close();
    }
  },
);

test.each(["parser", "preparer"] as const)(
  "%s can read retained raw host state and lazily load a room without effect admission",
  async (phase) => {
    const f = await rawHostPreparationFixture(phase);
    try {
      expect(f.rooms.live("cold-composition")).toBeNull();
      const outcome = await f.invoke(async () => {
        expect(f.retained.store.getContainer("cold-composition")?.discipline).toBe("composition");
        expect(f.retained.rooms.get("cold-composition")!.tileLayout()).toEqual(
          f.composition.tileLayout(),
        );
        expect(f.retained.rooms.censuses().find((row) => row.containerId === "canvas")?.items).toEqual(
          [],
        );
        expect(f.retained.host.roster().some((row) => row.manifest.id === "test.raw-bystander")).toBe(
          true,
        );
        expect(await f.retained.host.listInstalled()).toEqual({ plugins: [] });
      });
      expect(outcome.ok).toBe(true);
      expect(f.handlerAdmissions()).toBe(0);
      expect(f.store.latestDoc("cold-composition")).toBeNull();
      expect(await f.invoke(() => {}, "dispatch")).toEqual({ ok: true, result: {} });
      expect(f.handlerAdmissions()).toBe(1);
    } finally {
      await f.close();
    }
  },
);
