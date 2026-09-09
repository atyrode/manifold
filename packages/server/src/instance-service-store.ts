import {
  canonicalJobJson,
  ServicePolicySchema,
  type RuntimeDeps,
  type ServicePolicy,
} from "@manifold/protocol";
import {
  ServiceError,
  type AuthContext,
  type AuthService,
  type AuthorityRequirement,
  type CredentialReference,
} from "./auth.ts";
import type { ServerStore } from "./stores.ts";

export interface InstanceServiceRecord {
  serviceId: string;
  revision: string;
  machineId: string;
  pluginId: string;
  policy: ServicePolicy;
  enabled: boolean;
  credential: CredentialReference | null;
  jobId: string | null;
  configuredBy: string;
  configuredAt: number;
}

export interface ConfigureInstanceServiceArgs {
  serviceId: string;
  expectedRevision: string | null;
  machineId?: string;
  policy: ServicePolicy;
  enabled: boolean;
}

interface InstanceServiceRow {
  service_id: string;
  revision: string;
  machine_id: string;
  plugin_id: string;
  configuration: string;
  credential: string | null;
  job_id: string | null;
  configured_by: string;
  configured_at: number;
}

function record(row: InstanceServiceRow): InstanceServiceRecord {
  const configuration = JSON.parse(row.configuration) as { policy: ServicePolicy; enabled: boolean };
  return {
    serviceId: row.service_id,
    revision: row.revision,
    machineId: row.machine_id,
    pluginId: row.plugin_id,
    policy: configuration.policy,
    enabled: configuration.enabled,
    credential: row.credential === null ? null : JSON.parse(row.credential),
    jobId: row.job_id,
    configuredBy: row.configured_by,
    configuredAt: row.configured_at,
  };
}

/** Persisted placement and authority; process ownership belongs to JobService. */
export class InstanceServiceStore {
  constructor(
    private readonly store: ServerStore,
    private readonly auth: AuthService,
    private readonly runtime: RuntimeDeps,
  ) {}

  get(serviceId: string): InstanceServiceRecord | null {
    const row = this.store.db
      .query<InstanceServiceRow, [string]>("SELECT * FROM native_instance_services WHERE service_id=?")
      .get(serviceId);
    return row === null ? null : record(row);
  }

  list(): InstanceServiceRecord[] {
    return this.store.db
      .query<InstanceServiceRow, []>("SELECT * FROM native_instance_services ORDER BY service_id")
      .all()
      .map(record);
  }

  /** Identity established by native bootstrap, never a display-name search or fallback. */
  defaultOwnerId(): string | null {
    const id = this.store.getMeta("native_local_machine_id");
    if (id === null) return null;
    const machine = this.store.getMachine(id);
    const token = machine === null ? null : this.store.getToken(machine.tokenId);
    if (
      !machine || !token || token.principalId !== id || token.revokedAt !== null ||
      (token.expiresAt !== null && token.expiresAt <= this.runtime.now())
    ) return null;
    return id;
  }

  /** Requirements are derived by the trusted installed-runtime resolver, not public input. */
  configure(
    actor: AuthContext,
    args: ConfigureInstanceServiceArgs,
    callerPluginId: string,
    traceId: string,
    requirements: readonly AuthorityRequirement[],
  ): { previous: InstanceServiceRecord | null; current: InstanceServiceRecord } {
    return this.store.transaction(() => {
      const previous = this.get(args.serviceId);
      // Compare before any grant, principal, audit, or configuration mutation.
      if ((previous?.revision ?? null) !== args.expectedRevision)
        throw new ServiceError("conflict", "instance_service_configuration_changed");
      const machineId = args.machineId ?? previous?.machineId ?? this.defaultOwnerId();
      const currentActor = this.auth.restoreCredential(this.auth.credentialReference(actor));
      if (
        machineId === null || !this.store.getMachine(machineId) || !currentActor?.isRoot ||
        (!currentActor.caps.includes("*") && !currentActor.caps.includes("services:configure")) ||
        !this.auth.allowsRef(currentActor, "services:configure", { kind: "machine", machineId }) ||
        (previous !== null && !this.auth.allowsRef(currentActor, "services:configure", {
          kind: "machine", machineId: previous.machineId,
        }))
      ) throw new ServiceError("forbidden", "instance_service_configuration_forbidden");
      const policy = ServicePolicySchema.parse(args.policy);
      const serviceRuntime = policy.runtime;
      if (
        policy.serviceId !== args.serviceId || !serviceRuntime || serviceRuntime.scope !== "instance" ||
        !args.serviceId.startsWith(`${serviceRuntime.pluginId}.`) ||
        !serviceRuntime.operationId.startsWith(`${serviceRuntime.pluginId}.`) ||
        (previous !== null && previous.pluginId !== serviceRuntime.pluginId) ||
        Object.values(serviceRuntime.input).some((binding) => !("literal" in binding))
      ) throw new ServiceError("conflict", "invalid_instance_service_runtime");
      const configuration = canonicalJobJson({ policy, enabled: args.enabled });
      if (
        previous !== null && previous.machineId === machineId &&
        canonicalJobJson({ policy: previous.policy, enabled: previous.enabled }) === configuration
      ) return { previous, current: previous };
      const credential = args.enabled
        ? this.auth.mintNativeServiceCredential(args.serviceId, machineId, currentActor, requirements)
        : null;
      if (previous?.credential)
        this.auth.revokeNativeServiceCredential(previous.credential, currentActor.principal.id);
      const current: InstanceServiceRecord = {
        serviceId: args.serviceId,
        // Identity, not a content hash: A -> B -> A must not admit an old A writer.
        revision: this.runtime.newId(),
        machineId,
        pluginId: serviceRuntime.pluginId,
        policy,
        enabled: args.enabled,
        credential,
        jobId: null,
        configuredBy: currentActor.principal.id,
        configuredAt: this.runtime.now(),
      };
      this.store.db.query(
        `INSERT INTO native_instance_services(service_id,revision,machine_id,plugin_id,configuration,credential,job_id,configured_by,configured_at)
         VALUES(?,?,?,?,?,?,NULL,?,?) ON CONFLICT(service_id) DO UPDATE SET
         revision=excluded.revision,machine_id=excluded.machine_id,plugin_id=excluded.plugin_id,
         configuration=excluded.configuration,credential=excluded.credential,job_id=NULL,
         configured_by=excluded.configured_by,configured_at=excluded.configured_at`,
      ).run(
        current.serviceId, current.revision, machineId, current.pluginId, configuration,
        credential === null ? null : canonicalJobJson(credential), current.configuredBy, current.configuredAt,
      );
      this.store.addEvent(null, current.configuredAt, current.configuredBy, "instance_service_configured", {
        serviceId: current.serviceId, machineId, revision: current.revision,
        previousRevision: previous?.revision ?? null, enabled: current.enabled, callerPluginId, traceId,
      });
      return { previous, current };
    });
  }

  /** A delayed launch/exit can update only the configuration that caused it. */
  setJob(serviceId: string, revision: string, jobId: string | null): boolean {
    return this.store.db.query(
      "UPDATE native_instance_services SET job_id=? WHERE service_id=? AND revision=?",
    ).run(jobId, serviceId, revision).changes > 0;
  }
}
