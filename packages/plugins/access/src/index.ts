import { defineAction } from "@manifold/plugin";
import {
  BootstrapPrincipalRequestSchema,
  CreateGrantRequestSchema,
  CredentialsResponseSchema,
  DialSchema,
  DialShareRequestSchema,
  DialTicketSchema,
  GrantSchema,
  GrantsSchema,
  ListGrantsRequestSchema,
  MintShareRequestSchema,
  MintTokenRequestSchema,
  OpenDialRequestSchema,
  RevokeGrantRequestSchema,
  RevokeRequestSchema,
  RevokeResultSchema,
  RevokeShareRequestSchema,
  ShareGrantSchema,
  ShareInventorySchema,
  TokenGrantSchema,
  type PluginManifest,
} from "@manifold/protocol";
import { z } from "zod";

/**
 * Access administration, as a plugin: the three verbs that hand authority out and take it
 * back. They were `POST /api/principals`, `POST /api/tokens` and `POST /api/tokens/revoke`.
 *
 * The MECHANISM stays floor and is untouched — hashing, timing-safe comparison, bearer
 * authentication, attenuation, the revocation fence that closes live sockets. What moved is
 * the DOOR: who may ask, with what arguments, and what the answer looks like. A plugin here
 * cannot mint "as" somebody else, because the identity ref it is handed is pre-bound to
 * the calling principal (`ctx.identity`), and it cannot see a raw secret except the one it
 * is handing to the caller who just asked for it.
 *
 * ESSENTIAL (issue #113), and this manifest used to say the opposite, so the correction is
 * recorded rather than quietly swapped. The old reading was: the owner key authenticates
 * OUTSIDE the token system (`AuthService.authenticate` compares it before any token lookup),
 * so disabling this plugin can never lock the owner out — therefore ordinary. That answers
 * LOCKOUT, which was never the criterion. The criterion is whether the workspace can be
 * DRAWN, and `createPrincipal` is the only door that turns a credential into an identity: off,
 * the identity gate has nothing to knock on, so no browser that is not already holding a token
 * can enter this workspace at all — first-run onboarding and every new device with it. The
 * floor's boot path names this door (`packages/web/src/api.ts`), and the floor may only lean
 * on a seat the engine guarantees is there.
 *
 * What survives from the old reading is the RECOVERY story, and it is load-bearing here in a
 * way it is not for the other essential seats: the floor's recovery gate mounts inside the
 * identity gate, so an assembly that arrives with this seat off out of band cannot offer the
 * one-click restore to a device with no token. The owner key is the way back — it dispatches
 * `engine.plugins.setEnabled` as root without a principal — which is why the same fact that
 * used to argue for `ordinary` is the reason the refusal is safe.
 *
 * ADR 0011 LANDED beneath this door. Flat caps plus a container scope are grant rows on the node
 * tree now, and a token references the grant it was minted from. The vocabulary a caller sees —
 * `core.access.mint` with a cap set and an optional scope — did not move, which is the whole
 * point of having published the door before the evaluator changed: the swap happened under an
 * interface that had already promised its shape. What the ADR added ABOVE the door is the grant
 * administration trio below, which it named as this plugin's work and left otherwise unspecified.
 *
 * CONTRIBUTES ONE SECTION as of ADR 0019 §3 — `sessions`, the credential list. This plugin
 * shipped door-only for two waves on the stated grounds that "administration screens are a
 * later plugin"; the credential list is the first of them, and it lands here rather than in
 * a new god panel because the concept is this plugin's: principals and the credentials they
 * hold are what `core.access` mints and revokes. The FLEET's half of the same question —
 * which machines are enrolled, and withdrawing one — stays in `core.machines`'s existing
 * Machines section, for the same reason inverted (ADR 0019 §3: "rendered by the plugin that
 * owns each concept"). Two sections, two concepts, no panel that knows about both.
 *
 * The `admin UI: deferred, door-only` marker is therefore GONE from the description below,
 * deleted in the commit that discharges it. The share and grant markers stay: those screens
 * are still owed, and a marker that outlived its deferral is the lie the convention exists
 * to prevent — as is one deleted before its deferral ended.
 *
 * IN-PRODUCT DEFERRAL MARKER — the convention this manifest introduces, and it applies
 * wherever a plugin ships a door without the screen that drives it. A deferral a principal
 * can OBSERVE belongs in the manifest `description`, which is published data (`GET
 * /api/plugins`, and the roster row a client paints from it), not only in a source comment:
 * AXIOMS.md §Change control requires a deferral to be visible in-product, because one
 * discoverable solely by a reader of the tree is indistinguishable from a bug. The marker is
 * the description's last clause and reads `<capability>: deferred, <what remains reachable>`
 * — here `admin UI: deferred, door-only` — so one clause carries both what is missing and
 * the fact that everything else still works, which a bare "no UI yet" would not. It is
 * DELETED in the same commit as the UI that discharges it; a marker outliving its deferral
 * is a lie the roster tells every principal who reads it.
 *
 * Declared no read action until ADR 0011, because there was no access read to move: nothing
 * published principals or tokens except `GET /api/introspect`, the engine's own root-only
 * introspection door. `listGrants` is not a conversion of that — a grant row has no other door
 * onto it in the tree, so the only way to see what decides every other answer is the one this
 * plugin publishes.
 */
