import { z } from "zod";
import { CapSchema } from "./capabilities.ts";
import {
  ServiceAuthoritySubjectSchema,
  ServiceBindingSchema,
  ServiceConfigurationSchema,
  ServiceReadArgsSchema,
  ServiceInvokeArgsSchema,
  ServiceReplySchema,
} from "./services.ts";
import { ServiceTunnelFrameSchema } from "./services.ts";
import { JobResourceBindingsSchema, JobResourceInventorySchema } from "./job-resources.ts";

/** Native owner RPC changes independently of hub, session, and transport releases. */
export const JOB_OWNER_PROTOCOL_VERSION = 30;

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
/** Zero is reserved for native instance-service admission, never ordinary execution. */
const executionLimits = JobLimitsSchema.extend({
  timeoutMs: JobLimitsSchema.shape.timeoutMs.or(z.literal(0)),
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
      .record(
        component,
        z.strictObject({
          entry: z.array(component).min(1).max(16),
          sha256: hash,
          relativeTarget: z.array(locationComponent).min(1).max(16).optional(),
        }),
      )
      .refine((files) => Object.keys(files).length <= 8)
      .optional(),
  })
  .refine((artifact) => (artifact.url === undefined) !== (artifact.bundleFile === undefined), {
    message: "An artifact must name exactly one HTTPS url or bundleFile",
  })
  .refine(
    (artifact) => artifact.format !== "raw" || Object.keys(artifact.files ?? {}).length === 0,
  );
export const MachineLocationSchema = z
  .strictObject({
    anchor: z.enum(["home", "data", "state", "cache", "config", "runtime"]),
    components: z.array(locationComponent).min(1).max(16),
    revision: id,
    kind: z.enum(["file", "directory"]).optional(),
    /** Native retained storage is namespaced by plugin beneath the private owner store. */
    managed: z.literal(true).optional(),
    guestPath: z
      .string()
      .max(4096)
      .regex(
        /^\/home\/job\/(?!\.{1,2}(?:\/|$))[A-Za-z0-9._-]{1,128}(?:\/(?!\.{1,2}(?:\/|$))[A-Za-z0-9._-]{1,128}){0,15}$/,
      )
      .optional(),
  })
  .refine(
    (location) =>
      !location.managed || (location.anchor === "state" && location.kind === "directory"),
    {
      message: "Managed storage requires a state directory",
    },
  );
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
const inputFile = z
  .strictObject({
    input: component.optional(),
    literal: z.string().max(65536).optional(),
    generated: z.literal("service-bearer").optional(),
    homePath: z.array(locationComponent).min(1).max(16).optional(),
    jsonValues: z
      .array(
        z.strictObject({
          path: z
            .array(z.union([component, z.literal("*")]))
            .min(1)
            .max(16),
          serviceId: component,
          value: z.enum(["url", "bearer"]),
        }),
      )
      .max(64)
      .optional(),
  })
  .refine(
    (file) =>
      [file.input, file.literal, file.generated].filter((value) => value !== undefined).length ===
      1,
    {
      message: "An input file needs exactly one declared source",
    },
  );
