import { z } from "zod";
import { CapSchema } from "./capabilities.ts";
import { GrantNodeSchema, GrantReachSchema } from "./grants.ts";
import {
  AgentIdSchema,
  AgentRunCapsSchema,
  AgentCredentialSchema,
  AgentDelegationSchema,
  HarnessTargetSchema,
  SessionRefSchema,
  RunModelSchema,
  RunActivitySchema,
  AGENT_RUN_MAX_DEPTH,
  AGENT_RUN_MAX_DESCENDANTS,
  AGENT_RUN_MAX_RENEWALS,
  AGENT_RUN_MAX_LIFETIME_MS,
  AGENT_RUN_MAX_PURPOSE_LENGTH,
  AGENT_RUN_MAX_TASK_REFERENCE_LENGTH,
  AGENT_RUN_MAX_POLICY_BUNDLES,
  AGENT_RUN_MAX_POLICY_BODY_BYTES,
} from "./agents.ts";
import { TerminalRuntimeSchema } from "./jobs.ts";
import { PrincipalSchema } from "./principal.ts";

const AgentRunIdSchema = z.string().min(1).max(128);
const PolicyDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const AGENT_RUN_STATES = [
  "pending_policy",
  "active",
  "policy_stale",
  "completed",
  "failed",
  "cancelled",
  "abandoned",
  "expired",
  "revoked",
  "cleanup_failed",
] as const;
export const AgentRunStateSchema = z.enum(AGENT_RUN_STATES);
export type AgentRunState = z.infer<typeof AgentRunStateSchema>;

export const AGENT_RUN_TERMINAL_OUTCOMES = [
  "completed",
  "failed",
  "cancelled",
  "abandoned",
] as const;
export const AgentRunTerminalOutcomeSchema = z.enum(AGENT_RUN_TERMINAL_OUTCOMES);
export type AgentRunTerminalOutcome = z.infer<typeof AgentRunTerminalOutcomeSchema>;

export const AgentRunAuthorizationPathSchema = z.enum(["owner_key", "principal"]);
export type AgentRunAuthorizationPath = z.infer<typeof AgentRunAuthorizationPathSchema>;
export const AgentRunAuthorizationCredentialSchema = z.strictObject({
  tokenId: z.string().min(1).max(128).nullable(),
  grantId: z.string().min(1).max(128).nullable(),
  caps: z.array(CapSchema).max(128),
  containerScope: z.string().min(1).max(128).nullable(),
  expiresAt: z.number().int().nonnegative().optional(),
});
export type AgentRunAuthorizationCredential = z.infer<typeof AgentRunAuthorizationCredentialSchema>;

export const AgentRunCleanupSchema = z.strictObject({
  revokedCredentials: z.number().int().nonnegative(),
  revokedGrants: z.number().int().nonnegative(),
  finishedAt: z.number().int().nonnegative().optional(),
  failure: z.string().min(1).max(512).optional(),
});
export type AgentRunCleanup = z.infer<typeof AgentRunCleanupSchema>;