export const accessManifest: PluginManifest = {
  id: "core.access",
  version: "1.3.0",
  title: "Access",
  description:
    "Creates principals, mints delegated tokens, grants and denies capabilities at any node, shares nodes with other instances, revokes them, and lists who holds a live credential — share UI: deferred, door-only; grant UI: deferred, door-only",
  /*
    `*` is here because `createPrincipal` demands root and a manifest is a readable ceiling
    on a plugin's authority: a reader must be able to see, without opening the code, that
    one of these doors is root-only. The share doors add no capability — a share IS a token
    bound to a node (A5), so the cap that already means "hands authority out" is the one they
    declare, and `containers:read`/`containers:write` are what accepting and using a foreign
    node costs on the guest side. The grant doors add none either, and the ceiling is
    UNCHANGED by ADR 0011 for a reason worth stating: a manifest bounds what a plugin's actions
    may DECLARE, and the waterfall changed the other side of the intersection — what the CALLER
    is evaluated to hold. A ceiling that had to grow because authority became node-relative
    would have meant the two were never orthogonal.
  */
  capabilities: ["*", "tokens:mint", "containers:read", "containers:write"],
  essential: true,
  contributes: {
    panels: [],
    /*
      THE CREDENTIAL LIST'S HOME (ADR 0019 §3). `order: 30` puts it after Machines (20),
      which is the order the two answers belong in: the fleet is what an operator looks at
      daily, and who holds a credential is what they look at when something is wrong.

      Named `sessions` rather than `credentials` or `access` because a section id is what a
      HUMAN sees in the rail, and "which browsers hold my key" is a question about sessions.
      The word carries no second meaning here: a session in this product is a client
      connection, and a live credential is precisely what makes one possible.
    */
    sections: [{ id: "sessions", title: "Sessions", order: 30 }],
    elements: [],
    tools: [],
    /*
      THE DIAL'S NEWS (ADR 0012 §1, ADR 0014 §1). A dial has no `manifold://` form of its own,
      so all three are addressed to this plugin's node — the node whose doors create and
      destroy the relationship — and WHICH dial moved is the payload.

      All three are emitted by the FLOOR, and that is the same ruling `machine_online` already
      makes: a long-lived outbound socket coming up or going down is not the commit point of
      any action, so only the socket registry can know it. The engine emits; the plugin
      declares. `dial_revoked` is the one a guest's UI acts on hardest — it is the moment a
      projection stopped being legal, arriving without anybody at this instance doing anything.
     */
    events: [
      { id: "dial_online", title: "Dial live" },
      { id: "dial_offline", title: "Dial offline" },
      { id: "dial_revoked", title: "Dial revoked by its host" },
    ],
  },
};

/**
 * The two door names this plugin's own section dispatches, built from the manifest id rather
 * than spelled: a full action name is the pair `${manifest.id}.${local}`, so the chrome that
 * calls one and the `data-action` attribute that names it in the DOM (invariant 12) cannot
 * drift from the declaration below. `core.keys` set this precedent.
 */
export const ACCESS_LIST_CREDENTIALS_ACTION = `${accessManifest.id}.listCredentials`;
export const ACCESS_REVOKE_ACTION = `${accessManifest.id}.revoke`;

