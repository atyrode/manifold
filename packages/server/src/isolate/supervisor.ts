import type { AssemblyDelta, LifecycleCtx } from "@manifold/plugin";
import {
  ISOLATE_CRASH_BUDGET,
  ISOLATE_DISPATCH_DEADLINE_MS,
  ISOLATE_IDLE_EVICT_MS,
  type IsolateChildFrame,
  type IsolateHook,
  type IsolateHostFrame,
  type RuntimeDeps,
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

type LoadedFrame = Extract<IsolateChildFrame, { t: "loaded" }>;
type AnsweredFrame = Extract<IsolateChildFrame, { t: "dispatched" | "hooked" }>;

/** One round trip awaiting its answer, with the ctx that serves the child's calls meanwhile. */
interface Pending {
  readonly served: ServedCtx;
  readonly answer: (frame: AnsweredFrame) => void;
  readonly fail: (error: Error) => void;
}

/** The `load` handshake in flight. */
interface Handshake {
  readonly resolve: (frame: LoadedFrame) => void;
  readonly reject: (error: IsolateLoadError) => void;
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
  private readonly crashBudget: { readonly count: number; readonly windowMs: number };
  private closed = false;

  constructor(deps: IsolateSupervisorDeps) {
    this.logger = deps.logger;
    this.runtime = deps.runtime;
    this.dispatchDeadlineMs = deps.dispatchDeadlineMs ?? ISOLATE_DISPATCH_DEADLINE_MS;
    this.idleEvictMs = deps.idleEvictMs ?? ISOLATE_IDLE_EVICT_MS;
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
      hook: (hook, ctx, delta) => this.hook(pluginId, hook, ctx, delta),
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
        ctx: {
          principal: ctx.principal,
          caps: [...ctx.auth.caps],
          isRoot: ctx.auth.isRoot,
          containerScope: ctx.containerScope,
          now: ctx.now(),
        },
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

  private async hook(
    pluginId: string,
    hook: IsolateHook,
    ctx: LifecycleCtx,
    delta?: AssemblyDelta,
  ): Promise<void> {
    const frame = await this.request(
      pluginId,
      (id) => ({
        t: "hook",
        id,
        hook,
        ...(delta === undefined
          ? {}
          : { delta: { enabled: [...delta.enabled], disabled: [...delta.disabled] } }),
      }),
      { kind: "hook", ctx },
    );
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
    served: ServedCtx,
  ): Promise<AnsweredFrame> {
    const isolate = this.isolates.get(pluginId);
    if (isolate === undefined) throw new IsolateDenial("unavailable", "isolate is not loaded");
    try {
      await this.ensureRunning(isolate);
    } catch (error) {
      if (error instanceof IsolateDenial) throw error;
      throw new IsolateDenial("unavailable", error instanceof Error ? error.message : String(error));
    }
    const child = isolate.child;
    if (child === null || this.isolates.get(pluginId) !== isolate) {
      throw new IsolateDenial("unavailable", "isolate unloaded");
    }
    isolate.nextRequest += 1;
    const id = `r${String(isolate.nextRequest)}`;
    this.clearIdle(isolate);
    const deadline = setTimeout(() => this.expire(isolate, id), this.dispatchDeadlineMs);
    try {
      return await new Promise<AnsweredFrame>((resolve, reject) => {
        isolate.pending.set(id, { served, answer: resolve, fail: reject });
        if (!child.send(build(id))) reject(new IsolateDenial("unavailable", "isolate exited"));
      });
    } finally {
      clearTimeout(deadline);
      isolate.pending.delete(id);
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
        if (!child.send({ t: "load", pluginId, manifest, dir })) {
          reject(new IsolateLoadError("isolate exited before load"));
        }
      });
      if (isolate.loaded === null) isolate.loaded = loaded;
    } catch (error) {
      if (isolate.child === child) {
        // Still attached: the child is alive but not a plugin. Its exit must not count twice.
        isolate.child = null;
        this.retired.add(child);
        child.kill();
        if (respawn) this.recordCrash(isolate, error instanceof Error ? error.message : "load failed");
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
    pending.fail(new IsolateDenial("unavailable", "isolate deadline expired"));
    // A stuck isolate is a crash: the kill is unasked-for on purpose, so the exit counts.
    isolate.child?.kill();
  }

  private failAll(isolate: Isolate, error: IsolateDenial): void {
    for (const pending of isolate.pending.values()) pending.fail(error);
  }

  // ---------------------------------------------------------------- inbound frames

  private onFrame(isolate: Isolate, child: IsolateChild, frame: IsolateChildFrame): void {
    if (isolate.child !== child) return;
    switch (frame.t) {
      case "loaded":
        isolate.handshake?.resolve(frame);
        return;
      case "load_failed":
        isolate.handshake?.reject(new IsolateLoadError(frame.error));
        return;
      case "dispatched":
      case "hooked": {
        const pending = isolate.pending.get(frame.id);
        if (pending === undefined) {
          this.logger.warn("isolate_call_failed", {
            plugin: isolate.ref.pluginId,
            id: frame.id,
            reason: "answer to no request",
          });
          return;
        }
        pending.answer(frame);
        return;
      }
      case "call":
        void this.serve(isolate, child, frame);
        return;
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
    this.logger.warn("isolate_call_failed", {
      plugin: isolate.ref.pluginId,
      id,
      reason: "malformed frame",
      detail,
    });
    const pending = id === null ? undefined : isolate.pending.get(id);
    if (pending !== undefined) {
      pending.fail(new IsolateDenial("unavailable", "isolate answered with a malformed frame"));
      return;
    }
    if (id === null) {
      isolate.handshake?.reject(new IsolateLoadError(`malformed frame during load: ${detail}`));
    }
  }

  /** Serves one `call` from the ctx of the request its id is prefixed with. */
  private async serve(
    isolate: Isolate,
    child: IsolateChild,
    frame: Extract<IsolateChildFrame, { t: "call" }>,
  ): Promise<void> {
    const separator = frame.id.lastIndexOf(":");
    const pending =
      separator === -1 ? undefined : isolate.pending.get(frame.id.slice(0, separator));
    let reply: IsolateHostFrame;
    if (pending === undefined) {
      reply = { t: "reply", id: frame.id, ok: false, error: "no such request" };
    } else {
      try {
        const result = await serveCtxCall(frame.method, frame.args, pending.served);
        reply = { t: "reply", id: frame.id, ok: true, result: result ?? null };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        reply = { t: "reply", id: frame.id, ok: false, error: message.slice(0, 2048) };
      }
    }
    if (isolate.child === child) child.send(reply);
  }

  // ---------------------------------------------------------------- idle eviction

  private armIdle(isolate: Isolate): void {
    this.clearIdle(isolate);
    if (isolate.state !== "running" || isolate.child === null || isolate.pending.size > 0) return;
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
    if (child === null || isolate.state !== "running" || isolate.pending.size > 0) return;
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
