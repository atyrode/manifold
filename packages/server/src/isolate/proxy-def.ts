import type {
  AnyActionDef,
  AssemblyDelta,
  JobSettledCtx,
  LifecycleCtx,
  PluginDatabase,
  PluginJobContext,
  PluginLifecycle,
  PluginMigration,
  PluginStorage,
  SqlParam,
  SqlRow,
  SqlStatement,
} from "@manifold/plugin";
import {
  MAX_SQL_BATCH_STATEMENTS,
  MAX_SQL_PARAMS,
  MAX_SQL_PARAMS_BYTES,
  MAX_SQL_STATEMENT_BYTES,
} from "@manifold/plugin";
import {
  AskableCapSchema,
  GuestMigrationDeclarationsSchema,
  ManifoldRefSchema,
  LocalNameSchema,
  PlaceRequestSchema,
  ListJobRunsArgsSchema,
  type ActionSummary,
  type IsolateChildFrame,
  type IsolateCtxMethod,
  type IsolateHook,
  type PluginManifest,
  type SettledJob,
} from "@manifold/protocol";
import { z } from "zod";
import type { ActionCtx, ActionHandler } from "../plugin-host.ts";
import { IsolateDenial, IsolateLoadError, type IsolateLoadResult } from "./contract.ts";
import { JobExecuteArgsSchema, JobScheduleArgsSchema, jobDoorSchemas } from "../job-doors.ts";
import { serviceDoorSchemas } from "../service-doors.ts";
import { machineDoorSchemas } from "../machine-doors.ts";

/**
 * THE TWO DIRECTIONS OF PROXYING, both pure over a transport. Outbound: the child's `loaded`
 * report becomes a `ServerPluginDef` whose handlers and hooks are round trips. Inbound: a
 * child's `call` is served from the ctx of the request it belongs to. Neither direction
 * knows about processes, budgets or deadlines — that is the supervisor's — which is what
 * lets this file be checked against a scripted transport with no child at all.
 */

type LoadedFrame = Extract<IsolateChildFrame, { t: "loaded" }>;
export type IsolateDispatchOutcome = Extract<IsolateChildFrame, { t: "dispatched" }>["outcome"];

/**
 * One round trip into the child, as a proxy asks for it. `dispatch` answers with the child's
 * own verdict; both reject with {@link IsolateDenial} `unavailable` when the child is not
 * there to answer — crashed, evicted and failing to respawn, or silent past the deadline.
 */
export interface IsolateTransport {
  dispatch(action: string, args: unknown, ctx: ActionCtx): Promise<IsolateDispatchOutcome>;
  hook(hook: IsolateHook, ctx: LifecycleCtx, delta?: AssemblyDelta): Promise<void>;
  /** `onJobSettled` alone: its own ctx (the job slice rides it) and its own argument. */
  settled(ctx: JobSettledCtx, job: SettledJob): Promise<void>;
  migrate(
    migration: Pick<PluginMigration, "name" | "to">,
    storage: PluginStorage,
    database?: PluginDatabase,
  ): Promise<void>;
}

/**
 * One reported door as the host assembles it. Names arrive fully qualified (`ActionSummary`)
 * and are made local here; a name outside the plugin's own namespace fails the load rather
 * than the roster. `input` and `result` are `z.unknown()` carrying the child's JSON Schema as
 * metadata, so `assembleRoster`'s `z.toJSONSchema` publishes exactly what the child said.
 *
 * Exported because a refused install builds its roster doors from the SAME summaries, kept on
 * its row since the load that admitted them (`plugin-host.ts` `unverifiedDef`): one reading of
 * a summary, whether the handler behind it is a round trip or a standing refusal.
 */
