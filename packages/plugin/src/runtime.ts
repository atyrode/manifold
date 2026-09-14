import type {
  JobDescription,
  JobDeploymentDescription,
  JobEvent,
  JobFollowSnapshot,
  JobFollowUpdate,
  JobJournalPage,
  JobOutputPage,
  JobRequest,
  JobResourceBindings,
  ListJobRunsArgs,
  ListJobRunsResult,
  ManifoldRef,
  PublicJob,
  ServiceConfiguration,
  ServiceConfigurationRead,
  ServicePolicy,
  ServiceReadArgs,
  ServiceInvokeArgs,
  ServiceReply,
  ConfigureInstanceServiceArgs,
  InstanceServiceDescription,
  InstanceServicesDescription,
  InstanceServiceConfigurationRead,
  InstanceServiceReadArgs,
} from "@manifold/protocol";
export type { ServiceConfigurationRead } from "@manifold/protocol";

export type JobExecution = Pick<
  JobRequest,
  "jobId" | "machineId" | "operationId" | "input" | "outputs"
> & {
  limits?: JobRequest["limits"] | undefined;
  installationRevision?: string | undefined;
  artifactSha256?: string | undefined;
  resourceBindingDigest?: string | undefined;
  resourceBindings?: JobResourceBindings | undefined;
};
export interface JobScheduleTiming {
  scheduleId: string;
  revision: string;
  firstNominalAt: number;
  intervalMs: number;
  deadlineMs: number;
  expiresAt: number;
  offlinePolicy: "skip" | "coalesce-one";
}
export type PublicJobSchedule = JobScheduleTiming &
  Pick<
    JobRequest,
    "machineId" | "pluginId" | "operationId" | "installationRevision" | "artifactSha256"
  >;
export interface JobFollow {
  readonly snapshot: JobFollowSnapshot;
  close(): void;
}
type JobNode = Extract<ManifoldRef, { kind: "job" }>;
type OutputNode = Extract<ManifoldRef, { kind: "output" }>;

/** Host-bound to the caller's installation and credential; never accepts authority or parent overrides. */
export interface PluginJobContext {
  /** Read-only machines:run check at the machine, not an execution consent or grant. */
  describe(args: {
    machineId: string;
    pluginId: string;
    installationRevision?: string | undefined;
  }): JobDescription;
  describeDeployment(args: { machineId: string; pluginId: string }): JobDeploymentDescription;
  execute(args: JobExecution): PublicJob;
  status(node: JobNode): PublicJob;
  listRuns(args: ListJobRunsArgs): ListJobRunsResult;
  follow(node: JobNode, receive: (update: JobFollowUpdate) => void): JobFollow;
  input(args: {
    node: JobNode;
    requestId: string;
    seq: number;
    data: string;
    eof: boolean;
  }): Promise<{ accepted: true }>;
  cancel(node: JobNode): { accepted: true };
  output(args: {
    node: OutputNode;
    offset: number;
    maxBytes: number;
  }): Promise<Extract<JobEvent, { type: "output" }>>;
  /** One finished job's declared output by name, paged; `total` is its sealed length. */
  outputs(args: {
    node: JobNode;
    name: string;
    offset: number;
    limit: number;
  }): Promise<JobOutputPage>;
  /** A finished job's retained lifecycle frames; live observation is `follow`. */
  journal(args: {
    node: JobNode;
    after?: number | undefined;
    limit?: number | undefined;
  }): JobJournalPage;
  schedule(args: JobExecution & JobScheduleTiming): Record<string, never>;
  schedules(): PublicJobSchedule[];
  disableSchedule(args: { scheduleId: string; revision: string }): Record<string, never>;
}

export interface ServiceDescription {
  machineId: string;
  connected: boolean;
  services: {
    serviceId: string;
    revision: string;
    policySha256: string;
    operations: {
      operationId: string;
      readable: boolean;
      invocable: boolean;
      ready: boolean;
      reason: string | null;
    }[];
  }[];
}
export interface ConfigureServiceConfigurationArgs {
  machineId: string;
  expectedRevision: string | null;
  policies: ServicePolicy[];
}
/** Native policy and credential authority remain host-owned and bound to the caller. */
export interface PluginServiceContext {
  describe(args: { machineId: string }): ServiceDescription;
  readConfiguration(args: { machineId: string }): ServiceConfigurationRead;
  configureConfiguration(args: ConfigureServiceConfigurationArgs): ServiceConfiguration;
  read(args: ServiceReadArgs): Promise<ServiceReply>;
  invoke(args: ServiceInvokeArgs): Promise<ServiceReply>;
  describeInstance(args: { serviceId: string }): InstanceServiceDescription;
  listInstances(args: Record<string, never>): InstanceServicesDescription;
  readInstanceConfiguration(args: { serviceId: string }): InstanceServiceConfigurationRead;
  configureInstance(args: ConfigureInstanceServiceArgs): Promise<InstanceServiceDescription>;
  readInstance(args: InstanceServiceReadArgs): Promise<ServiceReply>;
  invokeInstance(args: InstanceServiceReadArgs): Promise<ServiceReply>;
}

/**
 * THE ONE VERB ONTO A SIBLING (ADR 0041): a server handler opens a door of a plugin its
 * manifest DECLARED as a `required` or `optional` dependency, and gains nothing by it. The
 * callee runs under the principal of the request this handler is serving, its own rungs grade
 * that principal, and the calling plugin is recorded as the origin on the callee's trace.
 *
 * It resolves with the callee door's own parsed result, and REJECTS with the refusal class
 * that stopped it (`ACTION_CALL_REFUSALS`): `undeclared_dependency` for an edge nobody wrote
 * down, `dependency_unavailable` for an optional one that is absent or off, `unknown_action`,
 * `capability` when the principal does not hold what the callee's door demands, `refused` for
 * the callee's own denial, and `dispatch_cycle` / `dispatch_depth` for the two bounds. A
 * handler that lets the rejection escape refuses its OWN dispatch with the same sentence, so
 * the caller of the caller learns which edge failed rather than reading a broken door.
 */
export interface PluginActionContext {
  call(args: { plugin: string; action: string; input: unknown }): Promise<unknown>;
}

/** The producer validates each bounded body against its manifest's declared stream schema. */
export interface StreamProducer {
  readonly epoch: string;
  readonly closed: boolean;
  publish(body: unknown): void;
  close(): void;
  onClose(listener: () => void): () => void;
}
export interface PluginStreamContext {
  open(kind: string, node: ManifoldRef): StreamProducer;
}
