import { expect, test } from "bun:test";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatManifoldUri,
  JOB_OWNER_PROTOCOL_VERSION,
  type Cap,
  type PluginManifest,
} from "@manifold/protocol";
import {
  canonicalJobJson,
  type JobCommand,
  type JobOwner,
  type MachineHalf,
  type SettledJob,
} from "@manifold/protocol";
import { defineAction, type JobSettledCtx, type PluginStorage } from "@manifold/plugin";
import { z } from "zod";
import { AuthService, type AuthContext } from "../src/auth.ts";
import { JobService } from "../src/job-service.ts";
import { silentLogger, type Logger } from "../src/log.ts";
import type { PluginHost, ServerPluginDef } from "../src/plugin-host.ts";
import { RoomManager } from "../src/room.ts";
import { TerminalBroker } from "../src/terminal-broker.ts";
import type { ServerStore } from "../src/stores.ts";
import { FakeClock, FakeRuntime, testPluginHost, testStore, testTileTrees } from "./helpers.ts";

/**
 * `onJobSettled` — THE ONE WAKE A SERVER HALF HAS FOR ITS OWN FINISHED WORK.
 *
 * A door answers a caller and a panel runs while somebody is looking; a job outlives both, so
 * without this hook a background half learns that its job ended by being asked. What is
 * defended here is the ADDRESSING, because that is what makes the wake safe to hand out: it
 * reaches the plugin whose request the job was and nobody else, and a half that declared no
 * hook is simply not called rather than called with nothing.
 */

const OWNER_KEY = "a".repeat(64);
const hash = "a".repeat(64);
const limits = { timeoutMs: 1000, memoryBytes: 1048576, processes: 1, outputBytes: 65536 };

function machineHalf(pluginId: string): MachineHalf {
  return {
    artifacts: {
      "linux-x64": {
        url: "https://example.invalid/worker",
        sha256: hash,
        entrySha256: hash,
        format: "raw",
        entry: ["worker"],
        maxBytes: 4096,
        maxExpandedBytes: 4096,
        maxMembers: 1,
      },
    },
    operations: {
      [`${pluginId}.run`]: {
        argv: [{ input: "value" }],
        input: { value: { type: "string", required: true, maxLength: 32 } },
        runtimeTools: [],
        locations: [],
        outputs: [],
        network: "none",
        limits,
        stdin: false,
      },
    },
    locations: {},
  };
}

function def(
  pluginId: string,
  onJobSettled?: (ctx: JobSettledCtx, job: SettledJob) => void | Promise<void>,
  manifestExtras: Partial<PluginManifest> = {},
): ServerPluginDef {
  return {
    manifest: {
      id: pluginId,
      version: "1.0.0",
      title: pluginId,
      description: "A worker half that runs one governed operation.",
      capabilities: [],
      contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
      machine: machineHalf(pluginId),
      ...manifestExtras,
    },
    actions: [],
    handlers: {},
    ...(onJobSettled ? { lifecycle: { onJobSettled } } : {}),
  };
}

interface Fixture {
  readonly auth: AuthService;
  readonly runtime: FakeRuntime;
  readonly store: ServerStore;
  readonly root: AuthContext;
  readonly host: PluginHost;
  readonly service: JobService;
  readonly machineId: string;
  readonly channel: {
    machineId: string;
    send(message: { type: "job_command"; command: JobCommand }): boolean;
  };
  readonly owner: JobOwner;
  readonly privateKey: KeyObject;
}

