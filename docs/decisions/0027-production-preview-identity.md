# Production identity admits browser users to disposable previews

Date: 2026-09-05
Status: accepted
Ratified: operator clarification on issue #286 and the implementation session, 2026-09-05; production is the authority for `preview.manifold.tyrode.dev` and numbered PR previews, authorized production users are eligible, and their restrictions must be preserved.

## Context

A browser credential belongs to one manifold instance. The shell stores it under that instance's origin, the API accepts no cookie, and handing a production owner key or reusable production bearer to an experimental PR build would invert the trust boundary. The publicly posted preview URL also cannot itself be authority.

The required experience is nevertheless one sign-in: a browser already signed into the operator's production instance opens integrated or numbered previews without fetching, copying, or pasting another key. People explicitly authorized on production may do the same, but a restricted key must not become preview administration.

## Decision

Production is a narrow identity assertion issuer for a configured preview DNS namespace. `MANIFOLD_PREVIEW_DOMAIN` enables issuance only for `https://preview.<domain>` and `https://<number>.<domain>`; `.localhost` HTTP is the test-only equivalent. Preview processes set `MANIFOLD_IDENTITY_AUTHORITY` to production. Routing is registration: preview deployment makes an eligible audience reachable, teardown removes it, and no per-preview secret or production registry row exists to reconcile.

An unauthenticated preview asks its own server to generate a 256-bit nonce and a separate opaque
state id. The server returns only the nonce and binds the undisclosed state id to that browser in a
two-minute, host-only, HttpOnly callback cookie; this is non-authoritative CSRF state, not a
parent-domain bearer. The browser also keeps the nonce in `sessionStorage`, then navigates to
production's `/auth/preview` route with the public audience and nonce.
The production shell reads only its own origin's stored credential and asks
`POST /api/identity/preview-assertion` for a statement. Production authenticates that credential
normally, admits only a local human principal, refuses container-scoped credentials because their
production container has no honest whole-workspace equivalent, and snapshots its effective root
authority. A genuinely unrestricted root credential remains `*`; administered denies turn a root
credential into its effective concrete set, and every other workspace-wide credential carries
only the concrete capabilities it can exercise at the production root.

The assertion is Ed25519-signed by an instance key generated at
`<data>/preview-identity.key`, names exact issuer, audience, source principal, capabilities,
nonce, unique id, issue time and a 60-second expiry. Production submits it in an auto-generated
POST form to the preview callback. It is never a URL parameter, cookie, GitHub secret, production
bearer, or owner key. The preview fetches and caches the production public key over the configured
HTTPS authority, checks signature, exact issuer and audience, and stages the proof under a random
one-time ticket delivered only to the receiving browser in a second host-only HttpOnly cookie.
A same-origin finalize navigation requires both that ticket and the initiating state cookie,
with matching signed nonce, before any local credential is minted. This prevents an attacker
from starting a flow and completing a signed-in victim's callback in another browser. Both
proofs are consumed on success; assertions cannot be reused within the process lifetime.

After verification the preview deterministically maps `(issuer, source principal id)` to a local
human principal whose `origin` names production and mints an ordinary preview-local token with the
asserted capabilities. That token expires after 15 minutes. The browser stores it only on the
preview origin and removes it at expiry, which restarts the same production handoff. Session
sockets are fenced with close code 4403 / `expired` at credential expiry. Production revocation or
authority changes therefore reach an already-open preview no later than the current 15-minute
local lease; a newly opened or renewed preview sees them immediately.

Issuance and acceptance append `preview_identity_issued` and `preview_identity_accepted` event rows containing identifiers, audience/issuer and expiry, never credential or assertion bytes. This handshake is identity admission before a local principal exists, not an action by an already-local actor; its durable mutations are the same principal, grant and token rows the identity mechanism owns. The event journal is its A6 record, matching owner-key authentication in ADR 0019 §4.

## Foundation law

This changes the existing `runtime-http` and `identity-caps` pillars; it adds no floor file or pillar. Bootstrap circularity holds because preview admission must run before the plugin host can be entered. Neutrality holds because the proof names principals, origins and capabilities, not a plugin or workspace domain noun. Arbitration holds because this is the sole boundary deciding whether a production proof becomes a preview-local credential. Administration remains in `core.access`; no second token or grant implementation is introduced.

## Alternatives rejected

- A parent-domain bearer cookie introduces ambient authority and CSRF, sends a development
  credential to sibling origins, and contradicts the operator's explicit constraint. The chosen
  host-only callback nonce is short-lived non-authoritative CSRF state and is never sent to a
  sibling preview.
- Copying production owner keys or bearer tokens into seeded preview databases, browser URLs, preview JavaScript, deployment secrets or forms gives less-trusted code reusable production authority.
- One preview account or secret per PR preserves isolation but fails the required ordinary-link experience and creates lifecycle work.
- Hard-coding the operator principal excludes people the operator explicitly authorized. Treating every valid production token as preview root makes restricted authority wider merely because it crossed an origin.
- Reusing the instance share/dial path presents a production container through a projection. The requirement is the actual preview workspace, and identity admission is not a second content federation mechanism.
- A symmetric signing secret shared with previews would let any preview forge production assertions for every sibling. Ed25519 gives previews verification without issuance authority.

## Consequences

Production-side support must be released and explicitly promoted before a deployed preview can complete the flow; this record does not authorize either operation. Production deployment must set `MANIFOLD_PREVIEW_DOMAIN=manifold.tyrode.dev`. Integrated and numbered preview processes receive the authority automatically from preview tooling; live worktrees retain their own sign-in. A retired preview has no route at which an assertion can be consumed.

The mechanism is intentionally deployment-specific rather than a general OIDC provider. ADR 0019's future relying-party posture remains unchanged for unrelated multi-human deployments: the owner key stays bootstrap and break-glass, agents never enter this browser flow, and all ordinary API authority remains explicit bearer authentication with no ambient cookie.
