import type {
  JobDescription,
  JobEvent,
  JobFollowSnapshot,
  JobFollowUpdate,
  JobRequest,
  ListJobRunsArgs,
  ListJobRunsResult,
  ManifoldRef,
  PublicJob,
} from "@manifold/protocol";

export type JobExecution = Pick<
  JobRequest,
  "jobId" | "machineId" | "operationId" | "input" | "outputs"
> & {
  limits?: JobRequest["limits"] | undefined;
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
  input(args: { node: JobNode; seq: number; data: string; eof: boolean }): { accepted: true };
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