export const AgentRunSchema = z
  .strictObject({
    id: AgentRunIdSchema,
    agentId: AgentIdSchema,
    session: SessionRefSchema.nullable(),
    model: RunModelSchema.optional(),
    activity: RunActivitySchema,
    principal: PrincipalSchema,
    rootRunId: AgentRunIdSchema,
    parentRunId: AgentRunIdSchema.nullable(),
    authorizedByPrincipalId: z.string().min(1).max(128),
    authorizationPath: AgentRunAuthorizationPathSchema,
    authorizationCredential: AgentRunAuthorizationCredentialSchema,
    purpose: z.string().min(1).max(AGENT_RUN_MAX_PURPOSE_LENGTH),
    taskRef: z.string().min(1).max(AGENT_RUN_MAX_TASK_REFERENCE_LENGTH).optional(),
    target: GrantNodeSchema,
    reach: GrantReachSchema,
    caps: AgentRunCapsSchema,
    createdAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
    renewals: z.number().int().min(0).max(AGENT_RUN_MAX_RENEWALS),
    maxDepth: z.number().int().min(0).max(AGENT_RUN_MAX_DEPTH),
    maxDescendants: z.number().int().min(0).max(AGENT_RUN_MAX_DESCENDANTS),
    depth: z.number().int().min(0).max(AGENT_RUN_MAX_DEPTH),
    cleanupOwnerPrincipalId: z.string().min(1).max(128),
    state: AgentRunStateSchema,
    policyRevision: PolicyDigestSchema,
    acknowledgedPolicyRevision: PolicyDigestSchema.optional(),
    cleanup: AgentRunCleanupSchema,
  })
  .refine((run) => run.principal.kind === "agent", {
    message: "an agent run principal must have kind agent",
    path: ["principal", "kind"],
  })
  .refine((run) => run.parentRunId !== null || run.depth === 0, {
    message: "a root run has depth zero",
    path: ["depth"],
  })
  .refine((run) => run.parentRunId === null || run.depth > 0, {
    message: "a child run has positive depth",
    path: ["depth"],
  });
export type AgentRun = z.infer<typeof AgentRunSchema>;

