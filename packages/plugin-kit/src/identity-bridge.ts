import { z } from "zod";
import {
  MintTokenV2RequestSchema, TokenGrantV2Schema,
  RegisterAgentV2RequestSchema, RegisterAgentV2ResultSchema,
  GetAgentV2RequestSchema, GetAgentV2ResultSchema,
  ListAgentsV2ResultSchema,
  UpdateAgentV2RequestSchema, UpdateAgentV2ResultSchema,
  DisableAgentV2RequestSchema, DisableAgentV2ResultSchema,
  EnableAgentV2RequestSchema, EnableAgentV2ResultSchema,
  RetireAgentV2RequestSchema, RetireAgentV2ResultSchema,
  CreateRunV2RequestSchema, CreateRunV2ResultSchema,
  CreateChildRunV2RequestSchema, CreateChildRunV2ResultSchema,
  InspectRunV2RequestSchema, InspectRunV2ResultSchema,
  ListRunsV2RequestSchema, ListRunsV2ResultSchema,
  RenewAgentRunV2RequestSchema, RenewAgentRunV2ResultSchema,
  FinishAgentRunV2RequestSchema, FinishAgentRunV2ResultSchema,
  ReportRunActivityV2RequestSchema, ReportRunActivityV2ResultSchema,
  AcknowledgeAgentPolicyV2RequestSchema, AcknowledgeAgentPolicyV2ResultSchema,
  PrincipalCredentialsV2Schema,
} from "@manifold/protocol";

/** Contract 12 identity RPC: schemas are the public action contracts, not a second grant model. */
export const IdentityV2BridgeSchemas = {
  mintTokenV2: { args: z.tuple([MintTokenV2RequestSchema]), result: TokenGrantV2Schema },
  registerAgentV2: { args: z.tuple([RegisterAgentV2RequestSchema]), result: RegisterAgentV2ResultSchema },
  getAgentV2: { args: z.tuple([GetAgentV2RequestSchema]), result: GetAgentV2ResultSchema },
  listAgentsV2: { args: z.tuple([]), result: ListAgentsV2ResultSchema },
  updateAgentV2: { args: z.tuple([UpdateAgentV2RequestSchema]), result: UpdateAgentV2ResultSchema },
  disableAgentV2: { args: z.tuple([DisableAgentV2RequestSchema]), result: DisableAgentV2ResultSchema },
  enableAgentV2: { args: z.tuple([EnableAgentV2RequestSchema]), result: EnableAgentV2ResultSchema },
  retireAgentV2: { args: z.tuple([RetireAgentV2RequestSchema]), result: RetireAgentV2ResultSchema },
  createRunV2: { args: z.tuple([CreateRunV2RequestSchema]), result: CreateRunV2ResultSchema },
  createChildRunV2: { args: z.tuple([CreateChildRunV2RequestSchema]), result: CreateChildRunV2ResultSchema },
  inspectRunV2: { args: z.tuple([InspectRunV2RequestSchema]), result: InspectRunV2ResultSchema },
  listRunsV2: { args: z.tuple([ListRunsV2RequestSchema]), result: ListRunsV2ResultSchema },
  renewAgentRunV2: { args: z.tuple([RenewAgentRunV2RequestSchema]), result: RenewAgentRunV2ResultSchema },
  finishAgentRunV2: { args: z.tuple([FinishAgentRunV2RequestSchema]), result: FinishAgentRunV2ResultSchema },
  reportRunActivityV2: { args: z.tuple([ReportRunActivityV2RequestSchema]), result: ReportRunActivityV2ResultSchema },
  acknowledgeAgentPolicyV2: { args: z.tuple([AcknowledgeAgentPolicyV2RequestSchema]), result: AcknowledgeAgentPolicyV2ResultSchema },
  listCredentialsV2: { args: z.tuple([]), result: PrincipalCredentialsV2Schema.array() },
} as const;
export type IdentityV2Method = keyof typeof IdentityV2BridgeSchemas;
export const IdentityV2MethodSchema = z.enum(Object.keys(IdentityV2BridgeSchemas) as [IdentityV2Method, ...IdentityV2Method[]]);
export function isIdentityV2Method(method: string): method is `identity.${IdentityV2Method}` {
  return method.startsWith("identity.") &&
    Object.hasOwn(IdentityV2BridgeSchemas, method.slice("identity.".length));
}
export type IdentityV2Answer<T> = { readonly ok: true; readonly value: T } |
  { readonly ok: false; readonly code: string; readonly message: string };
export type GuestIdentityV2 = {
  readonly [M in IdentityV2Method]: (...args: z.infer<(typeof IdentityV2BridgeSchemas)[M]["args"]>) =>
    Promise<IdentityV2Answer<z.infer<(typeof IdentityV2BridgeSchemas)[M]["result"]>>>;
};
export const IdentityV2AnswerSchemas = Object.fromEntries(
  Object.entries(IdentityV2BridgeSchemas).map(([name, schema]) => [
    name,
    z.discriminatedUnion("ok", [
      z.strictObject({ ok: z.literal(true), value: schema.result }),
      z.strictObject({ ok: z.literal(false), code: z.string().min(1).max(128), message: z.string().max(2048) }),
    ]),
  ]),
) as Readonly<Record<IdentityV2Method, z.ZodType>>;
