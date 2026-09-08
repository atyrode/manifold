import type { JobExecution, JobFollow } from "@manifold/plugin";
import { createHash, generateKeyPairSync, sign, verify, randomUUID } from "node:crypto";
import {
  formatManifoldUri,
  parseManifoldUri,
  type ManifoldRef,
  type Cap,
  type RuntimeDeps,
} from "@manifold/protocol";
import {
  canonicalJobJson,
  JobRequestSchema,
  MachineHalfSchema,
  MAX_JOB_FOLLOW_EVENTS,
  MAX_JOB_FOLLOW_BYTES,
  type JobCommand,
  type JobEvent,
  type JobOwner,
  type JobRequest,
  type MachineHalf,
  type JobFollowEvent,
  type JobFollowUpdate,
} from "../../protocol/src/jobs.ts";
import type { JobDescription } from "../../protocol/src/jobs.ts";
import { JobOutputRuleSchema } from "../../protocol/src/jobs.ts";
import {
  ServiceError,
  type AuthContext,
  type AuthService,
  type CredentialReference,
  type AuthorityRequirement,
  type GovernedAdmissionRequest,
  type GovernedAdmissionDecision,
} from "./auth.ts";
import { JobStore, type JobRecord, type JobInstallation } from "./job-store.ts";
import type { ServerStore, TraceRecord } from "./stores.ts";
import { JobSchedules, type JobScheduleSpec, type JobInvocationEdge } from "./job-schedules.ts";
export type { JobRecord } from "./job-store.ts";
interface JobFollower {
  auth: AuthContext;
  readonly callerPluginId: string;
  node: Extract<ManifoldRef, { kind: "job" }>;
  seq: number;
  receive(update: JobFollowUpdate): void;
}
interface JobReplay {
  frames: { seq: number; event: JobFollowEvent; bytes: number }[];
  bytes: number;
}
interface JobChannel {
  machineId: string;
  send(message: { type: "job_command"; command: JobCommand }): boolean;
}
const digest = (value: unknown) =>
  createHash("sha256").update(canonicalJobJson(value)).digest("hex");
function fail(code = "governed_authority_refused"): never {
  throw new ServiceError("forbidden", code);
}
const active = new Set(["queued", "admitted", "start-committed", "started"]);
export class JobService {
  readonly jobSchedules: JobSchedules;
  private lifecycleRecorder: ((record: TraceRecord) => void) | null = null;
  setLifecycleRecorder(record: (record: TraceRecord) => void): void {
    this.lifecycleRecorder = record;
  }
  private lifecycle(job: JobRecord, phase: string): void {
    if (!this.lifecycleRecorder) throw new Error("job_lifecycle_recorder_required");
    const origin = job.auditOrigin;
    const authority = this.jobs.authority(job);
    this.lifecycleRecorder({
      actor: origin?.actor ?? authority.requester,
      authority: origin?.authority ?? "machines:run",
      door: origin?.door ?? "engine.jobs.execute",
      containerId: origin?.containerId ?? job.request.credential.containerScope,
      session: origin?.session ?? null,
      ts: this.runtime.now(),
      outcome: phase === "refused" ? "forbidden" : "ok",
      targets: [],
      payload: {
        jobLifecycle: phase,
        parentTrace: job.request.traceId,
        originTraceAvailable: origin !== null,
        jobId: job.request.jobId,
        target: {
          machineId: job.request.machineId,
          pluginId: job.request.pluginId,
          operationId: job.request.operationId,
          installationRevision: job.request.installationRevision,
          artifactSha256: job.request.artifactSha256,
        },
        ...authority,
        state: job.state,
        ...(phase === "result" ? { exitCode: job.result?.exitCode ?? null } : {}),
      },
    });
  }

  describe(
    auth: AuthContext,
    args: { machineId: string; pluginId: string; installationRevision?: string | undefined },
    callerPluginId = "engine.jobs",
  ): JobDescription {
    const current = this.context(this.auth.credentialReference(auth));
    const node: ManifoldRef = { kind: "machine", machineId: args.machineId };
    if (
      !current ||
      (callerPluginId !== "engine.jobs" && callerPluginId !== args.pluginId) ||
      (!current.caps.includes("*") && !current.caps.includes("machines:run")) ||
      !this.auth.allowsRef(current, "machines:run", node)
    )
      fail();
    const install = this.jobs.installation(
      args.machineId,
      args.pluginId,
      args.installationRevision,
    );
    const live = this.channels.get(args.machineId);
    const connected = live?.proved === true;
    const enabled =
      install !== null &&
      install.enabled &&
      !install.purgeRequested &&
      !this.store.disabledPlugins().has(args.pluginId);
    const rows = this.store.db
      .query<
        {
          node: string;
          cap: Cap;
          enabled: number;
          revision: string;
          installation_revision: string;
          artifact: string;
        },
        [string, string, string | null]
      >(
        "SELECT node,cap,enabled,revision,installation_revision,artifact FROM machine_job_consents WHERE machine_id=? AND plugin_id=? AND installation_revision=? ORDER BY node,cap",
      )
      .all(args.machineId, args.pluginId, install?.revision ?? null);
    return {
      machineId: args.machineId,
      pluginId: args.pluginId,
      admissionPublicKey: this.admissionPublicKey,
      connected,
      platforms: connected ? [...live.owner.platforms] : [],
      retainedInstallations: this.store.db
        .query<{ revision: string; artifactSha256: string }, [string, string]>(
          `SELECT h.revision,h.artifact AS artifactSha256
           FROM machine_job_installations h
           JOIN machine_job_installs c ON c.machine_id=h.machine_id AND c.plugin_id=h.plugin_id
           WHERE h.machine_id=? AND h.plugin_id=? AND h.revision<>c.revision
           ORDER BY h.rowid DESC LIMIT 128`,
        )
        .all(args.machineId, args.pluginId),
      installation:
        install === null
          ? null
          : {
              revision: install.revision,
              artifactSha256: install.artifact,
              enabled,
              ready: enabled && connected && install.ready && !install.purgeRequested,
              purgeRequested: install.purgeRequested,
            },
      consents: rows.map(
        ({ node, cap, revision, enabled: consentEnabled, installation_revision, artifact }) => ({
          node,
          cap,
          revision,
          enabled:
            enabled &&
            consentEnabled === 1 &&
            install?.revision === installation_revision &&
            install.artifact === artifact,
        }),
      ),
    };
  }

  private reauthorizeDeferred(request: JobRequest): string | null {
    const context = this.context(request.credential);
    if (!context) return "credential_revoked_or_expired";
    try {
      const requirements = this.requirements(request);
      for (const { cap, ref } of requirements) {
        const install = this.resolve(ref);
        if (
          !install ||
          (!context.caps.includes("*") && !context.caps.includes(cap)) ||
          !this.auth.allowsRef(context, cap, ref) ||
          !this.consentFor(install, ref, cap)
        )
          return "governed_authority_refused";
      }
      return null;
    } catch (error) {
      if (error instanceof ServiceError) return error.message;
      throw error;
    }
  }

