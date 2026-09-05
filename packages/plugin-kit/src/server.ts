import {
  EventKindSchema,
  EventPayloadSchema,
  IsolateChildFrameSchema,
  IsolateHostFrameSchema,
  MAX_ISOLATE_ACTIONS,
  MAX_ISOLATE_EMITS,
  ManifoldRefSchema,
  type ActionScope,
  type ActionSummary,
  type AssemblyDelta,
  type Cap,
  type EventKind,
  type EventPayload,
  type IsolateChildFrame,
  type IsolateCtxMethod,
  type IsolateDispatchCtx,
  type IsolateHostFrame,
  type ManifoldRef,
  type PlaceRequest,
  type PlaceResponse,
  type PlacementDenial,
  type PluginManifest,
  type PluginRoster,
  type Principal,
} from "@manifold/protocol";
import { z } from "zod";
import { HostCallError, IsolateSliceUnavailable } from "./errors.ts";

/**
 * THE SERVER GUEST RUNTIME (ADR 0016 §1, §2).
 *
 * An installed plugin's server half runs in its own Bun process, spawned by the engine's
 * supervisor with an ipc channel. This module is the child's end of that channel: it answers
 * the four host frames (`load`, `dispatch`, `hook`, `shutdown`) and serves the plugin a ctx
 * whose every engine-touching member is a `call` frame the host answers. The author writes
 * handlers against {@link GuestCtx} exactly as an in-realm plugin writes them against the
 * engine's `ActionCtx`, minus the slices stage 1 does not serve — which are absent from the
 * type and, if reached at runtime, raise {@link IsolateSliceUnavailable} by name.
 *
 * Two rungs of the denial ladder are the child's (`ISOLATE_GUEST_DENIAL_RULES`): it parses
 * arguments against the action's own zod input, and its handler may refuse on domain grounds.
 * Every other rung is graded by the host before a dispatch ever reaches this process.
 */

// ---------------------------------------------------------------------------- the definition

/**
 * One action the plugin declares, in the shape the engine's `defineAction` takes. `input` and
 * `result` are the schemas THIS process enforces; the host publishes their JSON Schema on the
 * roster from the `loaded` frame and never parses the arguments itself.
 */
export interface ServerActionDef<In = unknown, Out = unknown> {
  /** LOCAL name (`bump`); the roster publishes `${manifest.id}.${name}`. */
  readonly name: string;
  readonly title: string;
  /** What invoking this action requires of the CALLER; a subset of the manifest's ceiling. */
  readonly caps: readonly Cap[];
  /** Absent ≡ `"workspace"`; `"container"` confines the door to `ctx.containerScope`. */
  readonly scope?: ActionScope | undefined;
  /** A cleanup action stays dispatchable while the plugin is disabled (D12). */
  readonly cleanup?: boolean | undefined;
  readonly input: z.ZodType<In>;
  readonly result: z.ZodType<Out>;
}

/** Identity helper so `In`/`Out` are inferred from the schemas at the definition site. */
export function defineServerAction<In, Out>(
  def: ServerActionDef<In, Out>,
): ServerActionDef<In, Out> {
  return def;
}

/**
 * The caller's authority, as one dispatch carries it. `allows` is a call back into the host
 * because it consults grants the child never sees; everything else is data the host sent.
 */
export interface GuestAuth {
  readonly principal: Principal;
  readonly caps: readonly Cap[];
  readonly containerScope: string | null;
  readonly isRoot: boolean;
  allows(cap: Exclude<Cap, "*">, containerId?: string): Promise<boolean>;
}

/**
 * The plugin's own storage, served over the boundary. The four verbs `ISOLATE_CTX_METHODS`
 * lists; the engine's ledger verbs (`dataVersion`, `appliedMigrations`) are not served in
 * stage 1 and are therefore not on this type.
 */
export interface GuestStorage {
  readonly pluginId: string;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  keys(prefix?: string): Promise<readonly string[]>;
}

/** What the engine's placement executor answers, restated over protocol types. */
export type GuestPlaceOutcome =
  | { readonly status: "placed"; readonly result: PlaceResponse }
  | { readonly status: "denied"; readonly denial: PlacementDenial }
  | { readonly status: "failed"; readonly failure: "not_found" | "conflict" };

