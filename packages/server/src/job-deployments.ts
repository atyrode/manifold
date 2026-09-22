import { createHash } from "node:crypto";
import {
  canonicalJobJson,
  formatManifoldUri,
  isOperatorAnchor,
  parseManifoldUri,
  jobResourceRequirements,
  jobResourceBindingsFor,
  MachineHalfSchema,
  ServicePolicySchema,
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
  type JobInvocationEdge,
  type JobDeploymentInvocationEdge,
  type JobDeploymentInstanceService,
  type JobOwner,
  type MachineHalf,
  type ServicePolicy,
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
/**
 * A target's durable position in one approval.
 *
 * `quiescing` and `configuring` exist only for a reviewed instance-service bootstrap, and they
 * are separate phases rather than steps inside `applying` because they bracket different kinds
 * of effect. Quiescing stops exactly the reviewed provider workload and then waits for the
 * owner to give up its lifetime: repeating it is an observation, never a second stop.
 * Configuring mints a credential and admits a provider job, so an interrupted attempt is
 * exactly as uncertain as an interrupted installation and recovers the same way.
 */
type Phase =
  | "pending"
  | "quiescing"
  | "applying"
  | "applied"
  | "configuring"
  | "bound"
  | "needs_review"
  | "cancelled";
interface TargetEvidence {
  identity: string;
  installation: string;
  consents: string;
  authority: string;
  resources: string;
  invocations: string;
  invocationApprovals: string;
  /** Prior record identity and proposed policy; never the volatile workload it will stop. */
  instanceServices: string;
}
interface TargetReceipt {
  consents: string;
  invocationEdges: string;
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
/** The instance-service record identity a proposal replaces. */
interface DeploymentInstanceService {
  machineId: string;
  pluginId: string;
  revision: string;
  enabled: boolean;
  policySha256: string;
  jobId: string | null;
}
interface NativeDeploymentHost {
  owner(machineId: string): JobOwner | null;
  artifactAvailable(install: JobInstallation, platform: keyof MachineHalf["artifacts"]): boolean;
  resourceRefusal(
    install: JobInstallation,
    operationId: string,
    invocationEdges: readonly JobInvocationEdge[],
    selectedOperationIds: readonly string[],
    instanceServices: readonly ServicePolicy[],
  ): string | null;
  invocations(
    auth: AuthContext,
    install: JobInstallation,
    operationIds: readonly string[],
    plannedConsents: readonly { node: string; cap: Cap }[],
    instanceServices: readonly ServicePolicy[],
  ): { edges: JobDeploymentInvocationEdge[]; digest: string; refusal: string | null };
  servicePolicies(
    machineId: string,
    machine: MachineHalf,
    bindings: JobResourceBindings | null,
    operationIds: readonly string[],
    instanceServices: readonly ServicePolicy[],
  ): { digest: string; refusal: string | null };
  /** Which bound service this plugin provides itself and has no installation for yet. */
  selfProvidedServiceRefusal(
    machineId: string,
    pluginId: string,
    machine: MachineHalf,
    operationIds: readonly string[],
    proposedServiceIds: readonly string[],
  ): string | null;
  instanceService(serviceId: string): DeploymentInstanceService | null;
  /** Provider jobs that still own a lifetime for this service, settled or not. */
  instanceServiceWorkload(serviceId: string): string[];
  /** Machine-state refusal for one proposed provider, evaluated without any effect. */
  instanceServiceRefusal(
    install: JobInstallation,
    policy: ServicePolicy,
    operationId: string,
    input: Record<string, string | number | boolean>,
  ): string | null;
  /** Stops exactly one reviewed provider workload; true once nothing owns its lifetime. */
  quiesceInstanceService(serviceId: string, jobId: string): boolean;
  configureInstanceService(
    auth: AuthContext,
    args: {
      serviceId: string;
      expectedRevision: string | null;
      machineId: string;
      policy: ServicePolicy;
      enabled: boolean;
    },
    traceId: string,
  ): void;
  /** Whether the owner has acknowledged this exact installation. */
  installed(machineId: string, pluginId: string, revision: string): boolean;
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
    if (current === null || !this.service.auth.holdsRoot(current))
      throw new ServiceError("forbidden", "deployment_admin_required");
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
         AND (t.phase IN ('pending','quiescing','applying','configuring') OR t.reason='deployment_application_uncertain')
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
    // Configuring an instance service is its own authority at the destination, rechecked from
    // the retained credential on every later transition rather than carried by the approval.
    if (request.instanceServices?.length)
      requirements.push({
        cap: "services:configure",
        ref: { kind: "machine", machineId },
      });
    const evidence = requirements.map((requirement) =>
      this.service.auth.explain(auth, requirement),
    );
    if (evidence.some((item) => !item.allowed))
      throw new ServiceError("forbidden", "deployment_authority_refused");
    return digest(evidence);
  }
  private invocationEdges(target: JobDeploymentTargetReview): JobDeploymentInvocationEdge[] {
    return target.invocationEdges.map(({ edge }) => {
      const row = this.service.store.db
        .query<{ edge: string; enabled: number; revision: string }, [string, string]>(
          "SELECT edge,enabled,revision FROM job_invocation_edges WHERE caller=? AND operation_id=?",
        )
        .get(canonicalJobJson(edge.caller), edge.callee.operationId);
      return {
        edge,
        approved: row?.enabled === 1 && row.edge === canonicalJobJson(edge),
        revision: row?.revision ?? null,
      };
    });
  }
  private previousInvocationEdges(request: JobDeploymentRequest, current: JobInstallation | null) {
    if (!current) return [];
    return request.operationIds.map((operationId) =>
      this.service.store.db
        .query<{ edge: string; enabled: number; revision: string }, [string]>(
          "SELECT edge,enabled,revision FROM job_invocation_edges WHERE caller=? ORDER BY operation_id",
        )
        .all(
          canonicalJobJson({
            machineId: current.machineId,
            pluginId: current.pluginId,
            operationId,
            installationRevision: current.revision,
            artifactSha256: current.artifact,
          }),
        ),
    );
  }
  /**
   * Declaration-level validation of the proposed instance services, independent of any machine.
   * These are properties of the request against the plugin's own manifest, so they refuse the
   * call outright instead of producing an unapprovable target an operator could not fix by
   * waiting: a provider that is not this plugin's, not selected, not a provider at all, a
   * service nothing declares a binding for, or a provider that depends on what it provides.
   */
  private declaredInstanceServices(
    request: JobDeploymentRequest,
    machine: MachineHalf,
  ): readonly NonNullable<JobDeploymentRequest["instanceServices"]>[number][] {
    const entries = request.instanceServices ?? [];
    const proposedIds = entries.map((entry) => entry.policy.serviceId);
    for (const entry of entries) {
      const operation = machine.operations[entry.operationId];
      if (!operation) conflict("unknown_operation");
      if (!operation.providesService) conflict("instance_service_provider_unsupported");
      if (!request.operationIds.includes(entry.operationId))
        conflict("instance_service_provider_unselected");
      if (
        !entry.policy.serviceId.startsWith(`${request.pluginId}.`) ||
        !Object.values(machine.operations).some((declared) =>
          declared.services?.some(
            (binding) =>
              binding.serviceId === entry.policy.serviceId &&
              binding.revision === entry.policy.revision,
          ),
        )
      )
        conflict("instance_service_binding_undeclared");
      if ((operation.services ?? []).some((binding) => proposedIds.includes(binding.serviceId)))
        conflict("instance_service_provider_cycle");
    }
    return entries;
  }
  /**
   * The concrete policies one target proposes, for a candidate installation revision.
   *
   * This is where #827's dependency cycle is actually broken. The runtime pin names the
   * installation the same request creates, so the revision is computed FIRST, from a pre-image
   * that contains the request's own instance-service entries but never the resolved policy's
   * digest; the policy then pins that revision, and only then does the promoted binding carry
   * the policy's digest. The provider operation's own binding digest is safe to take from the
   * base bindings because a provider that binds a proposed service is refused as a cycle.
   */
  private instancePolicies(
    request: JobDeploymentRequest,
    machine: MachineHalf,
    platform: keyof MachineHalf["artifacts"],
    artifactSha256: string,
    installationRevision: string,
    bindings: JobResourceBindings,
  ): ServicePolicy[] {
    return (request.instanceServices ?? []).map((entry) => {
      const parsed = ServicePolicySchema.safeParse({
        ...entry.policy,
        runtime: {
          scope: "instance",
          pluginId: request.pluginId,
          operationId: entry.operationId,
          installationRevision,
          artifactSha256,
          resourceBindingDigest: digest(
            jobResourceBindingsFor(machine, entry.operationId, platform, bindings) ?? null,
          ),
          input: Object.fromEntries(
            Object.entries(entry.input).map(([name, literal]) => [name, { literal }]),
          ),
        },
      });
      if (!parsed.success) conflict("invalid_instance_service_runtime");
      return parsed.data;
    });
  }
  /** Prior record identity and the exact workload a proposal's apply may stop. */
  private instanceServices(
    request: JobDeploymentRequest,
    policies: readonly ServicePolicy[],
  ): JobDeploymentInstanceService[] {
    return (request.instanceServices ?? []).map((entry, index) => {
      const record = this.host.instanceService(entry.policy.serviceId);
      return {
        expectedRevision: entry.expectedRevision,
        previous: record
          ? {
              machineId: record.machineId,
              revision: record.revision,
              enabled: record.enabled,
              policySha256: record.policySha256,
              jobId: record.jobId,
            }
          : null,
        policy: policies[index]!,
      };
    });
  }
  /**
   * Whether the destination's instance-service records still match what was approved. Before
   * the configuration transition the record must be exactly the one the operator saw; after it
   * the record must be exactly the one this approval wrote. Either way the only live provider
   * workload allowed is the reviewed one — a workload this approval never saw may not be
   * stopped, and it must not be left running under a replaced installation either.
   */
  private instanceRefusal(target: JobDeploymentTargetReview, configured: boolean): string | null {
    for (const entry of target.instanceServices ?? []) {
      const record = this.host.instanceService(entry.policy.serviceId);
      if (configured) {
        if (
          !record ||
          !record.enabled ||
          record.machineId !== target.machineId ||
          record.policySha256 !== digest(entry.policy)
        )
          return "instance_service_configuration_changed";
        continue;
      }
      if ((record?.revision ?? null) !== entry.expectedRevision)
        return "instance_service_configuration_changed";
      if (
        record &&
        (record.machineId !== target.machineId ||
          record.policySha256 !== entry.previous?.policySha256 ||
          record.enabled !== entry.previous.enabled ||
          record.jobId !== entry.previous.jobId)
      )
        return "instance_service_configuration_changed";
      if (
        this.host
          .instanceServiceWorkload(entry.policy.serviceId)
          .some((jobId) => jobId !== entry.previous?.jobId)
      )
        return "instance_service_workload_changed";
    }
    return null;
  }
  private receipt(request: JobDeploymentRequest, target: JobDeploymentTargetReview): TargetReceipt {
    return {
      consents: digest(
        this.consents(
          request,
          target.machineId,
          target.installationRevision,
          target.artifactSha256,
        ),
      ),
      invocationEdges: digest(this.invocationEdges(target)),
    };
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
        request.operationIds,
        (target.instanceServices ?? []).map((entry) => entry.policy),
      ).digest,
      invocations:
        target.installationRevision && target.artifactSha256
          ? this.host.invocations(
              auth,
              this.proposedInstallation(
                request,
                target,
                this.service.declaredMachine(request.pluginId)!,
              ),
              request.operationIds,
              this.rights(request, target.machineId),
              (target.instanceServices ?? []).map((entry) => entry.policy),
            ).digest
          : digest(null),
      invocationApprovals: digest([
        this.invocationEdges(target),
        this.previousInvocationEdges(request, target.invocationEdges.length ? current : null),
      ]),
      // Prior identity and proposed policy only. The provider workload apply may stop is bound
      // by the review body's `previous.jobId`, and checked as a subset rather than an equality,
      // because quiescing it is the effect this approval authorises.
      instanceServices: digest(
        (target.instanceServices ?? []).map((entry) => ({
          expectedRevision: entry.expectedRevision,
          previous: entry.previous,
          policySha256: digest(entry.policy),
        })),
      ),
    };
  }
  private snapshot(auth: AuthContext, request: JobDeploymentRequest) {
    const declaration = this.service.declaredMachine(request.pluginId);
    if (!declaration) conflict("manifest_declaration_unavailable");
    const machine = MachineHalfSchema.parse(declaration);
    // Reject malformed names/operation selection before offering any approval.
    this.rights(request, request.targets[0]!.machineId);
    const proposals = this.declaredInstanceServices(request, machine);
    const proposedIds = proposals.map((entry) => entry.policy.serviceId);
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
        reason ??= this.host.selfProvidedServiceRefusal(
          machineId,
          request.pluginId,
          machine,
          request.operationIds,
          proposedIds,
        );
        const resources: JobDeploymentTargetReview["resources"] = [];
        const bindings: JobResourceBindings = { tools: {}, services: {}, anchors: {} };
        // Disconnected review can reuse only immutable already-promoted native pins.
        const known = owner ? owner.resources : current?.resourceBindings;
        if (platform) {
          const selected = new Set(request.operationIds);
          for (const operationId of Object.keys(machine.operations)) {
            const required = jobResourceRequirements(machine, operationId, platform);
            for (const group of groups)
              for (const name of required[group]) {
                // A proposed service has no owner evidence and no record yet; its promoted
                // binding is the digest of the policy this review resolves below.
                if (group === "services" && proposedIds.includes(name)) continue;
                const sha256 = known?.[group][name] ?? null;
                // An operator anchor is reviewed by the host directory it presents, which only a
                // live owner advertises: a pin alone never approves an unseen host path.
                const operator = group === "anchors" && isOperatorAnchor(name);
                const source = operator
                  ? owner?.resources?.anchorDefinitions?.[name]?.source
                  : undefined;
                if (
                  !resources.some((resource) => resource.group === group && resource.name === name)
                ) {
                  resources.push({ group, name, sha256, ...(source ? { source } : {}) });
                  if (sha256) bindings[group][name] = sha256;
                }
                // A proved owner's inventory is an observation: a resource it does not
                // advertise disables the operation that needs it, never the installed worker
                // (`jobResourceRefusal`), so only a SELECTED operation's missing evidence
                // refuses the target. Refusing over an operation the request never named is
                // what forced an operator into hand-picked deployment phases (#715) and blocks
                // a scan-only deployment over an unselected operation's unavailable tool.
                //
                // Without an owner the same absence means the hub cannot see the machine at
                // all, and an offline review may only reuse pins already promoted: approving
                // there would grant authority over whatever appears on reconnect.
                if ((!sha256 || (operator && !source)) && (!owner || selected.has(operationId)))
                  reason ??= "resource_evidence_unknown";
              }
          }
        }
        const needsBindings =
          machine.requiresResourceBindings ||
          resources.length > 0 ||
          Object.values(machine.operations).some((operation) => operation.services?.length);
        const base = needsBindings ? bindings : null;
        // The revision is a digest of the REQUEST — the declaration, artifact, the bindings
        // that exist independently of this approval, and the instance-service entries as the
        // caller wrote them. It never contains the resolved policy, whose runtime pins this
        // revision; that is the self-reference #827 had to break.
        const pinned = !artifactSha256
          ? null
          : `deployment-${digest({ deploymentId: request.deploymentId, machineId, declarationSha256, artifactSha256, resourceBindings: base, ...(proposals.length ? { instanceServices: proposals } : {}) })}`;
        const complete = (revision: string) => {
          if (!platform || !artifactSha256 || !base || !proposals.length)
            return { policies: [] as ServicePolicy[], bindings: base };
          const policies = this.instancePolicies(
            request,
            machine,
            platform,
            artifactSha256,
            revision,
            base,
          );
          const services = { ...base.services };
          for (const policy of policies) services[policy.serviceId] = digest(policy);
          return { policies, bindings: { ...base, services } };
        };
        // Reusing the installed revision is only sound if the bindings it would carry are the
        // ones already promoted, proposed policies included.
        const reuse =
          current &&
          digest(current.machine) === declarationSha256 &&
          current.artifact === artifactSha256
            ? complete(current.revision)
            : null;
        const same =
          reuse !== null && digest(current!.resourceBindings ?? null) === digest(reuse.bindings);
        const resolved = same
          ? reuse!
          : pinned
            ? complete(pinned)
            : { policies: [], bindings: base };
        const resourceBindings = resolved.bindings;
        const installationRevision = !artifactSha256 ? null : same ? current!.revision : pinned;
        for (const policy of resolved.policies)
          resources.push({ group: "services", name: policy.serviceId, sha256: digest(policy) });
        resources.sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
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
        const instanceServices = proposals.length
          ? this.instanceServices(request, resolved.policies)
          : undefined;
        let invocationEdges: JobDeploymentInvocationEdge[] = [];
        if (proposed && platform) {
          try {
            const invocations = this.host.invocations(
              auth,
              proposed,
              request.operationIds,
              this.rights(request, machineId),
              resolved.policies,
            );
            invocationEdges = invocations.edges;
            reason ??= invocations.refusal;
            reason ??= this.host.servicePolicies(
              machineId,
              machine,
              resourceBindings,
              request.operationIds,
              resolved.policies,
            ).refusal;
            if (!this.host.artifactAvailable(proposed, platform))
              reason ??= "artifact_bundle_unavailable";
            if (owner)
              for (const operationId of request.operationIds)
                reason ??= this.host.resourceRefusal(
                  proposed,
                  operationId,
                  invocationEdges.map(({ edge }) => edge),
                  request.operationIds,
                  resolved.policies,
                );
            for (const [index, entry] of (instanceServices ?? []).entries()) {
              // The record this proposal replaces has to be the one the operator is looking
              // at, owned here, provided by this plugin, and holding no workload but its own.
              const record = this.host.instanceService(entry.policy.serviceId);
              if ((record?.revision ?? null) !== entry.expectedRevision)
                reason ??= "instance_service_configuration_changed";
              else if (record && record.machineId !== machineId)
                reason ??= "instance_service_owner_changed";
              else if (record && record.pluginId !== request.pluginId)
                reason ??= "instance_service_plugin_mismatch";
              else if (
                this.host
                  .instanceServiceWorkload(entry.policy.serviceId)
                  .some((jobId) => jobId !== record?.jobId)
              )
                reason ??= "instance_service_lifetime_unconfirmed";
              reason ??= this.host.instanceServiceRefusal(
                proposed,
                entry.policy,
                proposals[index]!.operationId,
                proposals[index]!.input,
              );
            }
          } catch (error) {
            if (!(error instanceof ServiceError)) throw error;
            reason ??= error.message;
          }
        }
        // Only the reviewed provider workload is this approval's to stop; anything else the
        // plugin is running on this machine still holds the target.
        const busy = this.busy(machineId, request.pluginId, instanceServices ?? []);
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
          invocationEdges,
          ...(instanceServices ? { instanceServices } : {}),
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
            "SELECT deployment_id FROM machine_job_deployment_targets WHERE machine_id=? AND plugin_id=? AND phase IN ('pending','quiescing','applying','configuring') LIMIT 1",
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
  /**
   * Whether this plugin still has work on the machine that an installation may not interrupt.
   * A reviewed instance-service proposal exempts exactly the provider job named in its own
   * approval, because quiescing that job is the effect the operator approved; every other job
   * of this plugin — and every job of any other plugin — keeps the target waiting instead.
   */
  private busy(
    machineId: string,
    pluginId: string,
    reviewed: readonly JobDeploymentInstanceService[] = [],
  ): boolean {
    const exempt = reviewed.flatMap((entry) =>
      entry.previous?.jobId ? [entry.previous.jobId] : [],
    );
    return this.service.jobs
      .reconcilable(machineId)
      .some(
        (job) =>
          job.request.pluginId === pluginId &&
          !exempt.includes(job.request.jobId) &&
          (["queued", "admitted", "start-committed", "started"].includes(job.state) ||
            (job.permit !== null && !job.ownerClosed)),
      );
  }
  /**
   * Why this target may not proceed, or may no longer be treated as applied.
   *
   * `phase` decides how much of the destination is still expected to look like the review.
   * Before the configuration transition a proposed instance service is evaluated prospectively,
   * exactly as review did; after it the proposal is dropped and the destination must satisfy
   * every ordinary live check — the record, the owner's own advertisement of the policy and the
   * provider job — so "ready" never means anything less than the native acknowledgement.
   */
  private refusal(
    approval: Approval,
    target: JobDeploymentTargetReview,
    index: number,
    phase: Phase,
  ): string | null {
    const applied = phase === "applied" || phase === "configuring" || phase === "bound";
    const configured = phase === "bound";
    const proposals = configured
      ? []
      : (target.instanceServices ?? []).map((entry) => entry.policy);
    const auth = this.service.auth.restoreCredential(approval.credential);
    if (auth === null || !this.service.auth.holdsRoot(auth)) return "credential_revoked_or_expired";
    const request = approval.review.request;
    if (!approval.evidence[index]?.invocations) return "deployment_review_stale";
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
      const invocations = this.host.invocations(
        auth,
        install,
        request.operationIds,
        this.rights(request, target.machineId),
        proposals,
      );
      if (invocations.refusal) return invocations.refusal;
      if (invocations.digest !== approval.evidence[index]!.invocations)
        return "invocation_scope_changed";
      const policies = this.host.servicePolicies(
        target.machineId,
        install.machine,
        target.resourceBindings,
        request.operationIds,
        proposals,
      );
      if (policies.refusal) return policies.refusal;
      if (policies.digest !== approval.evidence[index]!.resources)
        return "service_definition_changed";
      if (!target.platform || !this.host.artifactAvailable(install, target.platform))
        return "artifact_bundle_unavailable";
      const owner = this.host.owner(target.machineId);
      if (owner) {
        if (!owner.platforms.includes(target.platform)) return "installation_platform_unavailable";
        // A reviewed instance service is excluded here on purpose: its promoted digest is
        // checked against the proposal, and then against the configured record, by
        // `instanceRefusal`, while the owner's own advertisement of it is checked — with a
        // reason that distinguishes "not yet" from "changed" — by the resource walk below.
        const reviewed = (target.instanceServices ?? []).map((entry) => entry.policy.serviceId);
        if (target.resourceBindings)
          for (const group of groups)
            for (const [name, hash] of Object.entries(target.resourceBindings[group]))
              if (
                owner.resources?.[group][name] !== hash &&
                !(group === "services" && reviewed.includes(name))
              )
                return "resource_revision_changed";
        for (const operationId of request.operationIds) {
          const refusal = this.host.resourceRefusal(
            install,
            operationId,
            applied ? [] : target.invocationEdges.map(({ edge }) => edge),
            request.operationIds,
            proposals,
          );
          if (refusal) return refusal;
        }
      }
      const instance = this.instanceRefusal(target, configured);
      if (instance) return instance;
    } catch (error) {
      if (!(error instanceof ServiceError)) throw error;
      return error.message;
    }
    return null;
  }
  private proposed(approval: Approval, target: JobDeploymentTargetReview): JobInstallation {
    return this.proposedInstallation(approval.review.request, target, approval.review.machine);
  }
  private proposedInstallation(
    request: JobDeploymentRequest,
    target: JobDeploymentTargetReview,
    machine: MachineHalf,
  ): JobInstallation {
    if (!target.installationRevision || !target.artifactSha256) conflict("deployment_unapprovable");
    return {
      machineId: target.machineId,
      pluginId: request.pluginId,
      revision: target.installationRevision,
      artifact: target.artifactSha256,
      machine,
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
    // `quiescing` is deliberately absent: its only effect is stopping the exact reviewed
    // provider workload, which is durable, idempotent and re-observed on the next pass.
    for (const phase of ["applying", "configuring"] as const)
      for (const row of this.service.store.db
        .query<StoredApproval, [string]>(
          "SELECT DISTINCT d.* FROM machine_job_deployments d JOIN machine_job_deployment_targets t USING(deployment_id) WHERE t.phase=?",
        )
        .all(phase)) {
        const approval = JSON.parse(row.approval) as Approval;
        for (const target of approval.review.targets)
          this.service.store.transaction(() =>
            this.transition(
              approval,
              target,
              phase,
              "needs_review",
              "deployment_application_uncertain",
            ),
          );
      }
  }
  /** The reviewed provider workloads that still hold a lifetime this apply has to stop. */
  private quiesceRequired(
    approval: Approval,
    target: JobDeploymentTargetReview,
  ): { serviceId: string; jobId: string }[] {
    const proposed = this.proposed(approval, target);
    const current = this.service.jobs.installation(target.machineId, proposed.pluginId);
    // An installation that is not being replaced never needs its provider stopped: configuring
    // the replacement record retires its own predecessor through the ordinary door.
    if (this.installation(current) === this.installation(proposed)) return [];
    return (target.instanceServices ?? []).flatMap((entry) =>
      entry.previous?.jobId &&
      this.host.instanceServiceWorkload(entry.policy.serviceId).includes(entry.previous.jobId)
        ? [{ serviceId: entry.policy.serviceId, jobId: entry.previous.jobId }]
        : [],
    );
  }
  reconcile(): void {
    if (this.processing) return;
    this.processing = true;
    try {
      const rows = this.service.store.db
        .query<StoredApproval, []>(
          "SELECT DISTINCT d.* FROM machine_job_deployments d JOIN machine_job_deployment_targets t USING(deployment_id) WHERE d.cancelled=0 AND t.phase IN ('pending','quiescing','applied') ORDER BY d.rowid",
        )
        .all();
      for (const row of rows) {
        const approval = JSON.parse(row.approval) as Approval;
        for (const [index, target] of approval.review.targets.entries()) {
          if (
            this.targets(row.deployment_id).find((item) => item.machine_id === target.machineId)
              ?.phase === "applied"
          ) {
            this.bindTarget(row, approval, target, index);
            continue;
          }
          const attempt = this.service.runtime.newId();
          const claimed = this.service.store.transaction(() => {
            const phase = this.targets(row.deployment_id).find(
              (item) => item.machine_id === target.machineId,
            )?.phase;
            if (
              this.get(row.deployment_id)?.cancelled ||
              (phase !== "pending" && phase !== "quiescing")
            )
              return null;
            const reason = this.refusal(approval, target, index, phase);
            if (reason) {
              this.transition(approval, target, phase, "needs_review", reason);
              return null;
            }
            if (
              !this.host.owner(target.machineId) ||
              this.busy(
                target.machineId,
                approval.review.request.pluginId,
                target.instanceServices ?? [],
              ) ||
              this.service.store.getMachine(target.machineId)?.draining
            )
              return null;
            // The reviewed provider still owns a lifetime under an installation this apply
            // replaces. Record the stop as its own durable phase before requesting it, so a
            // reader sees why the target is waiting and a restart re-observes instead of
            // re-deciding.
            const quiesce = this.quiesceRequired(approval, target);
            if (quiesce.length) {
              if (
                phase === "pending" &&
                !this.transition(
                  approval,
                  target,
                  "pending",
                  "quiescing",
                  "provider_workload_quiescing",
                )
              )
                return null;
              return { quiesce };
            }
            if (!this.transition(approval, target, phase, "applying", null)) return null;
            this.service.store.db
              .query(
                "UPDATE machine_job_deployment_targets SET attempt=? WHERE deployment_id=? AND machine_id=? AND phase='applying'",
              )
              .run(attempt, row.deployment_id, target.machineId);
            return { quiesce: [] };
          });
          if (!claimed) continue;
          if (claimed.quiesce.length) {
            for (const { serviceId, jobId } of claimed.quiesce)
              this.host.quiesceInstanceService(serviceId, jobId);
            continue;
          }
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
              const reason = this.refusal(approval, target, index, "applying");
              if (
                reason ||
                !this.host.owner(target.machineId) ||
                this.busy(
                  target.machineId,
                  approval.review.request.pluginId,
                  target.instanceServices ?? [],
                ) ||
                this.quiesceRequired(approval, target).length ||
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
                  instanceServices: (target.instanceServices ?? []).map((entry) => entry.policy),
                });
              for (const { edge, approved } of target.invocationEdges)
                if (!approved) this.service.setInvocationEdge(auth, { edge, enabled: true });
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
              const receipt = canonicalJobJson(this.receipt(approval.review.request, target));
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
  /**
   * Configure the reviewed instance services, once the owner has acknowledged the exact
   * installation their runtime pins. This is a separate durable phase from `applying` because
   * it can only happen after a native round trip: the installation the policy names has to
   * exist and be acknowledged before a provider job may be admitted from it.
   *
   * The configuration runs through the ordinary door, outside this method's transactions, for
   * the same reason `install` does: it mints a credential and admits a job, and an effect that
   * reaches the owner may not be undone by a rollback. A process that dies between the effect
   * and its transition is recovered as uncertain and asks for a new review; nothing replays.
   */
  private bindTarget(
    row: StoredApproval,
    approval: Approval,
    target: JobDeploymentTargetReview,
    index: number,
  ): void {
    const entries = target.instanceServices ?? [];
    if (!entries.length) return;
    const attempt = this.service.runtime.newId();
    const claimed = this.service.store.transaction(() => {
      const retained = this.targets(row.deployment_id).find(
        (item) => item.machine_id === target.machineId,
      );
      if (this.get(row.deployment_id)?.cancelled || retained?.phase !== "applied") return false;
      const reason = this.refusal(approval, target, index, "applied");
      if (reason) {
        this.transition(approval, target, "applied", "needs_review", reason);
        return false;
      }
      if (
        !this.host.owner(target.machineId) ||
        this.service.store.getMachine(target.machineId)?.draining ||
        !this.host.installed(
          target.machineId,
          approval.review.request.pluginId,
          target.installationRevision!,
        )
      )
        return false;
      if (!this.transition(approval, target, "applied", "configuring", null)) return false;
      this.service.store.db
        .query(
          "UPDATE machine_job_deployment_targets SET attempt=? WHERE deployment_id=? AND machine_id=? AND phase='configuring'",
        )
        .run(attempt, row.deployment_id, target.machineId);
      return true;
    });
    if (!claimed) return;
    try {
      const auth = this.service.auth.restoreCredential(approval.credential);
      if (auth === null || !this.service.auth.holdsRoot(auth))
        conflict("credential_revoked_or_expired");
      for (const entry of entries)
        this.host.configureInstanceService(
          auth,
          {
            serviceId: entry.policy.serviceId,
            expectedRevision: entry.expectedRevision,
            machineId: target.machineId,
            policy: entry.policy,
            enabled: true,
          },
          approval.traceId,
        );
      this.service.store.transaction(() => {
        const retained = this.targets(row.deployment_id).find(
          (item) => item.machine_id === target.machineId,
        );
        if (retained?.phase !== "configuring" || retained.attempt !== attempt) return;
        this.transition(approval, target, "configuring", "bound", null);
      });
    } catch (error) {
      this.service.store.transaction(() =>
        this.transition(
          approval,
          target,
          "configuring",
          "needs_review",
          error instanceof ServiceError ? error.message : "deployment_application_uncertain",
        ),
      );
      if (!(error instanceof ServiceError)) throw error;
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
      const entries = target.instanceServices ?? [];
      // A reviewed provider comes up through the ordinary instance-service lifecycle once its
      // configuration lands: the owner has to receive the policy, advertise it and run the job.
      // These are the only refusals that read as "not yet" rather than "review this again".
      const starting = (reason: string): boolean =>
        entries.length > 0 &&
        [
          "instance_service_starting",
          "services_unavailable",
          "service_unavailable",
          "service_runtime_unavailable",
          "operation_resources_unreported",
        ].includes(reason);
      if (record.phase === "cancelled") return result("cancelled", record.reason);
      if (record.phase === "needs_review") return result("needs_review", record.reason);
      if (record.phase === "applying" || record.phase === "configuring")
        return result("needs_review", "deployment_application_uncertain");
      const current = this.service.jobs.installation(target.machineId, request.pluginId);
      if (
        (record.phase === "applied" || record.phase === "bound") &&
        current?.revision !== target.installationRevision
      )
        return result("superseded", "installation_replaced");
      const refusal = this.refusal(approval, target, index, record.phase);
      if (refusal)
        return record.phase === "bound" && starting(refusal)
          ? result("installing", refusal)
          : result("needs_review", refusal);
      if (record.phase === "quiescing")
        return result("installing", record.reason ?? "provider_workload_quiescing");
      if (record.phase === "pending")
        return result(
          "pending",
          !connected
            ? "owner_offline"
            : this.service.store.getMachine(target.machineId)?.draining
              ? "machine_draining"
              : this.busy(target.machineId, request.pluginId, entries)
                ? "active_installation"
                : null,
        );
      const desired = this.proposed(approval, target);
      if (this.installation(current) !== this.installation(desired))
        return result("needs_review", "installation_changed");
      const receipt = record.receipt ? (JSON.parse(record.receipt) as TargetReceipt) : null;
      const currentReceipt = this.receipt(request, target);
      if (receipt?.invocationEdges !== currentReceipt.invocationEdges)
        return result("needs_review", "invocation_edge_changed");
      if (receipt?.consents !== currentReceipt.consents)
        return result("needs_review", "consent_changed");
      if (!connected) return result("installing", "owner_offline");
      const auth = this.service.auth.restoreCredential(approval.credential)!;
      const description = this.service.describe(auth, {
        machineId: target.machineId,
        pluginId: request.pluginId,
      });
      if (!description.installation?.ready)
        return result("installing", "owner_acknowledgement_pending");
      // Installed and acknowledged, with the reviewed configuration still to apply.
      if (record.phase === "applied" && entries.length)
        return result("installing", "instance_service_configuring");
      for (const operationId of request.operationIds) {
        const operation = description.operations?.[operationId];
        if (!operation?.ready) {
          const reason = operation?.reason ?? "unknown_operation";
          return starting(reason) ? result("installing", reason) : result("needs_review", reason);
        }
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
      for (const target of approval.review.targets)
        // Every phase that has not yet produced a durable installation or configuration
        // receipt. `applied` and `bound` are receipts and stay exactly where they are.
        for (const phase of ["pending", "quiescing", "applying", "configuring"] as const)
          this.transition(approval, target, phase, "cancelled", "approval_cancelled");
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
    // The same credential, target and caller-plugin walk `describe` takes, including on
    // absence — but not its governed consent gate: this answers with the plugin's OWN
    // deployment and installation record, not with the machine's facts, so an install-only
    // deployment with no operation consents must still be able to read its own progress (#735).
    this.service.machineReadAuthority(auth, parsed, callerPluginId);
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