async function fixture(
  defs: readonly ServerPluginDef[],
  options: {
    readonly lifecycleTimeoutMs?: number;
    readonly jobSettledTimeouts?: Readonly<Record<string, number>>;
    readonly dataDir?: string;
    readonly logger?: Logger;
  } = {},
): Promise<Fixture> {
  const runtime = new FakeRuntime();
  const clock = new FakeClock(runtime);
  const store = testStore();
  const auth = new AuthService(store, OWNER_KEY, runtime);
  const root = auth.authenticate(OWNER_KEY);
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
  const host = await testPluginHost(store, auth, rooms, broker, runtime, {
    settingsPlugins: [...defs],
    ...options,
  });
  const service = new JobService(store, auth, runtime);
  const machineId = auth.enrollMachine("worker", root).machine.id;
  const commands: JobCommand[] = [];
  const channel = {
    machineId,
    send: (message: { type: "job_command"; command: JobCommand }) => {
      commands.push(message.command);
      return true;
    },
  };
  const pair = generateKeyPairSync("ed25519");
  const owner: JobOwner = {
    protocolVersion: JOB_OWNER_PROTOCOL_VERSION,
    ownerId: "test-owner",
    publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    generation: 1,
    platforms: ["linux-x64"],
    inventoryDigest: "b".repeat(64),
  };
  // The host owns the resolvers and the settled fan-out, exactly as `main.ts` composes them.
  host.setJobs(service);
  for (const entry of defs)
    service.install(root, {
      machineId,
      pluginId: entry.manifest.id,
      installationRevision: "r1",
      artifactSha256: hash,
      machine: machineHalf(entry.manifest.id),
    });
  for (const entry of defs)
    for (const cap of ["machines:run", "jobs:read"] as Cap[])
      service.consent(root, {
        machineId,
        pluginId: entry.manifest.id,
        installationRevision: "r1",
        artifactSha256: hash,
        node: formatManifoldUri({
          kind: "operation",
          machineId,
          operationId: `${entry.manifest.id}.run`,
        }),
        cap,
        enabled: true,
      });
  service.online(channel, owner, "epoch");
  const challenge = commands.at(-1);
  if (challenge?.type !== "owner_challenge") throw new Error("owner challenge missing");
  const body = { nonce: challenge.nonce, serverEpoch: challenge.serverEpoch, machineId, owner };
  service.event(channel, {
    type: "owner_proof",
    ...body,
    signature: sign(null, Buffer.from(canonicalJobJson(body)), pair.privateKey).toString("base64"),
  });
  for (const entry of defs)
    service.event(channel, {
      type: "installed",
      pluginId: entry.manifest.id,
      installationRevision: "r1",
      artifactSha256: hash,
    });
  return {
    store,
    auth,
    runtime,
    root,
    host,
    service,
    machineId,
    channel,
    owner,
    privateKey: pair.privateKey,
  };
}

/** One job of `pluginId`, run to a sealed result the way its owner reports one. */
function run(f: Fixture, pluginId: string, jobId: string, actor: AuthContext = f.root): void {
  const job = f.service.execute(actor, pluginId, "trace-1", {
    jobId,
    machineId: f.machineId,
    operationId: `${pluginId}.run`,
    input: { value: "safe" },
    outputs: [],
  });
  f.service.event(f.channel, {
    type: "result",
    result: {
      jobId,
      requestDigest: job.request.requestDigest,
      ownerId: f.owner.ownerId,
      ownerGeneration: f.owner.generation,
      state: "exited",
      exitCode: 0,
      reason: null,
      startedAt: 0,
      finishedAt: 9,
      usage: { elapsedMs: 1, memoryBytes: 1, processes: 1, outputBytes: 4 },
      limits,
      outputs: [{ outputId: "o-1", name: "stdout", sha256: hash, bytes: 4, files: 1 }],
    },
  });
}

test("a settled job wakes the half that started it, with its node and its own authority", async () => {
  const woken: { plugin: string; job: SettledJob }[] = [];
  const journalled: number[] = [];
  const arrived = Promise.withResolvers<void>();
  const f = await fixture([
    def("sample.alpha", (ctx, job) => {
      woken.push({ plugin: "sample.alpha", job });
      // The hook's own job slice, discharged against the job's credential: the wake is
      // actionable rather than an announcement a door has to follow up on.
      journalled.push(
        ctx.jobs.journal({
          node: {
            kind: "job",
            machineId: job.machineId,
            operationId: job.operationId,
            jobId: job.jobId,
          },
        }).events.length,
      );
      arrived.resolve();
    }),
    def("sample.beta", (_ctx, job) => {
      woken.push({ plugin: "sample.beta", job });
    }),
  ]);
  try {
    run(f, "sample.alpha", "job-alpha");
    await arrived.promise;
    expect(woken).toEqual([
      {
        plugin: "sample.alpha",
        job: {
          jobId: "job-alpha",
          machineId: f.machineId,
          operationId: "sample.alpha.run",
          pluginId: "sample.alpha",
          state: "exited",
          exitCode: 0,
          reason: null,
          finishedAt: 9,
          outputs: [{ outputId: "o-1", name: "stdout", sha256: hash, bytes: 4, files: 1 }],
        },
      },
    ]);
    expect(journalled).toEqual([1]);
  } finally {
    f.store.close();
  }
});

