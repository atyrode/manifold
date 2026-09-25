import {
  formatManifoldUri,
  JobResourceBindingsSchema,
  type JobResourceBindings,
} from "@manifold/protocol";
import type { AuthorityEvidence } from "./auth.ts";
import {
  canonicalJobJson,
  JobLifecycleEventSchema,
  JobInferenceUsageTotalSchema,
  JobRequestSchema,
  JobResultSchema,
  MachineHalfSchema,
  MAX_JOB_JOURNAL_EVENTS,
  type JobRequest,
  type JobResult,
  type JobJournalPage,
  type JobInferenceCallEvent,
  type JobInferenceUsageTotal,
  type JobLifecycleEvent,
  type JobPermit,
  type MachineHalf,
  type JobOwner,
  type JobAuthority,
} from "../../protocol/src/jobs.ts";
import type { ServerStore, TraceAttribution } from "./stores.ts";
import type { JobOccurrence } from "./job-schedules.ts";
export type JobAuditOrigin = Pick<
  TraceAttribution,
  "actor" | "authority" | "door" | "containerId" | "session"
>;
export interface JobCancellation {
  reason: string;
  mode: "cancel" | "retire";
}
export interface JobRecord {
  request: JobRequest;
  state: JobResult["state"];
  permit: JobPermit | null;
  result: JobResult | null;
  auditOrigin: JobAuditOrigin | null;
  decisionId: string | null;
  nextInputSeq: number | null;
  stdinClosed: boolean;
  ownerClosed: boolean;
}
export interface JobInstallation {
  machineId: string;
  pluginId: string;
  revision: string;
  artifact: string;
  machine: MachineHalf;
  resourceBindings?: JobResourceBindings;
  enabled: boolean;
  ready: boolean;
  purgeRequested: boolean;
}
export interface JobRunPosition {
  at: number;
  source: 0 | 1;
  jobId: string;
}
export interface JobRunCandidate {
  position: JobRunPosition;
  request: JobRequest;
  job: JobRecord | null;
  occurrence: JobOccurrence | null;
}
/**
 * The states in which a job still holds or may take a slot. A partial index serves a query only
 * when the query repeats the index's predicate, so every live read spells it from here.
 */