export function localActionDef(pluginId: string, summary: ActionSummary): AnyActionDef {
  const prefix = `${pluginId}.`;
  const local = summary.name.startsWith(prefix)
    ? LocalNameSchema.safeParse(summary.name.slice(prefix.length))
    : null;
  if (local === null || !local.success) {
    throw new IsolateLoadError(
      `action "${summary.name}" is not a local name under plugin "${pluginId}"`,
    );
  }
  return {
    name: local.data,
    title: summary.title,
    caps: summary.caps,
    ...(summary.delegates === undefined ? {} : { delegates: summary.delegates }),
    scope: summary.scope,
    ...(summary.requirements === undefined ? {} : { requirements: summary.requirements }),
    ...(summary.trace === undefined ? {} : { trace: summary.trace }),
    ...(summary.cleanup === true ? { cleanup: true } : {}),
    input: z.unknown().meta({ ...summary.input }),
    result: z.unknown().meta({ ...summary.result }),
  };
}

/**
 * The def the host assembles for an installed row, built from what the child reported.
 *
 * The arguments are graded in the child against the action's own zod (the schema lives where
 * the code lives, and an `invalid_args` from there is thrown back through {@link IsolateDenial}
 * for the ladder to trace); a reader of `GET /api/plugins` sees the same shape it would for
 * an in-realm door.
 */
export function buildIsolateDef(
  manifest: PluginManifest,
  loaded: LoadedFrame,
  transport: IsolateTransport,
): IsolateLoadResult {
  const declarations = GuestMigrationDeclarationsSchema.safeParse({
    dataVersion: manifest.dataVersion,
    migrations: loaded.migrations ?? [],
  });
  if (!declarations.success) throw new IsolateLoadError(declarations.error.message);
  const { migrations } = declarations.data;
  const actions: AnyActionDef[] = [];
  const handlers: Record<string, ActionHandler> = {};
  for (const summary of loaded.actions) {
    const action = localActionDef(manifest.id, summary);
    const { name } = action;
    actions.push(action);
    handlers[name] = async (ctx: ActionCtx, args: unknown): Promise<unknown> => {
      const outcome = await transport.dispatch(name, args, ctx);
      if (!outcome.ok) {
        if (outcome.rule === "invalid_args")
          throw new IsolateDenial("invalid_args", outcome.message);
        // The handler's own domain refusal: data, exactly as an in-realm handler returns it.
        return { refused: outcome.message };
      }
      // Re-staged, never sent: the host's buffer flushes after the ledger settles (A6).
      for (const event of outcome.emits) ctx.emit(event.ref, event.kind, event.payload);
      return outcome.result;
    };
  }
  /*
    Only the hooks the child declared exist on the proxy, so the host fans out exactly what
    it would for an in-realm plugin that left a hook undefined — a round trip to say "nothing
    to do" would still count against the 2 s bound.
   */
  const lifecycle: PluginLifecycle = {
    ...(loaded.hooks.onEnable ? { onEnable: (ctx) => transport.hook("onEnable", ctx) } : {}),
    ...(loaded.hooks.onDisable ? { onDisable: (ctx) => transport.hook("onDisable", ctx) } : {}),
    ...(loaded.hooks.onAssemblyChanged
      ? { onAssemblyChanged: (ctx, delta) => transport.hook("onAssemblyChanged", ctx, delta) }
      : {}),
    ...(loaded.hooks.onJobSettled
      ? { onJobSettled: (ctx, job) => transport.settled(ctx, job) }
      : {}),
  };
  return {
    def: {
      manifest,
      actions,
      handlers,
      lifecycle,
      migrations: migrations.map((migration) => ({
        ...migration,
        migrate: (storage, database) => transport.migrate(migration, storage, database),
      })),
    },
    lifecycle,
  };
}

/**
 * The request a child's `call` belongs to. A dispatch serves the whole {@link IsolateCtxMethod}
 * list from the caller's `ActionCtx`; a lifecycle hook has only its `LifecycleCtx`, so it
 * serves storage and the plugin's own database — a hook orders its OWN durable state, and
 * rows are as much of that as keys — and answers `slice_unavailable` for the rest, the same
 * word the guest runtime uses for a slice stage 1 does not carry, EXCEPT for `jobs.*`, which
 * it serves when and only when that ctx carries the slice (the installer's restored
 * credential, #514). `onJobSettled` sits between them: it is a hook, and it carries the job
 * slice bound to the settled job's own credential, so it serves storage, the database and
 * `jobs.*` and nothing else — a separate kind because its slice is guaranteed: the host does
 * not deliver the wake without one. A MIGRATION carries storage alone: the supervisor admits
 * only `storage.*` from a migrating guest, so a guest's tables are made where the reference
 * plugin makes them — in `onEnable`, which does carry the database.
 */
