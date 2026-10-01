import { createHash } from "node:crypto";
import {
  canonicalJobJson,
  ServicePolicySchema,
  type ServiceOperationPolicy,
  type ServicePolicy,
} from "@manifold/protocol";
import { z } from "zod";
import {
  bytes,
  ConnectionMetadataSchema,
  DigestSchema,
  IssueNumberSchema,
  LIMITS,
  LoginSchema,
  NameSchema,
  NodeIdSchema,
  PrepareIssuePublicationInputSchema,
  PublicationSchema,
  publicText,
  RepositoryNameSchema,
  type ConnectionMetadata,
  type Publication,
  type Receipt,
} from "./contract.ts";

export const GITHUB_ORIGIN = "https://api.github.com";
export const NATIVE_OPS = {
  account: "account",
  repository: "repository",
  create: "create",
  list: "list",
  issue: "issue",
} as const;

const MAX_REQUEST_BYTES = 65536;
const PolicyDestinationSchema = ConnectionMetadataSchema.pick({
  serviceId: true,
  serviceRevision: true,
  owner: true,
  repository: true,
}).strip();
// Current connections may carry their separately reviewed provider revision as well.
const PolicyMetadataSchema = ConnectionMetadataSchema.extend({
  connectionRevision: DigestSchema.optional(),
});

function issueFields(): string[][] {
  return [
    ["id"],
    ["node_id"],
    ["number"],
    ["html_url"],
    ["repository_url"],
    ["title"],
    ["body"],
    ["user", "id"],
    ["user", "node_id"],
    ["user", "login"],
    ["user", "type"],
    ["pull_request", "url"],
  ];
}

function nativeOperation(
  method: "GET" | "POST",
  path: string,
  fields: string[][],
): ServiceOperationPolicy {
  return {
    method,
    path,
    requestHeaders: {
      "user-agent": "manifold-atyrode-github",
      "x-github-api-version": "2026-03-10",
    },
    readable: method === "GET",
    invocable: method === "POST",
    input: {},
    query: {},
    body: [],
    timeoutMs: 15000,
    maxRequestBytes: MAX_REQUEST_BYTES,
    maxResponseBytes: 1024 * 1024,
    maxResultBytes: 96 * 1024,
    response: { kind: "projected-json", fields, maxArrayItems: LIMITS.pageSize },
  };
}

function reviewedPolicy(
  metadata: z.infer<typeof PolicyDestinationSchema>,
  credentialRef: string,
): ServicePolicy {
  const repositoryPath = `/repos/${metadata.owner}/${metadata.repository}`;
  return {
    serviceId: metadata.serviceId,
    revision: metadata.serviceRevision,
    origin: GITHUB_ORIGIN,
    allowLoopbackHttp: false,
    credential: { ref: credentialRef, header: "Authorization", prefix: "Bearer " },
    maxConcurrent: LIMITS.activeCalls,
    operations: {
      [NATIVE_OPS.account]: nativeOperation("GET", "/user", [
        ["id"],
        ["node_id"],
        ["login"],
        ["type"],
        ["html_url"],
      ]),
      [NATIVE_OPS.repository]: nativeOperation("GET", repositoryPath, [
        ["id"],
        ["node_id"],
        ["name"],
        ["full_name"],
        ["html_url"],
        ["owner", "id"],
        ["owner", "node_id"],
        ["owner", "login"],
        ["owner", "type"],
        ["private"],
        ["visibility"],
        ["archived"],
        ["has_issues"],
      ]),
      [NATIVE_OPS.create]: {
        ...nativeOperation("POST", `${repositoryPath}/issues`, issueFields()),
        input: {
          title: { type: "string", required: true, maxBytes: LIMITS.titleBytes },
          body: { type: "string", required: true, maxBytes: LIMITS.bodyBytes },
        },
        body: [
          { path: ["title"], value: { input: "title" } },
          { path: ["body"], value: { input: "body" } },
        ],
      },
      [NATIVE_OPS.list]: {
        ...nativeOperation(
          "GET",
          `${repositoryPath}/issues`,
          issueFields().map((path) => ["*", ...path]),
        ),
        input: {
          state: { type: "string", required: true, maxBytes: 3, enum: ["all"] },
          sort: { type: "string", required: true, maxBytes: 7, enum: ["created"] },
          direction: { type: "string", required: true, maxBytes: 4, enum: ["desc"] },
          per_page: {
            type: "number",
            required: true,
            min: LIMITS.pageSize,
            max: LIMITS.pageSize,
            integer: true,
          },
          page: { type: "number", required: true, min: 1, max: LIMITS.pages, integer: true },
        },
        query: {
          state: "state",
          sort: "sort",
          direction: "direction",
          per_page: "per_page",
          page: "page",
        },
      },
      [NATIVE_OPS.issue]: {
        ...nativeOperation("GET", `${repositoryPath}/issues/{issueNumber}`, issueFields()),
        // Native path leaves must be strings. The provider supplies a validated safe integer.
        input: { issueNumber: { type: "string", required: true, maxBytes: 16 } },
      },
    },
  };
}

/** Optional operator provisioning aid only; this never reads or configures native authority. */
export function githubServicePolicy(
  metadata: Pick<ConnectionMetadata, "serviceId" | "serviceRevision" | "owner" | "repository">,
  credentialRef: string,
): ServicePolicy {
  return reviewedPolicy(PolicyDestinationSchema.parse(metadata), NameSchema.parse(credentialRef));
}

