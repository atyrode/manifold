import { z } from "zod";
import { CapSchema } from "./capabilities.ts";

const id = z.string().min(1).max(128);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const component = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
  .refine((v) => v !== "." && v !== "..");
const locationComponent = z
  .string()
  .regex(/^[A-Za-z0-9.][A-Za-z0-9._-]{0,127}$/)
  .refine((value) => value !== "." && value !== "..");
export const JobLimitsSchema = z.strictObject({
  timeoutMs: z.number().int().positive().max(86400000),
  memoryBytes: z.number().int().positive().max(1099511627776),
  processes: z.number().int().positive().max(4096),
  outputBytes: z.number().int().positive().max(1073741824),
});
export const MachineArtifactSchema = z
  .strictObject({
    url: z
      .url()
      .max(4096)
      .refine((v) => {
        const url = new URL(v);
        return url.protocol === "https:" && url.username === "" && url.password === "";
      }),
    sha256: hash,
    format: z.enum(["raw", "zip", "tar.gz"]),
    entry: z.array(component).min(1).max(16),
    entrySha256: hash,
    maxBytes: z.number().int().positive().max(536870912),
    maxExpandedBytes: z.number().int().positive().max(1073741824),
    maxMembers: z.number().int().positive().max(10000),
    files: z
      .record(component, z.strictObject({ entry: z.array(component).min(1).max(16), sha256: hash }))
      .refine((files) => Object.keys(files).length <= 8)
      .optional(),
  })
  .refine(
    (artifact) => artifact.format !== "raw" || Object.keys(artifact.files ?? {}).length === 0,
  );
