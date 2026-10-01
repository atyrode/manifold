import { PluginCapSchema } from "@manifold/protocol";
import { z } from "zod";
import manifestJson from "../manifest.json";

export const PLUGIN_ID = manifestJson.id;
export const CAPS = {
  configure: PluginCapSchema.parse(
    manifestJson.capabilities.find((cap) => cap === `${PLUGIN_ID}:configure`),
  ),
  read: PluginCapSchema.parse(manifestJson.capabilities.find((cap) => cap === `${PLUGIN_ID}:read`)),
  prepare: PluginCapSchema.parse(
    manifestJson.capabilities.find((cap) => cap === `${PLUGIN_ID}:prepare`),
  ),
  publish: PluginCapSchema.parse(
    manifestJson.capabilities.find((cap) => cap === `${PLUGIN_ID}:publish`),
  ),
} as const;
export const DOORS = {
  configureConnection: "configureConnection",
  readConnections: "readConnections",
  prepareIssuePublication: "prepareIssuePublication",
  publishIssue: "publishIssue",
  readPublication: "readPublication",
  reconcilePublication: "reconcilePublication",
} as const;
export const LIMITS = {
  connections: 16,
  operations: 1000,
  retainedBytes: 16 * 1024 * 1024,
  activeCalls: 4,
  titleBytes: 256,
  bodyBytes: 32768,
  pageSize: 2,
  pages: 10,
} as const;
const utf8 = new TextEncoder();
export const bytes = (value: string): number => utf8.encode(value).byteLength;
export const publicText = (maxBytes: number) =>
  z
    .string()
    .max(maxBytes)
    .refine((value) => value.isWellFormed() && bytes(value) <= maxBytes);
export const NameSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
  .refine((value) => !["__proto__", "constructor", "prototype"].includes(value));
export const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const NodeIdSchema = z.string().regex(/^[A-Za-z0-9_+/=-]{1,256}$/);
export const LoginSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/);
export const RepositoryNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9_.-]{1,100}$/)
  .refine((value) => value !== "." && value !== "..");
export const IssueNumberSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const OperationIdSchema = z.string().regex(/^[a-f0-9]{32}$/);
export const ConnectionMetadataSchema = z.strictObject({
  connectionId: NameSchema,
  machineId: NameSchema,
  serviceId: NameSchema,
  serviceRevision: NameSchema,
  policySha256: DigestSchema,
  owner: LoginSchema,
  repository: RepositoryNameSchema,
  ownerNodeId: NodeIdSchema,
  repositoryNodeId: NodeIdSchema,
  accountLogin: LoginSchema,
  accountNodeId: NodeIdSchema,
  credentialMode: z.literal("owner-user-token"),
});
export const ConfigureConnectionInputSchema = ConnectionMetadataSchema.extend({
  expectedRevision: DigestSchema.nullable(),
});
export const ConnectionSchema = ConnectionMetadataSchema.extend({
  connectionRevision: DigestSchema,
});
export const PrepareIssuePublicationInputSchema = z.strictObject({
  consumerRef: NameSchema,
  connectionId: NameSchema,
  publicTitle: publicText(LIMITS.titleBytes).refine((value) => value.trim().length > 0),
  publicBody: publicText(LIMITS.bodyBytes),
});
export const PublishIssueInputSchema = z.strictObject({
  operationId: OperationIdSchema,
  reviewedDigest: DigestSchema,
});
export const ReadPublicationInputSchema = z.strictObject({ operationId: OperationIdSchema });
export const ReconcilePublicationInputSchema = ReadPublicationInputSchema.extend({
  issueNumber: IssueNumberSchema.optional(),
});
export const ReadConnectionsInputSchema = z.strictObject({});
export const ReceiptSchema = z.strictObject({
  operationId: OperationIdSchema,
  reviewedDigest: DigestSchema,
  repositoryNodeId: NodeIdSchema,
  issueNodeId: NodeIdSchema,
  issueId: IssueNumberSchema,
  issueNumber: IssueNumberSchema,
  url: z.url().max(512),
  accountNodeId: NodeIdSchema,
});
export const StateSchema = z.enum(["ready", "dispatching", "published", "outcome_unknown"]);
export const ReconciliationSchema = z.enum([
  "recovery_fence",
  "response_unknown",
  "receipt_uncommitted",
  "no_match",
  "conflict",
  "invalid_evidence",
  "incomplete",
]);
export const PublicationSchema = z.strictObject({
  version: z.literal(1),
  operationId: OperationIdSchema,
  state: StateSchema,
  reviewedDigest: DigestSchema,
  connection: ConnectionSchema,
  publicTitle: publicText(LIMITS.titleBytes),
  publicBody: publicText(LIMITS.bodyBytes),
  marker: z.string().regex(/^<!-- manifold-github:[a-f0-9]{48} -->$/),
  receipt: ReceiptSchema.nullable(),
  candidateIssueNumber: IssueNumberSchema.nullable(),
  reconciliation: ReconciliationSchema.nullable(),
});
export const ConfigureConnectionResultSchema = z.strictObject({
  version: z.literal(1),
  connection: ConnectionSchema,
});
export const ReadConnectionsResultSchema = z.strictObject({
  version: z.literal(1),
  connections: z.array(ConnectionSchema).max(LIMITS.connections),
});
export const contracts = {
  [DOORS.configureConnection]: {
    input: ConfigureConnectionInputSchema,
    result: ConfigureConnectionResultSchema,
  },
  [DOORS.readConnections]: {
    input: ReadConnectionsInputSchema,
    result: ReadConnectionsResultSchema,
  },
  [DOORS.prepareIssuePublication]: {
    input: PrepareIssuePublicationInputSchema,
    result: PublicationSchema,
  },
  [DOORS.publishIssue]: { input: PublishIssueInputSchema, result: PublicationSchema },
  [DOORS.readPublication]: { input: ReadPublicationInputSchema, result: PublicationSchema },
  [DOORS.reconcilePublication]: {
    input: ReconcilePublicationInputSchema,
    result: PublicationSchema,
  },
} as const;
export type ConnectionMetadata = z.infer<typeof ConnectionMetadataSchema>;
export type Connection = z.infer<typeof ConnectionSchema>;
export type ConfigureConnectionInput = z.infer<typeof ConfigureConnectionInputSchema>;
export type PrepareIssuePublicationInput = z.infer<typeof PrepareIssuePublicationInputSchema>;
export type PublishIssueInput = z.infer<typeof PublishIssueInputSchema>;
export type ReadPublicationInput = z.infer<typeof ReadPublicationInputSchema>;
export type ReconcilePublicationInput = z.infer<typeof ReconcilePublicationInputSchema>;
export type Publication = z.infer<typeof PublicationSchema>;
export type Receipt = z.infer<typeof ReceiptSchema>;
