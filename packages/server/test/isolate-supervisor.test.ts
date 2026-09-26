import { afterEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { LifecycleCtx, PluginStorage } from "@manifold/plugin";
import type { Cap, EventKind, EventPayload, ManifoldRef, PluginManifest } from "@manifold/protocol";
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
    | "principal"
    | "auth"
    | "containerScope"
    | "outsideScope"
    | "storage"
    | "now"
    | "newId"
    | "emit"
    | "admitPrepared"
  > = {
    traceId: 1,
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
  test("load turns the child's report into a def with local names and only the declared hooks", async () => {
    const { supervisor, logger, states } = fixture();
    const { def, lifecycle } = await supervisor.load({
      pluginId: PLUGIN_ID,
      manifest,
      dir: GUEST_DIR,
    });

    expect(def.manifest).toBe(manifest);
    expect(def.actions.map((action) => action.name).sort()).toEqual([
      "backpressure",
      "boom",
      "echo",
      "fenced",
      "fencedEmit",
      "garble",
      "hang",
      "oversize",
      "refuse",
      "slice",
    ]);
    expect(Object.keys(def.handlers).sort()).toEqual(
      def.actions.map((action) => action.name).sort(),
    );
    expect(typeof lifecycle.onEnable).toBe("function");
    expect(lifecycle.onDisable).toBeUndefined();
    expect(def.lifecycle).toBe(lifecycle);
    expect(supervisor.state(PLUGIN_ID)).toBe("running");
    expect(states.map((row) => row.state)).toEqual(["starting", "running"]);
    expect(logger.count("isolate_spawned")).toBe(1);
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
