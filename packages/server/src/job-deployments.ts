import { createHash } from "node:crypto";
import {
  canonicalJobJson,
  formatManifoldUri,
  parseManifoldUri,
  jobResourceRequirements,
  MachineHalfSchema,
  JobDeploymentRequestSchema,
  JobDeploymentApplyArgsSchema,
  JobDeploymentReadArgsSchema,
  JobDeploymentListArgsSchema,
  JobDeploymentCancelArgsSchema,
  JobDeploymentDescribeArgsSchema,
  type JobDeployment,
  type JobDeploymentReview,
  type JobDeploymentRequest,
  type JobDeploymentTargetReview,
  type JobDeploymentTargetStatus,
  type JobDeploymentDescription,
  type JobResourceBindings,
  type JobOwner,
  type MachineHalf,
  type Cap,
} from "@manifold/protocol";
import type { z } from "zod";
import {
  ServiceError,
  type AuthContext,
  type CredentialReference,
  type AuthorityRequirement,
} from "./auth.ts";
import type { JobService } from "./job-service.ts";
import type { JobInstallation, JobAuditOrigin } from "./job-store.ts";
import type { TraceRecord } from "./stores.ts";

const digest = (value: unknown): string =>
  createHash("sha256").update(canonicalJobJson(value)).digest("hex");
const groups = ["tools", "services", "anchors"] as const;
// Bound retained reviewed payloads. Empty approvals are compact, permanent retired-ID fences.
// These small identity fences are intentionally unbounded; pruning them would permit replay.
const MAX_APPROVALS = 256;
type Phase = "pending" | "applying" | "applied" | "needs_review" | "cancelled";
interface TargetEvidence {
  identity: string;
  installation: string;
  consents: string;
  authority: string;
  resources: string;
}
interface Approval {
  review: JobDeploymentReview;
  credential: CredentialReference;
  evidence: TargetEvidence[];
  traceId: string;
  origin: JobAuditOrigin | null;
}
interface StoredApproval {
  deployment_id: string;
  revision: number;
  approved_at: number;
  cancelled: number;
  approval: string; // Empty only after terminal review retention; never parse a retired ID.
}
interface TargetRecord {
  machine_id: string;
  phase: Phase;
  attempt: string | null;
  reason: string | null;
  receipt: string | null;
}
interface NativeDeploymentHost {
  owner(machineId: string): JobOwner | null;
  artifactAvailable(install: JobInstallation, platform: keyof MachineHalf["artifacts"]): boolean;
  resourceRefusal(install: JobInstallation, operationId: string): string | null;
  servicePolicies(
    machineId: string,
    machine: MachineHalf,
    bindings: JobResourceBindings | null,
  ): { digest: string; refusal: string | null };
  record(record: TraceRecord): void;
  changed(): void;
}
function conflict(reason: string): never {
  throw new ServiceError("conflict", reason);
}

/** Retains reviewed authority until application; native installation/consent rows own all effects. */
export class JobDeployments {
  private processing = false;
  constructor(
    private readonly service: JobService,
    private readonly host: NativeDeploymentHost,
  ) {}