/**
 * Authority mirrors the deleted routes exactly, rung for rung.
 *
 * - `createPrincipal` was `requireRoot`, so its declared cap is `*` — the door's own
 *   `forbidden` rung answers a non-root caller, rather than the handler relaying a prose
 *   refusal from the mechanism for a question the ladder can ask first.
 * - `mint` and `revoke` demanded `tokens:mint`, which the mechanism checked
 *   itself; declaring it moves that check to the rung where every other cap is checked, and
 *   the mechanism's own check stays as the belt to the door's braces.
 *
 * Both are `scope: "container"`, and that is a preservation rather than a widening. The routes
 * authenticated ANY token: a container-scoped agent holding `tokens:mint` could mint a further
 * attenuated token inside its own container and revoke what it had minted there, which is
 * how a terminal agent delegates to a sub-agent. Refusing scoped callers at the door would
 * have deleted that as unreachable — `packages/testkit/e2e/auth.test.ts` exists precisely to
 * prove attenuation rather than a route guard. The confinement obligation `scope: "container"`
 * places on the handler is discharged by the mechanism, on the real caller: a mint may not
 * widen its minter's container scope, and a scoped revocation reaches only that container's tokens.
 * Re-checking it here would be a second implementation of one rule (invariant 14), so it is
 * proved by test instead.
 */
