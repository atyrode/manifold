import type { HostServices, SessionHandle, StreamHandle } from "@manifold/plugin";
import { MACHINES_RESOURCE } from "@manifold/plugin/portable-hooks";
import { requestResponse } from "../http.ts";
import {
  ActionOutcomeSchema,
  ISOLATE_ERROR_TEXT_MAX,
  HARDENED_CONTRACT_COMPAT_VERSIONS,
  IsolateReplyFrameSchema,
  WebIsolateWorkerFrameSchema,
  ManifoldRefSchema,
  MachinesResponseSchema,
  PLUGIN_BUNDLE_WEB_WORKER_FILE,
  TerminalRuntimeSchema,
  WebHostContextSchema,
  StreamOpenSchema,
  type Cap,
  type MachineSummary,
  type PlacementDestination,
  type PlacementRef,
  type Principal,
  type IsolateReplyFrame,
  type PanelArg,
  type ManifoldRef,
  type UiNode,
  type WebHostMethod,
  type WebHostContext,
  type WebIsolateHostFrame,
  type WebIsolateWorkerFrame,
} from "@manifold/protocol";

/**
 * THE BROWSER HALF OF THE ISOLATION RUNNER (ADR 0016 §1): one dedicated `Worker` per installed
 * plugin, supervised from the page. The worker holds the plugin's logic and none of its pixels
 * (§3) — it announces the panels it serves, is told when one is mounted, answers with whole
 * component trees, and reaches the host only by NAME through `call` frames the supervisor
 * serves from the panel's real {@link HostServices}. It never receives the bearer, a socket or a
 * DOM handle: `web.js` is fetched by the page with the page's authority and handed to the worker
 * as a Blob, and every capability the guest exercises is the page's own, attached per call.
 *
 * WHAT A WORKER IS FOR. A worker's `init` is immutable — who is looking and from where — so a
 * worker's identity is (plugin, container) within one host gate; the registry below keys on
 * exactly that, and a viewer moving to another container gets a worker initialised for it while
 * the one they left is released. One worker serves every mounted instance of every panel the
 * plugin declares: the frames carry an instance id, so two tiles of one panel never collide.
 *
 * WHAT A FAULT IS. The guest reports its own program throwing (`fault`, scoped to an instance
 * when one was involved); the supervisor reports the worker itself breaking — a frame the
 * protocol does not admit, an uncaught error, a module that would not load. The second kind is
 * WORKER-WIDE and terminal: the worker is stopped, every mounted instance shows the fault, and so
 * does every instance mounted afterwards, until the last one unmounts and the lease lapses. The
 * roster is untouched either way: a browser's failure is not something the server knows (§6).
 */

/** The `Worker` surface the supervisor uses, so a test can hand it a fake and read its frames. */
export interface WorkerLike {
  postMessage(message: unknown): void;
  terminate(): void;
  addEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void;
  addEventListener(type: "messageerror", listener: () => void): void;
  addEventListener(type: "error", listener: (event: { readonly message: string }) => void): void;
}

/** Makes the worker for a module path; the default fetches with the bearer, spawns from a Blob. */
export type WorkerFactory = (url: string) => WorkerLike | Promise<WorkerLike>;

export interface WorkerHostDeps {
  readonly pluginId: string;
  readonly principal: Principal;
  readonly caps: readonly Cap[];
  readonly containerId: string | null;
  /** The host ref every `call` is served from; the live one, via {@link WorkerHost.bind}. */
  readonly host: HostServices;
  /** Portable React bundles have a separate, self-contained Worker entry. */
  readonly portableWorker?: boolean | undefined;
  readonly workerFactory?: WorkerFactory | undefined;
}

/** Authenticated plugin module routes; no credential is ever carried in the path. */
export function webModulePath(pluginId: string, worker = false): string {
  const member = worker ? PLUGIN_BUNDLE_WEB_WORKER_FILE : "web.js";
  return `/api/plugins/${encodeURIComponent(pluginId)}/${member}`;
}

