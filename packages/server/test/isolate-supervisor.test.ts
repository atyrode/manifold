import { afterEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { LifecycleCtx, PluginStorage } from "@manifold/plugin";
import type { EventKind, EventPayload, ManifoldRef, PluginManifest } from "@manifold/protocol";
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
  > = {
    traceId: 1,
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

afterEach(async () => {
  await Promise.all(open.splice(0).map((supervisor) => supervisor.close()));
});

describe("IsolateSupervisor", () => {
  test("load turns the child's report into a def with local names and only the declared hooks", async () => {
    const { supervisor, logger, states } = fixture();
    const { def, lifecycle } = await supervisor.load({
      pluginId: PLUGIN_ID,
      manifest,
      dir: GUEST_DIR,
    });

    expect(def.manifest).toBe(manifest);
    expect(def.actions.map((action) => action.name).sort()).toEqual([
      "boom",
      "echo",
      "garble",
      "hang",
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
    expect((failure as Error).message).toBe("isolate did not answer load within 200ms");
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
