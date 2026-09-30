import { describe, expect, test } from "bun:test";
import {
  PluginManifestSchema,
  PluginOwnedRefSchema,
  ReferencePrepareRequestSchema,
  ReferencePublishRequestSchema,
  ReferenceRequirePublishedRequestSchema,
  ReferenceGrantRequestSchema,
  ReferenceAudienceRequestSchema,
  RestrictedAudiencePageSchema,
  RestrictedGrantResultSchema,
  type OwnedReferenceDeclaration,
} from "@manifold/protocol";

const ref = { kind: "file" as const, fileId: "f" };
const declaration: OwnedReferenceDeclaration = {
  kind: "file",
  resolveAction: "resolve",
  readCapability: "vendor.owner:read",
  createCapability: "vendor.owner:create",
  deleteCapability: "vendor.owner:delete",
  creatorCaps: ["vendor.owner:read", "vendor.owner:delete", "vendor.owner:share"],
  sharing: {
    grantorCapability: "vendor.owner:share",
    prerequisites: ["vendor.owner:read", "vendor.owner:share"],
    grantableCaps: ["vendor.owner:read"],
  },
};
const manifest = {
  id: "vendor.owner",
  version: "1",
  title: "Owner",
  description: "",
  capabilities: [
    "vendor.owner:read",
    "vendor.owner:create",
    "vendor.owner:delete",
    "vendor.owner:share",
  ],
  contributes: { references: [declaration] },
};

describe("owned-reference declaration authority", () => {
  test("only declared own-namespace capabilities can govern publication or sharing", () => {
    expect(PluginManifestSchema.safeParse(manifest).success).toBe(true);
    for (const cap of ["*", "containers:read", "other.owner:read", "vendor.owner:unknown"]) {
      expect(
        PluginManifestSchema.safeParse({
          ...manifest,
          contributes: { references: [{ ...declaration, readCapability: cap }] },
        }).success,
      ).toBe(false);
      expect(
        PluginManifestSchema.safeParse({
          ...manifest,
          contributes: { references: [{ ...declaration, creatorCaps: [cap] }] },
        }).success,
      ).toBe(false);
    }
    expect(PluginManifestSchema.safeParse({ ...manifest, capabilities: ["*"] }).success).toBe(
      false,
    );
  });

  test("claims and derivations are closed, unique and bounded", () => {
    const invalidDeclarations = [
      { ...declaration, kind: "terminal" },
      { ...declaration, resolveAction: "other.owner.resolve" },
      { ...declaration, scope: "subtree" },
      { ...declaration, creatorCaps: [] },
      { ...declaration, creatorCaps: ["vendor.owner:read", "vendor.owner:read"] },
      { ...declaration, creatorCaps: Array(17).fill("vendor.owner:read") },
      { ...declaration, sharing: { ...declaration.sharing, prerequisites: ["vendor.owner:read"] } },
      {
        ...declaration,
        sharing: { ...declaration.sharing, grantableCaps: ["vendor.owner:delete"] },
      },
      { ...declaration, sharing: { ...declaration.sharing, principalClass: "human" } },
    ];
    for (const invalid of invalidDeclarations) {
      expect(
        PluginManifestSchema.safeParse({
          ...manifest,
          contributes: { references: [invalid] },
        }).success,
      ).toBe(false);
    }
    expect(
      PluginManifestSchema.safeParse({
        ...manifest,
        contributes: { references: [declaration, declaration] },
      }).success,
    ).toBe(false);
  });
});

describe("reference request boundaries", () => {
  test("host-minted identity cannot be selected or smuggled through a prepare request", () => {
    const request = { kind: "file", requestId: "r".repeat(128), bindingDigest: "a".repeat(64) };
    expect(ReferencePrepareRequestSchema.safeParse(request).success).toBe(true);
    for (const patch of [
      { kind: "plugin" },
      { requestId: "r".repeat(129) },
      { requestId: "" },
      { bindingDigest: "A".repeat(64) },
      { bindingDigest: "a".repeat(63) },
      { bindingDigest: `${"a".repeat(64)}\n` },
      { ref },
      { ownerPlugin: "other.owner" },
      { principalId: "p" },
      { credential: "c" },
    ])
      expect(ReferencePrepareRequestSchema.safeParse({ ...request, ...patch }).success).toBe(false);
    expect(
      ReferencePublishRequestSchema.safeParse({
        preparationId: "p",
        readyDigest: "a".repeat(64),
      }).success,
    ).toBe(true);
    expect(
      ReferencePublishRequestSchema.safeParse({
        preparationId: "p",
        readyDigest: "A".repeat(64),
      }).success,
    ).toBe(false);
    expect(PluginOwnedRefSchema.safeParse({ kind: "terminal", terminalId: "t" }).success).toBe(
      false,
    );
    expect(ReferenceRequirePublishedRequestSchema.safeParse({ ref, access: "write" }).success).toBe(
      false,
    );
  });

  test("restricted shares cannot carry engine caps, wildcard reach or authority provenance", () => {
    const request = { ref, principalId: "p", caps: ["vendor.owner:read"], previousGrantId: null };
    expect(ReferenceGrantRequestSchema.safeParse(request).success).toBe(true);
    for (const patch of [
      { caps: [] },
      { caps: ["*"] },
      { caps: ["containers:read"] },
      { caps: ["vendor.owner:read", "vendor.owner:read"] },
      { principalId: "p".repeat(129) },
      { reach: "subtree" },
      { createdBy: "admin" },
      { effect: "deny" },
      { role: "creator" },
    ])
      expect(ReferenceGrantRequestSchema.safeParse({ ...request, ...patch }).success).toBe(false);
  });

  test("audience pagination and the authority projection are bounded and non-credential-bearing", () => {
    expect(ReferenceAudienceRequestSchema.safeParse({ ref, limit: 64 }).success).toBe(true);
    for (const limit of [0, -1, 65, 1.5]) {
      expect(ReferenceAudienceRequestSchema.safeParse({ ref, limit }).success).toBe(false);
    }
    expect(ReferenceAudienceRequestSchema.safeParse({ ref, after: "x".repeat(129) }).success).toBe(
      false,
    );
    expect(RestrictedAudiencePageSchema.safeParse({ shares: [], next: null }).success).toBe(true);
    expect(
      RestrictedAudiencePageSchema.safeParse({
        shares: Array.from({ length: 65 }, (_, index) => ({
          grantId: `g${index}`,
          principalId: `p${index}`,
          caps: ["vendor.owner:read"],
          active: true,
        })),
        next: null,
      }).success,
    ).toBe(false);
    const result = { changed: true, principalReadAllowed: true, credentialAccess: "not_evaluated" };
    expect(RestrictedGrantResultSchema.safeParse(result).success).toBe(true);
    expect(
      RestrictedGrantResultSchema.safeParse({ ...result, credentialAccess: "allowed" }).success,
    ).toBe(false);
    expect(
      RestrictedGrantResultSchema.safeParse({ ...result, winningGrantId: "admin-grant" }).success,
    ).toBe(false);
  });
});
