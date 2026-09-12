import { z } from "zod";
import { CapSchema } from "./capabilities.ts";
import { JobResourceBindingsSchema } from "./job-resources.ts";
import { JobOwnerSchema, JobRequestSchema, MachineHalfSchema } from "./jobs.ts";

const id = JobRequestSchema.shape.jobId;
const hash = JobRequestSchema.shape.artifactSha256;
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const reason = z.string().min(1).max(2048).nullable();

/** Approval names an explicit destination set; enrolling another machine never widens it. */
export const JobDeploymentRequestSchema = z.strictObject({
  deploymentId: id,
  pluginId: JobRequestSchema.shape.pluginId,
  targets: z
    .array(
      z.strictObject({
        machineId: JobRequestSchema.shape.machineId,
        platform: JobOwnerSchema.shape.platforms.element.optional(),
      }),
    )
    .min(1)
    .max(64)
    .refine(
      (targets) => new Set(targets.map((target) => target.machineId)).size === targets.length,
    ),
  operationIds: z
    .array(JobRequestSchema.shape.operationId)
    .max(128)
    .refine((operations) => new Set(operations).size === operations.length),
});
export type JobDeploymentRequest = z.infer<typeof JobDeploymentRequestSchema>;

export const JobDeploymentConsentSchema = z.strictObject({
  node: z.string().min(1).max(2048),
  cap: CapSchema,
  approved: z.boolean(),
  revision: id.nullable(),
});
export type JobDeploymentConsent = z.infer<typeof JobDeploymentConsentSchema>;

export const JobDeploymentTargetReviewSchema = z.strictObject({
  machineId: JobRequestSchema.shape.machineId,
  machineName: z.string().max(512),
  connected: z.boolean(),
  platform: JobOwnerSchema.shape.platforms.element.nullable(),
  artifactSha256: hash.nullable(),
  expectedInstallationRevision: JobRequestSchema.shape.installationRevision.nullable(),
  installationRevision: JobRequestSchema.shape.installationRevision.nullable(),
  resourceBindings: JobResourceBindingsSchema.nullable(),
  resources: z.array(
    z.strictObject({
      group: z.enum(["tools", "services", "anchors"]),
      name: id,
      sha256: hash.nullable(),
    }),
  ),
  consents: z.array(JobDeploymentConsentSchema),
  approvable: z.boolean(),
  reason,
});
export type JobDeploymentTargetReview = z.infer<typeof JobDeploymentTargetReviewSchema>;

/** The digest binds the current declaration, destination evidence and exact consent changes. */
export const JobDeploymentReviewSchema = z.strictObject({
  request: JobDeploymentRequestSchema,
  machine: MachineHalfSchema,
  declarationSha256: hash,
  reviewDigest: hash,
  targets: z.array(JobDeploymentTargetReviewSchema).min(1).max(64),
  approvable: z.boolean(),
});
export type JobDeploymentReview = z.infer<typeof JobDeploymentReviewSchema>;

export const JobDeploymentApplyArgsSchema = z.strictObject({
  request: JobDeploymentRequestSchema,
  reviewDigest: hash,
});
export type JobDeploymentApplyArgs = z.infer<typeof JobDeploymentApplyArgsSchema>;

export const JobDeploymentStateSchema = z.enum([
  "pending",
  "installing",
  "ready",
  "needs_review",
  "refused",
  "cancelled",
  "superseded",
]);
export type JobDeploymentState = z.infer<typeof JobDeploymentStateSchema>;

export const JobDeploymentTargetStatusSchema = z.strictObject({
  machineId: JobRequestSchema.shape.machineId,
  connected: z.boolean(),
  state: JobDeploymentStateSchema,
  reason,
});
export type JobDeploymentTargetStatus = z.infer<typeof JobDeploymentTargetStatusSchema>;

/** Progress projects native installation and consent evidence, rather than owning another runtime registry. */
export const JobDeploymentSchema = z.strictObject({
  deploymentId: id,
  pluginId: JobRequestSchema.shape.pluginId,
  revision,
  approvedBy: id,
  approvedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  cancelled: z.boolean(),
  review: JobDeploymentReviewSchema,
  targets: z.array(JobDeploymentTargetStatusSchema).min(1).max(64),
});
export type JobDeployment = z.infer<typeof JobDeploymentSchema>;

export const JobDeploymentReadArgsSchema = z.strictObject({ deploymentId: id });
export const JobDeploymentListArgsSchema = z.strictObject({
  pluginId: JobRequestSchema.shape.pluginId,
  limit: z.number().int().min(1).max(100).default(20),
});
export const JobDeploymentListResultSchema = z.strictObject({
  deployments: z.array(JobDeploymentSchema).max(100),
});
export const JobDeploymentCancelArgsSchema = z.strictObject({
  deploymentId: id,
  expectedRevision: revision,
});

/** Product readers see only their authorized destination's progress, not the operator's review. */
export const JobDeploymentDescribeArgsSchema = z.strictObject({
  machineId: JobRequestSchema.shape.machineId,
  pluginId: JobRequestSchema.shape.pluginId,
});
export const JobDeploymentDescriptionSchema = z.strictObject({
  installation: z
    .strictObject({
      revision: JobRequestSchema.shape.installationRevision,
      artifactSha256: JobRequestSchema.shape.artifactSha256,
      machine: MachineHalfSchema,
    })
    .nullable(),
  deployment: z
    .strictObject({
      deploymentId: id,
      machineId: JobRequestSchema.shape.machineId,
      pluginId: JobRequestSchema.shape.pluginId,
      revision,
      state: JobDeploymentStateSchema,
      reason,
    })
    .nullable(),
});
export type JobDeploymentDescription = z.infer<typeof JobDeploymentDescriptionSchema>;
