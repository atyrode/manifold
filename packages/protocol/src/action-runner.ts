import { z } from "zod";
import {
  AcknowledgeAgentPolicyRequestSchema,
  AgentPolicyChallengeSchema,
  AgentRunTerminalOutcomeSchema,
  CreateChildRunRequestSchema,
  CreateRunRequestSchema,
  RenewAgentRunRequestSchema,
} from "./agent-runs.ts";
import { ReportRunActivityRequestSchema } from "./agents.ts";
import { GrantNodeSchema } from "./grants.ts";
import { ActionDenialSchema, ActionSummarySchema } from "./plugin.ts";

export const ACTION_RUNNER_MAX_FRAME_BYTES = 65_536;
export const ACTION_RUNNER_MAX_FRAMES = 1_024;
export const ACTION_RUNNER_IDLE_TIMEOUT_MS = 5 * 60_000;

/** Only the live, server-authored action vocabulary is needed by an HTTP caller. */
export const ActionProtocolSchema = z.object({
  protocolVersion: z.number().int().positive(),
  actions: z.array(ActionSummarySchema).max(10_000),
});
export type ActionProtocol = z.infer<typeof ActionProtocolSchema>;

const IdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const JustificationSchema = z
  .string()
  .max(512)
  .refine((value) => {
    try {
      encodeURIComponent(value);
      return true;
    } catch {
      return false;
    }
  })
  .optional();
const RunIdSchema = z.string().min(1).max(128);

/** Launcher-only data, never a member of the model-facing request union. */
export const ActionRunnerBindSchema = z.union([
  CreateRunRequestSchema.pick({ agentId: true, session: true, model: true }),
  z.strictObject({ runId: RunIdSchema }),
]);
export type ActionRunnerBind = z.infer<typeof ActionRunnerBindSchema>;

/** Only the trusted inherited activity pipe accepts this frame. */
export const ActionRunnerActivitySchema = ReportRunActivityRequestSchema.extend({
  activity: z.enum(["working", "blocked", "done", "idle"]),
});
export type ActionRunnerActivity = z.infer<typeof ActionRunnerActivitySchema>;

/** Credentials, origins and transport headers are deliberately absent from every frame. */
export const ActionRunnerRequestSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("discover"), id: IdSchema, runId: RunIdSchema }),
  z.strictObject({ type: z.literal("policy"), id: IdSchema, runId: RunIdSchema }),
  z.strictObject({
    type: z.literal("ack"),
    id: IdSchema,
    runId: RunIdSchema,
    policy: AcknowledgeAgentPolicyRequestSchema,
  }),
  z.strictObject({
    type: z.literal("invoke"),
    id: IdSchema,
    runId: RunIdSchema,
    door: z.string().min(1).max(256),
    target: GrantNodeSchema,
    args: z.unknown(),
    justification: JustificationSchema,
  }),
  z.strictObject({
    type: z.literal("child"),
    id: IdSchema,
    runId: RunIdSchema,
    declaration: CreateChildRunRequestSchema.omit({
      runId: true,
      agentId: true,
      session: true,
      model: true,
    }),
    justification: JustificationSchema,
  }),
  z.strictObject({
    type: z.literal("renew"),
    id: IdSchema,
    ...RenewAgentRunRequestSchema.shape,
    justification: JustificationSchema,
  }),
  z.strictObject({
    type: z.literal("finish"),
    id: IdSchema,
    runId: RunIdSchema,
    outcome: AgentRunTerminalOutcomeSchema,
  }),
]);
export type ActionRunnerRequest = z.infer<typeof ActionRunnerRequestSchema>;

const CorrelationSchema = z.object({
  id: IdSchema.nullable(),
  runId: RunIdSchema.nullable(),
  door: z.string().max(256),
  /** Caller-declared target, not an assertion about the ledger's resolved targets. */
  target: GrantNodeSchema,
  traceId: z.number().int().positive().nullable(),
});

export const ActionRunnerResponseSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("discovery"),
    id: IdSchema.nullable(),
    runId: RunIdSchema.nullable(),
    ...ActionProtocolSchema.shape,
  }),
  z.strictObject({
    type: z.literal("policy"),
    ...CorrelationSchema.shape,
    policy: AgentPolicyChallengeSchema,
  }),
  z.strictObject({
    type: z.literal("result"),
    ...CorrelationSchema.shape,
    outcome: z.union([
      z.strictObject({ ok: z.literal(true) }),
      z.strictObject({
        ok: z.literal(false),
        denial: ActionDenialSchema.pick({ rule: true }),
      }),
    ]),
    expiresAt: z.number().int().positive().optional(),
    cleanup: z
      .strictObject({
        finishedRuns: z.number().int().positive(),
        revokedCredentials: z.number().int().nonnegative(),
        revokedGrants: z.number().int().nonnegative(),
      })
      .optional(),
  }),
  z.strictObject({
    type: z.literal("error"),
    id: IdSchema.nullable(),
    door: z.string().max(256).nullable(),
    target: GrantNodeSchema.nullable(),
    runId: RunIdSchema.nullable(),
    code: z.enum([
      "invalid_frame",
      "credential_input",
      "incompatible_protocol",
      "unknown_action",
      "invalid_state",
      "policy_mismatch",
      "transport_failed",
      "missing_trace",
      "invalid_response",
      "limit_exceeded",
      "cleanup_failed",
    ]),
    traceId: z.number().int().positive().nullable(),
  }),
  z.strictObject({
    type: z.literal("closed"),
    outcome: AgentRunTerminalOutcomeSchema,
    cleanup: z.enum(["confirmed", "failed", "not_started"]),
  }),
]);
export type ActionRunnerResponse = z.infer<typeof ActionRunnerResponseSchema>;