  private root(auth: AuthContext): AuthContext {
    const current = this.service.auth.restoreCredential(
      this.service.auth.credentialReference(auth),
    );
    if (!current?.isRoot) throw new ServiceError("forbidden", "deployment_admin_required");
    return current;
  }
  private get(deploymentId: string): StoredApproval | null {
    return this.service.store.db
      .query<StoredApproval, [string]>(
        "SELECT * FROM machine_job_deployments WHERE deployment_id=?",
      )
      .get(deploymentId);
  }
  private targets(deploymentId: string): TargetRecord[] {
    return this.service.store.db
      .query<TargetRecord, [string]>(
        "SELECT machine_id,phase,attempt,reason,receipt FROM machine_job_deployment_targets WHERE deployment_id=? ORDER BY rowid",
      )
      .all(deploymentId);
  }
  /** Runs inside admission's transaction, so a refused admission cannot discard history. */
  private retainApprovalCapacity(): void {
    let count = this.service.store.db
      .query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM machine_job_deployments WHERE approval<>''",
      )
      .get()!.count;
    if (count < MAX_APPROVALS) return;
    const candidates = this.service.store.db
      .query<{ deployment_id: string }, []>(
        `SELECT d.deployment_id FROM machine_job_deployments d
       WHERE d.approval<>'' AND NOT EXISTS (
         SELECT 1 FROM machine_job_deployment_targets t WHERE t.deployment_id=d.deployment_id
         AND (t.phase IN ('pending','applying') OR t.reason='deployment_application_uncertain')
       ) ORDER BY d.approved_at,d.rowid`,
      )
      .all();
    for (const candidate of candidates) {
      const row = this.get(candidate.deployment_id)!;
      // Applied is a durable receipt, not completion: an owner may still owe its install ACK.
      if (
        !this.project(row).targets.every(
          (target) =>
            target.state === "ready" ||
            target.state === "superseded" ||
            target.state === "cancelled" ||
            target.state === "needs_review",
        )
      )
        continue;
      this.service.store.db
        .query("DELETE FROM machine_job_deployment_targets WHERE deployment_id=?")
        .run(row.deployment_id);
      // Keep only the small identity fence, not the reviewed authority or its target payloads.
      this.service.store.db
        .query("UPDATE machine_job_deployments SET approval='' WHERE deployment_id=?")
        .run(row.deployment_id);
      if (--count < MAX_APPROVALS) return;
    }
    conflict("deployment_capacity");
  }
  private identity(machineId: string): string {
    const machine = this.service.store.getMachine(machineId);
    const token = machine && this.service.store.getToken(machine.tokenId);
    const owner = this.service.jobs.owner(machineId);
    return digest({
      machine: machine && {
        id: machine.id,
        tokenId: machine.tokenId,
        ownerHostId: machine.ownerHostId,
      },
      token: token && {
        principalId: token.principalId,
        grantId: token.grantId,
        caps: token.caps,
        revokedAt: token.revokedAt,
        expiresAt: token.expiresAt,
      },
      owner,
    });
  }
  private installation(install: JobInstallation | null): string {
    if (!install) return digest(null);
    const scope: Partial<JobInstallation> = { ...install };
    delete scope.ready;
    return digest(scope);
  }
  private rights(request: JobDeploymentRequest, machineId: string) {
    const machine = this.service.declaredMachine(request.pluginId);
    if (!machine) conflict("manifest_declaration_unavailable");
    const rights = new Map<string, { node: string; cap: Cap }>();
    const add = (node: string, cap: Cap) => rights.set(`${node}/${cap}`, { node, cap });
    for (const operationId of request.operationIds) {
      const operation = machine.operations[operationId];
      if (!operation) conflict("unknown_operation");
      const node = formatManifoldUri({ kind: "operation", machineId, operationId });
      // The existing runtime inspector's exact operation rights, never a wildcard consent.
      for (const cap of ["machines:run", "jobs:read", "jobs:cancel", "operations:invoke"] as const)
        add(node, cap);
      if (operation.stdin) add(node, "jobs:input");
      if (operation.network === "host") add(node, "network:host");
      for (const location of operation.locations)
        add(
          formatManifoldUri({ kind: "location", machineId, locationId: location.locationId }),
          `locations:${location.access}`,
        );
    }
    return [...rights.values()].sort(
      (a, b) => a.node.localeCompare(b.node) || a.cap.localeCompare(b.cap),
    );
  }
  private consents(
    request: JobDeploymentRequest,
    machineId: string,
    revision: string | null,
    artifact: string | null,
  ) {
    return this.rights(request, machineId).map(({ node, cap }) => {
      const row = this.service.store.db
        .query<
          { revision: string; enabled: number; artifact: string },
          [string, string, string | null, string, string]
        >(
          "SELECT revision,enabled,artifact FROM machine_job_consents WHERE machine_id=? AND plugin_id=? AND installation_revision=? AND node=? AND cap=?",
        )
        .get(machineId, request.pluginId, revision, node, cap);
      return {
        node,
        cap,
        approved: row?.enabled === 1 && row.artifact === artifact,
        revision: row?.revision ?? null,
      };
    });
  }
  private authority(auth: AuthContext, request: JobDeploymentRequest, machineId: string): string {
    const requirements: AuthorityRequirement[] = [
      { cap: "machines:run" as const, ref: { kind: "machine" as const, machineId } },
      ...this.rights(request, machineId).map(({ node, cap }) => ({
        cap: cap as Exclude<Cap, "*">,
        ref: parseManifoldUri(node)!,
      })),
    ];
    const machine = this.service.declaredMachine(request.pluginId)!;
    for (const operationId of request.operationIds)
      for (const binding of machine.operations[operationId]!.services ?? [])
        for (const serviceOperationId of binding.operationIds)
          requirements.push({
            cap: "services:invoke",
            ref: {
              kind: "service",
              machineId,
              serviceId: binding.serviceId,
              operationId: serviceOperationId,
            },
          });
    const evidence = requirements.map((requirement) =>
      this.service.auth.explain(auth, requirement),
    );
    if (evidence.some((item) => !item.allowed))
      throw new ServiceError("forbidden", "deployment_authority_refused");
    return digest(evidence);
  }
  private evidence(
    auth: AuthContext,
    request: JobDeploymentRequest,
    target: JobDeploymentTargetReview,
  ): TargetEvidence {
    const current = this.service.jobs.installation(target.machineId, request.pluginId);
    return {
      identity: this.identity(target.machineId),
      installation: this.installation(current),
      consents: digest([
        this.consents(
          request,
          target.machineId,
          target.installationRevision,
          target.artifactSha256,
        ),
        this.consents(
          request,
          target.machineId,
          current?.revision ?? null,
          current?.artifact ?? null,
        ),
      ]),
      authority: this.authority(auth, request, target.machineId),
      resources: this.host.servicePolicies(
        target.machineId,
        this.service.declaredMachine(request.pluginId)!,
        target.resourceBindings,
      ).digest,
    };
  }
  private snapshot(auth: AuthContext, request: JobDeploymentRequest) {
    const declaration = this.service.declaredMachine(request.pluginId);
    if (!declaration) conflict("manifest_declaration_unavailable");
    const machine = MachineHalfSchema.parse(declaration);
    // Reject malformed names/operation selection before offering any approval.
    this.rights(request, request.targets[0]!.machineId);
    const declarationSha256 = digest(machine);
    const targets = request.targets.map(
      ({ machineId, platform: selected }): JobDeploymentTargetReview => {
        const destination = this.service.store.getMachine(machineId);
        const token = destination && this.service.store.getToken(destination.tokenId);
        const owner = this.host.owner(machineId);
        const current = this.service.jobs.installation(machineId, request.pluginId);
        const pinnedOwner = this.service.jobs.owner(machineId);
        const candidates = Object.keys(machine.artifacts) as (keyof typeof machine.artifacts)[];
        const platform =
          selected ??
          candidates.find((value) => owner?.platforms.includes(value)) ??
          candidates.find((value) => machine.artifacts[value]?.sha256 === current?.artifact) ??
          null;
        const artifactSha256 = platform ? (machine.artifacts[platform]?.sha256 ?? null) : null;
        let reason: string | null =
          !destination ||
          !token ||
          token.revokedAt !== null ||
          (token.expiresAt !== null && token.expiresAt <= this.service.runtime.now())
            ? "executor_revoked_or_unknown"
            : this.service.store.disabledPlugins().has(request.pluginId)
              ? "plugin_disabled"
              : !pinnedOwner
                ? "owner_identity_unproved"
                : !platform || !artifactSha256 || (owner && !owner.platforms.includes(platform))
                  ? "installation_platform_unavailable"
                  : null;
        const resources: JobDeploymentTargetReview["resources"] = [];
        const bindings: JobResourceBindings = { tools: {}, services: {}, anchors: {} };
        // Disconnected review can reuse only immutable already-promoted native pins.
        const known = owner ? owner.resources : current?.resourceBindings;
        if (platform) {
          for (const operationId of Object.keys(machine.operations)) {
            const required = jobResourceRequirements(machine, operationId, platform);
            for (const group of groups)
              for (const name of required[group]) {
                if (
                  resources.some((resource) => resource.group === group && resource.name === name)
                )
                  continue;
                const sha256 = known?.[group][name] ?? null;
                resources.push({ group, name, sha256 });
                if (sha256) bindings[group][name] = sha256;
                else reason ??= "resource_evidence_unknown";
              }
          }
        }
        resources.sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
        const needsBindings =
          machine.requiresResourceBindings ||
          resources.length > 0 ||
          Object.values(machine.operations).some((operation) => operation.services?.length);
        const resourceBindings = needsBindings ? bindings : null;
        const same =
          current &&
          digest(current.machine) === declarationSha256 &&
          current.artifact === artifactSha256 &&
          digest(current.resourceBindings ?? null) === digest(resourceBindings);
        const installationRevision = !artifactSha256
          ? null
          : same
            ? current.revision
            : `deployment-${digest({ deploymentId: request.deploymentId, machineId, declarationSha256, artifactSha256, resourceBindings })}`;
        const proposed: JobInstallation | null =
          artifactSha256 && installationRevision
            ? {
                machineId,
                pluginId: request.pluginId,
                revision: installationRevision,
                artifact: artifactSha256,
                machine,
                ...(resourceBindings ? { resourceBindings } : {}),
                enabled: true,
                ready: false,
                purgeRequested: false,
              }
            : null;
        if (proposed && platform) {
          try {
            reason ??= this.host.servicePolicies(machineId, machine, resourceBindings).refusal;
            if (!this.host.artifactAvailable(proposed, platform))
              reason ??= "artifact_bundle_unavailable";
            if (owner)
              for (const operationId of Object.keys(machine.operations))
                reason ??= this.host.resourceRefusal(proposed, operationId);
          } catch (error) {
            if (!(error instanceof ServiceError)) throw error;
            reason ??= error.message;
          }
        }
        const busy = this.busy(machineId, request.pluginId);
        return {
          machineId,
          machineName: destination?.name ?? machineId,
          connected: owner !== null,
          platform,
          artifactSha256,
          expectedInstallationRevision: current?.revision ?? null,
          installationRevision,
          resourceBindings,
          resources,
          consents: this.consents(request, machineId, installationRevision, artifactSha256),
          approvable: reason === null,
          reason:
            reason ?? (busy ? "active_installation" : owner === null ? "owner_offline" : null),
        };
      },
    );
    const evidence = targets.map((target) => this.evidence(auth, request, target));
    const body = {
      request,
      machine,
      declarationSha256,
      targets,
      approvable: targets.every((target) => target.approvable),
    };
    const review: JobDeploymentReview = {
      ...body,
      reviewDigest: digest({
        ...body,
        evidence,
        credential: this.service.auth.credentialReference(auth),
      }),
    };
    return { review, evidence };
  }
  review(auth: AuthContext, args: JobDeploymentRequest): JobDeploymentReview {
    return this.service.store.transaction(() => {
      const current = this.root(auth);
      const request = JobDeploymentRequestSchema.parse(args);
      if (this.get(request.deploymentId)?.approval === "") conflict("deployment_id_retired");
      return this.snapshot(current, request).review;
    });
  }
  apply(
    auth: AuthContext,
    args: z.infer<typeof JobDeploymentApplyArgsSchema>,
    traceId: string,
  ): JobDeployment {
    const current = this.root(auth);
    const parsed = JobDeploymentApplyArgsSchema.parse(args);
    this.service.store.transaction(() => {
      const prior = this.get(parsed.request.deploymentId);
      if (prior) {
        if (prior.approval === "") conflict("deployment_id_retired");
        const approval = JSON.parse(prior.approval) as Approval;
        if (
          approval.review.reviewDigest !== parsed.reviewDigest ||
          digest(approval.review.request) !== digest(parsed.request) ||
          digest(approval.credential) !== digest(this.service.auth.credentialReference(current))
        )
          conflict("deployment_id_conflict");
        return;
      }
      const snapshot = this.snapshot(current, parsed.request);
      if (snapshot.review.reviewDigest !== parsed.reviewDigest) conflict("deployment_review_stale");
      if (!snapshot.review.approvable) conflict("deployment_unapprovable");
      this.retainApprovalCapacity();
      for (const target of snapshot.review.targets) {
        const competing = this.service.store.db
          .query<{ deployment_id: string }, [string, string]>(
            "SELECT deployment_id FROM machine_job_deployment_targets WHERE machine_id=? AND plugin_id=? AND phase IN ('pending','applying') LIMIT 1",
          )
          .get(target.machineId, parsed.request.pluginId);
        if (competing) conflict("deployment_target_pending");
      }
      const approval: Approval = {
        ...snapshot,
        credential: this.service.auth.credentialReference(current),
        traceId,
        origin: this.service.jobs.dispatchOrigin(traceId),
      };
      this.service.store.db
        .query(
          "INSERT INTO machine_job_deployments(deployment_id,plugin_id,revision,approved_at,cancelled,approval) VALUES(?,?,1,?,0,?)",
        )
        .run(
          parsed.request.deploymentId,
          parsed.request.pluginId,
          this.service.runtime.now(),
          canonicalJobJson(approval),
        );
      for (const target of snapshot.review.targets)
        this.service.store.db
          .query(
            "INSERT INTO machine_job_deployment_targets(deployment_id,machine_id,plugin_id,phase) VALUES(?,?,?,'pending')",
          )
          .run(parsed.request.deploymentId, target.machineId, parsed.request.pluginId);
      this.service.store.afterCommit(() => this.host.changed());
    });
    this.reconcile();
    return this.read(current, { deploymentId: parsed.request.deploymentId });
  }
  private busy(machineId: string, pluginId: string): boolean {
    return this.service.jobs
      .reconcilable(machineId)
      .some(
        (job) =>
          job.request.pluginId === pluginId &&
          (["queued", "admitted", "start-committed", "started"].includes(job.state) ||
            (job.permit !== null && !job.ownerClosed)),
      );
  }
  private refusal(
    approval: Approval,
    target: JobDeploymentTargetReview,
    index: number,
    applied: boolean,
  ): string | null {
    const auth = this.service.auth.restoreCredential(approval.credential);
    if (!auth?.isRoot) return "credential_revoked_or_expired";
    const request = approval.review.request;
    if (
      digest(this.service.declaredMachine(request.pluginId)) !== approval.review.declarationSha256
    )
      return "manifest_declaration_changed";
    if (this.service.store.disabledPlugins().has(request.pluginId)) return "plugin_disabled";
    if (this.identity(target.machineId) !== approval.evidence[index]!.identity)
      return "destination_identity_changed";
    const destination = this.service.store.getMachine(target.machineId);
    const token = destination && this.service.store.getToken(destination.tokenId);
    if (
      !token ||
      token.revokedAt !== null ||
      (token.expiresAt !== null && token.expiresAt <= this.service.runtime.now())
    )
      return "executor_revoked_or_expired";
    try {
      if (this.authority(auth, request, target.machineId) !== approval.evidence[index]!.authority)
        return "authority_changed";
      if (
        !applied &&
        digest(this.evidence(auth, request, target)) !== digest(approval.evidence[index])
      )
        return "deployment_scope_changed";
      const install = this.proposed(approval, target);
      const policies = this.host.servicePolicies(
        target.machineId,
        install.machine,
        target.resourceBindings,
      );
      if (policies.refusal) return policies.refusal;
      if (policies.digest !== approval.evidence[index]!.resources)
        return "service_definition_changed";
      if (!target.platform || !this.host.artifactAvailable(install, target.platform))
        return "artifact_bundle_unavailable";
      const owner = this.host.owner(target.machineId);
      if (owner) {
        if (!owner.platforms.includes(target.platform)) return "installation_platform_unavailable";
        if (target.resourceBindings)
          for (const group of groups)
            for (const [name, hash] of Object.entries(target.resourceBindings[group]))
              if (owner.resources?.[group][name] !== hash) return "resource_revision_changed";
        for (const operationId of Object.keys(install.machine.operations)) {
          const refusal = this.host.resourceRefusal(install, operationId);
          if (refusal) return refusal;
        }
      }
    } catch (error) {
      if (!(error instanceof ServiceError)) throw error;
      return error.message;
    }
    return null;
  }
  private proposed(approval: Approval, target: JobDeploymentTargetReview): JobInstallation {
    if (!target.installationRevision || !target.artifactSha256) conflict("deployment_unapprovable");
    return {
      machineId: target.machineId,
      pluginId: approval.review.request.pluginId,
      revision: target.installationRevision,
      artifact: target.artifactSha256,
      machine: approval.review.machine,
      ...(target.resourceBindings ? { resourceBindings: target.resourceBindings } : {}),
      enabled: true,
      ready: false,
      purgeRequested: false,
    };
  }
  private lifecycle(
    approval: Approval,
    target: JobDeploymentTargetReview,
    phase: string,
    reason: string | null,
  ): void {
    this.host.record({
      actor: approval.origin?.actor ?? approval.credential.principalId,
      authority: approval.origin?.authority ?? "root",
      door: approval.origin?.door ?? "engine.jobs.applyDeployment",
      containerId: approval.origin?.containerId ?? approval.credential.containerScope,
      session: approval.origin?.session ?? null,
      ts: this.service.runtime.now(),
      outcome: phase === "needs_review" ? "forbidden" : "ok",
      targets: [],
      payload: {
        deploymentLifecycle: phase,
        parentTrace: approval.traceId,
        originTraceAvailable: approval.origin !== null,
        deploymentId: approval.review.request.deploymentId,
        machineId: target.machineId,
        pluginId: approval.review.request.pluginId,
        installationRevision: target.installationRevision,
        artifactSha256: target.artifactSha256,
        reviewDigest: approval.review.reviewDigest,
        reason,
      },
    });
  }
  private transition(
    approval: Approval,
    target: JobDeploymentTargetReview,
    from: Phase,
    to: Phase,
    reason: string | null,
  ): boolean {
    const id = approval.review.request.deploymentId;
    const changed =
      this.service.store.db
        .query(
          "UPDATE machine_job_deployment_targets SET phase=?,reason=? WHERE deployment_id=? AND machine_id=? AND phase=?",
        )
        .run(to, reason, id, target.machineId, from).changes === 1;
    if (changed) {
      this.lifecycle(approval, target, to, reason);
      this.service.store.db
        .query("UPDATE machine_job_deployments SET revision=revision+1 WHERE deployment_id=?")
        .run(id);
      this.service.store.afterCommit(() => this.host.changed());
    }
    return changed;
  }
  /** Called only after native trace recording is installed. Never replay an interrupted effect. */
  recover(): void {
    for (const row of this.service.store.db
      .query<StoredApproval, []>(
        "SELECT DISTINCT d.* FROM machine_job_deployments d JOIN machine_job_deployment_targets t USING(deployment_id) WHERE t.phase='applying'",
      )
      .all()) {
      const approval = JSON.parse(row.approval) as Approval;
      for (const target of approval.review.targets)
        this.service.store.transaction(() =>
          this.transition(
            approval,
            target,
            "applying",
            "needs_review",
            "deployment_application_uncertain",
          ),
        );
    }
  }
  reconcile(): void {
    if (this.processing) return;
    this.processing = true;
    try {
      const rows = this.service.store.db
        .query<StoredApproval, []>(
          "SELECT DISTINCT d.* FROM machine_job_deployments d JOIN machine_job_deployment_targets t USING(deployment_id) WHERE d.cancelled=0 AND t.phase='pending' ORDER BY d.rowid",
        )
        .all();
      for (const row of rows) {
        const approval = JSON.parse(row.approval) as Approval;
        for (const [index, target] of approval.review.targets.entries()) {
          const attempt = this.service.runtime.newId();
          const claimed = this.service.store.transaction(() => {
            if (
              this.get(row.deployment_id)?.cancelled ||
              this.targets(row.deployment_id).find((item) => item.machine_id === target.machineId)
                ?.phase !== "pending"
            )
              return false;
            const reason = this.refusal(approval, target, index, false);
            if (reason) {
              this.transition(approval, target, "pending", "needs_review", reason);
              return false;
            }
            if (
              !this.host.owner(target.machineId) ||
              this.busy(target.machineId, approval.review.request.pluginId) ||
              this.service.store.getMachine(target.machineId)?.draining
            )
              return false;
            if (!this.transition(approval, target, "pending", "applying", null)) return false;
            this.service.store.db
              .query(
                "UPDATE machine_job_deployment_targets SET attempt=? WHERE deployment_id=? AND machine_id=? AND phase='applying'",
              )
              .run(attempt, row.deployment_id, target.machineId);
            return true;
          });
          if (!claimed) continue;
          try {
            this.service.store.transaction(() => {
              const retained = this.targets(row.deployment_id).find(
                (item) => item.machine_id === target.machineId,
              );
              if (
                this.get(row.deployment_id)?.cancelled ||
                retained?.phase !== "applying" ||
                retained.attempt !== attempt
              )
                return;
              const reason = this.refusal(approval, target, index, false);
              if (
                reason ||
                !this.host.owner(target.machineId) ||
                this.busy(target.machineId, approval.review.request.pluginId) ||
                this.service.store.getMachine(target.machineId)?.draining
              )
                conflict(reason ?? "deployment_application_unavailable");
              const auth = this.service.auth.restoreCredential(approval.credential)!;
              const proposed = this.proposed(approval, target);
              const current = this.service.jobs.installation(target.machineId, proposed.pluginId);
              if (this.installation(current) !== this.installation(proposed))
                this.service.install(auth, {
                  machineId: target.machineId,
                  pluginId: proposed.pluginId,
                  installationRevision: proposed.revision,
                  artifactSha256: proposed.artifact,
                  machine: proposed.machine,
                  resourceBindings: proposed.resourceBindings,
                });
              for (const consent of target.consents)
                if (!consent.approved)
                  this.service.consent(auth, {
                    machineId: target.machineId,
                    pluginId: proposed.pluginId,
                    installationRevision: proposed.revision,
                    artifactSha256: proposed.artifact,
                    node: consent.node,
                    cap: consent.cap,
                    enabled: true,
                  });
              // Native rows and this receipt commit together, before any install command is sent.
              const receipt = digest(
                this.consents(
                  approval.review.request,
                  target.machineId,
                  proposed.revision,
                  proposed.artifact,
                ),
              );
              this.service.store.db
                .query(
                  "UPDATE machine_job_deployment_targets SET receipt=? WHERE deployment_id=? AND machine_id=? AND phase='applying' AND attempt=?",
                )
                .run(receipt, row.deployment_id, target.machineId, attempt);
              this.transition(approval, target, "applying", "applied", null);
            });
          } catch (error) {
            // A post-commit transport error cannot erase the durable effect receipt.
            this.service.store.transaction(() =>
              this.transition(
                approval,
                target,
                "applying",
                "needs_review",
                error instanceof ServiceError ? error.message : "deployment_application_uncertain",
              ),
            );
            if (!(error instanceof ServiceError)) throw error;
          }
        }
      }
    } finally {
      this.processing = false;
    }
  }
  private project(row: StoredApproval): JobDeployment {
    const approval = JSON.parse(row.approval) as Approval;
    const request = approval.review.request;
    const records = this.targets(row.deployment_id);
    const targets = approval.review.targets.map((target, index): JobDeploymentTargetStatus => {
      const connected = this.host.owner(target.machineId) !== null;
      const result = (
        state: JobDeploymentTargetStatus["state"],
        reason: string | null,
      ): JobDeploymentTargetStatus => ({ machineId: target.machineId, connected, state, reason });
      const record = records.find((item) => item.machine_id === target.machineId)!;
      if (record.phase === "cancelled") return result("cancelled", record.reason);
      if (record.phase === "needs_review") return result("needs_review", record.reason);
      if (record.phase === "applying")
        return result("needs_review", "deployment_application_uncertain");
      const current = this.service.jobs.installation(target.machineId, request.pluginId);
      if (record.phase === "applied" && current?.revision !== target.installationRevision)
        return result("superseded", "installation_replaced");
      const refusal = this.refusal(approval, target, index, record.phase === "applied");
      if (refusal) return result("needs_review", refusal);
      if (record.phase === "pending")
        return result(
          "pending",
          !connected
            ? "owner_offline"
            : this.service.store.getMachine(target.machineId)?.draining
              ? "machine_draining"
              : this.busy(target.machineId, request.pluginId)
                ? "active_installation"
                : null,
        );
      const desired = this.proposed(approval, target);
      if (this.installation(current) !== this.installation(desired))
        return result("needs_review", "installation_changed");
      if (
        record.receipt !==
        digest(
          this.consents(
            request,
            target.machineId,
            target.installationRevision,
            target.artifactSha256,
          ),
        )
      )
        return result("needs_review", "consent_changed");
      if (!connected) return result("installing", "owner_offline");
      const auth = this.service.auth.restoreCredential(approval.credential)!;
      const description = this.service.describe(auth, {
        machineId: target.machineId,
        pluginId: request.pluginId,
      });
      if (!description.installation?.ready)
        return result("installing", "owner_acknowledgement_pending");
      for (const operationId of request.operationIds) {
        const operation = description.operations?.[operationId];
        if (!operation?.ready)
          return result("needs_review", operation?.reason ?? "unknown_operation");
      }
      return result("ready", null);
    });
    return {
      deploymentId: row.deployment_id,
      pluginId: request.pluginId,
      revision: row.revision,
      approvedBy: approval.credential.principalId,
      approvedAt: row.approved_at,
      cancelled: row.cancelled === 1,
      review: approval.review,
      targets,
    };
  }
  read(auth: AuthContext, args: z.infer<typeof JobDeploymentReadArgsSchema>): JobDeployment {
    this.root(auth);
    const row = this.get(JobDeploymentReadArgsSchema.parse(args).deploymentId);
    if (!row || row.approval === "") throw new ServiceError("not_found", "deployment_not_found");
    return this.project(row);
  }
  list(auth: AuthContext, args: z.infer<typeof JobDeploymentListArgsSchema>) {
    this.root(auth);
    const { pluginId, limit } = JobDeploymentListArgsSchema.parse(args);
    return {
      deployments: this.service.store.db
        .query<StoredApproval, [string, number]>(
          "SELECT * FROM machine_job_deployments WHERE plugin_id=? AND approval<>'' ORDER BY rowid DESC LIMIT ?",
        )
        .all(pluginId, limit)
        .map((row) => this.project(row)),
    };
  }
  cancel(auth: AuthContext, args: z.infer<typeof JobDeploymentCancelArgsSchema>): JobDeployment {
    this.root(auth);
    const { deploymentId, expectedRevision } = JobDeploymentCancelArgsSchema.parse(args);
    this.service.store.transaction(() => {
      const row = this.get(deploymentId);
      if (!row || row.approval === "") throw new ServiceError("not_found", "deployment_not_found");
      if (row.revision !== expectedRevision) conflict("deployment_revision_stale");
      if (row.cancelled) return;
      this.service.store.db
        .query(
          "UPDATE machine_job_deployments SET cancelled=1,revision=revision+1 WHERE deployment_id=? AND revision=?",
        )
        .run(deploymentId, expectedRevision);
      const approval = JSON.parse(row.approval) as Approval;
      for (const target of approval.review.targets) {
        this.transition(approval, target, "pending", "cancelled", "approval_cancelled");
        this.transition(approval, target, "applying", "cancelled", "approval_cancelled");
      }
      this.service.store.afterCommit(() => this.host.changed());
    });
    return this.read(auth, { deploymentId });
  }
  describe(
    auth: AuthContext,
    args: z.infer<typeof JobDeploymentDescribeArgsSchema>,
    callerPluginId: string,
  ): JobDeploymentDescription {
    const parsed = JobDeploymentDescribeArgsSchema.parse(args);
    // Reuse the exact current credential, target and caller-plugin check, including on absence.
    this.service.describe(auth, parsed, callerPluginId);
    const current = this.service.jobs.installation(parsed.machineId, parsed.pluginId);
    const installation = current
      ? {
          revision: current.revision,
          artifactSha256: current.artifact,
          machine: current.machine,
        }
      : null;
    const row = this.service.store.db
      .query<StoredApproval, [string, string]>(
        "SELECT d.* FROM machine_job_deployments d JOIN machine_job_deployment_targets t USING(deployment_id) WHERE d.plugin_id=? AND t.machine_id=? AND d.approval<>'' ORDER BY d.rowid DESC LIMIT 1",
      )
      .get(parsed.pluginId, parsed.machineId);
    if (!row) return { deployment: null, installation };
    const result = this.project(row);
    const target = result.targets.find((target) => target.machineId === parsed.machineId)!;
    return {
      installation,
      deployment: {
        deploymentId: result.deploymentId,
        machineId: parsed.machineId,
        pluginId: parsed.pluginId,
        revision: result.revision,
        state: target.state,
        reason: target.reason,
      },
    };
  }
}
