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
import { TerminalBroker } from "../src/terminal-broker.ts";
import { FakeClock, FakeRuntime, testPluginHost, testStore, testTileTrees } from "./helpers.ts";

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
