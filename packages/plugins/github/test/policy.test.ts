import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  canonicalJobJson,
  ServicePolicySchema,
  type ServiceOperationPolicy,
  type ServicePolicy,
} from "@manifold/protocol";
import type { z } from "zod";
import {
  LIMITS,
  type Connection,
  type ConnectionMetadata,
  type Publication,
} from "../src/contract.ts";
import {
  githubServicePolicy,
  IssueEvidenceSchema,
  issueReceipt,
  type NATIVE_OPS,
  publicationDigest,
  validateGithubPolicy,
  verifyGithubIdentity,
} from "../src/policy.ts";

const metadata: ConnectionMetadata = {
  connectionId: "fixture-connection",
  machineId: "fixture-machine",
  serviceId: "fixture-github",
  serviceRevision: "fixture-revision",
  policySha256: "0".repeat(64),
  owner: "fixture-owner",
  repository: "fixture-repo",
  ownerNodeId: "O_fixture_owner",
  repositoryNodeId: "R_fixture_repo",
  accountLogin: "fixture-user",
  accountNodeId: "U_fixture_user",
  credentialMode: "owner-user-token",
};
type FixedPolicy = Omit<ServicePolicy, "operations"> & {
  operations: Record<keyof typeof NATIVE_OPS, ServiceOperationPolicy>;
};
const policyFixture = githubServicePolicy(metadata, "fixture-native-token") as FixedPolicy;

function metadataFor(policy: ServicePolicy): ConnectionMetadata {
  return {
    ...metadata,
    policySha256: createHash("sha256").update(canonicalJobJson(policy)).digest("hex"),
  };
}

const connection: Connection = {
  ...metadataFor(policyFixture),
  connectionRevision: "c".repeat(64),
};
type Review = Pick<
  Publication,
  "operationId" | "reviewedDigest" | "connection" | "publicTitle" | "publicBody" | "marker"
>;
type Issue = z.infer<typeof IssueEvidenceSchema>;
type Account = {
  id: number;
  node_id: string;
  login: string;
  type: string;
  html_url: string;
};
type Repository = {
  id: number;
  node_id: string;
  name: string;
  full_name: string;
  html_url: string;
  owner: Omit<Account, "html_url">;
  private: boolean;
  visibility: string;
  archived: boolean;
  has_issues: boolean;
};
const marker = `<!-- manifold-github:${"a".repeat(48)} -->`;

function reviewFixture(overrides: Partial<Review> = {}): Review {
  const publication = {
    operationId: "b".repeat(32),
    connection: structuredClone(connection),
    publicTitle: "A reviewed public issue",
    publicBody: `Public details only.\n\n${marker}`,
    marker,
    ...overrides,
  };
  return { ...publication, reviewedDigest: publicationDigest(publication) };
}

function issueFixture(review: Review = reviewFixture()): Issue {
  return {
    id: 101,
    node_id: "I_fixture_issue",
    number: 7,
    html_url: "https://github.com/fixture-owner/fixture-repo/issues/7",
    repository_url: "https://api.github.com/repos/fixture-owner/fixture-repo",
    title: review.publicTitle,
    body: review.publicBody,
    user: { id: 11, node_id: "U_fixture_user", login: "fixture-user", type: "User" },
  };
}

function accountFixture(): Account {
  return {
    id: 11,
    node_id: "U_fixture_user",
    login: "fixture-user",
    type: "User",
    html_url: "https://github.com/fixture-user",
  };
}

function repositoryFixture(): Repository {
  return {
    id: 21,
    node_id: "R_fixture_repo",
    name: "fixture-repo",
    full_name: "fixture-owner/fixture-repo",
    html_url: "https://github.com/fixture-owner/fixture-repo",
    owner: { id: 31, node_id: "O_fixture_owner", login: "fixture-owner", type: "Organization" },
    private: false,
    visibility: "public",
    archived: false,
    has_issues: true,
  };
}