  schedule(
    auth: AuthContext,
    pluginId: string,
    traceId: string,
    args: JobExecution & Omit<JobScheduleSpec, "request">,
    callerPluginId = pluginId,
  ): JobScheduleSpec {
    const {
      scheduleId,
      revision,
      firstNominalAt,
      intervalMs,
      deadlineMs,
      expiresAt,
      offlinePolicy,
      ...execute
    } = args;
    const request = this.build(auth, pluginId, traceId, execute);
    if (
      (pluginId !== callerPluginId && callerPluginId !== "engine.jobs") ||
      !this.callerOwnsNode(callerPluginId, {
        kind: "operation",
        machineId: request.machineId,
        operationId: request.operationId,
      })
    )
      fail("schedule_owner_mismatch");
    const spec: JobScheduleSpec = {
      scheduleId,
      revision,
      firstNominalAt,
      intervalMs,
      deadlineMs,
      expiresAt,
      offlinePolicy,
      request,
    };
    this.store.transaction(() => {
      const prior = this.store.db
        .query<{ spec: string }, [string]>(
          "SELECT spec FROM job_schedules WHERE schedule_id=? LIMIT 1",
        )
        .get(scheduleId);
      if (
        prior &&
        callerPluginId !== "engine.jobs" &&
        (JSON.parse(prior.spec) as JobScheduleSpec).request.pluginId !== callerPluginId
      )
        fail("schedule_owner_mismatch");
      if (
        prior &&
        (JSON.parse(prior.spec) as JobScheduleSpec).request.credential.principalId !==
          auth.principal.id &&
        !auth.isRoot
      )
        fail("schedule_owner_mismatch");
      const refusal = this.reauthorizeDeferred(request);
      if (refusal) fail(refusal);
      this.jobSchedules.putSchedule(spec);
      this.store.db
        .query(
          "UPDATE job_schedules SET audit_origin=COALESCE(audit_origin,?) WHERE schedule_id=? AND revision=?",
        )
        .run(JSON.stringify(this.jobs.dispatchOrigin(request.traceId)), scheduleId, revision);
    });
    return spec;
  }

  schedules(auth: AuthContext, callerPluginId = "engine.jobs"): JobScheduleSpec[] {
    const context = this.context(this.auth.credentialReference(auth));
    if (!context) return [];
    return this.jobSchedules.listSchedules().filter(
      (spec) =>
        (callerPluginId === "engine.jobs" ||
          (spec.request.pluginId === callerPluginId &&
            this.ownsNode(callerPluginId, {
              kind: "operation",
              machineId: spec.request.machineId,
              operationId: spec.request.operationId,
            }))) &&
        (context.isRoot || spec.request.credential.principalId === context.principal.id) &&
        this.canReadGoverned(context, {
          kind: "operation",
          machineId: spec.request.machineId,
          operationId: spec.request.operationId,
        }),
    );
  }

  disableSchedule(
    auth: AuthContext,
    scheduleId: string,
    revision: string,
    callerPluginId = "engine.jobs",
  ): void {
    const context = this.context(this.auth.credentialReference(auth));
    if (!context) fail();
    const spec = this.jobSchedules
      .listSchedules()
      .find((row) => row.scheduleId === scheduleId && row.revision === revision);
    if (!spec || (!context.isRoot && spec.request.credential.principalId !== context.principal.id))
      fail("schedule_not_found");
    const node: ManifoldRef = {
      kind: "operation",
      machineId: spec.request.machineId,
      operationId: spec.request.operationId,
    };
    if (
      (callerPluginId !== "engine.jobs" && spec.request.pluginId !== callerPluginId) ||
      !this.callerOwnsNode(callerPluginId, node) ||
      !this.canReadGoverned(context, node) ||
      !this.consentFor(this.resolve(node)!, node, "machines:run")
    )
      fail();
    if (!this.auth.allowsRef(context, "machines:run", node)) fail();
    this.jobSchedules.disableSchedule(scheduleId, revision, "schedule_disabled");
    for (const job of this.jobs.active())
      if (this.jobSchedules.getOccurrence(job.request.jobId)?.schedule_id === scheduleId)
        this.cancelRecord(job, "schedule_disabled");
  }

  tick(): void {
    this.reconcileAuthority();
    this.jobSchedules.tick(this.runtime.now(), {
      reauthorize: (request) => this.reauthorizeDeferred(request),
      isOnline: (machineId) => this.channels.get(machineId)?.proved === true,
      enqueue: (request) => {
        this.jobs.reserve(request, this.runtime.now());
      },
    });
    for (const job of this.jobs.active()) if (job.state === "queued") this.start(job);
  }

  private reconcileAuthority(): void {
    for (const job of this.jobs.active()) {
      if (job.state === "queued") continue; // Admission independently checks current authority.
      const reason =
        this.jobs.cancellation(job.request.jobId) ??
        this.reauthorizeDeferred(job.request) ??
        this.invocationRefusal(job.request, false);
      if (reason !== null) this.cancelRecord(job, reason);
    }
    for (const follower of [...this.followers])
      if (!this.canReadGoverned(follower.auth, follower.node, follower.callerPluginId))
        this.closeFollower(follower, "authority_revoked");
  }

  setInvocationEdge(auth: AuthContext, args: { edge: JobInvocationEdge; enabled: boolean }): void {
    if (!auth.isRoot || !this.context(this.auth.credentialReference(auth))) fail();
    const { edge, enabled } = args;
    for (const bound of [edge.maxDepth, edge.maxConcurrency, ...Object.values(edge.aggregate)])
      if (!Number.isSafeInteger(bound) || bound < 1) fail("invalid_invocation_bound");
    if (edge.caller.machineId !== edge.callee.machineId) fail("invocation_cross_host");
    for (const target of [edge.caller, edge.callee]) {
      const install = this.jobs.installation(target.machineId, target.pluginId);
      if (
        !install?.enabled ||
        install.revision !== target.installationRevision ||
        install.artifact !== target.artifactSha256 ||
        !Object.hasOwn(install.machine.operations, target.operationId)
      )
        fail("invocation_target_changed");
    }
    const callee = this.jobs.installation(edge.callee.machineId, edge.callee.pluginId)!;
    const operation = callee.machine.operations[edge.callee.operationId]!;
    const resources = operation.locations.map((resource) => ({
      ...resource,
      revision: callee.machine.locations[resource.locationId]?.revision,
    }));
    if (canonicalJobJson(resources) !== canonicalJobJson(edge.resources))
      fail("invocation_resources_changed");
    if (edge.outputs.length > 30) fail("invocation_output_limit");
    const outputs = edge.outputs.map((output) => JobOutputRuleSchema.parse(output));
    const caller = this.jobs.installation(edge.caller.machineId, edge.caller.pluginId)!;
    const callerOperation = caller.machine.operations[edge.caller.operationId]!;
    if (
      new Set(outputs.map((output) => output.name)).size !== outputs.length ||
      outputs.some(
        (output) =>
          output.name === "stdout" ||
          output.name === "stderr" ||
          !operation.outputs.includes(output.name) ||
          caller.machine.locations[output.locationId]?.kind === "file" ||
          !callerOperation.locations.some(
            (location) =>
              location.locationId === output.locationId &&
              (location.access === "write" || location.access === "create"),
          ),
      )
    )
      fail("invalid_output_binding");
    this.store.transaction(() => {
      this.store.db
        .query(
          "INSERT INTO job_invocation_edges(caller,operation_id,edge,enabled) VALUES(?,?,?,?) ON CONFLICT(caller,operation_id) DO UPDATE SET edge=excluded.edge,enabled=excluded.enabled",
        )
        .run(
          canonicalJobJson(edge.caller),
          edge.callee.operationId,
          canonicalJobJson(edge),
          enabled ? 1 : 0,
        );
    });
    for (const job of this.jobs.active())
      if (job.request.parent && this.invocationRefusal(job.request, false))
        this.cancelRecord(job, "invocation_edge_changed");
  }

