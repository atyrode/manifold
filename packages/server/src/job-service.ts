import type { JobExecution, JobFollow } from "@manifold/plugin";
import {
  createHash,
  createCipheriv,
  createDecipheriv,
  generateKeyPairSync,
  sign,
  verify,
  randomUUID,
  randomBytes,
} from "node:crypto";
import { z } from "zod";
import {
  formatManifoldUri,
  parseManifoldUri,
  type ManifoldRef,
  type Cap,
  type RuntimeDeps,
  type PluginBundle,
  type JobArtifactDelivery,
  type ServiceConfigurationRead,
  type ConfigureInstanceServiceArgs,
  type InstanceServiceConfigurationRead,
  type InstanceServiceDescription,
  type InstanceServiceOwner,
  type InstanceServiceReadArgs,
  type InstanceServicesDescription,
  type ServiceTunnelFrame,
} from "@manifold/protocol";
import {
  canonicalJobJson,
  JobRequestSchema,
  JobCommandSchema,
  MachineHalfSchema,
  MAX_JOB_FOLLOW_EVENTS,
  MAX_JOB_FOLLOW_BYTES,
  ListJobRunsArgsSchema,
  ListJobRunsResultSchema,
  PublicScheduleOccurrenceSchema,
  JobInvocationEdgeSchema,
  type JobInvocationEdge,
  type InspectJobInvocationsResult,
  type ListJobRunsArgs,
  type ListJobRunsResult,
  type PublicJob,
  type PublicJobRun,
  type JobCommand,
  type JobEvent,
  type JobOwner,
  type JobRequest,
  type MachineHalf,
  type JobFollowEvent,
  type JobFollowUpdate,
  type TerminalRuntime,
} from "../../protocol/src/jobs.ts";
import type { JobDescription } from "../../protocol/src/jobs.ts";
import { JobOutputRuleSchema } from "../../protocol/src/jobs.ts";
import {
  JobResourceBindingsSchema,
  jobResourceBindingsFor,
  jobResourceRefusal,
  type JobResourceBindings,
} from "../../protocol/src/job-resources.ts";
import {
  ServiceConfigurationSchema,
  ServicePolicySchema,
  ServiceReadArgsSchema,
  ServiceInvokeArgsSchema,
  ServiceReplySchema,
  servicePolicyCredentialRefs,
  type ServiceConfiguration,
  type ServicePolicy,
  type ServiceBinding,
  type ServiceReadArgs,
  type ServiceInvokeArgs,
  type ServiceReply,
} from "../../protocol/src/services.ts";
import {
  ServiceError,
  type AuthContext,
  type AuthService,
  type CredentialReference,
  type AuthorityRequirement,
  type GovernedAdmissionRequest,
  type GovernedAdmissionDecision,
} from "./auth.ts";
import {
  JobStore,
  type JobRecord,
  type JobInstallation,
  type JobRunPosition,
} from "./job-store.ts";
import type { ServerStore, TraceRecord } from "./stores.ts";
import { JobSchedules, type JobScheduleSpec } from "./job-schedules.ts";
import { InstanceServiceStore, type InstanceServiceRecord } from "./instance-service-store.ts";
export type { JobRecord } from "./job-store.ts";
import { deliveredArtifact } from "@manifold/plugin-kit/artifacts";
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
interface ServiceTunnelDirection {
  next: number;
  waiting: number | null;
  ended: boolean;
}
interface HubServiceTunnel {
  request: Extract<JobEvent, { type: "service_tunnel_open" }>;
  consumer: JobChannel;
  producer: JobChannel;
  policy: ServicePolicy;
  instanceRevision: string;
  operationIds: string[];
  ready: boolean;
  timer: ReturnType<typeof setTimeout>;
  outward: ServiceTunnelDirection;
  inward: ServiceTunnelDirection;
}
const digest = (value: unknown) =>
  createHash("sha256").update(canonicalJobJson(value)).digest("hex");
function fail(code = "governed_authority_refused"): never {
  throw new ServiceError("forbidden", code);
}
const active = new Set(["queued", "admitted", "start-committed", "started"]);
const runCursorSchema = z.strictObject({
  filter: z.strictObject({
    pluginId: z.string().min(1).max(256),
    machineId: z.string().min(1).max(256),
    operationId: z.string().min(1).max(256).nullable(),
  }),
  before: z.strictObject({
    at: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    source: z.union([z.literal(0), z.literal(1)]),
    jobId: z.string().min(1).max(256),
  }),
});
interface JobChanges {
  run(node: Extract<ManifoldRef, { kind: "job" }>, actor: string): void;
  access(): void;
}

export class JobService {
  readonly jobSchedules: JobSchedules;
  private readonly runCursorKey = randomBytes(32);
  private changeNotifier: JobChanges | null = null;
  readonly instanceServices: InstanceServiceStore;
  private readonly effectiveServices = new Map<string, ServiceConfiguration>();
  private readonly instanceStarts = new Set<string>();
  private readonly instanceFailures = new Map<string, { revision: string; reason: string }>();
  private readonly instanceReadiness = new Map<
    string,
    { revision: string; jobId: string; channel: JobChannel }
  >();
  private machinePresence: ((machineId: string) => boolean) | null = null;
  private readonly serviceTunnels = new Map<string, HubServiceTunnel>();

  setMachinePresence(presence: (machineId: string) => boolean): void {
    this.machinePresence = presence;
  }