export type ServedCtx =
  | { readonly kind: "dispatch"; readonly ctx: ActionCtx }
  | { readonly kind: "settled"; readonly ctx: JobSettledCtx }
  | { readonly kind: "hook"; readonly ctx: LifecycleCtx }
  | {
      readonly kind: "migration";
      readonly ctx: { readonly storage: PluginStorage; readonly database?: PluginDatabase };
    };

/** The positional argument at `index`, which the served method needs to be a string. */
function stringArg(args: readonly unknown[], index: number, method: IsolateCtxMethod): string {
  const value = args[index];
  if (typeof value !== "string") {
    throw new Error(`${method}: argument ${String(index)} must be a string`);
  }
  return value;
}

/** The `jobs.*` slice, which a dispatch and any hook holding a credential serve from its ctx. */
const JOB_METHODS = [
  "jobs.describe",
  "jobs.describeDeployment",
  "jobs.execute",
  "jobs.status",
  "jobs.listRuns",
  "jobs.input",
  "jobs.cancel",
  "jobs.output",
  "jobs.outputs",
  "jobs.journal",
  "jobs.schedule",
  "jobs.schedules",
  "jobs.disableSchedule",
] as const;
type JobsCtxMethod = (typeof JOB_METHODS)[number];
function jobsMethod(method: IsolateCtxMethod): method is JobsCtxMethod {
  return (JOB_METHODS as readonly string[]).includes(method);
}
function serveJobsCall(
  method: JobsCtxMethod,
  args: readonly unknown[],
  jobs: PluginJobContext,
): unknown {
  switch (method) {
    case "jobs.describe":
      return jobs.describe(jobDoorSchemas.describe.parse(args[0]));
    case "jobs.describeDeployment":
      return jobs.describeDeployment(jobDoorSchemas.describeDeployment.parse(args[0]));
    case "jobs.execute":
      return jobs.execute(JobExecuteArgsSchema.parse(args[0]));
    case "jobs.status":
      return jobs.status(jobDoorSchemas.status.parse({ node: args[0] }).node);
    case "jobs.listRuns":
      return jobs.listRuns(ListJobRunsArgsSchema.parse(args[0]));
    case "jobs.input":
      return jobs.input(jobDoorSchemas.input.parse(args[0]));
    case "jobs.cancel":
      return jobs.cancel(jobDoorSchemas.cancel.parse({ node: args[0] }).node);
    case "jobs.output":
      return jobs.output(jobDoorSchemas.output.parse(args[0]));
    case "jobs.outputs":
      return jobs.outputs(jobDoorSchemas.outputs.parse(args[0]));
    case "jobs.journal":
      return jobs.journal(jobDoorSchemas.journal.parse(args[0]));
    case "jobs.schedule":
      return jobs.schedule(JobScheduleArgsSchema.parse(args[0]));
    case "jobs.schedules":
      return jobs.schedules();
    case "jobs.disableSchedule":
      return jobs.disableSchedule(jobDoorSchemas.disableSchedule.parse(args[0]));
  }
}

/**
 * The plugin's own database, or the refusal that says it never asked for one. A manifest
 * without `database` has no slice on either side of the boundary (ADR 0034 §6), and the word
 * is the one the guest runtime already uses for a member stage 1 does not carry.
 */
function databaseOf(served: ServedCtx, method: IsolateCtxMethod): PluginDatabase {
  const database = served.ctx.database;
  if (database === undefined) throw new Error(`slice_unavailable: ${method}`);
  return database;
}

const SQL_WIRE_TAG = "$manifold.sql";
const MAX_SQL_BASE64_CHARS = Math.ceil(MAX_SQL_PARAMS_BYTES / 3) * 4;

interface SqlInputBudget {
  bytes: number;
}

function claimSqlInput(budget: SqlInputBudget, bytes: number, method: IsolateCtxMethod): void {
  budget.bytes += bytes;
  if (budget.bytes > MAX_SQL_PARAMS_BYTES) {
    throw new Error(`${method}: SQL input is over the ${String(MAX_SQL_PARAMS_BYTES)}-byte limit`);
  }
}