export type GuestEmit = (ref: ManifoldRef, kind: EventKind, payload?: EventPayload) => void;

/**
 * Everything a handler is given: the engine's `ActionCtx`, as served across a process
 * boundary. Members that ask the host a question return promises; members that are the
 * caller's own data are plain. `emit` stages, exactly as in-realm — the emissions ride back
 * on the `dispatched` frame and the host flushes them only when the outcome is `ok`.
 */
export interface GuestCtx {
  readonly pluginId: string;
  readonly principal: Principal;
  readonly auth: GuestAuth;
  readonly containerScope: string | null;
  outsideScope(containerId: string | null): Promise<{ readonly refused: string } | null>;
  now(): number;
  newId(): Promise<string>;
  readonly storage: GuestStorage;
  readonly emit: GuestEmit;
  readonly machines: { isOnline(machineId: string): Promise<boolean> };
  readonly placement: { place(request: PlaceRequest): Promise<GuestPlaceOutcome> };
  readonly host: { roster(): Promise<PluginRoster>; enabled(id: string): Promise<boolean> };
}

/**
 * What a lifecycle hook is given. Storage is served; `emit` is NOT — the `hooked` frame has
 * no carrier for emissions, so a hook that emits raises {@link IsolateSliceUnavailable} and
 * the hook fails by name rather than publishing into the void.
 */
export interface GuestLifecycleCtx {
  readonly pluginId: string;
  readonly storage: GuestStorage;
  readonly emit: GuestEmit;
  now(): number;
}

export interface GuestLifecycle {
  onEnable?(ctx: GuestLifecycleCtx): void | Promise<void>;
  onDisable?(ctx: GuestLifecycleCtx): void | Promise<void>;
  onAssemblyChanged?(ctx: GuestLifecycleCtx, delta: AssemblyDelta): void | Promise<void>;
}

/**
 * `args` is typed `never` so a handler may declare the exact input its schema parses — the
 * runtime has validated by the time it is called — while the definition holds every handler
 * in one map. Resolving `{ refused: string }` denies the dispatch with rule `refused`.
 */
export type ServerHandler = (ctx: GuestCtx, args: never) => Promise<unknown>;

export interface ServerPluginDef {
  readonly manifest: PluginManifest;
  readonly actions: readonly ServerActionDef[];
  readonly handlers: Readonly<Record<string, ServerHandler>>;
  readonly lifecycle?: GuestLifecycle | undefined;
}

// ---------------------------------------------------------------------------- the transport

/**
 * The child's end of the ipc channel, as four verbs. Production binds them to `process`;
 * tests bind them to an in-memory pair, which is how a whole host↔guest conversation runs
 * inside one test without a second process.
 */
export interface ServerGuestTransport {
  send(frame: IsolateChildFrame): void;
  onMessage(listener: (frame: unknown) => void): void;
  exit(code: number): void;
  warn(line: string): void;
}

/**
 * `process`, when this module runs as a spawned ipc child; null when merely imported. The
 * verbs are called ON `process` — `on` is an EventEmitter method and refuses a detached
 * receiver.
 */
function processTransport(): ServerGuestTransport | null {
  if (typeof process.send !== "function") return null;
  return {
    send: (frame) => {
      process.send?.(frame);
    },
    onMessage: (listener) => {
      process.on("message", listener);
    },
    exit: (code) => process.exit(code),
    warn: (line) => {
      process.stderr.write(`${line}\n`);
    },
  };
}

// ---------------------------------------------------------------------------- storage rules

/*
  The key and value discipline of `@manifold/plugin`'s `storage.ts`, restated: the kit may
  depend only on the protocol, and an author deserves the refusal before the round trip. The
  host enforces the same rules on its side of the boundary, so a drift here can only make a
  key fail EARLIER, never let one through.
 */
const STORAGE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const RESERVED_KEY_PREFIX = "$";
const MAX_STORAGE_VALUE_BYTES = 64 * 1024;