  private readonly directServiceCalls = new Map<
    string,
    {
      mode: "read" | "invoke";
      channel: JobChannel;
      args: ServiceReadArgs;
      credential: CredentialReference;
      callerPluginId: string;
      traceId: string;
      authorized: boolean;
      finish(error?: Error, reply?: ServiceReply): void;
    }
  >();
  private readonly installationResources = new Map<
    string,
    {
      channel: JobChannel;
      revision: string;
      artifact: string;
      resources: NonNullable<Extract<JobEvent, { type: "installed" }>["resources"]>;
    }
  >();
  private configuration(machineId: string): ServiceConfiguration {
    const row = this.store.db
      .query<{ configuration: string }, [string]>(
        "SELECT configuration FROM native_service_configurations WHERE machine_id=?",
      )
      .get(machineId);
    return row
      ? ServiceConfigurationSchema.parse(JSON.parse(row.configuration))
      : { revision: null, policies: [] };
  }
  private instancePolicy(record: InstanceServiceRecord): ServicePolicy {
    return record.policy;
  }
  private effectiveConfiguration(machineId: string): ServiceConfiguration {
    const cached = this.effectiveServices.get(machineId);
    if (cached) return cached;
    const local = this.configuration(machineId);
    const policies = new Map(local.policies.map((policy) => [policy.serviceId, policy]));
    let inherited = false;
    for (const record of this.instanceServices.list()) {
      if (!record.enabled) continue;
      const policy = this.instancePolicy(record);
      if (record.machineId === machineId) {
        policies.set(record.serviceId, policy);
      } else {
        const operations = Object.fromEntries(
          Object.entries(policy.operations).filter(([, operation]) => "kind" in operation),
        );
        if (!Object.keys(operations).length) continue;
        const definition = { ...policy };
        delete definition.runtime;
        policies.set(
          record.serviceId,
          ServicePolicySchema.parse({
            ...definition,
            operations,
            remote: {
              machineId: record.machineId,
              serviceId: record.serviceId,
              revision: record.revision,
              policySha256: digest(policy),
            },
          }),
        );
      }
      inherited = true;
    }
    const values = [...policies.values()];
    const configuration = inherited
      ? ServiceConfigurationSchema.parse({ revision: digest(values), policies: values })
      : local;
    this.effectiveServices.set(machineId, configuration);
    return configuration;
  }
  private instanceOwner(machineId: string | null): InstanceServiceOwner | null {
    if (machineId === null) return null;
    const machine = this.store.getMachine(machineId);
    if (!machine) return null;
    const token = this.store.getToken(machine.tokenId);
    return {
      machineId,
      name: machine.name,
      online:
        token?.revokedAt === null &&
        (token.expiresAt === null || token.expiresAt > this.runtime.now()) &&
        this.machinePresence?.(machineId) === true,
    };
  }
  private instanceReason(record: InstanceServiceRecord): string | null {
    if (!record.enabled) return "instance_service_disabled";
    if (this.store.getMachine(record.machineId)?.draining) return "machine_draining";
    const live = this.channels.get(record.machineId);
    if (!live?.proved) return "resource_owner_unavailable";
    if (!record.credential || !this.auth.restoreCredential(record.credential))
      return "credential_revoked_or_expired";
    const ready = this.instanceReadiness.get(record.serviceId);
    if (
      ready?.revision === record.revision &&
      ready.jobId === record.jobId &&
      ready.channel === live.channel &&
      this.jobs.get(ready.jobId)?.state === "started"
    )
      return null;
    const failure = this.instanceFailures.get(record.serviceId);
    if (failure?.revision === record.revision) return failure.reason;
    const job = record.jobId ? this.jobs.get(record.jobId) : null;
    if (job && active.has(job.state)) return "instance_service_starting";
    return this.instanceStarts.has(record.serviceId)
      ? "instance_service_starting"
      : (job?.result?.reason ?? "instance_service_unavailable");
  }
  private instanceDescription(
    record: InstanceServiceRecord | null,
    serviceId: string,
    showDefaultOwner: boolean,
  ): InstanceServiceDescription {
    const defaultOwner = showDefaultOwner
      ? this.instanceOwner(this.instanceServices.defaultOwnerId())
      : null;
    const owner = record ? this.instanceOwner(record.machineId) : null;
    const target = owner ?? defaultOwner;
    const reason = record ? this.instanceReason(record) : null;
    return {
      serviceId,
      defaultOwner,
      owner,
      configuration: record
        ? {
            revision: record.revision,
            pluginId: record.pluginId,
            enabled: record.enabled,
            policySha256: digest(this.instancePolicy(record)),
          }
        : null,
      connected: target !== null && this.channels.get(target.machineId)?.proved === true,
      state: !record
        ? "unconfigured"
        : !record.enabled
          ? "stopped"
          : reason === null
            ? "ready"
            : reason === "instance_service_starting"
              ? "starting"
              : "unavailable",
      reason,
    };
  }
  private canInspectInstance(current: AuthContext, record: InstanceServiceRecord): boolean {
    return (
      current.isRoot ||
      Object.keys(record.policy.operations).some((operationId) =>
        (["services:read", "services:invoke"] as const).some(
          (cap) =>
            (current.caps.includes("*") || current.caps.includes(cap)) &&
            this.auth.allowsRef(current, cap, {
              kind: "service",
              machineId: record.machineId,
              serviceId: record.serviceId,
              operationId,
            }),
        ),
      )
    );
  }
  describeInstanceService(
    auth: AuthContext,
    args: { serviceId: string },
  ): InstanceServiceDescription {
    const current = this.auth.restoreCredential(this.auth.credentialReference(auth));
    const record = this.instanceServices.get(args.serviceId);
    if (!current || (!current.isRoot && (!record || !this.canInspectInstance(current, record))))
      fail("service_unauthorized");
    return this.instanceDescription(record, args.serviceId, current.isRoot);
  }
  listInstanceServices(auth: AuthContext): InstanceServicesDescription {
    const current = this.auth.restoreCredential(this.auth.credentialReference(auth));
    if (!current) fail("service_unauthorized");
    return {
      defaultOwner: current.isRoot
        ? this.instanceOwner(this.instanceServices.defaultOwnerId())
        : null,
      services: this.instanceServices
        .list()
        .filter((record) => this.canInspectInstance(current, record))
        .map((record) => this.instanceDescription(record, record.serviceId, current.isRoot)),
    };
  }
  readInstanceServiceConfiguration(
    auth: AuthContext,
    args: { serviceId: string },
  ): InstanceServiceConfigurationRead {
    const current = this.auth.restoreCredential(this.auth.credentialReference(auth));
    if (!current?.isRoot) fail("instance_service_configuration_forbidden");
    const record = this.instanceServices.get(args.serviceId);
    if (record) this.configurationAuthority(current, record.machineId);
    return {
      description: this.instanceDescription(record, args.serviceId, true),
      policy: record?.policy ?? null,
    };
  }
  private instanceRuntimeRequest(
    auth: AuthContext,
    policy: ServicePolicy,
    machineId: string,
    traceId: string,
  ): JobRequest {
    const runtime = policy.runtime;
    if (!runtime || runtime.scope !== "instance") fail("invalid_instance_service_runtime");
    const install = this.jobs.installation(machineId, runtime.pluginId);
    const operation = install?.machine.operations[runtime.operationId];
    if (
      !install?.enabled ||
      !operation?.providesService ||
      !install.ready ||
      install.purgeRequested ||
      this.store.disabledPlugins().has(install.pluginId)
    )
      fail("instance_service_runtime_unavailable");
    const input: JobRequest["input"] = {};
    for (const [name, value] of Object.entries(runtime.input)) {
      if (!("literal" in value)) fail("invalid_instance_service_runtime");
      input[name] = value.literal;
    }
    return this.build(auth, runtime.pluginId, traceId, {
      jobId: this.runtime.newId(),
      machineId,
      operationId: runtime.operationId,
      installationRevision: runtime.installationRevision,
      artifactSha256: runtime.artifactSha256,
      resourceBindingDigest: runtime.resourceBindingDigest,
      input,
      outputs: [],
    });
  }
  async configureInstanceService(
    auth: AuthContext,
    args: ConfigureInstanceServiceArgs,
    callerPluginId = "engine.services",
    traceId = "native-services",
  ): Promise<InstanceServiceDescription> {
    const previous = this.instanceServices.get(args.serviceId);
    if ((previous?.revision ?? null) !== args.expectedRevision)
      throw new ServiceError("conflict", "instance_service_configuration_changed");
    const machineId =
      args.machineId ?? previous?.machineId ?? this.instanceServices.defaultOwnerId();
    if (machineId === null) throw new ServiceError("conflict", "instance_service_owner_required");
    const current = this.configurationAuthority(auth, machineId);
    if (previous) this.configurationAuthority(current, previous.machineId);
    if (callerPluginId !== "engine.services" && args.policy.runtime?.pluginId !== callerPluginId)
      fail("instance_service_plugin_mismatch");
    if (!previous && this.instanceServices.list().length >= 64)
      throw new ServiceError("conflict", "instance_service_capacity");
    const template = args.enabled
      ? this.instanceRuntimeRequest(current, args.policy, machineId, traceId)
      : null;
    const requirements = template ? this.requirements(template) : [];
    const result = this.store.transaction(() => {
      const result = this.instanceServices.configure(
        current,
        args,
        callerPluginId,
        traceId,
        requirements,
      );
      this.effectiveServices.clear();
      this.serviceTrace(current, callerPluginId, traceId, "configure-instance", {
        serviceId: args.serviceId,
        machineId,
        previousRevision: args.expectedRevision,
        revision: result.current.revision,
        enabled: result.current.enabled,
      });
      return result;
    });
    if (result.previous?.revision !== result.current.revision) {
      this.instanceReadiness.delete(args.serviceId);
      this.instanceFailures.delete(args.serviceId);
      if (result.previous?.jobId) {
        const previousJob = this.jobs.get(result.previous.jobId);
        if (previousJob) this.cancelRecord(previousJob, "instance_service_configuration_changed");
      }
    }
    for (const live of [...this.channels.values()])
      if (live.proved && !this.synchronizeServices(live.channel)) this.offline(live.channel);
    if (result.current.enabled) {
      this.instanceStarts.add(args.serviceId);
      this.ensureInstanceService(args.serviceId);
    } else this.instanceStarts.delete(args.serviceId);
    this.reconcileAuthority();
    this.accessChanged();
    return this.instanceDescription(
      this.instanceServices.get(args.serviceId),
      args.serviceId,
      true,
    );
  }
  private instanceServiceReadArgs(args: InstanceServiceReadArgs): ServiceReadArgs {
    const record = this.instanceServices.get(args.serviceId);
    if (!record || record.revision !== args.expectedRevision)
      throw new ServiceError("conflict", "instance_service_configuration_changed");
    const reason = this.instanceReason(record);
    if (reason !== null) throw new ServiceError("conflict", reason);
    return {
      machineId: record.machineId,
      serviceId: record.serviceId,
      revision: record.policy.revision,
      policySha256: digest(this.instancePolicy(record)),
      operationId: args.operationId,
      input: args.input,
    };
  }
  readInstanceService(
    auth: AuthContext,
    args: InstanceServiceReadArgs,
    callerPluginId = "engine.services",
    traceId = "native-services",
  ): Promise<ServiceReply> {
    return this.readService(auth, this.instanceServiceReadArgs(args), callerPluginId, traceId);
  }
  invokeInstanceService(
    auth: AuthContext,
    args: InstanceServiceReadArgs,
    callerPluginId = "engine.services",
    traceId = "native-services",
  ): Promise<ServiceReply> {
    return this.invokeService(auth, this.instanceServiceReadArgs(args), callerPluginId, traceId);
  }
  private ensureInstanceService(serviceId: string): void {
    const record = this.instanceServices.get(serviceId);
    if (!record?.enabled) {
      this.instanceStarts.delete(serviceId);
      return;
    }
    if (
      !this.channels.get(record.machineId)?.proved ||
      !this.jobs.installation(record.machineId, record.pluginId)?.ready
    )
      return;
    const owned = this.jobs.instanceServiceJobs(serviceId);
    const existing = record.jobId ? this.jobs.get(record.jobId) : null;
    if (existing && active.has(existing.state)) {
      this.instanceStarts.delete(serviceId);
      return;
    }
    if (owned.length || (record.jobId !== null && existing === null)) {
      this.instanceFailures.set(serviceId, {
        revision: record.revision,
        reason: "instance_service_lifetime_unconfirmed",
      });
      return;
    }
    this.instanceStarts.delete(serviceId);
    try {
      const current = record.credential ? this.auth.restoreCredential(record.credential) : null;
      if (!current) fail("credential_revoked_or_expired");
      const base = this.instanceRuntimeRequest(
        current,
        record.policy,
        record.machineId,
        record.traceId,
      );
      const unsigned: Omit<JobRequest, "requestDigest"> & { requestDigest?: string } = {
        ...base,
        limits: { ...base.limits, timeoutMs: 0 },
        service: {
          serviceId,
          revision: record.revision,
          policySha256: digest(this.instancePolicy(record)),
        },
      };
      delete unsigned.requestDigest;
      const request = JobRequestSchema.parse({ ...unsigned, requestDigest: digest(unsigned) });
      const job = this.store.transaction(() => {
        if (!this.instanceServices.setJob(serviceId, record.revision, request.jobId))
          throw new ServiceError("conflict", "instance_service_configuration_changed");
        this.jobs.reserve(request, this.runtime.now());
        const decision = this.decide({
          credential: request.credential,
          pluginId: request.pluginId,
          action: "engine.services.configureInstance",
          evidence: this.requirements(request).map((requirement) =>
            this.auth.explain(current, requirement),
          ),
        });
        this.jobs.decision(request.jobId, decision.decisionId);
        if (!decision.allowed) this.jobs.state(request.jobId, "refused");
        return this.jobs.get(request.jobId)!;
      });
      this.instanceFailures.delete(serviceId);
      this.changed(job.request);
      if (job.state === "queued") this.start(job);
    } catch (error) {
      if (!(error instanceof ServiceError)) throw error;
      this.instanceFailures.set(serviceId, { revision: record.revision, reason: error.message });
    }
    this.accessChanged();
  }
  private configurationAuthority(auth: AuthContext, machineId: string): AuthContext {
    const current = this.auth.restoreCredential(this.auth.credentialReference(auth));
    if (
      !current?.isRoot ||
      !this.store.getMachine(machineId) ||
      (!current.caps.includes("*") && !current.caps.includes("services:configure")) ||
      !this.auth.allowsRef(current, "services:configure", { kind: "machine", machineId })
    )
      fail();
    return current;
  }
  readServiceConfiguration(
    auth: AuthContext,
    args: { machineId: string },
  ): ServiceConfigurationRead {
    this.configurationAuthority(auth, args.machineId);
    const live = this.channels.get(args.machineId);
    const disabled = this.store.disabledPlugins();
    return {
      configuration: this.configuration(args.machineId),
      connected: live?.proved === true,
      credentialReferences: live?.proved ? (live.owner.resources?.credentialReferences ?? []) : [],
      runtimeCandidates: this.jobs.installations(args.machineId).flatMap((install) =>
        Object.entries(install.machine.operations).flatMap(([operationId, operation]) => {
          if (!operation.providesService) return [];
          const reason = !live?.proved
            ? "resource_owner_unavailable"
            : !install.enabled || disabled.has(install.pluginId)
              ? "installation_disabled"
              : install.purgeRequested
                ? "purge_requested"
                : !install.ready
                  ? "installation_unavailable"
                  : this.operationRefusal(install, operationId);
          return [
            {
              runtime: {
                pluginId: install.pluginId,
                operationId,
                installationRevision: install.revision,
                artifactSha256: install.artifact,
                resourceBindingDigest: digest(this.operationBindings(install, operationId) ?? null),
              },
              ready: reason === null,
              reason,
            },
          ];
        }),
      ),
    };
  }
  configureServiceConfiguration(
    auth: AuthContext,
    args: { machineId: string; expectedRevision: string | null; policies: ServicePolicy[] },
    callerPluginId = "engine.services",
    traceId = "native-services",
  ): ServiceConfiguration {
    const current = this.configurationAuthority(auth, args.machineId);
    if (
      args.policies.some(
        (policy) =>
          policy.remote ||
          policy.runtime?.scope === "instance" ||
          this.instanceServices.get(policy.serviceId) !== null,
      )
    )
      throw new ServiceError("conflict", "native_instance_service_configuration_required");
    const configuration = ServiceConfigurationSchema.parse({
      revision: digest(args.policies),
      policies: args.policies,
    });
    this.store.transaction(() => {
      if (this.configuration(args.machineId).revision !== args.expectedRevision)
        throw new ServiceError("conflict", "service_configuration_changed");
      this.serviceTrace(current, callerPluginId, traceId, "configure", {
        machineId: args.machineId,
        previousRevision: args.expectedRevision,
        revision: configuration.revision,
        policies: configuration.policies.map((policy) => ({
          serviceId: policy.serviceId,
          revision: policy.revision,
          policySha256: digest(policy),
        })),
      });
      this.store.db
        .query(
          "INSERT INTO native_service_configurations(machine_id,revision,configuration) VALUES(?,?,?) ON CONFLICT(machine_id) DO UPDATE SET revision=excluded.revision,configuration=excluded.configuration",
        )
        .run(args.machineId, configuration.revision!, canonicalJobJson(configuration));
      this.effectiveServices.clear();
    });
    const live = this.channels.get(args.machineId);
    if (live?.proved && !this.synchronizeServices(live.channel)) this.offline(live.channel);
    this.reconcileAuthority();
    this.accessChanged();
    return configuration;
  }
  private synchronizeServices(channel: JobChannel): boolean {
    try {
      return channel.send({
        type: "job_command",
        command: {
          type: "configure_services",
          configuration: this.effectiveConfiguration(channel.machineId),
        },
      });
    } catch {
      return false;
    }
  }
  describeServices(
    auth: AuthContext,
    args: { machineId: string },
    _callerPluginId = "engine.services",
  ) {
    const current = this.auth.restoreCredential(this.auth.credentialReference(auth));
    if (!current || !this.store.getMachine(args.machineId)) fail();
    const live = this.channels.get(args.machineId);
    return {
      machineId: args.machineId,
      connected: live?.proved === true,
      services: this.effectiveConfiguration(args.machineId).policies.flatMap((policy) => {
        const operations = Object.entries(policy.operations).flatMap(([operationId, operation]) => {
          const ref: ManifoldRef = {
            kind: "service",
            machineId: args.machineId,
            serviceId: policy.serviceId,
            operationId,
          };
          if (
            !(["services:read", "services:invoke"] as const).some(
              (cap) =>
                (current.caps.includes("*") || current.caps.includes(cap)) &&
                this.auth.allowsRef(current, cap, ref),
            )
          )
            return [];
          const reason =
            this.serviceAvailability(policy, args.machineId, [operationId]) ??
            this.runtimeServiceRefusal(policy, args.machineId);
          return [
            {
              operationId,
              readable: !("kind" in operation) && operation.readable === true,
              invocable: !("kind" in operation) && operation.invocable === true,
              ready: reason === null,
              reason,
            },
          ];
        });
        return operations.length
          ? [
              {
                serviceId: policy.serviceId,
                revision: policy.revision,
                policySha256: digest(policy),
                operations,
              },
            ]
          : [];
      }),
    };
  }
  private serviceConsent(node: ManifoldRef, cap: Cap, policies?: ServicePolicy[]) {
    if (
      node.kind !== "service" ||
      (cap !== "services:read" && cap !== "services:invoke") ||
      !node.operationId ||
      !this.store.getMachine(node.machineId)
    )
      return null;
    const policy = (policies ?? this.effectiveConfiguration(node.machineId).policies).find(
      (policy) =>
        policy.serviceId === node.serviceId && Object.hasOwn(policy.operations, node.operationId!),
    );
    const operation = policy?.operations[node.operationId];
    if (
      cap === "services:read" &&
      (!operation ||
        "kind" in operation ||
        operation.readable !== true ||
        operation.method !== "GET" ||
        operation.response.kind !== "projected-json")
    )
      return null;
    return policy
      ? { node: formatManifoldUri(node), revision: policy.revision, artifactSha256: digest(policy) }
      : null;
  }
  private serviceAvailability(
    policy: ServicePolicy,
    machineId: string,
    operationIds: readonly string[],
  ): string | null {
    const live = this.channels.get(machineId);
    if (!live?.proved) return "resource_owner_unavailable";
    if (live.owner.resources?.services[policy.serviceId] !== digest(policy))
      return "service_unavailable";
    for (const ref of servicePolicyCredentialRefs(policy, operationIds)) {
      const source = live.owner.resources.credentialReferences?.find(
        (source) => source.ref === ref,
      );
      if (!source?.available || !policy.origin || !source.origins.includes(policy.origin))
        return "service_credential_unavailable";
    }
    const definition = live.owner.resources.serviceDefinitions[policy.serviceId];
    if (
      !definition ||
      definition.revision !== policy.revision ||
      operationIds.some((id) => !definition.operationIds.includes(id))
    )
      return "service_unavailable";
    return null;
  }
  private directServiceAuthority(
    credential: CredentialReference,
    args: ServiceReadArgs,
    channel: JobChannel,
    mode: "read" | "invoke",
  ) {
    const current = this.auth.restoreCredential(credential);
    const live = this.channels.get(args.machineId);
    if (!current || !live?.proved || live.channel !== channel) fail("service_unauthorized");
    const machine = this.store.getMachine(args.machineId);
    if (!machine || this.store.getToken(machine.tokenId)?.revokedAt !== null)
      fail("service_unavailable");
    const policy = this.effectiveConfiguration(args.machineId).policies.find(
      (policy) => policy.serviceId === args.serviceId,
    );
    const operation = policy?.operations[args.operationId];
    if (
      !policy ||
      policy.revision !== args.revision ||
      digest(policy) !== args.policySha256 ||
      live.owner.resources?.services[args.serviceId] !== args.policySha256
    )
      fail("service_binding_mismatch");
    if (
      !operation ||
      "kind" in operation ||
      operation.response.kind !== "projected-json" ||
      (mode === "read"
        ? operation.readable !== true || operation.method !== "GET"
        : operation.invocable !== true)
    )
      fail("service_unauthorized");
    const availability = this.serviceAvailability(policy, args.machineId, [args.operationId]);
    if (availability) fail(availability);
    const requirement: AuthorityRequirement = {
      cap: mode === "read" ? "services:read" : "services:invoke",
      ref: {
        kind: "service",
        machineId: args.machineId,
        serviceId: args.serviceId,
        operationId: args.operationId,
      },
    };
    if (
      (!current.caps.includes("*") && !current.caps.includes(requirement.cap)) ||
      !this.auth.allowsRef(current, requirement.cap, requirement.ref) ||
      !this.serviceConsent(requirement.ref, requirement.cap)
    )
      fail("service_unauthorized");
    return { current, requirement, operation };
  }
  private serviceTrace(
    current: AuthContext,
    callerPluginId: string,
    traceId: string,
    phase: string,
    metadata: Record<string, unknown>,
    allowed = true,
    mode: "read" | "invoke" = phase === "invoke" ? "invoke" : "read",
  ): void {
    if (!this.lifecycleRecorder) throw new Error("job_lifecycle_recorder_required");
    this.lifecycleRecorder({
      actor: current.principal.id,
      authority:
        phase === "configure" || phase === "configure-instance"
          ? "services:configure"
          : `services:${mode}`,
      door:
        phase === "configure"
          ? "engine.services.configureConfiguration"
          : phase === "configure-instance"
            ? "engine.services.configureInstance"
            : `engine.services.${mode}`,
      containerId: current.containerScope,
      session: null,
      ts: this.runtime.now(),
      outcome: allowed ? "ok" : "forbidden",
      targets: [],
      payload: { serviceLifecycle: phase, callerPluginId, parentTrace: traceId, ...metadata },
    });
  }
  private authorizeDirectService(
    pending: {
      mode: "read" | "invoke";
      channel: JobChannel;
      args: ServiceReadArgs;
      credential: CredentialReference;
      callerPluginId: string;
      traceId: string;
    },
    requestId: string,
    phase: string,
  ): void {
    this.store.transaction(() => {
      const { current, requirement } = this.directServiceAuthority(
        pending.credential,
        pending.args,
        pending.channel,
        pending.mode,
      );
      const decision = this.decide({
        credential: pending.credential,
        pluginId: pending.callerPluginId,
        action: `engine.services.${pending.mode}`,
        evidence: [this.auth.explain(current, requirement)],
      });
      const { machineId, serviceId, revision, policySha256, operationId } = pending.args;
      this.serviceTrace(
        current,
        pending.callerPluginId,
        pending.traceId,
        phase,
        {
          requestId,
          machineId,
          serviceId,
          revision,
          policySha256,
          operationId,
          decisionId: decision.decisionId,
        },
        decision.allowed,
        pending.mode,
      );
      if (!decision.allowed) fail("service_unauthorized");
    });
  }
  async readService(
    auth: AuthContext,
    raw: ServiceReadArgs,
    callerPluginId = "engine.services",
    traceId = "native-services",
  ): Promise<ServiceReply> {
    return this.directService(
      auth,
      ServiceReadArgsSchema.parse(raw),
      "read",
      callerPluginId,
      traceId,
    );
  }
  async invokeService(
    auth: AuthContext,
    raw: ServiceInvokeArgs,
    callerPluginId = "engine.services",
    traceId = "native-services",
  ): Promise<ServiceReply> {
    return this.directService(
      auth,
      ServiceInvokeArgsSchema.parse(raw),
      "invoke",
      callerPluginId,
      traceId,
    );
  }
  private directService(
    auth: AuthContext,
    args: ServiceReadArgs,
    mode: "read" | "invoke",
    callerPluginId: string,
    traceId: string,
  ): Promise<ServiceReply> {
    const live = this.channels.get(args.machineId);
    if (!live?.proved) return Promise.reject(new ServiceError("conflict", "service_unavailable"));
    const credential = this.auth.credentialReference(auth);
    const { operation } = this.directServiceAuthority(credential, args, live.channel, mode);
    if (this.directServiceCalls.size >= 256)
      return Promise.reject(new ServiceError("conflict", "service_busy"));
    const requestId = randomUUID();
    const { promise, resolve, reject } = Promise.withResolvers<ServiceReply>();
    const timer = setTimeout(
      () => pending.finish(new ServiceError("conflict", "service_timeout")),
      Math.min(operation.timeoutMs + 5000, 305000),
    );
    const pending = {
      mode,
      channel: live.channel,
      args,
      credential,
      callerPluginId,
      traceId,
      authorized: false,
      finish: (error?: Error, reply?: ServiceReply) => {
        if (this.directServiceCalls.get(requestId) !== pending) return;
        this.directServiceCalls.delete(requestId);
        clearTimeout(timer);
        if (error) {
          try {
            live.channel.send({
              type: "job_command",
              command: {
                type: mode === "read" ? "service_read_cancel" : "service_invoke_cancel",
                requestId,
              },
            });
          } catch {
            /* A lost channel cannot acknowledge cancellation. */
          }
          reject(error);
        } else if (reply) resolve(reply);
        else reject(new ServiceError("conflict", "service_unconfirmed"));
      },
    };
    this.directServiceCalls.set(requestId, pending);
    try {
      if (!this.synchronizeServices(live.channel))
        throw new ServiceError("conflict", "service_unavailable");
      this.authorizeDirectService(pending, requestId, "dispatch");
      if (
        !live.channel.send({
          type: "job_command",
          command: {
            type: mode === "read" ? "service_read" : "service_invoke",
            requestId,
            ...args,
          },
        })
      )
        pending.finish(new ServiceError("conflict", "service_unavailable"));
    } catch (error) {
      pending.finish(
        error instanceof ServiceError ? error : new ServiceError("conflict", "service_unavailable"),
      );
    }
    return promise;
  }
  private platform(install: JobInstallation): keyof MachineHalf["artifacts"] {
    const platform = Object.entries(install.machine.artifacts).find(
      ([platform, artifact]) =>
        artifact.sha256 === install.artifact &&
        (this.channels
          .get(install.machineId)
          ?.owner.platforms.some((value) => value === platform) ??
          true),
    )?.[0];
    if (!platform) fail("installation_platform_unavailable");
    return platform as keyof MachineHalf["artifacts"];
  }
  private operationBindings(
    install: JobInstallation,
    operationId: string,
  ): JobResourceBindings | undefined {
    return jobResourceBindingsFor(
      install.machine,
      operationId,
      this.platform(install),
      install.resourceBindings,
    );
  }
  private boundServicePolicy(
    install: JobInstallation,
    binding: ServiceBinding,
  ): ServicePolicy | undefined {
    const policy = this.effectiveConfiguration(install.machineId).policies.find(
      (policy) => policy.serviceId === binding.serviceId,
    );
    if (
      !policy ||
      policy.revision !== binding.revision ||
      install.resourceBindings?.services[binding.serviceId] !== digest(policy) ||
      binding.operationIds.some((id) => !Object.hasOwn(policy.operations, id))
    )
      return undefined;
    return policy;
  }

