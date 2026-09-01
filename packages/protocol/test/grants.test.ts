import { describe, expect, test } from "bun:test";
import {
  CreateGrantRequestSchema,
  GRANT_EFFECTS,
  GRANT_REACHES,
  GrantPrincipalSchema,
  GrantSchema,
  GrantsSchema,
  ListGrantsRequestSchema,
  MANIFOLD_ROOT_URI,
  MANIFOLD_URI_SCHEME,
  MAX_GRANT_ID_LENGTH,
  MAX_GRANT_NODE_LENGTH,
  RevokeGrantRequestSchema,
  buildProtocolJsonSchema,
  formatManifoldUri,
  grantVocabulary,
} from "@manifold/protocol";

const CONTAINER = formatManifoldUri({ kind: "container", containerId: "c-1" });
const ELEMENT = formatManifoldUri({
  kind: "element",
  containerId: "c-1",
  elementId: "e-1",
});

/** ADR 0011's row, spelled once so every rejection below differs from it by exactly one thing. */
const row = (over: Record<string, unknown> = {}) => ({
  id: "g-1",
  principal: { kind: "principal", id: "p-1" },
  node: CONTAINER,
  caps: ["containers:read"],
  effect: "allow",
  reach: "subtree",
  createdBy: "p-owner",
  createdAt: 1_700_000_000_000,
  ...over,
});

/** What `core.access.grant` takes: the row minus everything the door itself supplies. */
const request = (over: Record<string, unknown> = {}) => ({
  principal: { kind: "principal", id: "p-1" },
  node: CONTAINER,
  caps: ["containers:read"],
  effect: "deny",
  reach: "node",
  ...over,
});

describe("WHO a grant names", () => {
  test("all four forms parse, and a class row carrying an id does not", () => {
    /*
      The class forms are the reason grants are rows at all, so each one has to be spellable —
      and `{ kind: "any-human", id: "p-1" }` has to be REFUSED rather than read as the class it
      names. A loose object would accept that typo and silently widen a row meant for one
      person into a row for every human in the workspace, which is the largest mistake this
      shape can make and the cheapest one to make: an author copying the principal form and
      changing only the `kind`.
    */
    expect(GrantPrincipalSchema.safeParse({ kind: "principal", id: "p-1" }).success).toBe(true);
    expect(GrantPrincipalSchema.safeParse({ kind: "any-human" }).success).toBe(true);
    expect(GrantPrincipalSchema.safeParse({ kind: "any-agent" }).success).toBe(true);
    expect(
      GrantPrincipalSchema.safeParse({ kind: "instance", origin: "https://guest.example" }).success,
    ).toBe(true);

    expect(GrantPrincipalSchema.safeParse({ kind: "any-human", id: "p-1" }).success).toBe(false);
    expect(GrantPrincipalSchema.safeParse({ kind: "any-agent", id: "p-1" }).success).toBe(false);
  });

  test("a principal form needs a bounded id and an instance form a normalized origin", () => {
    expect(GrantPrincipalSchema.safeParse({ kind: "principal" }).success).toBe(false);
    expect(GrantPrincipalSchema.safeParse({ kind: "principal", id: "" }).success).toBe(false);
    expect(GrantPrincipalSchema.safeParse({ kind: "principal", id: "p".repeat(129) }).success).toBe(
      false,
    );
    /*
      The federation form's origin goes through the SAME normalizer the instance channel's
      mismatch check compares with (ADR 0014 §4). A row spelled `http://Guest.example:80/`
      would be a row no dialing guest could ever match, so it is refused at the write.
    */
    expect(
      GrantPrincipalSchema.safeParse({ kind: "instance", origin: "guest.example" }).success,
    ).toBe(false);
    expect(
      GrantPrincipalSchema.safeParse({ kind: "instance", origin: "https://Guest.example:443/" })
        .success,
    ).toBe(false);
    expect(GrantPrincipalSchema.safeParse({ kind: "everyone" }).success).toBe(false);
  });
});