test("an owner refusal retains its reason in the durable result and authorized settled wake", async () => {
  const arrived = Promise.withResolvers<SettledJob>();
  const f = await fixture([
    def("sample.alpha", (_ctx, job) => {
      arrived.resolve(job);
    }),
  ]);
  try {
    const jobId = "refused-start";
    const job = f.service.execute(f.root, "sample.alpha", "trace-1", {
      jobId,
      machineId: f.machineId,
      operationId: "sample.alpha.run",
      input: { value: "safe" },
      outputs: [],
    });
    expect(job.state).toBe("start-committed");
    f.service.event(f.channel, { type: "refusal", jobId, reason: "journal_capacity" });
    const settled = await arrived.promise;
    expect(settled).toMatchObject({ jobId, state: "interrupted", reason: "journal_capacity" });
    expect(f.service.jobs.get(jobId)?.result).toMatchObject({
      state: "interrupted",
      reason: "journal_capacity",
    });
    const node = {
      kind: "job" as const,
      machineId: f.machineId,
      operationId: "sample.alpha.run",
      jobId,
    };
    const journal = f.service.journal(f.root, node, 0, 128, "sample.alpha");
    expect(journal.events.at(-1)?.event).toMatchObject({
      type: "result",
      result: { state: "interrupted", reason: "journal_capacity" },
    });
    f.service.event(f.channel, { type: "refusal", jobId, reason: "different_late_refusal" });
    expect(f.service.jobs.get(jobId)?.result?.reason).toBe("journal_capacity");
  } finally {
    f.store.close();
  }
});

test("a half that declared no hook is left alone, and the settle after it still lands", async () => {
  const woken: { plugin: string; jobId: string }[] = [];
  const arrived = Promise.withResolvers<void>();
  const f = await fixture([
    def("sample.alpha", (_ctx, job) => {
      woken.push({ plugin: "sample.alpha", jobId: job.jobId });
      arrived.resolve();
    }),
    def("sample.quiet"),
  ]);
  try {
    // The half without a hook settles FIRST, so the awaited wake proves the fan-out survived it.
    run(f, "sample.quiet", "job-quiet");
    run(f, "sample.alpha", "job-alpha");
    await arrived.promise;
    expect(woken).toEqual([{ plugin: "sample.alpha", jobId: "job-alpha" }]);
    expect(f.service.jobs.get("job-quiet")?.result?.state).toBe("exited");
  } finally {
    f.store.close();
  }
});

test("the wake carries the plugin's own storage, and that authority ends with the call", async () => {
  const wakes = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const seen: PluginStorage[] = [];
  const read: (string | null)[] = [];
  let woke = 0;
  const f = await fixture([
    def("sample.alpha", async (ctx) => {
      const index = woke++;
      seen.push(ctx.storage);
      if (index === 0) {
        await ctx.storage.set("last-settled", "job-alpha");
        read.push(await ctx.storage.get("last-settled"));
      }
      wakes[index]?.resolve();
    }),
  ]);
  try {
    run(f, "sample.alpha", "job-alpha");
    await wakes[0]?.promise;
    // The hook's own durable state, written and read back inside the wake rather than
    // through a door it would have to dispatch to itself.
    expect(read).toEqual(["job-alpha"]);
    expect(await f.store.pluginStorage("sample.alpha").get("last-settled")).toBe("job-alpha");

    run(f, "sample.alpha", "job-beta");
    await wakes[1]?.promise;
    // One turn boundary, not a timed wait: the engine closes the lease in the continuation
    // after the hook's promise settles, so draining the pending microtasks is enough.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const retained = seen[0];
    if (retained === undefined) throw new Error("the hook never ran");
    expect(seen[1]).not.toBe(retained);
    await expect(retained.get("last-settled")).rejects.toThrow();
  } finally {
    f.store.close();
  }
});
/** A real sibling door: refused late calls must not reach its handler. */
function siblingDoor(onCall: () => void): ServerPluginDef {
  const base = def("sample.sibling");
  return {
    ...base,
    manifest: { ...base.manifest, capabilities: ["containers:read"] },
    actions: [
      defineAction({
        name: "ping",
        title: "Ping",
        caps: ["containers:read"],
        input: z.strictObject({}),
        result: z.strictObject({ ok: z.boolean() }),
      }),
    ],
    handlers: {
      ping: () => {
        onCall();
        return Promise.resolve({ ok: true });
      },
    },
  };
}