function assertStorageKey(key: string): void {
  if (key.startsWith(RESERVED_KEY_PREFIX)) {
    throw new Error(
      `storage key "${key}" is reserved: keys starting with "${RESERVED_KEY_PREFIX}" belong to the engine`,
    );
  }
  if (!STORAGE_KEY_PATTERN.test(key)) {
    throw new Error(
      `storage key "${key}" is not a valid key (ASCII, 1-128 chars, starting alphanumeric)`,
    );
  }
}

function assertStorageValue(key: string, value: string): void {
  const bytes = new TextEncoder().encode(value).byteLength;
  if (bytes > MAX_STORAGE_VALUE_BYTES) {
    throw new Error(
      `storage value for "${key}" is ${String(bytes)} bytes, over the ${String(MAX_STORAGE_VALUE_BYTES)}-byte limit`,
    );
  }
}

// ---------------------------------------------------------------------------- the runtime

/** The ActionCtx members stage 1 does not serve; reaching one is a named refusal, not a TypeError. */
const UNSERVED_SLICES = ["store", "rooms", "broker", "identity", "dials"] as const;

/** One request's calls: `<requestId>:<n>`, so the host finds the dispatch a call belongs to. */
type Call = (method: IsolateCtxMethod, args: readonly unknown[]) => Promise<unknown>;