const LIVE_STATES = "('queued','admitted','start-committed','started')";
export class JobStore {
  constructor(
    readonly store: ServerStore,
    private readonly lifecycle: (job: JobRecord, phase: string) => void,
  ) {
    // Settled jobs stay in `machine_jobs`, so the reads the hub repeats on every tick, owner
    // event and authority change must reach the few live rows through an index rather than
    // scan the whole history (#841). A derived index changes no stored fact, so it is created
    // at open like the journal's recency indexes: a build without it opens the same database.
    store.db.exec(
      `CREATE INDEX IF NOT EXISTS machine_jobs_live ON machine_jobs(state) WHERE state IN ${LIVE_STATES}`,
    );
  }
  get(jobId: string): JobRecord | null {
    const r = this.store.db
      .query<
        {
          request: string;
          state: JobResult["state"];
          permit: string | null;
          result: string | null;
          audit_origin: string | null;
          decision_id: string | null;
          next_input_seq: number | null;
          stdin_closed: number;
          owner_closed: number;
        },
        [string]
      >(
        "SELECT request,state,permit,result,audit_origin,decision_id,next_input_seq,stdin_closed,owner_closed FROM machine_jobs WHERE job_id=?",
      )
      .get(jobId);
    return r
      ? {
          request: JobRequestSchema.parse(JSON.parse(r.request)),
          state: r.state,
          permit: r.permit === null ? null : JSON.parse(r.permit),
          result: r.result === null ? null : JobResultSchema.parse(JSON.parse(r.result)),
          auditOrigin: r.audit_origin === null ? null : JSON.parse(r.audit_origin),
          decisionId: r.decision_id,
          nextInputSeq: r.next_input_seq,
          stdinClosed: r.stdin_closed === 1,
          ownerClosed: r.owner_closed === 1,
        }
      : null;
  }
  inputCursor(jobId: string, seq: number, closed: boolean): void {
    this.store.db
      .query(
        `UPDATE machine_jobs SET next_input_seq=?,stdin_closed=MAX(stdin_closed,?)
       WHERE job_id=? AND (next_input_seq IS NULL OR next_input_seq<=?)`,
      )
      .run(seq, closed ? 1 : 0, jobId, seq);
  }
  reserveInput(
    job: JobRecord,
    requestId: string,
    seq: number,
    actor: string,
    traceId: string,
  ): boolean {
    return (
      this.store.db
        .query(
          `INSERT INTO machine_job_inputs(job_id,request_id,seq,actor,trace_id,decision_id,state)
       VALUES(?,?,?,?,?,?,'pending') ON CONFLICT(job_id,request_id) DO NOTHING`,
        )
        .run(job.request.jobId, requestId, seq, actor, traceId, job.decisionId).changes === 1
    );
  }
  inputResult(
    jobId: string,
    requestId: string,
    state: "accepted" | "rejected" | "unknown",
    reason: string | null,
  ): void {
    this.store.db
      .query(
        "UPDATE machine_job_inputs SET state=?,reason=? WHERE job_id=? AND request_id=? AND state!='accepted'",
      )
      .run(state, reason, jobId, requestId);
  }
  /** Read-only reservation admission, shared by execute and every durable reservation. */
  reservation(request: JobRequest): JobRecord | null {
    const previous = this.get(request.jobId);
    if (previous !== null && previous.request.requestDigest !== request.requestDigest)
      throw new Error("job_digest_conflict");
    return previous;
  }
  reserve(request: JobRequest, now: number): JobRecord {
    const previous = this.reservation(request);
    if (previous !== null) return previous;
    this.store.db
      .query(
        "INSERT INTO machine_jobs(job_id,machine_id,plugin_id,digest,request,state,created_at,audit_origin) VALUES (?,?,?,?,?,'queued',?,?)",
      )
      .run(
        request.jobId,
        request.machineId,
        request.pluginId,
        request.requestDigest,
        canonicalJobJson(request),
        now,
        JSON.stringify(this.origin(request)),
      );
    return this.get(request.jobId)!;
  }
  active(machineId?: string): JobRecord[] {
    const rows =
      machineId === undefined
        ? this.store.db
            .query<{ job_id: string }, []>(
              `SELECT job_id FROM machine_jobs WHERE state IN ${LIVE_STATES} ORDER BY rowid ASC`,
            )
            .all()
        : this.store.db
            .query<{ job_id: string }, [string]>(
              `SELECT job_id FROM machine_jobs WHERE machine_id=? AND state IN ${LIVE_STATES} ORDER BY rowid ASC`,
            )
            .all(machineId);
    return rows.map((r) => this.get(r.job_id)!);
  }
  /**
   * How many of one operation's jobs occupy this candidate's concurrency slots. Every non-queued
   * unsettled job occupies a slot; queued jobs do so only for later reservations in durable rowid
   * FIFO order. Count from the hub's own rows so admission never trusts the fan it is bounding.
   */
  activeOperationJobs(
    machineId: string,
    pluginId: string,
    operationId: string,
    exceptJobId: string,
    replacingTerminalId: string | null = null,
  ): number {
    return (
      this.store.db
        .query<
          { count: number },
          [string, string, string, string, string, string, string | null, string | null]
        >(
          `SELECT COUNT(*) AS count FROM machine_jobs
       WHERE machine_id=? AND plugin_id=? AND json_extract(request,'$.operationId')=?
         AND job_id!=? AND state IN ${LIVE_STATES}
         AND (state!='queued' OR (SELECT rowid FROM machine_jobs WHERE job_id=?) IS NULL
           OR rowid < (SELECT rowid FROM machine_jobs WHERE job_id=?))
         AND (? IS NULL OR json_extract(request,'$.terminal.terminalId') IS NOT ?)`,
        )
        .get(
          machineId,
          pluginId,
          operationId,
          exceptJobId,
          exceptJobId,
          exceptJobId,
          replacingTerminalId,
          replacingTerminalId,
        )?.count ?? 0
    );
  }
  /** A sent permit without a confirmed outcome still owns its service lifetime. */
  instanceServiceJobs(serviceId: string): JobRecord[] {
    const rows = this.store.db
      .query<{ job_id: string }, [string]>(
        `SELECT job_id FROM machine_jobs WHERE json_extract(request,'$.service.serviceId')=?
       AND (state IN ${LIVE_STATES} OR
         (permit IS NOT NULL AND owner_closed=0))
       LIMIT 65`,
      )
      .all(serviceId);
    if (rows.length > 64) throw new Error("instance_service_jobs_capacity");
    return rows.map((row) => this.get(row.job_id)!);
  }
  /**
   * Live jobs and settled service jobs whose owner has not yet confirmed their workload empty,
   * in rowid order. Each half reads its own index: the second repeats the predicate of
   * `machine_jobs_instance_service` so SQLite can prove that partial index applies. The cost
   * therefore follows the rows returned, never the retained history (#841).
   */
  reconcilable(machineId?: string): JobRecord[] {
    const rows = this.store.db
      .query<{ job_id: string }, [string | null]>(
        `SELECT job_id FROM (
           SELECT rowid AS position, job_id FROM machine_jobs
            WHERE state IN ${LIVE_STATES} AND (?1 IS NULL OR machine_id=?1)
           UNION ALL
           SELECT rowid, job_id FROM machine_jobs
            WHERE json_extract(request,'$.service.serviceId') IS NOT NULL AND
             (state IN ${LIVE_STATES} OR (permit IS NOT NULL AND owner_closed=0)) AND
             state NOT IN ${LIVE_STATES} AND (?1 IS NULL OR machine_id=?1))
         ORDER BY position`,
      )
      .all(machineId ?? null);
    return rows.map((row) => this.get(row.job_id)!);
  }
  confirmEmpty(jobId: string): boolean {
    return this.store.transaction(() => {
      const changed =
        this.store.db
          .query(
            "UPDATE machine_jobs SET owner_closed=1 WHERE job_id=? AND owner_closed=0 AND permit IS NOT NULL",
          )
          .run(jobId).changes > 0;
      if (changed) this.lifecycle(this.get(jobId)!, "workload_empty");
      return changed;
    });
  }
  /** Durable discovery is bounded before any records or authority evidence are materialized. */
  runCandidates(
    args: {
      pluginId: string;
      machineId: string;
      operationId?: string;
      before?: JobRunPosition;
    },
    limit: number,
  ): JobRunCandidate[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 257)
      throw new Error("invalid-job-run-limit");
    const rows = this.store.db
      .query<
        {
          at: number;
          source: 0 | 1;
          job_id: string;
          request: string;
          persisted_job_id: string | null;
          schedule_id: string | null;
          revision: string | null;
          deadline: number | null;
          state: string | null;
          reason: string | null;
        },
        [
          string,
          string,
          string | null,
          string | null,
          string,
          string,
          string | null,
          string | null,
          number | null,
          number | null,
          number | null,
          string | null,
          number,
        ]
      >(
        `WITH candidates AS (
          SELECT j.created_at AS at, 0 AS source, j.job_id, j.request,
            j.job_id AS persisted_job_id, NULL AS schedule_id, NULL AS revision,
            NULL AS deadline, NULL AS state, NULL AS reason
          FROM machine_jobs j
          WHERE j.plugin_id = ? AND j.machine_id = ?
            AND (? IS NULL OR json_extract(j.request, '$.operationId') = ?)
            AND NOT EXISTS (
              SELECT 1 FROM job_schedule_occurrences o WHERE o.job_id = j.job_id
            )
          UNION ALL
          SELECT o.nominal AS at, 1 AS source, o.job_id, o.request,
            j.job_id AS persisted_job_id, o.schedule_id, o.revision,
            o.deadline, o.state, o.reason
          FROM job_schedule_occurrences o
          LEFT JOIN machine_jobs j ON j.job_id = o.job_id
          WHERE json_extract(o.request, '$.pluginId') = ?
            AND json_extract(o.request, '$.machineId') = ?
            AND (? IS NULL OR json_extract(o.request, '$.operationId') = ?)
        )
        SELECT * FROM candidates
        WHERE ? IS NULL OR (at, source, job_id) < (?, ?, ?)
        ORDER BY at DESC, source DESC, job_id DESC
        LIMIT ?`,
      )
      .all(
        args.pluginId,
        args.machineId,
        args.operationId ?? null,
        args.operationId ?? null,
        args.pluginId,
        args.machineId,
        args.operationId ?? null,
        args.operationId ?? null,
        args.before?.at ?? null,
        args.before?.at ?? null,
        args.before?.source ?? null,
        args.before?.jobId ?? null,
        limit,
      );
    return rows.map((row) => ({
      position: { at: row.at, source: row.source, jobId: row.job_id },
      request: JobRequestSchema.parse(JSON.parse(row.request)),
      job: row.persisted_job_id === null ? null : this.get(row.persisted_job_id),
      occurrence:
        row.source === 0
          ? null
          : {
              schedule_id: row.schedule_id!,
              revision: row.revision!,
              nominal: row.at,
              job_id: row.job_id,
              request: row.request,
              deadline: row.deadline!,
              state: row.state!,
              reason: row.reason,
            },
    }));
  }
  dispatchOrigin(traceId: string): JobAuditOrigin | null {
    return this.store.db
      .query<JobAuditOrigin, [string]>(
        "SELECT principal_id AS actor,authority,door,container_id AS containerId,session FROM events WHERE id=? AND type='trace'",
      )
      .get(traceId);
  }
  origin(request: JobRequest): JobAuditOrigin | null {
    if (request.parent) return this.get(request.parent.parentJobId)?.auditOrigin ?? null;
    if (request.service) {
      const service = this.store.db
        .query<{ configured_by: string }, [string, string]>(
          "SELECT configured_by FROM native_instance_services WHERE service_id=? AND revision=?",
        )
        .get(request.service.serviceId, request.service.revision);
      return service
        ? {
            actor: service.configured_by,
            authority: "services:configure",
            door: "engine.services.configureInstance",
            containerId: null,
            session: null,
          }
        : null;
    }
    const schedule = this.store.db
      .query<{ audit_origin: string | null }, [string]>(
        "SELECT s.audit_origin FROM job_schedules s JOIN job_schedule_occurrences o ON o.schedule_id=s.schedule_id AND o.revision=s.revision WHERE o.job_id=?",
      )
      .get(request.jobId);
    return schedule
      ? schedule.audit_origin === null
        ? null
        : JSON.parse(schedule.audit_origin)
      : this.dispatchOrigin(request.traceId);
  }
  decision(jobId: string, decisionId: string): void {
    this.store.db
      .query("UPDATE machine_jobs SET decision_id=? WHERE job_id=?")
      .run(decisionId, jobId);
  }
  authority(job: JobRecord): JobAuthority {
    const request = job.request;
    const occurrence = this.store.db
      .query<{ schedule_id: string; revision: string; nominal: number }, [string]>(
        "SELECT schedule_id,revision,nominal FROM job_schedule_occurrences WHERE job_id=?",
      )
      .get(request.jobId);
    const row =
      job.decisionId === null
        ? null
        : this.store.db
            .query<
              {
                policy_revision: string;
                evidence: string;
                consents: string;
              },
              [string]
            >("SELECT policy_revision,evidence,consents FROM machine_job_decisions WHERE id=?")
            .get(job.decisionId);
    const evidence = row
      ? (JSON.parse(row.evidence) as {
          allowed: boolean;
          refusal: string | null;
          requirements: (AuthorityEvidence & { revision: number })[];
        })
      : null;
    return {
      origin: request.parent
        ? {
            kind: "invocation",
            traceId: request.traceId,
            door: job.auditOrigin?.door ?? null,
            ...request.parent,
          }
        : occurrence
          ? {
              kind: "schedule",
              door: job.auditOrigin?.door ?? null,
              traceId: request.traceId,
              scheduleId: occurrence.schedule_id,
              revision: occurrence.revision,
              nominalAt: occurrence.nominal,
            }
          : request.service
            ? {
                kind: "service",
                traceId: request.traceId,
                door: job.auditOrigin?.door ?? null,
                serviceId: request.service.serviceId,
                revision: request.service.revision,
              }
            : { kind: "action", traceId: request.traceId, door: job.auditOrigin?.door ?? null },
      requester: request.credential.principalId,
      executor: job.permit
        ? {
            machineId: request.machineId,
            ownerId: job.permit.ownerId,
            ownerGeneration: job.permit.ownerGeneration,
          }
        : null,
      decision:
        row && job.decisionId && evidence
          ? {
              decisionId: job.decisionId,
              policyRevision: row.policy_revision,
              allowed: evidence.allowed,
              refusal: evidence.refusal,
              grants: evidence.requirements.map(({ requirement, winner, revision, allowed }) => ({
                node: formatManifoldUri(requirement.ref),
                cap: requirement.cap,
                allowed,
                grantId: winner?.id ?? null,
                authorizer: winner?.createdBy ?? null,
                revision,
              })),
              consents: JSON.parse(row.consents),
            }
          : null,
    };
  }
  state(jobId: string, state: JobRecord["state"], permit?: JobPermit): void {
    this.store.transaction(() => {
      const previous = this.get(jobId);
      if (!previous || previous.state === state) return;
      if (permit)
        this.store.db
          .query("UPDATE machine_jobs SET state=?,permit=? WHERE job_id=?")
          .run(state, canonicalJobJson(permit), jobId);
      else this.store.db.query("UPDATE machine_jobs SET state=? WHERE job_id=?").run(state, jobId);
      this.lifecycle(this.get(jobId)!, state);
    });
  }
  cancellation(jobId: string): JobCancellation | null {
    const row = this.store.db
      .query<{ cancel_reason: string | null; cancel_mode: JobCancellation["mode"] }, [string]>(
        "SELECT cancel_reason,cancel_mode FROM machine_jobs WHERE job_id=?",
      )
      .get(jobId);
    return row?.cancel_reason == null ? null : { reason: row.cancel_reason, mode: row.cancel_mode };
  }
  cancel(jobId: string, reason: string, mode: JobCancellation["mode"] = "cancel"): void {
    this.store.db
      .query(
        `UPDATE machine_jobs SET cancel_reason=?,cancel_mode=? WHERE job_id=?
         AND (cancel_reason IS NULL OR cancel_mode='retire' OR ?='cancel')`,
      )
      .run(reason, mode, jobId, mode);
  }
  result(result: JobResult): void {
    this.store.transaction(() => {
      this.store.db
        .query("UPDATE machine_jobs SET state=?,result=? WHERE job_id=?")
        .run(result.state, canonicalJobJson(result), result.jobId);
      const job = this.get(result.jobId)!;
      if (
        result.state === "cancelled" ||
        result.state === "interrupted" ||
        result.state === "refused"
      )
        this.lifecycle(job, result.state);
      this.lifecycle(job, "result");
    });
  }
  /**
   * The durable half of the follow sequence, and only its LIFECYCLE frames: a byte channel is
   * live-only, because a durable public record carries lifecycle and digest facts rather than a
   * transcript (ADR 0033 §Lifecycle and durability). The newest `MAX_JOB_JOURNAL_EVENTS` per job
   * survive, so a job that transitions forever trims its own prefix instead of growing without
   * end — and `journal` reports the surviving floor as `firstSeq` rather than implying it began
   * there.
   */
  appendJournal(jobId: string, seq: number, at: number, event: JobLifecycleEvent): void {
    this.store.transaction(() => this.appendJournalRecord(jobId, seq, at, event));
  }
  /**
   * Persist one accepted metered call and fold it into the whole-job total in the same
   * transaction. A nullable row is a migration sentinel: its retained suffix is deliberately
   * never promoted to an exact total.
   */
  appendInferenceCall(
    jobId: string,
    seq: number,
    at: number,
    event: JobInferenceCallEvent,
  ): JobInferenceUsageTotal | null {
    return this.store.transaction(() => {
      const inserted = this.appendJournalRecord(jobId, seq, at, event);
      const row = this.store.db
        .query<{ usage: string | null }, [string]>(
          "SELECT usage FROM machine_job_inference_usage WHERE job_id=?",
        )
        .get(jobId);
      if (!inserted)
        return row?.usage == null
          ? null
          : JobInferenceUsageTotalSchema.parse(JSON.parse(row.usage));
      if (row?.usage === null) return null;
      const previous =
        row == null
          ? {
              calls: 0,
              inputTokens: 0,
              outputTokens: 0,
              cachedInputTokens: 0,
              costMicros: 0,
              lastModel: event.model,
            }
          : JobInferenceUsageTotalSchema.parse(JSON.parse(row.usage));
      const add = (spent: number, more: number) => Math.min(spent + more, Number.MAX_SAFE_INTEGER);
      const total: JobInferenceUsageTotal = {
        calls: add(previous.calls, 1),
        inputTokens: add(previous.inputTokens, event.inputTokens),
        outputTokens: add(previous.outputTokens, event.outputTokens),
        cachedInputTokens: add(previous.cachedInputTokens, event.cachedInputTokens),
        costMicros: add(previous.costMicros, event.costMicros),
        lastModel: event.model,
      };
      this.store.db
        .query(
          `INSERT INTO machine_job_inference_usage(job_id,usage) VALUES(?,?)
           ON CONFLICT(job_id) DO UPDATE SET usage=excluded.usage`,
        )
        .run(jobId, canonicalJobJson(total));
      return total;
    });
  }
  private appendJournalRecord(
    jobId: string,
    seq: number,
    at: number,
    event: JobLifecycleEvent,
  ): boolean {
    const inserted =
      this.store.db
        .query(
          "INSERT INTO machine_job_journal(job_id,seq,at,event) VALUES(?,?,?,?) ON CONFLICT(job_id,seq) DO NOTHING",
        )
        .run(jobId, seq, at, canonicalJobJson(event)).changes === 1;
    this.store.db
      .query(
        `DELETE FROM machine_job_journal WHERE job_id=? AND seq<=COALESCE(
         (SELECT seq FROM machine_job_journal WHERE job_id=? ORDER BY seq DESC LIMIT 1 OFFSET ?),-1)`,
      )
      .run(jobId, jobId, MAX_JOB_JOURNAL_EVENTS);
    return inserted;
  }
  inferenceUsage(jobId: string): JobInferenceUsageTotal | null {
    const row = this.store.db
      .query<{ usage: string | null }, [string]>(
        "SELECT usage FROM machine_job_inference_usage WHERE job_id=?",
      )
      .get(jobId);
    return row?.usage == null ? null : JobInferenceUsageTotalSchema.parse(JSON.parse(row.usage));
  }
  journal(jobId: string, after: number, limit: number): JobJournalPage {
    const rows = this.store.db
      .query<{ seq: number; at: number; event: string }, [string, number, number]>(
        "SELECT seq,at,event FROM machine_job_journal WHERE job_id=? AND seq>? ORDER BY seq LIMIT ?",
      )
      .all(jobId, after, limit);
    const retained = this.store.db
      .query<{ seq: number | null }, [string]>(
        "SELECT MIN(seq) AS seq FROM machine_job_journal WHERE job_id=?",
      )
      .get(jobId);
    const events = rows.map((row) => ({
      seq: row.seq,
      at: row.at,
      event: JobLifecycleEventSchema.parse(JSON.parse(row.event)),
    }));
    return {
      jobId,
      inferenceUsage: this.inferenceUsage(jobId),
      events,
      firstSeq: retained?.seq ?? null,
      nextAfter: events.length === limit ? (events.at(-1)?.seq ?? null) : null,
    };
  }
  /** Purge destroys a plugin's retained job metadata with the rest of its bounded state. */
  purgeJournal(pluginId: string): void {
    this.store.transaction(() => {
      this.store.db
        .query(
          "DELETE FROM machine_job_journal WHERE job_id IN (SELECT job_id FROM machine_jobs WHERE plugin_id=?)",
        )
        .run(pluginId);
      this.store.db
        .query(
          "DELETE FROM machine_job_inference_usage WHERE job_id IN (SELECT job_id FROM machine_jobs WHERE plugin_id=?)",
        )
        .run(pluginId);
    });
  }
  installation(machineId: string, pluginId: string, revision?: string): JobInstallation | null {
    const r = this.store.db
      .query<
        {
          revision: string;
          artifact: string;
          manifest: string;
          resource_bindings: string | null;
          enabled: number;
          ready: number;
          purge_requested: number;
        },
        [string, string, string | null]
      >(
        `SELECT h.revision,h.artifact,h.manifest,h.resource_bindings,c.enabled,c.purge_requested,
          CASE WHEN h.revision=c.revision THEN c.ready ELSE 0 END AS ready
         FROM machine_job_installations h
         JOIN machine_job_installs c ON c.machine_id=h.machine_id AND c.plugin_id=h.plugin_id
         WHERE h.machine_id=? AND h.plugin_id=? AND h.revision=COALESCE(?,c.revision)`,
      )
      .get(machineId, pluginId, revision ?? null);
    return r
      ? {
          machineId,
          pluginId,
          revision: r.revision,
          artifact: r.artifact,
          machine: MachineHalfSchema.parse(JSON.parse(r.manifest)),
          ...(r.resource_bindings === null
            ? {}
            : {
                resourceBindings: JobResourceBindingsSchema.parse(JSON.parse(r.resource_bindings)),
              }),
          enabled: r.enabled === 1,
          ready: r.ready === 1,
          purgeRequested: r.purge_requested === 1,
        }
      : null;
  }
  installations(machineId?: string): JobInstallation[] {
    const rows =
      machineId === undefined
        ? this.store.db
            .query<{ machine_id: string; plugin_id: string }, []>(
              "SELECT machine_id,plugin_id FROM machine_job_installs",
            )
            .all()
        : this.store.db
            .query<{ machine_id: string; plugin_id: string }, [string]>(
              "SELECT machine_id,plugin_id FROM machine_job_installs WHERE machine_id=?",
            )
            .all(machineId);
    return rows.map((r) => this.installation(r.machine_id, r.plugin_id)!);
  }
  owner(machineId: string): Pick<JobOwner, "ownerId" | "publicKey" | "generation"> | null {
    const r = this.store.db
      .query<{ owner_id: string; public_key: string; generation: number }, [string]>(
        "SELECT owner_id,public_key,generation FROM machine_job_owners WHERE machine_id=?",
      )
      .get(machineId);
    return r ? { ownerId: r.owner_id, publicKey: r.public_key, generation: r.generation } : null;
  }
  pinOwner(machineId: string, owner: JobOwner): void {
    this.store.db
      .query(
        "INSERT INTO machine_job_owners VALUES (?,?,?,?) ON CONFLICT(machine_id) DO UPDATE SET generation=excluded.generation",
      )
      .run(machineId, owner.ownerId, owner.publicKey, owner.generation);
  }
  revision(kind: string, identity: string, digest: string): number {
    const row = this.store.db
      .query<{ revision: number; digest: string }, [string, string]>(
        "SELECT revision,digest FROM machine_job_revisions WHERE kind=? AND identity=?",
      )
      .get(kind, identity);
    if (row?.digest === digest) return row.revision;
    const revision = (row?.revision ?? 0) + 1;
    this.store.db
      .query(
        "INSERT INTO machine_job_revisions VALUES (?,?,?,?) ON CONFLICT(kind,identity) DO UPDATE SET revision=excluded.revision,digest=excluded.digest",
      )
      .run(kind, identity, revision, digest);
    return revision;
  }
}