describe("reviewed owner-native GitHub policy", () => {
  test("a credential reference is native-owned but its exact policy digest is reviewed", () => {
    const changed = githubServicePolicy(
      {
        serviceId: metadata.serviceId,
        serviceRevision: metadata.serviceRevision,
        owner: metadata.owner,
        repository: metadata.repository,
      },
      "another-native-reference",
    );
    const parsed = ServicePolicySchema.parse(changed);
    expect(validateGithubPolicy(parsed, metadataFor(parsed))).toBe(true);
    expect(validateGithubPolicy(parsed, connection)).toBe(false);
    const reordered = Object.fromEntries(Object.entries(policyFixture).reverse()) as ServicePolicy;
    expect(validateGithubPolicy(reordered, connection)).toBe(true);
  });

  const tampering: Array<[string, (policy: FixedPolicy) => void]> = [
    [
      "alternate origin",
      (policy) => {
        policy.origin = "https://github.example";
      },
    ],
    [
      "loopback permission",
      (policy) => {
        policy.allowLoopbackHttp = true;
      },
    ],
    [
      "different service",
      (policy) => {
        policy.serviceId = "another-service";
      },
    ],
    [
      "different revision",
      (policy) => {
        policy.revision = "another-revision";
      },
    ],
    [
      "missing source credential",
      (policy) => {
        delete policy.credential;
      },
    ],
    [
      "alternate credential header",
      (policy) => {
        policy.credential!.header = "X-Api-Key";
      },
    ],
    [
      "alternate credential mode",
      (policy) => {
        policy.credential!.prefix = "Basic ";
      },
    ],
    [
      "extra concurrency",
      (policy) => {
        policy.maxConcurrent = 5;
      },
    ],
    [
      "unreviewed cost policy",
      (policy) => {
        policy.directCostCeilingMicros = 1;
      },
    ],
    [
      "alternate repository",
      (policy) => {
        policy.operations.create.path = "/repos/fixture-owner/another-repo/issues";
      },
    ],
    [
      "different method",
      (policy) => {
        policy.operations.create.method = "PATCH";
      },
    ],
    [
      "invocable account read",
      (policy) => {
        policy.operations.account.invocable = true;
      },
    ],
    [
      "disabled identity read",
      (policy) => {
        policy.operations.repository.readable = false;
      },
    ],
    [
      "unreviewed API header",
      (policy) => {
        policy.operations.create.requestHeaders!["x-github-api-version"] = "2022-11-28";
      },
    ],
    [
      "additional header",
      (policy) => {
        policy.operations.create.requestHeaders!["x-extra"] = "unreviewed";
      },
    ],
    [
      "longer timeout",
      (policy) => {
        policy.operations.create.timeoutMs = 16000;
      },
    ],
    [
      "larger response",
      (policy) => {
        policy.operations.list.maxResponseBytes *= 2;
      },
    ],
    [
      "changed result ceiling",
      (policy) => {
        policy.operations.list.maxResultBytes -= 1;
      },
    ],
    [
      "changed request ceiling",
      (policy) => {
        policy.operations.create.maxRequestBytes -= 1;
      },
    ],
    [
      "larger title",
      (policy) => {
        policy.operations.create.input.title = { type: "string", required: true, maxBytes: 257 };
      },
    ],
    [
      "optional body",
      (policy) => {
        policy.operations.create.input.body = { type: "string", required: false, maxBytes: 32768 };
      },
    ],
    [
      "extra JSON field",
      (policy) => {
        policy.operations.create.body.push({
          path: ["assignee"],
          value: { literal: "another-user" },
        });
      },
    ],
    [
      "credential in issue body",
      (policy) => {
        policy.operations.create.body[1] = {
          path: ["body"],
          value: { credentialRef: "fixture-native-token" },
        };
      },
    ],
    [
      "omitted review field",
      (policy) => {
        policy.operations.create.body.pop();
      },
    ],
    [
      "open-only reconciliation",
      (policy) => {
        policy.operations.list.input.state = {
          type: "string",
          required: true,
          maxBytes: 4,
          enum: ["open"],
        };
      },
    ],
    [
      "reconciliation order changes",
      (policy) => {
        policy.operations.list.input.direction = {
          type: "string",
          required: true,
          maxBytes: 4,
          enum: ["desc", "asc"],
        };
      },
    ],
    [
      "unbounded pagination",
      (policy) => {
        policy.operations.list.input.page = {
          type: "number",
          required: true,
          min: 1,
          max: 11,
          integer: true,
        };
      },
    ],
    [
      "larger page",
      (policy) => {
        policy.operations.list.input.per_page = {
          type: "number",
          required: true,
          min: 1,
          max: 100,
          integer: true,
        };
      },
    ],
    [
      "extra query leaf",
      (policy) => {
        policy.operations.list.query.creator = "state";
      },
    ],
    [
      "longer issue path leaf",
      (policy) => {
        policy.operations.issue.input.issueNumber = {
          type: "string",
          required: true,
          maxBytes: 128,
        };
      },
    ],
    [
      "full response disclosure",
      (policy) => {
        policy.operations.create.response = { kind: "json", disclosure: "full" };
      },
    ],
    [
      "additional projected data",
      (policy) => {
        const response = policy.operations.repository.response;
        if (response.kind === "projected-json") response.fields.push(["permissions", "admin"]);
      },
    ],
    [
      "missing PR exclusion evidence",
      (policy) => {
        const response = policy.operations.issue.response;
        if (response.kind === "projected-json")
          response.fields = response.fields.filter((path) => path[0] !== "pull_request");
      },
    ],
    [
      "larger projected array",
      (policy) => {
        const response = policy.operations.list.response;
        if (response.kind === "projected-json") response.maxArrayItems = 3;
      },
    ],
    [
      "extra operation",
      (policy) => {
        Object.assign(policy.operations, { unreviewed: structuredClone(policy.operations.create) });
      },
    ],
    [
      "unknown policy field",
      (policy) => {
        Object.assign(policy, { endpoint: "unreviewed" });
      },
    ],
    [
      "prototype-named operation",
      (policy) => {
        Object.defineProperty(policy.operations, "__proto__", {
          enumerable: true,
          value: structuredClone(policy.operations.create),
        });
      },
    ],
  ];

  test.each(tampering)("rejects %s even with a fresh digest", (_name, mutate) => {
    const changed = structuredClone(policyFixture);
    mutate(changed);
    expect(validateGithubPolicy(changed, metadataFor(changed))).toBe(false);
  });

  test("unsafe path controls, credential text, and unsupported registration modes refuse", () => {
    expect(() =>
      githubServicePolicy({ ...metadata, repository: "../escape" }, "fixture-token"),
    ).toThrow();
    expect(() => githubServicePolicy(metadata, "Bearer secret value")).toThrow();
    const unsupported = {
      ...metadata,
      credentialMode: "github-app",
    } as unknown as ConnectionMetadata;
    expect(validateGithubPolicy(policyFixture, unsupported)).toBe(false);
  });
});