export const MachineOperationSchema = z
  .strictObject({
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
    /** Fixed reviewed values cannot replace native transport or private-home bindings. */
    environment: z
      .record(
        z
          .string()
          .regex(/^[A-Z_][A-Z0-9_]{0,63}$/)
          .refine(
            (name) =>
              !["HOME", "PATH", "TMPDIR"].includes(name) &&
              !name.startsWith("MANIFOLD_") &&
              !name.startsWith("XDG_"),
          ),
        z
          .string()
          .max(4096)
          .refine((value) => !value.includes("\0")),
      )
      .refine(
        (values) =>
          Object.keys(values).length <= 64 &&
          new TextEncoder().encode(JSON.stringify(values)).length <= 65536,
      )
      .optional(),
    inputFiles: z
      .record(component, inputFile)
      .refine((files) => Object.keys(files).length <= 64)
      .optional(),
    services: z.array(ServiceBindingSchema).max(16).optional(),
    providesService: z.boolean().optional(),
    workingDirectory: z.strictObject({ locationId: id }).optional(),
    locations: z
      .array(z.strictObject({ locationId: id, access: z.enum(["read", "write", "create"]) }))
      .max(32),
    outputs: z.array(boundOutputName).max(32),
    network: z.enum(["none", "host"]),
    limits: JobLimitsSchema,
    stdin: z.boolean(),
  })
  .refine(
    (operation) =>
      !operation.executable || operation.runtimeTools.includes(operation.executable.runtimeTool),
    {
      message: "The executable must name a required runtimeTool",
    },
  )
  .refine(
    (operation) =>
      Object.values(operation.inputFiles ?? {}).every(
        (file) =>
          (file.input === undefined ||
            (operation.input[file.input]?.type === "string" &&
              operation.input[file.input]?.required === true)) &&
          (file.generated === undefined ||
            (operation.providesService === true && file.jsonValues === undefined)) &&
          (file.jsonValues ?? []).every((value) =>
            operation.services?.some((binding) => binding.serviceId === value.serviceId),
          ),
      ),
    {
      message: "Input file sources and service values must be declared by the operation",
    },
  )
  .refine(
    (operation) =>
      operation.argv.every(
        (slot) => !slot.when || operation.input[slot.when.input]?.type === typeof slot.when.equals,
      ),
    {
      message: "Conditional arguments must compare a declared input of the same type",
    },
  )
  .refine((operation) => new Set(operation.runtimeTools).size === operation.runtimeTools.length, {
    message: "Runtime tools must be unique",
  })
  .refine(
    (operation) =>
      !operation.workingDirectory ||
      operation.locations.some(
        (location) => location.locationId === operation.workingDirectory!.locationId,
      ),
    {
      message: "The working directory must name a declared location",
    },
  );
const platformArtifacts = z.partialRecord(
  z.enum(["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"]),
  MachineArtifactSchema,
);
export const MachineHalfSchema = z
  .strictObject({
    artifacts: platformArtifacts,
    tools: z
      .record(component, platformArtifacts)
      .refine((tools) => Object.keys(tools).length <= 8)
      .optional(),
    operations: z
      .record(id, MachineOperationSchema)
      .refine((v) => Object.keys(v).length > 0 && Object.keys(v).length <= 64),
    locations: z.record(id, MachineLocationSchema).refine((v) => Object.keys(v).length <= 64),
    requiresResourceBindings: z.boolean().optional(),
  })
  .refine(
    (machine) =>
      Object.values(machine.operations).every((operation) =>
        operation.locations.every(
          (location) =>
            !machine.locations[location.locationId]?.managed || location.access !== "create",
        ),
      ),
    {
      message:
        "Managed storage is provisioned by native ownership; operations request read or write",
    },
  );
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
    .refine(
      (v) =>
        Object.keys(v).length <= 64 &&
        new TextEncoder().encode(JSON.stringify(v)).byteLength <= 65536,
    ),
  limits: executionLimits,
  outputs: z.array(JobOutputBindingSchema).max(30),
  parent: z.strictObject({ parentJobId: id, invocationId: id }).nullable(),
  credential: JobCredentialSchema,
  traceId: id,
  requestDigest: hash,
  /** Native terminal admission only; never accepted by ordinary job execute input. */
  terminal: z.strictObject({ terminalId: id, terminalHostId: id, containerId: id }).optional(),
  /** Native durable-service admission only; no browser or worker can choose this origin. */
  service: z
    .strictObject({ serviceId: component, revision: component, policySha256: hash })
    .optional(),
});
export type JobRequest = z.infer<typeof JobRequestSchema>;