/** Decodes only the two SQLite scalar types JSON cannot carry; the database validates the rest. */
function sqlValueFromWire(
  value: unknown,
  method: IsolateCtxMethod,
  budget: SqlInputBudget,
): SqlParam {
  if (value === null || typeof value === "boolean") {
    claimSqlInput(budget, 8, method);
    return value;
  }
  if (typeof value === "string") {
    claimSqlInput(budget, Buffer.byteLength(value), method);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error(`${method}: numeric SQL parameters must be finite`);
    claimSqlInput(budget, 8, method);
    return value;
  }
  if (typeof value !== "object" || Array.isArray(value))
    throw new Error(`${method}: invalid SQL parameter`);
  const tag = Reflect.get(value, SQL_WIRE_TAG);
  const encoded = Reflect.get(value, "value");
  if (tag === "bigint" && typeof encoded === "string" && /^-?\d{1,128}$/.test(encoded)) {
    claimSqlInput(budget, Buffer.byteLength(encoded), method);
    return BigInt(encoded);
  }
  if (tag === "bytes" && typeof encoded === "string" && encoded.length <= MAX_SQL_BASE64_CHARS) {
    const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
    const decodedBytes = Math.floor(encoded.length / 4) * 3 - padding;
    claimSqlInput(budget, decodedBytes, method);
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") === encoded) return bytes;
  }
  throw new Error(`${method}: invalid encoded SQL parameter`);
}

function sqlValueToWire(value: SqlParam): unknown {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("database returned a non-finite SQL number");
  }
  if (typeof value === "bigint") return { [SQL_WIRE_TAG]: "bigint", value: value.toString() };
  if (value instanceof Uint8Array) {
    return {
      [SQL_WIRE_TAG]: "bytes",
      value: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64"),
    };
  }
  return value;
}

function sqlRowsToWire(rows: readonly SqlRow[]): readonly Readonly<Record<string, unknown>>[] {
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([column, value]) => [column, sqlValueToWire(value as SqlParam)]),
    ),
  );
}

/**
 * The bound parameters of one served statement. The frame schema bounds how many ARGUMENTS a
 * call carries and nothing about their shape, so the list is narrowed and its JSON-safe SQL
 * tags decoded here; the database applies the public type and byte bounds before execution.
 */
function paramsArg(
  args: readonly unknown[],
  index: number,
  method: IsolateCtxMethod,
  budget: SqlInputBudget = { bytes: 0 },
): readonly SqlParam[] | undefined {
  const value = args[index];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`${method}: argument ${String(index)} must be an array of parameters`);
  }
  if (value.length > MAX_SQL_PARAMS) {
    throw new Error(`${method}: too many SQL parameters`);
  }
  const decoded: SqlParam[] = [];
  for (const parameter of value) decoded.push(sqlValueFromWire(parameter, method, budget));
  return decoded;
}

/** The statement list of a served `batch`, decoded without trusting child-owned object shapes. */
function statementsArg(
  args: readonly unknown[],
  method: IsolateCtxMethod,
): readonly SqlStatement[] {
  const value = args[0];
  if (!Array.isArray(value)) {
    throw new Error(`${method}: argument 0 must be an array of statements`);
  }
  if (value.length > MAX_SQL_BATCH_STATEMENTS) {
    throw new Error(`${method}: too many SQL statements`);
  }
  const budget = { bytes: 0 };
  const decoded: SqlStatement[] = [];
  for (const statement of value) {
    if (statement === null || typeof statement !== "object" || Array.isArray(statement)) {
      throw new Error(`${method}: every statement must be an object with a sql string`);
    }
    const sql = Reflect.get(statement, "sql");
    const params = Reflect.get(statement, "params");
    if (typeof sql !== "string")
      throw new Error(`${method}: every statement must be an object with a sql string`);
    const sqlBytes = Buffer.byteLength(sql);
    if (sqlBytes > MAX_SQL_STATEMENT_BYTES)
      throw new Error(`${method}: SQL statement is too large`);
    claimSqlInput(budget, sqlBytes, method);
    const statementParams = paramsArg([params], 0, method, budget);
    decoded.push({
      sql,
      ...(statementParams === undefined ? {} : { params: statementParams }),
    });
  }
  return decoded;
}

