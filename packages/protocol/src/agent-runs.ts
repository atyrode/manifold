import { z } from "zod";
import { CapSchema } from "./capabilities.ts";
import { AuthorityScopeSchema, GrantNodeSchema, GrantReachSchema } from "./grants.ts";
import { LegacyCapSchema } from "./legacy-authority.ts";
import {
  AgentIdSchema,
  AgentRunCapsSchema,
  AgentRunAuthorityCapsSchema,
  AgentAuthorityScopeSchema,
  AgentCredentialSchema,
  AgentDelegationSchema,
  HarnessTargetSchema,
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
import {
  AGENT_TOOL_MAX_REPLY_BYTES,
  AGENT_TOOL_MAX_REQUEST_BYTES,
  TerminalRuntimeSchema,
} from "./jobs.ts";
import {
  ActionDenialSchema,
  ActionProjectedResultSchema,
  ActionResultApprovalSchema,
  ActionResultProjectionDigestSchema,
} from "./plugin.ts";
import { PrincipalSchema } from "./principal.ts";
import { SessionRefSchema } from "./session-ref.ts";

const AgentRunIdSchema = z.string().min(1).max(128);
const PolicyDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const ToolSelectionSchema = z
  .array(z.string().min(1).max(256))
  .max(32)
  .refine(
    (doors) => new Set(doors).size === doors.length && doors.every((door) => !door.includes("*")),
  );

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
  caps: z.array(LegacyCapSchema).max(128),
  containerScope: z.string().min(1).max(128).nullable(),
  expiresAt: z.number().int().nonnegative().optional(),
});
export type AgentRunAuthorizationCredential = z.infer<typeof AgentRunAuthorizationCredentialSchema>;
export const AgentRunAuthorizationCredentialAuthoritySchema =
  AgentRunAuthorizationCredentialSchema.extend({
    caps: z.array(CapSchema).max(128),
    authorityScope: AuthorityScopeSchema.optional(),
  });
export type AgentRunAuthorizationCredentialAuthority = z.infer<
  typeof AgentRunAuthorizationCredentialAuthoritySchema
>;

export const AgentRunCleanupSchema = z.strictObject({
  revokedCredentials: z.number().int().nonnegative(),
  revokedGrants: z.number().int().nonnegative(),
  finishedAt: z.number().int().nonnegative().optional(),
  failure: z.string().min(1).max(512).optional(),
});
export type AgentRunCleanup = z.infer<typeof AgentRunCleanupSchema>;

function validateRun(
  run: { principal: { kind: string }; parentRunId: string | null; depth: number },
  ctx: z.RefinementCtx,
): void {
  if (run.principal.kind !== "agent")
    ctx.addIssue({
      code: "custom",
      message: "an agent run principal must have kind agent",
      path: ["principal", "kind"],
    });
  if (run.parentRunId === null && run.depth !== 0)
    ctx.addIssue({ code: "custom", message: "a root run has depth zero", path: ["depth"] });
  if (run.parentRunId !== null && run.depth === 0)
    ctx.addIssue({ code: "custom", message: "a child run has positive depth", path: ["depth"] });
}

const AgentRunFieldsSchema = z.strictObject({
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
  tools: z.array(ActionResultApprovalSchema).max(32).optional(),
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
});
export const AgentRunSchema = AgentRunFieldsSchema.superRefine(validateRun);
export type AgentRun = z.infer<typeof AgentRunSchema>;
export const AgentRunAuthoritySchema = AgentRunFieldsSchema.extend({
  caps: AgentRunAuthorityCapsSchema,
  authorityScope: AgentAuthorityScopeSchema.optional(),
  authorizationCredential: AgentRunAuthorizationCredentialAuthoritySchema,
})
  .superRefine(validateRun)
  .refine((run) => run.authorityScope !== undefined || run.caps.length > 0, {
    message: "legacy run authority requires at least one capability",
    path: ["caps"],
  });
export type AgentRunAuthority = z.infer<typeof AgentRunAuthoritySchema>;
export const AgentRunV2Schema = AgentRunFieldsSchema.extend({
  caps: AgentRunAuthorityCapsSchema,
  scope: AgentAuthorityScopeSchema,
  authorizationCredential: AgentRunAuthorizationCredentialAuthoritySchema,
}).superRefine(validateRun);
export type AgentRunV2 = z.infer<typeof AgentRunV2Schema>;

