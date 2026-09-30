import { describe, expect, test } from "bun:test";
import type {
  Grant,
  Principal,
  PrincipalCredentials,
  TokenGrant,
} from "@manifold/protocol";
import { accessHandlers } from "../src/server.ts";

/**
 * HANDING AUTHORITY OUT, and the discipline of relaying instead of deciding.
 *
 * These handlers own no rule. Every authority question — root for a bootstrap, a cap set no
 * broader than the minter's, no widening of container scope, revoking only what you minted — is
 * answered by the identity mechanism on the REAL caller, because that is the call ref ADR 0011's
 * waterfall replaces. So what is worth pinning here is exactly what the handlers DO own:
 * that a refusal from the mechanism arrives as a `refused` denial with its wording intact
 * rather than as a thrown 500, that a grant is passed through unaltered, and that a
 * revocation count of zero is a success rather than a refusal.
 *
 * The full ladder — caps, scope, disabled plugin, unknown action — is exercised against the
 * real door in `packages/server/test/access-door.test.ts`, which is the only place it can be
 * told the truth about a token.
 */

interface Call {
  readonly kind:
    | "create"
    | "mint"
    | "revoke"
    | "listCredentials"
    | "grant"
    | "revokeGrant"
    | "listGrants";
  readonly payload: unknown;
}

type Answer<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: string; readonly message: string };

interface Recorder {
  readonly ctx: Parameters<typeof accessHandlers.mint>[0];
  readonly calls: Call[];
}

const principal: Principal = { id: "p-1", kind: "human", name: "delegate", color: "#2563eb" };
const grant: TokenGrant = {
  token: "raw-secret",
  principal,
  caps: ["containers:read"],
  containerId: null,
};

/** One principal and its one live credential, as the credential list hands it back. */
const credentials: PrincipalCredentials = {
  principal,
  createdAt: 1_700_000_000_000,
  sessions: [
    {
      id: "token-1",
      createdAt: 1_700_000_000_000,
      caps: ["containers:read"],
      expiresAt: 1_700_000_000_000 + 14 * 24 * 60 * 60 * 1000,
    },
  ],
};


/**
 * One authority row, as the mechanism hands it back. Named for what it IS rather than `grant`,
 * which this file already spends on a `TokenGrant`: a token grant is a CREDENTIAL and this is a
 * ROW, and letting one identifier mean both in one file is how the two concepts get confused.
 */
const authorityRow: Grant = {
  id: "grant-1",
  principal: { kind: "principal", id: "p-1" },
  node: "manifold://container/container-7",
  caps: ["containers:write"],
  effect: "allow",
  reach: "subtree",
  createdBy: "p-0",
  createdAt: 1_700_000_000_000,
};

/** A mechanism under the test's control: it either issues, or refuses with a code and words. */
function recorder(options: {
  create?: Answer<TokenGrant>;
  mint?: Answer<TokenGrant>;
  revoke?: Answer<number>;
  listCredentials?: Answer<readonly PrincipalCredentials[]>;
  grant?: Answer<Grant>;
  revokeGrant?: Answer<number>;
  listGrants?: Answer<readonly Grant[]>;
}): Recorder {
  const calls: Call[] = [];
  const answer = <T>(given: Answer<T> | undefined, fallback: T): Answer<T> =>
    given ?? { ok: true, value: fallback };
  const unused = (): never => {
    throw new Error("unused access fixture");
  };
  return {
    calls,
    ctx: {
      identity: {
        createPrincipal: (input) => {
          calls.push({ kind: "create", payload: input });
          return answer(options.create, grant);
        },
        registerAgent: unused,
        listAgents: unused,
        getAgent: unused,
        updateAgent: unused,
        disableAgent: unused,
        enableAgent: unused,
        retireAgent: unused,
        createRun: unused,
        createChildRun: unused,
        listRuns: unused,
        inspectRun: unused,
        listHarnesses: unused,
        listHarnessSessions: unused,
        resolveHarnessSession: unused,
        launchRun: unused,
        sendRunInput: unused,
        reportRunActivity: unused,
        agentPolicyChallenge: unused,
        acknowledgeAgentPolicy: unused,
        renewAgentRun: unused,
        finishAgentRun: unused,
        reloadAgentPolicy: unused,
        mintToken: (input) => {
          calls.push({ kind: "mint", payload: input });
          return answer(options.mint, grant);
        },
        revokePrincipal: (principalId) => {
          calls.push({ kind: "revoke", payload: principalId });
          return answer(options.revoke, 0);
        },
        pausePrincipalAccess: unused,
        resumePrincipalAccess: unused,
        listCredentials: () => {
          calls.push({ kind: "listCredentials", payload: null });
          return answer(options.listCredentials, [credentials]);
        },
        mintShare: unused,
        revokeShare: unused,
        listShares: unused,
        listShareRecipients: unused,
        approveShareRecipient: unused,
        removeShareRecipient: unused,
        grant: (input) => {
          calls.push({ kind: "grant", payload: input });
          return answer(options.grant, authorityRow);
        },
        revokeGrant: (grantId) => {
          calls.push({ kind: "revokeGrant", payload: grantId });
          return answer(options.revokeGrant, 0);
        },
        listGrants: (filter) => {
          calls.push({ kind: "listGrants", payload: filter });
          return answer(options.listGrants, [authorityRow]);
        },
      },
      dials: {
        dial: unused,
        open: unused,
        list: unused,
      },
    },
  };
}

