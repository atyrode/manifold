import { describe, expect, test } from "bun:test";
import type { Principal, TokenGrant } from "@manifold/protocol";
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
  readonly kind: "create" | "mint" | "revoke";
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

/** A mechanism under the test's control: it either issues, or refuses with a code and words. */
function recorder(options: {
  create?: Answer<TokenGrant>;
  mint?: Answer<TokenGrant>;
  revoke?: Answer<number>;
}): Recorder {
  const calls: Call[] = [];
  const answer = <T>(given: Answer<T> | undefined, fallback: T): Answer<T> =>
    given ?? { ok: true, value: fallback };
  return {
    calls,
    ctx: {
      identity: {
        createPrincipal: (input) => {
          calls.push({ kind: "create", payload: input });
          return answer(options.create, grant);
        },
        mintToken: (input) => {
          calls.push({ kind: "mint", payload: input });
          return answer(options.mint, grant);
        },
        revokePrincipal: (principalId) => {
          calls.push({ kind: "revoke", payload: principalId });
          return answer(options.revoke, 0);
        },
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
      principal: { name: "sub agent", kind: "agent" as const },
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
    // mechanism's, and a request carries no secret to leak into one (invariant 6).
    expect(reason).toBe("cannot widen container scope");
    expect(reason).not.toContain(grant.token);
  });
});