export const JobInvocationTargetSchema = JobRequestSchema.pick({
  machineId: true,
  pluginId: true,
  operationId: true,
  installationRevision: true,
  artifactSha256: true,
});
export const JobInvocationEdgeSchema = z.strictObject({
  caller: JobInvocationTargetSchema,
  callee: JobInvocationTargetSchema,
  resources: z
    .array(
      z.strictObject({
        locationId: z.string().min(1).max(256),
        revision: z.string().min(1).max(256),
        access: z.enum(["read", "write", "create"]),
      }),
    )
    .max(32),
  outputs: z.array(JobOutputRuleSchema).max(30),
  maxDepth: z.number().int().positive().max(64),
  maxConcurrency: z.number().int().positive().max(4096),
  aggregate: JobLimitsSchema,
});
export type JobInvocationEdge = z.infer<typeof JobInvocationEdgeSchema>;
export const InspectJobInvocationsArgsSchema = z.strictObject({ machineId: id, pluginId: id });
export const JobInvocationCandidateSchema = z.strictObject({
  serviceId: id,
  revision: id,
  operationIds: z.array(id),
  policySha256: hash,
  caller: JobInvocationTargetSchema,
  callee: JobInvocationTargetSchema,
  resources: JobInvocationEdgeSchema.shape.resources,
  callerLimits: JobLimitsSchema,
  calleeLimits: JobLimitsSchema,
  locations: z.record(id, MachineLocationSchema),
  outputNames: MachineOperationSchema.shape.outputs,
  outputLocations: z.record(id, MachineLocationSchema),
});
export type JobInvocationCandidate = z.infer<typeof JobInvocationCandidateSchema>;
export const InspectJobInvocationsResultSchema = z.strictObject({
  machineId: id,
  pluginId: id,
  candidates: z.array(JobInvocationCandidateSchema),
  unavailable: z.array(
    z.strictObject({
      caller: JobInvocationTargetSchema,
      serviceId: id,
      revision: id,
      reason: z.string(),
    }),
  ),
  edges: z.array(z.strictObject({ edge: JobInvocationEdgeSchema, enabled: z.boolean() })),
});
export type InspectJobInvocationsResult = z.infer<typeof InspectJobInvocationsResultSchema>;
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
  limits: executionLimits,
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
  operations: z
    .record(
      id,
      z.strictObject({
        ready: z.boolean(),
        reason: id.nullable(),
        resourceBindingDigest: hash,
      }),
    )
    .optional(),
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
      kind: z.literal("service"),
      traceId: id,
      door: id.nullable(),
      serviceId: component,
      revision: component,
    }),
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
  /** Owner-confirmed cursor; null while disconnected, awaiting receipt or reconciliation. */
  nextInputSeq: count.nullable(),
  result: JobResultSchema.nullable(),
  authority: JobAuthoritySchema,
  terminal: JobRequestSchema.shape.terminal,
  service: JobRequestSchema.shape.service,
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
/** Retained owner announcements must remain readable for maintenance across RPC upgrades. */
export const JobOwnerSchema = z.strictObject({
  protocolVersion: z.number().int().positive(),
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
  type: z.literal("start"),
  request: JobRequestSchema,
  permit: JobPermitSchema,
});
export const JobCommandSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("owner_challenge"),
    nonce: id,
    serverEpoch: id,
    machineId: id,
    admissionPublicKey: z.string().max(4096),
  }),
  z
    .strictObject({
      type: z.literal("install"),
      pluginId: id,
      installationRevision: id,
      machine: MachineHalfSchema,
      artifactSha256: hash,
      resourceBindings: JobResourceBindingsSchema.optional(),
      action: z.enum(["disable", "purge"]).optional(),
      artifact: JobArtifactDeliverySchema.optional(),
      /** Additional exact bundle members, keyed by bundleFile; the primary member is not repeated. */
      toolArtifacts: z
        .record(component, z.base64().max(MAX_JOB_ARTIFACT_BASE64_BYTES))
        .refine((files) => Object.keys(files).length <= 8)
        .optional(),
    })
    .refine(
      ({ artifact, toolArtifacts, ...metadata }) =>
        new TextEncoder().encode(JSON.stringify(metadata)).byteLength +
          (artifact === undefined ? 0 : artifact.bundleFile.length) +
          Object.keys(toolArtifacts ?? {}).reduce((bytes, name) => bytes + name.length + 8, 0) +
          256 <=
        MAX_JOB_INSTALL_METADATA_BYTES,
      { message: "install metadata exceeds the frame budget" },
    )
    .refine(
      ({ artifact, toolArtifacts }) =>
        (artifact?.data.length ?? 0) +
          Object.values(toolArtifacts ?? {}).reduce((bytes, data) => bytes + data.length, 0) <=
          MAX_JOB_ARTIFACT_BASE64_BYTES &&
        (!artifact || !Object.hasOwn(toolArtifacts ?? {}, artifact.bundleFile)),
      {
        message: "install bundle members exceed the aggregate budget or repeat the primary",
      },
    ),
  JobStartCommandSchema,
  z.strictObject({
    type: z.literal("input"),
    jobId: id,
    requestId: id,
    ...chunk,
    eof: z.boolean(),
  }),
  // Supplying admission abandons an unknown start durably; it never retries execution.
  z.strictObject({
    type: z.literal("cancel"),
    jobId: id,
    reason: id,
    admission: JobStartCommandSchema.omit({ type: true }).optional(),
  }),
  // Retirement requires a signed instance-service admission, supplied here or retained by the owner.
  z
    .strictObject({
      type: z.literal("retire"),
      jobId: id,
      reason: id,
      admission: JobStartCommandSchema.omit({ type: true }).optional(),
    })
    .refine(({ admission }) => !admission || admission.request.service !== undefined, {
      message: "Only instance-service workloads may retire",
    }),
  z.strictObject({
    type: z.literal("status"),
    jobId: id,
    admission: JobStartCommandSchema.omit({ type: true }).optional(),
  }),
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
    subject: ServiceAuthoritySubjectSchema,
    authorizationId: id,
    allowed: z.boolean(),
  }),
  z.strictObject({
    type: z.literal("input_authorized"),
    jobId: id,
    requestId: id,
    allowed: z.boolean(),
  }),
  z.strictObject({
    type: z.literal("configure_services"),
    configuration: ServiceConfigurationSchema,
  }),
  z.strictObject({
    type: z.literal("service_read"),
    requestId: id,
    ...ServiceReadArgsSchema.shape,
  }),
  z.strictObject({ type: z.literal("service_read_cancel"), requestId: id }),
  z.strictObject({
    type: z.literal("service_invoke"),
    requestId: id,
    ...ServiceInvokeArgsSchema.shape,
  }),
  z.strictObject({ type: z.literal("service_invoke_cancel"), requestId: id }),
  z.strictObject({
    type: z.literal("service_tunnel_open"),
    channelId: id,
    serviceId: component,
    revision: component,
    policySha256: hash,
    operationIds: z.array(component).min(1).max(64),
  }),
  z.strictObject({
    type: z.literal("service_tunnel_ready"),
    channelId: id,
    endpoint: z
      .strictObject({
        url: z.string().max(256),
        bearer: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
      })
      .nullable(),
  }),
  z.strictObject({ type: z.literal("service_tunnel_frame"), frame: ServiceTunnelFrameSchema }),
]);
export type JobCommand = z.infer<typeof JobCommandSchema>;
export const JobInstallationResourcesSchema = z.strictObject({
  artifactAvailable: z.boolean(),
  tools: z
    .array(
      z.strictObject({
        alias: component,
        managed: z.boolean(),
        available: z.boolean(),
        artifactSha256: hash.optional(),
        entrySha256: hash.optional(),
        reason: id.optional(),
      }),
    )
    .max(520)
    .refine((tools) => new Set(tools.map((tool) => tool.alias)).size === tools.length),
  operations: z
    .array(
      z.strictObject({
        operationId: id,
        available: z.boolean(),
        reason: id.optional(),
      }),
    )
    .max(64)
    .refine(
      (operations) =>
        new Set(operations.map((operation) => operation.operationId)).size === operations.length,
    ),
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
    subject: ServiceAuthoritySubjectSchema,
    authorizationId: id,
    serviceId: component,
    revision: component,
    policySha256: hash,
    operationId: component,
  }),
  z.strictObject({
    type: z.literal("service_read_result"),
    requestId: id,
    reply: ServiceReplySchema,
  }),
  z.strictObject({
    type: z.literal("service_invoke_result"),
    requestId: id,
    reply: ServiceReplySchema,
  }),
  z.strictObject({
    type: z.literal("resources"),
    resources: JobResourceInventorySchema,
  }),
  z.strictObject({
    type: z.literal("input_result"),
    jobId: id,
    requestId: id,
    seq: count,
    accepted: z.boolean(),
    reason: id.nullable(),
    nextInputSeq: count.nullable(),
    stdinClosed: z.boolean(),
  }),
  z.strictObject({
    type: z.literal("input_state"),
    jobId: id,
    requestDigest: hash,
    ownerId: id,
    ownerGeneration: count,
    nextInputSeq: count,
    stdinClosed: z.boolean(),
  }),
  z.strictObject({
    type: z.literal("input_authorize"),
    jobId: id,
    requestId: id,
    seq: count,
    parentJobId: id.nullable(),
  }),
  z.strictObject({
    type: z.literal("service_ready"),
    jobId: id,
    service: JobRequestSchema.shape.service.unwrap(),
  }),
  z.strictObject({
    type: z.literal("workload_empty"),
    jobId: id,
    requestDigest: hash,
    ownerId: id,
    ownerGeneration: count,
  }),
  z.strictObject({
    type: z.literal("service_tunnel_open"),
    channelId: id,
    jobId: id,
    serviceId: component,
    revision: component,
    policySha256: hash,
  }),
  z.strictObject({
    type: z.literal("service_tunnel_ready"),
    channelId: id,
    endpoint: z
      .strictObject({
        url: z.string().max(256),
        bearer: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
      })
      .nullable(),
  }),
  z.strictObject({ type: z.literal("service_tunnel_frame"), frame: ServiceTunnelFrameSchema }),
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
/**
 * What a finished job left behind for a reader who was not following it.
 *
 * Follow is live and in memory; the journal is the DURABLE half of the SAME sequence, and it
 * retains LIFECYCLE frames only. Byte-channel frames are deliberately absent: a durable public
 * record carries lifecycle, attribution and digest facts, never a transcript (ADR 0033
 * §Lifecycle and durability). A reader therefore sees holes in `seq` where stdout/stderr frames
 * passed, and those holes are the contract rather than loss — what retention dropped is the
 * prefix below `firstSeq`.
 */