/** Every emission is checked as it is staged, so a `dispatched` frame is valid by construction. */
const EmissionSchema = z.strictObject({
  ref: ManifoldRefSchema,
  kind: EventKindSchema,
  payload: EventPayloadSchema,
});
type Emission = z.infer<typeof EmissionSchema>;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function issueText(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.map(String).join(".") || "(root)"} ${issue.message}`)
    .join("; ");
}

/**
 * Wires a definition to a transport and starts answering host frames. `defineServerPlugin`
 * calls this with the process; tests call it with a fake host.
 */
export function attachServerGuest(def: ServerPluginDef, transport: ServerGuestTransport): void {
  const pending = new Map<
    string,
    { readonly method: IsolateCtxMethod; resolve(value: unknown): void; reject(error: Error): void }
  >();
  const actions = new Map(def.actions.map((action) => [action.name, action] as const));
  let loaded = false;

  /** Every outgoing frame is parsed first: a kit bug fails here, loudly, never as a malformed frame. */
  const post = (frame: IsolateChildFrame): void => {
    transport.send(IsolateChildFrameSchema.parse(frame));
  };

  /** A call factory bound to one request id; closed once that request has answered. */
  const callsFor = (requestId: string): { call: Call; close(): void } => {
    let seq = 0;
    let open = true;
    return {
      call: (method, args) => {
        if (!open) {
          return Promise.reject(
            new Error(`${method} called after request "${requestId}" already answered`),
          );
        }
        seq += 1;
        const id = `${requestId}:${String(seq)}`;
        const { promise, resolve, reject } = Promise.withResolvers<unknown>();
        pending.set(id, { method, resolve, reject });
        post({ t: "call", id, method, args: [...args] });
        return promise;
      },
      close: () => {
        open = false;
      },
    };
  };

  const storageFor = (call: Call): GuestStorage => ({
    pluginId: def.manifest.id,
    get: async (key) => {
      assertStorageKey(key);
      return (await call("storage.get", [key])) as string | null;
    },
    set: async (key, value) => {
      assertStorageKey(key);
      assertStorageValue(key, value);
      await call("storage.set", [key, value]);
    },
    delete: async (key) => {
      assertStorageKey(key);
      await call("storage.delete", [key]);
    },
    keys: async (prefix) =>
      (await call("storage.keys", prefix === undefined ? [] : [prefix])) as readonly string[],
  });

  const dispatchCtx = (call: Call, carried: IsolateDispatchCtx, staged: Emission[]): GuestCtx => {
    const ctx: GuestCtx = {
      pluginId: def.manifest.id,
      principal: carried.principal,
      auth: {
        principal: carried.principal,
        caps: carried.caps,
        containerScope: carried.containerScope,
        isRoot: carried.isRoot,
        allows: async (cap, containerId) =>
          (await call(
            "auth.allows",
            containerId === undefined ? [cap] : [cap, containerId],
          )) as boolean,
      },
      containerScope: carried.containerScope,
      outsideScope: async (containerId) =>
        (await call("outsideScope", [containerId])) as { refused: string } | null,
      now: () => carried.now,
      newId: async () => (await call("newId", [])) as string,
      storage: storageFor(call),
      emit: (ref, kind, payload) => {
        if (staged.length >= MAX_ISOLATE_EMITS) {
          throw new Error(`a dispatch may stage at most ${String(MAX_ISOLATE_EMITS)} emissions`);
        }
        const parsed = EmissionSchema.safeParse({ ref, kind, payload: payload ?? {} });
        if (!parsed.success) throw new Error(`emit refused: ${issueText(parsed.error)}`);
        staged.push(parsed.data);
      },
      machines: {
        isOnline: async (machineId) => (await call("machines.isOnline", [machineId])) as boolean,
      },
      placement: {
        place: async (request) => (await call("placement.place", [request])) as GuestPlaceOutcome,
      },
      host: {
        roster: async () => (await call("host.roster", [])) as PluginRoster,
        enabled: async (id) => (await call("host.enabled", [id])) as boolean,
      },
    };
    for (const slice of UNSERVED_SLICES) {
      Object.defineProperty(ctx, slice, {
        enumerable: false,
        get: () => {
          throw new IsolateSliceUnavailable(slice);
        },
      });
    }
    return ctx;
  };

  const hookCtx = (call: Call): GuestLifecycleCtx => ({
    pluginId: def.manifest.id,
    storage: storageFor(call),
    emit: () => {
      throw new IsolateSliceUnavailable("emit");
    },
    now: () => Date.now(),
  });

  /** The `loaded` payload, or the sentence that makes this definition unloadable. */
  const describe = (pluginId: string): ActionSummary[] => {
    if (pluginId !== def.manifest.id) {
      throw new Error(`loaded as "${pluginId}" but the manifest declares "${def.manifest.id}"`);
    }
    if (def.actions.length > MAX_ISOLATE_ACTIONS) {
      throw new Error(
        `${String(def.actions.length)} actions declared, at most ${String(MAX_ISOLATE_ACTIONS)} may be`,
      );
    }
    if (actions.size !== def.actions.length) {
      throw new Error("two actions share one name");
    }
    for (const name of Object.keys(def.handlers)) {
      if (!actions.has(name)) throw new Error(`handler "${name}" has no declared action`);
    }
    return def.actions.map((action) => {
      if (!Object.hasOwn(def.handlers, action.name)) {
        throw new Error(`action "${action.name}" has no handler`);
      }
      return {
        name: `${pluginId}.${action.name}`,
        title: action.title,
        caps: [...action.caps],
        ...(action.cleanup === undefined ? {} : { cleanup: action.cleanup }),
        scope: action.scope ?? "workspace",
        input: z.toJSONSchema(action.input, { io: "input" }),
        result: z.toJSONSchema(action.result, { io: "output" }),
      };
    });
  };

  const onLoad = (frame: Extract<IsolateHostFrame, { t: "load" }>): void => {
    if (loaded) {
      transport.warn("load received twice; ignored");
      return;
    }
    let summaries: ActionSummary[];
    try {
      summaries = describe(frame.pluginId);
    } catch (error) {
      post({ t: "load_failed", error: errorText(error) });
      return;
    }
    loaded = true;
    post({
      t: "loaded",
      actions: summaries,
      hooks: {
        onEnable: def.lifecycle?.onEnable !== undefined,
        onDisable: def.lifecycle?.onDisable !== undefined,
        onAssemblyChanged: def.lifecycle?.onAssemblyChanged !== undefined,
      },
    });
  };

  const onDispatch = async (frame: Extract<IsolateHostFrame, { t: "dispatch" }>): Promise<void> => {
    const refuse = (rule: "invalid_args" | "refused", message: string): void => {
      post({ t: "dispatched", id: frame.id, outcome: { ok: false, rule, message } });
    };
    const action = actions.get(frame.action);
    const handler = def.handlers[frame.action];
    if (action === undefined || handler === undefined) {
      refuse("refused", `no such action "${frame.action}"`);
      return;
    }
    const parsed = action.input.safeParse(frame.args);
    if (!parsed.success) {
      refuse("invalid_args", issueText(parsed.error));
      return;
    }
    const requests = callsFor(frame.id);
    const staged: Emission[] = [];
    const ctx = dispatchCtx(requests.call, frame.ctx, staged);
    const invoke = handler as (ctx: GuestCtx, args: unknown) => Promise<unknown>;
    let produced: unknown;
    try {
      produced = await invoke(ctx, parsed.data);
    } catch (error) {
      requests.close();
      // A slice the boundary does not serve, a host call the host refused, or the handler's
      // own bug: the wire has two rungs for the child and this is the domain one. The sentence
      // reaches the caller and stderr carries the rest.
      transport.warn(`action "${frame.action}" failed: ${errorText(error)}`);
      refuse("refused", errorText(error));
      return;
    }
    requests.close();
    if (produced !== null && typeof produced === "object") {
      const denial = Reflect.get(produced, "refused");
      if (typeof denial === "string") {
        refuse("refused", denial);
        return;
      }
    }
    const result = action.result.safeParse(produced);
    if (!result.success) {
      transport.warn(`action "${frame.action}" produced a result outside its schema`);
      refuse("refused", `result outside its schema: ${issueText(result.error)}`);
      return;
    }
    post({
      t: "dispatched",
      id: frame.id,
      outcome: { ok: true, result: result.data, emits: staged },
    });
  };

  const onHook = async (frame: Extract<IsolateHostFrame, { t: "hook" }>): Promise<void> => {
    const requests = callsFor(frame.id);
    const ctx = hookCtx(requests.call);
    try {
      const lifecycle = def.lifecycle ?? {};
      switch (frame.hook) {
        case "onEnable":
          if (lifecycle.onEnable === undefined) throw new Error("onEnable is not declared");
          await lifecycle.onEnable(ctx);
          break;
        case "onDisable":
          if (lifecycle.onDisable === undefined) throw new Error("onDisable is not declared");
          await lifecycle.onDisable(ctx);
          break;
        case "onAssemblyChanged":
          if (lifecycle.onAssemblyChanged === undefined) {
            throw new Error("onAssemblyChanged is not declared");
          }
          await lifecycle.onAssemblyChanged(ctx, frame.delta ?? { enabled: [], disabled: [] });
          break;
        default: {
          const never: never = frame.hook;
          throw new Error(`unknown hook ${String(never)}`);
        }
      }
    } catch (error) {
      requests.close();
      post({ t: "hooked", id: frame.id, ok: false, error: errorText(error) });
      return;
    }
    requests.close();
    post({ t: "hooked", id: frame.id, ok: true });
  };

  const onReply = (frame: Extract<IsolateHostFrame, { t: "reply" }>): void => {
    const waiting = pending.get(frame.id);
    if (waiting === undefined) {
      transport.warn(`reply for unknown call "${frame.id}"; ignored`);
      return;
    }
    pending.delete(frame.id);
    if (frame.ok) waiting.resolve(frame.result);
    else waiting.reject(new HostCallError(waiting.method, frame.error));
  };

  transport.onMessage((message) => {
    const frame = IsolateHostFrameSchema.safeParse(message);
    if (!frame.success) {
      transport.warn(`unknown host frame ignored: ${issueText(frame.error)}`);
      return;
    }
    const host = frame.data;
    switch (host.t) {
      case "load":
        onLoad(host);
        return;
      case "dispatch":
        void onDispatch(host);
        return;
      case "hook":
        void onHook(host);
        return;
      case "reply":
        onReply(host);
        return;
      case "shutdown":
        transport.exit(0);
        return;
      default: {
        const never: never = host;
        transport.warn(`unhandled host frame ${String(never)}`);
      }
    }
  });
}

/**
 * THE AUTHORING ENTRY POINT. Call it once at the top level of your `server.ts`. When the
 * module is the entry of a spawned isolate — `process.send` exists — it wires the ipc
 * channel and starts serving; imported anywhere else (a test, a tool, `pack`) it is inert.
 */
export function defineServerPlugin(def: ServerPluginDef): void {
  const transport = processTransport();
  if (transport === null) return;
  attachServerGuest(def, transport);
}
