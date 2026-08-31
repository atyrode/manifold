import { defineAction } from "@manifold/plugin";
import {
  BootstrapPrincipalRequestSchema,
  MintTokenRequestSchema,
  RevokeRequestSchema,
  RevokeResultSchema,
  TokenGrantSchema,
  type PluginManifest,
} from "@manifold/protocol";

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
 * Declares NO read action, because there is no access read to move: nothing today publishes
 * principals or tokens except `GET /api/introspect`, which is the engine's own root-only
 * introspection door over rooms, terminals, machines and principals together. Inventing
 * `core.access.list` would be inventing a read, not converting one.
 */
export const accessManifest: PluginManifest = {
  id: "core.access",
  version: "1.0.0",
  title: "Access",
  description: "Creates principals, mints delegated tokens, and revokes them.",
  /*
    `*` is here because `createPrincipal` demands root and a manifest is a readable ceiling
    on a plugin's authority: a reader must be able to see, without opening the code, that
    one of these doors is root-only.
  */
  capabilities: ["*", "tokens:mint"],
  contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
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
];
