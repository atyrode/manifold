import type {
  AssemblyDelta,
  JobSettledCtx,
  LifecycleCtx,
  StreamProducer,
  JobFollow,
  PluginDatabase,
  PluginMigration,
  PluginStorage,
} from "@manifold/plugin";
import {
  ISOLATE_CRASH_BUDGET,
  ISOLATE_DISPATCH_DEADLINE_MS,
  ISOLATE_IDLE_EVICT_MS,
  ISOLATE_MAX_FRAME_BYTES,
  ISOLATE_MIGRATION_DEADLINE_MS,
  MAX_MIGRATION_STORAGE_OPERATIONS,
  ManifoldRefSchema,
  IsolateHarnessRequestSchema,
  IsolateHarnessResultSchemas,
  type IsolateHarnessRequest,
  type IsolateDispatchCtx,
  type IsolateChildFrame,
  type IsolateCtxMethod,
  type IsolateHook,
  type IsolateHostFrame,
  type RuntimeDeps,
  type JobFollowUpdate,
  type SettledJob,
} from "@manifold/protocol";
import type { Logger } from "../log.ts";
import type { ActionCtx } from "../plugin-host.ts";
import {
  IsolateDenial,
  IsolateLoadError,
  type InstalledPluginRef,
  type IsolateLoadResult,
  type IsolateRunner,
  type IsolateState,
} from "./contract.ts";
import { IsolateChild } from "./ipc.ts";
import {
  buildIsolateDef,
  serveCtxCall,
  type IsolateDispatchOutcome,
  type IsolateTransport,
  type ServedCtx,
} from "./proxy-def.ts";
import { isDeepStrictEqual } from "node:util";

/**
 * THE SUPERVISOR (ADR 0016 §1, §6): one child process per installed plugin, spawned lazily
 * and kept exactly as long as it is useful. It owns the four things a process boundary
 * adds to a handler call and nothing a handler call already had:
 *
 * - the HANDSHAKE — `load` out, `loaded` back, or the child is not a plugin;
 * - the DEADLINE — every round trip is bounded, and a silent child is killed, because a hung
 *   isolate is a refusal (`unavailable`) rather than a stuck promise;
 * - the CRASH BUDGET — an exit the supervisor did not ask for is counted, and at
 *   `ISOLATE_CRASH_BUDGET` the plugin is `crashed` until an operator unloads and loads it;
 * - IDLE EVICTION — a child that served nothing for `ISOLATE_IDLE_EVICT_MS` is shut down,
 *   and the next dispatch spawns it again (ten installed plugins are ten heaps otherwise).
 *
 * Every `call` a child makes is served from the ctx of the request it is handling, found by
 * the request id the call's own id is prefixed with (`<request>:<n>`), so `auth.allows` is
 * graded as THAT caller and storage is THAT plugin's namespace.
 */

/** How long a child gets between `shutdown` and `SIGKILL`. */
const SHUTDOWN_GRACE_MS = 2_000;

/**
 * THE ROOT FENCE'S REFUSAL (#411). A dispatch or harness frame carries the caller's root class
 * as data, evaluated when the frame was built, and the guest reads that boolean for the rest of
 * the handler. When the frame said root and the host's live answer no longer does — an
 * administered deny landed mid-handler — the host serves nothing more of that request: every
 * further effectful ctx call, and every emission the answer carries, is refused by this name.
 * Effects already committed stay committed, and a stale `false` only ever fails closed.
 */
const ROOT_AUTHORITY_WITHDRAWN = "root_authority_withdrawn";

/** Correlated calls that release a request's resources rather than exercise authority. */
const ROOT_FENCE_EXEMPT: Partial<Record<IsolateCtxMethod, true>> = {
  "jobs.ack": true,
  "jobs.unfollow": true,
  "streams.close": true,
};

type LoadedFrame = Extract<IsolateChildFrame, { t: "loaded" }>;
type AnsweredFrame = Extract<
  IsolateChildFrame,
  { t: "dispatched" | "harnessed" | "hooked" | "migrated" }
>;

/** One round trip awaiting its answer, with the ctx that serves the child's calls meanwhile. */
interface Pending {
  readonly served: ServedCtx | null;
  readonly request: IsolateHostFrame;
  serving: number;
  admitted: boolean;
  readonly answer: (frame: AnsweredFrame) => void;
  readonly fail: (error: Error) => void;
}

/** The `load` handshake in flight. */
interface Handshake {
  readonly resolve: (frame: LoadedFrame) => void;
  readonly reject: (error: IsolateLoadError) => void;
}

interface JobObserver {
  follow: JobFollow | null;
  delivery: number;
  readonly unacknowledged: number[];
}