test.each(["credential", "action", "consent"] as const)(
  "a sibling native child outlives the settled hook but still loses %s authority",
  async (withdrawal) => {
    const posted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let retained: JobSettledCtx | undefined;
    const sibling = def("sample.sibling");
    const f = await fixture([
      def(
        "sample.alpha",
        async (ctx, job) => {
          retained = ctx;
          try {
            await ctx.actions.call({
              plugin: "sample.sibling",
              action: "post",
              input: { machineId: job.machineId, jobId: "child" },
            });
            posted.resolve();
            await release.promise;
          } catch (error) {
            posted.reject(error);
          }
        },
        {
          capabilities: ["containers:read"],
          dependencies: { "sample.sibling": { type: "optional" } },
        },
      ),
      {
        ...sibling,
        manifest: {
          ...sibling.manifest,
          capabilities: ["containers:read", "machines:run"],
        },
        actions: [
          defineAction({
            name: "post",
            title: "Post",
            caps: ["containers:read"],
            delegates: ["machines:run"],
            input: z.strictObject({ machineId: z.string(), jobId: z.string() }),
            result: z.strictObject({ jobId: z.string() }),
          }),
        ],
        handlers: {
          post: async (ctx, args: { machineId: string; jobId: string }) => {
            const child = await ctx.jobs.execute({
              ...args,
              operationId: "sample.sibling.run",
              input: { value: "safe" },
              outputs: [],
            });
            return { jobId: child.jobId };
          },
        },
      },
    ]);
    try {
      const token = f.auth.mintToken(
        {
          principal: { name: "settlement runner", kind: "human" },
          caps: ["containers:read", "machines:run", "jobs:read"],
        },
        f.root,
      );
      const actor = f.auth.authenticate(token.token);
      run(f, "sample.alpha", "parent", actor);
      await posted.promise;
      f.service.tick();
      expect(f.service.jobs.get("child")?.state).toBe("start-committed");
      expect(f.service.jobs.cancellation("child")).toBeNull();
      release.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await expect(
        retained!.actions.call({
          plugin: "sample.sibling",
          action: "post",
          input: { machineId: f.machineId, jobId: "late-child" },
        }),
      ).rejects.toThrow();
      expect(f.service.jobs.get("late-child")).toBeNull();
      f.service.tick();
      expect(f.service.jobs.get("child")?.state).toBe("start-committed");
      expect(f.service.jobs.cancellation("child")).toBeNull();
      if (withdrawal === "credential") {
        f.auth.revokePrincipal(actor.principal.id, f.root);
      } else if (withdrawal === "action") {
        await f.host.setEnabled("sample.sibling", false, f.root.principal.id);
      } else {
        f.service.consent(f.root, {
          machineId: f.machineId,
          pluginId: "sample.sibling",
          installationRevision: "r1",
          artifactSha256: hash,
          node: formatManifoldUri({
            kind: "operation",
            machineId: f.machineId,
            operationId: "sample.sibling.run",
          }),
          cap: "machines:run",
          enabled: false,
        });
      }
      f.service.tick();
      expect(f.service.jobs.cancellation("child")).toEqual({
        reason:
          withdrawal === "credential"
            ? "credential_revoked"
            : withdrawal === "action"
              ? "plugin_disabled"
              : "job_consent_refused:machines:run",
        mode: "cancel",
      });
    } finally {
      release.resolve();
      f.host.close();
      f.store.close();
    }
  },
);