function refusal(outcome: unknown): string {
  if (outcome === null || typeof outcome !== "object" || !("refused" in outcome)) {
    throw new Error("expected a refusal");
  }
  const reason = Reflect.get(outcome, "refused");
  if (typeof reason !== "string") throw new Error("a refusal must carry a string");
  return reason;
}

describe("core.access handlers", () => {
  test("a grant is passed through exactly as the mechanism issued it", async () => {
    const host = recorder({});

    const created = await accessHandlers.createPrincipal(host.ctx, {
      name: "delegate",
      kind: "human",
    });
    const minted = await accessHandlers.mint(host.ctx, {
      principalId: principal.id,
      caps: ["containers:read"],
    });

    // Identity, not a copy: a door that rebuilt the grant could drop a field the caller needs
    // (or, worse, keep a stale one) and the result schema would still pass.
    expect(created).toBe(grant);
    expect(minted).toBe(grant);
    expect(host.calls.map((call) => call.kind)).toEqual(["create", "mint"]);
  });

  test("the caller's request reaches the mechanism unedited", async () => {
    const host = recorder({});
    const request = {
      principal: { name: "delegate", kind: "human" as const },
      caps: ["scenes:write" as const],
      containerId: "container-7",
    };

    await accessHandlers.mint(host.ctx, request);

    // No normalizing, no defaulting, no dropping of `containerId`: the mechanism decides what a
    // request means, and a door that pre-chewed it would be a second attenuation rule.
    expect(host.calls[0]?.payload).toBe(request);
  });

  test("a refusal keeps the mechanism's wording, so a 403 body becomes a denial message", async () => {
    const rootOnly = recorder({
      create: { ok: false, code: "forbidden", message: "root capability required" },
    });
    const tooWide = recorder({
      mint: { ok: false, code: "forbidden", message: "cannot mint capability terminals:write" },
    });
    const notMine = recorder({
      revoke: { ok: false, code: "forbidden", message: "cannot revoke another principal" },
    });

    expect(
      refusal(await accessHandlers.createPrincipal(rootOnly.ctx, { name: "x", kind: "human" })),
    ).toBe("root capability required");
    expect(
      refusal(
        await accessHandlers.mint(tooWide.ctx, {
          principalId: "p-2",
          caps: ["terminals:write"],
        }),
      ),
    ).toBe("cannot mint capability terminals:write");
    expect(refusal(await accessHandlers.revoke(notMine.ctx, { principalId: "p-3" }))).toBe(
      "cannot revoke another principal",
    );
  });

  test("a missing principal refuses rather than throwing, exactly as the route 404'd", async () => {
    const host = recorder({
      mint: { ok: false, code: "not_found", message: "principal not found" },
    });

    expect(
      refusal(await accessHandlers.mint(host.ctx, { principalId: "ghost", caps: ["*"] })),
    ).toBe("principal not found");
  });

  test("revocation answers a count, and zero is a success", async () => {
    const nothing = recorder({ revoke: { ok: true, value: 0 } });
    const three = recorder({ revoke: { ok: true, value: 3 } });

    // Idempotence is the point: asking twice about a principal whose tokens already died is
    // what somebody nervous about a leak does, and it must not read as a failure.
    expect(await nothing.ctx.identity.revokePrincipal("p-9")).toEqual({ ok: true, value: 0 });
    expect(await accessHandlers.revoke(nothing.ctx, { principalId: "p-9" })).toEqual({
      revoked: 0,
    });
    expect(await accessHandlers.revoke(three.ctx, { principalId: "p-9" })).toEqual({
      revoked: 3,
    });
  });

  test("no raw secret is ever formatted into a refusal", async () => {
    const host = recorder({
      mint: { ok: false, code: "forbidden", message: "cannot widen container scope" },
    });

    const reason = refusal(
      await accessHandlers.mint(host.ctx, { principalId: principal.id, caps: ["containers:read"] }),
    );

    // The handlers build no message of their own; the only string they can emit is the
    // mechanism's, and a request carries no secret to leak into one (docs/CONTRACTS.md §Data and credential boundaries).
    expect(reason).toBe("cannot widen container scope");
    expect(reason).not.toContain(grant.token);
  });
});