export const MachineLocationSchema = z.strictObject({
  anchor: z.enum(["home", "data", "state", "cache", "config", "runtime"]),
  components: z.array(locationComponent).min(1).max(16),
  revision: id,
  kind: z.enum(["file", "directory"]).optional(),
  guestPath: z
    .string()
    .max(4096)
    .regex(
      /^\/home\/job\/(?!\.{1,2}(?:\/|$))[A-Za-z0-9._-]{1,128}(?:\/(?!\.{1,2}(?:\/|$))[A-Za-z0-9._-]{1,128}){0,15}$/,
    )
    .optional(),
});
export const MachineInputFieldSchema = z.strictObject({
  type: z.enum(["string", "number", "boolean"]),
  required: z.boolean(),
  maxLength: z.number().int().positive().max(65536).optional(),
  format: z.literal("revisioned-id").optional(),
  enum: z
    .array(z.union([z.string().max(65536), z.number().finite(), z.boolean()]))
    .max(64)
    .optional(),
});
const boundOutputName = component.refine((name) => name !== "stdout" && name !== "stderr");
export const MachineOperationSchema = z.strictObject({
  argv: z
    .array(
      z.union([
        z.strictObject({ literal: z.string().max(4096) }),
        z.strictObject({ input: component }),
      ]),
    )
    .max(64),
  input: z.record(component, MachineInputFieldSchema).refine((v) => Object.keys(v).length <= 64),
  runtimeTools: z.array(component).max(8),
  locations: z
    .array(z.strictObject({ locationId: id, access: z.enum(["read", "write", "create"]) }))
    .max(32),
  outputs: z.array(boundOutputName).max(32),
  network: z.enum(["none", "host"]),
  limits: JobLimitsSchema,
  stdin: z.boolean(),
});
export const MachineHalfSchema = z.strictObject({
  artifacts: z.partialRecord(
    z.enum(["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"]),
    MachineArtifactSchema,
  ),
  operations: z
    .record(id, MachineOperationSchema)
    .refine((v) => Object.keys(v).length > 0 && Object.keys(v).length <= 64),
  locations: z.record(id, MachineLocationSchema).refine((v) => Object.keys(v).length <= 64),
});
export type MachineHalf = z.infer<typeof MachineHalfSchema>;
export type MachineArtifact = z.infer<typeof MachineArtifactSchema>;
export type MachineOperation = z.infer<typeof MachineOperationSchema>;
export type MachineLocation = z.infer<typeof MachineLocationSchema>;
export const JobCredentialSchema = z.strictObject({
  principalId: id,
  tokenId: id.nullable(),
  grantId: id.nullable(),
  caps: z.array(CapSchema).max(128),
  containerScope: id.nullable(),
  expiresAt: count.optional(),
});
export const JobOutputBindingSchema = z.strictObject({
  name: boundOutputName,
  locationId: id,
  components: z.array(component).min(1).max(16),
});
export const JobOutputRuleSchema = JobOutputBindingSchema.extend({
  maxSuffixComponents: z.number().int().nonnegative().max(16),
}).refine((rule) => rule.components.length + rule.maxSuffixComponents <= 16);
export type JobOutputRule = z.infer<typeof JobOutputRuleSchema>;
export const JobRequestSchema = z.strictObject({
  jobId: id,
  machineId: id,
  operationId: id,
  pluginId: id,
  installationRevision: id,
  artifactSha256: hash,
  input: z
    .record(component, z.union([z.string().max(65536), z.number().finite(), z.boolean()]))
    .refine((v) => Object.keys(v).length <= 64 && JSON.stringify(v).length <= 65536),
  limits: JobLimitsSchema,
  outputs: z.array(JobOutputBindingSchema).max(30),
  parent: z.strictObject({ parentJobId: id, invocationId: id }).nullable(),
  credential: JobCredentialSchema,
  traceId: id,
  requestDigest: hash,
});
export type JobRequest = z.infer<typeof JobRequestSchema>;
export const JobPermitSchema = z.strictObject({
  permitId: id,
  jobId: id,
  requestDigest: hash,
  ownerId: id,
  ownerGeneration: count,
  decisionId: id,
  policyRevision: id,
  issuedAt: count,
  expiresAt: count,
  signature: z.base64().max(1024),
});
export type JobPermit = z.infer<typeof JobPermitSchema>;
export const JobStateSchema = z.enum([
  "queued",
  "admitted",
  "start-committed",
  "started",
  "exited",
  "interrupted",
  "cancelled",
  "refused",
]);
export const JobResultSchema = z.strictObject({
  jobId: id,
  requestDigest: hash,
  ownerId: id,
  ownerGeneration: count,
  state: JobStateSchema,
  exitCode: z.number().int().nullable(),
  reason: id.nullable(),
  startedAt: count.nullable(),
  finishedAt: count.nullable(),
  usage: z
    .strictObject({ elapsedMs: count, memoryBytes: count, processes: count, outputBytes: count })
    .nullable(),
  limits: JobLimitsSchema,
  outputs: z
    .array(
      z.strictObject({ outputId: id, name: component, sha256: hash, bytes: count, files: count }),
    )
    .max(32),
});
export type JobResult = z.infer<typeof JobResultSchema>;
export const JobDescriptionSchema = z.strictObject({
  machineId: id,
  pluginId: id,
  admissionPublicKey: z.string().startsWith("-----BEGIN PUBLIC KEY-----").max(4096),
  connected: z.boolean(),
  platforms: z.array(z.string()),
  installation: z
    .strictObject({
      revision: id,
      artifactSha256: hash,
      enabled: z.boolean(),
      ready: z.boolean(),
      purgeRequested: z.boolean(),
    })
    .nullable(),
  retainedInstallations: z.array(z.strictObject({ revision: id, artifactSha256: hash })).max(128),
  consents: z.array(
    z.strictObject({
      node: z.string(),
      cap: CapSchema,
      enabled: z.boolean(),
      revision: id,
    }),
  ),
});
export type JobDescription = z.infer<typeof JobDescriptionSchema>;
export const JobAuthoritySchema = z.strictObject({
  origin: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("action"), traceId: id }),
    z.strictObject({
      kind: z.literal("schedule"),
      traceId: id,
      scheduleId: id,
      revision: id,
      nominalAt: count,
    }),
    z.strictObject({
      kind: z.literal("invocation"),
      traceId: id,
      parentJobId: id,
      invocationId: id,
    }),
  ]),
  requester: id,
  executor: z.strictObject({ machineId: id, ownerId: id, ownerGeneration: count }).nullable(),
  decision: z
    .strictObject({
      decisionId: id,
      policyRevision: id,
      allowed: z.boolean(),
      refusal: id.nullable(),
      grants: z.array(
        z.strictObject({
          node: z.string(),
          cap: CapSchema,
          allowed: z.boolean(),
          grantId: id.nullable(),
          authorizer: id.nullable(),
          revision: count,
        }),
      ),
      consents: z.array(z.strictObject({ node: z.string(), revision: id, artifactSha256: hash })),
    })
    .nullable(),
});
export type JobAuthority = z.infer<typeof JobAuthoritySchema>;
export const PublicJobSchema = z.strictObject({
  jobId: id,
  machineId: id,
  operationId: id,
  pluginId: id,
  installationRevision: id,
  artifactSha256: hash,
  state: JobStateSchema,
  result: JobResultSchema.nullable(),
  authority: JobAuthoritySchema,
});
export type PublicJob = z.infer<typeof PublicJobSchema>;

