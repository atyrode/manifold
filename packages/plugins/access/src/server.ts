import type {
  BootstrapPrincipalRequest,
  CreateGrantRequest,
  Dial,
  DialShareRequest,
  DialTicket,
  Grant,
  Grants,
  ListGrantsRequest,
  MintShareRequest,
  MintTokenRequest,
  OpenDialRequest,
  PrincipalCredentials,
  RevokeGrantRequest,
  RevokeResult,
  RevokeShareRequest,
  Share,
  ShareGrant,
  ShareInventory,
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
 * identity ref that is already bound to the caller. No store, no rooms, no broker, and
 * deliberately no `AuthService` — this plugin never sees a bearer secret it did not just
 * mint, never authenticates anybody, and cannot choose whose authority it acts with.
 * `assembly.ts` checks this shape against the real `ActionCtx` by assignment.
 */
interface AccessCtx {
  readonly identity: {
    createPrincipal(input: BootstrapPrincipalRequest): IdentityAnswer<TokenGrant>;
    mintToken(input: MintTokenRequest): IdentityAnswer<TokenGrant>;
    revokePrincipal(principalId: string): IdentityAnswer<number>;
    /*
      The credential READ (ADR 0019 §3), on the identity door because a credential is what
      this door hands out: the list and the revoke it aims are the same concept read and
      written, and a `credentials` surface beside `identity` would say otherwise. The
      mechanism narrows the answer to what THIS caller could revoke, so the handler below has
      nothing to filter and deliberately does not try.
    */
    listCredentials(): IdentityAnswer<readonly PrincipalCredentials[]>;
    /*
      The share trio sits on the identity door because a share IS a token bound to a node: the
      attenuation ladder it runs is `mintToken`'s, and putting it anywhere else would be a
      second place authority is handed out (invariant 14).
    */
    mintShare(input: MintShareRequest): IdentityAnswer<ShareGrant>;
    revokeShare(shareId: string): IdentityAnswer<number>;
    listShares(): IdentityAnswer<readonly Share[]>;
    /*
      The grant trio sits here for the share trio's reason and one more: a grant is what a token
      REFERENCES (ADR 0011), so writing one and minting one are the same act at different
      granularities, and the attenuation the mechanism runs is the same ladder. A separate
      `grants` surface beside `identity` would say the workspace has two authorities.
    */
    grant(input: CreateGrantRequest): IdentityAnswer<Grant>;
    revokeGrant(grantId: string): IdentityAnswer<number>;
    listGrants(filter: ListGrantsRequest): IdentityAnswer<readonly Grant[]>;
  };
  /*
    The GUEST half is not the identity mechanism — it is a store plus an outbound network
    client — so it is its own surface. Nothing here mints authority: `dial` accepts a secret
    somebody else minted, and `open` asks the HOST for a ticket over the instance channel.
  */
  readonly dials: {
    dial(input: DialShareRequest): Promise<IdentityAnswer<Dial>>;
    open(dialId: string): Promise<IdentityAnswer<DialTicket>>;
    list(): IdentityAnswer<readonly Dial[]>;
  };
}

/** Either the result the action publishes, or a refusal the door turns into a denial. */
type Outcome<T> = { refused: string } | T;

/**
 * These are the bodies of the three deleted routes, moved with their meaning intact.
 *
 * Every refusal the mechanism can produce is relayed VERBATIM — "root capability required",
 * "cannot mint capability terminals:write", "cannot widen container scope", "principal not found",
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

  async mint(ctx: AccessCtx, args: MintTokenRequest): Promise<Outcome<TokenGrant>> {
    /*
      The whole attenuation ladder — a cap set no broader than the minter's, wildcard only
      for root, no widening of container scope, no minting for a principal you did not create —
      runs inside the mechanism, on the REAL caller, because that is where ADR 0011's
      evaluator replaces it. This handler exists to relay, not to re-decide.
    */
    const minted = ctx.identity.mintToken(args);
    return minted.ok ? minted.value : { refused: minted.message };
  },

  async revoke(ctx: AccessCtx, args: { principalId: string }): Promise<Outcome<RevokeResult>> {
    const revoked = ctx.identity.revokePrincipal(args.principalId);
    // A count of zero is a SUCCESS: revocation is idempotent, and asking twice about a
    // principal whose tokens are already dead is precisely what a nervous administrator
    // does. The refusals above it are about entitlement, never about the outcome being nil.
    return revoked.ok ? { revoked: revoked.value } : { refused: revoked.message };
  },

  /**
   * WHO HOLDS A CREDENTIAL HERE, and since when (ADR 0019 §3).
   *
   * The question "which browsers hold my key" had no answer at all before this door:
   * `GET /api/introspect` published principals to a root caller and nothing else did, so a
   * human could not look, and neither could an agent (A2). This is that question made
   * readable — and readable by whoever may act on it, not only by root, for the reasons the
   * mechanism records.
   *
   * No filtering here, and no widening either: the mechanism answers for the REAL caller and
   * this handler relays. A plugin that re-derived which principals it may see would be a
   * second authority check on one question, and the one that mattered would be the one
   * further from the store.
   */
  async listCredentials(
    ctx: AccessCtx,
    _args: Record<string, never>,
  ): Promise<Outcome<{ principals: readonly PrincipalCredentials[] }>> {
    const listed = ctx.identity.listCredentials();
    return listed.ok ? { principals: listed.value } : { refused: listed.message };
  },

  /*
    THE SHARE HALF (ADR 0014). Same discipline as the three above and for the same reason: the
    ladder lives in the mechanism, on the real caller, and these handlers relay. What they add
    is one rule each that is genuinely the DOOR's — the node form a share may name, and the
    fact that accepting a dial waits for the far side to say what it is.
  */
  async mintShare(ctx: AccessCtx, args: MintShareRequest): Promise<Outcome<ShareGrant>> {
    if (args.node.kind !== "container") {
      /*
        The one check that is this door's own. A share is a token bound to a node, and the
        degenerate grant a token can express today is a CONTAINER scope — so a share naming an
        element, a terminal or a principal would be a grant the mechanism beneath cannot
        express, and answering "minted" would be a lie about what was granted. ADR 0011 widens
        the field to subtree grants without reshaping the request, at which point this rung is
        the evaluator's rather than a refusal.
      */
      return { refused: "only a container can be shared" };
    }
    const minted = ctx.identity.mintShare(args);
    return minted.ok ? minted.value : { refused: minted.message };
  },

  async revokeShare(ctx: AccessCtx, args: RevokeShareRequest): Promise<Outcome<RevokeResult>> {
    // Zero severed tickets is a SUCCESS for `revoke`'s reason: a share nobody walked through
    // is exactly the one an owner revokes on a hunch, and the pipe is cut either way.
    const revoked = ctx.identity.revokeShare(args.shareId);
    return revoked.ok ? { revoked: revoked.value } : { refused: revoked.message };
  },

  async listShares(ctx: AccessCtx): Promise<Outcome<ShareInventory>> {
    /*
      One door, both directions. A refusal from either half refuses the whole answer rather
      than being folded into a half-populated record: "here are your dials, and something went
      wrong with your shares" is a shape a caller cannot act on, and a partially-true inventory
      of who holds authority over this workspace is worse than none.
    */
    const shares = ctx.identity.listShares();
    if (!shares.ok) return { refused: shares.message };
    const dials = ctx.dials.list();
    if (!dials.ok) return { refused: dials.message };
    return { shares: [...shares.value], dials: [...dials.value] };
  },

  async dialShare(ctx: AccessCtx, args: DialShareRequest): Promise<Outcome<Dial>> {
    // Blocks on the host's welcome by design (see the action's note): a row that named nothing
    // yet would be a zombie nobody can tell from a live share that happens to be offline.
    const dialed = await ctx.dials.dial(args);
    return dialed.ok ? dialed.value : { refused: dialed.message };
  },

  async openDial(ctx: AccessCtx, args: OpenDialRequest): Promise<Outcome<DialTicket>> {
    /*
      The guest's own authority question, answered before the host is asked anything: this
      instance decides whether this principal may use this dial, and only then does the
      instance channel request a ticket for it. The share secret never appears in the answer —
      what the caller receives is a per-principal token the HOST minted, which is what makes a
      remote viewer attributable and revocable one principal at a time.
    */
    const opened = await ctx.dials.open(args.dialId);
    return opened.ok ? opened.value : { refused: opened.message };
  },

  /*
    THE GRANT HALF (ADR 0011). Relay, like everything above it, and for the reason that matters
    most here: a handler that re-decided who may write a grant would be a SECOND evaluator, one
    rung above the only one — which is the failure ADR 0011 exists to prevent ("authority must
    not be re-derived per feature"). The mechanism owns the ladder: root, the node's shape, the
    subset rule, and the refusal that no deny row may name the workspace owner.
  */
  async grant(ctx: AccessCtx, args: CreateGrantRequest): Promise<Outcome<Grant>> {
    const written = ctx.identity.grant(args);
    return written.ok ? written.value : { refused: written.message };
  },

  async revokeGrant(ctx: AccessCtx, args: RevokeGrantRequest): Promise<Outcome<RevokeResult>> {
    // Zero is a SUCCESS, `revoke`'s ruling applied to a row instead of a token: revocation is
    // idempotent, and "that grant is already gone" is the answer a careful administrator wants,
    // not a refusal they have to distinguish from "you may not".
    const revoked = ctx.identity.revokeGrant(args.grantId);
    return revoked.ok ? { revoked: revoked.value } : { refused: revoked.message };
  },

  async listGrants(ctx: AccessCtx, args: ListGrantsRequest): Promise<Outcome<Grants>> {
    const grants = ctx.identity.listGrants(args);
    return grants.ok ? { grants: [...grants.value] } : { refused: grants.message };
  },
};