/**
 * The default factory. A `Worker` cannot carry an `Authorization` header and a token may never
 * ride a URL (docs/CONTRACTS.md §Data and credential boundaries), so the PAGE fetches the module with the bearer and spawns the worker
 * from a Blob of the bytes. The object URL is revoked as soon as the constructor has parsed it —
 * the blob URL entry is captured at parse time, so the worker's own fetch still resolves.
 * A blob: script URL cannot resolve a relative module graph, so the bundle must be self-contained.
 * It does not separate the worker from the creator's security origin or remove ambient networking.
 */
async function blobModuleWorker(path: string, token: string, name: string): Promise<WorkerLike> {
  const response = await requestResponse(path, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const blob = new Blob([await response.arrayBuffer()], { type: "text/javascript" });
  const objectUrl = URL.createObjectURL(blob);
  try {
    return new Worker(objectUrl, { type: "module", name });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

type CallFrame = Extract<WebIsolateWorkerFrame, { t: "call" }>;
type OpenTerminalOpts = Parameters<SessionHandle["openTerminal"]>[0];

function legacyMachineSummaries(machines: readonly MachineSummary[]): readonly MachineSummary[] {
  return machines.map(({ physicalCoreCount: _physicalCoreCount, ...machine }) => machine);
}

/** Only the public machine-list boundary changes shape for strict pre-contract-10 readers. */
function legacyMachineResult(frame: CallFrame, result: unknown): unknown {
  if (frame.method === "machines") {
    const parsed = MachinesResponseSchema.shape.machines.safeParse(result);
    return parsed.success ? legacyMachineSummaries(parsed.data) : result;
  }
  if (frame.method !== "action" || frame.args[0] !== MACHINES_RESOURCE) return result;
  const outcome = ActionOutcomeSchema.safeParse(result);
  if (!outcome.success || !outcome.data.ok) return result;
  const parsed = MachinesResponseSchema.safeParse(outcome.data.result);
  if (!parsed.success) return result;
  return {
    ...outcome.data,
    result: { machines: legacyMachineSummaries(parsed.data.machines) },
  };
}

/**
 * A `call` the closed method vocabulary does not name, read just far enough to answer it. The
 * full schema refuses it (and a refused frame is a worker-wide fault), but a guest built against
 * a newer vocabulary asking for a slice this host does not serve deserves the per-call refusal
 * the server side gives (`slice_unavailable`), not a dead panel.
 */
function unservedCall(data: unknown): { readonly id: string; readonly method: string } | null {
  if (typeof data !== "object" || data === null) return null;
  const { t, id, method } = data as { t?: unknown; id?: unknown; method?: unknown };
  if (t !== "call" || typeof id !== "string" || typeof method !== "string") return null;
  const reply = IsolateReplyFrameSchema.safeParse({ t: "reply", id, ok: false, error: "" });
  return reply.success ? { id, method } : null;
}

function describe(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function refusalFrame(id: string, reason: unknown, prefix = ""): IsolateReplyFrame {
  return IsolateReplyFrameSchema.parse({
    t: "reply",
    id,
    ok: false,
    error: `${prefix}${describe(reason)}`.slice(0, ISOLATE_ERROR_TEXT_MAX),
  });
}

function argText(method: WebHostMethod, args: readonly unknown[], index: number): string {
  const value = args[index];
  if (typeof value !== "string") {
    throw new TypeError(`${method}: argument ${String(index)} must be a string`);
  }
  return value;
}

const SubscriptionTopicsSchema = ManifoldRefSchema.array().max(64);

interface MountOptions {
  readonly kind?: "panel" | "section";
  readonly host?: HostServices;
  readonly arg?: PanelArg | undefined;
}

interface Mounted {
  readonly panel: string;
  readonly kind: "panel" | "section";
  host: HostServices;
  arg: PanelArg | undefined;
  offStatus: (() => void) | null;
  offAuthority: (() => void) | null;
  authorityEpoch: number;
  contextStamp: string | null;
  faulted: boolean;
  readonly onRender: (tree: UiNode) => void;
  readonly onFault: (error: string) => void;
  /** Whether a `mount` frame has gone out: only then does an `unmount` owe one. */
  announced: boolean;
}

interface Subscription {
  readonly instance: string;
  readonly topics: readonly ManifoldRef[];
  release: () => void;
  pending: boolean;
  dirty: boolean;
}

export class WorkerHost {
  private worker: WorkerLike | null = null;
  /** The panels the guest announced with `ready`; null until it has. */
  private panels: ReadonlySet<string> | null = null;
  private sections: ReadonlySet<string> = new Set();
  private contract = 0;
  private readonly mounted = new Map<string, Mounted>();
  private readonly streams = new Map<
    string,
    {
      instance: string;
      handle: StreamHandle;
      release: () => void;
      unacknowledged: number;
    }
  >();
  private readonly subscriptions = new Map<string, Subscription>();
  private offVisibility: (() => void) | null = null;
  private started = false;
  /** The worker-wide fault, once there is one; sticky for the life of this supervisor. */
  private fault: string | null = null;
  private stopped = false;
  private host: HostServices;

  constructor(private readonly deps: WorkerHostDeps) {
    this.host = deps.host;
  }

  /**
   * The gate rebuilds its host ref on every composition change and a supervisor outlives many
   * of them, so the newest is the one every `call` is served from.
   */
  bind(host: HostServices): void {
    this.host = host;
  }

  /** Spawns the worker and sends `init`. Once per supervisor; a stopped one never restarts. */
  start(): void {
    if (this.started || this.stopped || this.fault !== null) return;
    this.started = true;
    if (typeof document !== "undefined") {
      const page = document;
      const changed = (): void => {
        for (const [instance, entry] of this.mounted) this.sendContext(instance, entry);
      };
      page.addEventListener("visibilitychange", changed);
      this.offVisibility = () => page.removeEventListener("visibilitychange", changed);
    }
    const { pluginId } = this.deps;
    const factory: WorkerFactory =
      this.deps.workerFactory ?? ((url) => blobModuleWorker(url, this.host.token, pluginId));
    const adopt = (worker: WorkerLike): void => {
      if (this.stopped || this.fault !== null) {
        worker.terminate();
        return;
      }
      this.worker = worker;
      worker.addEventListener("message", (event) => this.receive(event.data));
      worker.addEventListener("messageerror", () => {
        this.crash("a frame from the worker could not be deserialised");
      });
      worker.addEventListener("error", (event) => {
        this.crash(`uncaught error in the worker: ${event.message}`);
      });
      this.post({
        t: "init",
        pluginId,
        principal: this.deps.principal,
        caps: [...this.deps.caps],
        containerId: this.deps.containerId,
      });
    };
    let made: WorkerLike | Promise<WorkerLike>;
    try {
      made = factory(webModulePath(pluginId, this.deps.portableWorker));
    } catch (reason) {
      this.crash(`web half failed to load: ${describe(reason)}`);
      return;
    }
    if (made instanceof Promise) {
      made.then(adopt, (reason: unknown) => {
        this.crash(`web half failed to load: ${describe(reason)}`);
      });
    } else {
      adopt(made);
    }
  }

  /**
   * Mounts one panel instance. `mount` goes to the worker once it is `ready` and only if it
   * serves the panel — a declared panel with no program is a named fault on that instance, not
   * a blank tile. Returns the unmount, which sends `unmount` iff `mount` went out.
   */
  mount(
    instance: string,
    panel: string,
    onRender: (tree: UiNode) => void,
    onFault: (error: string) => void,
    options: MountOptions = {},
  ): () => void {
    if (this.fault !== null || this.stopped) {
      onFault(this.fault ?? "worker is stopped");
      return () => {};
    }
    if (this.mounted.has(instance)) throw new Error("duplicate mounted instance");
    const entry: Mounted = {
      panel,
      kind: options.kind ?? "panel",
      host: options.host ?? this.host,
      arg: options.arg,
      offStatus: null,
      offAuthority: null,
      authorityEpoch: 0,
      contextStamp: null,
      faulted: false,
      onRender,
      onFault,
      announced: false,
    };
    this.mounted.set(instance, entry);
    if (this.panels !== null) this.announce(instance, entry);
    return () => {
      if (this.mounted.get(instance) !== entry) return;
      this.mounted.delete(instance);
      this.releaseInstance(instance, entry);
      if (entry.announced && this.fault === null) this.post({ t: "unmount", instance });
    };
  }

  /** Update one mount's presentation and live authority without resetting its React state. */
  update(instance: string, host: HostServices, arg?: PanelArg): void {
    const entry = this.mounted.get(instance);
    if (entry === undefined || entry.faulted) return;
    const changedClient = entry.host.client !== host.client;
    entry.host = host;
    entry.arg = arg;
    if (entry.announced && this.contract >= 9) {
      if (changedClient) {
        entry.authorityEpoch += 1;
        try {
          this.observeStatus(instance, entry);
          for (const [id, stream] of this.streams) {
            if (stream.instance !== instance) continue;
            this.closeStream(id);
            this.post({
              t: "stream",
              id,
              message: {
                type: "stream_closed",
                subscriptionId: id,
                reason: "host_context_changed",
              },
            });
          }
          for (const [id, subscription] of this.subscriptions) {
            if (subscription.instance !== instance) continue;
            this.bindSubscription(id, subscription, host.client);
            this.notify(id, subscription);
          }
        } catch (reason) {
          this.faultInstance(instance, entry, describe(reason));
          return;
        }
      }
      this.sendContext(instance, entry);
    }
  }

  /** A named callback firing on a mounted instance's tree; dropped if the instance is gone. */
  event(instance: string, event: string, payload?: unknown): void {
    const entry = this.mounted.get(instance);
    if (entry === undefined || !entry.announced || entry.faulted || this.fault !== null) return;
    this.post(
      payload === undefined
        ? { t: "event", instance, event }
        : { t: "event", instance, event, payload },
    );
  }

  /** Terminates the worker. Every mounted instance is forgotten: the supervisor is done. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const [instance, entry] of this.mounted) this.releaseInstance(instance, entry);
    this.mounted.clear();
    this.offVisibility?.();
    this.offVisibility = null;
    this.worker?.terminate();
    this.worker = null;
  }

  private announce(instance: string, entry: Mounted): void {
    if (this.panels === null) return;
    const contributions = entry.kind === "section" ? this.sections : this.panels;
    if (!contributions.has(entry.panel)) {
      this.faultInstance(
        instance,
        entry,
        `${entry.kind} "${entry.panel}" is declared by ${this.deps.pluginId} but its web half serves no component for it`,
      );
      return;
    }
    entry.announced = true;
    if (this.contract < 9) {
      this.post({ t: "mount", instance, panel: entry.panel });
      return;
    }
    this.observeStatus(instance, entry);
    const context = this.context(entry);
    entry.contextStamp = JSON.stringify({ context, arg: entry.arg });
    this.post({
      t: "mount",
      instance,
      panel: entry.panel,
      kind: entry.kind,
      context,
      ...(entry.arg === undefined ? {} : { arg: entry.arg }),
    });
  }

  private context(entry: Mounted): WebHostContext {
    const { host } = entry;
    return WebHostContextSchema.parse({
      principal: host.principal,
      caps: host.client.selfCaps(),
      ...(this.contract < 12
        ? {}
        : {
            workspaceCaps: host.client.workspaceCaps(),
            workspaceEvents: host.client.workspaceEventsAvailable(),
          }),
      containerId: host.containerId,
      topics: host.topics,
      status: host.client.status,
      hidden: typeof document !== "undefined" && document.hidden,
      canAuthor: host.authoring !== null,
    });
  }

  private observeStatus(instance: string, entry: Mounted): void {
    entry.offStatus?.();
    entry.offAuthority?.();
    entry.offAuthority = null;
    const client = entry.host.client;
    entry.offStatus = entry.host.client.on("status", () => this.sendContext(instance, entry));
    if (this.contract >= 12) {
      entry.offAuthority = client.onAuthorityChange(() => {
        if (entry.host.client !== client || this.mounted.get(instance) !== entry || entry.faulted)
          return;
        entry.authorityEpoch += 1;
        this.sendContext(instance, entry);
      });
    }
  }

  private sendContext(instance: string, entry: Mounted): void {
    if (
      this.contract < 9 ||
      !entry.announced ||
      entry.faulted ||
      this.mounted.get(instance) !== entry
    )
      return;
    const context = this.context(entry);
    const stamp = JSON.stringify({ context, arg: entry.arg });
    if (stamp === entry.contextStamp) return;
    entry.contextStamp = stamp;
    this.post({
      t: "context",
      instance,
      context,
      ...(entry.arg === undefined ? {} : { arg: entry.arg }),
    });
  }

  private releaseInstance(instance: string, entry: Mounted): void {
    entry.offStatus?.();
    entry.offStatus = null;
    entry.offAuthority?.();
    entry.offAuthority = null;
    entry.authorityEpoch += 1;
    for (const [id, stream] of this.streams) {
      if (stream.instance === instance) this.closeStream(id);
    }
    for (const [id, subscription] of this.subscriptions) {
      if (subscription.instance === instance) this.closeSubscription(id);
    }
  }

  private faultInstance(instance: string, entry: Mounted, error: string): void {
    if (entry.faulted) return;
    entry.faulted = true;
    this.releaseInstance(instance, entry);
    if (entry.announced) this.post({ t: "unmount", instance });
    entry.onFault(error);
  }

  private post(frame: WebIsolateHostFrame): void {
    this.worker?.postMessage(frame);
  }

  private receive(data: unknown): void {
    if (this.fault !== null || this.stopped) return;
    const parsed = WebIsolateWorkerFrameSchema.safeParse(data);
    if (!parsed.success) {
      const unserved = unservedCall(data);
      if (unserved !== null) {
        this.reply(refusalFrame(unserved.id, `slice_unavailable: ${unserved.method}`));
        return;
      }
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.map(String).join(".") || "(root)"} ${issue.message}`)
        .join("; ");
      this.crash(`malformed frame from the worker: ${issues}`);
      return;
    }
    const frame = parsed.data;
    switch (frame.t) {
      case "ready": {
        if (this.panels !== null) return;
        const contract = frame.hardenedContract ?? 1;
        if (
          !HARDENED_CONTRACT_COMPAT_VERSIONS.has(contract) ||
          (this.deps.portableWorker === true && contract < 9)
        ) {
          this.crash(`unsupported web hardened contract ${String(contract)}`);
          return;
        }
        this.contract = contract;
        if (contract >= 12) {
          // The common init handshake predates knowing the guest's admitted contract.
          this.post({
            t: "init",
            pluginId: this.deps.pluginId,
            principal: this.deps.principal,
            caps: [...this.host.client.selfCaps()],
            containerId: this.deps.containerId,
            workspaceCaps: [...this.host.client.workspaceCaps()],
            workspaceEvents: this.host.client.workspaceEventsAvailable(),
          });
        }
        this.sections = new Set(frame.sections ?? []);
        this.panels = new Set(frame.panels);
        for (const [instance, entry] of this.mounted) this.announce(instance, entry);
        return;
      }
      case "render": {
        const entry = this.mounted.get(frame.instance);
        if (entry?.announced === true && !entry.faulted) entry.onRender(frame.tree);
        return;
      }
      case "call": {
        void this.serve(frame);
        return;
      }
      case "fault": {
        if (frame.instance === undefined) {
          this.crash(frame.error);
          return;
        }
        const entry = this.mounted.get(frame.instance);
        if (entry !== undefined) this.faultInstance(frame.instance, entry, frame.error);
        return;
      }
      default: {
        const unreachable: never = frame;
        throw new Error(`unhandled worker frame ${String(unreachable)}`);
      }
    }
  }

  private async serve(frame: CallFrame): Promise<void> {
    let reply: IsolateReplyFrame;
    const scoped = this.contract >= 9 || this.deps.portableWorker === true;
    const owner = frame.instance === undefined ? undefined : this.mounted.get(frame.instance);
    const syncEpoch = owner?.authorityEpoch;
    const syncClient = owner?.host.client;
    if (scoped && (owner === undefined || !owner.announced || owner.faulted)) {
      this.reply(refusalFrame(frame.id, "call owner is not mounted"));
      return;
    }
    try {
      const value: unknown = await this.dispatch(frame.method, frame.args, frame.instance);
      const result =
        frame.method === "syncSubscriptions" &&
        (owner?.authorityEpoch !== syncEpoch || owner?.host.client !== syncClient)
          ? false
          : this.contract < 10
            ? legacyMachineResult(frame, value)
            : value;
      reply = { t: "reply", id: frame.id, ok: true, result };
    } catch (reason) {
      reply = refusalFrame(frame.id, reason);
    }
    if (this.fault !== null || this.stopped) return;
    if (
      scoped &&
      owner !== undefined &&
      (this.mounted.get(frame.instance!) !== owner || owner.faulted)
    )
      return;
    this.reply(reply);
  }

  private reply(frame: IsolateReplyFrame): void {
    const reply = IsolateReplyFrameSchema.parse(frame);
    try {
      this.post(reply);
    } catch (reason) {
      // A result the structured clone refuses (a live handle, a function): answer once by id.
      this.post(refusalFrame(frame.id, reason, "result not serialisable: "));
    }
  }

  /**
   * Every served method is one of {@link SessionHandle}'s by the same name, or `navigate`, on
   * the panel's real host ref — the guest asks by name, the page acts with its own authority.
   * The SDK validates `place`'s two references against the protocol before anything goes out;
   * `action`'s arguments are `unknown` by contract (the door parses them); the rest are checked
   * here. A thrown error becomes a `reply ok:false` naming it.
   */
  private closeStream(id: string): void {
    const stream = this.streams.get(id);
    if (stream === undefined) return;
    this.streams.delete(id);
    stream.release();
    stream.handle.close();
  }

  private closeSubscription(id: string): void {
    const subscription = this.subscriptions.get(id);
    if (subscription === undefined) return;
    this.subscriptions.delete(id);
    subscription.release();
  }

  private bindSubscription(id: string, subscription: Subscription, client: SessionHandle): void {
    subscription.release();
    subscription.release = client.subscribe(subscription.topics, () =>
      this.notify(id, subscription),
    );
  }

  private notify(id: string, subscription: Subscription): void {
    if (this.subscriptions.get(id) !== subscription) return;
    if (subscription.pending) {
      subscription.dirty = true;
      return;
    }
    subscription.pending = true;
    this.post({ t: "notification", id });
  }

  private mountedOwner(instance: string | undefined): Mounted {
    const entry = instance === undefined ? undefined : this.mounted.get(instance);
    if (entry === undefined || !entry.announced || entry.faulted) {
      throw new Error("call owner is not mounted");
    }
    return entry;
  }

  private checkResourceOwner(
    resource: { readonly instance: string } | undefined,
    instance: string | undefined,
  ): void {
    if (this.contract >= 9 && resource !== undefined && resource.instance !== instance) {
      throw new Error("resource belongs to another mounted instance");
    }
  }

  private async createTerminal(
    instance: string | undefined,
    args: readonly unknown[],
  ): Promise<unknown> {
    const entry = this.mountedOwner(instance);
    const currentHost = entry.host;
    if (currentHost.authoring === null) throw new Error("terminal authoring is unavailable");
    const machineId = args[0];
    if (machineId !== null && (typeof machineId !== "string" || machineId.length === 0)) {
      throw new TypeError("createTerminal: machine id must be a string or null");
    }
    const runtime = args[1] === null ? undefined : TerminalRuntimeSchema.parse(args[1]);
    const machine =
      machineId === null
        ? undefined
        : (await currentHost.client.machines()).find((candidate) => candidate.id === machineId);
    // The lookup is asynchronous: neither a retired mount nor an obsolete host may author.
    if (
      this.stopped ||
      this.fault !== null ||
      this.mountedOwner(instance) !== entry ||
      entry.host.client !== currentHost.client ||
      entry.host.token !== currentHost.token
    ) {
      throw new Error("terminal authoring context changed");
    }
    const authoring = entry.host.authoring;
    if (authoring === null) throw new Error("terminal authoring is unavailable");
    if (machineId !== null && machine === undefined)
      throw new Error("machine is no longer available");
    return authoring.createTerminal(machine, runtime);
  }

  private dispatch(
    method: WebHostMethod,
    args: readonly unknown[],
    instance: string | undefined,
  ): unknown {
    const host = this.contract >= 9 ? this.mountedOwner(instance).host : this.host;
    const client = host.client;
    if (method === "syncSubscriptions" && this.contract < 12) {
      throw new Error("slice_unavailable: syncSubscriptions requires hardened contract 12");
    }
    if (
      this.contract < 9 &&
      (method === "subscribe" ||
        method === "unsubscribe" ||
        method === "ackEvent" ||
        method === "createTerminal")
    ) {
      throw new Error(`slice_unavailable: ${method} requires hardened contract 9`);
    }
    switch (method) {
      case "syncSubscriptions":
        if (args.length !== 0) throw new TypeError("syncSubscriptions takes no arguments");
        return client.syncSubscriptions().then((synced) => {
          if (typeof synced !== "boolean") {
            throw new TypeError("syncSubscriptions result must be a boolean");
          }
          return synced;
        });
      case "subscribe": {
        this.mountedOwner(instance);
        const id = argText(method, args, 0);
        if (id.length === 0 || id.length > 64) throw new Error("invalid subscription id");
        if (this.subscriptions.has(id)) throw new Error("duplicate subscription id");
        if (this.subscriptions.size >= 64) throw new Error("too many event subscriptions");
        const topics = SubscriptionTopicsSchema.parse(args[1]);
        const subscription: Subscription = {
          instance: instance!,
          topics,
          release: () => {},
          pending: false,
          dirty: false,
        };
        this.subscriptions.set(id, subscription);
        try {
          this.bindSubscription(id, subscription, client);
        } catch (reason) {
          this.closeSubscription(id);
          throw reason;
        }
        return null;
      }
      case "unsubscribe": {
        const id = argText(method, args, 0);
        this.checkResourceOwner(this.subscriptions.get(id), instance);
        this.closeSubscription(id);
        return null;
      }
      case "ackEvent": {
        const id = argText(method, args, 0);
        const subscription = this.subscriptions.get(id);
        this.checkResourceOwner(subscription, instance);
        if (subscription === undefined || !subscription.pending) return null;
        subscription.pending = false;
        if (subscription.dirty) {
          subscription.dirty = false;
          this.notify(id, subscription);
        }
        return null;
      }
      case "createTerminal":
        return this.createTerminal(instance, args);
      case "openStream": {
        const id = argText(method, args, 0);
        if (id.length === 0 || id.length > 64) throw new Error("invalid stream handle id");
        const owner = this.contract >= 9 ? instance : argText(method, args, 2);
        this.mountedOwner(owner);
        if (this.contract >= 9 && args[2] !== undefined && args[2] !== owner) {
          throw new Error("stream owner does not match call owner");
        }
        if (this.streams.has(id)) throw new Error("duplicate stream handle");
        if (this.streams.size >= 64) throw new Error("too many stream subscriptions");
        const options = args[1];
        if (typeof options !== "object" || options === null)
          throw new Error("stream options required");
        const request = StreamOpenSchema.parse({
          ...options,
          type: "stream_open",
          subscriptionId: id,
        });
        const handle = client.openStream(request);
        const stream = { instance: owner!, handle, release: () => {}, unacknowledged: 0 };
        this.streams.set(id, stream);
        stream.release = handle.on((message) => {
          if (this.streams.get(id) !== stream) return;
          if (stream.unacknowledged >= 64) {
            this.closeStream(id);
            this.post({
              t: "stream",
              id,
              message: {
                type: "stream_closed",
                subscriptionId: message.subscriptionId,
                reason: "slow_consumer",
              },
            });
            return;
          }
          stream.unacknowledged += 1;
          this.post({ t: "stream", id, message });
          if (message.type === "stream_closed" || message.type === "stream_refused")
            this.closeStream(id);
        });
        return null;
      }
      case "closeStream": {
        const id = argText(method, args, 0);
        this.checkResourceOwner(this.streams.get(id), instance);
        this.closeStream(id);
        return null;
      }
      case "ackStream": {
        const stream = this.streams.get(argText(method, args, 0));
        this.checkResourceOwner(stream, instance);
        if (stream !== undefined && stream.unacknowledged > 0) stream.unacknowledged -= 1;
        return null;
      }
      case "action":
        return client.action(argText(method, args, 0), args[1]);
      case "place":
        return client.place(args[0] as PlacementRef, args[1] as PlacementDestination);
      case "selfCaps":
        return client.selfCaps();
      case "machines":
        return client.machines();
      case "resolve":
        return client.resolve(argText(method, args, 0));
      case "navigate":
        host.navigate(argText(method, args, 0));
        return null;
      case "openTerminal": {
        // The SDK parses the frame against the protocol before it goes out; this only keeps a
        // non-object from reaching it, since the SDK reads fields off the options first.
        const opts = args[0];
        if (typeof opts !== "object" || opts === null || Array.isArray(opts)) {
          throw new TypeError(`${method}: argument 0 must be an object`);
        }
        return client.openTerminal(opts as OpenTerminalOpts);
      }
      case "sendTerminalInput": {
        const data = args[1];
        if (typeof data !== "string" && !(data instanceof Uint8Array)) {
          throw new TypeError(`${method}: argument 1 must be a string or bytes`);
        }
        client.sendTerminalInput(argText(method, args, 0), data);
        return null;
      }
      case "terminalsByContainer":
        return client.terminalsByContainer();
      default: {
        const unreachable: never = method;
        throw new Error(`slice_unavailable: ${String(unreachable)}`);
      }
    }
  }

  /** A worker-wide fault: reported once, shown on every instance, and the worker is stopped. */
  private crash(error: string): void {
    if (this.fault !== null) return;
    this.fault = error;
    console.error("evt=web_isolate_fault", { plugin: this.deps.pluginId, error });
    for (const entry of this.mounted.values()) entry.onFault(error);
    this.stop();
  }
}

/** One panel instance's hold on a plugin's worker; the last release stops it after a grace. */
export interface WorkerLease {
  readonly worker: WorkerHost;
  release(): void;
}

/**
 * How long a worker outlives its last mounted instance. Long enough that a layout gesture, a
 * StrictMode double-mount or a pane swap does not cost a fetch and a re-init; short enough that
 * disabling a plugin (whose panels unmount into placeholders) frees its worker promptly.
 */
export const WORKER_GRACE_MS = 5_000;

interface Held {
  readonly worker: WorkerHost;
  readonly token: string;
  refs: number;
  reaper: ReturnType<typeof setTimeout> | null;
}

export interface WorkerRegistryOptions {
  readonly graceMs?: number | undefined;
  readonly workerFactory?: WorkerFactory | undefined;
}

/**
 * THE WORKERS THIS PAGE HOLDS, keyed by (plugin, container): created lazily on the first mount
 * that needs one, shared by every instance that follows, stopped {@link WORKER_GRACE_MS} after
 * the last release unless another mount reclaims it first. A stopped worker is forgotten, so a
 * faulted plugin gets a fresh worker — and a fresh chance — the next time one of its panels is
 * mounted after the grace, which is what disable-then-enable does.
 * A new credential retires the old supervisor immediately: its module fetch and
 * initial authority belong to the previous admission, not the current one.
 */
export class WorkerRegistry {
  private readonly held = new Map<string, Held>();

  constructor(private readonly options: WorkerRegistryOptions = {}) {}

  acquire(pluginId: string, host: HostServices, portableWorker = false): WorkerLease {
    const key = `${pluginId}\u0000${host.containerId ?? ""}\u0000${portableWorker ? "react" : "legacy"}`;
    let held = this.held.get(key);
    if (held !== undefined && held.token !== host.token) {
      if (held.reaper !== null) clearTimeout(held.reaper);
      held.worker.stop();
      this.held.delete(key);
      held = undefined;
    }
    if (held === undefined) {
      const worker = new WorkerHost({
        pluginId,
        principal: host.principal,
        caps: host.client.selfCaps(),
        containerId: host.containerId,
        host,
        portableWorker,
        workerFactory: this.options.workerFactory,
      });
      held = { worker, token: host.token, refs: 0, reaper: null };
      this.held.set(key, held);
      worker.start();
    }
    if (held.reaper !== null) {
      clearTimeout(held.reaper);
      held.reaper = null;
    }
    held.refs += 1;
    held.worker.bind(host);
    const hold = held;
    let released = false;
    return {
      worker: hold.worker,
      release: () => {
        if (released) return;
        released = true;
        hold.refs -= 1;
        if (hold.refs > 0 || this.held.get(key) !== hold) return;
        hold.reaper = setTimeout(() => {
          hold.reaper = null;
          if (hold.refs > 0 || this.held.get(key) !== hold) return;
          this.held.delete(key);
          hold.worker.stop();
        }, this.options.graceMs ?? WORKER_GRACE_MS);
      },
    };
  }

  /** Every held worker, stopped now: the page is going away, or a test is done. */
  stopAll(): void {
    for (const held of this.held.values()) {
      if (held.reaper !== null) clearTimeout(held.reaper);
      held.worker.stop();
    }
    this.held.clear();
  }
}
