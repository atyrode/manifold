import type { JobScheduleTiming } from "@manifold/plugin";
import { createHash } from "node:crypto";
import { canonicalJobJson, JobRequestSchema, type JobRequest } from "@manifold/protocol";
import type { ServerStore } from "./stores.ts";
import { JobOutputRuleSchema, type JobOutputRule } from "../../protocol/src/jobs.ts";

export const JOB_SCHEDULE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS job_schedules (
 schedule_id TEXT NOT NULL, revision TEXT NOT NULL, spec TEXT NOT NULL,
 next_nominal INTEGER NOT NULL, disabled_reason TEXT, audit_origin TEXT,
 PRIMARY KEY(schedule_id, revision)
);
CREATE TABLE IF NOT EXISTS job_schedule_occurrences (
 schedule_id TEXT NOT NULL, revision TEXT NOT NULL, nominal INTEGER NOT NULL,
 job_id TEXT NOT NULL UNIQUE, request TEXT NOT NULL, deadline INTEGER NOT NULL,
 state TEXT NOT NULL, reason TEXT,
 PRIMARY KEY(schedule_id, revision, nominal)
);
CREATE TABLE IF NOT EXISTS job_invocation_reservations (
 parent_job_id TEXT NOT NULL, invocation_id TEXT NOT NULL, job_id TEXT NOT NULL UNIQUE,
 root_job_id TEXT NOT NULL, depth INTEGER NOT NULL, request TEXT NOT NULL,
 edge TEXT NOT NULL, active INTEGER NOT NULL,
 PRIMARY KEY(parent_job_id, invocation_id)
);
CREATE INDEX IF NOT EXISTS job_invocation_root ON job_invocation_reservations(root_job_id);
CREATE TABLE IF NOT EXISTS job_invocation_edges (
 caller TEXT NOT NULL, operation_id TEXT NOT NULL, edge TEXT NOT NULL, enabled INTEGER NOT NULL,
 PRIMARY KEY(caller, operation_id)
);
`;

export interface JobScheduleSpec extends JobScheduleTiming {
  request: JobRequest;
}
export interface JobScheduleCallbacks {
  /** Common authority evaluator; null permits, otherwise a durable refusal reason. */
  reauthorize(request: JobRequest): string | null;
  /** Persist the job in this same SQLite transaction. Do not dispatch network I/O here. */
  enqueue(request: JobRequest): void;
  isOnline(machineId: string): boolean;
}
interface ScheduleRow {
  spec: string;
  next_nominal: number;
  disabled_reason: string | null;
}
export interface JobOccurrence {
  schedule_id: string;
  revision: string;
  nominal: number;
  job_id: string;
  request: string;
  deadline: number;
  state: string;
  reason: string | null;
}
type Target = Pick<
  JobRequest,
  "machineId" | "pluginId" | "operationId" | "installationRevision" | "artifactSha256"
>;
export interface InvocationResource {
  locationId: string;
  revision: string;
  access: "read" | "write" | "create";
}
export interface JobInvocationEdge {
  caller: Target;
  callee: Target;
  resources: InvocationResource[];
  outputs: JobOutputRule[];
  maxDepth: number;
  maxConcurrency: number;
  aggregate: JobRequest["limits"];
}
export interface JobInvocationSpec {
  /** Loaded by the hub from its durable job row, never supplied by the child. */
  parent: { request: JobRequest; state: string; ownerId: string; ownerGeneration: number };
  /** Authenticated and proof-verified owner connection delivering the invocation event. */
  host: { machineId: string; ownerId: string; ownerGeneration: number };
  child: JobRequest;
  /** Exact explicit edge from current policy, not an edge claimed by the invoking workload. */
  edge: JobInvocationEdge;
  resources: InvocationResource[];
  now: number;
}
interface InvocationRow {
  root_job_id: string;
  depth: number;
  request: string;
  edge: string;
  active: number;
}
const limitKeys = ["timeoutMs", "memoryBytes", "processes", "outputBytes"] as const;
function target(request: JobRequest): Target {
  const { machineId, pluginId, operationId, installationRevision, artifactSha256 } = request;
  return { machineId, pluginId, operationId, installationRevision, artifactSha256 };
}
function equal(a: unknown, b: unknown): boolean {
  return canonicalJobJson(a) === canonicalJobJson(b);
}
function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJobJson(value)).digest("hex");
}
function validateRequest(request: JobRequest): void {
  JobRequestSchema.parse(request);
  const { requestDigest, ...body } = request;
  if (hash(body) !== requestDigest) throw new Error("job-request-digest-mismatch");
}
function integer(value: number, positive = false): void {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0))
    throw new Error("invalid-schedule-bound");
}

/** All durable reservations and admission callbacks share the ServerStore transaction. */
export class JobSchedules {
  constructor(private readonly store: ServerStore) {}

  private changeNotifier: ((request: JobRequest) => void) | null = null;

  setChangeNotifier(notify: (request: JobRequest) => void): void {
    this.changeNotifier = notify;
  }

  private changed(jobId: string): void {
    if (!this.changeNotifier) return;
    this.store.afterCommit(() => {
      const occurrence = this.getOccurrence(jobId);
      if (occurrence) this.changeNotifier?.(JobRequestSchema.parse(JSON.parse(occurrence.request)));
    });
  }

  putSchedule(spec: JobScheduleSpec): void {
    validateRequest(spec.request);
    if (
      !spec.scheduleId ||
      spec.scheduleId.length > 256 ||
      !spec.revision ||
      spec.revision.length > 256 ||
      spec.request.parent !== null
    )
      throw new Error("invalid-schedule-identity");
    integer(spec.firstNominalAt);
    integer(spec.intervalMs, true);
    integer(spec.deadlineMs, true);
    integer(spec.expiresAt, true);
    if (
      !["skip", "coalesce-one"].includes(spec.offlinePolicy) ||
      spec.firstNominalAt >= spec.expiresAt ||
      spec.deadlineMs > spec.expiresAt ||
      spec.expiresAt > (spec.request.credential.expiresAt ?? Number.MAX_SAFE_INTEGER)
    )
      throw new Error("schedule-expiry-ceiling");
    this.store.transaction(() => {
      const previous = this.store.db
        .query<{ spec: string }, [string, string]>(
          "SELECT spec FROM job_schedules WHERE schedule_id=? AND revision=?",
        )
        .get(spec.scheduleId, spec.revision);
      const encoded = canonicalJobJson(spec);
      if (previous) {
        if (previous.spec !== encoded) throw new Error("schedule-revision-conflict");
        return;
      }
      this.store.db
        .query(
          "UPDATE job_schedules SET disabled_reason='schedule-replaced' WHERE schedule_id=? AND disabled_reason IS NULL",
        )
        .run(spec.scheduleId);
      this.store.db
        .query(
          "UPDATE job_schedule_occurrences SET state='refused',reason='schedule-replaced' WHERE schedule_id=? AND state='pending'",
        )
        .run(spec.scheduleId);
      this.store.db
        .query("INSERT INTO job_schedules(schedule_id,revision,spec,next_nominal) VALUES(?,?,?,?)")
        .run(spec.scheduleId, spec.revision, encoded, spec.firstNominalAt);
    });
  }

  listSchedules(): JobScheduleSpec[] {
    return this.store.db
      .query<{ spec: string }, []>(
        "SELECT spec FROM job_schedules WHERE disabled_reason IS NULL ORDER BY schedule_id,revision",
      )
      .all()
      .map((row) => JSON.parse(row.spec) as JobScheduleSpec);
  }

  disableSchedule(scheduleId: string, revision: string, reason: string): void {
    this.store.transaction(() => {
      this.store.db
        .query("UPDATE job_schedules SET disabled_reason=? WHERE schedule_id=? AND revision=?")
        .run(reason, scheduleId, revision);
      const changed = this.store.db
        .query<{ job_id: string }, [string, string, string]>(
          "UPDATE job_schedule_occurrences SET state='refused',reason=? WHERE schedule_id=? AND revision=? AND state='pending' RETURNING job_id",
        )
        .all(reason, scheduleId, revision);
      for (const row of changed) this.changed(row.job_id);
    });
  }

  getOccurrence(jobId: string): JobOccurrence | null {
    return this.store.db
      .query<JobOccurrence, [string]>("SELECT * FROM job_schedule_occurrences WHERE job_id=?")
      .get(jobId);
  }

  /** Call at actual start as well as on enqueue; null means no schedule restriction. */
  startRefusal(jobId: string, now: number): string | null {
    const occurrence = this.getOccurrence(jobId);
    if (!occurrence) return null;
    const schedule = this.store.db
      .query<ScheduleRow, [string, string]>(
        "SELECT * FROM job_schedules WHERE schedule_id=? AND revision=?",
      )
      .get(occurrence.schedule_id, occurrence.revision);
    if (!schedule) return "schedule-missing";
    if (schedule.disabled_reason) return schedule.disabled_reason;
    if (now >= occurrence.deadline) return "schedule-deadline-expired";
    return occurrence.state === "refused" || occurrence.state === "skipped"
      ? (occurrence.reason ?? "schedule-refused")
      : null;
  }

  tick(now: number, callbacks: JobScheduleCallbacks): void {
    integer(now);
    this.store.transaction(() => {
      for (const row of this.store.db
        .query<ScheduleRow, []>("SELECT * FROM job_schedules WHERE disabled_reason IS NULL")
        .all()) {
        const spec = JSON.parse(row.spec) as JobScheduleSpec;
        if (now >= spec.expiresAt) {
          this.disableSchedule(spec.scheduleId, spec.revision, "schedule-expired");
          continue;
        }
        const denial = callbacks.reauthorize(spec.request);
        if (denial) {
          this.disableSchedule(spec.scheduleId, spec.revision, denial);
          continue;
        }
        const online = callbacks.isOnline(spec.request.machineId);
        if (row.next_nominal <= now) {
          const nominal =
            row.next_nominal +
            Math.floor((now - row.next_nominal) / spec.intervalMs) * spec.intervalMs;
          const next = nominal + spec.intervalMs;
          if (!Number.isSafeInteger(next)) {
            this.disableSchedule(spec.scheduleId, spec.revision, "schedule-time-overflow");
            continue;
          }
          this.store.db
            .query("UPDATE job_schedules SET next_nominal=? WHERE schedule_id=? AND revision=?")
            .run(next, spec.scheduleId, spec.revision);
          const coalesced = this.store.db
            .query<{ job_id: string }, [string, string]>(
              "UPDATE job_schedule_occurrences SET state='skipped',reason='schedule-coalesced' WHERE schedule_id=? AND revision=? AND state='pending' RETURNING job_id",
            )
            .all(spec.scheduleId, spec.revision);
          for (const row of coalesced) this.changed(row.job_id);
          const jobId = `schedule-${hash([spec.scheduleId, spec.revision, nominal])}`;
          const body: Omit<JobRequest, "requestDigest"> & { requestDigest?: string } = {
            ...spec.request,
            jobId,
          };
          delete body.requestDigest;
          const request = { ...body, requestDigest: hash(body) };
          const deadline = nominal + Math.min(spec.deadlineMs, spec.expiresAt - nominal);
          const skipped = (!online && spec.offlinePolicy === "skip") || now >= deadline;
          this.store.db
            .query(
              "INSERT INTO job_schedule_occurrences(schedule_id,revision,nominal,job_id,request,deadline,state,reason) VALUES(?,?,?,?,?,?,?,?)",
            )
            .run(
              spec.scheduleId,
              spec.revision,
              nominal,
              jobId,
              canonicalJobJson(request),
              deadline,
              skipped ? "skipped" : "pending",
              skipped ? "schedule-offline-or-expired" : null,
            );
          this.changed(jobId);
        }
        for (const pending of this.store.db
          .query<JobOccurrence, [string, string]>(
            "SELECT * FROM job_schedule_occurrences WHERE schedule_id=? AND revision=? AND state='pending'",
          )
          .all(spec.scheduleId, spec.revision)) {
          if (now >= pending.deadline) {
            this.store.db
              .query(
                "UPDATE job_schedule_occurrences SET state='refused',reason='schedule-deadline-expired' WHERE job_id=?",
              )
              .run(pending.job_id);
            this.changed(pending.job_id);
          } else if (online) {
            const request = JSON.parse(pending.request) as JobRequest;
            const reason = callbacks.reauthorize(request);
            if (reason) {
              this.disableSchedule(spec.scheduleId, spec.revision, reason);
              break;
            }
            callbacks.enqueue(request);
            this.store.db
              .query("UPDATE job_schedule_occurrences SET state='enqueued' WHERE job_id=?")
              .run(pending.job_id);
            this.changed(pending.job_id);
          }
        }
      }
    });
  }

  reserveInvocation(
    spec: JobInvocationSpec,
    callbacks: Pick<JobScheduleCallbacks, "reauthorize" | "enqueue">,
  ): "reserved" | "duplicate" {
    const { parent, child, host, edge } = spec;
    validateRequest(child);
    validateRequest(parent.request);
    integer(spec.now);
    if (
      parent.state !== "started" ||
      host.machineId !== parent.request.machineId ||
      host.ownerId !== parent.ownerId ||
      host.ownerGeneration !== parent.ownerGeneration ||
      child.machineId !== host.machineId ||
      child.parent?.parentJobId !== parent.request.jobId ||
      child.jobId === parent.request.jobId
    )
      throw new Error("invocation-parent-not-host-bound");
    if (
      !equal(child.credential, parent.request.credential) ||
      spec.now >= (child.credential.expiresAt ?? Number.MAX_SAFE_INTEGER)
    )
      throw new Error("invocation-credential-ceiling");
    if (
      !equal(target(parent.request), edge.caller) ||
      !equal(target(child), edge.callee) ||
      !equal(spec.resources, edge.resources)
    )
      throw new Error("invocation-edge-mismatch");
    const outputRules = edge.outputs.map((rule) => JobOutputRuleSchema.parse(rule));
    if (
      new Set(outputRules.map((rule) => rule.name)).size !== outputRules.length ||
      new Set(child.outputs.map((output) => output.name)).size !== child.outputs.length ||
      child.outputs.length !== outputRules.length
    )
      throw new Error("invocation-output-mismatch");
    for (const output of child.outputs) {
      const rule = outputRules.find((rule) => rule.name === output.name);
      if (
        !rule ||
        output.locationId !== rule.locationId ||
        output.components.length <
          rule.components.length + (rule.maxSuffixComponents > 0 ? 1 : 0) ||
        output.components.length > rule.components.length + rule.maxSuffixComponents ||
        rule.components.some((component, index) => output.components[index] !== component)
      )
        throw new Error("invocation-output-mismatch");
    }
    integer(edge.maxDepth, true);
    integer(edge.maxConcurrency, true);
    for (const key of limitKeys) integer(edge.aggregate[key], true);
    return this.store.transaction(() => {
      const existing = this.store.db
        .query<InvocationRow, [string, string]>(
          "SELECT * FROM job_invocation_reservations WHERE parent_job_id=? AND invocation_id=?",
        )
        .get(parent.request.jobId, child.parent!.invocationId);
      if (existing) {
        if (
          existing.request !== canonicalJobJson(child) ||
          existing.edge !== canonicalJobJson(edge)
        )
          throw new Error("invocation-identity-conflict");
        return "duplicate";
      }
      const ancestor = this.store.db
        .query<InvocationRow, [string]>("SELECT * FROM job_invocation_reservations WHERE job_id=?")
        .get(parent.request.jobId);
      if (parent.request.parent && (!ancestor || !ancestor.active))
        throw new Error("invocation-parent-reservation-missing");
      const root = ancestor?.root_job_id ?? parent.request.jobId;
      const depth = (ancestor?.depth ?? 0) + 1;
      const reservations = this.store.db
        .query<InvocationRow, [string]>(
          "SELECT * FROM job_invocation_reservations WHERE root_job_id=?",
        )
        .all(root);
      // Every ancestor ceiling remains in force, including after that ancestor completes.
      const ceilings = [
        edge,
        ...reservations.map((row) => JSON.parse(row.edge) as JobInvocationEdge),
      ];
      for (const ceiling of ceilings) {
        if (
          depth > ceiling.maxDepth ||
          reservations.filter((row) => row.active).length >= ceiling.maxConcurrency
        )
          throw new Error("invocation-depth-or-concurrency-limit");
        for (const key of limitKeys) {
          let total = child.limits[key];
          for (const row of reservations) {
            total += (JSON.parse(row.request) as JobRequest).limits[key];
            if (!Number.isSafeInteger(total)) throw new Error("invocation-aggregate-limit");
          }
          if (total > ceiling.aggregate[key]) throw new Error("invocation-aggregate-limit");
        }
      }
      const denial = callbacks.reauthorize(parent.request) ?? callbacks.reauthorize(child);
      if (denial) throw new Error(denial);
      this.store.db
        .query(
          "INSERT INTO job_invocation_reservations(parent_job_id,invocation_id,job_id,root_job_id,depth,request,edge,active) VALUES(?,?,?,?,?,?,?,1)",
        )
        .run(
          parent.request.jobId,
          child.parent!.invocationId,
          child.jobId,
          root,
          depth,
          canonicalJobJson(child),
          canonicalJobJson(edge),
        );
      callbacks.enqueue(child);
      return "reserved";
    });
  }

  finishInvocation(jobId: string): void {
    this.store.db
      .query("UPDATE job_invocation_reservations SET active=0 WHERE job_id=?")
      .run(jobId);
  }
}
