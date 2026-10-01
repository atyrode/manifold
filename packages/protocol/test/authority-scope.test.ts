import { describe, expect, test } from "bun:test";
import {
  AgentAuthoritySchema,
  AgentGrantSchema,
  AgentGrantV2Schema,
  AgentRunAuthoritySchema,
  AgentRunSchema,
  AgentRunAuthorizationCredentialSchema,
  AgentRunInspectionSchema,
  AgentRunInspectionV2Schema,
  AgentRunInventoryV2Schema,
  AuthorityScopeSchema,
  CredentialSchema,
  CredentialV2Schema,
  CreateRunV2RequestSchema,
  CreateChildRunV2RequestSchema,
  LegacyCapSchema,
  LegacyAuthoredCapSchema,
  MintTokenRequestSchema,
  MintTokenV2RequestSchema,
  TokenGrantSchema,
  TokenGrantV2Schema,
  canonicalizeAuthorityScope,
  intersectAuthorityScopes,
  projectAgentV2,
  projectRunV2,
  projectLegacyAgent,
  projectLegacyCaps,
  projectLegacyCredential,
  projectLegacyRun,
  scopeAdmits,
  scopeWithin,
  type AuthorityScope,
} from "@manifold/protocol";

const M1 = "manifold://machine/m1";
const M2 = "manifold://machine/m2";
const J1 = "manifold://machine/m1/operation/op/job/job";
const correlated: AuthorityScope = [
  { target: M1, reach: "subtree", caps: ["machines:shell"] },
  { target: M2, reach: "node", caps: ["machines:read"] },
];
const principal = { id: "principal", kind: "agent" as const, name: "Worker", color: "#91a7ff" };
const agent = AgentAuthoritySchema.parse({
  agentId: "agent",
  principalId: principal.id,
  sponsorPrincipalId: "sponsor",
  name: "Worker",
  purpose: "Bounded work",
  harness: "external",
  context: { profile: {} },
  grant: {
    caps: ["machines:shell", "machines:read"],
    targets: [M1, M2],
    reach: "subtree",
    authorityScope: correlated,
    maxRunLifetimeMs: 60_000,
    delegation: { maxDepth: 0, maxDescendants: 0 },
    expiresAt: 120_000,
  },
  state: "idle",
  activeRuns: 0,
  createdAt: 1,
  updatedAt: 1,
});
const run = AgentRunAuthoritySchema.parse({
  id: "run",
  agentId: agent.agentId,
  session: null,
  activity: "unknown",
  principal,
  rootRunId: "run",
  parentRunId: null,
  authorizedByPrincipalId: "sponsor",
  authorizationPath: "principal",
  authorizationCredential: {
    tokenId: "token",
    grantId: "grant",
    caps: ["machines:read"],
    containerScope: null,
  },
  purpose: "Bounded work",
  target: M1,
  reach: "node",
  caps: ["machines:read"],
  authorityScope: [{ target: M1, reach: "node", caps: ["machines:read"] }],
  createdAt: 1,
  expiresAt: 120_000,
  renewals: 0,
  maxDepth: 0,
  maxDescendants: 0,
  depth: 0,
  cleanupOwnerPrincipalId: "sponsor",
  state: "active",
  policyRevision: "a".repeat(64),
  cleanup: { revokedCredentials: 0, revokedGrants: 0 },
});

