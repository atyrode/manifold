import { afterEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { ByteCarrierContext, JobSettledCtx, LifecycleCtx, PluginStorage } from "@manifold/plugin";
import type {
  Cap,
  EventKind,
  EventPayload,
  ReferenceProbeResult,
  ManifoldRef,
  PluginManifest,
  SettledJob,
} from "@manifold/protocol";
import { ByteTransferError } from "@manifold/protocol";
import { AuthService } from "../src/auth.ts";
import { IsolateDenial, IsolateLoadError, type IsolateState } from "../src/isolate/contract.ts";
import { IsolateSupervisor, type IsolateSupervisorDeps } from "../src/isolate/supervisor.ts";
import type { Logger, LogLevel } from "../src/log.ts";
import type { ActionCtx, ServerPluginDef } from "../src/plugin-host.ts";
import { FakeRuntime, testStore } from "./helpers.ts";

/*
  REAL CHILD PROCESSES, on purpose: the supervisor's whole job is what happens at a process
  boundary — a spawn, a silence, an exit — and a fake transport would prove the supervisor
  against itself. The guest is `fixtures/isolate-guest/server.js`, the child side of the
  protocol written by hand against the schemas rather than through the kit.
 */

const GUEST_DIR = resolve(import.meta.dir, "fixtures/isolate-guest");
const SILENT_GUEST_DIR = resolve(import.meta.dir, "fixtures/isolate-guest-silent");
const PLUGIN_ID = "test.guest";

const manifest: PluginManifest = {
  id: PLUGIN_ID,
  version: "1.0.0",
  title: "Guest",
  description: "the supervisor's test subject",
  capabilities: [],
  contributes: {
    panels: [],
    sections: [],
    elements: [],
    tools: [],
    events: [{ id: "echoed", title: "Echoed" }],
  },
  entry: { server: true },
};
const settledJob: SettledJob = {
  jobId: "finished",
  machineId: "worker",
  pluginId: PLUGIN_ID,
  operationId: `${PLUGIN_ID}.run`,
  state: "exited",
  exitCode: 0,
  reason: null,
  finishedAt: 1,
  outputs: [],
};

const principal = { id: "p1", kind: "human" as const, name: "Pat", color: "#123456" };

interface LogLine {
  readonly level: LogLevel;
  readonly evt: string;
  readonly fields: Readonly<Record<string, unknown>> | undefined;
}

class CaptureLogger implements Logger {
  readonly lines: LogLine[] = [];

  info(evt: string, fields?: Readonly<Record<string, unknown>>): void {
    this.lines.push({ level: "info", evt, fields });
  }

  warn(evt: string, fields?: Readonly<Record<string, unknown>>): void {
    this.lines.push({ level: "warn", evt, fields });
  }

  error(evt: string, fields?: Readonly<Record<string, unknown>>): void {
    this.lines.push({ level: "error", evt, fields });
  }

  count(evt: string): number {
    return this.lines.filter((line) => line.evt === evt).length;
  }
}

/**
 * Polls until `predicate` holds. A real process exit and a real pipe drain are what these
 * tests observe, and no fake clock can advance an OS process — so the wait is on the
 * condition itself, bounded, never on a guessed duration.
 */
async function until(predicate: () => boolean, timeoutMs = 1_500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await Bun.sleep(10);
  }
}

interface Emitted {
  readonly ref: ManifoldRef;
  readonly kind: EventKind;
  readonly payload: EventPayload | undefined;
}

/** The ctx slice a proxy handler touches, over real storage; the rest is never reached. */
function actionCtx(
  storage: PluginStorage,
  runtime: FakeRuntime,
): { readonly ctx: ActionCtx; readonly emitted: Emitted[] } {
  const emitted: Emitted[] = [];
  const slice: Pick<
    ActionCtx,
    | "traceId"
    | "callerPlugin"
    | "principal"
    | "auth"
    | "containerScope"
    | "outsideScope"
    | "storage"
    | "now"
    | "newId"
    | "emit"
    | "admitPrepared"
    | "references"
  > = {
    traceId: 1,
    callerPlugin: null,
    admitPrepared: () => {},
    principal,
    auth: {
      principal,
      caps: ["scenes:write"],
      containerScope: null,
      isRoot: false,
      allows: () => true,
    },
    containerScope: null,
    outsideScope: () => null,
    storage,
    now: () => runtime.now(),
    newId: () => runtime.newId(),
    references: {
      attach: async () => { throw new Error("unexpected references.attach"); },
      prepare: async () => { throw new Error("unexpected references.prepare"); },
      publish: async () => { throw new Error("unexpected references.publish"); },
      abort: async () => { throw new Error("unexpected references.abort"); },
      requirePublished: async () => { throw new Error("unexpected references.requirePublished"); },
      unpublish: async () => { throw new Error("unexpected references.unpublish"); },
      receipt: async () => { throw new Error("unexpected references.receipt"); },
      readable: async () => { throw new Error("unexpected references.readable"); },
      grant: async () => { throw new Error("unexpected references.grant"); },
      revoke: async () => { throw new Error("unexpected references.revoke"); },
      audience: async () => { throw new Error("unexpected references.audience"); },
    },
    emit: (ref, kind, payload) => {
      emitted.push({ ref, kind, payload });
    },
  };
  return { ctx: slice as ActionCtx, emitted };
}

function invoke(
  def: ServerPluginDef,
  action: string,
  ctx: ActionCtx,
  args: unknown,
): Promise<unknown> {
  const handler = def.handlers[action];
  if (handler === undefined) throw new Error(`no handler ${action}`);
  return handler(ctx, args as never);
}

interface Fixture {
  readonly supervisor: IsolateSupervisor;
  readonly logger: CaptureLogger;
  readonly runtime: FakeRuntime;
  readonly storage: PluginStorage;
  readonly states: { readonly state: IsolateState; readonly detail: string | undefined }[];
}

const open: IsolateSupervisor[] = [];

function fixture(overrides: Partial<IsolateSupervisorDeps> = {}): Fixture {
  const logger = new CaptureLogger();
  const runtime = new FakeRuntime();
  const supervisor = new IsolateSupervisor({ logger, runtime, ...overrides });
  const states: Fixture["states"] = [];
  supervisor.onState((pluginId, state, detail) => {
    expect(pluginId).toBe(PLUGIN_ID);
    states.push({ state, detail });
  });
  open.push(supervisor);
  return { supervisor, logger, runtime, storage: testStore().pluginStorage(PLUGIN_ID), states };
}
function heldHookCtx(storage: PluginStorage, runtime: FakeRuntime, key = "enabled") {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const completed = Promise.withResolvers<void>();
  const reads: string[] = [];
  const ctx: JobSettledCtx = {
    pluginId: PLUGIN_ID,
    storage: {
      ...storage,
      get: async (name) => {
        reads.push(name);
        if (name === key) {
          entered.resolve();
          await release.promise;
        }
        const result = await storage.get(name);
        if (name === key) completed.resolve();
        return result;
      },
    },
    now: () => runtime.now(),
    emit: () => {},
    jobs: {} as JobSettledCtx["jobs"],
    actions: {} as JobSettledCtx["actions"],
  };
  return {
    ctx,
    entered: entered.promise,
    completed: completed.promise,
    release: () => release.resolve(),
    reads,
  };
}

const barriers: string[] = [];

async function guestBarrier() {
  const dir = await mkdtemp(resolve(tmpdir(), "isolate-profile-"));
  barriers.push(dir);
  return {
    dir,
    entered: () => until(() => existsSync(resolve(dir, "entered"))),
    release: () => writeFile(resolve(dir, "release"), ""),
  };
}

async function harnessFixture(overrides: Partial<IsolateSupervisorDeps> = {}) {
  const subject = fixture(overrides);
  const ref = {
    pluginId: PLUGIN_ID,
    manifest: {
      ...manifest,
      contributes: {
        ...manifest.contributes,
        harness: { id: "test", title: "Test", profileSchema: {}, sessionRef: "typed" as const },
      },
    },
    dir: GUEST_DIR,
    hardenedContract: 7,
  };
  const loaded = await subject.supervisor.load(ref);
  if (loaded.def.harness === undefined) throw new Error("missing harness");
  const { ctx, emitted } = actionCtx(subject.storage, subject.runtime);
  let actions = 0;
  const guardedCtx = {
    ...ctx,
    actions: {
      call: async () => {
        actions += 1;
        return null;
      },
    },
  } as ActionCtx;
  return {
    ...subject,
    ...loaded,
    ref,
    harness: loaded.def.harness,
    ctx: guardedCtx,
    emitted,
    actionEffects: () => actions,
  };
}