  private resourceRefusal(install: JobInstallation, operationId: string): string | null {
    const live = this.channels.get(install.machineId);
    const refusal = jobResourceRefusal(
      install.machine,
      operationId,
      this.platform(install),
      install.resourceBindings,
      live?.proved ? live.owner.resources : undefined,
    );
    if (refusal) return refusal;
    for (const binding of install.machine.operations[operationId]?.services ?? []) {
      const policy = this.boundServicePolicy(install, binding);
      if (!policy) return "service_definition_changed";
      const availability = this.serviceAvailability(
        policy,
        install.machineId,
        binding.operationIds,
      );
      if (availability) return availability;
      const runtimeReason = this.runtimeServiceRefusal(
        policy,
        install.machineId,
        install,
        operationId,
      );
      if (runtimeReason) return runtimeReason;
    }
    const report = this.installationResources.get(`${install.machineId}/${install.pluginId}`);
    if (
      report?.channel === live?.channel &&
      report?.revision === install.revision &&
      report.artifact === install.artifact
    ) {
      const operation = report.resources.operations.find(
        (value) => value.operationId === operationId,
      );
      if (!operation?.available) return operation?.reason ?? "operation_artifact_unavailable";
    }
    return null;
  }
  private operationRefusal(install: JobInstallation, operationId: string): string | null {
    if (
      !install.enabled ||
      install.purgeRequested ||
      this.store.disabledPlugins().has(install.pluginId)
    )
      return "installation_disabled";
    const live = this.channels.get(install.machineId);
    if (!live?.proved) return "resource_owner_unavailable";
    const resourceReason = this.resourceRefusal(install, operationId);
    if (resourceReason) return resourceReason;
    if (!install.ready) return "operation_resources_unreported";
    const report = this.installationResources.get(`${install.machineId}/${install.pluginId}`);
    if (
      report?.channel === live.channel &&
      report.revision === install.revision &&
      report.artifact === install.artifact
    ) {
      const operation = report.resources.operations.find(
        (value) => value.operationId === operationId,
      );
      return operation?.available ? null : (operation?.reason ?? "operation_artifact_unavailable");
    }
    return install.ready &&
      !install.machine.requiresResourceBindings &&
      !Object.keys(install.machine.tools ?? {}).length
      ? null
      : "operation_resources_unreported";
  }
  private runtimeInstallation(policy: ServicePolicy, machineId: string): JobInstallation | null {
    const runtime = policy.runtime;
    if (!runtime) return null;
    const callee = this.jobs.installation(machineId, runtime.pluginId);
    if (
      !callee ||
      !callee.enabled ||
      callee.purgeRequested ||
      this.store.disabledPlugins().has(runtime.pluginId) ||
      callee.revision !== runtime.installationRevision ||
      callee.artifact !== runtime.artifactSha256 ||
      !callee.machine.operations[runtime.operationId]?.providesService ||
      digest(this.operationBindings(callee, runtime.operationId) ?? null) !==
        runtime.resourceBindingDigest
    )
      return null;
    return callee;
  }
  private runtimeServiceRefusal(
    policy: ServicePolicy,
    machineId: string,
    caller?: JobInstallation,
    callerOperationId?: string,
    visiting: ReadonlySet<string> = new Set(),
  ): string | null {
    if (policy.remote) {
      const remote = policy.remote;
      const record = this.instanceServices.get(remote.serviceId);
      if (
        !record?.enabled ||
        record.machineId !== remote.machineId ||
        record.machineId === machineId ||
        record.revision !== remote.revision ||
        digest(this.instancePolicy(record)) !== remote.policySha256
      )
        return "service_definition_changed";
      return this.runtimeServiceRefusal(
        this.instancePolicy(record),
        record.machineId,
        undefined,
        undefined,
        visiting,
      );
    }
    const runtime = policy.runtime;
    if (!runtime) return null;
    if (visiting.has(policy.serviceId) || visiting.size >= 8) return "service_runtime_unavailable";
    const next = new Set(visiting).add(policy.serviceId);
    const callee = this.runtimeInstallation(policy, machineId);
    if (!callee) return "service_runtime_changed";
    const live = this.channels.get(machineId);
    if (!live?.proved || !callee.ready) return "service_runtime_unavailable";
    const resourceReason = jobResourceRefusal(
      callee.machine,
      runtime.operationId,
      this.platform(callee),
      callee.resourceBindings,
      live.owner.resources,
    );
    if (resourceReason) return resourceReason;
    for (const binding of callee.machine.operations[runtime.operationId]?.services ?? []) {
      const dependency = this.effectiveConfiguration(machineId).policies.find(
        (policy) => policy.serviceId === binding.serviceId,
      );
      if (
        !dependency ||
        dependency.revision !== binding.revision ||
        callee.resourceBindings?.services[binding.serviceId] !== digest(dependency)
      )
        return "service_definition_changed";
      const reason =
        this.serviceAvailability(dependency, machineId, binding.operationIds) ??
        this.runtimeServiceRefusal(dependency, machineId, callee, runtime.operationId, next);
      if (reason) return reason;
    }
    const report = this.installationResources.get(`${machineId}/${runtime.pluginId}`);
    if (
      report?.channel !== live.channel ||
      report.revision !== callee.revision ||
      report.artifact !== callee.artifact ||
      !report.resources.operations.some(
        (operation) => operation.operationId === runtime.operationId && operation.available,
      )
    )
      return "service_runtime_unavailable";
    if (runtime.scope === "instance") {
      const record = this.instanceServices.get(policy.serviceId);
      if (
        !record ||
        record.machineId !== machineId ||
        record.policy.revision !== policy.revision ||
        digest(this.instancePolicy(record)) !== digest(policy)
      )
        return "service_definition_changed";
      return this.instanceReason(record);
    }
    const edges = this.store.db
      .query<{ edge: string }, []>("SELECT edge FROM job_invocation_edges WHERE enabled=1")
      .all();
    const matching = edges.some((row) => {
      const edge = JSON.parse(row.edge) as JobInvocationEdge;
      if (callerOperationId !== undefined && edge.caller.operationId !== callerOperationId)
        return false;
      if (
        edge.callee.machineId !== machineId ||
        edge.callee.pluginId !== runtime.pluginId ||
        edge.callee.operationId !== runtime.operationId ||
        edge.callee.installationRevision !== runtime.installationRevision ||
        edge.callee.artifactSha256 !== runtime.artifactSha256
      )
        return false;
      const source = caller ?? this.jobs.installation(machineId, edge.caller.pluginId);
      return (
        source !== null &&
        source.machineId === machineId &&
        source.pluginId === edge.caller.pluginId &&
        source.revision === edge.caller.installationRevision &&
        source.artifact === edge.caller.artifactSha256 &&
        source.enabled &&
        !source.purgeRequested &&
        !this.store.disabledPlugins().has(source.pluginId) &&
        source.machine.operations[edge.caller.operationId]?.services?.some(
          (binding) =>
            binding.serviceId === policy.serviceId && binding.revision === policy.revision,
        ) === true
      );
    });
    return matching ? null : "service_runtime_edge_missing";
  }
  private authorizeJobService(
    channel: JobChannel,
    event: Extract<JobEvent, { type: "service_authorize" }>,
  ): boolean {
    if (event.subject.kind !== "job") return false;
    const job = this.jobs.get(event.subject.jobId);
    if (!job || job.state !== "started" || !this.inputOwner(job, channel)) return false;
    const policy = this.effectiveConfiguration(channel.machineId).policies.find(
      (policy) => policy.serviceId === event.serviceId,
    );
    const install = this.jobs.installation(channel.machineId, job.request.pluginId);
    const binding = install?.machine.operations[job.request.operationId]?.services?.find(
      (binding) =>
        binding.serviceId === event.serviceId &&
        binding.revision === event.revision &&
        binding.operationIds.includes(event.operationId),
    );
    let refusal =
      !policy ||
      policy.revision !== event.revision ||
      digest(policy) !== event.policySha256 ||
      !Object.hasOwn(policy.operations, event.operationId) ||
      !binding ||
      job.request.resourceBindings?.services[event.serviceId] !== event.policySha256
        ? "service_binding_mismatch"
        : (this.serviceAvailability(policy, channel.machineId, [event.operationId]) ??
          this.runtimeServiceRefusal(
            policy,
            channel.machineId,
            install ?? undefined,
            job.request.operationId,
          ));
    let ancestor: JobRecord | null = job;
    for (let depth = 0; ancestor && refusal === null; depth++) {
      if (depth >= 64) {
        refusal = "invocation_depth";
        break;
      }
      refusal =
        this.jobs.cancellation(ancestor.request.jobId) ??
        this.reauthorizeDeferred(ancestor.request) ??
        this.invocationRefusal(ancestor.request);
      ancestor = ancestor.request.parent
        ? this.jobs.get(ancestor.request.parent.parentJobId)
        : null;
    }
    const current = this.auth.restoreCredential(job.request.credential);
    const requirement: AuthorityRequirement = {
      cap: "services:invoke",
      ref: {
        kind: "service",
        machineId: channel.machineId,
        serviceId: event.serviceId,
        operationId: event.operationId,
      },
    };
    const requirements = [requirement];
    if (policy?.remote)
      requirements.push({
        cap: "services:invoke",
        ref: {
          kind: "service",
          machineId: policy.remote.machineId,
          serviceId: policy.remote.serviceId,
          operationId: event.operationId,
        },
      });
    return this.store.transaction(() => {
      const decision = this.decide(
        {
          credential: job.request.credential,
          pluginId: job.request.pluginId,
          action: "engine.services.invoke",
          evidence: requirements.map((requirement) =>
            current
              ? this.auth.explain(current, requirement)
              : { requirement, winner: null, allowed: false },
          ),
        },
        refusal,
      );
      if (current)
        this.serviceTrace(
          current,
          job.request.pluginId,
          job.request.traceId,
          "invoke",
          {
            jobId: job.request.jobId,
            authorizationId: event.authorizationId,
            machineId: channel.machineId,
            serviceId: event.serviceId,
            revision: event.revision,
            policySha256: event.policySha256,
            operationId: event.operationId,
            decisionId: decision.decisionId,
          },
          decision.allowed,
        );
      return decision.allowed;
    });
  }
  private readonly inputSync = new Map<string, JobChannel>();
  private readonly inputs = new Map<
    string,
    {
      channel: JobChannel;
      requestId: string;
      seq: number;
      authorized: boolean;
      auth: AuthContext;
      node: ManifoldRef;
      callerPluginId: string;
      finish(error?: Error): void;
    }
  >();
  setChangeNotifier(notify: JobChanges): void {
    this.changeNotifier = notify;
  }