describe("correlated authority algebra", () => {
  test("M1 shell does not cross-pair with M2 read", () => {
    expect(scopeAdmits(correlated, M1, "machines:shell")).toBe(true);
    expect(scopeAdmits(correlated, M2, "machines:read")).toBe(true);
    expect(scopeAdmits(correlated, M2, "machines:shell")).toBe(false);
    expect(scopeAdmits(correlated, M1, "machines:read")).toBe(false);
    expect(scopeWithin([{ target: M2, reach: "node", caps: ["machines:shell"] }], correlated)).toBe(
      false,
    );
  });

  test("node authority never satisfies subtree or descendant authority", () => {
    const node: AuthorityScope = [{ target: M1, reach: "node", caps: ["jobs:read"] }];
    const subtree: AuthorityScope = [{ target: M1, reach: "subtree", caps: ["jobs:read"] }];
    expect(scopeAdmits(node, M1, "jobs:read", "subtree")).toBe(false);
    expect(scopeAdmits(node, J1, "jobs:read")).toBe(false);
    expect(scopeAdmits(subtree, J1, "jobs:read", "subtree")).toBe(true);
    expect(scopeWithin(subtree, node)).toBe(false);
    expect(scopeWithin(node, subtree)).toBe(true);
    expect(intersectAuthorityScopes(node, subtree)).toEqual(node);
  });

  test("intersections preserve the narrower node and never manufacture authority", () => {
    const left: AuthorityScope = [
      { target: M1, reach: "subtree", caps: ["jobs:read", "machines:shell"] },
    ];
    const right: AuthorityScope = [{ target: J1, reach: "node", caps: ["jobs:read"] }];
    const snapshot = structuredClone([left, right]);
    expect(intersectAuthorityScopes(left, right)).toEqual(right);
    expect(intersectAuthorityScopes(right, left)).toEqual(right);
    expect([left, right]).toEqual(snapshot);
    expect(
      intersectAuthorityScopes(correlated, [
        { target: M2, reach: "node", caps: ["machines:shell"] },
      ]),
    ).toEqual([]);
    expect(intersectAuthorityScopes(correlated, [])).toEqual([]);
    expect(scopeWithin([], correlated)).toBe(true);
    expect(scopeAdmits([], M1, "machines:shell")).toBe(false);
  });

  test("canonicalization merges target/reach pairs, sorts and leaves the baseline unchanged", () => {
    const input: AuthorityScope = [
      { target: M2, reach: "node", caps: ["machines:read"] },
      {
        target: "manifold://machine/%6D1",
        reach: "subtree",
        caps: ["jobs:read", "machines:shell", "jobs:read"],
      },
      { target: M1, reach: "subtree", caps: ["machines:read"] },
    ];
    const before = structuredClone(input);
    expect(canonicalizeAuthorityScope(input)).toEqual([
      { target: M1, reach: "subtree", caps: ["jobs:read", "machines:read", "machines:shell"] },
      { target: M2, reach: "node", caps: ["machines:read"] },
    ]);
    expect(input).toEqual(before);
    expect(scopeAdmits(input, M1, "machines:shell", "subtree")).toBe(true);
  });

  test("wire bounds reject entry and merged-cap overflows without throwing on invalid nodes", () => {
    expect(
      AuthorityScopeSchema.safeParse(Array.from({ length: 65 }, () => correlated[0])).success,
    ).toBe(false);
    const caps = Array.from({ length: 129 }, (_, index) => `example.plugin:cap${index}`);
    expect(AuthorityScopeSchema.safeParse([{ target: M1, reach: "node", caps }]).success).toBe(
      false,
    );
    expect(
      AuthorityScopeSchema.safeParse([
        { target: M1, reach: "node", caps: caps.slice(0, 128) },
        { target: "manifold://machine/%6D1", reach: "node", caps: caps.slice(128) },
      ]).success,
    ).toBe(false);
    expect(
      AuthorityScopeSchema.safeParse([
        { target: "invalid", reach: "node", caps: ["machines:read"] },
      ]).success,
    ).toBe(false);
    expect(
      AuthorityScopeSchema.safeParse([{ target: M1, reach: "node", caps: ["*"] }]).success,
    ).toBe(false);
  });
});