/** Everything the supervisor keeps per loaded plugin. */
class Isolate {
  state: IsolateState = "stopped";
  /** The process serving this plugin right now; null while stopped, evicted, or crashed. */
  child: IsolateChild | null = null;
  /** The in-flight spawn, shared by every request that arrives while it settles. */
  starting: Promise<void> | null = null;
  handshake: Handshake | null = null;
  /** The child's first report; a respawn's is not consulted, the bundle is pinned by hash. */
  loaded: LoadedFrame | null = null;
  readonly pending = new Map<string, Pending>();
  callTail: Promise<void> = Promise.resolve();
  queuedCalls = 0;
  queuedCallBytes = 0;
  migration: { readonly id: string; readonly calls: Set<string> } | null = null;
  /** A context-free validation owns the drained guest until its request settles. */
  validation: { readonly id: string; violated: boolean } | null = null;
  readonly producers = new Map<string, StreamProducer>();
  readonly jobObservers = new Map<string, JobObserver>();
  nextProducer = 0;
  /** Unasked-for exits inside the budget window, as `runtime.now()` stamps. */
  crashes: number[] = [];
  /** Cancels the armed idle-eviction timer; a closure, so no platform timer type is named. */
  cancelIdle: (() => void) | null = null;
  nextRequest = 0;

  constructor(readonly ref: InstalledPluginRef) {}
}

export interface IsolateSupervisorDeps {
  readonly logger: Logger;
  readonly runtime: RuntimeDeps;
  /** The runner's numbers, defaulting to the protocol's; a test narrows them. */
  readonly dispatchDeadlineMs?: number;
  readonly idleEvictMs?: number;
  readonly migrationDeadlineMs?: number;
  readonly crashBudget?: { readonly count: number; readonly windowMs: number };
}

export class IsolateSupervisor implements IsolateRunner {
  private readonly isolates = new Map<string, Isolate>();
  /**
   * Children the supervisor itself told to go — by unload, eviction, or after a failed
   * handshake. Their exit is not a crash and their late frames are noise. Keyed by process
   * rather than flagged on the isolate because a replacement may already be running while
   * the old process finishes exiting.
   */
  private readonly retired = new WeakSet<IsolateChild>();
  private readonly listeners = new Set<
    (pluginId: string, state: IsolateState, detail?: string) => void
  >();
  private readonly logger: Logger;
  private readonly runtime: RuntimeDeps;
  private readonly dispatchDeadlineMs: number;
  private readonly idleEvictMs: number;
  private readonly migrationDeadlineMs: number;
  private readonly crashBudget: { readonly count: number; readonly windowMs: number };
  private closed = false;

  constructor(deps: IsolateSupervisorDeps) {
    this.logger = deps.logger;
    this.runtime = deps.runtime;
    this.dispatchDeadlineMs = deps.dispatchDeadlineMs ?? ISOLATE_DISPATCH_DEADLINE_MS;
    this.idleEvictMs = deps.idleEvictMs ?? ISOLATE_IDLE_EVICT_MS;
    this.migrationDeadlineMs = deps.migrationDeadlineMs ?? ISOLATE_MIGRATION_DEADLINE_MS;
    this.crashBudget = deps.crashBudget ?? ISOLATE_CRASH_BUDGET;
  }

  async load(ref: InstalledPluginRef): Promise<IsolateLoadResult> {
    if (this.closed) throw new IsolateLoadError("the supervisor is closed");
    if (this.isolates.has(ref.pluginId)) await this.unload(ref.pluginId);
    const isolate = new Isolate(ref);
    this.isolates.set(ref.pluginId, isolate);
    try {
      await this.ensureRunning(isolate);
    } catch (error) {
      // Only this record: an unload during the handshake may already have replaced it.
      if (this.isolates.get(ref.pluginId) === isolate) this.isolates.delete(ref.pluginId);
      this.transition(isolate, "stopped");
      if (error instanceof IsolateLoadError) throw error;
      throw new IsolateLoadError(error instanceof Error ? error.message : String(error));
    }
    if (this.isolates.get(ref.pluginId) !== isolate) {
      throw new IsolateLoadError("isolate unloaded during load");
    }
    if (isolate.loaded === null) throw new IsolateLoadError("the child reported no load");
    const pluginId = ref.pluginId;
    const transport: IsolateTransport = {
      dispatch: (action, args, ctx) => this.dispatch(pluginId, action, args, ctx),
      harness: (request, ctx) => this.harness(isolate, request, ctx),
      hook: (hook, ctx, delta) => this.hook(pluginId, hook, ctx, delta),
      settled: (ctx, job) => this.settled(pluginId, ctx, job),
      migrate: (migration, storage, database) =>
        this.migrate(isolate, migration, storage, database),
    };
    try {
      return buildIsolateDef(ref.manifest, isolate.loaded, transport);
    } catch (error) {
      await this.unload(pluginId);
      throw error;
    }
  }

  async unload(pluginId: string): Promise<void> {
    const isolate = this.isolates.get(pluginId);
    if (isolate === undefined) return;
    this.isolates.delete(pluginId);
    this.clearIdle(isolate);
    const child = isolate.child;
    isolate.child = null;
    isolate.handshake?.reject(new IsolateLoadError("isolate unloaded during load"));
    this.failAll(isolate, new IsolateDenial("unavailable", "isolate unloaded"));
    if (child !== null) await this.retire(child);
    this.transition(isolate, "stopped");
  }

  state(pluginId: string): IsolateState {
    return this.isolates.get(pluginId)?.state ?? "stopped";
  }