test("selected settlement retains its own longer lease; the unselected hook times out and policy is copied", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "manifold-settled-lease-"));
  const unselectedExpired = Promise.withResolvers<void>();
  const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const release = Promise.withResolvers<void>();
  const contexts: JobSettledCtx[] = [];
  const jobs: SettledJob[] = [];
  let actionCalls = 0;
  const sibling = siblingDoor(() => {
    actionCalls++;
  });
  const worker = (id: string, index: number, database = false) =>
    def(
      id,
      async (ctx, job) => {
        contexts[index] = ctx;
        jobs[index] = job;
        entered[index]!.resolve();
        await release.promise;
      },
      {
        capabilities: ["containers:read"],
        dependencies: { "sample.sibling": { type: "optional" } },
        ...(database ? { database: { maxBytes: 4 * 1024 * 1024 } } : {}),
      },
    );
  const policy: Record<string, number> = { "sample.alpha": 2_000 };
  const f = await fixture([worker("sample.alpha", 0, true), worker("sample.beta", 1), sibling], {
    lifecycleTimeoutMs: 20,
    jobSettledTimeouts: policy,
    dataDir,
    logger: {
      ...silentLogger,
      error: (event, fields) => {
        if (event === "plugin_lifecycle" && fields?.plugin === "sample.beta")
          unselectedExpired.resolve();
      },
    },
  });
  try {
    policy["sample.alpha"] = 20;
    run(f, "sample.alpha", "alpha-lease");
    run(f, "sample.beta", "beta-lease");
    await Promise.all(entered.map((entry) => entry.promise));
    await unselectedExpired.promise;
    const alpha = contexts[0]!;
    const beta = contexts[1]!;
    const alphaJob = jobs[0]!;
    const betaJob = jobs[1]!;
    const node = (job: SettledJob) => ({
      kind: "job" as const,
      machineId: job.machineId,
      operationId: job.operationId,
      jobId: job.jobId,
    });
    // The default lease has expired while the selected 2s policy is still serving.
    await expect(beta.storage.set("late", "no")).rejects.toThrow();
    expect(() => beta.jobs.journal({ node: node(betaJob) })).toThrow();
    await expect(
      beta.actions!.call({ plugin: "sample.sibling", action: "ping", input: {} }),
    ).rejects.toThrow();
    await alpha.storage.set("during", "yes");
    expect(alpha.jobs.journal({ node: node(alphaJob) }).events).toHaveLength(1);
    await alpha.database!.run("CREATE TABLE lease_check (value TEXT)");
    expect(
      await alpha.actions!.call({ plugin: "sample.sibling", action: "ping", input: {} }),
    ).toEqual({ ok: true });
    expect(actionCalls).toBe(1);
    release.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(alpha.storage.set("late", "no")).rejects.toThrow();
    await expect(alpha.database!.run("INSERT INTO lease_check VALUES ('no')")).rejects.toThrow();
    expect(() => alpha.jobs.journal({ node: node(alphaJob) })).toThrow();
    await expect(
      alpha.actions!.call({ plugin: "sample.sibling", action: "ping", input: {} }),
    ).rejects.toThrow();
    expect(actionCalls).toBe(1);
    expect(await f.store.pluginStorage("sample.alpha").get("late")).toBeNull();
  } finally {
    release.resolve();
    f.host.close();
    f.store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a disabled settlement stays revoked after re-enable, without cancelling an admitted hook", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let retained: JobSettledCtx | undefined;
  let actionCalls = 0;
  const f = await fixture(
    [
      def(
        "sample.alpha",
        async (ctx) => {
          retained = ctx;
          entered.resolve();
          await release.promise;
        },
        {
          capabilities: ["containers:read"],
          dependencies: { "sample.sibling": { type: "optional" } },
        },
      ),
      siblingDoor(() => {
        actionCalls++;
      }),
    ],
    { jobSettledTimeouts: { "sample.alpha": 2_000 } },
  );
  try {
    run(f, "sample.alpha", "disable-lease");
    await entered.promise;
    await retained!.storage.set("before", "yes");
    expect(
      await retained!.actions.call({ plugin: "sample.sibling", action: "ping", input: {} }),
    ).toEqual({ ok: true });
    expect(await f.host.setEnabled("sample.alpha", false, "root")).toEqual({ ok: true });
    expect(await f.host.setEnabled("sample.alpha", true, "root")).toEqual({ ok: true });
    await expect(retained!.storage.set("after", "no")).rejects.toThrow();
    expect(() => retained!.jobs.schedules()).toThrow();
    await expect(
      retained!.actions.call({ plugin: "sample.sibling", action: "ping", input: {} }),
    ).rejects.toThrow();
    expect(actionCalls).toBe(1);
    expect(await f.store.pluginStorage("sample.alpha").get("after")).toBeNull();
  } finally {
    release.resolve();
    f.host.close();
    f.store.close();
  }
});