export const CreateRunRequestSchema = z.strictObject({
  agentId: AgentIdSchema,
  session: SessionRefSchema.optional(),
  caps: AgentRunCapsSchema.optional(),
  tools: ToolSelectionSchema.optional(),
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
/** Supplied by a trusted harness server to its native execution context, never by the workload. */
export const NativeAgentRunBindingSchema = z.strictObject({
  runId: AgentRunIdSchema,
  sessionId: SessionRefSchema.shape.sessionId,
  target: HarnessTargetSchema,
});
export type NativeAgentRunBinding = z.infer<typeof NativeAgentRunBindingSchema>;
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

/** Canonical application messages contain no identity or target selector. */
export const AgentToolRequestSchema = z
  .discriminatedUnion("type", [
    z.strictObject({ type: z.literal("describe") }),
    z.strictObject({ type: z.literal("policy") }),
    z.strictObject({ type: z.literal("ack"), policy: AcknowledgeAgentPolicyRequestSchema }),
    z.strictObject({
      type: z.literal("invoke"),
      door: z.string().min(1).max(256),
      args: z.unknown(),
      justification: z.string().max(512).optional(),
    }),
  ])
  .refine((value) => {
    try {
      return (
        new TextEncoder().encode(JSON.stringify(value)).byteLength <= AGENT_TOOL_MAX_REQUEST_BYTES
      );
    } catch {
      return false;
    }
  });
export type AgentToolRequest = z.infer<typeof AgentToolRequestSchema>;

export const AgentToolRefusalCodeSchema = z.enum([
  "binding_unavailable",
  "authority_unavailable",
  "tool_ungranted",
  "tool_unavailable",
  "publication_changed",
  "malformed_request",
  "cancelled",
  "saturated",
  "limit_exceeded",
  "unsupported_feature",
]);
export type AgentToolRefusalCode = z.infer<typeof AgentToolRefusalCodeSchema>;
const ToolProjectionSchema = z.discriminatedUnion("ok", [
  ActionProjectedResultSchema.options[0].extend({ trust: z.literal("untrusted") }),
  ActionProjectedResultSchema.options[1].extend({ trust: z.literal("untrusted") }),
]);
export const AgentToolReplySchema = z
  .discriminatedUnion("type", [
    z.strictObject({
      type: z.literal("description"),
      runId: AgentRunIdSchema,
      agentId: AgentIdSchema,
      target: GrantNodeSchema,
      tools: z
        .array(
          z.strictObject({
            door: z.string().min(1).max(256),
            name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
            title: z.string().max(1024),
            parameters: z
              .record(z.string(), z.unknown())
              .refine(
                (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 16_384,
              ),
            contractDigest: ActionResultProjectionDigestSchema,
          }),
        )
        .max(32),
      unavailable: z
        .array(
          z.strictObject({
            door: z.string().min(1).max(256),
            reason: AgentToolRefusalCodeSchema,
          }),
        )
        .max(32),
    }),
    z.strictObject({ type: z.literal("policy"), policy: AgentPolicyChallengeSchema }),
    z
      .strictObject({
        type: z.literal("result"),
        door: z.string().min(1).max(256),
        traceId: z.number().int().positive(),
        outcome: z.union([
          z.strictObject({ ok: z.literal(true) }),
          z.strictObject({ ok: z.literal(false), denial: ActionDenialSchema.pick({ rule: true }) }),
        ]),
        projection: ToolProjectionSchema.optional(),
      })
      .refine((value) => value.projection === undefined || value.outcome.ok),
    z.strictObject({
      type: z.literal("refused"),
      code: AgentToolRefusalCodeSchema,
      traceId: z.number().int().positive().nullable(),
    }),
    z.strictObject({
      type: z.literal("unknown"),
      reason: z.enum([
        "cancelled",
        "disconnected",
        "interrupted",
        "protocol_error",
        "missing_trace",
      ]),
      traceId: z.number().int().positive().nullable(),
    }),
  ])
  .refine((value) => {
    try {
      return (
        new TextEncoder().encode(JSON.stringify(value)).byteLength <= AGENT_TOOL_MAX_REPLY_BYTES
      );
    } catch {
      return false;
    }
  });
export type AgentToolReply = z.infer<typeof AgentToolReplySchema>;

/** V2 narrowing names correlated scope; omission inherits the immutable baseline. */
export const CreateRunV2RequestSchema = CreateRunRequestSchema.omit({ caps: true }).extend({
  scope: AgentAuthorityScopeSchema.optional(),
});
export type CreateRunV2Request = z.infer<typeof CreateRunV2RequestSchema>;
export const CreateChildRunV2RequestSchema = CreateRunV2RequestSchema.omit({
  agentId: true,
}).extend({
  runId: AgentRunIdSchema,
  agentId: AgentIdSchema.optional(),
});
export type CreateChildRunV2Request = z.infer<typeof CreateChildRunV2RequestSchema>;
export const CreateRunV2ResultSchema = CreateRunResultSchema.extend({ run: AgentRunV2Schema });
export type CreateRunV2Result = z.infer<typeof CreateRunV2ResultSchema>;
export const CreateRunV2CredentialResultSchema = CreateRunV2ResultSchema.required({
  credential: true,
});
export type CreateRunV2CredentialResult = z.infer<typeof CreateRunV2CredentialResultSchema>;
export const CreateChildRunV2ResultSchema = CreateRunV2ResultSchema;
export type CreateChildRunV2Result = z.infer<typeof CreateChildRunV2ResultSchema>;
export const ReportRunActivityV2ResultSchema = ReportRunActivityResultSchema.extend({
  run: AgentRunV2Schema,
});
export type ReportRunActivityV2Result = z.infer<typeof ReportRunActivityV2ResultSchema>;
export const AcknowledgeAgentPolicyV2RequestSchema = AcknowledgeAgentPolicyRequestSchema;
export type AcknowledgeAgentPolicyV2Request = z.infer<typeof AcknowledgeAgentPolicyV2RequestSchema>;
export const AcknowledgeAgentPolicyV2ResultSchema = AcknowledgeAgentPolicyResultSchema.extend({
  run: AgentRunV2Schema,
});
export type AcknowledgeAgentPolicyV2Result = z.infer<typeof AcknowledgeAgentPolicyV2ResultSchema>;
export const RenewAgentRunV2RequestSchema = RenewAgentRunRequestSchema;
export type RenewAgentRunV2Request = z.infer<typeof RenewAgentRunV2RequestSchema>;
export const RenewAgentRunV2ResultSchema = RenewAgentRunResultSchema.extend({
  run: AgentRunV2Schema,
});
export type RenewAgentRunV2Result = z.infer<typeof RenewAgentRunV2ResultSchema>;
export const FinishAgentRunV2RequestSchema = FinishAgentRunRequestSchema;
export type FinishAgentRunV2Request = z.infer<typeof FinishAgentRunV2RequestSchema>;
export const FinishAgentRunV2ResultSchema = FinishAgentRunResultSchema.extend({
  run: AgentRunV2Schema,
});
export type FinishAgentRunV2Result = z.infer<typeof FinishAgentRunV2ResultSchema>;
