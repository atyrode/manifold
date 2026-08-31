import type {
  BootstrapPrincipalRequest,
  MintTokenRequest,
  RevokeResult,
  TokenGrant,
} from "@manifold/protocol";

/**
 * What the identity mechanism answers when it refuses: the same code the HTTP boundary maps
 * to a status, carried as DATA. A plugin cannot name the server's `ServiceError` class, and
 * should not — an expected refusal is an answer, not an exception, and the floor's binding
 * hands it over in that shape.
 */
type IdentityAnswer<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * The slice of the host this plugin touches, declared locally (D1): three calls on an
 * identity surface that is already bound to the caller. No store, no rooms, no broker, and
 * deliberately no `AuthService` — this plugin never sees a bearer secret it did not just
 * mint, never authenticates anybody, and cannot choose whose authority it acts with.
 * `composition.ts` checks this shape against the real `ActionCtx` by assignment.
 */
interface AccessCtx {
  readonly identity: {
    createPrincipal(input: BootstrapPrincipalRequest): IdentityAnswer<TokenGrant>;
    mintToken(input: MintTokenRequest): IdentityAnswer<TokenGrant>;
    revokePrincipal(principalId: string): IdentityAnswer<number>;
  };
}

/** Either the result the action publishes, or a refusal the door turns into a denial. */
type Outcome<T> = { refused: string } | T;

/**
 * These are the bodies of the three deleted routes, moved with their meaning intact.
 *
 * Every refusal the mechanism can produce is relayed VERBATIM — "root capability required",
 * "cannot mint capability terminal:write", "cannot widen pad scope", "principal not found",
 * "cannot revoke another principal". The wording was the route's 403/404 body and it is the
 * part a human reads, so it travels unchanged; what changed is the envelope, exactly as it
 * did when the terminal routes' 404 became a refusal (`terminal not found`).
 *
 * Nothing here logs, and nothing here formats a secret into a message. The raw token exists
 * in one place — the result handed to the caller who asked for it — and the dispatcher logs
 * an action's NAME, principal and outcome, never its arguments or its result (invariant 6).
 */
export const accessHandlers = {
  async createPrincipal(
    ctx: AccessCtx,
    args: BootstrapPrincipalRequest,
  ): Promise<Outcome<TokenGrant>> {
    const created = ctx.identity.createPrincipal(args);
    return created.ok ? created.value : { refused: created.message };
  },

  async mintToken(ctx: AccessCtx, args: MintTokenRequest): Promise<Outcome<TokenGrant>> {
    /*
      The whole attenuation ladder — a cap set no broader than the minter's, wildcard only
      for root, no widening of pad scope, no minting for a principal you did not create —
      runs inside the mechanism, on the REAL caller, because that is where ADR 0011's
      evaluator replaces it. This handler exists to relay, not to re-decide.
    */
    const minted = ctx.identity.mintToken(args);
    return minted.ok ? minted.value : { refused: minted.message };
  },

  async revokeToken(ctx: AccessCtx, args: { principalId: string }): Promise<Outcome<RevokeResult>> {
    const revoked = ctx.identity.revokePrincipal(args.principalId);
    // A count of zero is a SUCCESS: revocation is idempotent, and asking twice about a
    // principal whose tokens are already dead is precisely what a nervous administrator
    // does. The refusals above it are about entitlement, never about the outcome being nil.
    return revoked.ok ? { revoked: revoked.value } : { refused: revoked.message };
  },
};
