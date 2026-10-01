import { z } from "zod";
import { ActionResultApprovalsSchema, PluginCapSchema } from "./plugin.ts";
import { CapSchema } from "./capabilities.ts";
import { AuthorityScopeSchema, GrantNodeSchema, GrantReachSchema } from "./grants.ts";
import { LegacyAuthoredCapSchema } from "./legacy-authority.ts";
import { HarnessIdSchema, SessionRefSchema } from "./session-ref.ts";

export const AgentIdSchema = z.string().min(1).max(128);
export type AgentId = z.infer<typeof AgentIdSchema>;
export const RunModelSchema = z.strictObject({
  provider: z.string().min(1).max(128),
  model: z.string().min(1).max(256),
});
export type RunModel = z.infer<typeof RunModelSchema>;
export const RunActivitySchema = z.enum(["working", "blocked", "done", "idle", "unknown"]);
export type RunActivity = z.infer<typeof RunActivitySchema>;

export const AGENT_RUN_MAX_DEPTH = 4;
export const AGENT_RUN_MAX_DESCENDANTS = 32;
export const AGENT_RUN_MAX_RENEWALS = 24;
export const AGENT_RUN_MAX_LIFETIME_MS = 60 * 60 * 1_000;
export const AGENT_RUN_MAX_PURPOSE_LENGTH = 512;
export const AGENT_RUN_MAX_TASK_REFERENCE_LENGTH = 256;
export const AGENT_RUN_MAX_POLICY_BUNDLES = 8;
export const AGENT_RUN_MAX_POLICY_BODY_BYTES = 65_536;

/** Runner admission is not ordinary run authority and cannot reproduce a standing grant. */
export const AgentRunCapSchema = z
  .lazy(() => LegacyAuthoredCapSchema)
  .refine(
    (cap) =>
      cap !== "*" &&
      cap !== "tokens:mint" &&
      cap !== "machines:mint" &&
      cap !== "plugins:manage" &&
      cap !== "agents:run",
    "agent run capability cannot grant runner, wildcard, legacy token, fleet, or plugin administration",
  );
export type AgentRunCap = z.infer<typeof AgentRunCapSchema>;
export const AgentRunCapsSchema = z
  .array(AgentRunCapSchema)
  .min(1)
  .max(64)
  .refine((caps) => new Set(caps).size === caps.length, "duplicate agent run capability");

/** Internal and V2 authority includes ordinary account shells, but never Agent administration. */
export const AgentRunAuthorityCapSchema = z.union([
  CapSchema.exclude(["*", "tokens:mint", "machines:mint", "plugins:manage", "agents:run"]),
  z.lazy(() => PluginCapSchema),
]);
export type AgentRunAuthorityCap = z.infer<typeof AgentRunAuthorityCapSchema>;
export const AgentRunAuthorityCapsSchema = z
  .array(AgentRunAuthorityCapSchema)
  .max(128)
  .refine((caps) => new Set(caps).size === caps.length, "duplicate agent run capability");
export const AgentAuthorityScopeSchema = z
  .lazy(() => AuthorityScopeSchema)
  .refine(
    (scope) =>
      scope.every((entry) =>
        entry.caps.every((cap) => AgentRunAuthorityCapSchema.safeParse(cap).success),
      ),
    "agent scope cannot grant runner, wildcard, legacy token, fleet, or plugin administration",
  );
export const AgentDelegationSchema = z.strictObject({
  maxDepth: z.number().int().min(0).max(AGENT_RUN_MAX_DEPTH),
  maxDescendants: z.number().int().min(0).max(AGENT_RUN_MAX_DESCENDANTS),
});
export type AgentDelegation = z.infer<typeof AgentDelegationSchema>;
export const AgentGrantSchema = z.strictObject({
  caps: AgentRunCapsSchema,
  tools: z.lazy(() => ActionResultApprovalsSchema).optional(),
  targets: z
    .array(z.lazy(() => GrantNodeSchema))
    .min(1)
    .max(64),
  reach: z.lazy(() => GrantReachSchema),
  maxRunLifetimeMs: z.number().int().min(60_000).max(AGENT_RUN_MAX_LIFETIME_MS),
  delegation: AgentDelegationSchema,
  expiresAt: z.number().int().positive(),
});
export type AgentGrant = z.infer<typeof AgentGrantSchema>;