export const CreateRunRequestSchema = z.strictObject({
  agentId: AgentIdSchema,
  session: SessionRefSchema.optional(),
  caps: AgentRunCapsSchema.optional(),
  target: z.union([GrantNodeSchema, HarnessTargetSchema]).optional(),
  reach: GrantReachSchema.optional(),
  lifetimeMs: z.number().int().min(60_000).max(AGENT_RUN_MAX_LIFETIME_MS).optional(),
  delegation: AgentDelegationSchema.optional(),
  model: RunModelSchema.optional(),
  /** Free-form references belong only to the explicit bring-your-own external harness. */
  taskRef: z.string().min(1).max(AGENT_RUN_MAX_TASK_REFERENCE_LENGTH).optional(),
});
export type CreateRunRequest = z.infer<typeof CreateRunRequestSchema>;
export const CreateChildRunRequestSchema = CreateRunRequestSchema.omit({ agentId: true }).extend({
  runId: AgentRunIdSchema,
  agentId: AgentIdSchema.optional(),
});
export type CreateChildRunRequest = z.infer<typeof CreateChildRunRequestSchema>;
export const CreateRunResultSchema = z.strictObject({
  run: AgentRunSchema,
  credential: AgentCredentialSchema.optional(),
});
export type CreateRunResult = z.infer<typeof CreateRunResultSchema>;
export const CreateRunCredentialResultSchema = CreateRunResultSchema.required({ credential: true });
export type CreateRunCredentialResult = z.infer<typeof CreateRunCredentialResultSchema>;
export const LaunchRunRequestSchema = z.strictObject({
  runId: AgentRunIdSchema,
  target: HarnessTargetSchema.optional(),
});
export type LaunchRunRequest = z.infer<typeof LaunchRunRequestSchema>;
export const LaunchRunResultSchema = z.strictObject({
  runtime: TerminalRuntimeSchema,
  destination: z.strictObject({ machineId: z.string().min(1).max(128) }),
  session: SessionRefSchema,
  reviewDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export type LaunchRunResult = z.infer<typeof LaunchRunResultSchema>;
export const SendRunInputRequestSchema = z.strictObject({
  runId: AgentRunIdSchema,
  input: z.string().min(1).max(65_536),
});
export type SendRunInputRequest = z.infer<typeof SendRunInputRequestSchema>;
export const SendRunInputResultSchema = z.strictObject({});
export type SendRunInputResult = z.infer<typeof SendRunInputResultSchema>;
export const ReportRunActivityResultSchema = z.strictObject({ run: AgentRunSchema });
export type ReportRunActivityResult = z.infer<typeof ReportRunActivityResultSchema>;

export const AgentRunCredentialSchema = z.strictObject({
  token: z.string().min(1),
  expiresAt: z.number().int().positive(),
});
export type AgentRunCredential = z.infer<typeof AgentRunCredentialSchema>;

export const AGENT_POLICY_SOURCES = ["builtin", "operator"] as const;
export const AgentPolicySourceSchema = z.enum(AGENT_POLICY_SOURCES);
export type AgentPolicySource = z.infer<typeof AgentPolicySourceSchema>;

export const AgentPolicyBundleSchema = z.strictObject({
  id: z.string().min(1).max(64),
  source: AgentPolicySourceSchema,
  digest: PolicyDigestSchema,
  body: z
    .string()
    .min(1)
    .refine(
      (body) => new TextEncoder().encode(body).byteLength <= AGENT_RUN_MAX_POLICY_BODY_BYTES,
      `policy body exceeds ${AGENT_RUN_MAX_POLICY_BODY_BYTES} bytes`,
    ),
});
export type AgentPolicyBundle = z.infer<typeof AgentPolicyBundleSchema>;

export const AgentPolicyChallengeSchema = z.strictObject({
  runId: AgentRunIdSchema,
  revision: PolicyDigestSchema,
  required: z.array(AgentPolicyBundleSchema).min(1).max(AGENT_RUN_MAX_POLICY_BUNDLES),
  issuedAt: z.number().int().nonnegative(),
  acknowledgedAt: z.number().int().nonnegative().optional(),
});
export type AgentPolicyChallenge = z.infer<typeof AgentPolicyChallengeSchema>;

export const AgentPolicyAcknowledgementSchema = z.strictObject({
  id: z.string().min(1).max(64),
  digest: PolicyDigestSchema,
});
export type AgentPolicyAcknowledgement = z.infer<typeof AgentPolicyAcknowledgementSchema>;

export const AcknowledgeAgentPolicyRequestSchema = z.strictObject({
  revision: PolicyDigestSchema,
  acknowledgements: z
    .array(AgentPolicyAcknowledgementSchema)
    .min(1)
    .max(AGENT_RUN_MAX_POLICY_BUNDLES)
    .refine(
      (entries) => new Set(entries.map((entry) => entry.id)).size === entries.length,
      "duplicate policy acknowledgement",
    ),
});
export type AcknowledgeAgentPolicyRequest = z.infer<typeof AcknowledgeAgentPolicyRequestSchema>;

export const AcknowledgeAgentPolicyResultSchema = z.strictObject({ run: AgentRunSchema });
export type AcknowledgeAgentPolicyResult = z.infer<typeof AcknowledgeAgentPolicyResultSchema>;

export const RenewAgentRunRequestSchema = z.strictObject({
  runId: AgentRunIdSchema,
  lifetimeMs: z
    .number()
    .int()
    .min(60_000)
    .max(AGENT_RUN_MAX_LIFETIME_MS)
    .default(AGENT_RUN_MAX_LIFETIME_MS),
});
export type RenewAgentRunRequest = z.infer<typeof RenewAgentRunRequestSchema>;

export const RenewAgentRunResultSchema = z.strictObject({
  run: AgentRunSchema,
  credential: AgentRunCredentialSchema,
  revokedCredentials: z.number().int().nonnegative(),
});
export type RenewAgentRunResult = z.infer<typeof RenewAgentRunResultSchema>;

export const FinishAgentRunRequestSchema = z.strictObject({
  runId: AgentRunIdSchema,
  outcome: AgentRunTerminalOutcomeSchema,
});
export type FinishAgentRunRequest = z.infer<typeof FinishAgentRunRequestSchema>;

export const FinishAgentRunResultSchema = z.strictObject({
  run: AgentRunSchema,
  finishedRuns: z.number().int().positive(),
  revokedCredentials: z.number().int().nonnegative(),
  revokedGrants: z.number().int().nonnegative(),
});
export type FinishAgentRunResult = z.infer<typeof FinishAgentRunResultSchema>;

export const ReloadAgentPolicyResultSchema = z.strictObject({
  revision: PolicyDigestSchema,
  suspendedRuns: z.number().int().nonnegative(),
});
export type ReloadAgentPolicyResult = z.infer<typeof ReloadAgentPolicyResultSchema>;