async function referenceFixture(overrides: Partial<IsolateSupervisorDeps> = {}) {
  const subject = fixture(overrides);
  const { def } = await subject.supervisor.load({
    pluginId: PLUGIN_ID, manifest, dir: GUEST_DIR, hardenedContract: 10,
  });
  if (def.probeReady === undefined) throw new Error("missing readiness probe");
  const { ctx } = actionCtx(subject.storage, subject.runtime);
  return {
    ...subject,
    def,
    probe: def.probeReady,
    ctx: { ...ctx, credentialBinding: "b".repeat(64) } as ActionCtx,
    ref: { kind: "file" as const, fileId: "owned" },
  };
}

async function unavailable(promise: Promise<unknown>): Promise<void> {
  let settled = false;
  const outcome = promise
    .then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )
    .finally(() => {
      settled = true;
    });
  // The refusal must not wait for the held guest's release or the dispatch deadline.
  await until(() => settled);
  expect(await outcome).toEqual({ error: expect.any(IsolateDenial) });
  const result = await outcome;
  if ("error" in result) expect((result.error as IsolateDenial).rule).toBe("unavailable");
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((supervisor) => supervisor.close()));
  await Promise.all(barriers.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("IsolateSupervisor", () => {
  test("native terminal reconciliation has only its data lease across the real child boundary", async () => {
    const { supervisor, runtime, storage } = fixture({ referenceProbeDeadlineMs: 500 });
    const { def } = await supervisor.load({
      pluginId: PLUGIN_ID, manifest, dir: GUEST_DIR, hardenedContract: 10,
    });
    const reconcile = def.reconcileNativeTransfers;
    if (!reconcile) throw new Error("missing native evidence callback");
    await storage.set("reservation:transfer", "active");
    await storage.set("reservation:independent", "active");
    const evidence = { transferId: "transfer", requestId: "request", actorId: principal.id,
      credentialBinding: "a".repeat(64), mode: "put" as const, state: "committed" as const };
    await reconcile({ storage, now: () => runtime.now() }, [evidence]);
    expect(await storage.get("reservation:transfer")).toBeNull();
    expect(await storage.get("reservation:independent")).toBe("active");
    await storage.set("reservation:transfer", "active");
    await expect(reconcile({ storage, now: () => runtime.now() }, [{ ...evidence, requestId: "escape" }]))
      .rejects.toBeInstanceOf(IsolateDenial);
    expect(await storage.get("reservation:transfer")).toBe("active");
    expect(await storage.get("reservation:independent")).toBe("active");
  });

  test("publication can await a nested data probe without inheriting or deadlocking action authority", async () => {
    const { supervisor, runtime, storage } = fixture({ referenceProbeDeadlineMs: 500 });
    const { def } = await supervisor.load({
      pluginId: PLUGIN_ID, manifest, dir: GUEST_DIR, hardenedContract: 10,
    });
    const { ctx } = actionCtx(storage, runtime);
    const probe = def.probeReady;
    const reclaim = def.reclaimReferences;
    if (probe === undefined || reclaim === undefined) throw new Error("missing reference callbacks");
    const ref = { kind: "file" as const, fileId: "owned" };
    const readyDigest = "a".repeat(64);
    await storage.set("ready:prepared", readyDigest);
    const caller = {
      ...ctx,
      credentialBinding: "b".repeat(64),
      references: {
        ...ctx.references,
        publish: async ({ preparationId }: { preparationId: string }) => {
          const ready = await probe({ storage, now: () => runtime.now() }, { ref, preparationId, requestId: 'request', bindingDigest: 'b'.repeat(64), publication: 'prepared' });
          if (ready === null) throw new Error("published_ready_missing");
          if (ready?.readyDigest == null) throw new Error('published_ready_missing');
          return { ref, preparationId: ready.preparationId, readyDigest: ready.readyDigest };
        },
      },
    } satisfies ActionCtx;
    expect(await invoke(def, "reference", caller, { text: "prepared" })).toEqual({
      binding: "b".repeat(64),
      result: { ref, preparationId: "prepared", readyDigest },
    });
    await reclaim({ storage, now: () => runtime.now() }, [
      { ref, preparationId: "prepared", state: "deleted" },
    ]);
    expect(await probe({ storage, now: () => runtime.now() }, { ref, preparationId: "prepared", requestId: 'request', bindingDigest: 'b'.repeat(64), publication: 'prepared' })).toBeNull();
  });

  test("idle maintenance declines a busy guest without interrupting its ordinary effects", async () => {
    const f = await referenceFixture({ referenceProbeDeadlineMs: 2_000 });
    const idleProbe = f.def.probeReadyWhenIdle;
    if (idleProbe === undefined) throw new Error("missing idle readiness probe");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const ordinary = invoke(f.def, "echo", {
      ...f.ctx,
      storage: {
        ...f.storage,
        get: async (key) => {
          entered.resolve();
          await release.promise;
          return f.storage.get(key);
        },
      },
    }, { text: "uninterrupted" });
    const request = {
      ref: f.ref, preparationId: "prepared", requestId: "request",
      bindingDigest: "b".repeat(64), publication: "published" as const,
    };
    try {
      await entered.promise;
      await unavailable(idleProbe({ storage: f.storage, now: () => f.runtime.now() }, request));
    } finally {
      release.resolve();
    }
    expect(await ordinary).toEqual({ text: "uninterrupted", count: 1 });
    expect(await f.storage.get("count")).toBe("1");

    const probing = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<string | null>();
    const recovery = idleProbe({
      storage: {
        ...f.storage,
        get: async () => { probing.resolve(); return finish.promise; },
      },
      now: () => f.runtime.now(),
    }, request);
    let admitted = false;
    let queued: Promise<unknown> | undefined;
    try {
      await probing.promise;
      queued = invoke(f.def, "echo", {
        ...f.ctx, admitPrepared: () => { admitted = true; },
      }, { text: "queued behind recovery" }).catch((error: unknown) => error);
      expect(await f.storage.get("count")).toBe("1");
      expect(admitted).toBe(false);
    } finally {
      finish.resolve("a".repeat(64));
    }
    expect(await recovery).toEqual({
      preparationId: "prepared", readyDigest: "a".repeat(64), expiresAt: f.runtime.now() + 60_000,
    });
    expect(await queued).toEqual({ text: "queued behind recovery", count: 2 });
    expect(admitted).toBe(true);
    expect(f.logger.count("isolate_exited")).toBe(0);
    expect(await invoke(f.def, "echo", f.ctx, { text: "resumed" })).toEqual({ text: "resumed", count: 3 });
  });

  test.each(["completeAfterBarrier", "prepareAfterBarrier"])(
    "a private publication probe waits for the current owner turn and excludes new admission: %s",
    async (action) => {
      const f = await referenceFixture({ referenceProbeDeadlineMs: 2_000 });
      const gate = await guestBarrier();
      const release = Promise.withResolvers<string | null>();
      let reading = false;
      let admitted = 0;
      let published = false;
      const existing = invoke(f.def, action, {
        ...f.ctx,
        admitPrepared: () => { admitted += 1; },
      }, { text: gate.dir }).catch((error: unknown) => error);
      await gate.entered();
      const caller = {
        ...f.ctx,
        references: {
          ...f.ctx.references,
          publish: async ({ preparationId }: { preparationId: string }) => {
            const ready = await f.probe({
              storage: {
                ...f.storage,
                get: async () => { reading = true; return release.promise; },
              },
              now: () => f.runtime.now(),
            }, { ref: f.ref, preparationId, requestId: 'request', bindingDigest: 'b'.repeat(64), publication: 'prepared' });
            published = true;
            if (ready?.readyDigest == null) throw new Error('published_ready_missing');
            return { ref: f.ref, preparationId: ready.preparationId, readyDigest: ready.readyDigest };
          },
        },
      } satisfies ActionCtx;
      const publication = invoke(f.def, "reference", caller, { text: "prepared" })
        .catch((error: unknown) => error);
      let queued: Promise<unknown> | undefined;
      let queuedAdmitted = false;
      try {
        expect(reading).toBe(false);
        await gate.release();
        expect(await existing).toEqual({
          text: action === "completeAfterBarrier" ? "completed" : "admitted",
        });
        expect(admitted).toBe(1);
        await until(() => reading);
        queued = invoke(f.def, "echo", {
          ...f.ctx, admitPrepared: () => { queuedAdmitted = true; },
        }, { text: "still usable" }).catch((error: unknown) => error);
        expect(await f.storage.get("count")).toBeNull();
        expect(queuedAdmitted).toBe(false);
        expect(published).toBe(false);
        expect(f.logger.count("isolate_exited")).toBe(0);
        release.resolve("a".repeat(64));
        expect(await publication).toEqual({
          binding: "b".repeat(64),
          result: { ref: f.ref, preparationId: "prepared", readyDigest: "a".repeat(64) },
        });
        expect(await queued).toEqual({
          text: "still usable", count: 1,
        });
        expect(queuedAdmitted).toBe(true);
        expect(f.logger.count("isolate_spawned")).toBe(1);
      } finally {
        release.resolve(null);
        await gate.release();
        await Promise.all([existing, publication, queued]);
      }
    },
  );

  test.each(["dispatch", "harness"])(
    "a probe cannot forge its waiting %s completion to acquire emission authority",
    async (victimKind) => {
      const f = fixture({ referenceProbeDeadlineMs: 2_000 });
      const { def } = await f.supervisor.load({
        pluginId: PLUGIN_ID,
        manifest: {
          ...manifest,
          contributes: {
            ...manifest.contributes,
            harness: { id: "test", title: "Test", profileSchema: {}, sessionRef: "typed" },
          },
        },
        dir: GUEST_DIR,
        hardenedContract: 10,
      });
      const probe = def.probeReady;
      const harness = def.harness;
      if (probe === undefined || harness === undefined) throw new Error("missing guest callbacks");
      const { ctx, emitted } = actionCtx(f.storage, f.runtime);
      const gate = await guestBarrier();
      const caller = {
        ...ctx,
        storage: {
          ...f.storage,
          get: async (key: string) => {
            if (key !== "nested-probe") return f.storage.get(key);
            await probe({ storage: f.storage, now: () => f.runtime.now() }, {
              ref: { kind: "file", fileId: "owned" }, preparationId: "emission",
              requestId: "request", bindingDigest: "b".repeat(64), publication: "prepared",
            });
            return null;
          },
        },
      } satisfies ActionCtx;
      const victim = (victimKind === "dispatch"
        ? invoke(def, "holdForProbe", caller, { text: gate.dir })
        : harness.sessions(caller, { machineId: `hold-for-probe:${gate.dir}` }))
        .catch((error: unknown) => error);
      try {
        await gate.entered();
        await gate.release();
        expect(await victim).toBeInstanceOf(IsolateDenial);
        expect(emitted).toEqual([]);
        expect(await invoke(def, "echo", ctx, { text: "fresh generation" })).toEqual({
          text: "fresh generation", count: 1,
        });
        expect(emitted).toEqual([{
          ref: { kind: "plugin", pluginId: PLUGIN_ID }, kind: "echoed", payload: { count: 1 },
        }]);
        expect(f.logger.count("isolate_spawned")).toBe(2);
      } finally {
        await gate.release();
        await victim;
      }
    },
  );

  test("a parent publish timeout can finish without releasing the still-running probe's fence", async () => {
    const f = await referenceFixture({ referenceProbeDeadlineMs: 2_000 });
    const release = Promise.withResolvers<string | null>();
    const expired = Promise.withResolvers<never>();
    let reading = false;
    let probeResult: Promise<ReferenceProbeResult> | undefined;
    const caller = {
      ...f.ctx,
      references: {
        ...f.ctx.references,
        publish: async () => {
          probeResult = f.probe({
            storage: {
              ...f.storage,
              get: async () => { reading = true; return release.promise; },
            },
            now: () => f.runtime.now(),
          }, { ref: f.ref, preparationId: "prepared", requestId: 'request', bindingDigest: 'b'.repeat(64), publication: 'prepared' });
          const ready = await Promise.race([probeResult, expired.promise]);
          if (ready === null) throw new Error("published_ready_missing");
          if (ready?.readyDigest == null) throw new Error('published_ready_missing');
          return { ref: f.ref, preparationId: ready.preparationId, readyDigest: ready.readyDigest };
        },
      },
    } satisfies ActionCtx;
    const publication = invoke(f.def, "reference", caller, { text: "prepared" })
      .catch((error: unknown) => error);
    try {
      await until(() => reading);
      expired.reject(new Error("authority_lost"));
      expect(await publication).toEqual({ refused: "authority_lost" });
      await unavailable(invoke(f.def, "identify", f.ctx, { text: "still fenced" }));
      release.resolve("a".repeat(64));
      expect(await probeResult).toMatchObject({ preparationId: "prepared", readyDigest: "a".repeat(64) });
      expect(await invoke(f.def, "echo", f.ctx, { text: "after timeout" })).toEqual({
        text: "after timeout", count: 1,
      });
      expect(f.logger.count("isolate_spawned")).toBe(1);
      expect(f.logger.count("isolate_exited")).toBe(0);
    } finally {
      release.resolve(null);
      await Promise.allSettled([publication, probeResult]);
    }
  });

  test(
    "an action deadline quarantines its nested probe and late data result",
    async () => {
      const f = await referenceFixture({
        dispatchDeadlineMs: 500, referenceProbeDeadlineMs: 2_000,
      });
      const release = Promise.withResolvers<string | null>();
      let reading = false;
      let published = false;
      const caller = {
        ...f.ctx,
        references: {
          ...f.ctx.references,
          publish: async () => {
            const ready = await f.probe({
              storage: {
                ...f.storage,
                get: async () => { reading = true; return release.promise; },
              },
              now: () => f.runtime.now(),
            }, { ref: f.ref, preparationId: "prepared", requestId: 'request', bindingDigest: 'b'.repeat(64), publication: 'prepared' });
            published = true;
            if (ready?.readyDigest == null) throw new Error('published_ready_missing');
            return { ref: f.ref, preparationId: ready.preparationId, readyDigest: ready.readyDigest };
          },
        },
      } satisfies ActionCtx;
      const publication = invoke(f.def, "reference", caller, { text: "prepared" })
        .catch((error: unknown) => error);
      try {
        await until(() => reading);
        // A dead generation's outstanding data await must not serialize its replacement.
        expect(await publication).toBeInstanceOf(IsolateDenial);
        expect(published).toBe(false);
        expect(await f.probe({ storage: f.storage, now: () => f.runtime.now() }, { ref: f.ref, preparationId: "fresh", requestId: 'request', bindingDigest: 'b'.repeat(64), publication: 'prepared' })).toBeNull();
        release.resolve("a".repeat(64));
        expect(await invoke(f.def, "echo", f.ctx, { text: "fresh generation" })).toEqual({
          text: "fresh generation", count: 1,
        });
        expect(published).toBe(false);
        expect(f.logger.count("isolate_spawned")).toBe(2);
      } finally {
        release.resolve(null);
        await publication;
      }
    },
  );

  test("an unadmitted owner request expires without killing the active data callback", async () => {
    const f = await referenceFixture({ dispatchDeadlineMs: 100, referenceProbeDeadlineMs: 2_000 });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<string | null>();
    const probing = f.probe({
      storage: {
        ...f.storage,
        get: async () => { entered.resolve(); return release.promise; },
      },
      now: () => f.runtime.now(),
    }, {
      ref: f.ref, preparationId: "prepared", requestId: "request",
      bindingDigest: "b".repeat(64), publication: "published",
    });
    let admitted = false;
    try {
      await entered.promise;
      await unavailable(invoke(f.def, "echo", {
        ...f.ctx, admitPrepared: () => { admitted = true; },
      }, { text: "expired before admission" }));
      expect(admitted).toBe(false);
      expect(await f.storage.get("count")).toBeNull();
      release.resolve("a".repeat(64));
      expect(await probing).toMatchObject({ preparationId: "prepared", readyDigest: "a".repeat(64) });
      expect(await invoke(f.def, "echo", f.ctx, { text: "still live" })).toEqual({
        text: "still live", count: 1,
      });
      expect(f.logger.count("isolate_exited")).toBe(0);
    } finally {
      release.resolve(null);
      await Promise.allSettled([probing]);
    }
  });

  test("a dequeued owner request retains its original total deadline", async () => {
    const f = await referenceFixture({ dispatchDeadlineMs: 1_000, referenceProbeDeadlineMs: 800 });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<string | null>();
    const request = {
      ref: f.ref, preparationId: "prepared", requestId: "request",
      bindingDigest: "b".repeat(64), publication: "published" as const,
    };
    const activeProbe = f.probe({
      storage: {
        ...f.storage,
        get: async () => { entered.resolve(); return release.promise; },
      },
      now: () => f.runtime.now(),
    }, request);
    await entered.promise;
    const action = invoke(f.def, "hang", f.ctx, { text: "remaining deadline" })
      .catch((error: unknown) => error);
    try {
      // This integration exercises actual IPC/deadline/SIGKILL ordering. Advancing only
      // parent timers would not advance the child process that must receive the request.
      await Bun.sleep(650);
      release.resolve("a".repeat(64));
      await activeProbe;
      // Its 800 ms starts now: the action's original remaining 350 ms must expire first.
      // Resetting the action to 1,000 ms after dequeue would let this queued probe expire
      // without killing the generation, and would retain the action's authority too long.
      await unavailable(f.probe({ storage: f.storage, now: () => f.runtime.now() }, request));
      expect(f.logger.count("isolate_exited")).toBe(1);
      expect(await action).toBeInstanceOf(IsolateDenial);
    } finally {
      release.resolve(null);
      await Promise.allSettled([activeProbe, action]);
    }
  });

  test("owner request admission is bounded while a data callback holds the guest", async () => {
    const f = await referenceFixture({ referenceProbeDeadlineMs: 2_000 });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<string | null>();
    const probing = f.probe({
      storage: {
        ...f.storage,
        get: async () => { entered.resolve(); return release.promise; },
      },
      now: () => f.runtime.now(),
    }, {
      ref: f.ref, preparationId: "prepared", requestId: "request",
      bindingDigest: "b".repeat(64), publication: "published",
    });
    const queued: Promise<unknown>[] = [];
    try {
      await entered.promise;
      for (let index = 0; index < 255; index += 1) {
        queued.push(invoke(f.def, "echo", f.ctx, { text: "queued" }).catch((error: unknown) => error));
      }
      await unavailable(invoke(f.def, "echo", f.ctx, { text: "over capacity" }));
      expect(await f.storage.get("count")).toBeNull();
      release.resolve("a".repeat(64));
      await probing;
      for (const result of await Promise.all(queued)) expect(result).toMatchObject({ text: "queued" });
      expect(await f.storage.get("count")).toBe("255");
      expect(f.logger.count("isolate_exited")).toBe(0);
    } finally {
      release.resolve(null);
      await Promise.allSettled([probing, ...queued]);
    }
  });

  test("an aborted queued byte request never enters the guest or survives into its next owner turn", async () => {
    const f = fixture({ referenceProbeDeadlineMs: 2_000 });
    const { def } = await f.supervisor.load({
      pluginId: PLUGIN_ID, dir: GUEST_DIR, hardenedContract: 10,
      manifest: {
        ...manifest,
        contributes: {
          ...manifest.contributes,
          byteCarriers: [{ id: "bytes", direction: "outgoing", capability: "scenes:read", refKinds: ["file"] }],
        },
      },
    });
    const probe = def.probeReady;
    const carrier = def.byteCarriers?.["bytes"];
    if (probe === undefined || carrier === undefined) throw new Error("missing guest callbacks");
    const gate = await guestBarrier();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<string | null>();
    const probing = probe({
      storage: {
        ...f.storage,
        get: async () => { entered.resolve(); return release.promise; },
      },
      now: () => f.runtime.now(),
    }, {
      ref: { kind: "file", fileId: "owned" }, preparationId: "prepared", requestId: "request",
      bindingDigest: "b".repeat(64), publication: "published",
    });
    const abort = new AbortController();
    const byteCtx: ByteCarrierContext = {
      pluginId: PLUGIN_ID, principal, credentialBinding: "b".repeat(64),
      signal: abort.signal, now: () => f.runtime.now(),
      assertCurrent: () => { if (abort.signal.aborted) throw new ByteTransferError("cancelled"); },
      requirePublished: async () => { throw new Error("unexpected fixture publication call"); },
      nativeTransfers: {
        readChunk: async () => { throw new Error("unexpected fixture native read"); },
        status: async () => { throw new Error("unexpected fixture native status"); },
      },
    };
    const input = {
      transferId: "queued-byte", ref: { kind: "file" as const, fileId: gate.dir },
      offset: 0, sequence: 0, length: 1,
    };
    try {
      await entered.promise;
      const cancelled = carrier.authorize(byteCtx, input);
      abort.abort();
      await expect(cancelled).rejects.toMatchObject({ reason: "cancelled" });
      release.resolve("a".repeat(64));
      await probing;
      expect(existsSync(resolve(gate.dir, "byte-entered"))).toBe(false);
      const fresh = new AbortController();
      expect(await carrier.authorize({
        ...byteCtx,
        signal: fresh.signal,
        assertCurrent: () => { if (fresh.signal.aborted) throw new ByteTransferError("cancelled"); },
      }, input)).toEqual({ expiresAt: f.runtime.now() + 60_000 });
      expect(existsSync(resolve(gate.dir, "byte-entered"))).toBe(true);
      expect(f.logger.count("isolate_exited")).toBe(0);
    } finally {
      release.resolve(null);
      await Promise.allSettled([probing]);
    }
  });

  test("unload cancels unadmitted owner requests rather than replaying them in the next generation", async () => {
    const f = await referenceFixture();
    const gate = await guestBarrier();
    const active = invoke(f.def, "completeAfterBarrier", f.ctx, { text: gate.dir })
      .catch((error: unknown) => error);
    await gate.entered();
    let admitted = false;
    const queued = invoke(f.def, "echo", {
      ...f.ctx, admitPrepared: () => { admitted = true; },
    }, { text: "not replayed" }).catch((error: unknown) => error);
    try {
      await f.supervisor.unload(PLUGIN_ID);
      expect(await active).toBeInstanceOf(IsolateDenial);
      expect(await queued).toBeInstanceOf(IsolateDenial);
      expect(admitted).toBe(false);
      const { def } = await f.supervisor.load({
        pluginId: PLUGIN_ID, manifest, dir: GUEST_DIR, hardenedContract: 10,
      });
      expect(await invoke(def, "echo", f.ctx, { text: "fresh generation" })).toEqual({
        text: "fresh generation", count: 1,
      });
      const unsent = invoke(def, "echo", f.ctx, { text: "retired before startup" })
        .catch((error: unknown) => error);
      await f.supervisor.unload(PLUGIN_ID);
      expect(await unsent).toBeInstanceOf(IsolateDenial);
      expect(await f.storage.get("count")).toBe("1");
      expect(f.logger.count("isolate_spawned")).toBe(2);
    } finally {
      await gate.release();
      await Promise.all([active, queued]);
    }
  });

  test("a probe cannot complete while an owner-data callback is still outstanding", async () => {
    const f = await referenceFixture({ referenceProbeDeadlineMs: 2_000 });
    const gate = await guestBarrier();
    const release = Promise.withResolvers<string | null>();
    let reading = false;
    const probed = f.probe({
      storage: {
        ...f.storage,
        get: async () => { reading = true; return release.promise; },
      },
      now: () => f.runtime.now(),
    }, { ref: f.ref, preparationId: `early:${gate.dir}`, requestId: 'request', bindingDigest: 'b'.repeat(64), publication: 'prepared' }).catch((error: unknown) => error);
    try {
      await until(() => reading);
      await gate.release();
      expect(await probed).toBeInstanceOf(IsolateDenial);
      expect(f.logger.lines.some((line) => line.fields?.reason === "deadline")).toBe(false);
      release.resolve("a".repeat(64));
      expect(await invoke(f.def, "echo", f.ctx, { text: "after quarantine" })).toEqual({
        text: "after quarantine", count: 1,
      });
    } finally {
      release.resolve(null);
      await gate.release();
      await probed;
    }
  });

  test.each(["overflow", "replay"])(
    "probe data calls cannot exceed the bounded queue or reuse an accepted callback id: %s",
    async (preparationId) => {
      const f = await referenceFixture({ referenceProbeDeadlineMs: 2_000 });
      const release = Promise.withResolvers<string | null>();
      let reads = 0;
      const probed = f.probe({
        storage: {
          ...f.storage,
          get: async () => { reads += 1; return release.promise; },
        },
        now: () => f.runtime.now(),
      }, { ref: f.ref, preparationId, requestId: 'request', bindingDigest: 'b'.repeat(64), publication: 'prepared' }).catch((error: unknown) => error);
      try {
        expect(await probed).toBeInstanceOf(IsolateDenial);
        expect(f.logger.lines.some((line) => line.fields?.reason === "deadline")).toBe(false);
        expect(reads).toBeLessThanOrEqual(1);
        release.resolve(null);
        expect(await invoke(f.def, "echo", f.ctx, { text: "queue drained" })).toEqual({
          text: "queue drained", count: 1,
        });
      } finally {
        release.resolve(null);
        await probed;
      }
    },
  );

  test("a reference call before input admission cannot reach the host service", async () => {
    const { supervisor, runtime, storage } = fixture();
    const { def } = await supervisor.load({
      pluginId: PLUGIN_ID, manifest, dir: GUEST_DIR, hardenedContract: 10,
    });
    const { ctx } = actionCtx(storage, runtime);
    let spent = false;
    const caller = {
      ...ctx,
      credentialBinding: "b".repeat(64),
      references: { ...ctx.references, publish: async () => { spent = true; throw new Error("must not reach"); } },
    } satisfies ActionCtx;
    expect(await invoke(def, "referenceBeforeAdmission", caller, {})).toEqual({
      denial: "slice_unavailable: references.publish",
    });
    expect(spent).toBe(false);
  });

  test.each(["identity", "references", "receipt", "storage", "parent-answer", "hang"])(
    "a nested readiness probe cannot borrow its waiting action or outlive its deadline: %s",
    async (preparationId) => {
      const { supervisor, runtime, storage } = fixture({ referenceProbeDeadlineMs: 200 });
      const { def } = await supervisor.load({
        pluginId: PLUGIN_ID, manifest, dir: GUEST_DIR, hardenedContract: 10,
      });
      const { ctx } = actionCtx(storage, runtime);
      const probe = def.probeReady;
      if (probe === undefined) throw new Error("missing readiness probe");
      let publications = 0;
      let published = false;
      let identityWrites = 0;
      let receipts = 0;
      const caller = {
        ...ctx,
        credentialBinding: "b".repeat(64),
        identity: { ...ctx.identity, revokeMachine: () => { identityWrites += 1; return { ok: true, value: 1 }; } },
        references: {
          ...ctx.references,
          receipt: async () => { receipts += 1; throw new Error("must not reach"); },
          publish: async () => {
            publications += 1;
            await probe({ storage, now: () => runtime.now() }, { ref: { kind: "file", fileId: "owned" }, preparationId, requestId: 'request', bindingDigest: 'b'.repeat(64), publication: 'prepared' });
            published = true;
            throw new Error("probe unexpectedly returned");
          },
        },
      } satisfies ActionCtx;
      await expect(invoke(def, "reference", caller, { text: preparationId })).rejects.toBeInstanceOf(
        IsolateDenial,
      );
      expect(publications).toBe(1);
      expect(identityWrites).toBe(0);
      expect(receipts).toBe(0);
      expect(published).toBe(false);
      expect(await storage.get("borrowed")).toBeNull();
    },
  );

  test("harness requests use the caller's host slices and stage emissions only after a valid answer", async () => {
    const { supervisor, runtime, storage } = fixture();
    const declared: PluginManifest = {
      ...manifest,
      contributes: {
        ...manifest.contributes,
        harness: {
          id: "test",
          title: "Test",
          profileSchema: {},
          sessionRef: "typed",
        },
      },
    };
    const { def } = await supervisor.load({
      pluginId: PLUGIN_ID,
      manifest: declared,
      dir: GUEST_DIR,
      hardenedContract: 7,
    });
    if (def.harness === undefined) throw new Error("missing harness");
    const { ctx, emitted } = actionCtx(storage, runtime);
    expect(await def.harness.sessions(ctx, { machineId: "m1" })).toEqual([
      { harness: "test", machineId: "m1", sessionId: "s1" },
    ]);
    expect(await storage.get("harness-caller")).toBe(principal.id);
    expect(emitted).toEqual([
      {
        ref: { kind: "plugin", pluginId: PLUGIN_ID },
        kind: "echoed",
        payload: { caller: principal.id },
      },
    ]);
    const deniedCtx = { ...ctx, auth: { ...ctx.auth, allows: () => false } };
    expect(await def.harness.sessions(deniedCtx, { machineId: "m1" })).toEqual([]);
    const ref = { harness: "test", machineId: "m1", sessionId: "s1" };
    expect(await def.harness.resolveSession(ctx, ref)).toEqual(ref);
    expect((await def.harness.profileSchema.safeParseAsync("valid")).success).toBe(true);
  });

  test.each(["side-effect", "emit", "wrong-kind", "wrong-id", "invalid-result", "hang", "boom"])(
    "profile validation fails closed for %s without modifying storage",
    async (profile) => {
      const { supervisor, storage } = fixture({ dispatchDeadlineMs: 500 });
      const declared: PluginManifest = {
        ...manifest,
        contributes: {
          ...manifest.contributes,
          harness: {
            id: "test",
            title: "Test",
            profileSchema: {},
            sessionRef: "typed",
          },
        },
      };
      const { def } = await supervisor.load({
        pluginId: PLUGIN_ID,
        manifest: declared,
        dir: GUEST_DIR,
        hardenedContract: 7,
      });
      if (def.harness === undefined) throw new Error("missing harness");
      await expect(def.harness.profileSchema.safeParseAsync(profile)).rejects.toBeInstanceOf(
        IsolateDenial,
      );
      expect(await storage.get("profile-leak")).toBeNull();
    },
  );

  test("a held caller refuses validation before forged live, stale or future IDs can reach sinks", async () => {
    const f = await harnessFixture();
    const gate = await guestBarrier();
    const held = f.harness.sessions(f.ctx, { machineId: `barrier:${gate.dir}` });
    await gate.entered();
    try {
      await unavailable(
        f.harness.profileSchema.safeParseAsync({
          rawIds: ["r1", "r0", "r3"],
        }),
      );
      expect(await f.storage.get("profile-leak")).toBeNull();
      expect(f.actionEffects()).toBe(0);
      // Refusing a profile does not serialize ordinary dispatches, harness methods or hooks.
      const [echo, sessions] = await Promise.all([
        invoke(f.def, "echo", f.ctx, { text: "concurrent" }),
        f.harness.sessions(f.ctx, { machineId: "other" }),
        f.lifecycle.onEnable?.({
          pluginId: PLUGIN_ID,
          storage: f.storage,
          now: () => f.runtime.now(),
          emit: () => {},
        }),
      ]);
      expect(echo).toEqual({ text: "concurrent", count: 1 });
      expect(sessions).toEqual([{ harness: "test", machineId: "other", sessionId: "s1" }]);
    } finally {
      await gate.release();
      await held;
    }
    expect((await f.harness.profileSchema.safeParseAsync("valid")).success).toBe(true);
  });

  test("held pure validation refuses every request and cannot borrow an unsent caller's ID", async () => {
    const f = await harnessFixture();
    await invoke(f.def, "slice", f.ctx, {});
    const gate = await guestBarrier();
    const validation = f.harness.profileSchema
      .safeParseAsync({
        barrier: gate.dir,
        rawIds: ["r1", "r3", "r2"],
      })
      .catch((error: unknown) => error);
    await gate.entered();
    try {
      await unavailable(f.harness.sessions(f.ctx, { machineId: "unsent" }));
      await unavailable(invoke(f.def, "echo", f.ctx, { text: "unsent" }));
      await unavailable(
        Promise.resolve(
          f.lifecycle.onEnable!({
            pluginId: PLUGIN_ID,
            storage: f.storage,
            now: () => f.runtime.now(),
            emit: () => {},
          }),
        ),
      );
      await unavailable(f.harness.profileSchema.safeParseAsync("valid"));
      expect(await f.storage.get("harness-caller")).toBeNull();
      expect(await f.storage.get("count")).toBeNull();
      expect(f.emitted).toEqual([]);
    } finally {
      await gate.release();
    }
    expect(await validation).toBeInstanceOf(IsolateDenial);
    expect(await f.storage.get("profile-leak")).toBeNull();
    expect(f.actionEffects()).toBe(0);
    expect((await f.harness.profileSchema.safeParseAsync("valid")).success).toBe(true);
    expect(await invoke(f.def, "echo", f.ctx, { text: "after" })).toEqual({
      text: "after",
      count: 1,
    });
  });

  test.each(["r1", "r2", "r3", "unknown"])(
    "exclusive validation fails closed for raw host calls prefixed %s",
    async (id) => {
      const f = await harnessFixture();
      await invoke(f.def, "slice", f.ctx, {});
      await unavailable(f.harness.profileSchema.safeParseAsync({ rawIds: [id] }));
      expect(await f.storage.get("profile-leak")).toBeNull();
      expect(f.actionEffects()).toBe(0);
      expect((await f.harness.profileSchema.safeParseAsync("valid")).success).toBe(true);
    },
  );

  test("validation waits for neither retained producers nor serving calls: it refuses until drained", async () => {
    const f = await harnessFixture();
    let closed = false;
    let onClose = () => {};
    const published: unknown[] = [];
    const close = () => {
      closed = true;
      onClose();
    };
    const ctx = {
      ...f.ctx,
      streams: {
        open: () => ({
          epoch: "epoch",
          get closed() {
            return closed;
          },
          publish: (body: unknown) => {
            published.push(body);
          },
          close,
          onClose: (listener: () => void) => {
            onClose = listener;
            return () => {};
          },
        }),
      },
    } as ActionCtx;
    await f.harness.sessions(ctx, { machineId: "producer" });
    await unavailable(f.harness.profileSchema.safeParseAsync({ rawIds: ["producer"] }));
    expect(published).toEqual([]);
    expect(closed).toBe(false);
    close();
    expect((await f.harness.profileSchema.safeParseAsync("valid")).success).toBe(true);

    const release = Promise.withResolvers<void>();
    const gate = await guestBarrier();
    let serving = false;
    let finished = false;
    const blocked = {
      ...f.ctx,
      storage: {
        ...f.storage,
        set: async (key: string, value: string) => {
          serving = true;
          await release.promise;
          await f.storage.set(key, value);
          finished = true;
        },
      },
    } as ActionCtx;
    const answered = f.harness
      .sessions(blocked, { machineId: `queue-and-answer:${gate.dir}` })
      .catch((error: unknown) => error);
    try {
      await until(() => serving);
      // Ensure the call is serving before the hostile child prematurely answers.
      await gate.release();
      expect(await answered).toBeInstanceOf(IsolateDenial);
      await unavailable(f.harness.profileSchema.safeParseAsync("valid"));
      expect(await f.storage.get("queued")).toBeNull();
    } finally {
      await gate.release();
      release.resolve();
    }
    await until(() => finished);
    expect(await f.storage.get("queued")).toBe("value");
    expect((await f.harness.profileSchema.safeParseAsync("valid")).success).toBe(true);
  });

  test("a host call queued before an early answer cannot use that removed request's ctx", async () => {
    const f = await harnessFixture({ dispatchDeadlineMs: 2_000 });
    const release = Promise.withResolvers<void>();
    const gate = await guestBarrier();
    let serving = false;
    const blocked = {
      ...f.ctx,
      storage: {
        ...f.storage,
        set: async (key: string, value: string) => {
          serving = true;
          await release.promise;
          await f.storage.set(key, value);
        },
      },
    } as ActionCtx;
    const first = f.harness.sessions(blocked, { machineId: "first" });
    try {
      await until(() => serving);
      // This guest enqueues storage.set, then answers while the first call blocks the queue.
      const second = f.harness.sessions(f.ctx, { machineId: `queue-and-answer:${gate.dir}` });
      await gate.entered();
      await gate.release();
      await expect(second).rejects.toMatchObject({ rule: "unavailable" });
      expect(f.supervisor.state(PLUGIN_ID)).toBe("running");
    } finally {
      await gate.release();
      release.resolve();
    }
    await first;
    await f.harness.sessions(f.ctx, { machineId: "after" });
    expect(await f.storage.get("queued")).toBeNull();
  });

  test.each(["deadline", "disconnect", "replacement"])(
    "validation exclusivity clears after %s",
    async (ending) => {
      const f = await harnessFixture({ dispatchDeadlineMs: 2_000 });
      const gate = await guestBarrier();
      const validation = f.harness.profileSchema
        .safeParseAsync({
          barrier: gate.dir,
          disconnect: ending === "disconnect",
        })
        .catch((error: unknown) => error);
      await gate.entered();
      let harness = f.harness;
      let def = f.def;
      if (ending === "replacement") {
        const replacement = await f.supervisor.load(f.ref);
        def = replacement.def;
        harness = replacement.def.harness!;
      } else if (ending === "disconnect") await gate.release();
      expect(await validation).toBeInstanceOf(IsolateDenial);
      if (ending !== "replacement") await until(() => f.supervisor.state(PLUGIN_ID) === "stopped");
      expect((await harness.profileSchema.safeParseAsync("valid")).success).toBe(true);
      expect(await invoke(def, "echo", f.ctx, { text: "recovered" })).toEqual({
        text: "recovered",
        count: 1,
      });
      expect(await f.storage.get("profile-leak")).toBeNull();
      expect(f.actionEffects()).toBe(0);
    },
  );

  test("an older guest declaring a harness retains ordinary actions without gaining harness support", async () => {
    const { supervisor, runtime, storage } = fixture();
    const declared: PluginManifest = {
      ...manifest,
      contributes: {
        ...manifest.contributes,
        harness: {
          id: "test",
          title: "Test",
          profileSchema: {},
          sessionRef: "typed",
        },
      },
    };
    const { def } = await supervisor.load({
      pluginId: PLUGIN_ID,
      manifest: declared,
      dir: GUEST_DIR,
      hardenedContract: 6,
    });
    expect(def.harness).toBeUndefined();
    const { ctx } = actionCtx(storage, runtime);
    expect(await invoke(def, "echo", ctx, { text: "legacy" })).toEqual({
      text: "legacy",
      count: 1,
    });
  });

  test("only contract 8 receives the host-owned immediate caller on real child dispatches", async () => {
    for (const contract of [7, 8]) {
      const { supervisor, runtime, storage } = fixture();
      const { def } = await supervisor.load({
        pluginId: PLUGIN_ID,
        manifest,
        dir: GUEST_DIR,
        hardenedContract: contract,
      });
      const { ctx } = actionCtx(storage, runtime);
      expect(await invoke(def, "identify", ctx, { callerPlugin: "test.forged" })).toEqual({
        present: contract === 8,
        callerPlugin: null,
      });
      if (contract === 8) {
        expect(
          await invoke(
            def,
            "identify",
            { ...ctx, callerPlugin: "test.middle" },
            {
              callerPlugin: "test.forged",
            },
          ),
        ).toEqual({ present: true, callerPlugin: "test.middle" });
      }
    }
  });

  test("a dispatch round-trips through the child, which reaches storage by call, and its emits are re-staged", async () => {
    const { supervisor, runtime, storage } = fixture();
    const { def } = await supervisor.load({ pluginId: PLUGIN_ID, manifest, dir: GUEST_DIR });
    const { ctx, emitted } = actionCtx(storage, runtime);
    // This #536-generation fixture omits any extension handshake and ignores a dispatch whose
    // current strict baseline lacks traceId.

    expect(await invoke(def, "echo", ctx, { text: "hi" })).toEqual({ text: "hi", count: 1 });
    expect(await invoke(def, "echo", ctx, { text: "again" })).toEqual({ text: "again", count: 2 });
    expect(await storage.get("count")).toBe("2");
    expect(emitted).toEqual([
      { ref: { kind: "plugin", pluginId: PLUGIN_ID }, kind: "echoed", payload: { count: 1 } },
      { ref: { kind: "plugin", pluginId: PLUGIN_ID }, kind: "echoed", payload: { count: 2 } },
    ]);
    // A non-storage slice is served from the same dispatch's ctx.
    expect(await invoke(def, "slice", ctx, {})).toBe("id-1");
  });

  test("an isolate without private callbacks still admits independent requests concurrently", async () => {
    const f = fixture();
    const { def } = await f.supervisor.load({
      pluginId: PLUGIN_ID, manifest, dir: GUEST_DIR, hardenedContract: 9,
    });
    const { ctx } = actionCtx(f.storage, f.runtime);
    const gate = await guestBarrier();
    const held = invoke(def, "completeAfterBarrier", ctx, { text: gate.dir });
    try {
      await gate.entered();
      expect(await invoke(def, "echo", ctx, { text: "independent" })).toEqual({
        text: "independent", count: 1,
      });
    } finally {
      await gate.release();
      expect(await held).toEqual({ text: "completed" });
    }
  });

  test("concurrent child dispatches increment durable state without losing an update", async () => {
    const { supervisor, runtime, storage } = fixture();
    const { def } = await supervisor.load({ pluginId: PLUGIN_ID, manifest, dir: GUEST_DIR });
    const { ctx } = actionCtx(storage, runtime);
    const first = await Promise.all([
      invoke(def, "echo", ctx, { text: "concurrent" }),
      invoke(def, "echo", ctx, { text: "concurrent" }),
    ]);
    expect(first).toEqual(
      expect.arrayContaining([
        { text: "concurrent", count: 1 },
        { text: "concurrent", count: 2 },
      ]),
    );
    expect(await storage.get("count")).toBe("2");
    const second = await Promise.all([
      invoke(def, "echo", ctx, { text: "updated" }),
      invoke(def, "echo", ctx, { text: "updated" }),
    ]);
    expect(second).toEqual(
      expect.arrayContaining([
        { text: "updated", count: 3 },
        { text: "updated", count: 4 },
      ]),
    );
    expect(await storage.get("count")).toBe("4");
  });

  test("the child's own verdicts: invalid_args throws the denial, refused returns as data", async () => {
    const { supervisor, runtime, storage } = fixture();
    const { def } = await supervisor.load({ pluginId: PLUGIN_ID, manifest, dir: GUEST_DIR });
    const { ctx } = actionCtx(storage, runtime);

    const denial = await invoke(def, "echo", ctx, { text: 7 }).catch((error: unknown) => error);
    expect(denial).toBeInstanceOf(IsolateDenial);
    expect((denial as IsolateDenial).rule).toBe("invalid_args");
    expect((denial as IsolateDenial).message).toBe("text must be a string");
    expect(await invoke(def, "refuse", ctx, {})).toEqual({ refused: "not today" });
  });

  test("a deny landing mid-handler fences a root dispatch's later effects, not earlier ones", async () => {
    const { supervisor, runtime, storage } = fixture();
    const { def } = await supervisor.load({ pluginId: PLUGIN_ID, manifest, dir: GUEST_DIR });
    const ownerKey = "a".repeat(64);
    const auth = new AuthService(testStore(), ownerKey, runtime);
    const owner = auth.authenticate(ownerKey);
    /*
      The host ctx's `isRoot` is the live evaluator, exactly as `plugin-host` builds it, and the
      guest's `auth.allows` call is where the test lands a real deny on the caller: between the
      dispatch frame (which carried the class as data) and the handler's next ctx call.
    */
    const caller = (caps: Cap[]) => {
      const context = auth.authenticate(
        auth.mintToken({ principal: { name: "caller", kind: "human" }, caps }, owner).token,
      );
      const { ctx, emitted } = actionCtx(storage, runtime);
      const live: ActionCtx = {
        ...ctx,
        auth: {
          ...ctx.auth,
          get isRoot(): boolean {
            return auth.holdsRoot(context);
          },
          allows: () => {
            auth.grant(
              {
                principal: { kind: "principal", id: context.principal.id },
                node: "manifold://container/elsewhere",
                caps: ["containers:write"],
                effect: "deny",
                reach: "subtree",
              },
              owner,
            );
            return true;
          },
        },
      };
      return { ctx: live, emitted };
    };
    const withdrawn = { refused: "root_authority_withdrawn" };

    const root = caller(["*"]);
    expect(await invoke(def, "fenced", root.ctx, { text: "root" })).toEqual(withdrawn);
    // The effect committed under valid authority stays committed; the one after the deny never ran.
    expect(await storage.get("root:first")).toBe("committed");
    expect(await storage.get("root:second")).toBeNull();

    const emitter = caller(["*"]);
    expect(await invoke(def, "fencedEmit", emitter.ctx, { text: "emit" })).toEqual(withdrawn);
    expect(emitter.emitted).toEqual([]);

    // A caller that never held root had nothing to withdraw: the same deny leaves it served.
    const ordinary = caller(["scenes:write"]);
    expect(await invoke(def, "fenced", ordinary.ctx, { text: "ordinary" })).toEqual({
      second: true,
    });
    expect(await storage.get("ordinary:second")).toBe("committed");
    const quiet = caller(["scenes:write"]);
    expect(await invoke(def, "fencedEmit", quiet.ctx, { text: "quiet" })).toEqual({});
    expect(quiet.emitted).toHaveLength(1);
  });

  test("a lifecycle hook is served from its LifecycleCtx and answers the child's verdict", async () => {
    const { supervisor, runtime, storage } = fixture();
    const { lifecycle } = await supervisor.load({ pluginId: PLUGIN_ID, manifest, dir: GUEST_DIR });
    const lifecycleCtx: LifecycleCtx = {
      pluginId: PLUGIN_ID,
      storage,
      now: () => runtime.now(),
      emit: () => {},
    };
    await expect(lifecycle.onEnable?.(lifecycleCtx)).resolves.toBeUndefined();
    await storage.set("enabled", "no");
    await expect(lifecycle.onEnable?.(lifecycleCtx)).rejects.toThrow(
      "onEnable failed in the isolate",
    );
  });

  test("selected onJobSettled stays live past the ordinary dispatch deadline", async () => {
    const { supervisor, runtime, storage, logger } = fixture({
      dispatchDeadlineMs: 120,
      jobSettledTimeouts: { [PLUGIN_ID]: 2_000 },
    });
    const { lifecycle } = await supervisor.load({ pluginId: PLUGIN_ID, manifest, dir: GUEST_DIR });
    const held = heldHookCtx(storage, runtime);
    const hook = lifecycle.onJobSettled!(held.ctx, settledJob);
    try {
      await held.entered;
      const ordinary = fixture({ dispatchDeadlineMs: 120 });
      const other = await ordinary.supervisor.load({
        pluginId: PLUGIN_ID,
        manifest,
        dir: GUEST_DIR,
      });
      const ordinaryHeld = heldHookCtx(ordinary.storage, ordinary.runtime);
      const ordinaryHook = other.lifecycle.onJobSettled!(ordinaryHeld.ctx, settledJob);
      try {
        await ordinaryHeld.entered;
        await expect(ordinaryHook).rejects.toMatchObject({
          rule: "unavailable",
          message: "isolate deadline expired",
        });
      } finally {
        ordinaryHeld.release();
      }
      expect(supervisor.state(PLUGIN_ID)).toBe("running");
      expect(logger.lines.filter((line) => line.fields?.reason === "deadline")).toEqual([]);
    } finally {
      held.release();
    }
    await expect(hook).resolves.toBeUndefined();
    expect(held.reads).toEqual(["metadataProbe", "enabled"]);
  });

  test("unselected onJobSettled still expires at the ordinary dispatch deadline", async () => {
    const { supervisor, runtime, storage, logger } = fixture({
      dispatchDeadlineMs: 120,
      jobSettledTimeouts: { "other.plugin": 2_000 },
    });
    const { lifecycle } = await supervisor.load({ pluginId: PLUGIN_ID, manifest, dir: GUEST_DIR });
    const held = heldHookCtx(storage, runtime);
    const hook = lifecycle.onJobSettled!(held.ctx, settledJob);
    try {
      await held.entered;
      await expect(hook).rejects.toMatchObject({
        rule: "unavailable",
        message: "isolate deadline expired",
      });
      expect(
        logger.lines.find((line) => line.fields?.reason === "deadline")?.fields?.deadlineMs,
      ).toBe(120);
      await until(() => supervisor.state(PLUGIN_ID) === "stopped");
    } finally {
      held.release();
    }
  });

  test("selected policy does not extend other hooks or dispatches", async () => {
    const { supervisor, runtime, storage, logger } = fixture({
      dispatchDeadlineMs: 120,
      jobSettledTimeouts: { [PLUGIN_ID]: 2_000 },
    });
    const { lifecycle, def } = await supervisor.load({
      pluginId: PLUGIN_ID,
      manifest,
      dir: GUEST_DIR,
    });
    const held = heldHookCtx(storage, runtime);
    const hook = lifecycle.onEnable!(held.ctx);
    try {
      await held.entered;
      await expect(hook).rejects.toMatchObject({
        rule: "unavailable",
        message: "isolate deadline expired",
      });
      await until(() => supervisor.state(PLUGIN_ID) === "stopped");
    } finally {
      held.release();
    }
    const { ctx } = actionCtx(storage, runtime);
    await expect(invoke(def, "hang", ctx, {})).rejects.toMatchObject({
      rule: "unavailable",
      message: "isolate deadline expired",
    });
    expect(
      logger.lines
        .filter((line) => line.fields?.reason === "deadline")
        .map((line) => line.fields?.deadlineMs),
    ).toEqual([120, 120]);
  });

  test("selected expiry kills the child, withdraws the ctx and uses the copied finite bound", async () => {
    const policy = { [PLUGIN_ID]: 2_000 };
    const { supervisor, runtime, storage, logger } = fixture({
      dispatchDeadlineMs: 120,
      jobSettledTimeouts: policy,
    });
    policy[PLUGIN_ID] = 60_000;
    const { lifecycle } = await supervisor.load({ pluginId: PLUGIN_ID, manifest, dir: GUEST_DIR });
    await storage.set("metadataProbe", "yes");
    const held = heldHookCtx(storage, runtime, "metadataProbe");
    const hook = lifecycle.onJobSettled!(held.ctx, settledJob);
    try {
      await held.entered;
      await expect(hook).rejects.toMatchObject({
        rule: "unavailable",
        message: "isolate deadline expired",
      });
      expect(
        logger.lines.find((line) => line.fields?.reason === "deadline")?.fields?.deadlineMs,
      ).toBe(3_000);
      await until(() => supervisor.state(PLUGIN_ID) === "stopped");
      expect(logger.lines.find((line) => line.evt === "isolate_exited")?.fields?.signal).toBe(
        "SIGKILL",
      );
    } finally {
      held.release();
    }
    await held.completed;
    expect(held.reads).toEqual(["metadataProbe"]);
    expect(await storage.get("metadataProbeResult")).toBeNull();
  }, 10_000);

  test("strict older guests omit hook metadata and cannot forge its reads; new hooks remain read-only", async () => {
    for (const contract of [1, 9, 11]) {
      const { supervisor, runtime, storage } = fixture();
      const { lifecycle } = await supervisor.load({
        pluginId: PLUGIN_ID,
        manifest,
        dir: GUEST_DIR,
        hardenedContract: contract,
      });
      await storage.set("metadataProbe", "yes");
      const ctx: LifecycleCtx = {
        pluginId: PLUGIN_ID,
        storage,
        now: () => runtime.now(),
        emit: () => {},
        host: { roster: () => [], enabled: () => true },
        services: { listInstances: () => ({ defaultOwner: null, services: [] }) },
        machines: { inventory: () => ({ ok: true, value: { machines: [] } }) },
      };
      for (const settled of [false, true]) {
        if (settled) {
          await lifecycle.onJobSettled!(
            {
              ...ctx,
              jobs: {} as JobSettledCtx["jobs"],
              actions: {} as JobSettledCtx["actions"],
            },
            settledJob,
          );
        } else await lifecycle.onEnable!(ctx);
        expect(JSON.parse((await storage.get("metadataProbeResult"))!)).toEqual({
          announced: contract >= 11,
          "host.enabled": contract >= 11 ? "allowed" : "slice_unavailable: host.enabled",
          "services.listInstances":
            contract >= 11 ? "allowed" : "slice_unavailable: services.listInstances",
          "services.invokeInstance": "slice_unavailable: services.invokeInstance",
          "machines.inventory":
            contract >= 11 ? "allowed" : "slice_unavailable: machines.inventory",
          "machines.drain": "slice_unavailable: machines.drain",
        });
      }
    }
  });

  test("a crash fails the dispatch, respawns on the next one, and the budget ends respawning", async () => {
    const { supervisor, runtime, storage, logger, states } = fixture();
    const { def } = await supervisor.load({ pluginId: PLUGIN_ID, manifest, dir: GUEST_DIR });
    const { ctx } = actionCtx(storage, runtime);

    for (let crash = 1; crash <= 2; crash += 1) {
      const failure = await invoke(def, "boom", ctx, {}).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(IsolateDenial);
      expect((failure as IsolateDenial).rule).toBe("unavailable");
      expect(supervisor.state(PLUGIN_ID)).toBe("stopped");
      // Lazy respawn: the next dispatch brings the child back, storage intact.
      expect(await invoke(def, "echo", ctx, { text: "back" })).toEqual({
        text: "back",
        count: crash,
      });
      expect(supervisor.state(PLUGIN_ID)).toBe("running");
    }
    expect(logger.count("isolate_spawned")).toBe(3);
    expect(
      logger.lines.filter((line) => line.evt === "isolate_exited" && line.fields?.asked === false),
    ).toHaveLength(2);

    await invoke(def, "boom", ctx, {}).catch(() => undefined);
    expect(supervisor.state(PLUGIN_ID)).toBe("crashed");
    expect(logger.count("isolate_crashed")).toBe(1);
    expect(states.at(-1)).toEqual({ state: "crashed", detail: "exit code 1" });

    const refused = await invoke(def, "echo", ctx, { text: "?" }).catch((error: unknown) => error);
    expect((refused as IsolateDenial).rule).toBe("unavailable");
    expect((refused as IsolateDenial).message).toBe("isolate crashed past its budget");
    expect(logger.count("isolate_spawned")).toBe(3);

    // Only unload + load resets the budget.
    await supervisor.unload(PLUGIN_ID);
    await supervisor.load({ pluginId: PLUGIN_ID, manifest, dir: GUEST_DIR });
    expect(supervisor.state(PLUGIN_ID)).toBe("running");
  });

  test("a child that never answers load fails the load and is killed", async () => {
    const { supervisor, logger } = fixture({ dispatchDeadlineMs: 200 });
    const failure = await supervisor
      .load({ pluginId: PLUGIN_ID, manifest, dir: SILENT_GUEST_DIR })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(IsolateLoadError);
    expect(supervisor.state(PLUGIN_ID)).toBe("stopped");
    await until(() => logger.count("isolate_exited") === 1);
    expect(logger.lines.find((line) => line.evt === "isolate_exited")?.fields?.signal).toBe(
      "SIGKILL",
    );
    expect(logger.count("isolate_crashed")).toBe(0);
  });

  test("a malformed child frame is logged and fails the request it names, and nothing else", async () => {
    const { supervisor, runtime, storage, logger } = fixture();
    const { def } = await supervisor.load({ pluginId: PLUGIN_ID, manifest, dir: GUEST_DIR });
    const { ctx } = actionCtx(storage, runtime);

    const failure = await invoke(def, "garble", ctx, {}).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(IsolateDenial);
    expect((failure as IsolateDenial).message).toBe("isolate answered with a malformed frame");
    const logged = logger.lines.find((line) => line.evt === "isolate_call_failed");
    expect(logged?.level).toBe("warn");
    expect(logged?.fields?.reason).toBe("malformed frame");
    // The child is still serving: a frame out of shape is not a crash.
    expect(supervisor.state(PLUGIN_ID)).toBe("running");
    expect(await invoke(def, "echo", ctx, { text: "still" })).toEqual({ text: "still", count: 1 });
  });

  test("an oversized raw child frame is rejected before parsing and terminates the child", async () => {
    const { supervisor, runtime, storage, logger } = fixture();
    const { def } = await supervisor.load({ pluginId: PLUGIN_ID, manifest, dir: GUEST_DIR });
    const { ctx } = actionCtx(storage, runtime);

    const failure = await invoke(def, "oversize", ctx, {}).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(IsolateDenial);
    expect((failure as IsolateDenial).message).toContain("isolate exited");
    await until(() => supervisor.state(PLUGIN_ID) === "stopped");
    const malformed = logger.lines.find(
      (line) => line.evt === "isolate_call_failed" && line.fields?.reason === "malformed frame",
    );
    expect(malformed?.fields?.detail).toContain("frame exceeds");
  });
  test("a child that stops reading host replies is killed before its write queue grows unbounded", async () => {
    const { supervisor, runtime, storage, logger } = fixture({ dispatchDeadlineMs: 2_000 });
    const { def } = await supervisor.load({ pluginId: PLUGIN_ID, manifest, dir: GUEST_DIR });
    const { ctx } = actionCtx(storage, runtime);
    await storage.set("bulk", "x".repeat(64 * 1024));

    const failure = await invoke(def, "backpressure", ctx, {}).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(IsolateDenial);
    expect((failure as IsolateDenial).message).toContain("isolate exited");
    await until(() => supervisor.state(PLUGIN_ID) === "stopped");
    expect(logger.count("isolate_protocol_backpressure")).toBe(1);
  });

  test("a dispatch past the deadline is unavailable and the stuck child is killed", async () => {
    const { supervisor, runtime, storage, logger } = fixture({ dispatchDeadlineMs: 150 });
    const { def } = await supervisor.load({ pluginId: PLUGIN_ID, manifest, dir: GUEST_DIR });
    const { ctx } = actionCtx(storage, runtime);

    const failure = await invoke(def, "hang", ctx, {}).catch((error: unknown) => error);
    expect((failure as IsolateDenial).rule).toBe("unavailable");
    expect((failure as IsolateDenial).message).toBe("isolate deadline expired");
    await until(() => supervisor.state(PLUGIN_ID) === "stopped");
    expect(logger.lines.find((line) => line.evt === "isolate_call_failed")?.fields?.reason).toBe(
      "deadline",
    );
    expect(await invoke(def, "echo", ctx, { text: "after" })).toEqual({ text: "after", count: 1 });
  });

  test("an idle child is evicted and the next dispatch spawns it again", async () => {
    const { supervisor, runtime, storage, logger } = fixture({ idleEvictMs: 100 });
    const { def } = await supervisor.load({ pluginId: PLUGIN_ID, manifest, dir: GUEST_DIR });
    const { ctx } = actionCtx(storage, runtime);

    await until(() => supervisor.state(PLUGIN_ID) === "stopped");
    expect(logger.count("isolate_evicted")).toBe(1);
    await until(() =>
      logger.lines.some((line) => line.evt === "isolate_exited" && line.fields?.asked === true),
    );
    expect(logger.count("isolate_crashed")).toBe(0);
    expect(await invoke(def, "echo", ctx, { text: "morning" })).toEqual({
      text: "morning",
      count: 1,
    });
    expect(logger.count("isolate_spawned")).toBe(2);
  });

  test("unload ends the child and every later dispatch is unavailable", async () => {
    const { supervisor, runtime, storage, logger, states } = fixture();
    const { def } = await supervisor.load({ pluginId: PLUGIN_ID, manifest, dir: GUEST_DIR });
    const { ctx } = actionCtx(storage, runtime);

    await supervisor.unload(PLUGIN_ID);
    expect(supervisor.state(PLUGIN_ID)).toBe("stopped");
    expect(states.at(-1)?.state).toBe("stopped");
    expect(logger.lines.find((line) => line.evt === "isolate_exited")?.fields?.asked).toBe(true);
    const failure = await invoke(def, "echo", ctx, { text: "?" }).catch((error: unknown) => error);
    expect((failure as IsolateDenial).rule).toBe("unavailable");
    expect(logger.count("isolate_spawned")).toBe(1);
  });
});
