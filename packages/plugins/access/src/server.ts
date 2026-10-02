import type {
  MintTokenV2Request,
  TokenGrantV2,
  RegisterAgentV2Request,
  RegisterAgentV2Result,
  GetAgentV2Result,
  ListAgentsV2Result,
  UpdateAgentV2Request,
  CreateRunV2Request,
  CreateChildRunV2Request,
  CreateRunV2Result,
  InspectRunV2Result,
  ListRunsV2Result,
  ReportRunActivityV2Result,
  AcknowledgeAgentPolicyV2Result,
  RenewAgentRunV2Result,
  FinishAgentRunV2Result,
  PrincipalCredentialsV2,
  AcknowledgeAgentPolicyRequest,
  AcknowledgeAgentPolicyResult,
  AgentPolicyChallenge,
  AgentRequest,
  ApproveShareRecipientRequest,
  BootstrapPrincipalRequest,
  CreateGrantRequest,
  CreateChildRunRequest,
  CreateRunRequest,
  CreateRunResult,
  Dial,
  DialShareRequest,
  DialTicket,
  Grant,
  Grants,
  ListGrantsRequest,
  FinishAgentRunRequest,
  FinishAgentRunResult,
  GetAgentResult,
  HarnessTarget,
  InspectRunRequest,
  InspectRunResult,
  LaunchRunRequest,
  LaunchRunResult,
  ListAgentsResult,
  ListHarnessesResult,
  ListHarnessSessionsRequest,
  ListHarnessSessionsResult,
  ListRunsRequest,
  ListRunsResult,
  ListShareRecipientsRequest,
  MintShareRequest,
  MintTokenRequest,
  OpenDialRequest,
  PrincipalCredentials,
  PrincipalAccessPauseRequest,
  PrincipalAccessPauseResult,
  RegisterAgentRequest,
  RegisterAgentResult,
  ReportRunActivityRequest,
  ReportRunActivityResult,
  ResolveHarnessSessionRequest,
  ResolveHarnessSessionResult,
  RevokeGrantRequest,
  RevokeResult,
  ReloadAgentPolicyResult,
  RenewAgentRunRequest,
  RenewAgentRunResult,
  RevokeShareRequest,
  RemoveShareRecipientRequest,
  SendRunInputRequest,
  SendRunInputResult,
  SessionRef,
  Share,
  ShareGrant,
  ShareInventory,
  ShareRecipient,
  TokenGrant,
  UpdateAgentRequest,
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
type AwaitableIdentity<T> = IdentityAnswer<T> | Promise<IdentityAnswer<T>>;

/**
 * The slice of the host this plugin touches, declared locally (D1): identity lifecycle calls
 * on a ref already bound to the caller. No store, rooms or broker, and deliberately no
 * `AuthService` — this plugin never sees a bearer secret it did not just mint, never
 * authenticates anybody, and cannot choose whose authority it acts with. `assembly.ts` checks
 * this shape against the real `ActionCtx` by assignment.
 */
interface AccessCtx {
  readonly identity: {
    createPrincipal(input: BootstrapPrincipalRequest): IdentityAnswer<TokenGrant>;
    mintToken(input: MintTokenRequest): IdentityAnswer<TokenGrant>;
    mintTokenV2(input: MintTokenV2Request): AwaitableIdentity<TokenGrantV2>;
    listCredentialsV2(): AwaitableIdentity<readonly PrincipalCredentialsV2[]>;
    registerAgentV2(input: RegisterAgentV2Request): Promise<IdentityAnswer<RegisterAgentV2Result>>;
    getAgentV2(input: AgentRequest): AwaitableIdentity<GetAgentV2Result>;
    listAgentsV2(): AwaitableIdentity<ListAgentsV2Result>;
    updateAgentV2(input: UpdateAgentV2Request): Promise<IdentityAnswer<GetAgentV2Result>>;
    disableAgentV2(input: AgentRequest): AwaitableIdentity<GetAgentV2Result>;
    enableAgentV2(input: AgentRequest): AwaitableIdentity<GetAgentV2Result>;
    retireAgentV2(input: AgentRequest): AwaitableIdentity<GetAgentV2Result>;
    createRunV2(input: CreateRunV2Request): AwaitableIdentity<CreateRunV2Result>;
    createChildRunV2(input: CreateChildRunV2Request): AwaitableIdentity<CreateRunV2Result>;
    inspectRunV2(input: InspectRunRequest): AwaitableIdentity<InspectRunV2Result>;
    listRunsV2(input: ListRunsRequest): AwaitableIdentity<ListRunsV2Result>;
    reportRunActivityV2(
      input: ReportRunActivityRequest,
    ): AwaitableIdentity<ReportRunActivityV2Result>;
    acknowledgeAgentPolicyV2(
      input: AcknowledgeAgentPolicyRequest,
    ): AwaitableIdentity<AcknowledgeAgentPolicyV2Result>;
    renewAgentRunV2(input: RenewAgentRunRequest): AwaitableIdentity<RenewAgentRunV2Result>;
    finishAgentRunV2(input: FinishAgentRunRequest): AwaitableIdentity<FinishAgentRunV2Result>;
    registerAgent(input: RegisterAgentRequest): Promise<IdentityAnswer<RegisterAgentResult>>;
    listAgents(): IdentityAnswer<ListAgentsResult>;
    getAgent(input: AgentRequest): IdentityAnswer<GetAgentResult>;
    updateAgent(input: UpdateAgentRequest): Promise<IdentityAnswer<GetAgentResult>>;
    disableAgent(input: AgentRequest): IdentityAnswer<GetAgentResult>;
    enableAgent(input: AgentRequest): IdentityAnswer<GetAgentResult>;
    retireAgent(input: AgentRequest): IdentityAnswer<GetAgentResult>;
    createRun(input: CreateRunRequest): IdentityAnswer<CreateRunResult>;
    createChildRun(input: CreateChildRunRequest): IdentityAnswer<CreateRunResult>;
    launchRun(input: LaunchRunRequest): Promise<IdentityAnswer<LaunchRunResult>>;
    listHarnesses(): IdentityAnswer<ListHarnessesResult>;
    listHarnessSessions(
      harness: string,
      target: HarnessTarget,
    ): Promise<IdentityAnswer<ListHarnessSessionsResult>>;
    resolveHarnessSession(
      session: SessionRef,
    ): Promise<IdentityAnswer<ResolveHarnessSessionResult>>;
    sendRunInput(input: SendRunInputRequest): Promise<IdentityAnswer<SendRunInputResult>>;
    reportRunActivity(input: ReportRunActivityRequest): IdentityAnswer<ReportRunActivityResult>;
    inspectRun(input: InspectRunRequest): IdentityAnswer<InspectRunResult>;
    listRuns(input: ListRunsRequest): IdentityAnswer<ListRunsResult>;
    agentPolicyChallenge(): IdentityAnswer<AgentPolicyChallenge>;
    acknowledgeAgentPolicy(
      input: AcknowledgeAgentPolicyRequest,
    ): IdentityAnswer<AcknowledgeAgentPolicyResult>;
    renewAgentRun(input: RenewAgentRunRequest): IdentityAnswer<RenewAgentRunResult>;
    finishAgentRun(input: FinishAgentRunRequest): IdentityAnswer<FinishAgentRunResult>;
    reloadAgentPolicy(): IdentityAnswer<ReloadAgentPolicyResult>;
    revokePrincipal(principalId: string): IdentityAnswer<number>;
    pausePrincipalAccess(
      input: PrincipalAccessPauseRequest,
    ): IdentityAnswer<PrincipalAccessPauseResult>;
    resumePrincipalAccess(
      input: PrincipalAccessPauseRequest,
    ): IdentityAnswer<PrincipalAccessPauseResult>;
    /*
      The credential READ (ADR 0019 §3), on the identity door because a credential is what
      this door hands out: the list and the withdrawal it aims are the same concept read and
      written, and a `credentials` surface beside `identity` would say otherwise. Ordinary rows
      are limited to live own issuance, with explicit root and self exceptions. Registered Agent
      inventories match their full credential/Run cutoff. Native services remain inspection-only.
      Run-chain readers use listRuns instead; they never inherit this credential-reference inventory.
    */
    listCredentials(): IdentityAnswer<readonly PrincipalCredentials[]>;
    /*
      Share delegation and recipient approval sit on the identity door because a share is a
      token bound to a node; their attenuation is `mintToken`'s, and putting them elsewhere is a
      second place authority is handed out (docs/CONTRACTS.md §One authoritative implementation).
    */
    mintShare(input: MintShareRequest): IdentityAnswer<ShareGrant>;
    revokeShare(shareId: string): IdentityAnswer<number>;
    listShares(): IdentityAnswer<readonly Share[]>;
    listShareRecipients(shareId: string): IdentityAnswer<readonly ShareRecipient[]>;
    approveShareRecipient(input: ApproveShareRecipientRequest): IdentityAnswer<ShareRecipient>;
    removeShareRecipient(input: RemoveShareRecipientRequest): IdentityAnswer<ShareRecipient>;
    /*
      The grant trio sits here for the same reason and one more: a grant is what a token
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
    open(input: OpenDialRequest): Promise<IdentityAnswer<DialTicket>>;
    list(): IdentityAnswer<readonly Dial[]>;
  };
}

/** Either the result the action publishes, or a refusal the door turns into a denial. */
type Outcome<T> = { refused: string } | T;

/**
 * These are thin action bodies over the identity mechanism.
 *
 * Expected refusals retain the identity mechanism's message, including named Agent admission
 * identifiers, under the dispatcher's generic refused rung. Authorization is never re-derived
 * here. Secrets are returned only when the bound identity door permits them; browser-created
 * Runs carry no credential. Context, profile, inspector requests and harness input use opaque
 * action traces, and these handlers never log arguments or results.
 */
export const accessHandlers = {
  async mintTokenV2(ctx: AccessCtx, args: MintTokenV2Request): Promise<Outcome<TokenGrantV2>> {
    const result = await ctx.identity.mintTokenV2(args);
    return result.ok ? result.value : { refused: result.message };
  },
  async listCredentialsV2(
    ctx: AccessCtx,
    _args: Record<string, never>,
  ): Promise<Outcome<{ principals: readonly PrincipalCredentialsV2[] }>> {
    const result = await ctx.identity.listCredentialsV2();
    return result.ok ? { principals: result.value } : { refused: result.message };
  },
  async registerAgentV2(
    ctx: AccessCtx,
    args: RegisterAgentV2Request,
  ): Promise<Outcome<RegisterAgentV2Result>> {
    const result = await ctx.identity.registerAgentV2(args);
    return result.ok ? result.value : { refused: result.message };
  },
  async getAgentV2(ctx: AccessCtx, args: AgentRequest): Promise<Outcome<GetAgentV2Result>> {
    const result = await ctx.identity.getAgentV2(args);
    return result.ok ? result.value : { refused: result.message };
  },
  async listAgentsV2(
    ctx: AccessCtx,
    _args: Record<string, never>,
  ): Promise<Outcome<ListAgentsV2Result>> {
    const result = await ctx.identity.listAgentsV2();
    return result.ok ? result.value : { refused: result.message };
  },
  async updateAgentV2(
    ctx: AccessCtx,
    args: UpdateAgentV2Request,
  ): Promise<Outcome<GetAgentV2Result>> {
    const result = await ctx.identity.updateAgentV2(args);
    return result.ok ? result.value : { refused: result.message };
  },
  async disableAgentV2(ctx: AccessCtx, args: AgentRequest): Promise<Outcome<GetAgentV2Result>> {
    const result = await ctx.identity.disableAgentV2(args);
    return result.ok ? result.value : { refused: result.message };
  },
  async enableAgentV2(ctx: AccessCtx, args: AgentRequest): Promise<Outcome<GetAgentV2Result>> {
    const result = await ctx.identity.enableAgentV2(args);
    return result.ok ? result.value : { refused: result.message };
  },
  async retireAgentV2(ctx: AccessCtx, args: AgentRequest): Promise<Outcome<GetAgentV2Result>> {
    const result = await ctx.identity.retireAgentV2(args);
    return result.ok ? result.value : { refused: result.message };
  },
  async createRunV2(ctx: AccessCtx, args: CreateRunV2Request): Promise<Outcome<CreateRunV2Result>> {
    const result = await ctx.identity.createRunV2(args);
    return result.ok ? result.value : { refused: result.message };
  },
  async createChildRunV2(
    ctx: AccessCtx,
    args: CreateChildRunV2Request,
  ): Promise<Outcome<CreateRunV2Result>> {
    const result = await ctx.identity.createChildRunV2(args);
    return result.ok ? result.value : { refused: result.message };
  },
  async inspectRunV2(
    ctx: AccessCtx,
    args: InspectRunRequest,
  ): Promise<Outcome<InspectRunV2Result>> {
    const result = await ctx.identity.inspectRunV2(args);
    return result.ok ? result.value : { refused: result.message };
  },
  async listRunsV2(ctx: AccessCtx, args: ListRunsRequest): Promise<Outcome<ListRunsV2Result>> {
    const result = await ctx.identity.listRunsV2(args);
    return result.ok ? result.value : { refused: result.message };
  },
  async reportRunActivityV2(
    ctx: AccessCtx,
    args: ReportRunActivityRequest,
  ): Promise<Outcome<ReportRunActivityV2Result>> {
    const result = await ctx.identity.reportRunActivityV2(args);
    return result.ok ? result.value : { refused: result.message };
  },
  async acknowledgeAgentPolicyV2(
    ctx: AccessCtx,
    args: AcknowledgeAgentPolicyRequest,
  ): Promise<Outcome<AcknowledgeAgentPolicyV2Result>> {
    const result = await ctx.identity.acknowledgeAgentPolicyV2(args);
    return result.ok ? result.value : { refused: result.message };
  },
  async renewAgentRunV2(
    ctx: AccessCtx,
    args: RenewAgentRunRequest,
  ): Promise<Outcome<RenewAgentRunV2Result>> {
    const result = await ctx.identity.renewAgentRunV2(args);
    return result.ok ? result.value : { refused: result.message };
  },
  async finishAgentRunV2(
    ctx: AccessCtx,
    args: FinishAgentRunRequest,
  ): Promise<Outcome<FinishAgentRunV2Result>> {
    const result = await ctx.identity.finishAgentRunV2(args);
    return result.ok ? result.value : { refused: result.message };
  },
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
      for root, no widening of container scope, and a live actor-issued credential before
      reminting for another existing principal — runs inside the mechanism, on the REAL caller,
      because that is where ADR 0011's evaluator replaces it. Historical issuance is not
      principal ownership. This handler exists to relay, not to re-decide.
    */
    const minted = ctx.identity.mintToken(args);
    return minted.ok ? minted.value : { refused: minted.message };
  },

  async registerAgent(
    ctx: AccessCtx,
    args: RegisterAgentRequest,
  ): Promise<Outcome<RegisterAgentResult>> {
    const registered = await ctx.identity.registerAgent(args);
    return registered.ok ? registered.value : { refused: registered.message };
  },

  async listAgents(
    ctx: AccessCtx,
    _args: Record<string, never>,
  ): Promise<Outcome<ListAgentsResult>> {
    const listed = ctx.identity.listAgents();
    return listed.ok ? listed.value : { refused: listed.message };
  },

  async getAgent(ctx: AccessCtx, args: AgentRequest): Promise<Outcome<GetAgentResult>> {
    const agent = ctx.identity.getAgent(args);
    return agent.ok ? agent.value : { refused: agent.message };
  },

  async updateAgent(ctx: AccessCtx, args: UpdateAgentRequest): Promise<Outcome<GetAgentResult>> {
    const updated = await ctx.identity.updateAgent(args);
    return updated.ok ? updated.value : { refused: updated.message };
  },

  async disableAgent(ctx: AccessCtx, args: AgentRequest): Promise<Outcome<GetAgentResult>> {
    const disabled = ctx.identity.disableAgent(args);
    return disabled.ok ? disabled.value : { refused: disabled.message };
  },

  async enableAgent(ctx: AccessCtx, args: AgentRequest): Promise<Outcome<GetAgentResult>> {
    const enabled = ctx.identity.enableAgent(args);
    return enabled.ok ? enabled.value : { refused: enabled.message };
  },

  async retireAgent(ctx: AccessCtx, args: AgentRequest): Promise<Outcome<GetAgentResult>> {
    const retired = ctx.identity.retireAgent(args);
    return retired.ok ? retired.value : { refused: retired.message };
  },

  async createRun(ctx: AccessCtx, args: CreateRunRequest): Promise<Outcome<CreateRunResult>> {
    const created = ctx.identity.createRun(args);
    return created.ok ? created.value : { refused: created.message };
  },

  async createChildRun(
    ctx: AccessCtx,
    args: CreateChildRunRequest,
  ): Promise<Outcome<CreateRunResult>> {
    const created = ctx.identity.createChildRun(args);
    return created.ok ? created.value : { refused: created.message };
  },

  async launchRun(ctx: AccessCtx, args: LaunchRunRequest): Promise<Outcome<LaunchRunResult>> {
    const launched = await ctx.identity.launchRun(args);
    return launched.ok ? launched.value : { refused: launched.message };
  },

  async listHarnesses(
    ctx: AccessCtx,
    _args: Record<string, never>,
  ): Promise<Outcome<ListHarnessesResult>> {
    const listed = ctx.identity.listHarnesses();
    return listed.ok ? listed.value : { refused: listed.message };
  },

  async listHarnessSessions(
    ctx: AccessCtx,
    args: ListHarnessSessionsRequest,
  ): Promise<Outcome<ListHarnessSessionsResult>> {
    const listed = await ctx.identity.listHarnessSessions(args.harness, args.target);
    return listed.ok ? listed.value : { refused: listed.message };
  },

  async resolveHarnessSession(
    ctx: AccessCtx,
    args: ResolveHarnessSessionRequest,
  ): Promise<Outcome<ResolveHarnessSessionResult>> {
    const resolved = await ctx.identity.resolveHarnessSession(args.session);
    return resolved.ok ? resolved.value : { refused: resolved.message };
  },

  async sendRunInput(
    ctx: AccessCtx,
    args: SendRunInputRequest,
  ): Promise<Outcome<SendRunInputResult>> {
    const sent = await ctx.identity.sendRunInput(args);
    return sent.ok ? sent.value : { refused: sent.message };
  },

  async reportRunActivity(
    ctx: AccessCtx,
    args: ReportRunActivityRequest,
  ): Promise<Outcome<ReportRunActivityResult>> {
    const reported = ctx.identity.reportRunActivity(args);
    return reported.ok ? reported.value : { refused: reported.message };
  },

  async inspectRun(ctx: AccessCtx, args: InspectRunRequest): Promise<Outcome<InspectRunResult>> {
    const inspected = ctx.identity.inspectRun(args);
    return inspected.ok ? inspected.value : { refused: inspected.message };
  },

  async listRuns(ctx: AccessCtx, args: ListRunsRequest): Promise<Outcome<ListRunsResult>> {
    const inventory = ctx.identity.listRuns(args);
    return inventory.ok ? inventory.value : { refused: inventory.message };
  },

  async getAgentPolicy(
    ctx: AccessCtx,
    _args: Record<string, never>,
  ): Promise<Outcome<AgentPolicyChallenge>> {
    const policy = ctx.identity.agentPolicyChallenge();
    return policy.ok ? policy.value : { refused: policy.message };
  },

  async acknowledgeAgentPolicy(
    ctx: AccessCtx,
    args: AcknowledgeAgentPolicyRequest,
  ): Promise<Outcome<AcknowledgeAgentPolicyResult>> {
    const acknowledged = ctx.identity.acknowledgeAgentPolicy(args);
    return acknowledged.ok ? acknowledged.value : { refused: acknowledged.message };
  },

  async renewAgentRun(
    ctx: AccessCtx,
    args: RenewAgentRunRequest,
  ): Promise<Outcome<RenewAgentRunResult>> {
    const renewed = ctx.identity.renewAgentRun(args);
    return renewed.ok ? renewed.value : { refused: renewed.message };
  },

  async finishAgentRun(
    ctx: AccessCtx,
    args: FinishAgentRunRequest,
  ): Promise<Outcome<FinishAgentRunResult>> {
    const finished = ctx.identity.finishAgentRun(args);
    return finished.ok ? finished.value : { refused: finished.message };
  },

  async reloadAgentPolicy(
    ctx: AccessCtx,
    _args: Record<string, never>,
  ): Promise<Outcome<ReloadAgentPolicyResult>> {
    const reloaded = ctx.identity.reloadAgentPolicy();
    return reloaded.ok ? reloaded.value : { refused: reloaded.message };
  },

  async revoke(ctx: AccessCtx, args: { principalId: string }): Promise<Outcome<RevokeResult>> {
    const revoked = ctx.identity.revokePrincipal(args.principalId);
    // A count of zero is a SUCCESS: withdrawal is idempotent, and asking twice after the
    // caller's manageable credentials are already dead is precisely what a nervous
    // administrator does. The refusals above it are about entitlement, never about a nil result.
    return revoked.ok ? { revoked: revoked.value } : { refused: revoked.message };
  },
  async pause(
    ctx: AccessCtx,
    args: PrincipalAccessPauseRequest,
  ): Promise<Outcome<PrincipalAccessPauseResult>> {
    const paused = ctx.identity.pausePrincipalAccess(args);
    return paused.ok ? paused.value : { refused: paused.message };
  },

  async resume(
    ctx: AccessCtx,
    args: PrincipalAccessPauseRequest,
  ): Promise<Outcome<PrincipalAccessPauseResult>> {
    const resumed = ctx.identity.resumePrincipalAccess(args);
    return resumed.ok ? resumed.value : { refused: resumed.message };
  },

  /**
   * THE LIVE CREDENTIAL INVENTORY AUTHORIZED FOR THIS CALLER, and since when (ADR 0019 §3).
   *
   * The question "which browsers hold my key" had no answer at all before this door:
   * `GET /api/introspect` published principals to a root caller and nothing else did, so a
   * human could not look, and neither could an agent (A2). Root still receives the complete
   * live inventory. A non-root receives explicit self credentials plus live own issuance for
   * other ordinary principals; legacy null provenance does not become delegated property.
   * Registered Agent inventories match their full credential/Run cutoff. Native service rows
   * remain inspection-only and follow their separate lifecycle.
   *
   * No filtering here, and no widening either: the mechanism answers for the REAL caller and
   * this handler relays. A plugin that re-derived which credentials it may see would be a
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
  async listShareRecipients(
    ctx: AccessCtx,
    args: ListShareRecipientsRequest,
  ): Promise<Outcome<readonly ShareRecipient[]>> {
    const recipients = ctx.identity.listShareRecipients(args.shareId);
    return recipients.ok ? recipients.value : { refused: recipients.message };
  },

  async approveShareRecipient(
    ctx: AccessCtx,
    args: ApproveShareRecipientRequest,
  ): Promise<Outcome<ShareRecipient>> {
    const approved = ctx.identity.approveShareRecipient(args);
    return approved.ok ? approved.value : { refused: approved.message };
  },

  async removeShareRecipient(
    ctx: AccessCtx,
    args: RemoveShareRecipientRequest,
  ): Promise<Outcome<ShareRecipient>> {
    const removed = ctx.identity.removeShareRecipient(args);
    return removed.ok ? removed.value : { refused: removed.message };
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
    const opened = await ctx.dials.open(args);
    return opened.ok ? opened.value : { refused: opened.message };
  },

  /*
    THE GRANT HALF (ADR 0011). Relay, like everything above it, and for the reason that matters
    most here: a handler that re-decided who may write or administer a grant would be a SECOND
    evaluator, one rung above the only one — which is the failure ADR 0011 exists to prevent
    ("authority must not be re-derived per feature"). Public grant actions remain root-only.
    At the service seam the mechanism still restricts any non-root list/revoke caller to
    `createdBy` provenance, while owning the node shape, subset rule, token-bound-grant
    protection, and refusal that no deny row may name the workspace owner.
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
