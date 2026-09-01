import { defineAction } from "@manifold/plugin";
import {
  BootstrapPrincipalRequestSchema,
  DialSchema,
  DialShareRequestSchema,
  DialTicketSchema,
  MintShareRequestSchema,
  MintTokenRequestSchema,
  OpenDialRequestSchema,
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
 * NOT `essential`, deliberately, and the reason is structural rather than a judgement call:
 * the owner key authenticates OUTSIDE the token system (`AuthService.authenticate` compares
 * it before any token lookup), so disabling this plugin can never lock the owner out of
 * their own workspace. Turning it off costs the ability to issue and revoke DELEGATED
 * authority; it does not cost the ability to administer, and the owner can always turn it
 * back on. `essential` is reserved for plugins the workspace cannot draw itself without.
 *
 * ADR 0011 will redesign what happens BENEATH this door — flat caps plus a container scope become
 * grants on the node tree, and a token becomes a reference to a grant. That is why the door
 * is worth having now: the vocabulary a caller sees (`core.access.mint` with a cap set
 * and an optional scope) is exactly the vocabulary the waterfall keeps, so the evaluator
 * swap happens under an interface that already published its shape.
 *
 * Contributes no UI this wave. Administration screens are a later plugin; the door is what
 * makes them possible, and it is reachable identically by a human, a remote client and an
 * agent (A2) the moment it is composed.
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
 * Declares NO read action, because there is no access read to move: nothing today publishes
 * principals or tokens except `GET /api/introspect`, which is the engine's own root-only
 * introspection door over rooms, terminals, machines and principals together. Inventing
 * `core.access.list` would be inventing a read, not converting one.
 */
export const accessManifest: PluginManifest = {
  id: "core.access",
  version: "1.1.0",
  title: "Access",
  description:
    "Creates principals, mints delegated tokens, shares nodes with other instances, and revokes them — admin UI: deferred, door-only; share UI: deferred, door-only",
  /*
    `*` is here because `createPrincipal` demands root and a manifest is a readable ceiling
    on a plugin's authority: a reader must be able to see, without opening the code, that
    one of these doors is root-only. The share doors add no capability — a share IS a token
    bound to a node (A5), so the cap that already means "hands authority out" is the one they
    declare, and `containers:read`/`containers:write` are what accepting and using a foreign
    node costs on the guest side.
  */
  capabilities: ["*", "tokens:mint", "containers:read", "containers:write"],
  contributes: {
    panels: [],
    sections: [],
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
];