describe("the durable row", () => {
  test("a row parses whole, and a row granting nothing is not a row", () => {
    expect(GrantSchema.safeParse(row()).success).toBe(true);
    expect(GrantSchema.safeParse(row({ caps: ["*"] })).success).toBe(true);
    /*
      `caps: []` is the one grant with no meaning — it neither allows nor denies anything — and
      an evaluator walking it would spend a row's worth of precedence on a set that cannot win
      or lose a capability contest. A door that accepted it would be storing a row an
      administrator can see in `listGrants` and never observe the effect of.
    */
    expect(GrantSchema.safeParse(row({ caps: [] })).success).toBe(false);
    expect(GrantSchema.safeParse(row({ caps: ["containers:teleport"] })).success).toBe(false);
  });

  test("the id has room for the width migration 13 derives", () => {
    /*
      `grant-token-<tokenId>` against a 128-bounded token id does not fit in 128, and the
      materialized rows ARE grants read by this schema on the way out of the table.
    */
    expect(GrantSchema.safeParse(row({ id: "g".repeat(MAX_GRANT_ID_LENGTH) })).success).toBe(true);
    expect(GrantSchema.safeParse(row({ id: "g".repeat(MAX_GRANT_ID_LENGTH + 1) })).success).toBe(
      false,
    );
    expect(GrantSchema.safeParse(row({ id: "" })).success).toBe(false);
  });

  test("WHERE reaches the row, at every depth the walk can address", () => {
    /*
      `GrantNodeSchema` itself is covered where the walk lives (`test/uri.test.ts`); what this
      asserts is that the row and the door WEAR it, so a node no evaluator could reach is
      refused before it is stored rather than after it fails to fire.
    */
    expect(GrantSchema.safeParse(row({ node: MANIFOLD_ROOT_URI })).success).toBe(true);
    expect(GrantSchema.safeParse(row({ node: ELEMENT })).success).toBe(true);
    expect(GrantSchema.safeParse(row({ node: "container/c-1" })).success).toBe(false);
    expect(GrantSchema.safeParse(row({ node: `${MANIFOLD_URI_SCHEME}nowhere/x` })).success).toBe(
      false,
    );
  });

  test("the stamp is an integer, and the row is exactly ADR 0011's eight fields", () => {
    expect(GrantSchema.safeParse(row({ createdAt: 1.5 })).success).toBe(false);
    expect(GrantSchema.safeParse(row({ createdAt: "1700000000000" })).success).toBe(false);
    expect(GrantSchema.safeParse(row({ createdBy: "" })).success).toBe(false);
    /*
      `bound` is the server's derived read (a token REFERENCES this row); it is a column, never a
      field of the wire row. Strict here is what keeps a stored record from leaking into the
      published shape one field at a time.
    */
    expect(GrantSchema.safeParse(row({ bound: true })).success).toBe(false);
    for (const field of [
      "id",
      "principal",
      "node",
      "caps",
      "effect",
      "reach",
      "createdBy",
      "createdAt",
    ]) {
      const partial: Record<string, unknown> = row();
      delete partial[field];
      expect(GrantSchema.safeParse(partial).success, field).toBe(false);
    }
  });
});

