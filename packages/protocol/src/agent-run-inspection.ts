import { z } from "zod";
import { AgentRunStateSchema } from "./agent-runs.ts";
import { AuthoredCapSchema } from "./plugin.ts";
import { GrantReachSchema } from "./grants.ts";
import { JobStateSchema } from "./jobs.ts";
import { TraceOutcomeSchema } from "./trace.ts";
import { AgentIdSchema, RunModelSchema, RunActivitySchema } from "./agents.ts";
import { SessionRefSchema } from "./session-ref.ts";

export const AGENT_JUSTIFICATION_MAX_LENGTH = 512;
const id = z.string().min(1).max(256);
const at = z.number().int().nonnegative();
const traceId = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .max(20);
const text = z.string().max(512);

const runSummary = z.strictObject({
  id,
  principalId: id,
  agentId: AgentIdSchema,
  session: SessionRefSchema.nullable(),
  model: RunModelSchema.optional(),
  activity: RunActivitySchema,
  name: text,
  state: AgentRunStateSchema,
});

/** A run discovery surface, never the credential administrator's token inventory. */
export const AgentRunInventorySchema = z.strictObject({
  observedAt: at,
  runs: z
    .array(
      runSummary.extend({
        purpose: text,
        createdAt: at,
        expiresAt: at,
        parentRunId: id.nullable(),
        actionCount: z.number().int().nonnegative(),
        refusalCount: z.number().int().nonnegative(),
      }),
    )
    .max(100),
  truncated: z.boolean(),
});
export type AgentRunInventory = z.infer<typeof AgentRunInventorySchema>;

export const AgentRunTraceSummarySchema = z.strictObject({
  traceId,
  at,
  actor: id,
  action: id,
  authority: text,
  targets: z.array(z.string().max(1024)).max(128),
  outcome: TraceOutcomeSchema.nullable(),
  settlement: z.enum(["settled", "pending_or_crashed"]),
  connectionId: id.nullable(),
  origin: z.enum(["http", "connection"]),
  agentDeclaration: text.optional(),
});
export type AgentRunTraceSummary = z.infer<typeof AgentRunTraceSummarySchema>;

export const AgentRunInspectionSchema = z.strictObject({
  availability: z.literal("available"),
  observedAt: at,
  run: runSummary.extend({
    rootRunId: id,
    parentRunId: id.nullable(),
    sponsorPrincipalId: id,
    authorizationPath: z.enum(["owner_key", "principal"]),
    purpose: text,
    taskRef: text.optional(),
    target: z.string().max(1024),
    reach: GrantReachSchema,
    caps: z.array(AuthoredCapSchema).max(128),
    createdAt: at,
    expiresAt: at,
    renewals: z.number().int().nonnegative(),
    depth: z.number().int().nonnegative(),
    maxDepth: z.number().int().nonnegative(),
    maxDescendants: z.number().int().nonnegative(),
    policyRevision: id,
    acknowledgedPolicyRevision: id.nullable(),
    policyAcknowledgedAt: at.nullable(),
    cleanup: z.strictObject({
      ownerPrincipalId: id,
      revokedCredentials: z.number().int().nonnegative(),
      revokedGrants: z.number().int().nonnegative(),
      finishedAt: at.nullable(),
      status: z.enum(["pending", "finished", "failed"]),
    }),
  }),
  lineage: z.array(runSummary).max(33),
  lineageComplete: z.boolean(),
  credentials: z
    .array(
      z.strictObject({
        createdAt: at,
        expiresAt: at.nullable(),
        revokedAt: at.nullable(),
        state: z.enum(["live", "expired", "revoked"]),
        grant: z
          .strictObject({
            node: z.string().max(1024),
            caps: z.array(AuthoredCapSchema).max(128),
            reach: GrantReachSchema,
            effect: z.enum(["allow", "deny"]),
          })
          .nullable(),
      }),
    )
    .max(100),
  connections: z
    .array(
      z.strictObject({
        connectionId: id,
        state: z.enum(["live", "closed_or_unavailable"]),
        firstObservedAt: at.nullable(),
        lastObservedAt: at.nullable(),
      }),
    )
    .max(100),
  traces: z.array(AgentRunTraceSummarySchema).max(100),
  nextBeforeTraceId: traceId.nullable(),
  requestedTrace: z.enum(["not_requested", "available", "unavailable"]),
  history: z.literal("retained_only"),
  jobs: z
    .array(
      z.strictObject({
        jobId: id,
        machineId: id,
        pluginId: id,
        operationId: id,
        installationRevision: id,
        artifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
        state: z.union([JobStateSchema, z.enum(["pending", "skipped", "enqueued"])]),
        createdAt: at,
        startedAt: at.nullable(),
        finishedAt: at.nullable(),
        exitCode: z.number().int().nullable(),
        traceId: id,
        origin: z.enum(["retained", "unavailable"]),
        parentJobId: id.nullable(),
        terminalId: id.nullable(),
        ownerState: z.enum(["closed", "unconfirmed"]),
      }),
    )
    .max(100),
  terminals: z
    .array(
      z.strictObject({
        terminalId: id,
        machineId: id,
        containerId: id,
        createdAt: at,
        state: z.enum(["running", "exited"]),
        exitCode: z.number().int().nullable(),
        traceId: traceId.nullable(),
        retention: z.literal("retained"),
      }),
    )
    .max(100),
  nativeTruncated: z.boolean(),
});
export type AgentRunInspection = z.infer<typeof AgentRunInspectionSchema>;
export const ListRunsRequestSchema = z.strictObject({ agentId: AgentIdSchema.optional() });
export type ListRunsRequest = z.infer<typeof ListRunsRequestSchema>;
export const ListRunsResultSchema = AgentRunInventorySchema;
export type ListRunsResult = z.infer<typeof ListRunsResultSchema>;
export const InspectRunRequestSchema = z
  .strictObject({
    runId: id,
    beforeTraceId: traceId.optional(),
    traceId: traceId.optional(),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .refine((input) => input.beforeTraceId === undefined || input.traceId === undefined, {
    message: "name a trace or page cursor, not both",
  });
export type InspectRunRequest = z.infer<typeof InspectRunRequestSchema>;
export const InspectRunResultSchema = AgentRunInspectionSchema;
export type InspectRunResult = z.infer<typeof InspectRunResultSchema>;