export const ListJobRunsArgsSchema = z.strictObject({
  machineId: JobRequestSchema.shape.machineId,
  operationId: JobRequestSchema.shape.operationId.optional(),
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).max(2048).optional(),
});
export type ListJobRunsArgs = z.infer<typeof ListJobRunsArgsSchema>;
export const PublicScheduleOccurrenceSchema = z.strictObject({
  scheduleId: z.string().min(1).max(256),
  revision: z.string().min(1).max(256),
  nominalAt: count,
  jobId: JobRequestSchema.shape.jobId,
  machineId: JobRequestSchema.shape.machineId,
  pluginId: JobRequestSchema.shape.pluginId,
  operationId: JobRequestSchema.shape.operationId,
  installationRevision: JobRequestSchema.shape.installationRevision,
  artifactSha256: JobRequestSchema.shape.artifactSha256,
  state: z.enum(["pending", "enqueued", "skipped", "refused"]),
  reason: z.string().max(2048).nullable(),
});
export type PublicScheduleOccurrence = z.infer<typeof PublicScheduleOccurrenceSchema>;
export const PublicJobRunSchema = z
  .strictObject({
    job: PublicJobSchema.nullable(),
    occurrence: PublicScheduleOccurrenceSchema.nullable(),
  })
  .refine(
    ({ job, occurrence }) =>
      job !== null || occurrence !== null,
    { message: "A run must contain a job or schedule occurrence" },
  )
  .refine(
    ({ job, occurrence }) =>
      job === null ||
      occurrence === null ||
      (job.jobId === occurrence.jobId &&
        job.machineId === occurrence.machineId &&
        job.pluginId === occurrence.pluginId &&
        job.operationId === occurrence.operationId &&
        job.installationRevision === occurrence.installationRevision &&
        job.artifactSha256 === occurrence.artifactSha256),
    { message: "Job and occurrence targets must agree" },
  );