describe("what the three doors take", () => {
  test("effect and reach are decisions the caller MUST make, never defaults", () => {
    /*
      The precedence-sensitive pair, and the reason `CreateGrantRequestSchema` carries no zod
      default. Rule 3 makes `deny` beat `allow` at equal specificity and rule 1 makes reach
      decide which depths a row is even a candidate at, so a row that meant `deny` and got
      `allow` by omission — or `node` and got `subtree` — is a silent authority change wearing a
      successful write's clothes. Omission is refused loudly instead.
    */
    for (const field of ["effect", "reach"]) {
      const partial: Record<string, unknown> = request();
      delete partial[field];
      expect(CreateGrantRequestSchema.safeParse(partial).success, field).toBe(false);
    }
    for (const effect of GRANT_EFFECTS) {
      for (const reach of GRANT_REACHES) {
        expect(CreateGrantRequestSchema.safeParse(request({ effect, reach })).success).toBe(true);
      }
    }
    // Neither pair is coerced, cased loosely or padded: a closed set of two has no near misses.
    expect(CreateGrantRequestSchema.safeParse(request({ effect: "Deny" })).success).toBe(false);
    expect(CreateGrantRequestSchema.safeParse(request({ effect: "denied" })).success).toBe(false);
    expect(CreateGrantRequestSchema.safeParse(request({ effect: false })).success).toBe(false);
    expect(CreateGrantRequestSchema.safeParse(request({ reach: "subtree " })).success).toBe(false);
    expect(CreateGrantRequestSchema.safeParse(request({ reach: "tree" })).success).toBe(false);
  });

  test("the door mints the id and the attribution, so a caller cannot state them", () => {
    /*
      `createdBy` is WHO exercised authority and `id` is the handle `revokeGrant` names. A
      request that could carry either would let a caller forge the audit trail (A6) or collide
      with a row it does not own.
    */
    expect(CreateGrantRequestSchema.safeParse(request({ id: "g-1" })).success).toBe(false);
    expect(CreateGrantRequestSchema.safeParse(request({ createdBy: "p-owner" })).success).toBe(
      false,
    );
    expect(CreateGrantRequestSchema.safeParse(request({ createdAt: 1 })).success).toBe(false);
    expect(CreateGrantRequestSchema.safeParse(request({ node: "container/c-1" })).success).toBe(
      false,
    );
    expect(CreateGrantRequestSchema.safeParse(request({ caps: [] })).success).toBe(false);
  });

  test("revoke names a row by an id the row shape can actually carry", () => {
    /*
      Every id this accepts is an id `GrantSchema` produced, so the two bounds are ONE bound: a
      narrower argument would be a row that can be written and never withdrawn.
    */
    expect(RevokeGrantRequestSchema.safeParse({ grantId: "g-1" }).success).toBe(true);
    expect(
      RevokeGrantRequestSchema.safeParse({ grantId: "g".repeat(MAX_GRANT_ID_LENGTH) }).success,
    ).toBe(true);
    expect(
      RevokeGrantRequestSchema.safeParse({ grantId: "g".repeat(MAX_GRANT_ID_LENGTH + 1) }).success,
    ).toBe(false);
    expect(RevokeGrantRequestSchema.safeParse({ grantId: "" }).success).toBe(false);
    expect(RevokeGrantRequestSchema.safeParse({}).success).toBe(false);
    // Not a filtered revoke: one row per call, named, is the whole verb.
    expect(RevokeGrantRequestSchema.safeParse({ grantId: "g-1", node: CONTAINER }).success).toBe(
      false,
    );
  });

  test("a list request narrows a read and can never widen one", () => {
    expect(ListGrantsRequestSchema.safeParse({}).success).toBe(true);
    expect(ListGrantsRequestSchema.safeParse({ node: MANIFOLD_ROOT_URI }).success).toBe(true);
    expect(ListGrantsRequestSchema.safeParse({ principalId: "p-1" }).success).toBe(true);
    expect(ListGrantsRequestSchema.safeParse({ node: ELEMENT, principalId: "p-1" }).success).toBe(
      true,
    );
    /*
      An unknown filter key is refused rather than ignored, because an ignored filter answers a
      NARROWER question than the caller asked with a WIDER table than the caller expects — and
      an administrator reading "who reaches this node" off a full table draws a wrong conclusion
      from a successful call.
    */
    expect(ListGrantsRequestSchema.safeParse({ effect: "deny" }).success).toBe(false);
    expect(ListGrantsRequestSchema.safeParse({ principal: { kind: "any-human" } }).success).toBe(
      false,
    );
    expect(ListGrantsRequestSchema.safeParse({ node: "container/c-1" }).success).toBe(false);
    expect(ListGrantsRequestSchema.safeParse({ principalId: "" }).success).toBe(false);
  });

  test("the list answer is a table of rows and nothing else", () => {
    expect(GrantsSchema.safeParse({ grants: [] }).success).toBe(true);
    expect(GrantsSchema.safeParse({ grants: [row(), row({ id: "g-2" })] }).success).toBe(true);
    expect(GrantsSchema.safeParse({}).success).toBe(false);
    expect(GrantsSchema.safeParse({ grants: row() }).success).toBe(false);
    expect(GrantsSchema.safeParse({ grants: [row({ effect: "maybe" })] }).success).toBe(false);
    expect(GrantsSchema.safeParse({ grants: [], total: 0 }).success).toBe(false);
  });
});