export const AgentGrantAuthoritySchema = AgentGrantSchema.extend({
  caps: AgentRunAuthorityCapsSchema,
  targets: z.array(z.lazy(() => GrantNodeSchema)).max(64),
  authorityScope: AgentAuthorityScopeSchema.optional(),
}).refine(
  (grant) =>
    grant.authorityScope !== undefined || (grant.caps.length > 0 && grant.targets.length > 0),
  {
    message: "legacy agent authority requires capabilities and targets",
  },
);
export type AgentGrantAuthority = z.infer<typeof AgentGrantAuthoritySchema>;
export const AgentGrantV2Schema = AgentGrantSchema.omit({
  caps: true,
  targets: true,
  reach: true,
}).extend({ scope: AgentAuthorityScopeSchema });
export type AgentGrantV2 = z.infer<typeof AgentGrantV2Schema>;
export const AgentContextSchema = z.strictObject({
  instructions: z.string().max(65_536).optional(),
  profile: z.unknown(),
});
export type AgentContext = z.infer<typeof AgentContextSchema>;
export const AgentStateSchema = z.enum(["idle", "running", "disabled", "retired"]);
export const AgentSchema = z.strictObject({
  agentId: AgentIdSchema,
  principalId: z.string().min(1).max(128),
  sponsorPrincipalId: z.string().min(1).max(128),
  name: z.string().min(1).max(64),
  purpose: z.string().min(1).max(AGENT_RUN_MAX_PURPOSE_LENGTH),
  harness: HarnessIdSchema,
  grant: AgentGrantSchema,
  context: AgentContextSchema,
  policyRevisionAcknowledged: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  state: AgentStateSchema,
  activeRuns: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export type Agent = z.infer<typeof AgentSchema>;
export const AgentAuthoritySchema = AgentSchema.extend({ grant: AgentGrantAuthoritySchema });
export type AgentAuthority = z.infer<typeof AgentAuthoritySchema>;
export const AgentV2Schema = AgentSchema.extend({ grant: AgentGrantV2Schema });
export type AgentV2 = z.infer<typeof AgentV2Schema>;
export const RegisterAgentRequestSchema = AgentSchema.pick({
  name: true,
  purpose: true,
  harness: true,
  grant: true,
  context: true,
});
export type RegisterAgentRequest = z.infer<typeof RegisterAgentRequestSchema>;
export const AgentCredentialSchema = z.strictObject({
  token: z.string().min(1),
  expiresAt: z.number().int().positive(),
});
export const RegisterAgentResultSchema = z.strictObject({
  agent: AgentSchema,
  credential: AgentCredentialSchema.optional(),
  created: z.boolean(),
});
export type RegisterAgentResult = z.infer<typeof RegisterAgentResultSchema>;
export const AgentRequestSchema = z.strictObject({ agentId: AgentIdSchema });
export type AgentRequest = z.infer<typeof AgentRequestSchema>;
export const GetAgentResultSchema = z.strictObject({ agent: AgentSchema, canManage: z.boolean() });
export type GetAgentResult = z.infer<typeof GetAgentResultSchema>;
export const ListAgentsRequestSchema = z.strictObject({});
export const ListAgentsResultSchema = z.strictObject({
  agents: z.array(AgentSchema).max(100),
  truncated: z.boolean(),
  canRegister: z.boolean(),
});
export type ListAgentsResult = z.infer<typeof ListAgentsResultSchema>;
export const UpdateAgentRequestSchema = AgentRequestSchema.extend({
  purpose: AgentSchema.shape.purpose.optional(),
  grant: AgentGrantSchema.optional(),
  context: AgentContextSchema.optional(),
});
export type UpdateAgentRequest = z.infer<typeof UpdateAgentRequestSchema>;
export const ReportRunActivityRequestSchema = z.strictObject({
  runId: z.string().min(1).max(128),
  activity: RunActivitySchema,
});
export type ReportRunActivityRequest = z.infer<typeof ReportRunActivityRequestSchema>;

export const RegisterAgentV2RequestSchema = AgentV2Schema.pick({
  name: true,
  purpose: true,
  harness: true,
  grant: true,
  context: true,
});
export type RegisterAgentV2Request = z.infer<typeof RegisterAgentV2RequestSchema>;
export const RegisterAgentV2ResultSchema = RegisterAgentResultSchema.extend({
  agent: AgentV2Schema,
});
export type RegisterAgentV2Result = z.infer<typeof RegisterAgentV2ResultSchema>;
export const GetAgentV2RequestSchema = AgentRequestSchema;
export type GetAgentV2Request = z.infer<typeof GetAgentV2RequestSchema>;
export const GetAgentV2ResultSchema = GetAgentResultSchema.extend({ agent: AgentV2Schema });
export type GetAgentV2Result = z.infer<typeof GetAgentV2ResultSchema>;
export const ListAgentsV2RequestSchema = ListAgentsRequestSchema;
export type ListAgentsV2Request = z.infer<typeof ListAgentsV2RequestSchema>;
export const ListAgentsV2ResultSchema = ListAgentsResultSchema.extend({
  agents: z.array(AgentV2Schema).max(100),
});
export type ListAgentsV2Result = z.infer<typeof ListAgentsV2ResultSchema>;
export const UpdateAgentV2RequestSchema = UpdateAgentRequestSchema.extend({
  grant: AgentGrantV2Schema.optional(),
});
export type UpdateAgentV2Request = z.infer<typeof UpdateAgentV2RequestSchema>;
export const UpdateAgentV2ResultSchema = GetAgentV2ResultSchema;
export type UpdateAgentV2Result = z.infer<typeof UpdateAgentV2ResultSchema>;
export const ReportRunActivityV2RequestSchema = ReportRunActivityRequestSchema;
export type ReportRunActivityV2Request = z.infer<typeof ReportRunActivityV2RequestSchema>;
export const DisableAgentV2RequestSchema = AgentRequestSchema;
export type DisableAgentV2Request = z.infer<typeof DisableAgentV2RequestSchema>;
export const DisableAgentV2ResultSchema = GetAgentV2ResultSchema;
export type DisableAgentV2Result = z.infer<typeof DisableAgentV2ResultSchema>;
export const EnableAgentV2RequestSchema = AgentRequestSchema;
export type EnableAgentV2Request = z.infer<typeof EnableAgentV2RequestSchema>;
export const EnableAgentV2ResultSchema = GetAgentV2ResultSchema;
export type EnableAgentV2Result = z.infer<typeof EnableAgentV2ResultSchema>;
export const RetireAgentV2RequestSchema = AgentRequestSchema;
export type RetireAgentV2Request = z.infer<typeof RetireAgentV2RequestSchema>;
export const RetireAgentV2ResultSchema = GetAgentV2ResultSchema;
export type RetireAgentV2Result = z.infer<typeof RetireAgentV2ResultSchema>;

/** JSON Schema is published as data; the harness supplies the matching runtime validator. */
export const HarnessDefinitionSchema = z.strictObject({
  id: HarnessIdSchema,
  title: z.string().min(1).max(64),
  profileSchema: z.record(z.string(), z.unknown()),
  sessionRef: z.literal("typed"),
});
export type HarnessDefinition = z.infer<typeof HarnessDefinitionSchema>;
export const ListHarnessesResultSchema = z.strictObject({
  harnesses: z.array(HarnessDefinitionSchema).max(100),
});
export type ListHarnessesResult = z.infer<typeof ListHarnessesResultSchema>;
export const HarnessTargetSchema = z.strictObject({
  machineId: z.string().min(1).max(128),
  containerId: z.string().min(1).max(128).optional(),
});
export type HarnessTarget = z.infer<typeof HarnessTargetSchema>;
export const ListHarnessSessionsRequestSchema = z.strictObject({
  harness: HarnessIdSchema,
  target: HarnessTargetSchema,
});
export type ListHarnessSessionsRequest = z.infer<typeof ListHarnessSessionsRequestSchema>;
export const ListHarnessSessionsResultSchema = z.strictObject({
  sessions: z.array(SessionRefSchema).max(100),
  truncated: z.boolean(),
});
export type ListHarnessSessionsResult = z.infer<typeof ListHarnessSessionsResultSchema>;
export const ResolveHarnessSessionRequestSchema = z.strictObject({ session: SessionRefSchema });
export type ResolveHarnessSessionRequest = z.infer<typeof ResolveHarnessSessionRequestSchema>;
export const ResolveHarnessSessionResultSchema = z.strictObject({
  session: SessionRefSchema.nullable(),
});
export type ResolveHarnessSessionResult = z.infer<typeof ResolveHarnessSessionResultSchema>;
export const AgentAdmissionRefusalSchema = z.enum([
  "agent_unavailable",
  "agent_disabled",
  "agent_retired",
  "grant_expired",
  "cap_exceeds_grant",
  "target_exceeds_grant",
  "reach_exceeds_grant",
  "lifetime_exceeds_grant",
  "delegation_exceeds_grant",
  "sponsor_authority_unavailable",
  "session_harness_mismatch",
  "session_binding_untrusted",
]);
export type AgentAdmissionRefusal = z.infer<typeof AgentAdmissionRefusalSchema>;
