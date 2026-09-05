import type { HostServices, SessionHandle } from "@manifold/plugin";
import { instanceUrl } from "@manifold/plugin/hooks";
import {
  WebIsolateWorkerFrameSchema,
  type Cap,
  type PlacementDestination,
  type PlacementRef,
  type Principal,
  type UiNode,
  type WebHostMethod,
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
  readonly workerFactory?: WorkerFactory | undefined;
}

/** Where an installed plugin's web half is served, as a path on the instance (CONTRACTS.md). */
export function webModulePath(pluginId: string): string {
  return `/api/plugins/${encodeURIComponent(pluginId)}/web.js`;
}

/**
 * The default factory. A `Worker` cannot carry an `Authorization` header and a token may never
 * ride a URL (invariant 6), so the PAGE fetches the module with the bearer and spawns the worker
 * from a Blob of the bytes. The object URL is revoked as soon as the constructor has parsed it —
 * the blob URL entry is captured at parse time, so the worker's own fetch still resolves — and
 * the worker sees `blob:` as its origin, which is why a bundle has to be self-contained.
 */
async function blobModuleWorker(path: string, token: string, name: string): Promise<WorkerLike> {
  const response = await fetch(instanceUrl(path), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`web half fetch failed (${String(response.status)})`);
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

/**
 * A `call` the closed method vocabulary does not name, read just far enough to answer it. The
 * full schema refuses it (and a refused frame is a worker-wide fault), but a guest built against
 * a newer vocabulary asking for a slice this host does not serve deserves the per-call refusal
 * the server side gives (`slice_unavailable`), not a dead panel.
 */
function unservedCall(data: unknown): { readonly id: string; readonly method: string } | null {
  if (typeof data !== "object" || data === null) return null;
  const { t, id, method } = data as { t?: unknown; id?: unknown; method?: unknown };
  if (t !== "call" || typeof id !== "string" || id === "" || typeof method !== "string") {
    return null;
  }
  return { id, method };
}

function describe(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function argText(method: WebHostMethod, args: readonly unknown[], index: number): string {
  const value = args[index];
  if (typeof value !== "string") {
    throw new TypeError(`${method}: argument ${String(index)} must be a string`);
  }
  return value;
}

interface Mounted {
  readonly panel: string;
  readonly onRender: (tree: UiNode) => void;
  readonly onFault: (error: string) => void;
  /** Whether a `mount` frame has gone out: only then does an `unmount` owe one. */
  announced: boolean;
}

export class WorkerHost {
  private worker: WorkerLike | null = null;
  /** The panels the guest announced with `ready`; null until it has. */
  private panels: ReadonlySet<string> | null = null;
  private readonly mounted = new Map<string, Mounted>();
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
    if (this.worker !== null || this.stopped || this.fault !== null) return;
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
      made = factory(webModulePath(pluginId));
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
  ): () => void {
    if (this.fault !== null) {
      onFault(this.fault);
      return () => {};
    }
    const entry: Mounted = { panel, onRender, onFault, announced: false };
    this.mounted.set(instance, entry);
    if (this.panels !== null) this.announce(instance, entry);
    return () => {
      if (this.mounted.get(instance) !== entry) return;
      this.mounted.delete(instance);
      if (entry.announced && this.fault === null) this.post({ t: "unmount", instance });
    };
  }

  /** A named callback firing on a mounted instance's tree; dropped if the instance is gone. */
  event(instance: string, event: string, payload?: unknown): void {
    const entry = this.mounted.get(instance);
    if (entry === undefined || !entry.announced || this.fault !== null) return;
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
    this.mounted.clear();
    this.worker?.terminate();
    this.worker = null;
  }

  private announce(instance: string, entry: Mounted): void {
    if (this.panels === null) return;
    if (!this.panels.has(entry.panel)) {
      entry.onFault(
        `panel "${entry.panel}" is declared by ${this.deps.pluginId} but its web half serves no program for it`,
      );
      return;
    }
    entry.announced = true;
    this.post({ t: "mount", instance, panel: entry.panel });
  }

  private post(frame: WebIsolateHostFrame): void {
    this.worker?.postMessage(frame);
  }

  private receive(data: unknown): void {
    if (this.fault !== null) return;
    const parsed = WebIsolateWorkerFrameSchema.safeParse(data);
    if (!parsed.success) {
      const unserved = unservedCall(data);
      if (unserved !== null) {
        this.post({
          t: "reply",
          id: unserved.id,
          ok: false,
          error: `slice_unavailable: ${unserved.method}`,
        });
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
        this.panels = new Set(frame.panels);
        for (const [instance, entry] of this.mounted) this.announce(instance, entry);
        return;
      }
      case "render": {
        const entry = this.mounted.get(frame.instance);
        if (entry?.announced === true) entry.onRender(frame.tree);
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
        this.mounted.get(frame.instance)?.onFault(frame.error);
        return;
      }
      default: {
        const unreachable: never = frame;
        throw new Error(`unhandled worker frame ${String(unreachable)}`);
      }
    }
  }

  private async serve(frame: CallFrame): Promise<void> {
    let reply: WebIsolateHostFrame;
    try {
      const result: unknown = await this.dispatch(frame.method, frame.args);
      reply = { t: "reply", id: frame.id, ok: true, result };
    } catch (reason) {
      reply = { t: "reply", id: frame.id, ok: false, error: describe(reason) };
    }
    if (this.fault !== null || this.stopped) return;
    try {
      this.post(reply);
    } catch (reason) {
      // A result the structured clone refuses (a live handle, a function): the refusal names it.
      this.post({
        t: "reply",
        id: frame.id,
        ok: false,
        error: `result not serialisable: ${describe(reason)}`,
      });
    }
  }

  /**
   * Every served method is one of {@link SessionHandle}'s by the same name, or `navigate`, on
   * the panel's real host ref — the guest asks by name, the page acts with its own authority.
   * The SDK validates `place`'s two references against the protocol before anything goes out;
   * `action`'s arguments are `unknown` by contract (the door parses them); the rest are checked
   * here. A thrown error becomes a `reply ok:false` naming it.
   */
  private dispatch(method: WebHostMethod, args: readonly unknown[]): unknown {
    const client: SessionHandle = this.host.client;
    switch (method) {
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
        this.host.navigate(argText(method, args, 0));
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
    this.worker?.terminate();
    this.worker = null;
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
 */
export class WorkerRegistry {
  private readonly held = new Map<string, Held>();

  constructor(private readonly options: WorkerRegistryOptions = {}) {}

  acquire(pluginId: string, host: HostServices): WorkerLease {
    const key = `${pluginId}\u0000${host.containerId ?? ""}`;
    let held = this.held.get(key);
    if (held === undefined) {
      const worker = new WorkerHost({
        pluginId,
        principal: host.principal,
        caps: host.client.selfCaps(),
        containerId: host.containerId,
        host,
        workerFactory: this.options.workerFactory,
      });
      held = { worker, refs: 0, reaper: null };
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
        if (hold.refs > 0) return;
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