  invocationRefusal(request: JobRequest, requireLiveOwner = true): string | null {
    if (!request.parent) return null;
    const parent = this.jobs.get(request.parent.parentJobId);
    const live = this.channels.get(request.machineId);
    if (
      !parent ||
      parent.state !== "started" ||
      !parent.permit ||
      parent.request.machineId !== request.machineId ||
      (requireLiveOwner && !live?.proved) ||
      (live?.proved &&
        (live.owner.ownerId !== parent.permit.ownerId ||
          live.owner.generation !== parent.permit.ownerGeneration))
    )
      return "invocation_parent_not_live";
    const reservation = this.store.db
      .query<{ edge: string; request: string; active: number }, [string]>(
        "SELECT edge,request,active FROM job_invocation_reservations WHERE job_id=?",
      )
      .get(request.jobId);
    if (!reservation?.active || reservation.request !== canonicalJobJson(request))
      return "invocation_reservation_missing";
    const edge = JSON.parse(reservation.edge) as JobInvocationEdge;
    const current = this.store.db
      .query<{ edge: string; enabled: number }, [string, string]>(
        "SELECT edge,enabled FROM job_invocation_edges WHERE caller=? AND operation_id=?",
      )
      .get(canonicalJobJson(edge.caller), request.operationId);
    if (!current?.enabled || current.edge !== reservation.edge) return "invocation_edge_changed";
    return this.reauthorizeDeferred(parent.request);
  }

