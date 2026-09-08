import { z } from "zod";
import { CapSchema } from "./capabilities.ts";
import { ServiceBindingSchema } from "./services.ts";
import { JobResourceBindingsSchema, JobResourceInventorySchema } from "./job-resources.ts";

const id = z.string().min(1).max(128);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const component = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
  .refine((v) => ![".", "..", "__proto__", "constructor", "prototype"].includes(v));
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
      })
      .optional(),
    bundleFile: component.optional(),
    sha256: hash,
    format: z.enum(["raw", "zip", "tar.gz"]),
    entry: z.array(component).min(1).max(16),
    entrySha256: hash,
    maxBytes: z.number().int().positive().max(536870912),
    maxExpandedBytes: z.number().int().positive().max(1073741824),
    maxMembers: z.number().int().positive().max(10000),
    files: z
      .record(component, z.strictObject({
        entry: z.array(component).min(1).max(16),
        sha256: hash,
        relativeTarget: z.array(locationComponent).min(1).max(16).optional(),
      }))
      .refine((files) => Object.keys(files).length <= 8)
      .optional(),
  })
  .refine((artifact) => (artifact.url === undefined) !== (artifact.bundleFile === undefined), {
    message: "An artifact must name exactly one HTTPS url or bundleFile",
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
const argumentCondition = z.strictObject({
  input: component,
  equals: z.union([z.string().max(65536), z.number().finite(), z.boolean()]),
});
const inputFile = z.strictObject({
  input: component.optional(),
  literal: z.string().max(65536).optional(),
  generated: z.literal("service-bearer").optional(),
  homePath: z.array(locationComponent).min(1).max(16).optional(),
  jsonValues: z.array(z.strictObject({
    path: z.array(z.union([component, z.literal("*")])).min(1).max(16),
    serviceId: component,
    value: z.enum(["url", "bearer"]),
  })).max(64).optional(),
}).refine((file) => [file.input, file.literal, file.generated].filter((value) => value !== undefined).length === 1, {
  message: "An input file needs exactly one declared source",
});
export const MachineOperationSchema = z.strictObject({
  argv: z
    .array(
      z.union([
        z.strictObject({ literal: z.string().max(4096), when: argumentCondition.optional() }),
        z.strictObject({ input: component, when: argumentCondition.optional() }),
      ]),
    )
    .max(64),
  input: z.record(component, MachineInputFieldSchema).refine((v) => Object.keys(v).length <= 64),
  runtimeTools: z.array(component).max(8),
  executable: z.strictObject({ runtimeTool: component }).optional(),
  inputFiles: z.record(component, inputFile)
    .refine((files) => Object.keys(files).length <= 64).optional(),
  services: z.array(ServiceBindingSchema).max(16).optional(),
  providesService: z.boolean().optional(),
  locations: z
    .array(z.strictObject({ locationId: id, access: z.enum(["read", "write", "create"]) }))
    .max(32),
  outputs: z.array(boundOutputName).max(32),
  network: z.enum(["none", "host"]),
  limits: JobLimitsSchema,
  stdin: z.boolean(),
}).refine((operation) => !operation.executable ||
  operation.runtimeTools.includes(operation.executable.runtimeTool), {
  message: "The executable must name a required runtimeTool",
}).refine((operation) => Object.values(operation.inputFiles ?? {}).every((file) =>
  (file.input === undefined || (operation.input[file.input]?.type === "string" && operation.input[file.input]?.required === true)) &&
  (file.generated === undefined || (operation.providesService === true && file.jsonValues === undefined)) &&
  (file.jsonValues ?? []).every((value) => operation.services?.some((binding) => binding.serviceId === value.serviceId))), {
  message: "Input file sources and service values must be declared by the operation",
}).refine((operation) => operation.argv.every((slot) => !slot.when ||
  operation.input[slot.when.input]?.type === typeof slot.when.equals), {
  message: "Conditional arguments must compare a declared input of the same type",
}).refine((operation) => new Set(operation.runtimeTools).size === operation.runtimeTools.length, {
  message: "Runtime tools must be unique",
});
const platformArtifacts = z.partialRecord(
  z.enum(["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"]),
  MachineArtifactSchema,
);
export const MachineHalfSchema = z.strictObject({
  artifacts: platformArtifacts,
  tools: z.record(component, platformArtifacts)
    .refine((tools) => Object.keys(tools).length <= 8).optional(),
  operations: z
    .record(id, MachineOperationSchema)
    .refine((v) => Object.keys(v).length > 0 && Object.keys(v).length <= 64),
  locations: z.record(id, MachineLocationSchema).refine((v) => Object.keys(v).length <= 64),
  requiresResourceBindings: z.boolean().optional(),
});
export type MachineHalf = z.infer<typeof MachineHalfSchema>;
export type MachineArtifact = z.infer<typeof MachineArtifactSchema>;
export type MachineOperation = z.infer<typeof MachineOperationSchema>;
export type MachineLocation = z.infer<typeof MachineLocationSchema>;
/** All declared layouts, including managed tools; callers still select the owner platform. */
export function machineArtifacts(machine: MachineHalf | undefined): MachineArtifact[] {
  return [
    ...Object.values(machine?.artifacts ?? {}),
    ...Object.values(machine?.tools ?? {}).flatMap((platforms) => Object.values(platforms)),
  ];
}
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
  resourceBindings: JobResourceBindingsSchema.optional(),
  input: z
    .record(component, z.union([z.string().max(65536), z.number().finite(), z.boolean()]))
    .refine((v) => Object.keys(v).length <= 64 && new TextEncoder().encode(JSON.stringify(v)).byteLength <= 65536),
  limits: JobLimitsSchema,
  outputs: z.array(JobOutputBindingSchema).max(30),
  parent: z.strictObject({ parentJobId: id, invocationId: id }).nullable(),
  credential: JobCredentialSchema,
  traceId: id,
  requestDigest: hash,
  /** Native terminal admission only; never accepted by ordinary job execute input. */
  terminal: z.strictObject({ terminalId: id, terminalHostId: id, containerId: id }).optional(),
});
export type JobRequest = z.infer<typeof JobRequestSchema>;
/** Pinned installation input, not executable, working-directory or environment authority. */
export const TerminalRuntimeSchema = JobRequestSchema.pick({
  pluginId: true,
  operationId: true,
  installationRevision: true,
  artifactSha256: true,
  input: true,
}).extend({ resourceBindingDigest: hash });
export type TerminalRuntime = z.infer<typeof TerminalRuntimeSchema>;
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
  resources: JobResourceInventorySchema.optional(),
  operations: z.record(id, z.strictObject({
    ready: z.boolean(),
    reason: id.nullable(),
    resourceBindingDigest: hash,
  })).optional(),
  installation: z
    .strictObject({
      revision: id,
      artifactSha256: hash,
      enabled: z.boolean(),
      ready: z.boolean(),
      purgeRequested: z.boolean(),
      resourceBindings: JobResourceBindingsSchema.optional(),
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
    z.strictObject({ kind: z.literal("action"), traceId: id, door: id.nullable() }),
    z.strictObject({
      kind: z.literal("schedule"),
      traceId: id,
      door: id.nullable(),
      scheduleId: id,
      revision: id,
      nominalAt: count,
    }),
    z.strictObject({
      kind: z.literal("invocation"),
      traceId: id,
      door: id.nullable(),
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
  inputDigest: hash,
  resourceBindingDigest: hash,
  state: JobStateSchema,
  result: JobResultSchema.nullable(),
  authority: JobAuthoritySchema,
  terminal: JobRequestSchema.shape.terminal,
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
  .refine(({ job, occurrence }) => job !== null || occurrence !== null, {
    message: "A run must contain a job or schedule occurrence",
  })
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
  resources: JobResourceInventorySchema.optional(),
  /** Present only when this owner shares the native terminal host's supervision boundary. */
  terminalHostId: id.optional(),
});
export type JobOwner = z.infer<typeof JobOwnerSchema>;
/** The existing 16 MiB plugin JSON budget also bounds a single base64 machine member. */
export const MAX_JOB_ARTIFACT_BASE64_BYTES = 16 * 1024 * 1024;
export const MAX_JOB_INSTALL_METADATA_BYTES = 1024 * 1024;
export const MAX_JOB_INSTALL_FRAME_BYTES =
  MAX_JOB_ARTIFACT_BASE64_BYTES + MAX_JOB_INSTALL_METADATA_BYTES;
export const JobArtifactDeliverySchema = z.strictObject({
  bundleFile: component,
  data: z.base64().max(MAX_JOB_ARTIFACT_BASE64_BYTES),
});
export type JobArtifactDelivery = z.infer<typeof JobArtifactDeliverySchema>;
const chunk = { seq: count, data: z.base64().max(87384) };
export const JobStartCommandSchema = z.strictObject({
  type: z.literal("start"), request: JobRequestSchema, permit: JobPermitSchema,
});
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
    resourceBindings: JobResourceBindingsSchema.optional(),
    action: z.enum(["disable", "purge"]).optional(),
    artifact: JobArtifactDeliverySchema.optional(),
    /** Additional exact bundle members, keyed by bundleFile; the primary member is not repeated. */
    toolArtifacts: z.record(component, z.base64().max(MAX_JOB_ARTIFACT_BASE64_BYTES))
      .refine((files) => Object.keys(files).length <= 8).optional(),
  }).refine(({ artifact, toolArtifacts, ...metadata }) =>
    new TextEncoder().encode(JSON.stringify(metadata)).byteLength +
      (artifact === undefined ? 0 : artifact.bundleFile.length) +
      Object.keys(toolArtifacts ?? {}).reduce((bytes, name) => bytes + name.length + 8, 0) + 256 <= MAX_JOB_INSTALL_METADATA_BYTES,
    { message: "install metadata exceeds the frame budget" })
    .refine(({ artifact, toolArtifacts }) =>
      (artifact?.data.length ?? 0) + Object.values(toolArtifacts ?? {}).reduce((bytes, data) => bytes + data.length, 0) <= MAX_JOB_ARTIFACT_BASE64_BYTES &&
      (!artifact || !Object.hasOwn(toolArtifacts ?? {}, artifact.bundleFile)), {
      message: "install bundle members exceed the aggregate budget or repeat the primary",
    }),
  JobStartCommandSchema,
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
  z.strictObject({
    type: z.literal("service_authorized"),
    jobId: id,
    authorizationId: id,
    allowed: z.boolean(),
  }),
]);
export type JobCommand = z.infer<typeof JobCommandSchema>;
export const JobInstallationResourcesSchema = z.strictObject({
  artifactAvailable: z.boolean(),
  tools: z.array(z.strictObject({
    alias: component, managed: z.boolean(), available: z.boolean(),
    artifactSha256: hash.optional(), entrySha256: hash.optional(), reason: id.optional(),
  })).max(520).refine((tools) => new Set(tools.map((tool) => tool.alias)).size === tools.length),
  operations: z.array(z.strictObject({
    operationId: id, available: z.boolean(), reason: id.optional(),
  })).max(64).refine((operations) => new Set(operations.map((operation) => operation.operationId)).size === operations.length),
});
export type JobInstallationResources = z.infer<typeof JobInstallationResourcesSchema>;
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
    resources: JobInstallationResourcesSchema.optional(),
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
  z.strictObject({
    type: z.literal("service_authorize"),
    jobId: id,
    authorizationId: id,
    serviceId: component,
    revision: component,
    policySha256: hash,
    operationId: component,
  }),
  z.strictObject({
    type: z.literal("resources"),
    resources: JobResourceInventorySchema,
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