export const accessActions = [
  defineAction({
    name: "createPrincipal",
    title: "Create a principal with a root token",
    caps: ["*"],
    input: BootstrapPrincipalRequestSchema,
    result: TokenGrantSchema,
  }),
  defineAction({
    name: "mint",
    title: "Mint a token",
    caps: ["tokens:mint"],
    scope: "container",
    input: MintTokenRequestSchema,
    result: TokenGrantSchema,
  }),
  defineAction({
    /*
      CLEANUP (D12), and this is the sharpest case for that carve-out in the codebase:
      revocation is the verb somebody reaches for when a secret has leaked. If disabling
      this plugin also suspended revocation, an administrator's toggle — or a mistake —
      would keep a compromised token alive until somebody noticed and re-enabled. Creation
      and administration die on a disable; taking authority back does not.
    */
    cleanup: true,
    name: "revoke",
    title: "Revoke a principal's tokens",
    caps: ["tokens:mint"],
    scope: "container",
    input: RevokeRequestSchema,
    /*
      An EXHAUSTIVE record, not `{ ok: true }`: revocation is destructive, so how many
      tokens actually died is the auditable part, and the deleted route threw it away.
      `0` is a real answer — "there was nothing left to revoke" — and it must not look like
      the same success as `3`. The schema lives in the protocol so this door's declared
      result and every client's parse of it are the same object.
    */
    result: RevokeResultSchema,
  }),
  defineAction({
    name: "listCredentials",
    title: "List who holds a live credential",
    /*
      `tokens:mint`, NOT `*`, and this door is where that decision is published rather than
      only reasoned about (ADR 0019 §3 leaves the authority to the implementing change).

      It is DELIBERATELY graded differently from `listGrants` below, which ADR 0011 §8 settled
      as root-only. The two are neighbours and are not the same question: a grant row is the
      map of who may do what over this workspace — the reconnaissance a caller performs before
      deciding whom to impersonate — while a credential row says an identity exists and holds
      a live secret, carries no secret and no hash, and tells a reader nothing a `tokens:mint`
      holder could not learn by minting.

      The load-bearing half of the argument is the WRITE it aims. `revoke` above is
      `tokens:mint`; grading its list stricter would publish a revoke door that nobody who can
      open it can see the targets of, which is how an administrator ends up revoking by
      guesswork. Read and write are graded together, and the mechanism narrows the answer to
      exactly the principals this caller could revoke (`AuthService.listCredentials`) — so a
      non-root caller learns nothing it could not already act on.
    */
    caps: ["tokens:mint"],
    /*
      `scope: "workspace"`, and FORCED rather than chosen. A credential is not addressed by
      container: a token may be confined to one, but the principal holding it is a workspace
      fact, and a container-scoped caller asking "who holds a credential here" is asking about
      something its scope cannot describe. `revoke`'s `scope: "container"` is a different
      question — it names one principal and the mechanism confines the effect — and preserving
      that is not the same as admitting a scoped caller to a workspace-wide roster.
    */
    scope: "workspace",
    input: z.strictObject({}),
    result: CredentialsResponseSchema,
  }),

  /*
    THE SHARE DOORS (ADR 0014). Five verbs, one job each, and no new capability: a share is a
    token bound to a node, so `tokens:mint` — the cap that already means "may hand authority
    out" — is what the host-side three declare, and the ladder they run is `mint`'s ladder
    unchanged (caps ⊆ the minter's at that node, `*` root-only, no widening of container
    scope). Inventing `share:manage` would have been a second answer to "who may delegate".

    The three host doors are `scope: "container"` for the same preservation `mint` records
    above: a container-scoped agent may share the container it is confined to, and the
    mechanism confines the answer on the real caller.

    The two guest doors are `scope: "workspace"`, and that is not a widening either — it is
    forced. A dial names a node at ANOTHER instance, so a container-scoped token here is
    scoped to a local container id that the dial cannot be inside; admitting scoped callers
    would mean admitting them to something their scope does not describe.
  */
  defineAction({
    name: "mintShare",
    title: "Share a node with another instance",
    caps: ["tokens:mint"],
    scope: "container",
    input: MintShareRequestSchema,
    /*
      The raw secret, exactly once, the `TokenGrant` precedent verbatim: the host keeps only a
      hash, so this answer is the one moment it exists anywhere it can be copied from. Every
      other door that mentions a share publishes `Share`, which structurally cannot carry one.
    */
    result: ShareGrantSchema,
  }),
  defineAction({
    /*
      CLEANUP, for `revoke`'s reason and one of its own. Revocation is what somebody reaches
      for when a secret has leaked, and a share's secret is held by ANOTHER INSTANCE — the one
      case where the holder is beyond this workspace's reach entirely. A disable that suspended
      this door would leave a foreign instance projecting a node whose owner had already
      decided to cut the pipe, which is A4's "when an owner cuts the pipe, the projection dies
      everywhere" broken by an administrative toggle.
    */
    cleanup: true,
    name: "revokeShare",
    title: "Revoke a share and every ticket under it",
    caps: ["tokens:mint"],
    scope: "container",
    input: RevokeShareRequestSchema,
    /*
      The same count `revoke` publishes, meaning the same thing: how many TICKET principals
      actually died. Zero is a success — a share nobody had walked through is exactly the case
      a nervous owner revokes — and the share row is marked revoked either way.
    */
    result: RevokeResultSchema,
  }),
  defineAction({
    name: "listShares",
    title: "List shares granted and dials held",
    caps: ["tokens:mint"],
    scope: "container",
    input: z.strictObject({}),
    /*
      BOTH directions through one door, because the concept is "the cross-instance
      relationships this instance has" and two list doors would be two answers to one question
      (invariant 14). Neither collection carries a secret: `Share` cannot hold one by
      construction, and a `Dial` publishes the host, the node and the status — never the
      secret this instance holds to reach it.
    */
    result: ShareInventorySchema,
  }),
  defineAction({
    name: "dialShare",
    title: "Accept a share from another instance",
    caps: ["containers:write"],
    scope: "workspace",
    input: DialShareRequestSchema,
    /*
      BLOCKS on the handshake rather than answering optimistically, and the schema is what
      forces it: a `Dial` names the node and the caps the host reported, which are facts only
      the welcome carries. The alternative — a row written before the host answers — turns a
      bad token, a wrong origin, an already-revoked share and an unreachable host into the same
      permanently-offline zombie row, which is exactly the deferral-nobody-can-see shape
      AXIOMS.md §Change control forbids. One honest refusal instead.
    */
    result: DialSchema,
  }),
  defineAction({
    name: "openDial",
    title: "Get this principal's ticket for a dialed share",
    caps: ["containers:read"],
    scope: "workspace",
    input: OpenDialRequestSchema,
    /*
      The first of A4's three steps, answered by the guest's OWN instance (ADR 0014 §3): may
      THIS principal use this dial. The answer is an address and a per-principal ticket — never
      the share secret, which stays with this instance the way a machine token stays with the
      agent daemon. Every admitted principal gets the share's full caps this wave; narrowing
      per remote principal is a grant question, and grants are ADR 0011.
    */
    result: DialTicketSchema,
  }),

  /*
    THE GRANT DOORS (ADR 0011). Authority administration, which the ADR names as this plugin's
    (§Non-goals: "Grant administration is a later plugin — `core.access`") and specifies nothing
    else about. Everything below is therefore a derivation, and each derivation is written down
    rather than assumed.

    ROOT-ONLY (`*`), which is stricter than `mint`. A grant is not a token: `mint` may only hand
    out a subset of the minter's own authority, and that subset shrinks monotonically down a
    delegation chain. A DENY row does the opposite — it takes authority away from somebody else,
    and by the waterfall's deeper-beats-shallower rule a deny at a container beats an allow at
    the root. A `tokens:mint` holder scoped to one container could therefore write "deny
    scenes:write for the owner at manifold://container/<its own>" and lock the owner out of a
    container the owner owns. ADR 0011 defines attenuation for MINTING and says nothing about
    attenuating a denial, so the conservative reading of an unwritten rule is the narrow one:
    root writes grants until the operator rules otherwise. The mechanism closes the same hole a
    second time — `AuthService.grant` refuses any deny row matching the workspace owner at any
    node — because a door and a mechanism disagreeing about who may do this is exactly the
    failure mode invariant 14 is about. Grading these `tokens:mint` later widens the door
    without moving it: no argument, result or refusal changes shape.

    `scope: "workspace"` is FORCED, not chosen, and it is `dialShare`/`openDial`'s reasoning
    verbatim: the argument is a `manifold://` node URI that may be the workspace root itself, and
    a container-scoped token is scoped to a local container id that the root is not inside.
    Admitting a scoped caller would be admitting it to something its scope cannot describe. The
    scope rung answers before the caps rung, so a scoped caller learns nothing about what it
    lacks.

    NO NEW CAPABILITY, for the reason the share doors give: `*` and `tokens:mint` already answer
    "who may hand authority out", and a `grants:manage` would be a second answer to one question.
  */
  defineAction({
    name: "grant",
    title: "Grant or deny capabilities at a node",
    caps: ["*"],
    input: CreateGrantRequestSchema,
    /*
      The whole ROW, not an id: a grant is data (ADR 0011 §The grant row), and the caller needs
      the `id` to revoke it, the `createdAt` the precedence rule breaks ties by, and the
      `createdBy` that makes it auditable. Publishing less would force a `listGrants` round trip
      to learn what you just wrote.
    */
    result: GrantSchema,
  }),
  defineAction({
    /*
      CLEANUP (D12), and the reason is `revoke`'s exactly: a grant that should not exist is the
      administrative analogue of a leaked token — somebody holds authority they should not — and
      an administrator's toggle must never be what keeps it alive. The carve-out is narrow here
      by construction: the door is root-only, so the only principal who can reach it while
      `core.access` is off is the one who could turn it back on anyway.
    */
    cleanup: true,
    name: "revokeGrant",
    title: "Revoke a grant",
    caps: ["*"],
    input: RevokeGrantRequestSchema,
    /*
      `RevokeResult`, the same count `revoke` and `revokeShare` publish, meaning the same thing:
      how many rows actually died. `0` is a success — asking twice about a grant already gone is
      what a careful administrator does — and inventing a `{ ok: true }` here would be a second
      shape for one answer.
    */
    result: RevokeResultSchema,
  }),
  defineAction({
    name: "listGrants",
    title: "List grants",
    caps: ["*"],
    input: ListGrantsRequestSchema,
    /*
      A read, and root-only for the same reason the write is: the answer is the map of who holds
      what over this workspace, which is the reconnaissance a caller performs before deciding
      whom to impersonate. The filter narrows by node or by principal because an unfiltered
      answer over a real workspace is a page nobody reads; it never widens anything, so a
      filtered call and an unfiltered one differ only in size.

      This is `core.access`'s first read door, and it does not contradict the manifest note that
      the plugin "declares NO read action": that note recorded that there was no EXISTING read to
      convert. A grant has no other door onto it at all — no route, no introspection field — so
      publishing one is converting nothing and inventing the only way to see the rows that decide
      everything else.
    */
    result: GrantsSchema,
  }),
];
