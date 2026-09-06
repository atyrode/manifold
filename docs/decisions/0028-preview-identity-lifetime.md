# A preview identity lives as long as a production browser credential

Date: 2026-09-06
Status: accepted
Ratified: operator instruction on the PR #292 preview, 2026-09-06 — "my identity shouldn't expire on these PR previews, it should be no expiry just like in production".

## Context

ADR 0027 minted the preview-local token with a fifteen-minute lease so that production revocation and grant changes would reach an already-open preview within a quarter hour, renewed by silently re-running the production handoff when the browser removed the credential.

In use, the lease was the preview's most visible property. Every fifteen minutes the session sockets were fenced `4403 expired`, the shell reloaded through production, and the operator watched the sign-in and canvas connection start over — in the middle of a terminal session, on every numbered preview, for the whole life of a review. Production's own browsers do not behave this way: a human credential there lives fourteen days (`INTERACTIVE_TOKEN_TTL_MS`, ADR 0019 §2), and the operator experiences production as a place that stays signed in.

The revocation argument the lease served was weaker than it looked. Revoking a production identity already refuses the NEXT handoff — a new tab or renewed preview is denied at once, since the assertion is issued by production against its current authority. What the short lease bought was bounding an already-open preview tab, and the same tab open on production is bounded by exactly the fortnight this record adopts.

## Decision

A preview identity's token is an ordinary interactive credential: `acceptPreviewIdentity` mints with the `interactive` lifetime and the separate `preview` expiry kind is gone. Fourteen days is the one lifetime a human browser credential has, on production and on every preview alike.

Everything else in ADR 0027 stands: the assertion is single-use and short-lived, the credential is stored only on the preview origin, the browser removes it at expiry and repeats the production handoff, and session sockets are fenced `4403 expired` when it lapses. The trace ledger still records `preview_identity_accepted` with the expiry it minted.

## Consequences

- An open preview tab no longer restarts its session every fifteen minutes.
- Production revocation reaches an already-open preview at that preview credential's own expiry, or immediately when the operator revokes the preview principal's sessions on that preview (`core.access.revoke`), which is the same lever production has.
- ADR 0027's fifteen-minute figures are superseded by this record; `docs/CONTRACTS.md` §Identity is the normative text.