  private changed(request: JobRequest): void {
    const node = {
      kind: "job" as const,
      jobId: request.jobId,
      machineId: request.machineId,
      operationId: request.operationId,
    };
    this.store.afterCommit(() => this.changeNotifier?.run(node, request.credential.principalId));
  }

  private accessChanged(): void {
    this.store.afterCommit(() => this.changeNotifier?.access());
  }

  /** The same metadata-only projection serves execution, status and retained discovery. */
  publicJob(record: JobRecord): PublicJob {
    const { jobId, machineId, operationId, pluginId, installationRevision, artifactSha256 } =
      record.request;
    return {
      jobId,
      machineId,
      operationId,
      pluginId,
      installationRevision,
      artifactSha256,
      inputDigest: digest(record.request.input),
      resourceBindingDigest: digest(record.request.resourceBindings ?? null),
      state: record.state,
      nextInputSeq:
        this.inputSync.get(jobId) === this.channels.get(machineId)?.channel &&
        this.channels.get(machineId)?.proved &&
        !this.inputs.has(jobId)
          ? record.nextInputSeq
          : null,
      result: record.result,
      authority: this.jobs.authority(record),
      ...(record.request.terminal ? { terminal: record.request.terminal } : {}),
    };
  }

  listRuns(
    auth: AuthContext,
    pluginId: string,
    args: ListJobRunsArgs,
    callerPluginId = "engine.jobs",
  ): ListJobRunsResult {
    const current = this.auth.restoreCredential(this.auth.credentialReference(auth));
    if (!current || (!current.caps.includes("*") && !current.caps.includes("jobs:read")))
      fail("governed_authority_refused");
    if (callerPluginId !== "engine.jobs" && callerPluginId !== pluginId) fail("job_owner_mismatch");
    const parsed = ListJobRunsArgsSchema.parse(args);
    const filter = {
      pluginId,
      machineId: parsed.machineId,
      operationId: parsed.operationId ?? null,
    };
    let before: JobRunPosition | undefined;
    if (parsed.cursor !== undefined) {
      try {
        if (!/^[A-Za-z0-9_-]+$/.test(parsed.cursor)) throw new Error("invalid cursor");
        const bytes = Buffer.from(parsed.cursor, "base64url");
        if (bytes.length < 29 || bytes.toString("base64url") !== parsed.cursor)
          throw new Error("invalid cursor");
        const decipher = createDecipheriv("aes-256-gcm", this.runCursorKey, bytes.subarray(0, 12));
        decipher.setAuthTag(bytes.subarray(12, 28));
        const value = runCursorSchema.parse(
          JSON.parse(
            Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8"),
          ),
        );
        if (canonicalJobJson(value.filter) !== canonicalJobJson(filter))
          throw new Error("cursor filter mismatch");
        before = value.before;
      } catch {
        throw new ServiceError("conflict", "invalid_job_run_cursor_refresh_required");
      }
    }
    const candidates = this.jobs.runCandidates(
      {
        pluginId,
        machineId: parsed.machineId,
        ...(parsed.operationId === undefined ? {} : { operationId: parsed.operationId }),
        ...(before === undefined ? {} : { before }),
      },
      257,
    );
    const runs: PublicJobRun[] = [];
    const limit = parsed.limit ?? 50;
    let scanned = 0;
    while (scanned < candidates.length && scanned < 256 && runs.length < limit) {
      const candidate = candidates[scanned++]!;
      const request = candidate.request;
      const node = {
        kind: "job" as const,
        jobId: request.jobId,
        machineId: request.machineId,
        operationId: request.operationId,
      };
      if (!this.canReadGoverned(current, node, callerPluginId)) continue;
      const occurrence = candidate.occurrence;
      runs.push({
        job: candidate.job === null ? null : this.publicJob(candidate.job),
        occurrence:
          occurrence === null
            ? null
            : {
                scheduleId: occurrence.schedule_id,
                revision: occurrence.revision,
                nominalAt: occurrence.nominal,
                jobId: request.jobId,
                machineId: request.machineId,
                pluginId: request.pluginId,
                operationId: request.operationId,
                installationRevision: request.installationRevision,
                artifactSha256: request.artifactSha256,
                state: PublicScheduleOccurrenceSchema.shape.state.parse(occurrence.state),
                reason: occurrence.reason,
              },
      });
    }
    let nextCursor: string | null = null;
    if (scanned < candidates.length && scanned > 0) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", this.runCursorKey, nonce);
      const encrypted = Buffer.concat([
        cipher.update(JSON.stringify({ filter, before: candidates[scanned - 1]!.position })),
        cipher.final(),
      ]);
      nextCursor = Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString("base64url");
    }
    return ListJobRunsResultSchema.parse({ runs, nextCursor });
  }
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
        ...(job.request.terminal ? { terminal: job.request.terminal } : {}),
        ...authority,
        state: job.state,
        ...(phase === "result" ? { exitCode: job.result?.exitCode ?? null } : {}),
      },
    });
    this.changed(job.request);
  }

  describe(
    auth: AuthContext,
    args: { machineId: string; pluginId: string; installationRevision?: string | undefined },
    callerPluginId = "engine.jobs",
  ): JobDescription {
    const current = this.auth.restoreCredential(this.auth.credentialReference(auth));
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
    const operations = Object.fromEntries(
      Object.keys(install?.machine.operations ?? {}).map((operationId) => {
        const reason = install ? this.operationRefusal(install, operationId) : "unknown_operation";
        return [
          operationId,
          {
            ready: reason === null,
            reason,
            resourceBindingDigest: digest(
              install ? (this.operationBindings(install, operationId) ?? null) : null,
            ),
          },
        ];
      }),
    );
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
    const visibleServices =
      connected && !current.isRoot ? this.describeServices(current, args).services : [];
    return {
      machineId: args.machineId,
      pluginId: args.pluginId,
      admissionPublicKey: this.admissionPublicKey,
      connected,
      platforms: connected ? [...live.owner.platforms] : [],
      ...(connected && live.owner.resources
        ? {
            resources: current.isRoot
              ? live.owner.resources
              : {
                  tools: live.owner.resources.tools,
                  anchors: live.owner.resources.anchors,
                  services: Object.fromEntries(
                    visibleServices.map((service) => [service.serviceId, service.policySha256]),
                  ),
                  serviceDefinitions: Object.fromEntries(
                    visibleServices.map((service) => [
                      service.serviceId,
                      {
                        revision: service.revision,
                        operationIds: service.operations
                          .filter((operation) => operation.ready)
                          .map((operation) => operation.operationId),
                      },
                    ]),
                  ),
                },
          }
        : {}),
      operations,
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
              ...(install.resourceBindings ? { resourceBindings: install.resourceBindings } : {}),
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
    const context = this.auth.restoreCredential(request.credential);
    if (!context) return "credential_revoked_or_expired";
    try {
      const requirements = this.requirements(request);
      const policies = requirements.some((requirement) => requirement.ref.kind === "service")
        ? this.effectiveConfiguration(request.machineId).policies
        : [];
      for (const { cap, ref } of requirements) {
        const terminalSpawn = cap === "terminals:spawn" && ref.kind === "container";
        const install = ref.kind === "service" ? null : this.resolve(ref);
        if (
          (!context.caps.includes("*") && !context.caps.includes(cap)) ||
          !this.auth.allowsRef(context, cap, ref) ||
          (!terminalSpawn &&
            !(
              this.serviceConsent(ref, cap, policies) ??
              (install ? this.consentFor(install, ref, cap) : null)
            ))
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
    const context = this.auth.restoreCredential(this.auth.credentialReference(auth));
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
    const context = this.auth.restoreCredential(this.auth.credentialReference(auth));
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
    if (
      (!context.caps.includes("*") && !context.caps.includes("machines:run")) ||
      !this.auth.allowsRef(context, "machines:run", node)
    )
      fail();
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
    for (const serviceId of [...this.instanceStarts]) this.ensureInstanceService(serviceId);
  }

  private reconcileAuthority(): void {
    for (const tunnel of this.serviceTunnels.values())
      if (!this.serviceTunnelCurrent(tunnel)) this.closeServiceTunnel(tunnel);
    for (const pending of [...this.directServiceCalls.values()]) {
      try {
        this.directServiceAuthority(
          pending.credential,
          pending.args,
          pending.channel,
          pending.mode,
        );
      } catch {
        pending.finish(new ServiceError("forbidden", "service_unauthorized"));
      }
    }
    for (const job of this.jobs.reconcilable()) {
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

  inspectInvocations(
    auth: AuthContext,
    args: { machineId: string; pluginId: string },
  ): InspectJobInvocationsResult {
    if (!this.auth.restoreCredential(this.auth.credentialReference(auth))?.isRoot) fail();
    const result: InspectJobInvocationsResult = {
      ...args,
      candidates: [],
      unavailable: [],
      edges: [],
    };
    for (const row of this.store.db
      .query<{ edge: string; enabled: number }, [string, string]>(
        "SELECT edge,enabled FROM job_invocation_edges WHERE json_extract(caller,'$.machineId')=? AND json_extract(caller,'$.pluginId')=? ORDER BY caller,operation_id",
      )
      .all(args.machineId, args.pluginId)) {
      const edge = JobInvocationEdgeSchema.parse(JSON.parse(row.edge));
      if (edge.caller.machineId === args.machineId && edge.caller.pluginId === args.pluginId)
        result.edges.push({ edge, enabled: row.enabled === 1 });
    }
    const caller = this.jobs.installation(args.machineId, args.pluginId);
    if (!caller) return result;
    const policies = this.effectiveConfiguration(args.machineId).policies;
    for (const [operationId, operation] of Object.entries(caller.machine.operations)) {
      const callerRef: JobInvocationEdge["caller"] = {
        machineId: caller.machineId,
        pluginId: caller.pluginId,
        operationId,
        installationRevision: caller.revision,
        artifactSha256: caller.artifact,
      };
      for (const binding of operation.services ?? []) {
        const policy = policies.find((policy) => policy.serviceId === binding.serviceId);
        let reason: string | null = null;
        if (
          !caller.enabled ||
          caller.purgeRequested ||
          this.store.disabledPlugins().has(caller.pluginId)
        )
          reason = "installation_disabled";
        else if (
          !policy ||
          policy.revision !== binding.revision ||
          caller.resourceBindings?.services[binding.serviceId] !== digest(policy) ||
          binding.operationIds.some((id) => !Object.hasOwn(policy.operations, id))
        )
          reason = "service_definition_changed";
        if (reason) {
          result.unavailable.push({
            caller: callerRef,
            serviceId: binding.serviceId,
            revision: binding.revision,
            reason,
          });
          continue;
        }
        if (!policy?.runtime) continue;
        let callee: JobInstallation | null;
        try {
          callee = this.runtimeInstallation(policy, args.machineId);
        } catch (error) {
          if (!(error instanceof ServiceError)) throw error;
          result.unavailable.push({
            caller: callerRef,
            serviceId: binding.serviceId,
            revision: binding.revision,
            reason: "service_runtime_unavailable",
          });
          continue;
        }
        if (!callee) {
          result.unavailable.push({
            caller: callerRef,
            serviceId: binding.serviceId,
            revision: binding.revision,
            reason: "service_runtime_changed",
          });
          continue;
        }
        const calleeOperation = callee.machine.operations[policy.runtime.operationId]!;
        result.candidates.push({
          serviceId: binding.serviceId,
          revision: binding.revision,
          operationIds: binding.operationIds,
          policySha256: digest(policy),
          caller: callerRef,
          callee: {
            machineId: callee.machineId,
            pluginId: callee.pluginId,
            operationId: policy.runtime.operationId,
            installationRevision: callee.revision,
            artifactSha256: callee.artifact,
          },
          resources: calleeOperation.locations.map((resource) => ({
            ...resource,
            revision: callee.machine.locations[resource.locationId]!.revision,
          })),
          callerLimits: operation.limits,
          calleeLimits: calleeOperation.limits,
          locations: Object.fromEntries(
            calleeOperation.locations.map((resource) => [
              resource.locationId,
              callee.machine.locations[resource.locationId]!,
            ]),
          ),
          outputNames: calleeOperation.outputs,
          outputLocations: Object.fromEntries(
            operation.locations
              .filter(
                (resource) =>
                  resource.access !== "read" &&
                  caller.machine.locations[resource.locationId]?.kind !== "file",
              )
              .map((resource) => [
                resource.locationId,
                caller.machine.locations[resource.locationId]!,
              ]),
          ),
        });
      }
    }
    return result;
  }

  setInvocationEdge(auth: AuthContext, args: { edge: JobInvocationEdge; enabled: boolean }): void {
    if (!this.auth.restoreCredential(this.auth.credentialReference(auth))?.isRoot) fail();
    const edge = JobInvocationEdgeSchema.parse(args.edge);
    const { enabled } = args;
    if (enabled) this.validateInvocationEdge(edge);
    this.store.transaction(() => {
      if (!enabled) {
        // Revocation must remain possible after either installation changes. It cannot
        // replace a newer approval under the same durable caller/operation key.
        const stored = this.store.db
          .query<{ edge: string }, [string, string]>(
            "SELECT edge FROM job_invocation_edges WHERE caller=? AND operation_id=?",
          )
          .get(canonicalJobJson(edge.caller), edge.callee.operationId);
        if (!stored || canonicalJobJson(JSON.parse(stored.edge)) !== canonicalJobJson(edge))
          fail("invocation_edge_changed");
      }
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
    this.accessChanged();
  }

  private validateInvocationEdge(edge: JobInvocationEdge): void {
    for (const bound of [edge.maxDepth, edge.maxConcurrency, ...Object.values(edge.aggregate)])
      if (!Number.isSafeInteger(bound) || bound < 1) fail("invalid_invocation_bound");
    if (edge.caller.machineId !== edge.callee.machineId) fail("invocation_cross_host");
    for (const target of [edge.caller, edge.callee]) {
      const install = this.jobs.installation(target.machineId, target.pluginId);
      if (
        !install?.enabled ||
        install.purgeRequested ||
        this.store.disabledPlugins().has(target.pluginId) ||
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
    const context = this.auth.restoreCredential(parent.request.credential);
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
  private bundleResolver: ((pluginId: string) => PluginBundle | null) | null = null;
  setBundleResolver(resolver: (pluginId: string) => PluginBundle | null): void {
    this.bundleResolver = resolver;
  }
  private artifactDelivery(
    pluginId: string,
    machine: MachineHalf,
    sha256: string,
    platforms?: readonly string[],
  ): Pick<Extract<JobCommand, { type: "install" }>, "artifact" | "toolArtifacts"> | null {
    const candidates = Object.entries(machine.artifacts).filter(
      ([platform, artifact]) =>
        artifact.sha256 === sha256 && (!platforms?.length || platforms.includes(platform)),
    );
    if (!candidates.length) return null;
    // A primary digest alone cannot choose different platform-specific tool closures.
    const selections = candidates.map(([platform, primary]) => ({
      primary,
      tools: Object.values(machine.tools ?? {}).flatMap((tools) => {
        const tool = tools[platform as keyof typeof tools];
        return tool ? [tool] : [];
      }),
    }));
    if (selections.some((selection) => digest(selection) !== digest(selections[0])))
      fail("artifact_source_ambiguous");
    const { primary, tools } = selections[0]!;
    const specs = [primary, ...tools];
    if (!specs.some((spec) => spec.bundleFile !== undefined)) return {};
    const bundle = this.bundleResolver?.(pluginId);
    if (
      !bundle ||
      bundle.manifest.id !== pluginId ||
      digest(bundle.manifest.machine) !== digest(machine)
    )
      return null;
    let artifact: JobArtifactDelivery | undefined;
    const toolArtifacts: Record<string, string> = Object.create(null);
    for (const spec of specs) {
      if (!spec.bundleFile) continue;
      const data = bundle.files[spec.bundleFile];
      if (data === undefined) return null;
      const delivery = { bundleFile: spec.bundleFile, data };
      deliveredArtifact(spec, delivery);
      if (spec === primary) artifact = delivery;
      else if (artifact?.bundleFile !== spec.bundleFile) toolArtifacts[spec.bundleFile] = data;
    }
    return {
      ...(artifact ? { artifact } : {}),
      ...(Object.keys(toolArtifacts).length ? { toolArtifacts } : {}),
    };
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
    serviceOwnerMachineId?: string,
  ) {
    this.jobs = new JobStore(store, (job, phase) => this.lifecycle(job, phase));
    this.instanceServices = new InstanceServiceStore(store, auth, runtime, serviceOwnerMachineId);
    store.db
      .query(
        "UPDATE machine_job_inputs SET state='unknown',reason='job_input_delivery_unknown' WHERE state='pending'",
      )
      .run();
    this.jobSchedules = new JobSchedules(store);
    this.jobSchedules.setChangeNotifier((request) => this.changed(request));
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
    auth.onAuthorityChanged(() => {
      this.reconcileAuthority();
      this.accessChanged();
    });
    auth.onRevoked((principalId) => {
      for (const pending of [...this.directServiceCalls.values()]) {
        const machine = this.store.getMachine(pending.args.machineId);
        if (
          pending.credential.principalId === principalId ||
          (machine && this.store.getToken(machine.tokenId)?.principalId === principalId)
        )
          pending.finish(new ServiceError("forbidden", "service_unauthorized"));
      }
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
  private retainedRequest(jobId: string): JobRequest | null {
    const job = this.jobs.get(jobId);
    if (job) return job.request;
    const occurrence = this.jobSchedules.getOccurrence(jobId);
    return occurrence ? JobRequestSchema.parse(JSON.parse(occurrence.request)) : null;
  }

  private resolve(node: ManifoldRef): JobInstallation | null {
    if (!("machineId" in node) || !this.store.getMachine(node.machineId)) return null;
    if (node.kind === "job" || node.kind === "output") {
      const request = this.retainedRequest(node.jobId);
      if (
        !request ||
        request.machineId !== node.machineId ||
        request.operationId !== node.operationId
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
        request.pluginId,
        request.installationRevision,
      );
      return install?.artifact === request.artifactSha256 ? install : null;
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
    if (node.kind === "service") {
      const current = this.auth.restoreCredential(this.auth.credentialReference(auth));
      const policy = this.effectiveConfiguration(node.machineId).policies.find(
        (policy) => policy.serviceId === node.serviceId,
      );
      return (
        current !== null &&
        policy !== undefined &&
        (node.operationId === undefined || Object.hasOwn(policy.operations, node.operationId)) &&
        (["services:read", "services:invoke"] as const).some(
          (cap) =>
            (current.caps.includes("*") || current.caps.includes(cap)) &&
            this.auth.allowsRef(current, cap, node),
        )
      );
    }
    const cap =
      node.kind === "job" || node.kind === "output"
        ? "jobs:read"
        : node.kind === "location"
          ? "locations:read"
          : node.kind === "operation"
            ? "operations:invoke"
            : null;
    if (cap === null) return true;
    const current = this.auth.restoreCredential(this.auth.credentialReference(auth));
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
      const context = this.auth.restoreCredential(request.credential);
      let allowed = context !== null && request.evidence.length > 0 && refusal === null;
      const consents: { node: string; revision: string; artifactSha256: string }[] = [];
      const evidence: unknown[] = [];
      const servicePolicies = new Map<string, ServicePolicy[]>();
      for (const prior of request.evidence) {
        const { cap, ref } = prior.requirement;
        let policies: ServicePolicy[] | undefined;
        if (ref.kind === "service") {
          policies = servicePolicies.get(ref.machineId);
          if (!policies) {
            policies = this.effectiveConfiguration(ref.machineId).policies;
            servicePolicies.set(ref.machineId, policies);
          }
        }
        const terminalSpawn = cap === "terminals:spawn" && ref.kind === "container";
        const install = ref.kind === "service" ? null : this.resolve(ref);
        const fresh = context
          ? this.auth.explain(context, prior.requirement)
          : { ...prior, winner: null, allowed: false };
        const consent =
          this.serviceConsent(ref, cap, policies) ??
          (install ? this.consentFor(install, ref, cap) : null);
        const discharged =
          context !== null &&
          (terminalSpawn || install !== null || (ref.kind === "service" && consent !== null)) &&
          (context.caps.includes("*") || context.caps.includes(cap)) &&
          fresh.allowed &&
          (terminalSpawn || consent !== null);
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
      resourceBindings?: JobResourceBindings | undefined;
      machine: MachineHalf;
    },
  ): void {
    if (!auth.isRoot || !this.auth.restoreCredential(this.auth.credentialReference(auth))) fail();
    const machine = MachineHalfSchema.parse(args.machine);
    if (
      !this.store.getMachine(args.machineId) ||
      !Object.values(machine.artifacts).some((a) => a.sha256 === args.artifactSha256)
    )
      fail();
    const declared = this.declaredMachine(args.pluginId);
    if (declared === null || digest(declared) !== digest(machine))
      fail("manifest_declaration_mismatch");
    const delivery = this.artifactDelivery(
      args.pluginId,
      machine,
      args.artifactSha256,
      this.channels.get(args.machineId)?.owner.platforms,
    );
    if (delivery === null) fail("artifact_bundle_unavailable");
    const resourceBindings =
      args.resourceBindings === undefined
        ? undefined
        : JobResourceBindingsSchema.parse(args.resourceBindings);
    if (resourceBindings) {
      const live = this.channels.get(args.machineId);
      if (!live?.proved || !live.owner.resources) fail("resource_owner_unavailable");
      for (const group of ["tools", "services", "anchors"] as const)
        for (const [key, value] of Object.entries(resourceBindings[group]))
          if (live.owner.resources[group][key] !== value) fail("resource_revision_changed");
      const policies = this.effectiveConfiguration(args.machineId).policies;
      for (const [serviceId, value] of Object.entries(resourceBindings.services)) {
        const policy = policies.find((policy) => policy.serviceId === serviceId);
        if (!policy || digest(policy) !== value) fail("resource_revision_changed");
      }
    } else if (
      machine.requiresResourceBindings ||
      Object.values(machine.operations).some((op) => op.services?.length)
    )
      fail("resource_bindings_required");
    JobCommandSchema.parse({
      type: "install",
      pluginId: args.pluginId,
      installationRevision: args.installationRevision,
      artifactSha256: args.artifactSha256,
      machine,
      resourceBindings,
      ...delivery,
    });
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
          historical.artifact !== args.artifactSha256 ||
          digest(historical.resourceBindings ?? null) !== digest(resourceBindings ?? null))
      )
        fail("installation_revision_conflict");
      this.store.db
        .query(
          "INSERT INTO machine_job_installations(machine_id,plugin_id,revision,artifact,manifest,resource_bindings) VALUES (?,?,?,?,?,?) ON CONFLICT(machine_id,plugin_id,revision) DO NOTHING",
        )
        .run(
          args.machineId,
          args.pluginId,
          args.installationRevision,
          args.artifactSha256,
          canonicalJobJson(machine),
          resourceBindings === undefined ? null : canonicalJobJson(resourceBindings),
        );
      this.store.db
        .query(
          "INSERT INTO machine_job_installs(machine_id,plugin_id,revision,artifact,manifest,resource_bindings,enabled,ready,purge_requested) VALUES (?,?,?,?,?,?,1,0,0) ON CONFLICT(machine_id,plugin_id) DO UPDATE SET revision=excluded.revision,artifact=excluded.artifact,manifest=excluded.manifest,resource_bindings=excluded.resource_bindings,enabled=1,ready=0,purge_requested=0",
        )
        .run(
          args.machineId,
          args.pluginId,
          args.installationRevision,
          args.artifactSha256,
          canonicalJobJson(machine),
          resourceBindings === undefined ? null : canonicalJobJson(resourceBindings),
        );
    });
    this.sendInstall(this.jobs.installation(args.machineId, args.pluginId)!);
    this.reconcileAuthority();
    this.accessChanged();
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
    if (!auth.isRoot || !this.auth.restoreCredential(this.auth.credentialReference(auth))) fail();
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
    this.accessChanged();
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
    if (
      digest(request.resourceBindings ?? null) !==
      digest(this.operationBindings(install, request.operationId) ?? null)
    )
      fail("resource_bindings_changed");
    // Retained work keeps its pinned resources across transport loss. Live availability
    // gates new admission and service effects, not the continued validity of its grants.
    for (const binding of op.services ?? [])
      if (!this.boundServicePolicy(install, binding)) fail("service_definition_changed");
    if (request.service) {
      const record = this.instanceServices.get(request.service.serviceId);
      if (
        !record?.enabled ||
        record.jobId !== request.jobId ||
        record.machineId !== request.machineId ||
        record.revision !== request.service.revision ||
        record.policy.runtime?.operationId !== request.operationId ||
        digest(this.instancePolicy(record)) !== request.service.policySha256 ||
        digest(record.credential) !== digest(request.credential) ||
        request.limits.timeoutMs !== 0 ||
        request.parent ||
        request.terminal
      )
        fail("instance_service_configuration_changed");
    } else if (request.limits.timeoutMs <= 0) fail("invalid_limits");
    const terminalOrigin = request.terminal
      ? (this.jobs.get(request.jobId)?.auditOrigin ?? this.jobs.dispatchOrigin(request.traceId))
      : null;
    if (
      request.terminal &&
      (!terminalOrigin?.containerId ||
        terminalOrigin.door !== "core.terminals.open" ||
        terminalOrigin.actor !== request.credential.principalId)
    )
      fail("terminal_spawn_origin_missing");
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
      ...(request.terminal
        ? [
            {
              cap: "terminals:spawn" as const,
              ref: { kind: "container" as const, containerId: terminalOrigin!.containerId! },
            },
          ]
        : []),
      {
        cap: "machines:run",
        ref: { kind: "operation", machineId: request.machineId, operationId: request.operationId },
      },
      ...op.locations.map((l) => ({
        cap: `locations:${l.access}` as const,
        ref: { kind: "location" as const, machineId: request.machineId, locationId: l.locationId },
      })),
      ...(op.services ?? []).flatMap((binding) =>
        binding.operationIds.map((operationId) => ({
          cap: "services:invoke" as const,
          ref: {
            kind: "service" as const,
            machineId: request.machineId,
            serviceId: binding.serviceId,
            operationId,
          },
        })),
      ),
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
    terminal?: JobRequest["terminal"],
  ): JobRequest {
    const install = this.jobs.installation(args.machineId, pluginId);
    const op = install?.machine.operations[args.operationId];
    if (!install || !op) fail("unknown_operation");
    const resourceBindings = this.operationBindings(install, args.operationId);
    if (
      (args.installationRevision !== undefined && args.installationRevision !== install.revision) ||
      (args.artifactSha256 !== undefined && args.artifactSha256 !== install.artifact)
    )
      fail("installation_changed");
    if (
      args.resourceBindingDigest !== undefined &&
      args.resourceBindingDigest !== digest(resourceBindings ?? null)
    )
      fail("resource_bindings_changed");
    if (
      args.resourceBindings !== undefined &&
      digest(args.resourceBindings) !== digest(resourceBindings ?? null)
    )
      fail("resource_bindings_changed");
    const resourceReason = this.resourceRefusal(install, args.operationId);
    if (resourceReason) fail(resourceReason);
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
    if (limits.timeoutMs <= 0) fail("invalid_limits");
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
      jobId: args.jobId,
      machineId: args.machineId,
      operationId: args.operationId,
      input: args.input,
      outputs: args.outputs,
      limits,
      pluginId,
      traceId: originalTraceId,
      installationRevision: install.revision,
      artifactSha256: install.artifact,
      ...(resourceBindings ? { resourceBindings } : {}),
      parent: null,
      credential: this.auth.credentialReference(auth),
      ...(terminal ? { terminal } : {}),
    };
    return JobRequestSchema.parse({ ...unsigned, requestDigest: digest(unsigned) });
  }
  execute(auth: AuthContext, pluginId: string, traceId: string, args: JobExecution): JobRecord {
    if ("terminal" in args) fail("native_terminal_admission_required");
    if ("service" in args) fail("native_service_admission_required");
    const context = this.auth.restoreCredential(this.auth.credentialReference(auth));
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
    this.changed(job.request);
    if (job.state === "queued") this.start(job);
    return this.jobs.get(request.jobId)!;
  }
  /** Immediate native admission; unavailable/refused terminals never become retryable jobs. */
  admitTerminal(
    auth: AuthContext,
    runtime: TerminalRuntime,
    machineId: string,
    terminal: NonNullable<JobRequest["terminal"]>,
    traceId: number,
  ): Extract<JobCommand, { type: "start" }> {
    const live = this.channels.get(machineId);
    const install = this.jobs.installation(machineId, runtime.pluginId);
    if (
      !live?.proved ||
      live.owner.terminalHostId !== terminal.terminalHostId ||
      !live.owner.platforms.some((platform) => platform.startsWith("linux-"))
    )
      fail("terminal_runtime_host_unsupported");
    if (
      !install?.ready ||
      !install.enabled ||
      install.revision !== runtime.installationRevision ||
      install.artifact !== runtime.artifactSha256
    )
      fail("installation_changed");
    if (!install.machine.operations[runtime.operationId]?.stdin)
      fail("terminal_operation_requires_stdin");
    const context = this.auth.restoreCredential(this.auth.credentialReference(auth));
    if (!context) fail("credential_revoked_or_expired");
    const pinned = this.build(
      context,
      runtime.pluginId,
      String(traceId),
      {
        jobId: randomUUID(),
        machineId,
        operationId: runtime.operationId,
        input: runtime.input,
        outputs: [],
        resourceBindingDigest: runtime.resourceBindingDigest,
      },
      undefined,
      terminal,
    );
    const job = this.store.transaction(() => this.jobs.reserve(pinned, this.runtime.now()));
    const command = this.start(job, false);
    if (!command) {
      this.jobs.state(pinned.jobId, "refused");
      this.changed(pinned);
      fail("terminal_runtime_admission_refused");
    }
    this.changed(pinned);
    return command;
  }
  private start(
    job: JobRecord,
    dispatch = true,
  ): Extract<JobCommand, { type: "start" }> | undefined {
    const request = job.request;
    if (request.terminal && dispatch) return;
    const live = this.channels.get(request.machineId);
    if (
      live?.proved &&
      request.resourceBindings?.services &&
      Object.keys(request.resourceBindings.services).length &&
      !this.synchronizeServices(live.channel)
    )
      return;
    if (!live?.proved) return;
    const permit = this.store.transaction(() => {
      const current = this.jobs.get(request.jobId)!;
      if (current.state !== "queued") return null;
      const machine = this.store.getMachine(request.machineId);
      const install = this.jobs.installation(request.machineId, request.pluginId);
      if (!machine || machine.draining || !install?.ready) return null;
      const operationReason = this.operationRefusal(install, request.operationId);
      const context = this.auth.restoreCredential(request.credential);
      let refusal = !context
        ? "credential_revoked_or_expired"
        : (operationReason ??
          this.jobSchedules.startRefusal(request.jobId, this.runtime.now()) ??
          this.jobs.cancellation(request.jobId) ??
          this.invocationRefusal(request));
      let requirements: AuthorityRequirement[] = [];
      try {
        requirements = this.requirements(request);
      } catch (error) {
        refusal = error instanceof ServiceError ? error.message : "installation_changed";
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
    if (permit) {
      const command = { type: "start" as const, request, permit };
      if (dispatch) live.channel.send({ type: "job_command", command });
      return command;
    }
  }
  online(channel: JobChannel, owner: JobOwner | undefined, epoch: string): void {
    const previous = this.channels.get(channel.machineId)?.channel;
    if (previous) this.disconnectInputs(previous);
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
    this.disconnectInputs(channel);
    if (this.channels.get(channel.machineId)?.channel === channel) {
      this.channels.delete(channel.machineId);
      this.store.db
        .query("UPDATE machine_job_installs SET ready=0 WHERE machine_id=?")
        .run(channel.machineId);
    }
  }
  private serviceTunnelCurrent(tunnel: HubServiceTunnel): boolean {
    const job = this.jobs.get(tunnel.request.jobId);
    const record = this.instanceServices.get(tunnel.policy.serviceId);
    const current = job && this.auth.restoreCredential(job.request.credential);
    const consumer = this.channels.get(tunnel.consumer.machineId);
    const producer = this.channels.get(tunnel.producer.machineId);
    if (
      !job ||
      job.state !== "started" ||
      job.ownerClosed ||
      !current ||
      !consumer?.proved ||
      consumer.channel !== tunnel.consumer ||
      !producer?.proved ||
      producer.channel !== tunnel.producer ||
      !this.inputOwner(job, tunnel.consumer) ||
      this.jobs.cancellation(job.request.jobId) !== null ||
      this.reauthorizeDeferred(job.request) !== null ||
      !record?.enabled ||
      record.machineId !== tunnel.producer.machineId ||
      record.revision !== tunnel.instanceRevision ||
      digest(this.instancePolicy(record)) !== digest(tunnel.policy) ||
      this.instanceReason(record) !== null
    )
      return false;
    return tunnel.operationIds.every((operationId) =>
      this.auth.allowsRef(current, "services:invoke", {
        kind: "service",
        machineId: tunnel.producer.machineId,
        serviceId: tunnel.policy.serviceId,
        operationId,
      }),
    );
  }
  private closeServiceTunnel(tunnel: HubServiceTunnel): void {
    const channelId = tunnel.request.channelId;
    if (this.serviceTunnels.get(channelId) !== tunnel) return;
    this.serviceTunnels.delete(channelId);
    clearTimeout(tunnel.timer);
    for (const peer of [tunnel.consumer, tunnel.producer]) {
      try {
        peer.send({
          type: "job_command",
          command: {
            type: "service_tunnel_frame",
            frame: { type: "close", channelId },
          },
        });
      } catch {
        // The removed channel cannot regain authority when a disconnected peer returns.
      }
    }
  }
  private openServiceTunnel(
    consumer: JobChannel,
    request: Extract<JobEvent, { type: "service_tunnel_open" }>,
  ): void {
    let tunnel: HubServiceTunnel | undefined;
    try {
      if (this.serviceTunnels.has(request.channelId) || this.serviceTunnels.size >= 256)
        fail("service_unavailable");
      const policy = this.effectiveConfiguration(consumer.machineId).policies.find(
        (policy) => policy.serviceId === request.serviceId,
      );
      const job = this.jobs.get(request.jobId);
      const binding =
        job &&
        this.jobs
          .installation(consumer.machineId, job.request.pluginId)
          ?.machine.operations[job.request.operationId]?.services?.find(
            (binding) => binding.serviceId === request.serviceId,
          );
      const record = policy?.remote && this.instanceServices.get(policy.remote.serviceId);
      const producer = record && this.channels.get(record.machineId)?.channel;
      if (
        !policy?.remote ||
        policy.revision !== request.revision ||
        digest(policy) !== request.policySha256 ||
        !binding ||
        !record ||
        !producer ||
        record.machineId === consumer.machineId ||
        record.revision !== policy.remote.revision ||
        digest(this.instancePolicy(record)) !== policy.remote.policySha256 ||
        !binding.operationIds.length
      )
        fail("service_binding_mismatch");
      for (const operationId of binding.operationIds)
        if (
          !this.authorizeJobService(consumer, {
            type: "service_authorize",
            subject: { kind: "job", jobId: request.jobId },
            authorizationId: request.channelId,
            serviceId: request.serviceId,
            revision: request.revision,
            policySha256: request.policySha256,
            operationId,
          })
        )
          fail("service_unauthorized");
      tunnel = {
        request,
        consumer,
        producer,
        policy: this.instancePolicy(record),
        instanceRevision: record.revision,
        operationIds: binding.operationIds,
        ready: false,
        timer: setTimeout(() => {
          if (tunnel) this.closeServiceTunnel(tunnel);
        }, 5000),
        outward: { next: 0, waiting: null, ended: false },
        inward: { next: 0, waiting: null, ended: false },
      };
      this.serviceTunnels.set(request.channelId, tunnel);
      if (
        !this.serviceTunnelCurrent(tunnel) ||
        !producer.send({
          type: "job_command",
          command: {
            type: "service_tunnel_open",
            channelId: request.channelId,
            serviceId: record.serviceId,
            revision: tunnel.policy.revision,
            policySha256: digest(tunnel.policy),
            operationIds: binding.operationIds,
          },
        })
      )
        this.closeServiceTunnel(tunnel);
    } catch {
      if (tunnel) this.closeServiceTunnel(tunnel);
      else
        consumer.send({
          type: "job_command",
          command: {
            type: "service_tunnel_ready",
            channelId: request.channelId,
            endpoint: null,
          },
        });
    }
  }
  private relayServiceTunnel(channel: JobChannel, frame: ServiceTunnelFrame): void {
    const tunnel = this.serviceTunnels.get(frame.channelId);
    if (!tunnel || (channel !== tunnel.consumer && channel !== tunnel.producer)) return;
    if (frame.type === "close" || !tunnel.ready || !this.serviceTunnelCurrent(tunnel)) {
      this.closeServiceTunnel(tunnel);
      return;
    }
    const outward = channel === tunnel.consumer;
    const sent = outward ? tunnel.outward : tunnel.inward;
    const received = outward ? tunnel.inward : tunnel.outward;
    if (frame.type === "ack") {
      if (received.waiting !== frame.sequence) {
        this.closeServiceTunnel(tunnel);
        return;
      }
      received.waiting = null;
    } else {
      if (sent.ended || sent.waiting !== null || frame.sequence !== sent.next) {
        this.closeServiceTunnel(tunnel);
        return;
      }
      sent.waiting = sent.next++;
      sent.ended = frame.type === "end";
    }
    const target = outward ? tunnel.producer : tunnel.consumer;
    if (!target.send({ type: "job_command", command: { type: "service_tunnel_frame", frame } }))
      this.closeServiceTunnel(tunnel);
  }
  private disconnectInputs(channel: JobChannel): void {
    for (const tunnel of this.serviceTunnels.values())
      if (tunnel.consumer === channel || tunnel.producer === channel)
        this.closeServiceTunnel(tunnel);
    for (const [serviceId, ready] of this.instanceReadiness)
      if (ready.channel === channel) this.instanceReadiness.delete(serviceId);
    for (const pending of [...this.directServiceCalls.values()])
      if (pending.channel === channel)
        pending.finish(new ServiceError("conflict", "service_unavailable"));
    for (const [key, report] of this.installationResources)
      if (report.channel === channel) this.installationResources.delete(key);
    for (const [jobId, seat] of this.inputSync) if (seat === channel) this.inputSync.delete(jobId);
    for (const pending of [...this.inputs.values()])
      if (pending.channel === channel)
        pending.finish(new ServiceError("conflict", "job_input_delivery_unknown"));
  }
  private sendInstall(install: JobInstallation): void {
    const live = this.channels.get(install.machineId);
    if (live?.proved)
      live.channel.send({
        type: "job_command",
        command: JobCommandSchema.parse({
          type: "install",
          pluginId: install.pluginId,
          installationRevision: install.revision,
          artifactSha256: install.artifact,
          machine: install.machine,
          ...(install.resourceBindings ? { resourceBindings: install.resourceBindings } : {}),
          ...(install.enabled && !install.purgeRequested
            ? // An unavailable former bundle must refuse acquisition, not disconnect retained reads.
              (this.artifactDelivery(
                install.pluginId,
                install.machine,
                install.artifact,
                live.owner.platforms,
              ) ?? {})
            : {}),
          ...(install.purgeRequested
            ? { action: "purge" as const }
            : install.enabled
              ? {}
              : { action: "disable" as const }),
        }),
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
      if (!this.synchronizeServices(channel)) {
        this.offline(channel);
        return;
      }
      this.reconcileAuthority();
      for (const record of this.instanceServices.list())
        if (record.enabled && record.machineId === channel.machineId && record.jobId === null)
          this.instanceStarts.add(record.serviceId);
      for (const install of this.jobs.installations(channel.machineId)) this.sendInstall(install);
      channel.send({
        type: "job_command",
        command: {
          type: "drain",
          draining: this.store.getMachine(channel.machineId)?.draining ?? true,
        },
      });
      for (const job of this.jobs.reconcilable(channel.machineId)) {
        const cancellation = this.jobs.cancellation(job.request.jobId);
        if (cancellation !== null) this.cancelRecord(job, cancellation);
        else if (job.state === "queued") this.start(job);
        else
          channel.send({
            type: "job_command",
            command: {
              type: "status",
              jobId: job.request.jobId,
              ...(job.permit ? { admission: { request: job.request, permit: job.permit } } : {}),
            },
          });
      }
      return;
    }
    if (!live.proved) return;
    if (event.type === "service_tunnel_open") {
      this.openServiceTunnel(channel, event);
      return;
    }
    if (event.type === "service_tunnel_ready") {
      const tunnel = this.serviceTunnels.get(event.channelId);
      if (!tunnel || tunnel.producer !== channel) return;
      if (tunnel.ready || !event.endpoint || !this.serviceTunnelCurrent(tunnel)) {
        this.closeServiceTunnel(tunnel);
        return;
      }
      tunnel.ready = true;
      clearTimeout(tunnel.timer);
      const timeout = Math.max(
        ...tunnel.operationIds.map((id) => tunnel.policy.operations[id]!.timeoutMs),
      );
      tunnel.timer = setTimeout(() => this.closeServiceTunnel(tunnel), timeout + 5000);
      if (!tunnel.consumer.send({ type: "job_command", command: event }))
        this.closeServiceTunnel(tunnel);
      return;
    }
    if (event.type === "service_tunnel_frame") {
      this.relayServiceTunnel(channel, event.frame);
      return;
    }
    if (event.type === "service_ready") {
      const binding = event.service;
      const record = this.instanceServices.get(binding.serviceId);
      const job = this.jobs.get(event.jobId);
      if (
        !record?.enabled ||
        record.jobId !== event.jobId ||
        record.machineId !== channel.machineId ||
        record.revision !== binding.revision ||
        !job?.request.service ||
        canonicalJobJson(job.request.service) !== canonicalJobJson(binding) ||
        job.request.service.revision !== record.revision ||
        job.permit?.ownerId !== live.owner.ownerId ||
        job.permit.ownerGeneration !== live.owner.generation ||
        this.jobs.cancellation(event.jobId) !== null ||
        job.ownerClosed ||
        !active.has(job.state)
      )
        return;
      this.instanceReadiness.set(binding.serviceId, {
        revision: binding.revision,
        jobId: event.jobId,
        channel,
      });
      this.instanceFailures.delete(binding.serviceId);
      this.accessChanged();
      return;
    }
    if (event.type === "resources") {
      live.owner = { ...live.owner, resources: event.resources };
      this.reconcileAuthority();
      this.accessChanged();
      return;
    }
    if (event.type === "service_authorize") {
      let allowed = false;
      try {
        if (event.subject.kind === "tunnel") {
          const tunnel = this.serviceTunnels.get(event.subject.channelId);
          if (
            tunnel?.producer === channel &&
            tunnel.ready &&
            this.serviceTunnelCurrent(tunnel) &&
            event.serviceId === tunnel.policy.serviceId &&
            event.revision === tunnel.policy.revision &&
            event.policySha256 === digest(tunnel.policy) &&
            tunnel.operationIds.includes(event.operationId)
          ) {
            allowed = this.authorizeJobService(tunnel.consumer, {
              ...event,
              subject: { kind: "job", jobId: tunnel.request.jobId },
              serviceId: tunnel.request.serviceId,
              revision: tunnel.request.revision,
              policySha256: tunnel.request.policySha256,
            });
          }
        } else if (event.subject.kind !== "job") {
          const pending = this.directServiceCalls.get(event.subject.requestId);
          if (
            !pending ||
            pending.mode !== event.subject.kind ||
            pending.channel !== channel ||
            pending.args.serviceId !== event.serviceId ||
            pending.args.revision !== event.revision ||
            pending.args.policySha256 !== event.policySha256 ||
            pending.args.operationId !== event.operationId
          )
            fail("service_unauthorized");
          this.authorizeDirectService(pending, event.subject.requestId, "authorize");
          pending.authorized = true;
          allowed = true;
        } else {
          allowed = this.authorizeJobService(channel, event);
        }
      } catch {
        /* Refused owner calls never disclose input or upstream errors. */
      }
      let delivered = false;
      try {
        delivered = channel.send({
          type: "job_command",
          command: {
            type: "service_authorized",
            subject: event.subject,
            authorizationId: event.authorizationId,
            allowed,
          },
        });
      } catch {
        /* Send failure is not authorization delivery. */
      }
      if (
        (!allowed || !delivered) &&
        (event.subject.kind === "read" || event.subject.kind === "invoke")
      )
        this.directServiceCalls
          .get(event.subject.requestId)
          ?.finish(new ServiceError("forbidden", "service_unauthorized"));
      return;
    }
    if (event.type === "service_read_result" || event.type === "service_invoke_result") {
      const pending = this.directServiceCalls.get(event.requestId);
      if (
        !pending ||
        pending.channel !== channel ||
        event.type !== (pending.mode === "read" ? "service_read_result" : "service_invoke_result")
      )
        return;
      try {
        const reply = ServiceReplySchema.parse(event.reply);
        if ((reply.ok && !pending.authorized) || reply.requestId !== event.requestId)
          fail("service_unconfirmed");
        this.authorizeDirectService(pending, event.requestId, "disclose");
        pending.finish(undefined, reply);
      } catch (error) {
        pending.finish(
          error instanceof ServiceError
            ? error
            : new ServiceError("forbidden", "service_response_invalid"),
        );
      }
      return;
    }
    if (event.type === "input_authorize") {
      const job = this.jobs.get(event.jobId);
      const pending = this.inputs.get(event.jobId);
      let allowed = false;
      try {
        if (!job || !this.inputOwner(job, channel)) fail("job_input_owner_unavailable");
        this.inputAuthority(job);
        let context: AuthContext;
        let requirements: AuthorityRequirement[];
        if (event.parentJobId === null) {
          if (
            !pending ||
            pending.channel !== channel ||
            pending.requestId !== event.requestId ||
            pending.seq !== event.seq ||
            pending.authorized
          )
            fail("job_input_request_missing");
          context = this.auth.restoreCredential(this.auth.credentialReference(pending.auth))!;
          this.authorizedJob(pending.auth, pending.node, "jobs:input", pending.callerPluginId);
          requirements = [{ cap: "jobs:input", ref: pending.node }];
        } else {
          if (job.request.parent?.parentJobId !== event.parentJobId || pending)
            fail("job_input_parent_mismatch");
          context = this.auth.restoreCredential(job.request.credential)!;
          requirements = this.requirements(job.request);
          if (
            !this.jobs.reserveInput(
              job,
              event.requestId,
              event.seq,
              context.principal.id,
              job.request.traceId,
            )
          )
            fail("job_input_request_replayed");
        }
        const decision = this.decide({
          credential: this.auth.credentialReference(context),
          pluginId: job.request.pluginId,
          action: "engine.jobs.input",
          evidence: requirements.map((requirement) => this.auth.explain(context, requirement)),
        });
        this.store.db
          .query("UPDATE machine_job_inputs SET decision_id=? WHERE job_id=? AND request_id=?")
          .run(decision.decisionId, event.jobId, event.requestId);
        allowed = decision.allowed;
        if (allowed) {
          if (pending) pending.authorized = true;
          this.inputSync.delete(event.jobId);
        }
      } catch {
        // Input refusals are not job lifecycle events and never cancel another valid run.
      }
      channel.send({
        type: "job_command",
        command: {
          type: "input_authorized",
          jobId: event.jobId,
          requestId: event.requestId,
          allowed,
        },
      });
      return;
    }
    if (event.type === "input_state" || event.type === "input_result") {
      const job = this.jobs.get(event.jobId);
      if (!job || !this.inputOwner(job, channel)) return;
      const pending = this.inputs.get(event.jobId);
      if (event.type === "input_state") {
        if (
          event.requestDigest !== job.request.requestDigest ||
          event.ownerId !== job.permit?.ownerId ||
          event.ownerGeneration !== job.permit.ownerGeneration ||
          (job.nextInputSeq !== null && event.nextInputSeq < job.nextInputSeq)
        )
          return;
        this.jobs.inputCursor(event.jobId, event.nextInputSeq, event.stdinClosed);
        if (!pending) this.inputSync.set(event.jobId, channel);
        this.changed(job.request);
        return;
      }
      if (event.accepted && (event.reason !== null || event.nextInputSeq !== event.seq + 1)) return;
      if (event.nextInputSeq !== null)
        this.jobs.inputCursor(event.jobId, event.nextInputSeq, event.stdinClosed);
      this.jobs.inputResult(
        event.jobId,
        event.requestId,
        event.accepted
          ? "accepted"
          : event.reason === "job_input_delivery_unknown"
            ? "unknown"
            : "rejected",
        event.reason,
      );
      if (
        !pending ||
        pending.channel !== channel ||
        pending.requestId !== event.requestId ||
        pending.seq !== event.seq
      )
        return;
      try {
        this.authorizedJob(pending.auth, pending.node, "jobs:input", pending.callerPluginId);
        this.inputAuthority(job);
        if (!event.accepted || !pending.authorized)
          throw new ServiceError("conflict", event.reason ?? "job_input_unconfirmed");
        pending.finish();
      } catch {
        pending.finish(
          new ServiceError(
            "conflict",
            event.accepted
              ? "job_input_authority_revoked_after_delivery"
              : (event.reason ?? "job_input_unconfirmed"),
          ),
        );
      }
      return;
    }
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
      if (event.resources)
        this.installationResources.set(`${channel.machineId}/${event.pluginId}`, {
          channel,
          revision: event.installationRevision,
          artifact: event.artifactSha256,
          resources: event.resources,
        });
      else this.installationResources.delete(`${channel.machineId}/${event.pluginId}`);
      this.store.db
        .query("UPDATE machine_job_installs SET ready=1 WHERE machine_id=? AND plugin_id=?")
        .run(channel.machineId, event.pluginId);
      this.reconcileAuthority();
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
    if (
      !job ||
      job.request.machineId !== channel.machineId ||
      (!active.has(job.state) && event.type !== "workload_empty")
    )
      return;
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
    if (event.type === "workload_empty") {
      if (this.jobs.confirmEmpty(job.request.jobId)) {
        const serviceId = job.request.service?.serviceId;
        if (serviceId && this.instanceReadiness.get(serviceId)?.jobId === job.request.jobId)
          this.instanceReadiness.delete(serviceId);
        this.accessChanged();
      }
      return;
    }
    if (event.type === "state" || event.result.state === "started") {
      if (
        (event.type === "state" ? event.state : event.result.state) === "started" &&
        job.state === "start-committed" &&
        !job.ownerClosed &&
        fact.ownerGeneration === live.owner.generation
      ) {
        this.jobs.state(job.request.jobId, "started");
        this.publishJobEvent(job.request.jobId, {
          type: "state",
          jobId: job.request.jobId,
          requestDigest: fact.requestDigest,
          ownerId: fact.ownerId,
          ownerGeneration: fact.ownerGeneration,
          state: "started",
        });
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
    const context = this.auth.restoreCredential(this.auth.credentialReference(auth));
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
    const job = this.jobs.get(node.jobId);
    if (!job) return fail("job_not_started");
    return job;
  }
  status(auth: AuthContext, node: ManifoldRef, callerPluginId = "engine.jobs"): JobRecord {
    const job = this.authorizedJob(auth, node, "jobs:read", callerPluginId);
    const live = this.channels.get(job.request.machineId);
    if (
      live?.proved &&
      this.inputSync.get(job.request.jobId) !== live.channel &&
      !this.inputs.has(job.request.jobId)
    )
      live.channel.send({
        type: "job_command",
        command: {
          type: "status",
          jobId: job.request.jobId,
          ...(job.permit ? { admission: { request: job.request, permit: job.permit } } : {}),
        },
      });
    return this.jobs.get(job.request.jobId)!;
  }
  private inputOwner(job: JobRecord, channel: JobChannel): boolean {
    const live = this.channels.get(job.request.machineId);
    return (
      live?.channel === channel &&
      live.proved &&
      job.permit?.ownerId === live.owner.ownerId &&
      job.permit.ownerGeneration === live.owner.generation
    );
  }
  private inputAuthority(job: JobRecord): void {
    const reason =
      this.jobs.cancellation(job.request.jobId) ??
      this.reauthorizeDeferred(job.request) ??
      this.invocationRefusal(job.request);
    if (reason) fail(reason);
    if (
      job.state !== "started" ||
      job.stdinClosed ||
      job.request.terminal ||
      !this.jobs.installation(
        job.request.machineId,
        job.request.pluginId,
        job.request.installationRevision,
      )?.machine.operations[job.request.operationId]?.stdin
    )
      fail("job_input_not_open");
  }
  async input(
    auth: AuthContext,
    node: ManifoldRef,
    requestId: string,
    seq: number,
    data: string,
    eof: boolean,
    callerPluginId = "engine.jobs",
    traceId = "native-input",
  ): Promise<void> {
    const job = this.authorizedJob(auth, node, "jobs:input", callerPluginId);
    this.inputAuthority(job);
    const live = this.channels.get(job.request.machineId);
    if (!live || !this.inputOwner(job, live.channel)) fail("job_input_owner_unavailable");
    if (this.inputs.has(job.request.jobId) || this.inputs.size >= 64)
      throw new ServiceError("conflict", "job_input_pending");
    if (this.inputSync.get(job.request.jobId) !== live.channel || job.nextInputSeq === null)
      throw new ServiceError("conflict", "job_input_cursor_unconfirmed");
    if (seq !== job.nextInputSeq) throw new ServiceError("conflict", "job_input_sequence_conflict");
    const command = JobCommandSchema.parse({
      type: "input",
      jobId: job.request.jobId,
      requestId,
      seq,
      data,
      eof,
    });
    if (!this.jobs.reserveInput(job, requestId, seq, auth.principal.id, traceId))
      throw new ServiceError("conflict", "job_input_request_replayed");
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const finish = (error?: Error) => {
      if (this.inputs.get(job.request.jobId)?.requestId !== requestId) return;
      clearTimeout(timer);
      this.inputs.delete(job.request.jobId);
      if (error) {
        // Transport errors cannot establish whether stdin consumed any bytes.
        this.store.db
          .query(
            "UPDATE machine_job_inputs SET state='unknown',reason=? WHERE job_id=? AND request_id=? AND state='pending'",
          )
          .run("job_input_delivery_unknown", job.request.jobId, requestId);
        reject(error);
      } else resolve();
    };
    const timer = setTimeout(
      () => finish(new ServiceError("conflict", "job_input_delivery_unknown")),
      12000,
    );
    this.inputSync.delete(job.request.jobId);
    this.inputs.set(job.request.jobId, {
      channel: live.channel,
      requestId,
      seq,
      authorized: false,
      auth: structuredClone(auth),
      node: structuredClone(node),
      callerPluginId,
      finish,
    });
    try {
      if (!live.channel.send({ type: "job_command", command }))
        finish(new ServiceError("conflict", "job_input_delivery_unknown"));
    } catch {
      finish(new ServiceError("conflict", "job_input_delivery_unknown"));
    }
    return promise;
  }
  cancel(auth: AuthContext, node: ManifoldRef, callerPluginId = "engine.jobs"): void {
    this.cancelRecord(this.authorizedJob(auth, node, "jobs:cancel", callerPluginId), "requested");
  }
  cancelTerminal(terminalId: string): void {
    for (const job of this.jobs.active())
      if (job.request.terminal?.terminalId === terminalId)
        this.cancelRecord(job, "terminal_closed");
  }
  private cancelRecord(job: JobRecord, reason: string): void {
    if (!active.has(job.state) && (!job.request.service || !job.permit || job.ownerClosed)) return;
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
        command: {
          type: "cancel",
          jobId: job.request.jobId,
          reason,
          ...(job.permit ? { admission: { request: job.request, permit: job.permit } } : {}),
        },
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
    this.accessChanged();
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
