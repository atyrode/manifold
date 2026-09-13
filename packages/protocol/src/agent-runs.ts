import { z } from "zod";
import { CapSchema } from "./capabilities.ts";
import { GrantNodeSchema, GrantReachSchema } from "./grants.ts";
import { AuthoredCapSchema } from "./plugin.ts";
import { PrincipalSchema } from "./principal.ts";

export const AGENT_RUN_MAX_DEPTH = 4;
export const AGENT_RUN_MAX_DESCENDANTS = 32;
export const AGENT_RUN_MAX_RENEWALS = 24;
export const AGENT_RUN_MAX_LIFETIME_MS = 60 * 60 * 1_000;
export const AGENT_RUN_MAX_PURPOSE_LENGTH = 512;
export const AGENT_RUN_MAX_TASK_REFERENCE_LENGTH = 256;
export const AGENT_RUN_MAX_POLICY_BUNDLES = 8;
export const AGENT_RUN_MAX_POLICY_BODY_BYTES = 65_536;

const AgentRunIdSchema = z.string().min(1).max(128);
const PolicyDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);

/** Authority an ordinary autonomous run may hold. Legacy token and fleet administration stay separate. */
export const AgentRunCapSchema = AuthoredCapSchema.refine(
  (cap) =>
    cap !== "*" && cap !== "tokens:mint" && cap !== "machines:mint" && cap !== "plugins:manage",
  "agent run capability cannot grant wildcard, legacy token, fleet, or plugin administration",
);
export type AgentRunCap = z.infer<typeof AgentRunCapSchema>;

const AgentRunCapsSchema = z
  .array(AgentRunCapSchema)
  .min(1)
  .max(64)
  .refine((caps) => new Set(caps).size === caps.length, "duplicate agent run capability");

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
    maxDepth: z.number().int().min(1).max(AGENT_RUN_MAX_DEPTH),
    maxDescendants: z.number().int().min(1).max(AGENT_RUN_MAX_DESCENDANTS),
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

export const CreateAgentRunRequestSchema = z.strictObject({
  name: z.string().min(1).max(64),
  color: z
    .string()
    .regex(/^#[0-9a-f]{6}$/i)
    .optional(),
  purpose: z.string().min(1).max(AGENT_RUN_MAX_PURPOSE_LENGTH),
  taskRef: z.string().min(1).max(AGENT_RUN_MAX_TASK_REFERENCE_LENGTH).optional(),
  target: GrantNodeSchema,
  reach: GrantReachSchema,
  caps: AgentRunCapsSchema,
  lifetimeMs: z
    .number()
    .int()
    .min(60_000)
    .max(AGENT_RUN_MAX_LIFETIME_MS)
    .default(AGENT_RUN_MAX_LIFETIME_MS),
  maxDepth: z.number().int().min(1).max(AGENT_RUN_MAX_DEPTH).default(AGENT_RUN_MAX_DEPTH),
  maxDescendants: z
    .number()
    .int()
    .min(1)
    .max(AGENT_RUN_MAX_DESCENDANTS)
    .default(AGENT_RUN_MAX_DESCENDANTS),
});
export type CreateAgentRunRequest = z.infer<typeof CreateAgentRunRequestSchema>;

export const AgentRunCredentialSchema = z.strictObject({
  token: z.string().min(1),
  expiresAt: z.number().int().positive(),
});
export type AgentRunCredential = z.infer<typeof AgentRunCredentialSchema>;

export const CreateAgentRunResultSchema = z.strictObject({
  run: AgentRunSchema,
  credential: AgentRunCredentialSchema,
});
export type CreateAgentRunResult = z.infer<typeof CreateAgentRunResultSchema>;

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