  onState(listener: (pluginId: string, state: IsolateState, detail?: string) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.isolates.keys()].map((pluginId) => this.unload(pluginId)));
  }

  // ---------------------------------------------------------------- the proxies' transport

  private async dispatch(
    pluginId: string,
    action: string,
    args: unknown,
    ctx: ActionCtx,
  ): Promise<IsolateDispatchOutcome> {
    const frame = await this.request(
      pluginId,
      (id) => ({
        t: "dispatch",
        id,
        action,
        args,
        ctx: this.dispatchCtx(pluginId, ctx),
      }),
      { kind: "dispatch", ctx },
    );
    if (frame.t !== "dispatched") {
      this.logger.warn("isolate_call_failed", {
        plugin: pluginId,
        id: frame.id,
        reason: "a dispatch was answered with a hook frame",
      });
      throw new IsolateDenial("unavailable", "isolate answered out of protocol");
    }
    return frame.outcome;
  }

  private dispatchCtx(pluginId: string, ctx: ActionCtx): IsolateDispatchCtx {
    return {
      traceId: ctx.traceId,
      principal: ctx.principal,
      caps: [...ctx.auth.caps],
      isRoot: ctx.auth.isRoot,
      containerScope: ctx.containerScope,
      ...((this.isolates.get(pluginId)?.ref.hardenedContract ?? 0) >= 6
        ? { agentRun: ctx.agentRun }
        : {}),
      now: ctx.now(),
    };
  }

  private async harness(
    isolate: Isolate,
    request: IsolateHarnessRequest,
    ctx?: ActionCtx,
  ): Promise<IsolateDispatchOutcome> {
    const { pluginId } = isolate.ref;
    if (
      this.isolates.get(pluginId) !== isolate ||
      (isolate.ref.hardenedContract ?? 1) < 7 ||
      isolate.loaded?.harness === undefined
    )
      throw new IsolateDenial("unavailable", "harness unavailable");
    const parsed = IsolateHarnessRequestSchema.parse(request);
    if ((parsed.method === "validateProfile") !== (ctx === undefined))
      throw new IsolateDenial("unavailable", "invalid harness caller context");
    const frame = await this.request(
      pluginId,
      (id) => ({
        t: "harness",
        id,
        request: parsed,
        ...(ctx === undefined ? {} : { ctx: this.dispatchCtx(pluginId, ctx) }),
      }),
      ctx === undefined ? null : { kind: "dispatch", ctx },
    );
    if (
      frame.t !== "harnessed" ||
      (frame.outcome.ok &&
        (!IsolateHarnessResultSchemas[parsed.method].safeParse(frame.outcome.result).success ||
          (ctx === undefined && frame.outcome.emits.length !== 0)))
    )
      throw new IsolateDenial("unavailable", "harness answered out of protocol");
    return frame.outcome;
  }

  private async hook(
    pluginId: string,
    hook: IsolateHook,
    ctx: LifecycleCtx,
    delta?: AssemblyDelta,
  ): Promise<void> {
    await this.hooked(
      pluginId,
      hook,
      (id) => ({
        t: "hook",
        id,
        hook,
        ...(delta === undefined
          ? {}
          : { delta: { enabled: [...delta.enabled], disabled: [...delta.disabled] } }),
        // The child's ctx mirrors the host's: a slice the host cannot serve is not announced.
        ...(ctx.jobs === undefined ? {} : { jobs: true }),
      }),
      { kind: "hook", ctx },
    );
  }
  /** The settled hook carries the job slice, so its child calls are served from that ctx. */
  private async settled(pluginId: string, ctx: JobSettledCtx, job: SettledJob): Promise<void> {
    await this.hooked(
      pluginId,
      "onJobSettled",
      (id) => ({ t: "hook", id, hook: "onJobSettled", job }),
      { kind: "settled", ctx },
    );
  }
  private async hooked(
    pluginId: string,
    hook: IsolateHook,
    build: (id: string) => IsolateHostFrame,
    served: ServedCtx,
  ): Promise<void> {
    const frame = await this.request(pluginId, build, served);
    if (frame.t !== "hooked") {
      this.logger.warn("isolate_call_failed", {
        plugin: pluginId,
        id: frame.id,
        reason: "a hook was answered with a dispatch frame",
      });
      throw new IsolateDenial("unavailable", "isolate answered out of protocol");
    }
    if (!frame.ok) throw new Error(frame.error ?? `${hook} failed in the isolate`);
  }

  private async migrate(
    isolate: Isolate,
    migration: Pick<PluginMigration, "name" | "to">,
    storage: PluginStorage,
    database?: PluginDatabase,
  ): Promise<void> {
    if (this.isolates.get(isolate.ref.pluginId) !== isolate)
      throw new IsolateDenial("unavailable", "migration belongs to a retired plugin");
    if (
      isolate.pending.size !== 0 ||
      isolate.producers.size !== 0 ||
      isolate.jobObservers.size !== 0
    )
      throw new IsolateDenial("unavailable", "migration requires a drained guest");
    const frame = await this.request(
      isolate.ref.pluginId,
      (id) => ({ t: "migrate", id, migration }),
      { kind: "migration", ctx: { storage, ...(database === undefined ? {} : { database }) } },
    );
    if (frame.t !== "migrated" || frame.name !== migration.name)
      throw new IsolateDenial("unavailable", "migration answered out of protocol");
    if (!frame.outcome.ok) throw new Error(frame.outcome.error);
  }

  /**
   * One round trip: a running child (spawned now if it was evicted), a fresh id, the frame,
   * and the answer inside the deadline. The pending entry holds the request's ctx for the
   * child's calls until the answer arrives or the request fails — by deadline, by exit, or
   * by unload — and the idle clock restarts when nothing is in flight. Hooks ride the same
   * deadline as a backstop behind `runHook`'s own 2 s: the engine stops waiting at two
   * seconds, and the supervisor stops holding the ctx — and kills the child — at ten.
   */
  private async request(
    pluginId: string,
    build: (id: string) => IsolateHostFrame,
    served: ServedCtx | null,
  ): Promise<AnsweredFrame> {
    const isolate = this.isolates.get(pluginId);
    if (isolate === undefined) throw new IsolateDenial("unavailable", "isolate is not loaded");
    try {
      await this.ensureRunning(isolate);
    } catch (error) {
      if (error instanceof IsolateDenial) throw error;
      throw new IsolateDenial(
        "unavailable",
        error instanceof Error ? error.message : String(error),
      );
    }
    const child = isolate.child;
    if (child === null || this.isolates.get(pluginId) !== isolate) {
      throw new IsolateDenial("unavailable", "isolate unloaded");
    }
    if (isolate.validation !== null)
      throw new IsolateDenial("unavailable", "profile validation requires exclusive guest access");
    if (
      isolate.migration !== null ||
      ((served === null || served.kind === "migration") &&
        (isolate.pending.size !== 0 ||
          isolate.queuedCalls !== 0 ||
          isolate.producers.size !== 0 ||
          isolate.jobObservers.size !== 0))
    )
      throw new IsolateDenial("unavailable", "exclusive request requires a drained guest");
    isolate.nextRequest += 1;
    const id = `r${String(isolate.nextRequest)}`;
    this.clearIdle(isolate);
    const deadline = setTimeout(
      () => this.expire(isolate, id),
      served?.kind === "migration" ? this.migrationDeadlineMs : this.dispatchDeadlineMs,
    );
    try {
      const { promise, resolve, reject } = Promise.withResolvers<AnsweredFrame>();
      const request = build(id);
      if (served?.kind === "migration") isolate.migration = { id, calls: new Set() };
      if (served === null) isolate.validation = { id, violated: false };
      // Sending and registration are synchronous; no child frame can interleave them.
      // A failed send must not expose an unsent request's authority even for one microtask.
      if (!child.send(request)) throw new IsolateDenial("unavailable", "isolate exited");
      isolate.pending.set(id, {
        served,
        request,
        serving: 0,
        admitted: request.t === "harness" && served !== null,
        answer: resolve,
        fail: reject,
      });
      return await promise;
    } finally {
      clearTimeout(deadline);
      isolate.pending.delete(id);
      if (isolate.migration?.id === id) isolate.migration = null;
      if (isolate.validation?.id === id) isolate.validation = null;
      this.armIdle(isolate);
    }
  }

  // ---------------------------------------------------------------- the process lifecycle

  /** Resolves once a child is serving: the current one, the one being spawned, or a new one. */
  private ensureRunning(isolate: Isolate): Promise<void> {
    if (isolate.state === "crashed") {
      return Promise.reject(new IsolateDenial("unavailable", "isolate crashed past its budget"));
    }
    if (isolate.state === "running" && isolate.child !== null) return Promise.resolve();
    if (isolate.starting !== null) return isolate.starting;
    const starting = this.spawn(isolate).finally(() => {
      if (isolate.starting === starting) isolate.starting = null;
    });
    isolate.starting = starting;
    return starting;
  }

  /**
   * THE LOADER: spawn, send `load`, await `loaded` inside the deadline. A `load_failed`, a
   * silence, or an exit before the answer all fail the same way; on a respawn that failure
   * counts against the budget, because a plugin that cannot come back up is crashing.
   */
  private async spawn(isolate: Isolate): Promise<void> {
    const { pluginId, manifest, dir } = isolate.ref;
    const respawn = isolate.loaded !== null;
    this.transition(isolate, "starting");
    let child: IsolateChild;
    try {
      child = IsolateChild.spawn(pluginId, dir, this.logger, {
        frame: (from, frame) => this.onFrame(isolate, from, frame),
        malformed: (from, detail, id) => this.onMalformed(isolate, from, detail, id),
        exit: (from, code, signal) => this.onExit(isolate, from, code, signal),
      });
    } catch (error) {
      // No process at all (no interpreter): the same verdict as one that will not come up.
      if (respawn) this.recordCrash(isolate, error instanceof Error ? error.message : "no spawn");
      else this.transition(isolate, "stopped");
      throw error;
    }
    isolate.child = child;
    this.logger.info("isolate_spawned", { plugin: pluginId, pid: child.pid, respawn });
    let cancelDeadline = (): void => {};
    try {
      const loaded = await new Promise<LoadedFrame>((resolve, reject) => {
        isolate.handshake = { resolve, reject };
        const deadline = setTimeout(() => {
          reject(
            new IsolateLoadError(
              `isolate did not answer load within ${String(this.dispatchDeadlineMs)}ms`,
            ),
          );
        }, this.dispatchDeadlineMs);
        cancelDeadline = (): void => {
          clearTimeout(deadline);
        };
        const load: IsolateHostFrame = { t: "load", pluginId, manifest, dir };
        if ((isolate.ref.hardenedContract ?? 1) >= 2)
          load.hardenedContract = isolate.ref.hardenedContract;
        if (!child.send(load)) {
          reject(new IsolateLoadError("isolate exited before load"));
        }
      });
      if ((isolate.ref.hardenedContract ?? 1) < 7 && loaded.harness !== undefined)
        throw new IsolateLoadError("harness requires hardened contract 7");
      if (
        (isolate.ref.hardenedContract ?? 1) >= 7 &&
        manifest.contributes?.harness !== undefined &&
        loaded.harness === undefined
      )
        throw new IsolateLoadError("declared harness was not loaded");
      if (isolate.loaded !== null && !isDeepStrictEqual(isolate.loaded.harness, loaded.harness))
        throw new IsolateLoadError("respawn changed harness metadata");
      if (isolate.loaded === null) isolate.loaded = loaded;
    } catch (error) {
      if (isolate.child === child) {
        // Still attached: the child is alive but not a plugin. Its exit must not count twice.
        isolate.child = null;
        this.retired.add(child);
        child.kill();
        if (respawn)
          this.recordCrash(isolate, error instanceof Error ? error.message : "load failed");
        else this.transition(isolate, "stopped");
      }
      throw error;
    } finally {
      isolate.handshake = null;
      cancelDeadline();
    }
    if (isolate.child !== child) throw new IsolateDenial("unavailable", "isolate unloaded");
    this.transition(isolate, "running");
    this.armIdle(isolate);
  }

  /** `shutdown`, then `SIGKILL` after the grace; resolves once the process is gone. */
  private async retire(child: IsolateChild): Promise<void> {
    this.retired.add(child);
    if (!child.send({ t: "shutdown" })) return child.closed;
    const grace = setTimeout(() => child.kill(), SHUTDOWN_GRACE_MS);
    try {
      await child.closed;
    } finally {
      clearTimeout(grace);
    }
  }

  private onExit(
    isolate: Isolate,
    child: IsolateChild,
    code: number | null,
    signal: string | null,
  ): void {
    const fields = { plugin: isolate.ref.pluginId, pid: child.pid, code, signal };
    if (this.retired.has(child)) {
      this.logger.info("isolate_exited", { ...fields, asked: true });
      return;
    }
    this.logger.warn("isolate_exited", { ...fields, asked: false });
    if (isolate.child !== child) return;
    isolate.child = null;
    this.clearIdle(isolate);
    const detail = signal === null ? `exit code ${String(code)}` : `signal ${signal}`;
    this.failAll(isolate, new IsolateDenial("unavailable", `isolate exited (${detail})`));
    isolate.handshake?.reject(new IsolateLoadError(`isolate exited before load (${detail})`));
    /*
      An exit before the FIRST `loaded` is the load's failure to report, not a crash: the
      record is discarded by `load` and there is no budget to spend. A respawn that dies
      before answering is the same event as one that dies after — the plugin is not staying up.
     */
    if (isolate.loaded === null) return;
    this.recordCrash(isolate, detail);
  }

  /**
   * THE CRASH POLICY, as data (ADR 0016 §6): exits inside the window are counted, and at the
   * budget the plugin stops respawning and the roster says so. Under the budget the state is
   * `stopped`, which is the same state eviction leaves — the next dispatch spawns.
   */
  private recordCrash(isolate: Isolate, detail: string): void {
    const now = this.runtime.now();
    isolate.crashes = isolate.crashes.filter((at) => now - at < this.crashBudget.windowMs);
    isolate.crashes.push(now);
    if (isolate.crashes.length < this.crashBudget.count) {
      this.transition(isolate, "stopped", detail);
      return;
    }
    this.logger.error("isolate_crashed", {
      plugin: isolate.ref.pluginId,
      exits: isolate.crashes.length,
      windowMs: this.crashBudget.windowMs,
      detail,
    });
    this.transition(isolate, "crashed", detail);
  }

  /** The deadline: the request answers `unavailable` and the child that sat on it is killed. */
  private expire(isolate: Isolate, id: string): void {
    const pending = isolate.pending.get(id);
    if (pending === undefined) return;
    this.logger.warn("isolate_call_failed", {
      plugin: isolate.ref.pluginId,
      id,
      reason: "deadline",
      deadlineMs: this.dispatchDeadlineMs,
    });
    // Validation cannot release its fence while the timed-out guest can still send frames.
    // The killed child's drained exit fails the request and clears the phase together.
    if (isolate.validation?.id === id) isolate.validation.violated = true;
    else pending.fail(new IsolateDenial("unavailable", "isolate deadline expired"));
    // A stuck isolate is a crash: the kill is unasked-for on purpose, so the exit counts.
    isolate.child?.kill();
  }

  private failAll(isolate: Isolate, error: IsolateDenial): void {
    for (const pending of isolate.pending.values()) pending.fail(error);
    isolate.validation = null;
    for (const producer of isolate.producers.values()) producer.close();
    isolate.producers.clear();
    for (const observer of isolate.jobObservers.values()) observer.follow?.close();
    isolate.jobObservers.clear();
  }

  // ---------------------------------------------------------------- inbound frames

  private onFrame(isolate: Isolate, child: IsolateChild, frame: IsolateChildFrame): void {
    if (isolate.child !== child) return;
    // A violating child stays fenced until exit fails its validation. In particular, a
    // buffered answer cannot release the phase between SIGKILL and the drained exit event.
    if (isolate.validation?.violated) return;
    switch (frame.t) {
      case "received":
        if (!child.received(frame.receipt)) {
          this.logger.warn("isolate_call_failed", {
            plugin: isolate.ref.pluginId,
            reason: "invalid frame receipt",
          });
          child.kill();
        }
        return;
      case "loaded":
        if (isolate.handshake === null) {
          this.failMigration(isolate, "loaded frame outside the load handshake");
          return;
        }
        isolate.handshake.resolve(frame);
        return;
      case "load_failed":
        if (isolate.handshake === null) {
          this.failMigration(isolate, "load_failed frame outside the load handshake");
          return;
        }
        isolate.handshake.reject(new IsolateLoadError(frame.error));
        return;
      case "prepared": {
        const pending = isolate.pending.get(frame.id);
        if (
          pending === undefined ||
          pending.request.t !== "dispatch" ||
          pending.served?.kind !== "dispatch" ||
          pending.admitted ||
          pending.serving !== 0
        ) {
          pending?.fail(new IsolateDenial("unavailable", "isolate prepared out of protocol"));
          isolate.pending.delete(frame.id);
          child.send({ t: "admitted", id: frame.id, allowed: false });
          return;
        }
        try {
          if (pending.served.ctx.admitPrepared === undefined)
            throw new IsolateDenial("unavailable", "isolate has no admission continuation");
          pending.served.ctx.admitPrepared(frame.targets);
          pending.admitted = true;
          child.send({ t: "admitted", id: frame.id, allowed: true });
        } catch (error) {
          pending.fail(error instanceof Error ? error : new Error("isolate admission failed"));
          isolate.pending.delete(frame.id);
          child.send({ t: "admitted", id: frame.id, allowed: false });
        }
        return;
      }
      case "dispatched":
      case "harnessed":
      case "migrated":
      case "hooked": {
        const pending = isolate.pending.get(frame.id);
        if (pending === undefined) {
          this.logger.warn("isolate_call_failed", {
            plugin: isolate.ref.pluginId,
            id: frame.id,
            reason: "answer to no request",
          });
          this.failMigration(isolate, "answer to no migration request");
          return;
        }
        const expected =
          pending.request.t === "dispatch"
            ? "dispatched"
            : pending.request.t === "hook"
              ? "hooked"
              : pending.request.t === "harness"
                ? "harnessed"
                : "migrated";
        if (
          frame.t !== expected ||
          (frame.t === "dispatched" &&
            !pending.admitted &&
            (frame.outcome.ok || frame.outcome.rule !== "invalid_args")) ||
          (pending.request.t === "harness" &&
            (pending.serving !== 0 ||
              (frame.t === "harnessed" &&
                frame.outcome.ok &&
                (!IsolateHarnessResultSchemas[pending.request.request.method].safeParse(
                  frame.outcome.result,
                ).success ||
                  (pending.served === null && frame.outcome.emits.length !== 0))))) ||
          (pending.request.t === "migrate" &&
            (frame.t !== "migrated" ||
              frame.name !== pending.request.migration.name ||
              pending.serving !== 0))
        ) {
          pending.fail(new IsolateDenial("unavailable", "isolate answered out of protocol"));
        } else {
          pending.answer(
            frame.t !== "migrated" &&
              frame.t !== "hooked" &&
              frame.outcome.ok &&
              frame.outcome.emits.length !== 0 &&
              this.rootWithdrawn(pending)
              ? {
                  ...frame,
                  outcome: { ok: false, rule: "refused", message: ROOT_AUTHORITY_WITHDRAWN },
                }
              : frame,
          );
        }
        isolate.pending.delete(frame.id);
        return;
      }
      case "call": {
        if (isolate.validation !== null) {
          isolate.validation.violated = true;
          this.logger.warn("isolate_call_failed", {
            plugin: isolate.ref.pluginId,
            id: isolate.validation.id,
            reason: "profile validation cannot call host slices",
          });
          // Check the phase before correlating an untrusted call ID or entering the queue:
          // stale/future IDs and retained producer/observer IDs are not alternate authority.
          // Exit owns failure so no new request is admitted while this child is dying.
          child.kill();
          return;
        }
        const bytes = Buffer.byteLength(JSON.stringify(frame));
        if (
          isolate.queuedCalls >= 256 ||
          isolate.queuedCallBytes + bytes > ISOLATE_MAX_FRAME_BYTES * 2
        ) {
          this.logger.warn("isolate_protocol_backpressure", {
            plugin: isolate.ref.pluginId,
            queuedCalls: isolate.queuedCalls,
            queuedCallBytes: isolate.queuedCallBytes,
          });
          child.kill();
          return;
        }
        const separator = frame.id.lastIndexOf(":");
        const pending =
          separator === -1 ? undefined : isolate.pending.get(frame.id.slice(0, separator));
        if (pending !== undefined) pending.serving += 1;
        isolate.queuedCalls += 1;
        isolate.queuedCallBytes += bytes;
        const serve = async (): Promise<void> => {
          try {
            if (isolate.child === child) await this.serve(isolate, child, frame, pending);
          } finally {
            if (pending !== undefined && pending.serving > 0) pending.serving -= 1;
            isolate.queuedCalls -= 1;
            isolate.queuedCallBytes -= bytes;
          }
        };
        isolate.callTail = isolate.callTail.then(serve, serve);
        return;
      }
      default: {
        const exhaustive: never = frame;
        throw new Error(`unhandled child frame ${String(exhaustive)}`);
      }
    }
  }

  /**
   * A message that is not a frame. The request it named — by the `id` it carried, or the
   * handshake if it carried none while one was open — fails, because a peer that answers
   * out of shape has not answered; nothing else is disturbed.
   */
  private onMalformed(
    isolate: Isolate,
    child: IsolateChild,
    detail: string,
    id: string | null,
  ): void {
    if (isolate.child !== child) return;
    if (isolate.validation?.violated) return;
    this.logger.warn("isolate_call_failed", {
      plugin: isolate.ref.pluginId,
      id,
      reason: "malformed frame",
      detail,
    });
    const pending = id === null ? undefined : isolate.pending.get(id);
    if (this.failMigration(isolate, "malformed migration frame")) return;
    if (pending !== undefined) {
      pending.fail(new IsolateDenial("unavailable", "isolate answered with a malformed frame"));
      return;
    }
    if (id === null) {
      isolate.handshake?.reject(new IsolateLoadError(`malformed frame during load: ${detail}`));
    }
  }

  private failMigration(isolate: Isolate, detail: string): boolean {
    const migration = isolate.migration;
    if (migration === null) return false;
    const pending = isolate.pending.get(migration.id);
    if (pending === undefined) return false;
    pending.fail(new IsolateDenial("unavailable", detail));
    isolate.pending.delete(migration.id);
    return true;
  }

  /** Serves one `call` from the ctx of the request its id is prefixed with. */
  private async serve(
    isolate: Isolate,
    child: IsolateChild,
    frame: Extract<IsolateChildFrame, { t: "call" }>,
    pending: Pending | undefined,
  ): Promise<void> {
    let reply: IsolateHostFrame;
    const migration = isolate.migration;
    try {
      if (
        pending?.served?.kind === "dispatch" &&
        (!pending.admitted ||
          (pending.request.t !== "dispatch" && pending.request.t !== "harness") ||
          isolate.pending.get(pending.request.id) !== pending)
      )
        throw new Error("dispatch has not been admitted");
      if (
        pending !== undefined &&
        ROOT_FENCE_EXEMPT[frame.method] !== true &&
        this.rootWithdrawn(pending)
      )
        throw new Error(ROOT_AUTHORITY_WITHDRAWN);
      if (migration !== null) {
        if (
          pending?.served?.kind !== "migration" ||
          !(frame.method.startsWith("storage.") || frame.method.startsWith("database.")) ||
          migration.calls.has(frame.id) ||
          migration.calls.size >= MAX_MIGRATION_STORAGE_OPERATIONS
        ) {
          this.failMigration(isolate, "invalid migration data call");
          throw new Error(
            "migration may call only its own storage and database with fresh call ids",
          );
        }
        migration.calls.add(frame.id);
      }
      // `pending.serving` was claimed synchronously when the frame entered the bounded queue.
      let result: unknown;
      if (frame.method === "jobs.ack" || frame.method === "jobs.unfollow") {
        const id = frame.args[0];
        const observer = typeof id === "string" ? isolate.jobObservers.get(id) : undefined;
        if (observer !== undefined && typeof id === "string") {
          if (frame.method === "jobs.unfollow") {
            isolate.jobObservers.delete(id);
            observer.follow?.close();
            this.armIdle(isolate);
          } else {
            if (frame.args[1] !== observer.unacknowledged[0]) {
              isolate.jobObservers.delete(id);
              observer.follow?.close();
              throw new Error("invalid job observation acknowledgement");
            }
            observer.unacknowledged.shift();
          }
        }
      } else if (frame.method === "streams.publish" || frame.method === "streams.close") {
        const id = frame.args[0];
        const producer = typeof id === "string" ? isolate.producers.get(id) : undefined;
        if (frame.method === "streams.publish") {
          if (producer === undefined) throw new Error("no such stream producer");
          producer.publish(frame.args[1]);
        } else producer?.close();
      } else if (pending === undefined || pending.served === null) {
        throw new Error("no such request");
      } else if (frame.method === "streams.open") {
        if (pending.served.kind !== "dispatch") throw new Error("slice_unavailable: streams.open");
        if (isolate.producers.size >= 256) throw new Error("too many stream producers");
        const kind = frame.args[0];
        if (typeof kind !== "string") throw new Error("streams.open requires a kind");
        const producer = pending.served.ctx.streams.open(
          kind,
          ManifoldRefSchema.parse(frame.args[1]),
        );
        const id = `p${String(++isolate.nextProducer)}`;
        isolate.producers.set(id, producer);
        this.clearIdle(isolate);
        const ownerChild = child;
        producer.onClose(() => {
          isolate.producers.delete(id);
          if (isolate.child === ownerChild) ownerChild.send({ t: "producer_closed", id });
          this.armIdle(isolate);
        });
        result = { id, epoch: producer.epoch };
      } else if (frame.method === "jobs.follow") {
        if (pending.served.kind !== "dispatch") throw new Error("slice_unavailable: jobs.follow");
        const id = frame.args[1];
        if (typeof id !== "string" || !/^j[0-9]{1,12}$/.test(id) || isolate.jobObservers.has(id))
          throw new Error("invalid job observation identity");
        if (isolate.jobObservers.size >= 16) throw new Error("too many job observations");
        const node = ManifoldRefSchema.parse(frame.args[0]);
        if (node.kind !== "job") throw new Error("job observation requires a job");
        const observer: JobObserver = { follow: null, delivery: 0, unacknowledged: [] };
        isolate.jobObservers.set(id, observer);
        this.clearIdle(isolate);
        const receive = (update: JobFollowUpdate): void => {
          if (isolate.child !== child || isolate.jobObservers.get(id) !== observer) return;
          if (observer.unacknowledged.length >= 16) {
            isolate.jobObservers.delete(id);
            observer.follow?.close();
            child.send({
              t: "job_update",
              id,
              delivery: ++observer.delivery,
              update: { type: "closed", reason: "gap" },
            });
            this.armIdle(isolate);
            return;
          }
          const delivery = ++observer.delivery;
          observer.unacknowledged.push(delivery);
          child.send({ t: "job_update", id, delivery, update });
          if (update.type === "closed") {
            isolate.jobObservers.delete(id);
            this.armIdle(isolate);
          }
        };
        try {
          observer.follow = pending.served.ctx.jobs.follow(node, receive);
          result = { id, snapshot: observer.follow.snapshot };
        } catch (error) {
          isolate.jobObservers.delete(id);
          this.armIdle(isolate);
          throw error;
        }
      } else {
        result = await serveCtxCall(frame.method, frame.args, pending.served);
      }
      reply = { t: "reply", id: frame.id, ok: true, result: result ?? null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply = { t: "reply", id: frame.id, ok: false, error: message.slice(0, 2048) };
    }
    if (isolate.child === child) child.send(reply);
  }

  /** Whether this request was sent a root caller who has since lost the class (#411). */
  private rootWithdrawn(pending: Pending): boolean {
    return (
      pending.served?.kind === "dispatch" &&
      (pending.request.t === "dispatch" || pending.request.t === "harness") &&
      pending.request.ctx?.isRoot === true &&
      !pending.served.ctx.auth.isRoot
    );
  }

  // ---------------------------------------------------------------- idle eviction

  private armIdle(isolate: Isolate): void {
    this.clearIdle(isolate);
    if (
      isolate.state !== "running" ||
      isolate.child === null ||
      isolate.pending.size > 0 ||
      isolate.producers.size > 0 ||
      isolate.jobObservers.size > 0
    )
      return;
    const timer = setTimeout(() => this.evict(isolate), this.idleEvictMs);
    // A sleeping child must never be what keeps the server process alive.
    timer.unref();
    isolate.cancelIdle = (): void => {
      clearTimeout(timer);
    };
  }

  private clearIdle(isolate: Isolate): void {
    isolate.cancelIdle?.();
    isolate.cancelIdle = null;
  }

  private evict(isolate: Isolate): void {
    isolate.cancelIdle = null;
    const child = isolate.child;
    if (
      child === null ||
      isolate.state !== "running" ||
      isolate.pending.size > 0 ||
      isolate.producers.size > 0
    )
      return;
    this.logger.info("isolate_evicted", {
      plugin: isolate.ref.pluginId,
      pid: child.pid,
      idleMs: this.idleEvictMs,
    });
    isolate.child = null;
    this.transition(isolate, "stopped", "idle");
    void this.retire(child);
  }

  private transition(isolate: Isolate, state: IsolateState, detail?: string): void {
    if (isolate.state === state) return;
    isolate.state = state;
    for (const listener of this.listeners) listener(isolate.ref.pluginId, state, detail);
  }
}