/**
 * Serves one `call`. Every branch forwards to the SAME object an in-realm handler would
 * touch — `ctx.storage` is the plugin's own namespace, `ctx.auth.allows` grades the
 * dispatching caller, `ctx.placement.place` is the one executor — so an isolated plugin
 * reaches nothing an in-realm one could not (ADR 0016 §2). Arguments are narrowed here
 * because the frame schema bounds their count and nothing else; a wrong shape throws, and
 * the supervisor answers the throw as `{ ok: false, error }`.
 */
export async function serveCtxCall(
  method: IsolateCtxMethod,
  args: readonly unknown[],
  served: ServedCtx,
): Promise<unknown> {
  switch (method) {
    case "streams.open":
    case "streams.publish":
    case "streams.close":
    case "jobs.follow":
    case "jobs.ack":
    case "jobs.unfollow":
      throw new Error("long-lived context handles require isolate ownership");
    case "storage.get":
      return served.ctx.storage.get(stringArg(args, 0, method));
    case "storage.set":
      return served.ctx.storage.set(stringArg(args, 0, method), stringArg(args, 1, method));
    case "storage.compareAndSet":
      return served.ctx.storage.compareAndSet(
        stringArg(args, 0, method),
        args[1] === null ? null : stringArg(args, 1, method),
        stringArg(args, 2, method),
      );
    case "storage.delete":
      return served.ctx.storage.delete(stringArg(args, 0, method));
    case "storage.keys":
      return served.ctx.storage.keys(
        args[0] === undefined ? undefined : stringArg(args, 0, method),
      );
    case "database.query":
      return sqlRowsToWire(
        await databaseOf(served, method).query(
          stringArg(args, 0, method),
          paramsArg(args, 1, method),
        ),
      );
    case "database.run": {
      const result = await databaseOf(served, method).run(
        stringArg(args, 0, method),
        paramsArg(args, 1, method),
      );
      return {
        changes: result.changes,
        lastInsertRowid: sqlValueToWire(result.lastInsertRowid),
      };
    }
    case "database.batch":
      return (await databaseOf(served, method).batch(statementsArg(args, method))).map(
        sqlRowsToWire,
      );
    case "jobs.describe":
    case "jobs.describeDeployment":
    case "jobs.execute":
    case "jobs.status":
    case "jobs.listRuns":
    case "jobs.input":
    case "jobs.cancel":
    case "jobs.output":
    case "jobs.outputs":
    case "jobs.journal":
    case "jobs.schedule":
    case "jobs.schedules":
    case "jobs.disableSchedule":
    case "services.describe":
    case "services.readConfiguration":
    case "services.configureConfiguration":
    case "services.read":
    case "services.invoke":
    case "services.describeInstance":
    case "services.listInstances":
    case "services.readInstanceConfiguration":
    case "services.configureInstance":
    case "services.readInstance":
    case "services.invokeInstance":
    case "auth.allows":
    case "outsideScope":
    case "newId":
    case "machines.isOnline":
    case "machines.getTerminalExecution":
    case "machines.repository":
    case "placement.place":
    case "host.roster":
    case "host.enabled":
      break;
  }
  /*
    A hook serves `jobs.*` only when its ctx carries the slice, and the ctx carries it only
    when the installer's credential restored (`plugin-host.ts` `lifecycleCtx`). The absence is
    therefore a REFUSAL by the same name every unserved slice uses, never a downgrade to some
    other authority: a cadence a revoked installer can no longer authorize does not quietly
    register under the engine's.
   */
  if (served.kind === "hook") {
    const { jobs } = served.ctx;
    if (jobs === undefined || !jobsMethod(method)) throw new Error(`slice_unavailable: ${method}`);
    return serveJobsCall(method, args, jobs);
  }
  if (served.kind === "settled") {
    if (!jobsMethod(method)) throw new Error(`slice_unavailable: ${method}`);
    return serveJobsCall(method, args, served.ctx.jobs);
  }
  if (served.kind !== "dispatch") throw new Error(`slice_unavailable: ${method}`);
  const ctx = served.ctx;
  switch (method) {
    case "jobs.describe":
    case "jobs.describeDeployment":
    case "jobs.execute":
    case "jobs.status":
    case "jobs.listRuns":
    case "jobs.input":
    case "jobs.cancel":
    case "jobs.output":
    case "jobs.outputs":
    case "jobs.journal":
    case "jobs.schedule":
    case "jobs.schedules":
    case "jobs.disableSchedule":
      return serveJobsCall(method, args, ctx.jobs);
    case "services.describe":
      return ctx.services.describe(serviceDoorSchemas.describe.parse(args[0]));
    case "services.readConfiguration":
      return ctx.services.readConfiguration(serviceDoorSchemas.readConfiguration.parse(args[0]));
    case "services.configureConfiguration":
      return ctx.services.configureConfiguration(
        serviceDoorSchemas.configureConfiguration.parse(args[0]),
      );
    case "services.read":
      return ctx.services.read(serviceDoorSchemas.read.parse(args[0]));
    case "services.invoke":
      return ctx.services.invoke(serviceDoorSchemas.invoke.parse(args[0]));
    case "services.describeInstance":
      return ctx.services.describeInstance(serviceDoorSchemas.describeInstance.parse(args[0]));
    case "services.listInstances":
      return ctx.services.listInstances(serviceDoorSchemas.listInstances.parse(args[0]));
    case "services.readInstanceConfiguration":
      return ctx.services.readInstanceConfiguration(
        serviceDoorSchemas.readInstanceConfiguration.parse(args[0]),
      );
    case "services.configureInstance":
      return ctx.services.configureInstance(serviceDoorSchemas.configureInstance.parse(args[0]));
    case "services.readInstance":
      return ctx.services.readInstance(serviceDoorSchemas.readInstance.parse(args[0]));
    case "services.invokeInstance":
      return ctx.services.invokeInstance(serviceDoorSchemas.invokeInstance.parse(args[0]));
    case "auth.allows": {
      /*
        The ASKABLE vocabulary: the engine's capabilities without the wildcard, plus a plugin's
        own namespaced ones (ADR 0035). A hardened row's whole point is that its authority is
        its own, so the one authority question it may ask has to admit the names it declared —
        the host still answers from the rows, so admitting the NAME grants nothing.
      */
      const cap = AskableCapSchema.safeParse(args[0]);
      if (!cap.success) {
        throw new Error(`${method}: argument 0 must be a capability other than "*"`);
      }
      const ref = args[1] === undefined ? undefined : ManifoldRefSchema.safeParse(args[1]);
      if (ref !== undefined && !ref.success) {
        throw new Error(`${method}: argument 1 must be a structured reference`);
      }
      return ctx.auth.allows(cap.data, ref?.data);
    }
    case "outsideScope": {
      const containerId = args[0];
      if (containerId !== null && typeof containerId !== "string") {
        throw new Error(`${method}: argument 0 must be a container id or null`);
      }
      return ctx.outsideScope(containerId);
    }
    case "newId":
      return ctx.newId();
    case "machines.isOnline":
      return ctx.machines.isOnline(stringArg(args, 0, method));
    case "machines.getTerminalExecution":
      return ctx.machines.getTerminalExecution(stringArg(args, 0, method));
    case "machines.repository": {
      const query = machineDoorSchemas.repository.safeParse(args[0]);
      if (!query.success) throw new Error(`${method}: argument 0 is not a repository query`);
      return ctx.machines.repository(query.data.machineId, query.data.path);
    }
    case "placement.place": {
      const request = PlaceRequestSchema.safeParse(args[0]);
      if (!request.success) throw new Error(`${method}: argument 0 is not a placement request`);
      return ctx.placement.place(request.data);
    }
    case "host.roster":
      return ctx.host.roster();
    case "host.enabled":
      return ctx.host.enabled(stringArg(args, 0, method));
    default: {
      const exhaustive: never = method;
      throw new Error(`unserved ctx method ${String(exhaustive)}`);
    }
  }
}