export const JobLifecycleEventSchema = z.union([
  JobEventSchema.options[2],
  JobEventSchema.options[4],
  JobEventSchema.options[5],
]);
export type JobLifecycleEvent = z.infer<typeof JobLifecycleEventSchema>;
export const MAX_JOB_JOURNAL_EVENTS = 128;
export const JobJournalPageSchema = z.strictObject({
  jobId: id,
  events: z
    .array(z.strictObject({ seq: count, at: count, event: JobLifecycleEventSchema }))
    .max(MAX_JOB_JOURNAL_EVENTS),
  /** The oldest sequence still retained for this job, or null once nothing is. */
  firstSeq: count.nullable(),
  /** The `after` that continues this page, or null when the caller reached the end. */
  nextAfter: count.nullable(),
});
export type JobJournalPage = z.infer<typeof JobJournalPageSchema>;
/** One bounded page of one sealed output, addressed by the name its operation declared. */
export const MAX_JOB_OUTPUT_PAGE_BYTES = 65536;
export const JobOutputPageSchema = z.strictObject({
  jobId: id,
  outputId: id,
  name: component,
  sha256: hash,
  files: count,
  /** The sealed length the owner published; `offset + data` never passes it. */
  total: count,
  offset: count,
  data: chunk.data,
  eof: z.boolean(),
});
export type JobOutputPage = z.infer<typeof JobOutputPageSchema>;
/**
 * A settled job, as the plugin that started it is told.
 *
 * It is the ONE wake a server half has for its own finished work: doors answer callers and
 * panels only run while somebody is looking, so without this a background half learns that
 * its job ended by being asked. It names the NODE (machine, operation, job) rather than
 * describing the run, because addressing it again — reading its outputs, its journal, or
 * starting the next one — is the whole point, and every one of those is a governed read the
 * hook's own authority still has to discharge.
 *
 * The terminal states are the job states that are not active, unreduced: `exited` with a
 * code is not success (ADR 0033 §Lifecycle and durability — exit 0 is process success and
 * never a product postcondition), and `reason` carries the owner's own word for a deadline,
 * an output limit or a refusal. Output entries are the sealed descriptors, never bytes.
 */
export const SettledJobSchema = z.strictObject({
  jobId: id,
  machineId: id,
  operationId: id,
  pluginId: id,
  state: JobStateSchema.exclude(["queued", "admitted", "start-committed", "started"]),
  exitCode: z.number().int().nullable(),
  reason: id.nullable(),
  finishedAt: count.nullable(),
  /** Present only for a schedule occurrence, which is how a beat recognizes its own run. */
  scheduleId: id.optional(),
  revision: id.optional(),
  outputs: JobResultSchema.shape.outputs,
});
export type SettledJob = z.infer<typeof SettledJobSchema>;
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