test("the original settled credential is rechecked after expiry, not replaced by root authority", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let retained: JobSettledCtx | undefined;
  let settled: SettledJob | undefined;
  let actionCalls = 0;
  const f = await fixture(
    [
      def(
        "sample.alpha",
        async (ctx, job) => {
          retained = ctx;
          settled = job;
          entered.resolve();
          await release.promise;
        },
        {
          capabilities: ["containers:read"],
          dependencies: { "sample.sibling": { type: "optional" } },
        },
      ),
      siblingDoor(() => {
        actionCalls++;
      }),
    ],
    { jobSettledTimeouts: { "sample.alpha": 2_000 } },
  );
  try {
    const minted = f.auth.mintToken(
      {
        principal: { name: "job caller", kind: "human" },
        caps: ["machines:run", "jobs:read", "containers:read"],
      },
      f.root,
    );
    run(f, "sample.alpha", "expiring-lease", f.auth.authenticate(minted.token));
    await entered.promise;
    const node = {
      kind: "job" as const,
      machineId: settled!.machineId,
      operationId: settled!.operationId,
      jobId: settled!.jobId,
    };
    expect(retained!.jobs.journal({ node }).events).toHaveLength(1);
    expect(
      await retained!.actions.call({ plugin: "sample.sibling", action: "ping", input: {} }),
    ).toEqual({ ok: true });
    f.runtime.time = minted.expiresAt! + 1;
    // Root still holds the job, but its authority must never replace the caller's.
    expect(f.service.journal(f.root, node, 0, 20, "sample.alpha").events).toHaveLength(1);
    expect(() => retained!.jobs.journal({ node })).toThrow();
    await expect(retained!.storage.set("expired", "no")).rejects.toThrow();
    await expect(
      retained!.actions.call({ plugin: "sample.sibling", action: "ping", input: {} }),
    ).rejects.toThrow();
    expect(actionCalls).toBe(1);
  } finally {
    release.resolve();
    f.host.close();
    f.store.close();
  }
});

test("shutdown revokes a selected settlement's retained data and native doors", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let retained: JobSettledCtx | undefined;
  let settled: SettledJob | undefined;
  let actionCalls = 0;
  const f = await fixture(
    [
      def(
        "sample.alpha",
        async (ctx, job) => {
          retained = ctx;
          settled = job;
          entered.resolve();
          await release.promise;
        },
        {
          capabilities: ["containers:read"],
          dependencies: { "sample.sibling": { type: "optional" } },
        },
      ),
      siblingDoor(() => {
        actionCalls++;
      }),
    ],
    { jobSettledTimeouts: { "sample.alpha": 2_000 } },
  );
  try {
    run(f, "sample.alpha", "shutdown-lease");
    await entered.promise;
    expect(
      retained!.jobs.journal({
        node: {
          kind: "job",
          machineId: settled!.machineId,
          operationId: settled!.operationId,
          jobId: settled!.jobId,
        },
      }).events,
    ).toHaveLength(1);
    expect(
      await retained!.actions.call({ plugin: "sample.sibling", action: "ping", input: {} }),
    ).toEqual({ ok: true });
    f.host.close();
    await expect(retained!.storage.set("shutdown", "no")).rejects.toThrow();
    expect(() => retained!.jobs.schedules()).toThrow();
    await expect(
      retained!.actions.call({ plugin: "sample.sibling", action: "ping", input: {} }),
    ).rejects.toThrow();
    expect(actionCalls).toBe(1);
    expect(await f.store.pluginStorage("sample.alpha").get("shutdown")).toBeNull();
  } finally {
    release.resolve();
    f.host.close();
    f.store.close();
  }
});

