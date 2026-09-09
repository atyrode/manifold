import type {
  JobDescription,
  JobEvent,
  JobFollowSnapshot,
  JobFollowUpdate,
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
