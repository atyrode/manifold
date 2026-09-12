import type {
  ConfigureServiceConfigurationArgs,
  JobExecution,
  ServiceConfigurationRead,
  ServiceDescription,
} from "@manifold/plugin";
import {
  EventKindSchema,
  EventPayloadSchema,
  IsolateChildFrameSchema,
  IsolateHostFrameSchema,
  MAX_ISOLATE_ACTIONS,
  MAX_ISOLATE_EMITS,
  ManifoldRefSchema,
  ListJobRunsArgsSchema,
  ListJobRunsResultSchema,
  type ListJobRunsArgs,
  type ListJobRunsResult,
  type JobDescription,
  type ActionScope,
  type ActionRequirement,
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
  type ServiceConfiguration,
  type ServiceReadArgs,
  type ServiceInvokeArgs,
  type ServiceReply,
  type ConfigureInstanceServiceArgs,
  type InstanceServiceDescription,
  type InstanceServicesDescription,
  type TerminalExecution,
  type InstanceServiceConfigurationRead,
  type InstanceServiceReadArgs,
} from "@manifold/protocol";
import {
  JobFollowSnapshotSchema,
  JobJournalPageSchema,
  JobOutputPageSchema,
  type JobFollowSnapshot,
  type JobFollowUpdate,
  type JobJournalPage,
  type JobOutputPage,
  type JobResult,
  type SettledJob,
  type JobEvent,
} from "../../protocol/src/jobs.ts";
import { z } from "zod";
import { HostCallError, IsolateSliceUnavailable, PluginDatabaseError } from "./errors.ts";

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
  /** Native job/service ceiling, not caller permission; native calls still authorize targets and consent. */
  readonly delegates?: readonly Cap[];
  /** Absent ≡ `"workspace"`; `"container"` confines the door to `ctx.containerScope`. */
  readonly scope?: ActionScope | undefined;
  readonly requirements?: readonly ActionRequirement[];
  readonly trace?: "redacted" | "opaque";
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
  allows(cap: Exclude<Cap, "*">, ref?: ManifoldRef): Promise<boolean>;
}

/**
 * The plugin's own storage, served over the boundary. The verbs `ISOLATE_CTX_METHODS`
 * lists; the engine's ledger verbs (`dataVersion`, `appliedMigrations`) are not served in
 * stage 1 and are therefore not on this type.
 */