test("even a selected settlement expires at its finite bound and refuses a resumed hook", async () => {
  const entered = Promise.withResolvers<void>();
  const expired = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const continued = Promise.withResolvers<void>();
  let retained: JobSettledCtx | undefined;
  let actionCalls = 0;
  const f = await fixture(
    [
      def(
        "sample.alpha",
        async (ctx) => {
          retained = ctx;
          entered.resolve();
          await release.promise;
          await expect(ctx.storage.set("continued", "no")).rejects.toThrow();
          expect(() => ctx.jobs.schedules()).toThrow();
          continued.resolve();
        },
        {
          capabilities: ["containers:read"],
          dependencies: { "sample.sibling": { type: "optional" } },
        },
      ),
      siblingDoor(() => {
        actionCalls++;
      }),
    ],
    {
      jobSettledTimeouts: { "sample.alpha": 2_000 },
      logger: {
        ...silentLogger,
        error: (event, fields) => {
          if (event === "plugin_lifecycle" && fields?.plugin === "sample.alpha") expired.resolve();
        },
      },
    },
  );
  try {
    run(f, "sample.alpha", "finite-lease");
    await entered.promise;
    await retained!.storage.set("during", "yes");
    expect(
      await retained!.actions.call({ plugin: "sample.sibling", action: "ping", input: {} }),
    ).toEqual({ ok: true });
    await expired.promise;
    await expect(retained!.storage.set("after", "no")).rejects.toThrow();
    expect(() => retained!.jobs.schedules()).toThrow();
    await expect(
      retained!.actions.call({ plugin: "sample.sibling", action: "ping", input: {} }),
    ).rejects.toThrow();
    expect(actionCalls).toBe(1);
    release.resolve();
    await continued.promise;
    expect(await f.store.pluginStorage("sample.alpha").get("after")).toBeNull();
    expect(await f.store.pluginStorage("sample.alpha").get("continued")).toBeNull();
  } finally {
    release.resolve();
    f.host.close();
    f.store.close();
  }
}, 10_000);

test("a synchronous settled hook revokes its context before queued microtasks can admit effects", async () => {
  const observed = Promise.withResolvers<PromiseSettledResult<unknown>[]>();
  let actionCalls = 0;
  const f = await fixture([
    def(
      "sample.alpha",
      (ctx) => {
        queueMicrotask(() => {
          void Promise.allSettled([
            ctx.storage.set("queued", "no"),
            Promise.resolve().then(() => ctx.jobs.schedules()),
            ctx.actions.call({ plugin: "sample.sibling", action: "ping", input: {} }),
          ]).then(observed.resolve);
        });
      },
      {
        capabilities: ["containers:read"],
        dependencies: { "sample.sibling": { type: "optional" } },
      },
    ),
    siblingDoor(() => {
      actionCalls++;
    }),
  ]);
  try {
    run(f, "sample.alpha", "queued-lease");
    expect((await observed.promise).map((outcome) => outcome.status)).toEqual([
      "rejected",
      "rejected",
      "rejected",
    ]);
    expect(actionCalls).toBe(0);
    expect(await f.store.pluginStorage("sample.alpha").get("queued")).toBeNull();
  } finally {
    f.host.close();
    f.store.close();
  }
});

test("a sibling prepared while settlement was live cannot admit after the hook returns", async () => {
  const prepared = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const result = Promise.withResolvers<PromiseSettledResult<unknown>>();
  let effects = 0;
  const sibling: ServerPluginDef = {
    ...siblingDoor(() => {}),
    inputValidation: "guest",
    handlers: {
      ping: async (ctx) => {
        prepared.resolve();
        await release.promise;
        ctx.admitPrepared!([]);
        effects++;
        return { ok: true };
      },
    },
  };
  const f = await fixture(
    [
      def(
        "sample.alpha",
        (ctx) => {
          void ctx.actions.call({ plugin: "sample.sibling", action: "ping", input: {} }).then(
            (value) => result.resolve({ status: "fulfilled", value }),
            (reason: unknown) => result.resolve({ status: "rejected", reason }),
          );
        },
        {
          capabilities: ["containers:read"],
          dependencies: { "sample.sibling": { type: "optional" } },
        },
      ),
      sibling,
    ],
    { jobSettledTimeouts: { "sample.alpha": 2_000 } },
  );
  try {
    run(f, "sample.alpha", "late-prepared-sibling");
    await prepared.promise;
    release.resolve();
    expect((await result.promise).status).toBe("rejected");
    expect(effects).toBe(0);
  } finally {
    release.resolve();
    f.host.close();
    f.store.close();
  }
});
