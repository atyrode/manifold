# 0046 — Principal access pause is credential lifecycle state

Date: 2026-09-15
Status: accepted
Ratified: 2026-09-15, issue #164 and the operator's “Add access pause” decision

## Context

The plan calls reversible suspension a first-class identity verb, but no such access door
exists. A root `deny *` grant is not a suspension mechanism: ADR 0011 deliberately lets a
more-specific descendant row outrank an ancestor, so a principal with a child allow may keep
acting. Revoking credentials is effective but destructive, closes live sockets, settles some
run lifecycles, and requires a replacement credential before the principal can return.

The required operation must stop further authorized requests without killing processes,
deleting work, changing grants, replacing tokens, or making the workspace owner unable to
recover it.

## Decision

### 1. Pause precedes the grant waterfall

A pause is durable lifecycle state for one principal, not a grant. Before runner, Run-policy,
expiry, cache, or grant-waterfall evaluation, `AuthService.effectiveCaps` returns the empty set
for a paused non-owner principal. The same already-authenticated request or socket context is
therefore refused on its next authority check even when a more-specific allow reaches the
requested node.

Schema 41 stores one row per paused principal in `principal_access_pauses(principal_id,
paused_at, paused_by)`. `AuthService` loads the rows once and mirrors principal id and timestamp
in memory, so the frame hot path performs no SQLite read. A successful transition changes the
durable row and the in-memory mirror at one commit boundary, invalidates memoized authority,
and emits one declared access event.

### 2. Owner access is break-glass authority

The workspace owner cannot be paused. Both mutation doors refuse its principal explicitly,
and the evaluator ignores any stale or corrupt owner pause row loaded from storage. This is the
same recovery law that synthesizes undeniable owner authority and keeps the owner key outside
token revocation and expiry.

### 3. Two root-only, idempotent doors own the transition

`core.access.pause` and `core.access.resume` are workspace-scoped, root-only doors accepting
`{ principalId }`. Both refuse an unknown principal and the owner. Repeating pause returns the
original `{ principalId, pausedAt }`; repeating resume returns `{ principalId, pausedAt: null }`.
Only a real state transition emits `principal_access_paused` or `principal_access_resumed` on
the `core.access` collection.

`core.access.listCredentials` adds optional `pausedAt` to each principal row. The field is
additive for older readers and gives the Sessions surface one authoritative state to render.
Human, Agent, Run, and service principals share this lifecycle rule; service configuration and
credential ownership remain unchanged.

### 4. Suspension is not termination

Pause neither revokes a bearer nor a token-bound grant, closes a connection, settles a Run,
stops a job or terminal, nor deletes data. Existing processes and transports remain alive.
Every subsequent protected action is denied because its current authority set is empty. Resume
removes only the pause row; the same unexpired, unrevoked credential and the same grants work
again without reauthentication.

## Alternatives rejected

- **Root `deny *` grant.** A descendant allow outranks it by design, so it cannot guarantee
  suspension without changing ADR 0011 precedence for every authorization decision.
- **Revoke and re-mint.** It destroys credential continuity, fences sockets, and can settle work;
  that is incident response, not reversible pause.
- **Disconnect sockets or kill processes.** It suppresses current transports while leaving other
  request paths available, and destroys work the requested verb must preserve.
- **Read the pause table on every request.** Correct but needlessly adds SQLite work to the single
  authority hot path; commit-synchronized in-memory state provides the same process-local answer.

## Consequences and proof

The Sessions section shows `Pause access` or `Resume access` for non-self rows with credentials,
reports paused state in the row metadata, and renders the authoritative refusal when a viewer lacks
root authority. Revocation remains a separate, destructive two-press control.

Regression coverage exercises a principal with a deeper allow through a real pause door, proves
the same authenticated context is refused while its token and Run remain live, reconstructs
`AuthService` from the durable row, proves owner authority survives, and resumes the original
credential without reauthentication. Browser coverage drives both visible controls and the
rendered state transition.