describe("current account and canonical repository identity", () => {
  test("supports user tokens for public, private, and internal issue-enabled repositories", () => {
    for (const visibility of ["public", "private", "internal"]) {
      const repository = { ...repositoryFixture(), visibility, private: visibility !== "public" };
      expect(verifyGithubIdentity(accountFixture(), repository, connection)).toBe(true);
    }
  });

  const accountChanges: Array<[string, (account: Account) => void]> = [
    [
      "renamed account",
      (account) => {
        account.login = "Fixture-user";
      },
    ],
    [
      "different account node",
      (account) => {
        account.node_id = "U_someone_else";
      },
    ],
    [
      "bot token identity",
      (account) => {
        account.type = "Bot";
      },
    ],
    [
      "organization token identity",
      (account) => {
        account.type = "Organization";
      },
    ],
    [
      "unsafe account id",
      (account) => {
        account.id = Number.MAX_SAFE_INTEGER + 1;
      },
    ],
    [
      "redirected account URL",
      (account) => {
        account.html_url += "?next=elsewhere";
      },
    ],
  ];
  test.each(accountChanges)("refuses %s", (_name, mutate) => {
    const account = accountFixture();
    mutate(account);
    expect(verifyGithubIdentity(account, repositoryFixture(), connection)).toBe(false);
  });

  const repositoryChanges: Array<[string, (repository: Repository) => void]> = [
    [
      "repository transfer",
      (repository) => {
        repository.owner.node_id = "O_other_owner";
      },
    ],
    [
      "renamed owner",
      (repository) => {
        repository.owner.login = "Fixture-owner";
      },
    ],
    [
      "replaced repository node",
      (repository) => {
        repository.node_id = "R_replacement";
      },
    ],
    [
      "renamed repository",
      (repository) => {
        repository.name = "Fixture-repo";
      },
    ],
    [
      "mismatched full name",
      (repository) => {
        repository.full_name = "fixture-owner/another";
      },
    ],
    [
      "unsafe repository id",
      (repository) => {
        repository.id = Number.MAX_SAFE_INTEGER + 1;
      },
    ],
    [
      "unsafe owner id",
      (repository) => {
        repository.owner.id = Number.MAX_SAFE_INTEGER + 1;
      },
    ],
    [
      "archived repository",
      (repository) => {
        repository.archived = true;
      },
    ],
    [
      "disabled issues",
      (repository) => {
        repository.has_issues = false;
      },
    ],
    [
      "inconsistent visibility",
      (repository) => {
        repository.private = true;
      },
    ],
    [
      "noncanonical repository URL",
      (repository) => {
        repository.html_url += "/";
      },
    ],
    [
      "unsupported owner identity",
      (repository) => {
        repository.owner.type = "Bot";
      },
    ],
  ];
  test.each(repositoryChanges)("refuses %s", (_name, mutate) => {
    const repository = repositoryFixture();
    mutate(repository);
    expect(verifyGithubIdentity(accountFixture(), repository, connection)).toBe(false);
  });

  test("missing or unprojected identity data cannot silently become account evidence", () => {
    const withoutType: Partial<Account> = accountFixture();
    delete withoutType.type;
    expect(verifyGithubIdentity(withoutType, repositoryFixture(), connection)).toBe(false);
    expect(
      verifyGithubIdentity(
        { ...accountFixture(), token: "private-canary" },
        repositoryFixture(),
        connection,
      ),
    ).toBe(false);
  });
});