describe("released V1 and faithful V2 contracts", () => {
  test("V1 vocabulary rejects shell on grants, runs, credentials and inspection", () => {
    expect(LegacyCapSchema.safeParse("machines:shell").success).toBe(false);
    expect(LegacyAuthoredCapSchema.safeParse("machines:shell").success).toBe(false);
    expect(LegacyAuthoredCapSchema.safeParse("example.plugin:read").success).toBe(true);
    expect(
      MintTokenRequestSchema.safeParse({ principalId: "principal", caps: ["machines:shell"] })
        .success,
    ).toBe(false);
    expect(
      TokenGrantSchema.safeParse({
        token: "secret",
        principal,
        caps: ["machines:shell"],
        containerId: null,
      }).success,
    ).toBe(false);
    expect(
      CredentialSchema.safeParse({ id: "token", createdAt: 1, caps: ["machines:shell"] }).success,
    ).toBe(false);
    expect(AgentGrantSchema.shape.caps.safeParse(["machines:shell"]).success).toBe(false);
    expect(
      AgentRunSchema.safeParse({ ...projectLegacyRun(run), caps: ["machines:shell"] }).success,
    ).toBe(false);
    expect(
      AgentRunAuthorizationCredentialSchema.safeParse({
        ...run.authorizationCredential,
        caps: ["machines:shell"],
      }).success,
    ).toBe(false);
    expect(
      AgentRunInspectionSchema.shape.run.shape.caps.safeParse(["machines:shell"]).success,
    ).toBe(false);
    expect(
      AgentRunInspectionSchema.shape.credentials.element.shape.grant
        .unwrap()
        .shape.caps.safeParse(["machines:shell"]).success,
    ).toBe(false);
  });

  test("empty V2 grants and scope narrowing are explicit, while absence inherits", () => {
    const emptyGrant = {
      scope: [],
      maxRunLifetimeMs: 60_000,
      delegation: { maxDepth: 0, maxDescendants: 0 },
      expiresAt: 120_000,
    };
    expect(AgentGrantV2Schema.parse(emptyGrant).scope).toEqual([]);
    expect(CreateRunV2RequestSchema.parse({ agentId: "agent" }).scope).toBeUndefined();
    expect(CreateRunV2RequestSchema.parse({ agentId: "agent", scope: [] }).scope).toEqual([]);
    expect(
      CreateRunV2RequestSchema.safeParse({ agentId: "agent", caps: ["machines:read"] }).success,
    ).toBe(false);
    expect(
      CreateChildRunV2RequestSchema.safeParse({ runId: "run", caps: ["machines:read"] }).success,
    ).toBe(false);
    expect(
      AgentGrantV2Schema.safeParse({
        ...emptyGrant,
        scope: [{ target: M1, reach: "node", caps: ["tokens:mint"] }],
      }).success,
    ).toBe(false);
    expect(AgentGrantV2Schema.parse({ ...emptyGrant, scope: correlated }).scope).toEqual(
      correlated,
    );
    expect(
      CredentialV2Schema.parse({ id: "token", createdAt: 1, caps: [], authorityScope: [] })
        .authorityScope,
    ).toEqual([]);
    expect(AgentRunInventoryV2Schema.shape.runs.element.shape.scope.parse(correlated)).toEqual(
      correlated,
    );
    expect(AgentRunInspectionV2Schema.shape.run.shape.scope.parse(correlated)).toEqual(correlated);
  });

  test("mint V2 requires one principal and finite expiry, with an honest engine-only summary", () => {
    const input = { principalId: "principal", scope: correlated, expiresAt: 120_000 };
    expect(MintTokenV2RequestSchema.parse(input)).toEqual(input);
    expect(
      MintTokenV2RequestSchema.safeParse({ ...input, principal: { name: "Human" } }).success,
    ).toBe(false);
    expect(
      MintTokenV2RequestSchema.safeParse({ principalId: "principal", scope: [] }).success,
    ).toBe(false);
    expect(MintTokenV2RequestSchema.safeParse({ ...input, expiresAt: Infinity }).success).toBe(
      false,
    );
    const grant = {
      token: "secret",
      principal,
      scope: correlated,
      caps: ["machines:shell", "machines:read"],
      containerId: null,
      expiresAt: 120_000,
    };
    expect(TokenGrantV2Schema.parse(grant).scope).toEqual(correlated);
    expect(TokenGrantV2Schema.safeParse({ ...grant, caps: ["machines:read"] }).success).toBe(false);
    expect(TokenGrantV2Schema.parse({ ...grant, scope: [], caps: [] }).caps).toEqual([]);
  });
});