describe("the published vocabulary", () => {
  test("GET /api/protocol publishes the authority shapes a stranger cannot guess", () => {
    /*
      A3: the three access doors publish their argument schemas through the live action roster,
      but the model those doors open is shared by all three and belongs to none of them. This is
      the block that carries it, and it is asserted key by key because a section that quietly
      loses a member is a stranger's agent guessing again.
    */
    const contract = buildProtocolJsonSchema()["grantContract"] as Record<string, unknown>;
    expect(Object.keys(contract).sort()).toEqual([
      "createRequest",
      "effects",
      "grant",
      "listRequest",
      "listResult",
      "maxIdLength",
      "maxNodeLength",
      "node",
      "nodeScheme",
      "principal",
      "reaches",
      "revokeRequest",
    ]);
    expect(contract).toEqual(grantVocabulary());
  });

  test("the published closed pairs ARE the sets the schemas enforce", () => {
    /*
      A closed set that lives only in prose drifts from the code enforcing it, so the two pairs
      are published from the arrays the enums are built from, and every published member is
      round-tripped through the door's own schema.
    */
    const contract = grantVocabulary();
    expect(contract["effects"]).toEqual([...GRANT_EFFECTS]);
    expect(contract["reaches"]).toEqual([...GRANT_REACHES]);
    for (const effect of contract["effects"] as string[]) {
      expect(CreateGrantRequestSchema.safeParse(request({ effect })).success, effect).toBe(true);
    }
    for (const reach of contract["reaches"] as string[]) {
      expect(CreateGrantRequestSchema.safeParse(request({ reach })).success, reach).toBe(true);
    }
  });

  test("the bounds and the scheme are published as data, because a JSON Schema cannot say them", () => {
    /*
      `z.toJSONSchema` carries the node's bounds and drops its refinement — the containment walk
      is not expressible as a string constraint — so a reader handed only the generated schema
      would learn `maxLength` and never learn that WHERE is a `manifold://` URI.
    */
    const contract = grantVocabulary();
    expect(contract["nodeScheme"]).toBe(MANIFOLD_URI_SCHEME);
    expect(contract["maxNodeLength"]).toBe(MAX_GRANT_NODE_LENGTH);
    expect(contract["maxIdLength"]).toBe(MAX_GRANT_ID_LENGTH);
    const node = contract["node"] as Record<string, unknown>;
    expect(node["type"]).toBe("string");
    expect(node["maxLength"]).toBe(MAX_GRANT_NODE_LENGTH);
    /*
      The row's shape is published, not merely its name: an agent reads the eight fields and the
      four principal forms off this document rather than off this source tree.
    */
    const grant = contract["grant"] as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(grant.properties).sort()).toEqual([
      "caps",
      "createdAt",
      "createdBy",
      "effect",
      "id",
      "node",
      "principal",
      "reach",
    ]);
    expect(grant.required.sort()).toEqual(Object.keys(grant.properties).sort());
    const principal = contract["principal"] as { oneOf: { properties: Record<string, unknown> }[] };
    expect(
      principal.oneOf.map((form) => (form.properties["kind"] as { const: string }).const).sort(),
    ).toEqual(["any-agent", "any-human", "instance", "principal"]);
  });
});