/** Compare the entire owner-native policy, including its digest, without rewriting it. */
export function validateGithubPolicy(policy: ServicePolicy, metadata: ConnectionMetadata): boolean {
  try {
    const connection = PolicyMetadataSchema.safeParse(metadata);
    const parsed = ServicePolicySchema.safeParse(policy);
    if (!connection.success || !parsed.success || !parsed.data.credential) return false;
    const expected = reviewedPolicy(connection.data, parsed.data.credential.ref);
    const canonical = canonicalJobJson(policy);
    // Compare the original JSON too: schema record parsing must not hide forbidden own keys.
    return (
      canonical === canonicalJobJson(expected) &&
      createHash("sha256").update(canonical).digest("hex") === connection.data.policySha256
    );
  } catch {
    return false;
  }
}

const AccountEvidenceSchema = z.strictObject({
  id: IssueNumberSchema,
  node_id: NodeIdSchema,
  login: LoginSchema,
  type: z.literal("User"),
  html_url: z.url().max(512),
});
const RepositoryEvidenceSchema = z.strictObject({
  id: IssueNumberSchema,
  node_id: NodeIdSchema,
  name: RepositoryNameSchema,
  full_name: z.string().max(140),
  html_url: z.url().max(512),
  owner: z.strictObject({
    id: IssueNumberSchema,
    node_id: NodeIdSchema,
    login: LoginSchema,
    type: z.enum(["User", "Organization"]),
  }),
  private: z.boolean(),
  visibility: z.enum(["public", "private", "internal"]),
  archived: z.literal(false),
  has_issues: z.literal(true),
});

export function verifyGithubIdentity(
  account: unknown,
  repository: unknown,
  connection: ConnectionMetadata,
): boolean {
  const metadata = PolicyMetadataSchema.safeParse(connection);
  const user = AccountEvidenceSchema.safeParse(account);
  const repo = RepositoryEvidenceSchema.safeParse(repository);
  if (!metadata.success || !user.success || !repo.success) return false;
  const expected = metadata.data;
  return (
    user.data.login === expected.accountLogin &&
    user.data.node_id === expected.accountNodeId &&
    user.data.html_url === `https://github.com/${expected.accountLogin}` &&
    repo.data.node_id === expected.repositoryNodeId &&
    repo.data.name === expected.repository &&
    repo.data.full_name === `${expected.owner}/${expected.repository}` &&
    repo.data.html_url === `https://github.com/${expected.owner}/${expected.repository}` &&
    repo.data.owner.login === expected.owner &&
    repo.data.owner.node_id === expected.ownerNodeId &&
    repo.data.private === (repo.data.visibility !== "public")
  );
}

export const IssueEvidenceSchema = z.strictObject({
  id: IssueNumberSchema,
  node_id: NodeIdSchema,
  number: IssueNumberSchema,
  html_url: z.url().max(512),
  repository_url: z.url().max(512),
  title: PrepareIssuePublicationInputSchema.shape.publicTitle,
  body: publicText(LIMITS.bodyBytes).nullable(),
  user: z
    .strictObject({
      id: IssueNumberSchema,
      node_id: NodeIdSchema,
      login: z.union([LoginSchema, z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}\[bot\]$/)]),
      type: z.enum(["User", "Bot", "Organization"]),
    })
    .nullable(),
  pull_request: z.strictObject({ url: z.url().max(512) }).optional(),
});

const ReceiptPublicationSchema = PublicationSchema.pick({
  operationId: true,
  reviewedDigest: true,
  connection: true,
  publicTitle: true,
  publicBody: true,
  marker: true,
})
  .extend({ publicTitle: PrepareIssuePublicationInputSchema.shape.publicTitle })
  .strip();

type ReviewedPublication = Pick<
  Publication,
  "operationId" | "connection" | "publicTitle" | "publicBody" | "marker"
>;

export function publicationDigest(publication: ReviewedPublication): string {
  return createHash("sha256")
    .update(
      canonicalJobJson({
        version: 1,
        operationId: publication.operationId,
        connection: publication.connection,
        publicTitle: publication.publicTitle,
        publicBody: publication.publicBody,
        marker: publication.marker,
      }),
    )
    .digest("hex");
}

export function issueReceipt(
  value: unknown,
  publication: ReviewedPublication & Pick<Publication, "reviewedDigest">,
): Receipt | null {
  const evidence = IssueEvidenceSchema.safeParse(value);
  const reviewed = ReceiptPublicationSchema.safeParse(publication);
  if (!evidence.success || !reviewed.success) return null;
  const issue = evidence.data;
  const prepared = reviewed.data;
  const { connection, marker, publicTitle, publicBody } = prepared;
  if (
    "pull_request" in issue ||
    !issue.user ||
    issue.user.type !== "User" ||
    issue.user.login !== connection.accountLogin ||
    issue.user.node_id !== connection.accountNodeId ||
    issue.title !== publicTitle ||
    issue.body !== publicBody ||
    !publicBody.endsWith(`\n\n${marker}`) ||
    publicBody.indexOf(marker) !== publicBody.length - marker.length ||
    bytes(`/repos/${connection.owner}/${connection.repository}/issues`) +
      bytes(JSON.stringify({ title: publicTitle, body: publicBody })) >
      MAX_REQUEST_BYTES ||
    publicationDigest(prepared) !== prepared.reviewedDigest ||
    issue.repository_url !==
      `${GITHUB_ORIGIN}/repos/${connection.owner}/${connection.repository}` ||
    issue.html_url !==
      `https://github.com/${connection.owner}/${connection.repository}/issues/${issue.number}`
  )
    return null;
  return {
    operationId: prepared.operationId,
    reviewedDigest: prepared.reviewedDigest,
    repositoryNodeId: connection.repositoryNodeId,
    issueNodeId: issue.node_id,
    issueId: issue.id,
    issueNumber: issue.number,
    url: issue.html_url,
    accountNodeId: issue.user.node_id,
  };
}