describe("truthful legacy projection", () => {
  test("V2 projections preserve correlation and scope-bearing authorization credentials", () => {
    expect(projectAgentV2(agent).grant.scope).toEqual(correlated);
    const scoped = {
      ...run,
      authorityScope: correlated,
      authorizationCredential: { ...run.authorizationCredential, authorityScope: correlated },
    };
    const projected = projectRunV2(scoped);
    expect(projected.scope).toEqual(correlated);
    expect(projected.authorizationCredential.authorityScope).toEqual(correlated);
    expect("authorityScope" in projected).toBe(false);
    expect("targets" in projectAgentV2(agent).grant).toBe(false);
  });

  test("nonrectangular Agent scopes refuse instead of cross-pairing rights", () => {
    const nonrectangular = {
      ...agent,
      grant: {
        ...agent.grant,
        authorityScope: [
          { target: M1, reach: "node" as const, caps: ["machines:read" as const] },
          { target: M2, reach: "node" as const, caps: ["jobs:read" as const] },
        ],
      },
    };
    expect(() => projectLegacyAgent(nonrectangular)).toThrow("scoped_authority_requires_v2");
    expect(() => projectLegacyAgent(projectAgentV2(nonrectangular))).toThrow(
      "scoped_authority_requires_v2",
    );
    expect(() => [agent, nonrectangular].map(projectLegacyAgent)).toThrow(
      "scoped_authority_requires_v2",
    );
    const rectangular = {
      ...agent,
      grant: {
        ...agent.grant,
        authorityScope: [
          { target: M1, reach: "node" as const, caps: ["machines:read" as const] },
          { target: M2, reach: "node" as const, caps: ["machines:read" as const] },
        ],
      },
    };
    expect(projectLegacyAgent(rectangular).grant).toMatchObject({
      caps: ["machines:read"],
      targets: [M1, M2],
      reach: "node",
    });
  });

  test("Run projection requires its supported authority to match the launch anchor and reach", () => {
    expect(projectLegacyRun(run).caps).toEqual(["machines:read"]);
    expect(() => projectLegacyRun({ ...run, target: M2 })).toThrow("scoped_authority_requires_v2");
    expect(() => projectLegacyRun({ ...run, reach: "subtree" })).toThrow(
      "scoped_authority_requires_v2",
    );
    expect(() => [run, { ...run, target: M2 }].map(projectLegacyRun)).toThrow(
      "scoped_authority_requires_v2",
    );
    expect(() =>
      projectLegacyRun({
        ...run,
        authorityScope: [
          { target: M1, reach: "node", caps: ["machines:read"] },
          { target: M2, reach: "node", caps: ["jobs:read"] },
        ],
      }),
    ).toThrow("scoped_authority_requires_v2");
    expect(() =>
      projectLegacyRun({
        ...run,
        authorizationCredential: {
          ...run.authorizationCredential,
          authorityScope: [{ target: M1, reach: "node", caps: ["machines:read"] }],
        },
      }),
    ).toThrow("scoped_authority_requires_v2");
  });

  test("compatibility hints omit shell, but empty scoped authority never invents a V1 cap", () => {
    expect(projectLegacyCaps(["machines:shell", "machines:read"])).toEqual(["machines:read"]);
    expect(() => projectLegacyAgent(agent)).toThrow("scoped_authority_requires_v2");
    const empty = {
      ...agent,
      grant: { ...agent.grant, caps: [], targets: [], authorityScope: [] },
    };
    expect(projectAgentV2(empty).grant.scope).toEqual([]);
    expect(() => projectLegacyAgent(empty)).toThrow("scoped_authority_requires_v2");
    expect(() => projectLegacyRun({ ...run, caps: [], authorityScope: [] })).toThrow(
      "scoped_authority_requires_v2",
    );
    expect(() =>
      projectLegacyRun({
        ...run,
        caps: ["machines:shell"],
        authorityScope: [{ target: M1, reach: "node", caps: ["machines:shell"] }],
      }),
    ).toThrow("scoped_authority_requires_v2");
  });
});

describe("whole legacy credential inventory", () => {
  test("one correlated row refuses the whole projection rather than omitting its authority", () => {
    const rows = [
      { id: "legacy", createdAt: 1, caps: ["machines:read" as const] },
      {
        id: "correlated",
        createdAt: 2,
        caps: ["machines:read" as const, "machines:shell" as const],
        authorityScope: correlated,
      },
    ];
    expect(() => rows.map(projectLegacyCredential)).toThrow("scoped_authority_requires_v2");
    expect(rows[1]!.authorityScope).toEqual(correlated);
  });

  test("rectangular anchored ceilings project, explicit empty and legacy absence stay distinct", () => {
    const scoped = {
      id: "token",
      createdAt: 1,
      containerId: "container",
      caps: ["containers:read" as const],
      authorityScope: [
        {
          target: "manifold://container/container",
          reach: "subtree" as const,
          caps: ["containers:read" as const],
        },
      ],
    };
    expect(projectLegacyCredential(scoped)).toMatchObject({
      id: "token",
      containerId: "container",
      caps: ["containers:read"],
    });
    expect(() => projectLegacyCredential({ ...scoped, containerId: "other" })).toThrow(
      "scoped_authority_requires_v2",
    );
    expect(() => projectLegacyCredential({ ...scoped, authorityScope: [] })).toThrow(
      "scoped_authority_requires_v2",
    );
    expect(
      projectLegacyCredential({ id: "empty", createdAt: 1, caps: [], authorityScope: [] }).caps,
    ).toEqual([]);
    expect(() =>
      projectLegacyCredential({
        id: "legacy",
        createdAt: 1,
        caps: ["machines:shell", "machines:read"],
      }),
    ).toThrow("scoped_authority_requires_v2");
  });
});