/**
 * THE GRANT DOORS (ADR 0011), on the same discipline and for a sharper reason than the rest.
 *
 * A handler that re-decided who may write a grant would be a SECOND evaluator sitting one rung
 * above the only one — which is the exact failure ADR 0011 exists to prevent ("authority must
 * not be re-derived per feature"). So the whole contract of these three is: pass the request
 * down untouched, pass the row back untouched, and turn the mechanism's refusal into a refusal
 * with its words intact. What they must NOT do is inspect an effect, a node or a principal.
 *
 * The ladder itself — root-only, workspace-graded, the schema, `cleanup: true` — is exercised
 * against the real door in `packages/server/test/access-door.test.ts`, and the waterfall those
 * rows drive is observed there through an unrelated door's dispatch.
 */
describe("core.access grant doors (ADR 0011)", () => {
  const request = {
    principal: { kind: "principal" as const, id: "p-1" },
    node: "manifold://container/container-7",
    caps: ["containers:write" as const],
    effect: "deny" as const,
    reach: "node" as const,
  };

  test("a row is written and returned exactly as asked and answered", async () => {
    const host = recorder({});

    const written = await accessHandlers.grant(host.ctx, request);

    // Untouched in both directions. A `deny` at `reach: "node"` is the request most tempting to
    // "helpfully" normalize — to a subtree, or to an allow with a narrower cap set — and every
    // one of those would be the door quietly deciding authority.
    expect(written).toBe(authorityRow);
    expect(host.calls).toEqual([{ kind: "grant", payload: request }]);
  });

  test("the mechanism's refusals arrive as refusals, with their wording intact", async () => {
    const undeniable = recorder({
      grant: { ok: false, code: "forbidden", message: "cannot deny the workspace owner" },
    });
    const credential = recorder({
      revokeGrant: {
        ok: false,
        code: "forbidden",
        message: "a token's own grant is revoked by revoking the token",
      },
    });

    /*
      Both rules are the MECHANISM's, and both are about a hole a door cannot see: whether this
      row would name the workspace owner, and whether this row is the one a live credential
      stands on. The handler relays the words, exactly as it relays `cannot mint capability …`.
    */
    expect(refusal(await accessHandlers.grant(undeniable.ctx, request))).toBe(
      "cannot deny the workspace owner",
    );
    expect(refusal(await accessHandlers.revokeGrant(credential.ctx, { grantId: "grant-1" }))).toBe(
      "a token's own grant is revoked by revoking the token",
    );
  });

  test("revoking answers a count, and zero is a success", async () => {
    const gone = recorder({ revokeGrant: { ok: true, value: 1 } });
    const already = recorder({});

    // `revoke`'s ruling applied to a row: asking twice about a grant that is already gone is
    // what a careful administrator does, and the honest answer is nil rather than a refusal.
    expect(await accessHandlers.revokeGrant(gone.ctx, { grantId: "grant-1" })).toEqual({
      revoked: 1,
    });
    expect(await accessHandlers.revokeGrant(already.ctx, { grantId: "grant-1" })).toEqual({
      revoked: 0,
    });
  });

  test("listing relays the filter down and wraps the rows in the published envelope", async () => {
    const host = recorder({});

    const listed = await accessHandlers.listGrants(host.ctx, { node: authorityRow.node });

    // The filter is the caller's, never the handler's: narrowing here would mean two answers to
    // "which rows reach this node", one of them invisible to whoever reads the mechanism.
    expect(listed).toEqual({ grants: [authorityRow] });
    expect(host.calls).toEqual([{ kind: "listGrants", payload: { node: authorityRow.node } }]);
  });
});