export interface GuestStorage {
  readonly pluginId: string;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  /** Atomically replaces an exact stored value, or creates an absent key when expected is null. */
  compareAndSet(key: string, expected: string | null, value: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  keys(prefix?: string): Promise<readonly string[]>;
}

/**
 * A bound parameter and one statement, as the database takes them. The same shapes
 * `@manifold/plugin` declares; a blob is in-realm only in practice, because this boundary is
 * JSON and a `Uint8Array` does not survive it intact.
 */
export type GuestSqlParam = string | number | bigint | boolean | null | Uint8Array;
export interface GuestSqlStatement {
  readonly sql: string;
  readonly params?: readonly GuestSqlParam[];
}
export type GuestSqlRow = Readonly<Record<string, GuestSqlParam>>;

/**
 * THE PLUGIN'S OWN TABLES, served over the boundary (ADR 0034). The same three verbs an
 * in-realm plugin gets, with the same meanings: `query` returns rows, `run` returns what it
 * changed, and `batch` is the transaction — its statements are known before it starts, it
 * commits or rolls back whole, and it costs ONE round trip where a statement-at-a-time loop
 * would cost one each. Present on the context exactly when the manifest declared `database`;
 * absent otherwise, which is what the host answers `slice_unavailable` for.
 */
export interface GuestDatabase {
  readonly pluginId: string;
  query<Row extends GuestSqlRow = GuestSqlRow>(
    sql: string,
    params?: readonly GuestSqlParam[],
  ): Promise<readonly Row[]>;
  run(
    sql: string,
    params?: readonly GuestSqlParam[],
  ): Promise<{ readonly changes: number; readonly lastInsertRowid: number }>;
  batch(statements: readonly GuestSqlStatement[]): Promise<readonly (readonly GuestSqlRow[])[]>;
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
export interface GuestStreamProducer {
  readonly epoch: string;
  publish(body: unknown): Promise<void>;
  close(): Promise<void>;
  onClose(listener: () => void): () => void;
}

export type GuestJobNode = Extract<ManifoldRef, { kind: "job" }>;
export type GuestOutputNode = Extract<ManifoldRef, { kind: "output" }>;
export type GuestJobRequest = JobExecution;
export interface GuestJobStatus {
  jobId: string;
  machineId: string;
  operationId: string;
  pluginId: string;
  state: JobResult["state"];
  nextInputSeq: number | null;
  result: JobResult | null;
}
export interface GuestJobFollow {
  readonly snapshot: JobFollowSnapshot;
  close(): Promise<void>;
}
export interface GuestJobs {
  describe(args: {
    machineId: string;
    pluginId: string;
    installationRevision?: string;
  }): Promise<JobDescription>;
  execute(args: GuestJobRequest): Promise<GuestJobStatus>;
  status(node: GuestJobNode): Promise<GuestJobStatus>;
  listRuns(args: ListJobRunsArgs): Promise<ListJobRunsResult>;
  input(args: {
    node: GuestJobNode;
    requestId: string;
    seq: number;
    data: string;
    eof: boolean;
  }): Promise<{ accepted: true }>;
  cancel(node: GuestJobNode): Promise<void>;
  output(args: {
    node: GuestOutputNode;
    offset: number;
    maxBytes: number;
  }): Promise<Extract<JobEvent, { type: "output" }>>;
  outputs(args: {
    node: GuestJobNode;
    name: string;
    offset: number;
    limit: number;
  }): Promise<JobOutputPage>;
  journal(args: { node: GuestJobNode; after?: number; limit?: number }): Promise<JobJournalPage>;
  follow(node: GuestJobNode, receive: (update: JobFollowUpdate) => void): Promise<GuestJobFollow>;
}
/** What a settled-job hook may reach: every job verb except the live subscription. */
export type GuestSettledJobs = Omit<GuestJobs, "follow">;

/** The native service contract with asynchronous host calls across the isolate boundary. */
export interface GuestServices {
  describe(args: { machineId: string }): Promise<ServiceDescription>;
  readConfiguration(args: { machineId: string }): Promise<ServiceConfigurationRead>;
  configureConfiguration(args: ConfigureServiceConfigurationArgs): Promise<ServiceConfiguration>;
  read(args: ServiceReadArgs): Promise<ServiceReply>;
  invoke(args: ServiceInvokeArgs): Promise<ServiceReply>;
  describeInstance(args: { serviceId: string }): Promise<InstanceServiceDescription>;
  listInstances(args: Record<string, never>): Promise<InstanceServicesDescription>;
  readInstanceConfiguration(args: { serviceId: string }): Promise<InstanceServiceConfigurationRead>;
  configureInstance(args: ConfigureInstanceServiceArgs): Promise<InstanceServiceDescription>;
  readInstance(args: InstanceServiceReadArgs): Promise<ServiceReply>;
  invokeInstance(args: InstanceServiceReadArgs): Promise<ServiceReply>;
}

export interface GuestCtx {
  readonly traceId: IsolateDispatchCtx["traceId"];
  readonly pluginId: string;
  readonly principal: Principal;
  readonly auth: GuestAuth;
  readonly containerScope: string | null;
  outsideScope(containerId: string | null): Promise<{ readonly refused: string } | null>;
  now(): number;
  newId(): Promise<string>;
  readonly storage: GuestStorage;
  /**
   * This plugin's own tables, present exactly when its manifest declares `database`. A plugin
   * that declared none has no member here and the host answers `slice_unavailable` to anyone
   * who forges the call frame anyway (ADR 0034 §6).
   */
  readonly database?: GuestDatabase;
  readonly jobs: GuestJobs;
  readonly services: GuestServices;
  readonly streams: {
    open(kind: string, node: ManifoldRef): Promise<GuestStreamProducer>;
  };
  readonly emit: GuestEmit;
  readonly machines: {
    isOnline(machineId: string): Promise<boolean>;
    getTerminalExecution(machineId: string): Promise<TerminalExecution | null>;
  };
  readonly placement: { place(request: PlaceRequest): Promise<GuestPlaceOutcome> };
  readonly host: { roster(): Promise<PluginRoster>; enabled(id: string): Promise<boolean> };
}

/**
 * What a lifecycle hook is given. Storage is served, and so is the database when the manifest
 * declared one — a hook orders its OWN durable state, and rows are as much of that as keys.
 * `emit` is NOT: the `hooked` frame has no carrier for emissions, so a hook that emits raises
 * {@link IsolateSliceUnavailable} and the hook fails by name rather than publishing into the
 * void.
 */
export interface GuestLifecycleCtx {
  readonly pluginId: string;
  readonly storage: GuestStorage;
  readonly database?: GuestDatabase;
  readonly emit: GuestEmit;
  now(): number;
}
/** The settled hook's ctx: an ordinary hook ctx plus the settled job's own job authority. */
export interface GuestJobSettledCtx extends GuestLifecycleCtx {
  readonly jobs: GuestSettledJobs;
}

export interface GuestLifecycle {
  onEnable?(ctx: GuestLifecycleCtx): void | Promise<void>;
  onDisable?(ctx: GuestLifecycleCtx): void | Promise<void>;
  onAssemblyChanged?(ctx: GuestLifecycleCtx, delta: AssemblyDelta): void | Promise<void>;
  /** A job this plugin started reached a terminal state; the one wake a server half gets. */
  onJobSettled?(ctx: GuestJobSettledCtx, job: SettledJob): void | Promise<void>;
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

// ---------------------------------------------------------------------------- the database rules

/*
  The statement discipline of `@manifold/plugin`'s `database.ts`, restated for exactly the
  reason the storage rules above are: the kit may depend only on the protocol — `@manifold/plugin`
  pulls the engine's whole composition half, and a packed server bundle inlines what it imports
  — and an author deserves the refusal before the round trip rather than after it. The host
  enforces the same bounds on its side, so a drift here can only make a statement fail EARLIER,
  never let one through.
 */
const MAX_SQL_STATEMENT_BYTES = 64 * 1024;
const MAX_SQL_PARAMS = 999;
const MAX_SQL_BATCH_STATEMENTS = 256;
const REFUSED_LEADING_KEYWORDS: Record<string, true> = {
  ATTACH: true,
  DETACH: true,
  VACUUM: true,
  PRAGMA: true,
};
const REFUSED_FUNCTIONS = /\bload_extension\s*\(/i;

/** The first keyword of a statement, comments and leading whitespace removed; "" for none. */
function leadingKeyword(sql: string): string {
  let rest = sql;
  for (;;) {
    rest = rest.trimStart();
    if (rest.startsWith("--")) {
      const end = rest.indexOf("\n");
      if (end === -1) return "";
      rest = rest.slice(end + 1);
      continue;
    }
    if (rest.startsWith("/*")) {
      const end = rest.indexOf("*/");
      if (end === -1) return "";
      rest = rest.slice(end + 2);
      continue;
    }
    break;
  }
  const match = /^[A-Za-z_]+/.exec(rest);
  return match === null ? "" : match[0].toUpperCase();
}

function assertSqlStatement(sql: string): void {
  if (typeof sql !== "string" || sql.trim() === "") {
    throw new PluginDatabaseError("a statement must be a non-empty string");
  }
  const bytes = new TextEncoder().encode(sql).byteLength;
  if (bytes > MAX_SQL_STATEMENT_BYTES) {
    throw new PluginDatabaseError(
      `statement is ${String(bytes)} bytes, over the ${String(MAX_SQL_STATEMENT_BYTES)}-byte limit`,
    );
  }
  const keyword = leadingKeyword(sql);
  if (REFUSED_LEADING_KEYWORDS[keyword] === true) {
    throw new PluginDatabaseError(
      `${keyword} is refused: a plugin's database is one file and the engine opened it`,
    );
  }
  if (REFUSED_FUNCTIONS.test(sql)) {
    throw new PluginDatabaseError("load_extension is refused: a plugin's database loads nothing");
  }
}

function assertSqlParams(params: readonly GuestSqlParam[] | undefined): void {
  if (params === undefined) return;
  if (!Array.isArray(params)) throw new PluginDatabaseError("parameters must be an array");
  if (params.length > MAX_SQL_PARAMS) {
    throw new PluginDatabaseError(
      `${String(params.length)} parameters, over the ${String(MAX_SQL_PARAMS)} SQLite allows`,
    );
  }
}

function assertSqlBatch(statements: readonly GuestSqlStatement[]): void {
  if (!Array.isArray(statements) || statements.length === 0) {
    throw new PluginDatabaseError("a batch must hold at least one statement");
  }
  if (statements.length > MAX_SQL_BATCH_STATEMENTS) {
    throw new PluginDatabaseError(
      `a batch of ${String(statements.length)} statements is over the ${String(MAX_SQL_BATCH_STATEMENTS)}-statement limit`,
    );
  }
  for (const statement of statements) {
    assertSqlStatement(statement.sql);
    assertSqlParams(statement.params);
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
  const producerClosures = new Map<string, () => void>();
  type JobNotification = Extract<IsolateHostFrame, { t: "job_update" }>;
  interface Observer {
    ready: boolean;
    delivery: number;
    readonly queued: JobNotification[];
    readonly receive: (update: JobFollowUpdate) => void;
  }
  const observers = new Map<string, Observer>();
  let nextObserver = 0;

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
        if (pending.size >= 256) return Promise.reject(new Error("too many pending host calls"));
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

  // This channel carries only producer IDs. It cannot revive a completed dispatch's authority.
  const producerCalls = callsFor("producer");

  const deliverJob = (frame: JobNotification, observer: Observer): void => {
    if (frame.delivery !== observer.delivery + 1) {
      observers.delete(frame.id);
      void producerCalls.call("jobs.unfollow", [frame.id]).catch(() => {});
      observer.receive({ type: "closed", reason: "gap" });
      return;
    }
    observer.delivery = frame.delivery;
    try {
      observer.receive(frame.update);
    } catch {
      observers.delete(frame.id);
      void producerCalls.call("jobs.unfollow", [frame.id]).catch(() => {});
      transport.warn("job observation callback failed");
      return;
    }
    if (frame.update.type === "closed") observers.delete(frame.id);
    void producerCalls.call("jobs.ack", [frame.id, frame.delivery]).catch(() => {
      if (observers.delete(frame.id)) {
        try {
          observer.receive({ type: "closed", reason: "closed" });
        } catch {
          transport.warn("job observation callback failed");
        }
      }
    });
  };

  const receiveJob = (frame: JobNotification): void => {
    const observer = observers.get(frame.id);
    if (observer === undefined) return;
    if (observer.ready) {
      deliverJob(frame, observer);
    } else if (observer.queued.length < 16 || frame.update.type === "closed") {
      observer.queued.push(frame);
    } else {
      observers.delete(frame.id);
      void producerCalls.call("jobs.unfollow", [frame.id]).catch(() => {});
      try {
        observer.receive({ type: "closed", reason: "gap" });
      } catch {
        transport.warn("job observation callback failed");
      }
    }
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
    compareAndSet: async (key, expected, value) => {
      assertStorageKey(key);
      if (expected !== null) assertStorageValue(key, expected);
      assertStorageValue(key, value);
      return (await call("storage.compareAndSet", [key, expected, value])) as boolean;
    },
    delete: async (key) => {
      assertStorageKey(key);
      await call("storage.delete", [key]);
    },
    keys: async (prefix) =>
      (await call("storage.keys", prefix === undefined ? [] : [prefix])) as readonly string[],
  });

  /**
   * The database handle, or undefined for a plugin whose manifest declared none — the same
   * absence the host serves `slice_unavailable` for, decided here from the manifest this
   * process loaded so an author sees it in the type rather than at the boundary.
   *
   * A refusal is a REJECTION with `PluginDatabaseError`, whichever side decided: the bounds
   * above reject before the round trip, and the host's own refusal — an oversize result, a
   * SQLite error, a plugin that asked for a table it never made — is rethrown as the same
   * class, so a plugin writes one `try`/`catch` and never has to tell the sides apart.
   */
  const databaseFor = (call: Call): GuestDatabase | undefined => {
    if (def.manifest.database === undefined) return undefined;
    const ask = async (
      method: "database.query" | "database.run" | "database.batch",
      args: readonly unknown[],
    ): Promise<unknown> => {
      try {
        return await call(method, args);
      } catch (error) {
        if (error instanceof PluginDatabaseError) throw error;
        throw new PluginDatabaseError(
          error instanceof HostCallError ? error.detail : errorText(error),
        );
      }
    };
    return {
      pluginId: def.manifest.id,
      query: async <Row extends GuestSqlRow = GuestSqlRow>(
        sql: string,
        params?: readonly GuestSqlParam[],
      ) => {
        assertSqlStatement(sql);
        assertSqlParams(params);
        // Omitted, not sent as a hole: the frame is JSON, which has no `undefined`, and the
        // same reason `storage.keys` sends `[]` rather than `[undefined]` for no prefix.
        return (await ask(
          "database.query",
          params === undefined ? [sql] : [sql, params],
        )) as readonly Row[];
      },
      run: async (sql, params) => {
        assertSqlStatement(sql);
        assertSqlParams(params);
        return (await ask("database.run", params === undefined ? [sql] : [sql, params])) as {
          changes: number;
          lastInsertRowid: number;
        };
      },
      batch: async (statements) => {
        assertSqlBatch(statements);
        return (await ask("database.batch", [statements])) as readonly (readonly GuestSqlRow[])[];
      },
    };
  };

  /** Every job verb but `follow`: a live subscription belongs to a dispatch, not to a hook. */
  const jobsFor = (call: Call): GuestSettledJobs => ({
    describe: async (args) => (await call("jobs.describe", [args])) as JobDescription,
    execute: async (args) => (await call("jobs.execute", [args])) as GuestJobStatus,
    status: async (node) => (await call("jobs.status", [node])) as GuestJobStatus,
    listRuns: async (args) =>
      ListJobRunsResultSchema.parse(
        await call("jobs.listRuns", [ListJobRunsArgsSchema.parse(args)]),
      ),
    input: async (args) => (await call("jobs.input", [args])) as { accepted: true },
    cancel: async (node) => {
      await call("jobs.cancel", [node]);
    },
    output: async (args) =>
      (await call("jobs.output", [args])) as Extract<JobEvent, { type: "output" }>,
    outputs: async (args) => JobOutputPageSchema.parse(await call("jobs.outputs", [args])),
    journal: async (args) => JobJournalPageSchema.parse(await call("jobs.journal", [args])),
  });
  const dispatchCtx = (call: Call, carried: IsolateDispatchCtx, staged: Emission[]): GuestCtx => {
    // Spread, not assigned: a plugin that declared no database has NO member here, so reading
    // it is `undefined` rather than a handle that would fail one round trip later.
    const database = databaseFor(call);
    const ctx: GuestCtx = {
      traceId: carried.traceId,
      pluginId: def.manifest.id,
      principal: carried.principal,
      auth: {
        principal: carried.principal,
        caps: carried.caps,
        containerScope: carried.containerScope,
        isRoot: carried.isRoot,
        allows: async (cap, ref) =>
          (await call("auth.allows", ref === undefined ? [cap] : [cap, ref])) as boolean,
      },
      containerScope: carried.containerScope,
      outsideScope: async (containerId) =>
        (await call("outsideScope", [containerId])) as { refused: string } | null,
      now: () => carried.now,
      newId: async () => (await call("newId", [])) as string,
      storage: storageFor(call),
      ...(database === undefined ? {} : { database }),
      jobs: {
        ...jobsFor(call),
        follow: async (node, receive) => {
          if (observers.size >= 16) throw new Error("too many job observations");
          const id = `j${String(++nextObserver)}`;
          const observer: Observer = { ready: false, delivery: 0, queued: [], receive };
          observers.set(id, observer);
          try {
            const opened = (await call("jobs.follow", [node, id])) as {
              id: string;
              snapshot: unknown;
            };
            if (opened.id !== id) throw new Error("job observation identity mismatch");
            const snapshot = JobFollowSnapshotSchema.parse(opened.snapshot);
            // The awaited handle exposes its snapshot before any live callback. Frames
            // received during the handshake stay bounded and preserve delivery order.
            setTimeout(() => {
              if (observers.get(id) !== observer) return;
              observer.ready = true;
              for (const frame of observer.queued) {
                if (observers.get(id) !== observer) break;
                deliverJob(frame, observer);
              }
              observer.queued.length = 0;
            }, 0);
            return {
              snapshot,
              close: async () => {
                if (!observers.delete(id)) return;
                observer.queued.length = 0;
                await producerCalls.call("jobs.unfollow", [id]);
              },
            };
          } catch (error) {
            observers.delete(id);
            void producerCalls.call("jobs.unfollow", [id]).catch(() => {});
            throw error;
          }
        },
      },
      services: {
        describe: async (args) => (await call("services.describe", [args])) as ServiceDescription,
        readConfiguration: async (args) =>
          (await call("services.readConfiguration", [args])) as ServiceConfigurationRead,
        configureConfiguration: async (args) =>
          (await call("services.configureConfiguration", [args])) as ServiceConfiguration,
        read: async (args) => (await call("services.read", [args])) as ServiceReply,
        invoke: async (args) => (await call("services.invoke", [args])) as ServiceReply,
        describeInstance: async (args) =>
          (await call("services.describeInstance", [args])) as InstanceServiceDescription,
        listInstances: async (args) =>
          (await call("services.listInstances", [args])) as InstanceServicesDescription,
        readInstanceConfiguration: async (args) =>
          (await call("services.readInstanceConfiguration", [
            args,
          ])) as InstanceServiceConfigurationRead,
        configureInstance: async (args) =>
          (await call("services.configureInstance", [args])) as InstanceServiceDescription,
        readInstance: async (args) => (await call("services.readInstance", [args])) as ServiceReply,
        invokeInstance: async (args) =>
          (await call("services.invokeInstance", [args])) as ServiceReply,
      },
      streams: {
        open: async (kind, node) => {
          const opened = (await call("streams.open", [kind, node])) as {
            id: string;
            epoch: string;
          };
          let closed = false;
          const listeners = new Set<() => void>();
          const notify = (): void => {
            if (closed) return;
            closed = true;
            producerClosures.delete(opened.id);
            for (const listener of listeners) {
              try {
                void Promise.resolve(listener()).catch(() =>
                  transport.warn("producer close callback failed"),
                );
              } catch {
                transport.warn("producer close callback failed");
              }
            }
            listeners.clear();
          };
          producerClosures.set(opened.id, notify);
          return {
            epoch: opened.epoch,
            publish: async (body) => {
              if (closed) throw new Error("stream producer is closed");
              await producerCalls.call("streams.publish", [opened.id, body]);
            },
            close: async () => {
              if (closed) return;
              notify();
              await producerCalls.call("streams.close", [opened.id]);
            },
            onClose: (listener) => {
              if (closed) {
                try {
                  void Promise.resolve(listener()).catch(() =>
                    transport.warn("producer close callback failed"),
                  );
                } catch {
                  transport.warn("producer close callback failed");
                }
                return () => {};
              }
              listeners.add(listener);
              return () => {
                listeners.delete(listener);
              };
            },
          };
        },
      },
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
        getTerminalExecution: async (machineId) =>
          (await call("machines.getTerminalExecution", [machineId])) as TerminalExecution | null,
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

  const hookCtx = (call: Call): GuestLifecycleCtx => {
    const database = databaseFor(call);
    return {
      pluginId: def.manifest.id,
      storage: storageFor(call),
      ...(database === undefined ? {} : { database }),
      emit: () => {
        throw new IsolateSliceUnavailable("emit");
      },
      now: () => Date.now(),
    };
  };

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
        ...(action.delegates === undefined ? {} : { delegates: [...action.delegates] }),
        ...(action.cleanup === undefined ? {} : { cleanup: action.cleanup }),
        scope: action.scope ?? "workspace",
        ...(action.requirements === undefined ? {} : { requirements: [...action.requirements] }),
        ...(action.trace === undefined ? {} : { trace: action.trace }),
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
        onJobSettled: def.lifecycle?.onJobSettled !== undefined,
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
        case "onJobSettled":
          if (lifecycle.onJobSettled === undefined) {
            throw new Error("onJobSettled is not declared");
          }
          if (frame.job === undefined) throw new Error("onJobSettled carries no settled job");
          await lifecycle.onJobSettled({ ...ctx, jobs: jobsFor(requests.call) }, frame.job);
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
      case "job_update":
        receiveJob(host);
        return;
      case "producer_closed":
        producerClosures.get(host.id)?.();
        return;
      case "shutdown":
        for (const notify of producerClosures.values()) notify();
        producerClosures.clear();
        for (const observer of observers.values()) {
          try {
            observer.receive({ type: "closed", reason: "closed" });
          } catch {
            transport.warn("job observation callback failed");
          }
        }
        observers.clear();
        producerCalls.close();
        for (const waiting of pending.values()) waiting.reject(new Error("isolate shutting down"));
        pending.clear();
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