export type PublicJobRun = z.infer<typeof PublicJobRunSchema>;
export const ListJobRunsResultSchema = z.strictObject({
  runs: z.array(PublicJobRunSchema).max(100),
  nextCursor: z.string().min(1).max(2048).nullable(),
});
export type ListJobRunsResult = z.infer<typeof ListJobRunsResultSchema>;
export const JobOwnerSchema = z.strictObject({
  ownerId: id,
  publicKey: z.string().min(1).max(4096),
  generation: count,
  platforms: z.array(z.enum(["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"])).max(4),
  inventoryDigest: hash,
});
export type JobOwner = z.infer<typeof JobOwnerSchema>;
const chunk = { seq: count, data: z.base64().max(87384) };
export const JobCommandSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("owner_challenge"),
    nonce: id,
    serverEpoch: id,
    machineId: id,
    admissionPublicKey: z.string().max(4096),
  }),
  z.strictObject({
    type: z.literal("install"),
    pluginId: id,
    installationRevision: id,
    machine: MachineHalfSchema,
    artifactSha256: hash,
    action: z.enum(["disable", "purge"]).optional(),
  }),
  z.strictObject({ type: z.literal("start"), request: JobRequestSchema, permit: JobPermitSchema }),
  z.strictObject({ type: z.literal("input"), jobId: id, ...chunk, eof: z.boolean() }),
  z.strictObject({ type: z.literal("cancel"), jobId: id, reason: id }),
  z.strictObject({ type: z.literal("status"), jobId: id }),
  z.strictObject({ type: z.literal("drain"), draining: z.boolean() }),
  z.strictObject({
    type: z.literal("output_read"),
    jobId: id,
    outputId: id,
    requestId: id,
    offset: count,
    maxBytes: z.number().int().positive().max(65536),
  }),
  z.strictObject({ type: z.literal("output_release"), jobId: id, outputId: id }),
  z.strictObject({
    type: z.literal("invocation_reply"),
    parentJobId: id,
    invocationId: id,
    jobId: id.nullable(),
    reason: id.nullable(),
  }),
]);
export type JobCommand = z.infer<typeof JobCommandSchema>;
export const JobEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("owner_proof"),
    nonce: id,
    serverEpoch: id,
    machineId: id,
    owner: JobOwnerSchema,
    signature: z.base64().max(1024),
  }),
  z.strictObject({
    type: z.literal("installed"),
    pluginId: id,
    installationRevision: id,
    artifactSha256: hash,
  }),
  z.strictObject({
    type: z.literal("state"),
    jobId: id,
    requestDigest: hash,
    ownerId: id,
    ownerGeneration: count,
    state: JobStateSchema,
  }),
  z.strictObject({
    type: z.literal("output"),
    jobId: id,
    outputId: id,
    requestId: id,
    ...chunk,
    eof: z.boolean(),
  }),
  z.strictObject({ type: z.literal("result"), result: JobResultSchema }),
  z.strictObject({ type: z.literal("refusal"), jobId: id, reason: id }),
  z.strictObject({
    type: z.literal("invocation"),
    parentJobId: id,
    invocationId: id,
    operationId: id,
    input: JobRequestSchema.shape.input,
    outputs: JobRequestSchema.shape.outputs,
  }),
]);
export type JobEvent = z.infer<typeof JobEventSchema>;
export const JobFollowEventSchema = z.union([
  JobEventSchema.options[2],
  JobEventSchema.options[3],
  JobEventSchema.options[4],
  JobEventSchema.options[5],
]);
export type JobFollowEvent = z.infer<typeof JobFollowEventSchema>;
export const MAX_JOB_FOLLOW_EVENTS = 128;
export const MAX_JOB_FOLLOW_BYTES = 262144;
export const JobFollowSnapshotSchema = z.strictObject({
  jobId: id,
  state: JobStateSchema,
  result: JobResultSchema.nullable(),
  seq: count,
  firstSeq: count.nullable(),
  events: z
    .array(z.strictObject({ seq: count, event: JobFollowEventSchema }))
    .max(MAX_JOB_FOLLOW_EVENTS),
  unavailable: z.strictObject({ fromSeq: count, toSeq: count }).nullable(),
});
export type JobFollowSnapshot = z.infer<typeof JobFollowSnapshotSchema>;
export const JobFollowUpdateSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("event"), seq: count, event: JobFollowEventSchema }),
  z.strictObject({
    type: z.literal("closed"),
    reason: z.enum(["authority_revoked", "gap", "limit", "consumer_failed", "closed"]),
  }),
]);
export type JobFollowUpdate = z.infer<typeof JobFollowUpdateSchema>;
/** Canonical signing/digest encoding: sorted object keys, order-preserving arrays. */
export function canonicalJobJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJobJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .filter((k) => object[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJobJson(object[k])}`)
    .join(",")}}`;
}
