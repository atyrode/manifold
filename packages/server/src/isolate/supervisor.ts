import { AsyncLocalStorage } from "node:async_hooks";
import type {
  ByteCarrierContext,
  AssemblyDelta,
  JobSettledCtx,
  LifecycleCtx,
  StreamProducer,
  JobFollow,
  PluginDatabase,
  PluginMigration,
  PluginStorage,
  ReferenceProbeCtx,
} from "@manifold/plugin";
import {
  BYTE_REQUEST_TIMEOUT_MS,
  MAX_BYTE_REQUESTS,
  ByteTransferError,
  IsolateByteRequestSchema,
  type IsolateByteRequest,
  type IsolateByteReply,
  ISOLATE_CRASH_BUDGET,
  ISOLATE_DISPATCH_DEADLINE_MS,
  ISOLATE_IDLE_EVICT_MS,
  ISOLATE_MAX_FRAME_BYTES,
  ISOLATE_MIGRATION_DEADLINE_MS,
  MAX_MIGRATION_STORAGE_OPERATIONS,
  ManifoldRefSchema,
  MachineBridgeResultSchemas,
  isMachineBridgeMethod,
  IsolateHarnessRequestSchema,
  IsolateHarnessResultSchemas,
  ISOLATE_REFERENCE_PROBE_DEADLINE_MS,
  ReferenceProbeRequestSchema,
  ReferenceProbeResultSchema,
  IsolateReferenceReclaimRequestSchema,
  type ReferenceProbeRequest,
  type ReferenceProbeResult,
  type ReferenceTerminalReceipt,
  NativeTransferEvidenceBatchSchema,
  type NativeTransferTerminalEvidence,
  NativeTransferPendingAdmissionsSchema,
  type NativeTransferPendingAdmission,
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
import { jobSettledTimeouts, type JobSettledTimeouts } from "../settled-job-timeouts.ts";
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
  serveLifecycleMetadata,
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
/** The host hook may still need to finish flushing its answer after its own lease ends. */
const SETTLED_FLUSH_GRACE_MS = 1_000;

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
  {
    t:
      | "dispatched"
      | "harnessed"
      | "hooked"
      | "migrated"
      | "probed_ready"
      | "reclaimed_references"
      | "reconciled_native_transfers"
      | "pending_native_transfers_result"
      | "byte_answered";
  }
>;

// Every request/answer pair passes the same pending-request fence. New data-only
// request kinds belong here rather than in a separate readiness-probe allowlist.
const ANSWER_FOR_REQUEST: Partial<Record<IsolateHostFrame["t"], AnsweredFrame["t"]>> = {
  dispatch: "dispatched",
  harness: "harnessed",
  hook: "hooked",
  migrate: "migrated",
  probe_ready: "probed_ready",
  reclaim_references: "reclaimed_references",
  reconcile_native_transfers: "reconciled_native_transfers",
  pending_native_transfers: "pending_native_transfers_result",
  byte_request: "byte_answered",
};

/** One round trip awaiting its answer, with the ctx that serves the child's calls meanwhile. */
interface Pending {
  readonly served: ServedCtx | null;
  readonly request: Extract<IsolateHostFrame, { id: string }>;
  readonly expiresAt: number;
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

interface OwnerTurn {
  pending: Pending | null;
}

interface WaitingOwnerTurn {
  enter(): void;
  fail(error: Error): void;
}

interface HostCall {
  readonly isolate: Isolate;
  readonly child: IsolateChild;
  readonly pending: Pending;
  active: boolean;
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
  /** Only callback-owning guests exclude unrelated authority while serving a private probe. */
  ownerTurn: OwnerTurn | null = null;
  readonly waitingOwnerTurns = new Set<WaitingOwnerTurn>();
  callTail: Promise<void> = Promise.resolve();
  queuedCalls = 0;
  queuedCallBytes = 0;
  /** Drained admission excludes current work, not resource-charged retired awaits. */
  currentQueuedCalls = 0;
  migration: { readonly id: string; readonly calls: Set<string> } | null = null;
  /** A context-free validation owns the drained guest until its request settles. */
  validation: { readonly id: string; violated: boolean } | null = null;
  /** A nested owner-data callback cannot borrow any concurrent action's authority. */
  probe: { readonly id: string; readonly calls: Set<string>; violated: boolean } | null = null;
  probeCallTail: Promise<void> = Promise.resolve();
  readonly producers = new Map<string, StreamProducer>();
  readonly jobObservers = new Map<string, JobObserver>();
  nextProducer = 0;
  /** Unasked-for exits inside the budget window, as `runtime.now()` stamps. */
  crashes: number[] = [];
  /** Cancels the armed idle-eviction timer; a closure, so no platform timer type is named. */
  cancelIdle: (() => void) | null = null;
  nextRequest = 0;
  byteRequests = 0;

  constructor(readonly ref: InstalledPluginRef) {}
}

export interface IsolateSupervisorDeps {
  readonly logger: Logger;
  readonly runtime: RuntimeDeps;
  /** The runner's numbers, defaulting to the protocol's; a test narrows them. */
  readonly dispatchDeadlineMs?: number;
  readonly jobSettledTimeouts?: JobSettledTimeouts;
  readonly idleEvictMs?: number;
  readonly migrationDeadlineMs?: number;
  readonly referenceProbeDeadlineMs?: number;
  readonly crashBudget?: { readonly count: number; readonly windowMs: number };
}

export class IsolateSupervisor implements IsolateRunner {
  private readonly isolates = new Map<string, Isolate>();
  private readonly hostCall = new AsyncLocalStorage<HostCall>();
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
  private readonly idleListeners = new Set<(pluginId: string) => void>();
  private readonly logger: Logger;
  private readonly runtime: RuntimeDeps;
  private readonly dispatchDeadlineMs: number;
  private readonly jobSettledTimeouts: ReadonlyMap<string, number>;
  private readonly idleEvictMs: number;
  private readonly migrationDeadlineMs: number;
  private readonly referenceProbeDeadlineMs: number;
  private readonly crashBudget: { readonly count: number; readonly windowMs: number };
  private closed = false;

  constructor(deps: IsolateSupervisorDeps) {
    this.logger = deps.logger;
    this.runtime = deps.runtime;
    this.dispatchDeadlineMs = deps.dispatchDeadlineMs ?? ISOLATE_DISPATCH_DEADLINE_MS;
    this.jobSettledTimeouts = jobSettledTimeouts(deps.jobSettledTimeouts);
    this.idleEvictMs = deps.idleEvictMs ?? ISOLATE_IDLE_EVICT_MS;
    this.migrationDeadlineMs = deps.migrationDeadlineMs ?? ISOLATE_MIGRATION_DEADLINE_MS;
    this.referenceProbeDeadlineMs =
      deps.referenceProbeDeadlineMs ?? ISOLATE_REFERENCE_PROBE_DEADLINE_MS;
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
      byteRequest: (request, ctx) => this.byteRequest(isolate, request, ctx),
      probeReady: (ctx, input, idleOnly) => this.probeReady(isolate, ctx, input, idleOnly),
      reclaimReferences: (ctx, receipts) => this.reclaimReferences(isolate, ctx, receipts),
      reconcileNativeTransfers: (ctx, receipts) =>
        this.reconcileNativeTransfers(isolate, ctx, receipts),
      pendingNativeTransfersWhenIdle: (ctx) => this.pendingNativeTransfersWhenIdle(isolate, ctx),
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

  remainingHostCallMs(): number {
    const call = this.hostCall.getStore();
    if (call === undefined) return Number.POSITIVE_INFINITY;
    const request = call.pending.request;
    if (
      !call.active ||
      this.closed ||
      this.isolates.get(call.isolate.ref.pluginId) !== call.isolate ||
      call.isolate.child !== call.child ||
      !("id" in request) ||
      call.isolate.pending.get(request.id) !== call.pending
    )
      return 0;
    return Math.max(0, call.pending.expiresAt - performance.now());
  }

  onState(listener: (pluginId: string, state: IsolateState, detail?: string) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  onIdle(listener: (pluginId: string) => void): () => void {
    this.idleListeners.add(listener);
    return () => {
      this.idleListeners.delete(listener);
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
      ...((this.isolates.get(pluginId)?.ref.hardenedContract ?? 0) >= 12
        ? { credentialBinding: ctx.credentialBinding }
        : {}),
      principal: ctx.principal,
      ...((this.isolates.get(pluginId)?.ref.hardenedContract ?? 0) >= 8
        ? { callerPlugin: ctx.callerPlugin }
        : {}),
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

  private async byteRequest(
    isolate: Isolate,
    input: IsolateByteRequest,
    ctx: ByteCarrierContext,
  ): Promise<IsolateByteReply> {
    ctx.assertCurrent();
    if (
      this.isolates.get(isolate.ref.pluginId) !== isolate ||
      (isolate.ref.hardenedContract ?? 1) < 12
    )
      throw new ByteTransferError("unavailable");
    // Includes cancelled requests awaiting a guest answer/timeout, even during cold startup.
    if (isolate.byteRequests >= MAX_BYTE_REQUESTS) throw new ByteTransferError("busy");
    isolate.byteRequests += 1;
    try {
      const request = IsolateByteRequestSchema.parse(input);
      const frame = await this.request(
        isolate.ref.pluginId,
        (id) => ({
          t: "byte_request",
          id,
          request,
          ctx: {
            principal: ctx.principal,
            credentialBinding: ctx.credentialBinding,
            now: ctx.now(),
          },
        }),
        { kind: "byte", ctx },
      );
      ctx.assertCurrent();
      if (frame.t !== "byte_answered") throw new Error("byte reply kind mismatch");
      if (!frame.outcome.ok) throw new ByteTransferError(frame.outcome.reason);
      if (frame.outcome.reply.method !== request.method) throw new Error("byte method mismatch");
      return frame.outcome.reply;
    } catch (error) {
      if (error instanceof ByteTransferError) throw error;
      throw new ByteTransferError(input.method === "write" ? "outcome_unknown" : "unavailable");
    } finally {
      isolate.byteRequests -= 1;
    }
  }

  private async probeReady(
    isolate: Isolate,
    ctx: ReferenceProbeCtx,
    input: ReferenceProbeRequest,
    idleOnly = false,
  ): Promise<ReferenceProbeResult> {
    if (
      this.isolates.get(isolate.ref.pluginId) !== isolate ||
      (isolate.ref.hardenedContract ?? 1) < 12 ||
      isolate.loaded?.probeReady !== true
    )
      throw new IsolateDenial("unavailable", "readiness probe unavailable");
    const request = ReferenceProbeRequestSchema.parse(input);
    const frame = await this.request(
      isolate.ref.pluginId,
      (id) => ({ t: "probe_ready", id, request, now: ctx.now() }),
      { kind: "probe", ctx },
      idleOnly,
    );
    if (frame.t !== "probed_ready")
      throw new IsolateDenial("unavailable", "readiness probe answered out of protocol");
    if (!frame.outcome.ok) throw new Error(frame.outcome.error);
    return ReferenceProbeResultSchema.parse(frame.outcome.result);
  }

  private async reclaimReferences(
    isolate: Isolate,
    ctx: ReferenceProbeCtx,
    receipts: readonly ReferenceTerminalReceipt[],
  ): Promise<void> {
    if (
      this.isolates.get(isolate.ref.pluginId) !== isolate ||
      (isolate.ref.hardenedContract ?? 1) < 12 ||
      isolate.loaded?.reclaimReferences !== true
    )
      throw new IsolateDenial("unavailable", "reference reclamation unavailable");
    const request = IsolateReferenceReclaimRequestSchema.parse(receipts);
    const frame = await this.request(
      isolate.ref.pluginId,
      (id) => ({ t: "reclaim_references", id, receipts: request, now: ctx.now() }),
      { kind: "probe", ctx },
    );
    if (frame.t !== "reclaimed_references")
      throw new IsolateDenial("unavailable", "reference reclamation answered out of protocol");
    if (!frame.outcome.ok) throw new Error(frame.outcome.error);
  }

  private async reconcileNativeTransfers(
    isolate: Isolate,
    ctx: ReferenceProbeCtx,
    receipts: readonly NativeTransferTerminalEvidence[],
  ): Promise<void> {
    if (
      this.isolates.get(isolate.ref.pluginId) !== isolate ||
      (isolate.ref.hardenedContract ?? 1) < 12 ||
      isolate.loaded?.reconcileNativeTransfers !== true
    )
      throw new IsolateDenial("unavailable", "native evidence reconciliation unavailable");
    const request = NativeTransferEvidenceBatchSchema.parse(receipts);
    const frame = await this.request(
      isolate.ref.pluginId,
      (id) => ({ t: "reconcile_native_transfers", id, receipts: request, now: ctx.now() }),
      { kind: "probe", ctx },
    );
    if (frame.t !== "reconciled_native_transfers")
      throw new IsolateDenial(
        "unavailable",
        "native evidence reconciliation answered out of protocol",
      );
    if (!frame.outcome.ok) throw new Error(frame.outcome.error);
  }

  private async pendingNativeTransfersWhenIdle(
    isolate: Isolate,
    ctx: ReferenceProbeCtx,
  ): Promise<readonly NativeTransferPendingAdmission[] | null> {
    if (
      this.isolates.get(isolate.ref.pluginId) !== isolate ||
      (isolate.ref.hardenedContract ?? 1) < 12 ||
      isolate.loaded?.pendingNativeTransfers !== true ||
      isolate.loaded.reconcileNativeTransfers !== true
    )
      throw new IsolateDenial("unavailable", "pending native admissions unavailable");
    // Never queue a stale absence probe behind an action crossing into native admission.
    // request() acquires the exclusive owner turn synchronously before its first await.
    if (
      isolate.ownerTurn !== null ||
      isolate.waitingOwnerTurns.size !== 0 ||
      isolate.pending.size !== 0 ||
      isolate.currentQueuedCalls !== 0 ||
      isolate.producers.size !== 0 ||
      isolate.jobObservers.size !== 0 ||
      isolate.migration !== null ||
      isolate.validation !== null ||
      isolate.probe !== null
    )
      return null;
    const frame = await this.request(
      isolate.ref.pluginId,
      (id) => ({ t: "pending_native_transfers", id, now: ctx.now() }),
      { kind: "probe", ctx },
      true,
    );
    if (frame.t !== "pending_native_transfers_result")
      throw new IsolateDenial("unavailable", "pending native admissions answered out of protocol");
    if (!frame.outcome.ok) throw new Error(frame.outcome.error);
    return NativeTransferPendingAdmissionsSchema.parse(frame.outcome.result);
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
        ...((this.isolates.get(pluginId)?.ref.hardenedContract ?? 0) >= 11 &&
        ctx.host !== undefined &&
        ctx.services !== undefined &&
        ctx.machines !== undefined
          ? { metadata: true }
          : {}),
      }),
      { kind: "hook", ctx },
    );
  }
  /** The settled hook carries the job slice, so its child calls are served from that ctx. */
  private async settled(pluginId: string, ctx: JobSettledCtx, job: SettledJob): Promise<void> {
    await this.hooked(
      pluginId,
      "onJobSettled",
      (id) => ({
        t: "hook",
        id,
        hook: "onJobSettled",
        job,
        ...((this.isolates.get(pluginId)?.ref.hardenedContract ?? 0) >= 11 &&
        ctx.host !== undefined &&
        ctx.services !== undefined &&
        ctx.machines !== undefined
          ? { metadata: true }
          : {}),
      }),
      { kind: "settled", ctx },
    );
  }
  private async hooked(
    pluginId: string,
    hook: IsolateHook,
    build: (id: string) => Pending["request"],
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
   * by unload — and the idle clock restarts when nothing is in flight. Only selected settled
   * hooks get the operator's longer bound plus finite flush grace; other requests retain
   * their existing deadlines.
   */
  private async request(
    pluginId: string,
    build: (id: string) => Pending["request"],
    served: ServedCtx | null,
    idleOnly = false,
  ): Promise<AnsweredFrame> {
    const isolate = this.isolates.get(pluginId);
    if (isolate === undefined) throw new IsolateDenial("unavailable", "isolate is not loaded");
    const settledTimeoutMs =
      served?.kind === "settled" ? this.jobSettledTimeouts.get(pluginId) : undefined;
    const duration =
      served?.kind === "migration"
        ? this.migrationDeadlineMs
        : served?.kind === "probe"
          ? this.referenceProbeDeadlineMs
          : served?.kind === "byte"
            ? Math.min(this.dispatchDeadlineMs, BYTE_REQUEST_TIMEOUT_MS)
            : settledTimeoutMs === undefined
              ? this.dispatchDeadlineMs
              : settledTimeoutMs + SETTLED_FLUSH_GRACE_MS;
    const now = performance.now();
    // Awaited re-entry cannot acquire a fresh budget beyond its still-serving parent.
    const inheritedBudget = this.hostCall.getStore()?.active
      ? this.remainingHostCallMs()
      : Number.POSITIVE_INFINITY;
    const expiresAt = now + Math.min(duration, inheritedBudget);
    const turn = await this.acquireOwnerTurn(isolate, served, idleOnly, expiresAt);
    let startupDeadline: Timer | undefined;
    try {
      if (this.isolates.get(pluginId) !== isolate)
        throw new IsolateDenial("unavailable", "isolate unloaded");
      try {
        if (isolate.state !== "running" || isolate.child === null) {
          await Promise.race([
            this.ensureRunning(isolate),
            new Promise<never>((_, reject) => {
              startupDeadline = setTimeout(
                () =>
                  reject(
                    new IsolateDenial("unavailable", "isolate deadline expired before admission"),
                  ),
                Math.max(0, expiresAt - performance.now()),
              );
            }),
          ]);
        }
      } catch (error) {
        if (error instanceof IsolateDenial) throw error;
        throw new IsolateDenial(
          "unavailable",
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        clearTimeout(startupDeadline);
      }
      const child = isolate.child;
      if (child === null || this.isolates.get(pluginId) !== isolate) {
        throw new IsolateDenial("unavailable", "isolate unloaded");
      }
      if (expiresAt <= performance.now())
        throw new IsolateDenial("unavailable", "isolate deadline expired before admission");
      if (isolate.validation !== null)
        throw new IsolateDenial(
          "unavailable",
          "profile validation requires exclusive guest access",
        );
      if (isolate.probe !== null)
        throw new IsolateDenial("unavailable", "reference data callback is active");
      if (isolate.pending.size >= 256)
        throw new IsolateDenial("unavailable", "too many pending isolate requests");
      if (
        isolate.migration !== null ||
        ((idleOnly || served === null || served.kind === "migration") &&
          (isolate.pending.size !== 0 ||
            isolate.currentQueuedCalls !== 0 ||
            isolate.producers.size !== 0 ||
            isolate.jobObservers.size !== 0))
      )
        throw new IsolateDenial("unavailable", "exclusive request requires a drained guest");
      if (served?.kind === "byte") served.ctx.assertCurrent();
      isolate.nextRequest += 1;
      const id = `r${String(isolate.nextRequest)}`;
      const cancelByte = (): void => {
        child.send({ t: "byte_cancel", id });
      };
      this.clearIdle(isolate);
      const deadline = setTimeout(() => this.expire(isolate, id, duration), expiresAt - performance.now());
      try {
        const { promise, resolve, reject } = Promise.withResolvers<AnsweredFrame>();
        const request = build(id);
        if (served?.kind === "migration") isolate.migration = { id, calls: new Set() };
        if (served === null) isolate.validation = { id, violated: false };
        if (served?.kind === "probe") isolate.probe = { id, calls: new Set(), violated: false };
        // Sending and registration are synchronous; no child frame can interleave them.
        // A failed send must not expose an unsent request's authority even for one microtask.
        if (!child.send(request)) throw new IsolateDenial("unavailable", "isolate exited");
        const pending: Pending = {
          served,
          request,
          expiresAt,
          serving: 0,
          admitted: (request.t === "harness" && served !== null) || request.t === "byte_request",
          answer: resolve,
          fail: reject,
        };
        isolate.pending.set(id, pending);
        if (turn !== null) turn.pending = pending;
        if (served?.kind === "byte") {
          served.ctx.signal.addEventListener("abort", cancelByte, { once: true });
          if (served.ctx.signal.aborted) cancelByte();
        }
        return await promise;
      } finally {
        if (served?.kind === "byte") served.ctx.signal.removeEventListener("abort", cancelByte);
        clearTimeout(deadline);
        isolate.pending.delete(id);
        if (isolate.migration?.id === id) isolate.migration = null;
        if (isolate.validation?.id === id) isolate.validation = null;
        if (isolate.probe?.id === id) isolate.probe = null;
      }
    } finally {
      if (turn !== null) this.releaseOwnerTurn(isolate, turn);
      this.armIdle(isolate);
    }
  }

  private async acquireOwnerTurn(
    isolate: Isolate,
    served: ServedCtx | null,
    idleOnly: boolean,
    expiresAt: number,
  ): Promise<OwnerTurn | null> {
    if (
      (isolate.ref.hardenedContract ?? 1) < 12 ||
      !(
        isolate.loaded?.probeReady ||
        isolate.loaded?.reclaimReferences ||
        isolate.loaded?.reconcileNativeTransfers ||
        isolate.loaded?.pendingNativeTransfers
      )
    )
      return null;
    const origin = this.hostCall.getStore();
    // This lineage exists only while the host is serving this owner's exact current call.
    // A guest-provided request id, or a detached continuation after that call, grants nothing.
    if (
      !idleOnly &&
      served?.kind === "probe" &&
      origin?.active &&
      origin.isolate === isolate &&
      origin.child === isolate.child &&
      isolate.ownerTurn?.pending === origin.pending &&
      "id" in origin.pending.request &&
      isolate.pending.get(origin.pending.request.id) === origin.pending
    )
      return null;
    if (idleOnly && (isolate.ownerTurn !== null || isolate.waitingOwnerTurns.size !== 0))
      throw new IsolateDenial("unavailable", "exclusive request requires a drained guest");
    if (isolate.waitingOwnerTurns.size + isolate.pending.size >= 256)
      throw new IsolateDenial("unavailable", "too many pending isolate requests");
    if (served?.kind === "byte") served.ctx.assertCurrent();
    const turn: OwnerTurn = { pending: null };
    if (isolate.ownerTurn === null) {
      isolate.ownerTurn = turn;
      this.clearIdle(isolate);
      return turn;
    }
    const signal = served?.kind === "byte" ? served.ctx.signal : undefined;
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const waiting: WaitingOwnerTurn = {
      enter: () => {
        if (!isolate.waitingOwnerTurns.delete(waiting)) return;
        isolate.ownerTurn = turn;
        resolve();
      },
      fail: (error) => {
        if (isolate.waitingOwnerTurns.delete(waiting)) reject(error);
      },
    };
    isolate.waitingOwnerTurns.add(waiting);
    const deadline = setTimeout(
      () =>
        waiting.fail(new IsolateDenial("unavailable", "isolate deadline expired before admission")),
      Math.max(0, expiresAt - performance.now()),
    );
    const cancel = (): void => waiting.fail(new ByteTransferError("cancelled"));
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    try {
      await promise;
      return turn;
    } finally {
      clearTimeout(deadline);
      signal?.removeEventListener("abort", cancel);
      isolate.waitingOwnerTurns.delete(waiting);
    }
  }

  private releaseOwnerTurn(isolate: Isolate, turn: OwnerTurn): void {
    if (isolate.ownerTurn !== turn) return;
    isolate.ownerTurn = null;
    for (const waiting of isolate.waitingOwnerTurns) {
      waiting.enter();
      break;
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
  private expire(isolate: Isolate, id: string, deadlineMs: number): void {
    const pending = isolate.pending.get(id);
    if (pending === undefined) return;
    this.logger.warn("isolate_call_failed", {
      plugin: isolate.ref.pluginId,
      id,
      reason: "deadline",
      deadlineMs,
    });
    // Any expired action may be the publisher awaiting a nested probe. Keep that probe
    // fenced until exit, even if a buffered probe result races the parent's deadline.
    if (isolate.validation !== null) isolate.validation.violated = true;
    if (isolate.probe !== null) isolate.probe.violated = true;
    if (isolate.validation === null && isolate.probe === null)
      pending.fail(new IsolateDenial("unavailable", "isolate deadline expired"));
    // A stuck isolate is a crash: the kill is unasked-for on purpose, so the exit counts.
    isolate.child?.kill();
  }

  private failAll(isolate: Isolate, error: IsolateDenial): void {
    for (const pending of isolate.pending.values()) pending.fail(error);
    isolate.ownerTurn = null;
    for (const waiting of isolate.waitingOwnerTurns) waiting.fail(error);
    isolate.waitingOwnerTurns.clear();
    isolate.validation = null;
    isolate.probe = null;
    // Old-generation work remains charged until it settles, but cannot hold a new
    // child's callbacks behind its abandoned publish or owner-data await.
    isolate.callTail = Promise.resolve();
    isolate.probeCallTail = Promise.resolve();
    isolate.currentQueuedCalls = 0;
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
    if (isolate.probe?.violated) return;
    if (isolate.probe !== null) {
      const pending = "id" in frame ? isolate.pending.get(frame.id) : undefined;
      // Already-running requests may finish; they acquire no new callback authority.
      // A prepared frame racing probe admission is refused below, not a child crash.
      const existing =
        pending !== undefined &&
        "id" in frame &&
        ((frame.t === ANSWER_FOR_REQUEST[pending.request.t] &&
          (pending.served?.kind !== "probe" || frame.id === isolate.probe.id)) ||
          (frame.t === "prepared" && pending.request.t === "dispatch"));
      if (frame.t !== "received" && frame.t !== "call" && !existing) {
        isolate.probe.violated = true;
        child.kill();
        return;
      }
    }
    switch (frame.t) {
      case "received":
        if (!child.received(frame.receipt)) {
          this.logger.warn("isolate_call_failed", {
            plugin: isolate.ref.pluginId,
            reason: "invalid frame receipt",
          });
          if (isolate.probe !== null) isolate.probe.violated = true;
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
        if (isolate.probe !== null) {
          pending.fail(new IsolateDenial("unavailable", "reference data callback is active"));
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
      case "probed_ready":
      case "reclaimed_references":
      case "reconciled_native_transfers":
      case "pending_native_transfers_result":
      case "byte_answered":
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
        const expected = ANSWER_FOR_REQUEST[pending.request.t];
        if (
          frame.t !== expected ||
          pending.serving !== 0 ||
          (frame.t === "dispatched" &&
            !pending.admitted &&
            (frame.outcome.ok || frame.outcome.rule !== "invalid_args")) ||
          (pending.request.t === "harness" &&
            frame.t === "harnessed" &&
            frame.outcome.ok &&
            (!IsolateHarnessResultSchemas[pending.request.request.method].safeParse(
              frame.outcome.result,
            ).success ||
              (pending.served === null && frame.outcome.emits.length !== 0))) ||
          (pending.request.t === "migrate" &&
            (frame.t !== "migrated" || frame.name !== pending.request.migration.name))
        ) {
          if (isolate.probe !== null) {
            isolate.probe.violated = true;
            child.kill();
            return;
          }
          pending.fail(new IsolateDenial("unavailable", "isolate answered out of protocol"));
        } else if (
          isolate.probe !== null &&
          (frame.t === "dispatched" || frame.t === "harnessed") &&
          frame.outcome.ok &&
          frame.outcome.emits.length !== 0
        ) {
          // The shared guest cannot prove these were staged before the data-only phase.
          // Finishing a request may deliver data, never borrow its emission authority.
          pending.fail(new IsolateDenial("unavailable", "reference data callback cannot emit"));
        } else {
          pending.answer(
            frame.t !== "migrated" &&
              frame.t !== "hooked" &&
              frame.t !== "probed_ready" &&
              frame.t !== "reclaimed_references" &&
              frame.t !== "reconciled_native_transfers" &&
              frame.t !== "pending_native_transfers_result" &&
              frame.t !== "byte_answered" &&
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
          if (isolate.probe !== null) isolate.probe.violated = true;
          child.kill();
          return;
        }
        const separator = frame.id.lastIndexOf(":");
        const pending =
          separator === -1 ? undefined : isolate.pending.get(frame.id.slice(0, separator));
        const probe = isolate.probe;
        if (probe !== null) {
          if (
            pending?.served?.kind !== "probe" ||
            (pending.request.t !== "probe_ready" &&
              pending.request.t !== "reclaim_references" &&
              pending.request.t !== "reconcile_native_transfers" &&
              pending.request.t !== "pending_native_transfers") ||
            pending.request.id !== probe.id ||
            !(frame.method.startsWith("storage.") || frame.method.startsWith("database.")) ||
            probe.calls.has(frame.id) ||
            probe.calls.size >= 256
          ) {
            probe.violated = true;
            child.kill();
            return;
          }
          probe.calls.add(frame.id);
        }
        if (pending !== undefined) pending.serving += 1;
        isolate.queuedCalls += 1;
        isolate.queuedCallBytes += bytes;
        isolate.currentQueuedCalls += 1;
        const serve = async (): Promise<void> => {
          try {
            if (isolate.child === child) await this.serve(isolate, child, frame, pending);
          } finally {
            if (pending !== undefined && pending.serving > 0) pending.serving -= 1;
            isolate.queuedCalls -= 1;
            isolate.queuedCallBytes -= bytes;
            if (isolate.child === child) {
              isolate.currentQueuedCalls -= 1;
              this.armIdle(isolate);
            }
          }
        };
        // A references.publish call may await this very probe. Its data calls must not queue
        // behind the suspended action; the dedicated queue admits only the fenced own lease.
        if (pending?.served?.kind === "probe")
          isolate.probeCallTail = isolate.probeCallTail.then(serve, serve);
        else isolate.callTail = isolate.callTail.then(serve, serve);
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
    if (isolate.probe !== null) {
      isolate.probe.violated = true;
      child.kill();
      return;
    }
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
      // Calls wait behind earlier host work; a captured ctx is not authority after teardown.
      if (pending !== undefined && isolate.pending.get(pending.request.id) !== pending)
        throw new Error("no such request");
      if (isolate.probe?.violated || isolate.validation?.violated)
        throw new Error(`slice_unavailable: ${frame.method}`);
      if (isolate.probe !== null && pending?.served?.kind !== "probe")
        throw new Error(`slice_unavailable: ${frame.method}`);
      if (
        pending?.served?.kind === "probe" &&
        (!("id" in pending.request) ||
          isolate.pending.get(pending.request.id) !== pending ||
          isolate.probe?.id !== pending.request.id ||
          isolate.probe.violated)
      )
        throw new Error("reference data lease expired");
      if (
        frame.method.startsWith("references.") &&
        ((isolate.ref.hardenedContract ?? 1) < 12 ||
          !(
            pending?.served?.kind === "dispatch" ||
            (pending?.served?.kind === "byte" && frame.method === "references.requirePublished")
          ) ||
          !pending?.admitted)
      )
        throw new Error(`slice_unavailable: ${frame.method}`);
      if (frame.method.startsWith("nativeTransfers.") && (isolate.ref.hardenedContract ?? 1) < 12)
        throw new Error(`slice_unavailable: ${frame.method}`);
      if (pending?.served?.kind === "byte") {
        if (
          pending.request.t !== "byte_request" ||
          isolate.pending.get(pending.request.id) !== pending ||
          !(
            frame.method.startsWith("database.") ||
            frame.method === "references.requirePublished" ||
            frame.method === "nativeTransfers.readChunk" ||
            frame.method === "nativeTransfers.status"
          )
        )
          throw new ByteTransferError("unavailable");
        pending.served.ctx.assertCurrent();
      }
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
        // The fleet bridge is contract 9's; an older guest was never built to ask for it.
        if (isMachineBridgeMethod(frame.method) && (isolate.ref.hardenedContract ?? 1) < 9)
          throw new Error(`slice_unavailable: ${frame.method}`);
        if (
          (pending.served.kind === "hook" || pending.served.kind === "settled") &&
          (frame.method === "host.roster" ||
            frame.method === "host.enabled" ||
            frame.method === "services.listInstances" ||
            frame.method === "machines.inventory")
        ) {
          if ((isolate.ref.hardenedContract ?? 1) < 11)
            throw new Error(`slice_unavailable: ${frame.method}`);
          // Read after any queue wait, then reply without an await that could outlive
          // the credential, resource grant or hook lease which authorized these bytes.
          result = serveLifecycleMetadata(frame.method, frame.args, pending.served.ctx);
        } else {
          const origin: HostCall = { isolate, child, pending, active: true };
          const served = pending.served;
          try {
            result = await this.hostCall.run(origin, () =>
              serveCtxCall(frame.method, frame.args, served),
            );
          } finally {
            origin.active = false;
          }
          if (frame.method === "machines.inventory" && (isolate.ref.hardenedContract ?? 1) < 10) {
            // Contract-9 packed guests strictly parse the pre-topology inventory shape.
            const inventory = MachineBridgeResultSchemas["machines.inventory"].parse(result);
            if (inventory.ok) {
              for (const machine of inventory.value.machines) delete machine.physicalCoreCount;
            }
            result = inventory;
          }
        }
        if (pending.served.kind === "byte") pending.served.ctx.assertCurrent();
        if (
          frame.method.startsWith("references.") &&
          ((pending.served.kind !== "dispatch" && pending.served.kind !== "byte") ||
            !("id" in pending.request) ||
            isolate.pending.get(pending.request.id) !== pending ||
            this.rootWithdrawn(pending))
        )
          throw new Error("authority_lost");
      }
      reply = { t: "reply", id: frame.id, ok: true, result: result ?? null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply = { t: "reply", id: frame.id, ok: false, error: message.slice(0, 2048) };
    }
    // An in-flight host read may finish after its request has expired; never return it then.
    if (
      isolate.child === child &&
      (pending === undefined || isolate.pending.get(pending.request.id) === pending) &&
      !isolate.probe?.violated &&
      !isolate.validation?.violated
    )
      child.send(reply);
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
      this.isolates.get(isolate.ref.pluginId) !== isolate ||
      isolate.currentQueuedCalls !== 0 ||
      isolate.pending.size > 0 ||
      isolate.ownerTurn !== null ||
      isolate.waitingOwnerTurns.size > 0 ||
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
    for (const listener of this.idleListeners) listener(isolate.ref.pluginId);
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
      isolate.ownerTurn !== null ||
      isolate.waitingOwnerTurns.size > 0 ||
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