describe("exact reviewed issue receipt", () => {
  test("returns only the real safe identity bound to the reviewed operation", () => {
    const review = reviewFixture();
    expect(issueReceipt(issueFixture(review), review)).toEqual({
      operationId: review.operationId,
      reviewedDigest: review.reviewedDigest,
      repositoryNodeId: "R_fixture_repo",
      issueNodeId: "I_fixture_issue",
      issueId: 101,
      issueNumber: 7,
      url: "https://github.com/fixture-owner/fixture-repo/issues/7",
      accountNodeId: "U_fixture_user",
    });
  });

  test("the largest safe number is preserved without rounding or invented identity", () => {
    const review = reviewFixture();
    const issue = issueFixture(review);
    issue.id = issue.number = issue.user!.id = Number.MAX_SAFE_INTEGER;
    issue.html_url = `https://github.com/fixture-owner/fixture-repo/issues/${Number.MAX_SAFE_INTEGER}`;
    expect(issueReceipt(issue, review)).toMatchObject({
      issueId: Number.MAX_SAFE_INTEGER,
      issueNumber: Number.MAX_SAFE_INTEGER,
      url: issue.html_url,
    });
  });

  const invalidEvidence: Array<[string, (issue: Issue) => unknown]> = [
    ["unsafe issue id", (issue) => ({ ...issue, id: Number.MAX_SAFE_INTEGER + 1 })],
    [
      "unsafe issue number",
      (issue) => ({
        ...issue,
        number: Number.MAX_SAFE_INTEGER + 1,
        html_url: `https://github.com/fixture-owner/fixture-repo/issues/${Number.MAX_SAFE_INTEGER + 1}`,
      }),
    ],
    [
      "unsafe creator id",
      (issue) => ({ ...issue, user: { ...issue.user, id: Number.MAX_SAFE_INTEGER + 1 } }),
    ],
    ["fractional identity", (issue) => ({ ...issue, number: 7.5 })],
    ["zero identity", (issue) => ({ ...issue, id: 0 })],
    ["non-finite identity", (issue) => ({ ...issue, id: Infinity })],
    ["numeric string", (issue) => ({ ...issue, number: "7" })],
    ["missing node identity", (issue) => ({ ...issue, node_id: "" })],
    ["changed title", (issue) => ({ ...issue, title: `${issue.title}!` })],
    ["changed body", (issue) => ({ ...issue, body: `${issue.body}\n` })],
    ["different creator", (issue) => ({ ...issue, user: { ...issue.user, node_id: "U_another" } })],
    ["renamed creator", (issue) => ({ ...issue, user: { ...issue.user, login: "Fixture-user" } })],
    ["unsupported creator type", (issue) => ({ ...issue, user: { ...issue.user, type: "Bot" } })],
    [
      "pull request",
      (issue) => ({
        ...issue,
        pull_request: { url: "https://api.github.com/repos/fixture-owner/fixture-repo/pulls/7" },
      }),
    ],
    ["unprojected issue data", (issue) => ({ ...issue, private_context: "private-canary" })],
    [
      "unprojected creator data",
      (issue) => ({ ...issue, user: { ...issue.user, token: "private-canary" } }),
    ],
  ];
  test.each(invalidEvidence)("rejects %s", (_name, change) => {
    const review = reviewFixture();
    expect(issueReceipt(change(issueFixture(review)), review)).toBeNull();
  });

  test("unrelated empty or bot-created issues are evidence, never this publication's receipt", () => {
    const review = reviewFixture();
    const empty = { ...issueFixture(review), body: null, user: null };
    expect(IssueEvidenceSchema.safeParse(empty).success).toBe(true);
    expect(issueReceipt(empty, review)).toBeNull();
    const bot = {
      ...issueFixture(review),
      user: { id: 19, node_id: "B_fixture", login: "fixture-app[bot]", type: "Bot" },
    };
    expect(IssueEvidenceSchema.safeParse(bot).success).toBe(true);
    expect(issueReceipt(bot, review)).toBeNull();
  });

  test("a stale digest cannot authorize changed bytes, operation, or connection pins", () => {
    const original = reviewFixture();
    const changedReviews: Review[] = [
      { ...original, publicTitle: "Different reviewed text" },
      { ...original, operationId: "d".repeat(32) },
      { ...original, connection: { ...original.connection, connectionRevision: "e".repeat(64) } },
      { ...original, connection: { ...original.connection, policySha256: "f".repeat(64) } },
      { ...original, reviewedDigest: "0".repeat(64) },
    ];
    for (const changed of changedReviews)
      expect(issueReceipt(issueFixture(changed), changed)).toBeNull();
  });

  test("valid Unicode is exact public content, not a normalization opportunity", () => {
    const review = reviewFixture({
      publicTitle: "Caf\u00e9",
      publicBody: `\ud83d\ude00 Public body\n\n${marker}`,
    });
    const issue = issueFixture(review);
    expect(issueReceipt(issue, review)?.reviewedDigest).toBe(review.reviewedDigest);
    expect(issueReceipt({ ...issue, title: "Cafe\u0301" }, review)).toBeNull();
  });

  test("malformed Unicode and blank titles are rejected even with matching digest and evidence", () => {
    for (const overrides of [
      { publicTitle: "bad\ud800" },
      { publicTitle: " \t\n" },
      { publicBody: `bad\udc00\n\n${marker}` },
    ]) {
      const review = reviewFixture(overrides);
      expect(issueReceipt(issueFixture(review), review)).toBeNull();
    }
  });

  test("UTF-8 field limits and the native JSON request limit both apply", () => {
    const suffix = `\n\n${marker}`;
    const review = reviewFixture({
      publicTitle: "\u00e9".repeat(128),
      publicBody: `${"a".repeat(LIMITS.bodyBytes - suffix.length)}${suffix}`,
    });
    expect(issueReceipt(issueFixture(review), review)?.reviewedDigest).toBe(review.reviewedDigest);
    for (const overrides of [
      { publicTitle: `${review.publicTitle}\u00e9` },
      { publicBody: `a${review.publicBody}` },
      { publicBody: `${"\u0000".repeat(12000)}${suffix}` },
    ]) {
      const invalid = reviewFixture(overrides);
      expect(issueReceipt(issueFixture(invalid), invalid)).toBeNull();
    }
  });

  test("the request target consumes the same native byte allowance as the JSON body", () => {
    const target = `/repos/${connection.owner}/${connection.repository}/issues`;
    const title = "T".repeat(LIMITS.titleBytes);
    const suffix = `\n\n${marker}`;
    const remaining =
      65536 -
      Buffer.byteLength(target) -
      Buffer.byteLength(JSON.stringify({ title, body: suffix }));
    const body = `${"\n".repeat(Math.floor(remaining / 2))}${"a".repeat(remaining % 2)}${suffix}`;
    const review = reviewFixture({ publicTitle: title, publicBody: body });
    expect(Buffer.byteLength(target) + Buffer.byteLength(JSON.stringify({ title, body }))).toBe(
      65536,
    );
    expect(issueReceipt(issueFixture(review), review)?.issueNumber).toBe(7);

    const over = reviewFixture({ publicTitle: title, publicBody: `a${body}` });
    expect(issueReceipt(issueFixture(over), over)).toBeNull();
  });

  test("the exact provider marker occurs once at the reviewed body suffix", () => {
    for (const publicBody of [
      `Public details.\n${marker}`,
      `Public details.\n\n${marker}\n`,
      `${marker}\n\n${marker}`,
      "Public details without the operation marker.",
    ]) {
      const review = reviewFixture({ publicBody });
      expect(issueReceipt(issueFixture(review), review)).toBeNull();
    }
    const malformed = reviewFixture({ marker: "<!-- manifold-github:consumer-private-ref -->" });
    expect(issueReceipt(issueFixture(malformed), malformed)).toBeNull();
  });

  const noncanonicalIssueUrls = [
    "http://github.com/fixture-owner/fixture-repo/issues/7",
    "https://github.com.example/fixture-owner/fixture-repo/issues/7",
    "https://login:password@github.com/fixture-owner/fixture-repo/issues/7",
    "https://github.com:443/fixture-owner/fixture-repo/issues/7",
    "https://GITHUB.com/fixture-owner/fixture-repo/issues/7",
    "https://github.com/fixture-owner/fixture-repo/issues/7?redirect=elsewhere",
    "https://github.com/fixture-owner/fixture-repo/issues/7#fragment",
    "https://github.com/%66ixture-owner/fixture-repo/issues/7",
    "https://github.com/fixture-owner/another-repo/issues/7",
    "https://github.com/fixture-owner/fixture-repo/issues/07",
    "https://github.com/fixture-owner/fixture-repo/issues/8",
    "https://github.com/fixture-owner/fixture-repo/pull/7",
    "https://github.com/fixture-owner/fixture-repo/issues/7/",
    "https://github.com/fixture-owner/fixture-repo/issues/../issues/7",
  ];
  test.each(noncanonicalIssueUrls)("refuses noncanonical issue URL %s", (html_url) => {
    const review = reviewFixture();
    expect(issueReceipt({ ...issueFixture(review), html_url }, review)).toBeNull();
  });

  test.each([
    "https://api.github.com/repos/fixture-owner/another-repo",
    "https://api.github.com/repos/Fixture-owner/fixture-repo",
    "https://api.github.com/repos/fixture-owner/fixture-repo/",
    "https://api.github.com/repos/fixture-owner/fixture-repo?redirect=elsewhere",
    "https://github.com/fixture-owner/fixture-repo",
  ])("refuses noncanonical repository URL %s", (repository_url) => {
    const review = reviewFixture();
    expect(issueReceipt({ ...issueFixture(review), repository_url }, review)).toBeNull();
  });
});