  private invoke(machineId: string, event: Extract<JobEvent, { type: "invocation" }>): void {
    const parent = this.jobs.get(event.parentJobId);
    const live = this.channels.get(machineId);
    if (
      !parent?.permit ||
      !live?.proved ||
      parent.request.machineId !== machineId ||
      parent.state !== "started" ||
      parent.permit.ownerId !== live.owner.ownerId ||
      parent.permit.ownerGeneration !== live.owner.generation
    )
      fail("invocation_parent_not_host_bound");
    const { pluginId, operationId, installationRevision, artifactSha256 } = parent.request;
    const caller = { machineId, pluginId, operationId, installationRevision, artifactSha256 };
    const stored = this.store.db
      .query<{ edge: string; enabled: number }, [string, string]>(
        "SELECT edge,enabled FROM job_invocation_edges WHERE caller=? AND operation_id=?",
      )
      .get(canonicalJobJson(caller), event.operationId);
    if (!stored?.enabled) fail("invocation_edge_missing");
    const edge = JSON.parse(stored.edge) as JobInvocationEdge;
    const context = this.context(parent.request.credential);
    if (!context) fail("invocation_credential_revoked");
    const template = this.build(
      context,
      edge.callee.pluginId,
      parent.request.traceId,
      {
        jobId: `invocation-${digest([event.parentJobId, event.invocationId])}`,
        machineId,
        operationId: event.operationId,
        input: event.input,
        outputs: event.outputs,
      },
      parent.request,
    );
    const unsigned: Omit<JobRequest, "requestDigest"> & { requestDigest?: string } = {
      ...template,
      credential: parent.request.credential,
      parent: { parentJobId: event.parentJobId, invocationId: event.invocationId },
    };
    delete unsigned.requestDigest;
    const child = { ...unsigned, requestDigest: digest(unsigned) };
    const callee = this.jobs.installation(machineId, edge.callee.pluginId)!;
    const resources = callee.machine.operations[event.operationId]!.locations.map((resource) => ({
      ...resource,
      revision: callee.machine.locations[resource.locationId]!.revision,
    }));
    this.jobSchedules.reserveInvocation(
      {
        parent: {
          request: parent.request,
          state: parent.state,
          ownerId: parent.permit.ownerId,
          ownerGeneration: parent.permit.ownerGeneration,
        },
        host: { machineId, ownerId: live.owner.ownerId, ownerGeneration: live.owner.generation },
        child,
        edge,
        resources,
        now: this.runtime.now(),
      },
      {
        reauthorize: (request) => this.reauthorizeDeferred(request),
        enqueue: (request) => {
          this.jobs.reserve(request, this.runtime.now());
        },
      },
    );
    const reserved = this.jobs.get(child.jobId)!;
    if (reserved.state === "queued") this.start(reserved);
    if (this.jobs.get(child.jobId)?.state === "refused") fail("invocation_start_refused");
  }
  private manifestResolver: ((pluginId: string) => MachineHalf | null) | null = null;
  setManifestResolver(resolver: (pluginId: string) => MachineHalf | null): void {
    this.manifestResolver = resolver;
  }
  declaredMachine(pluginId: string): MachineHalf | null {
    return this.manifestResolver?.(pluginId) ?? null;
  }
  private readonly followers = new Set<JobFollower>();
  private readonly followQueue: {
    jobId: string;
    seq: number;
    event: JobFollowEvent;
    reason: "gap" | "limit" | null;
  }[] = [];
  private publishingFollow = false;
  private readonly replay = new Map<string, JobReplay>();
  private replayBytes = 0;
  follow(
    auth: AuthContext,
    node: ManifoldRef,
    receive: (update: JobFollowUpdate) => void,
    callerPluginId = "engine.jobs",
  ): JobFollow {
    if (node.kind !== "job") return fail("follow_requires_job");
    const job = this.authorizedJob(auth, node, "jobs:read", callerPluginId);
    let count = 0;
    for (const follower of this.followers) if (follower.node.jobId === node.jobId) count++;
    if (this.followers.size >= 256 || count >= 16) return fail("follow_limit");
    const watermark = this.store.db
      .query<{ event_seq: number }, [string]>("SELECT event_seq FROM machine_jobs WHERE job_id=?")
      .get(node.jobId);
    const follower: JobFollower = {
      auth: structuredClone(auth),
      callerPluginId,
      node: structuredClone(node),
      seq: watermark?.event_seq ?? 0,
      receive,
    };
    this.followers.add(follower);
    const ring = this.replay.get(node.jobId);
    const frames = ring?.frames ?? [];
    const firstSeq = frames[0]?.seq ?? null;
    const missingThrough = firstSeq === null ? follower.seq : firstSeq - 1;
    return {
      snapshot: {
        jobId: node.jobId,
        state: job.state,
        result: structuredClone(job.result),
        seq: follower.seq,
        firstSeq,
        events: frames.map(({ seq, event }) => ({ seq, event: structuredClone(event) })),
        unavailable: missingThrough > 0 ? { fromSeq: 1, toSeq: missingThrough } : null,
      },
      close: () => this.closeFollower(follower, "closed"),
    };
  }
  private closeFollower(
    follower: JobFollower,
    reason: Extract<JobFollowUpdate, { type: "closed" }>["reason"],
  ): void {
    if (!this.followers.delete(follower)) return;
    try {
      follower.receive({ type: "closed", reason });
    } catch {
      /* Detached consumers cannot retain a subscription. */
    }
  }
  private retainJobEvent(
    jobId: string,
    seq: number,
    event: JobFollowEvent,
    unavailable: boolean,
  ): void {
    let ring = this.replay.get(jobId);
    if (ring) {
      this.replay.delete(jobId);
      if (unavailable) {
        this.replayBytes -= ring.bytes;
        return;
      }
    } else {
      if (unavailable) return;
      ring = { frames: [], bytes: 0 };
    }
    const frame = {
      seq,
      event: structuredClone(event),
      bytes: Buffer.byteLength(JSON.stringify({ seq, event })) + 1,
    };
    ring.frames.push(frame);
    ring.bytes += frame.bytes;
    this.replayBytes += frame.bytes;
    while (ring.frames.length > MAX_JOB_FOLLOW_EVENTS || ring.bytes + 2 > MAX_JOB_FOLLOW_BYTES) {
      const removed = ring.frames.shift()!;
      ring.bytes -= removed.bytes;
      this.replayBytes -= removed.bytes;
    }
    this.replay.set(jobId, ring);
    while (this.replay.size > 64 || this.replayBytes > 4 * 1024 * 1024) {
      const oldest = this.replay.entries().next().value;
      if (!oldest) break;
      this.replay.delete(oldest[0]);
      this.replayBytes -= oldest[1].bytes;
    }
  }
  publishJobEvent(jobId: string, event: JobEvent): void {
    if (
      event.type !== "state" &&
      event.type !== "result" &&
      event.type !== "output" &&
      event.type !== "refusal"
    )
      return;
    if (event.type === "output" && event.requestId !== jobId) return;
    const previous = this.store.db
      .query<{ event_seq: number; output_seq: number | null }, [string]>(
        "SELECT event_seq,output_seq FROM machine_jobs WHERE job_id=?",
      )
      .get(jobId);
    if (!previous) return;
    const reason =
      previous.event_seq >= Number.MAX_SAFE_INTEGER ||
      (event.type === "output" && event.data.length > 87384)
        ? "limit"
        : event.type === "output" && event.seq !== (previous.output_seq ?? 0) + 1
          ? "gap"
          : null;
    const seq = Math.min(previous.event_seq + 1, Number.MAX_SAFE_INTEGER);
    this.store.db
      .query("UPDATE machine_jobs SET event_seq=?,output_seq=? WHERE job_id=?")
      .run(seq, event.type === "output" ? event.seq : previous.output_seq, jobId);
    this.retainJobEvent(jobId, seq, event, reason !== null);
    if (this.followQueue.length >= 64) {
      for (const follower of [...this.followers]) this.closeFollower(follower, "limit");
      this.followQueue.length = 0;
      return;
    }
    this.followQueue.push({ jobId, seq, event: structuredClone(event), reason });
    if (this.publishingFollow) return;
    this.publishingFollow = true;
    try {
      let delivered = 0;
      while (this.followQueue.length > 0) {
        if (++delivered > 64) {
          for (const follower of [...this.followers]) this.closeFollower(follower, "limit");
          this.followQueue.length = 0;
          break;
        }
        const next = this.followQueue.shift()!;
        for (const follower of [...this.followers]) {
          if (
            follower.node.jobId !== next.jobId ||
            !this.followers.has(follower) ||
            follower.seq >= next.seq
          )
            continue;
          if (!this.canReadGoverned(follower.auth, follower.node, follower.callerPluginId)) {
            this.closeFollower(follower, "authority_revoked");
            continue;
          }
          if (next.reason !== null) {
            this.closeFollower(follower, next.reason);
            continue;
          }
          follower.seq = next.seq;
          try {
            follower.receive({ type: "event", seq: next.seq, event: structuredClone(next.event) });
          } catch {
            this.closeFollower(follower, "consumer_failed");
          }
        }
      }
    } finally {
      this.publishingFollow = false;
    }
  }
  readonly jobs: JobStore;
  readonly admissionPublicKey: string;
  private readonly signingKey: string;
  private readonly channels = new Map<
    string,
    { channel: JobChannel; owner: JobOwner; nonce: string; epoch: string; proved: boolean }
  >();
  private readonly reads = new Map<
    string,
    {
      machineId: string;
      jobId: string;
      outputId: string;
      auth: AuthContext;
      readonly callerPluginId: string;
      node: ManifoldRef;
      resolve: (event: Extract<JobEvent, { type: "output" }>) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(
    readonly store: ServerStore,
    readonly auth: AuthService,
    readonly runtime: RuntimeDeps,
  ) {
    this.jobs = new JobStore(store, (job, phase) => this.lifecycle(job, phase));
    this.jobSchedules = new JobSchedules(store);
    const keys = store.transaction(() => {
      const existing = store.getMeta("jobs:signing-key");
      if (existing) return JSON.parse(existing) as { privateKey: string; publicKey: string };
      const pair = generateKeyPairSync("ed25519");
      const value = {
        privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
      };
      store.setMeta("jobs:signing-key", JSON.stringify(value));
      return value;
    });
    this.signingKey = keys.privateKey;
    this.admissionPublicKey = keys.publicKey;
    auth.onAuthorityChanged(() => this.reconcileAuthority());
    auth.onRevoked((principalId) => {
      for (const job of this.jobs.active()) {
        if (job.request.credential.principalId === principalId) {
          this.cancelRecord(job, "credential_revoked");
          continue;
        }
        const machine = this.store.getMachine(job.request.machineId);
        if (machine && this.store.getToken(machine.tokenId)?.principalId === principalId)
          this.cancelRecord(job, "executor_revoked");
      }
    });
  }
  private context(reference: CredentialReference): AuthContext | null {
    const principal = this.store.getPrincipal(reference.principalId);
    if (!principal) return null;
    if (reference.expiresAt !== undefined && reference.expiresAt <= this.runtime.now()) return null;
    if (reference.tokenId !== null) {
      const token = this.store.getToken(reference.tokenId);
      if (
        !token ||
        token.revokedAt !== null ||
        token.principalId !== reference.principalId ||
        token.grantId !== reference.grantId ||
        token.containerId !== reference.containerScope ||
        (token.expiresAt !== null && token.expiresAt <= this.runtime.now()) ||
        reference.caps.some((c) => !token.caps.includes(c) && !token.caps.includes("*"))
      )
        return null;
    } else if (reference.principalId !== this.auth.ownerPrincipal.id) return null;
    return {
      principal,
      caps: [...reference.caps],
      containerScope: reference.containerScope,
      tokenId: reference.tokenId,
      grantId: reference.grantId,
      isRoot: reference.tokenId === null,
      ...(reference.expiresAt === undefined ? {} : { expiresAt: reference.expiresAt }),
    };
  }
  private resolve(node: ManifoldRef): JobInstallation | null {
    if (!("machineId" in node) || !this.store.getMachine(node.machineId)) return null;
    if (node.kind === "job" || node.kind === "output") {
      const job = this.jobs.get(node.jobId);
      if (
        !job ||
        job.request.machineId !== node.machineId ||
        job.request.operationId !== node.operationId
      )
        return null;
      if (
        node.kind === "output" &&
        !this.store.db
          .query("SELECT node FROM machine_job_outputs WHERE node=? AND released=0")
          .get(formatManifoldUri(node))
      )
        return null;
      const install = this.jobs.installation(
        node.machineId,
        job.request.pluginId,
        job.request.installationRevision,
      );
      return install?.artifact === job.request.artifactSha256 ? install : null;
    }
    return (
      this.jobs
        .installations(node.machineId)
        .find((i) =>
          node.kind === "operation"
            ? Object.hasOwn(i.machine.operations, node.operationId)
            : node.kind === "location"
              ? Object.hasOwn(i.machine.locations, node.locationId)
              : false,
        ) ?? null
    );
  }
  ownsNode(pluginId: string, node: ManifoldRef): boolean {
    return this.resolve(node)?.pluginId === pluginId;
  }
  private callerOwnsNode(pluginId: string, node: ManifoldRef): boolean {
    return pluginId === "engine.jobs" || this.ownsNode(pluginId, node);
  }
  private consentFor(
    install: JobInstallation,
    node: ManifoldRef,
    cap: Cap,
    effective = true,
  ): { node: string; revision: string; artifactSha256: string } | null {
    const uri = formatManifoldUri(node);
    const consentNode =
      node.kind === "job" || node.kind === "output"
        ? formatManifoldUri({
            kind: "operation",
            machineId: node.machineId,
            operationId: node.operationId,
          })
        : uri;
    const row = this.store.db
      .query<
        { revision: string; artifact: string; installation_revision: string; enabled: number },
        [string, string, string, string, string]
      >(
        "SELECT revision,artifact,installation_revision,enabled FROM machine_job_consents WHERE machine_id=? AND plugin_id=? AND installation_revision=? AND node=? AND cap=?",
      )
      .get(install.machineId, install.pluginId, install.revision, consentNode, cap);
    return row !== null &&
      (!effective ||
        (install.enabled &&
          !install.purgeRequested &&
          !this.store.disabledPlugins().has(install.pluginId) &&
          row?.enabled === 1 &&
          row.artifact === install.artifact &&
          row.installation_revision === install.revision))
      ? { node: uri, revision: row.revision, artifactSha256: row.artifact }
      : null;
  }
  canReadGoverned(auth: AuthContext, node: ManifoldRef, callerPluginId = "engine.jobs"): boolean {
    const cap =
      node.kind === "job" || node.kind === "output"
        ? "jobs:read"
        : node.kind === "location"
          ? "locations:read"
          : node.kind === "operation"
            ? "operations:invoke"
            : null;
    if (cap === null) return true;
    const current = this.context(this.auth.credentialReference(auth));
    const install = this.resolve(node);
    return (
      this.callerOwnsNode(callerPluginId, node) &&
      current !== null &&
      install !== null &&
      (current.caps.includes("*") || current.caps.includes(cap)) &&
      this.auth.allowsRef(current, cap, node) &&
      this.consentFor(install, node, cap) !== null
    );
  }
  decide(
    request: GovernedAdmissionRequest,
    refusal: string | null = null,
  ): GovernedAdmissionDecision & { decisionId: string; policyRevision: string } {
    return this.store.transaction(() => {
      const context = this.context(request.credential);
      let allowed = context !== null && request.evidence.length > 0 && refusal === null;
      const consents: { node: string; revision: string; artifactSha256: string }[] = [];
      const evidence: unknown[] = [];
      for (const prior of request.evidence) {
        const { cap, ref } = prior.requirement;
        const install = this.resolve(ref);
        const fresh = context
          ? this.auth.explain(context, prior.requirement)
          : { ...prior, winner: null, allowed: false };
        const consent = install ? this.consentFor(install, ref, cap) : null;
        const discharged =
          context !== null &&
          install !== null &&
          (context.caps.includes("*") || context.caps.includes(cap)) &&
          fresh.allowed &&
          consent !== null;
        if (!discharged) allowed = false;
        const observedConsent =
          consent ?? (install ? this.consentFor(install, ref, cap, false) : null);
        if (observedConsent) consents.push(observedConsent);
        evidence.push({
          requirement: prior.requirement,
          winner: fresh.winner,
          allowed: discharged,
          revision: this.jobs.revision(
            "grant",
            fresh.winner?.id ?? "missing",
            digest(fresh.winner),
          ),
        });
      }
      const credentialRevision = this.jobs.revision(
        "credential",
        request.credential.tokenId ?? request.credential.principalId,
        digest({
          reference: request.credential,
          token:
            request.credential.tokenId === null
              ? null
              : this.store.getToken(request.credential.tokenId),
        }),
      );
      const verdict = {
        allowed,
        refusal: allowed ? null : (refusal ?? "authority_or_consent_refused"),
        requirements: evidence,
      };
      const policyRevision = String(
        this.jobs.revision(
          "policy",
          "workspace",
          digest({
            evidence: verdict,
            consents,
            credentialRevision,
            disabled: [...this.store.disabledPlugins()].sort(),
          }),
        ),
      );
      const decisionId = randomUUID();
      this.store.db
        .query("INSERT INTO machine_job_decisions VALUES (?,?,?,?,?,?,?,?)")
        .run(
          decisionId,
          this.runtime.now(),
          request.pluginId,
          request.action,
          canonicalJobJson({ ...request.credential, credentialRevision }),
          policyRevision,
          canonicalJobJson(verdict),
          canonicalJobJson(consents),
        );
      return allowed
        ? { allowed: true, decisionId, policyRevision, consentRevisions: consents }
        : { allowed: false, decisionId, policyRevision };
    });
  }
  install(
    auth: AuthContext,
    args: {
      machineId: string;
      pluginId: string;
      installationRevision: string;
      artifactSha256: string;
      machine: MachineHalf;
    },
  ): void {
    if (!auth.isRoot || !this.context(this.auth.credentialReference(auth))) fail();
    const machine = MachineHalfSchema.parse(args.machine);
    if (
      !this.store.getMachine(args.machineId) ||
      !Object.values(machine.artifacts).some((a) => a.sha256 === args.artifactSha256)
    )
      fail();
    const declared = this.declaredMachine(args.pluginId);
    if (declared === null || digest(declared) !== digest(machine))
      fail("manifest_declaration_mismatch");
    for (const name of [...Object.keys(machine.operations), ...Object.keys(machine.locations)])
      if (!name.startsWith(`${args.pluginId}.`)) fail("unqualified_declaration");
    for (const operation of Object.values(machine.operations)) {
      if (
        operation.locations.some(
          (location) => !Object.hasOwn(machine.locations, location.locationId),
        ) ||
        operation.argv.some(
          (slot) => "input" in slot && !Object.hasOwn(operation.input, slot.input),
        ) ||
        new Set(operation.outputs).size !== operation.outputs.length
      )
        fail("invalid_operation_declaration");
    }
    this.store.transaction(() => {
      if (this.jobs.active(args.machineId).some((j) => j.request.pluginId === args.pluginId))
        fail("active_installation");
      const historical = this.jobs.installation(
        args.machineId,
        args.pluginId,
        args.installationRevision,
      );
      if (
        historical &&
        (digest(historical.machine) !== digest(machine) ||
          historical.artifact !== args.artifactSha256)
      )
        fail("installation_revision_conflict");
      this.store.db
        .query(
          "INSERT INTO machine_job_installations(machine_id,plugin_id,revision,artifact,manifest) VALUES (?,?,?,?,?) ON CONFLICT(machine_id,plugin_id,revision) DO NOTHING",
        )
        .run(
          args.machineId,
          args.pluginId,
          args.installationRevision,
          args.artifactSha256,
          canonicalJobJson(machine),
        );
      this.store.db
        .query(
          "INSERT INTO machine_job_installs(machine_id,plugin_id,revision,artifact,manifest,enabled,ready,purge_requested) VALUES (?,?,?,?,?,1,0,0) ON CONFLICT(machine_id,plugin_id) DO UPDATE SET revision=excluded.revision,artifact=excluded.artifact,manifest=excluded.manifest,enabled=1,ready=0,purge_requested=0",
        )
        .run(
          args.machineId,
          args.pluginId,
          args.installationRevision,
          args.artifactSha256,
          canonicalJobJson(machine),
        );
    });
    this.sendInstall(this.jobs.installation(args.machineId, args.pluginId)!);
    this.reconcileAuthority();
  }
  consent(
    auth: AuthContext,
    args: {
      machineId: string;
      pluginId: string;
      installationRevision: string;
      node: string;
      artifactSha256: string;
      cap: Cap;
      enabled: boolean;
    },
  ): void {
    if (!auth.isRoot || !this.context(this.auth.credentialReference(auth))) fail();
    const node = parseManifoldUri(args.node);
    if (!node) fail();
    const install =
      node.kind === "job" || node.kind === "output"
        ? this.resolve(node)
        : this.jobs.installation(args.machineId, args.pluginId, args.installationRevision);
    if (
      !install ||
      !("machineId" in node) ||
      node.machineId !== args.machineId ||
      install.pluginId !== args.pluginId ||
      install.machineId !== args.machineId ||
      install.revision !== args.installationRevision ||
      install.artifact !== args.artifactSha256 ||
      (node.kind === "operation"
        ? !Object.hasOwn(install.machine.operations, node.operationId)
        : node.kind === "location"
          ? !Object.hasOwn(install.machine.locations, node.locationId)
          : node.kind !== "job" && node.kind !== "output")
    )
      fail();
    const consentNode =
      node.kind === "job" || node.kind === "output"
        ? formatManifoldUri({
            kind: "operation",
            machineId: node.machineId,
            operationId: node.operationId,
          })
        : formatManifoldUri(node);
    this.store.db
      .query(
        "INSERT INTO machine_job_consents VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(machine_id,plugin_id,installation_revision,node,cap) DO UPDATE SET revision=excluded.revision,enabled=excluded.enabled",
      )
      .run(
        args.machineId,
        args.pluginId,
        consentNode,
        args.cap,
        args.installationRevision,
        args.artifactSha256,
        randomUUID(),
        args.enabled ? 1 : 0,
      );
    this.reconcileAuthority();
  }
  private requirements(request: JobRequest): AuthorityRequirement[] {
    const install = this.jobs.installation(request.machineId, request.pluginId);
    const op = install?.machine.operations[request.operationId];
    if (
      !install ||
      !op ||
      !install.enabled ||
      install.revision !== request.installationRevision ||
      install.artifact !== request.artifactSha256 ||
      this.store.disabledPlugins().has(request.pluginId)
    )
      fail("installation_changed");
    const invocation: AuthorityRequirement[] = [];
    if (request.parent) {
      const parent = this.jobs.get(request.parent.parentJobId);
      if (!parent) fail("invocation_parent_missing");
      invocation.push(
        {
          cap: "operations:invoke",
          ref: {
            kind: "operation",
            machineId: request.machineId,
            operationId: request.operationId,
          },
        },
        {
          cap: "operations:invoke",
          ref: {
            kind: "operation",
            machineId: parent.request.machineId,
            operationId: parent.request.operationId,
          },
        },
      );
    }
    return [
      ...invocation,
      {
        cap: "machines:run",
        ref: { kind: "operation", machineId: request.machineId, operationId: request.operationId },
      },
      ...op.locations.map((l) => ({
        cap: `locations:${l.access}` as const,
        ref: { kind: "location" as const, machineId: request.machineId, locationId: l.locationId },
      })),
      ...(op.network === "host"
        ? [
            {
              cap: "network:host" as const,
              ref: {
                kind: "operation" as const,
                machineId: request.machineId,
                operationId: request.operationId,
              },
            },
          ]
        : []),
    ];
  }
  private build(
    auth: AuthContext,
    pluginId: string,
    traceId: string,
    args: JobExecution,
    outputParent?: JobRequest,
  ): JobRequest {
    const install = this.jobs.installation(args.machineId, pluginId);
    const op = install?.machine.operations[args.operationId];
    if (!install || !op) fail("unknown_operation");
    for (const [key, field] of Object.entries(op.input))
      if (
        field.format === "revisioned-id" &&
        args.input[key] !== undefined &&
        (typeof args.input[key] !== "string" ||
          !/^[A-Za-z0-9._-]{1,128}@[A-Za-z0-9._-]{1,128}$/.test(args.input[key] as string))
      )
        fail("invalid_revisioned_input");
    for (const [key, field] of Object.entries(op.input)) {
      const value = args.input[key];
      if (value === undefined) {
        if (field.required) fail("invalid_input");
        continue;
      }
      if (
        typeof value !== field.type ||
        (typeof value === "string" && value.length > (field.maxLength ?? 4096)) ||
        (field.enum && !field.enum.includes(value))
      )
        fail("invalid_input");
    }
    if (Object.keys(args.input).some((k) => !Object.hasOwn(op.input, k))) fail("invalid_input");
    const limits = args.limits ?? op.limits;
    for (const key of Object.keys(op.limits) as (keyof typeof limits)[])
      if (limits[key] > op.limits[key]) fail("limit_exceeded");
    const outputInstall = outputParent
      ? this.jobs.installation(outputParent.machineId, outputParent.pluginId)
      : install;
    const outputOperation = outputParent
      ? outputInstall?.machine.operations[outputParent.operationId]
      : op;
    if (
      !outputInstall ||
      !outputOperation ||
      (outputParent &&
        (outputParent.machineId !== args.machineId ||
          outputInstall.revision !== outputParent.installationRevision ||
          outputInstall.artifact !== outputParent.artifactSha256))
    )
      fail("output_parent_changed");
    if (new Set(args.outputs.map((o) => o.name)).size !== args.outputs.length)
      fail("duplicate_output");
    for (const output of args.outputs)
      if (
        output.name === "stdout" ||
        output.name === "stderr" ||
        !op.outputs.includes(output.name) ||
        outputInstall.machine.locations[output.locationId]?.kind === "file" ||
        !outputOperation.locations.some(
          (l) =>
            l.locationId === output.locationId && (l.access === "write" || l.access === "create"),
        )
      )
        fail("invalid_output_binding");
    const originalTraceId = this.jobs.get(args.jobId)?.request.traceId ?? traceId;
    const unsigned = {
      ...args,
      limits,
      pluginId,
      traceId: originalTraceId,
      installationRevision: install.revision,
      artifactSha256: install.artifact,
      parent: null,
      credential: this.auth.credentialReference(auth),
    };
    return JobRequestSchema.parse({ ...unsigned, requestDigest: digest(unsigned) });
  }
  execute(auth: AuthContext, pluginId: string, traceId: string, args: JobExecution): JobRecord {
    const context = this.context(this.auth.credentialReference(auth));
    if (!context) fail("credential_revoked_or_expired");
    const request = this.build(context, pluginId, traceId, args);
    const job = this.store.transaction(() => {
      const reserved = this.jobs.reserve(request, this.runtime.now());
      if (reserved.state !== "queued")
        return this.authorizedJob(
          context,
          {
            kind: "job",
            machineId: reserved.request.machineId,
            operationId: reserved.request.operationId,
            jobId: reserved.request.jobId,
          },
          "jobs:read",
          pluginId,
        );
      const decision = this.decide({
        credential: request.credential,
        pluginId,
        action: reserved.auditOrigin?.door ?? "engine.jobs.execute",
        evidence: this.requirements(request).map((requirement) =>
          this.auth.explain(context, requirement),
        ),
      });
      this.jobs.decision(request.jobId, decision.decisionId);
      const allowed = decision.allowed;
      if (!allowed) {
        if (reserved.state !== "queued") fail();
        this.jobs.state(request.jobId, "refused");
      }
      return this.jobs.get(request.jobId)!;
    });
    if (job.state === "queued") this.start(job);
    return this.jobs.get(request.jobId)!;
  }
  private start(job: JobRecord): void {
    const request = job.request;
    const live = this.channels.get(request.machineId);
    if (!live?.proved) return;
    const permit = this.store.transaction(() => {
      const current = this.jobs.get(request.jobId)!;
      if (current.state !== "queued") return null;
      const machine = this.store.getMachine(request.machineId);
      const install = this.jobs.installation(request.machineId, request.pluginId);
      if (!machine || machine.draining || !install?.ready) return null;
      const context = this.context(request.credential);
      let refusal = !context
        ? "credential_revoked_or_expired"
        : (this.jobSchedules.startRefusal(request.jobId, this.runtime.now()) ??
          this.jobs.cancellation(request.jobId) ??
          this.invocationRefusal(request));
      let requirements: AuthorityRequirement[] = [];
      try {
        requirements = this.requirements(request);
      } catch {
        refusal = "installation_changed";
      }
      const decision = this.decide(
        {
          credential: request.credential,
          pluginId: request.pluginId,
          action: current.auditOrigin?.door ?? "engine.jobs.execute",
          evidence: requirements.map((requirement) =>
            context
              ? this.auth.explain(context, requirement)
              : { requirement, winner: null, allowed: false },
          ),
        },
        refusal,
      );
      this.jobs.decision(request.jobId, decision.decisionId);
      if (!decision.allowed) {
        this.jobs.state(request.jobId, "refused");
        return null;
      }
      const unsigned = {
        permitId: randomUUID(),
        jobId: request.jobId,
        requestDigest: request.requestDigest,
        ownerId: live.owner.ownerId,
        ownerGeneration: live.owner.generation,
        decisionId: decision.decisionId,
        policyRevision: decision.policyRevision,
        issuedAt: this.runtime.now(),
        expiresAt: this.runtime.now() + 5000,
      };
      const permit = {
        ...unsigned,
        signature: sign(null, Buffer.from(canonicalJobJson(unsigned)), this.signingKey).toString(
          "base64",
        ),
      };
      this.jobs.state(request.jobId, "admitted", permit);
      this.jobs.state(request.jobId, "start-committed", permit);
      return permit;
    });
    if (!permit && this.jobs.get(request.jobId)?.state === "refused") {
      this.jobSchedules.finishInvocation(request.jobId);
      this.publishJobEvent(request.jobId, {
        type: "refusal",
        jobId: request.jobId,
        reason: "admission_refused",
      });
    }
    if (permit)
      live.channel.send({ type: "job_command", command: { type: "start", request, permit } });
  }
  online(channel: JobChannel, owner: JobOwner | undefined, epoch: string): void {
    this.channels.delete(channel.machineId);
    this.store.db
      .query("UPDATE machine_job_installs SET ready=0 WHERE machine_id=?")
      .run(channel.machineId);
    if (!owner) return;
    const pinned = this.jobs.owner(channel.machineId);
    if (
      pinned &&
      (pinned.ownerId !== owner.ownerId ||
        pinned.publicKey !== owner.publicKey ||
        owner.generation < pinned.generation)
    )
      return;
    const nonce = randomUUID();
    this.channels.set(channel.machineId, { channel, owner, nonce, epoch, proved: false });
    channel.send({
      type: "job_command",
      command: {
        type: "owner_challenge",
        nonce,
        serverEpoch: epoch,
        machineId: channel.machineId,
        admissionPublicKey: this.admissionPublicKey,
      },
    });
  }
  offline(channel: JobChannel): void {
    if (this.channels.get(channel.machineId)?.channel === channel) {
      this.channels.delete(channel.machineId);
      this.store.db
        .query("UPDATE machine_job_installs SET ready=0 WHERE machine_id=?")
        .run(channel.machineId);
    }
  }
  private sendInstall(install: JobInstallation): void {
    const live = this.channels.get(install.machineId);
    if (live?.proved)
      live.channel.send({
        type: "job_command",
        command: {
          type: "install",
          pluginId: install.pluginId,
          installationRevision: install.revision,
          artifactSha256: install.artifact,
          machine: install.machine,
          ...(install.purgeRequested
            ? { action: "purge" as const }
            : install.enabled
              ? {}
              : { action: "disable" as const }),
        },
      });
  }
  event(channel: JobChannel, event: JobEvent): void {
    const live = this.channels.get(channel.machineId);
    if (!live || live.channel !== channel) return;
    if (event.type === "owner_proof") {
      if (
        live.proved ||
        event.nonce !== live.nonce ||
        event.serverEpoch !== live.epoch ||
        event.machineId !== channel.machineId ||
        canonicalJobJson(event.owner) !== canonicalJobJson(live.owner)
      )
        return;
      const unsigned = {
        nonce: event.nonce,
        serverEpoch: event.serverEpoch,
        machineId: event.machineId,
        owner: event.owner,
      };
      try {
        if (
          !verify(
            null,
            Buffer.from(canonicalJobJson(unsigned)),
            live.owner.publicKey,
            Buffer.from(event.signature, "base64"),
          )
        )
          return;
      } catch {
        return;
      }
      this.store.transaction(() => {
        const pinned = this.jobs.owner(channel.machineId);
        if (
          pinned &&
          (pinned.ownerId !== live.owner.ownerId ||
            pinned.publicKey !== live.owner.publicKey ||
            pinned.generation > live.owner.generation)
        )
          fail("owner_fenced");
        this.jobs.pinOwner(channel.machineId, live.owner);
      });
      live.proved = true;
      this.reconcileAuthority();
      for (const install of this.jobs.installations(channel.machineId)) this.sendInstall(install);
      channel.send({
        type: "job_command",
        command: {
          type: "drain",
          draining: this.store.getMachine(channel.machineId)?.draining ?? true,
        },
      });
      for (const job of this.jobs.active(channel.machineId)) {
        const cancellation = this.jobs.cancellation(job.request.jobId);
        if (cancellation !== null) this.cancelRecord(job, cancellation);
        else if (job.state === "queued") this.start(job);
        else
          channel.send({
            type: "job_command",
            command: { type: "status", jobId: job.request.jobId },
          });
      }
      return;
    }
    if (!live.proved) return;
    if (event.type === "installed") {
      const install = this.jobs.installation(channel.machineId, event.pluginId);
      if (
        !install ||
        install.revision !== event.installationRevision ||
        install.artifact !== event.artifactSha256 ||
        !install.enabled ||
        install.purgeRequested ||
        this.store.disabledPlugins().has(event.pluginId)
      )
        return;
      this.store.db
        .query("UPDATE machine_job_installs SET ready=1 WHERE machine_id=? AND plugin_id=?")
        .run(channel.machineId, event.pluginId);
      for (const job of this.jobs.active(channel.machineId))
        if (job.state === "queued") this.start(job);
      return;
    }
    if (event.type === "output") {
      if (event.requestId === event.jobId) {
        const job = this.jobs.get(event.jobId);
        if (
          job?.request.machineId === channel.machineId &&
          job.permit?.ownerId === live.owner.ownerId &&
          active.has(job.state) &&
          (event.outputId === "stdout" || event.outputId === "stderr")
        )
          this.publishJobEvent(event.jobId, event);
        return;
      }
      const read = this.reads.get(event.requestId);
      if (
        !read ||
        read.machineId !== channel.machineId ||
        read.jobId !== event.jobId ||
        read.outputId !== event.outputId
      )
        return;
      clearTimeout(read.timer);
      this.reads.delete(event.requestId);
      if (!this.canReadGoverned(read.auth, read.node, read.callerPluginId)) {
        read.reject(new Error("output_authority_revoked"));
        return;
      }
      read.resolve(event);
      return;
    }
    if (event.type === "invocation") {
      try {
        this.invoke(channel.machineId, event);
        channel.send({
          type: "job_command",
          command: {
            type: "invocation_reply",
            parentJobId: event.parentJobId,
            invocationId: event.invocationId,
            jobId: `invocation-${digest([event.parentJobId, event.invocationId])}`,
            reason: null,
          },
        });
      } catch {
        channel.send({
          type: "job_command",
          command: {
            type: "invocation_reply",
            parentJobId: event.parentJobId,
            invocationId: event.invocationId,
            jobId: null,
            reason: "invocation_refused",
          },
        });
      }
      return;
    }
    const job = this.jobs.get(event.type === "result" ? event.result.jobId : event.jobId);
    if (!job || job.request.machineId !== channel.machineId || !active.has(job.state)) return;
    if (event.type === "refusal") {
      if (job.state === "queued") this.jobs.state(job.request.jobId, "refused");
      else this.interrupt(job, "owner_refusal_unknown");
      return;
    }
    const fact = event.type === "result" ? event.result : event;
    if (
      fact.requestDigest !== job.request.requestDigest ||
      fact.ownerId !== job.permit?.ownerId ||
      fact.ownerGeneration !== job.permit.ownerGeneration ||
      fact.ownerId !== live.owner.ownerId ||
      fact.ownerGeneration > live.owner.generation
    )
      return;
    if (event.type === "state") {
      if (event.state === "started" && job.state === "start-committed") {
        this.jobs.state(job.request.jobId, "started");
        this.publishJobEvent(job.request.jobId, event);
      }
      return;
    }
    if (active.has(event.result.state)) return;
    this.store.transaction(() => {
      this.jobs.result(event.result);
      for (const output of event.result.outputs) {
        if (
          output.name !== "stdout" &&
          output.name !== "stderr" &&
          !job.request.outputs.some((o) => o.name === output.name)
        )
          fail("undeclared_output");
        const node = formatManifoldUri({
          kind: "output",
          machineId: channel.machineId,
          operationId: job.request.operationId,
          jobId: job.request.jobId,
          outputId: output.outputId,
        });
        this.store.db
          .query(
            "INSERT INTO machine_job_outputs(node,job_id,plugin_id,metadata) VALUES (?,?,?,?) ON CONFLICT(node) DO NOTHING",
          )
          .run(node, job.request.jobId, job.request.pluginId, canonicalJobJson(output));
      }
    });
    this.jobSchedules.finishInvocation(job.request.jobId);
    this.publishJobEvent(job.request.jobId, event);
  }
  private interrupt(job: JobRecord, reason: string): void {
    const p = job.permit;
    this.jobs.result({
      jobId: job.request.jobId,
      requestDigest: job.request.requestDigest,
      ownerId: p?.ownerId ?? "unknown",
      ownerGeneration: p?.ownerGeneration ?? 0,
      state: "interrupted",
      exitCode: null,
      reason,
      startedAt: null,
      finishedAt: this.runtime.now(),
      usage: null,
      limits: job.request.limits,
      outputs: [],
    });
    this.jobSchedules.finishInvocation(job.request.jobId);
    this.publishJobEvent(job.request.jobId, {
      type: "result",
      result: this.jobs.get(job.request.jobId)!.result!,
    });
  }
  private authorizedJob(
    auth: AuthContext,
    node: ManifoldRef,
    cap: "jobs:read" | "jobs:input" | "jobs:cancel",
    callerPluginId = "engine.jobs",
  ): JobRecord {
    if (node.kind !== "job" && node.kind !== "output") return fail();
    const context = this.context(this.auth.credentialReference(auth));
    const install = this.resolve(node);
    if (
      !this.callerOwnsNode(callerPluginId, node) ||
      !context ||
      !install ||
      (!context.caps.includes("*") && !context.caps.includes(cap)) ||
      !this.auth.allowsRef(context, cap, node) ||
      !this.consentFor(install, node, cap)
    )
      return fail();
    return this.jobs.get(node.jobId)!;
  }
  status(auth: AuthContext, node: ManifoldRef, callerPluginId = "engine.jobs"): JobRecord {
    return this.authorizedJob(auth, node, "jobs:read", callerPluginId);
  }
  input(
    auth: AuthContext,
    node: ManifoldRef,
    seq: number,
    data: string,
    eof: boolean,
    callerPluginId = "engine.jobs",
  ): void {
    const job = this.authorizedJob(auth, node, "jobs:input", callerPluginId);
    const command = { type: "input" as const, jobId: job.request.jobId, seq, data, eof };
    this.channels.get(job.request.machineId)?.channel.send({ type: "job_command", command });
  }
  cancel(auth: AuthContext, node: ManifoldRef, callerPluginId = "engine.jobs"): void {
    this.cancelRecord(this.authorizedJob(auth, node, "jobs:cancel", callerPluginId), "requested");
  }
  private cancelRecord(job: JobRecord, reason: string): void {
    if (!active.has(job.state)) return;
    this.jobs.cancel(job.request.jobId, reason);
    if (job.state === "queued") {
      this.jobs.state(job.request.jobId, "cancelled");
      this.jobSchedules.finishInvocation(job.request.jobId);
      this.publishJobEvent(job.request.jobId, {
        type: "refusal",
        jobId: job.request.jobId,
        reason: "cancelled",
      });
    } else
      this.channels.get(job.request.machineId)?.channel.send({
        type: "job_command",
        command: { type: "cancel", jobId: job.request.jobId, reason },
      });
    for (const child of this.jobs.active())
      if (child.request.parent?.parentJobId === job.request.jobId) this.cancelRecord(child, reason);
  }
  output(
    auth: AuthContext,
    node: ManifoldRef,
    offset: number,
    maxBytes: number,
    callerPluginId = "engine.jobs",
  ): Promise<Extract<JobEvent, { type: "output" }>> {
    const job = this.authorizedJob(auth, node, "jobs:read", callerPluginId);
    if (
      node.kind !== "output" ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > 65536
    )
      return Promise.reject(new Error("invalid_output_read"));
    const live = this.channels.get(job.request.machineId);
    if (!live?.proved || this.reads.size >= 64)
      return Promise.reject(new Error("output_unavailable"));
    const requestId = randomUUID();
    const { promise, resolve, reject } =
      Promise.withResolvers<Extract<JobEvent, { type: "output" }>>();
    const timer = setTimeout(() => {
      this.reads.delete(requestId);
      reject(new Error("output_timeout"));
    }, 5000);
    this.reads.set(requestId, {
      machineId: job.request.machineId,
      jobId: job.request.jobId,
      outputId: node.outputId,
      auth: structuredClone(auth),
      callerPluginId,
      node: structuredClone(node),
      resolve,
      reject,
      timer,
    });
    if (
      !live.channel.send({
        type: "job_command",
        command: {
          type: "output_read",
          jobId: job.request.jobId,
          outputId: node.outputId,
          requestId,
          offset,
          maxBytes,
        },
      })
    ) {
      clearTimeout(timer);
      this.reads.delete(requestId);
      reject(new Error("output_unavailable"));
    }
    return promise;
  }
  disablePlugin(pluginId: string): void {
    this.store.db
      .query("UPDATE machine_job_installs SET enabled=0 WHERE plugin_id=?")
      .run(pluginId);
    for (const job of this.jobs.active())
      if (job.request.pluginId === pluginId) this.cancelRecord(job, "plugin_disabled");
    for (const install of this.jobs.installations())
      if (install.pluginId === pluginId) this.sendInstall(install);
    for (const follower of this.followers)
      if (this.jobs.get(follower.node.jobId)?.request.pluginId === pluginId)
        this.closeFollower(follower, "authority_revoked");
  }
  purgePlugin(pluginId: string): void {
    for (const liveJob of this.jobs.active()) {
      let ancestor: JobRecord | null = liveJob;
      for (let depth = 0; ancestor !== null && depth <= 64; depth++) {
        if (ancestor.request.pluginId === pluginId) fail("active_leases");
        ancestor = ancestor.request.parent
          ? this.jobs.get(ancestor.request.parent.parentJobId)
          : null;
      }
      if (ancestor !== null) fail("invocation_depth_invalid");
    }
    const installs = this.jobs.installations().filter((i) => i.pluginId === pluginId);
    if (installs.some((i) => i.enabled)) fail("disable_before_purge");
    for (const install of installs)
      if (!this.channels.get(install.machineId)?.proved) fail("owner_offline");
    this.store.db
      .query("UPDATE machine_job_outputs SET released=1 WHERE plugin_id=?")
      .run(pluginId);
    this.store.db
      .query("UPDATE machine_job_installs SET purge_requested=1,ready=0 WHERE plugin_id=?")
      .run(pluginId);
    for (const [jobId, ring] of this.replay)
      if (this.jobs.get(jobId)?.request.pluginId === pluginId) {
        this.replay.delete(jobId);
        this.replayBytes -= ring.bytes;
      }
    for (const install of installs)
      this.channels.get(install.machineId)!.channel.send({
        type: "job_command",
        command: {
          type: "install",
          action: "purge",
          pluginId,
          installationRevision: install.revision,
          artifactSha256: install.artifact,
          machine: install.machine,
        },
      });
  }
}
