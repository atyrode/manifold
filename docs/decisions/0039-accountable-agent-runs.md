# Autonomous work is a sponsor-bound run with exact policy acknowledgement

Date: 2026-09-13
Status: accepted
Ratified: the operator selected **“Broader delegation now”** on 2026-09-13 for #553, #557, #558 and #559: child runs and renewal are permitted; policy changes suspend live runs until exact re-acknowledgement; inspection is limited to a run and its direct descendants; selected effects may require bounded justification.

## Context

Manifold already had attributable principals, expiring bearer credentials, the permission waterfall,
the action plane and a durable trace ledger. It did not have a truthful unit for one autonomous task.
An operator could mint a `kind: "agent"` principal through the generic token door, but no row said who
sponsored this invocation, what it was for, where its authority stopped, which policy bytes it had
received, which children it created, or who must clean it up. Expiry limited one credential to an hour;
it did not settle descendants or prove teardown. An agent could discover actions through
`GET /api/protocol`, but no standard runner made that plane the obvious path and no scoped inspector
could answer what a current run had done without giving it the root-only audit history.

Issues #559 and #558 are the mechanism: a run-owned identity plus live policy acknowledgement.
Issues #553 and #557 consume that mechanism: one action-plane runner, and one sponsor-scoped run
inspector. The operator chose the broader delegation posture after these consequences were presented,
so delegation, renewal, re-acknowledgement and scoped inspection are decisions rather than defaults an
implementation inferred.

## Decision

### 1. One autonomous task is one fresh agent principal and one durable run

`core.access.createAgentRun` is the only generic admission door for autonomous identities. It creates a
fresh `kind: "agent"` principal, a hashed bearer credential and an `agent_runs` row in one transaction.
The row carries the sponsor principal and non-secret authorizing credential lineage, whether the
owner-key path authorized it, purpose, optional task reference, root and parent run ids, authority
target and reach, capability ceiling, expiry, renewal and depth budgets, cleanup owner, policy revision,
state and cleanup result.

The legacy `createPrincipal` and `mint` input schemas create humans only. They cannot create a new agent
principal, and `mint` cannot issue another credential for an existing agent principal. Credentials
issued before this cutover continue to authenticate until their existing expiry or revocation, but they
cannot reproduce themselves. Internal machine, service, federated-ticket and terminal-lifecycle
identities retain their separately named lifecycles; none becomes a public exemption.

### 2. Effective authority is live authority intersected with the run ceiling

A run never stores a second permission answer. It stores the exact non-secret credential lineage that
authorized the current lease. At each action, effective authority is the ordinary live permission
waterfall intersected with the run's capability list, target/reach boundary, expiry and active policy
state, then with each sponsor run's live authority at the actual node. A node-only grant or a
descendant-specific deny therefore cannot be laundered through a fresh principal. Sponsor revocation
constrains existing work as well as future issuance and renewal; a durable run row never turns stale
authority into a grant. Agent-run credentials cannot carry wildcard, legacy token minting, machine
enrollment or plugin administration.

### 3. Policy is server-selected exact bytes, and acknowledgement is a state transition

Every run starts `pending_policy`. It may call only the policy and teardown doors until it fetches the
exact built-in policy plus the optional operator policy selected by
`MANIFOLD_AGENT_POLICY_FILE`, then acknowledges every bundle id and SHA-256 digest at the current
revision. A successful acknowledgement moves the run to `active`. The server stores the exact bundle
snapshot and acknowledgement time; it does not claim comprehension, hidden-reasoning disclosure or
future compliance.

The configured policy file is loaded strictly and fail-closed. `core.access.reloadAgentPolicy` is
root-only. A changed revision snapshots the new exact bytes for every open run and moves each active run
to `policy_stale`; the dispatch ladder then permits only policy and teardown doors until exact
re-acknowledgement. Startup performs the same reconciliation, so a restart cannot preserve authority
against policy bytes that changed while the server was down.

### 4. Delegation and renewal are bounded attenuation, never inheritance by convention

An active run holding `agents:delegate` at the requested target may create a child only when the child's
capabilities, target, reach and expiry are subsets of the parent, and every later effect remains
intersected with the sponsor chain at its actual target. Maximum depth is four and one root run may
create at most 32 descendants; every intermediate run's lower descendant budget is also enforced. A
child may lower those ceilings but cannot raise them. The direct sponsor may renew an active,
policy-current run at most 24 times; renewal binds the sponsor's current credential, must extend the
existing lease, lasts no more than one hour and never outlives its parent. Renewal revokes every
previous credential first in the same transaction.

A run or its direct cleanup owner may finish it as completed, failed, cancelled or abandoned. Finishing
or expiring a run revokes every live credential and token-bound grant in its subtree and settles all
open descendants as revoked. Expiry is a backstop, not successful teardown. Cleanup counts and failures
are durable facts.

### 5. Lifecycle is action-plane-native and point-of-use

The lifecycle doors live in `core.access` and are published by `GET /api/protocol` with machine-readable
input and result schemas. `runAccess` declares which doors remain reachable for policy, teardown or
target-relative delegation; no action name or DOM control is special-cased in a client. The dispatch
ladder writes `policy_required` and `policy_stale` denials to the trace ledger like every known-door
refusal.

The runner required by #553 is one SDK transport and one bounded sequence executor over these published
actions. It may create children, renew and re-acknowledge through the lifecycle doors, but it may not
fall back to browser controls. A browser remains a verification surface for human-facing behavior, not
the autonomous control plane.

### 6. Inspection is scoped by sponsorship, not by possession of the history ledger

The inspector required by #557 projects existing run rows, action traces, events and job records; it does
not create a second audit store. A run may inspect itself and direct descendants it sponsored. Its
cleanup owner may inspect the run and that same direct-descendant view. Root may inspect all runs. No
other principal receives a history oracle.

Selected effectful actions may require a bounded, schema-declared justification attached to that action
invocation. The list is closed and reviewable; it is not a free-form requirement on every call, and the
record never claims to expose chain-of-thought.

## Refused alternatives

**Keep generic `kind: "agent"` mints and add optional metadata.** Optional lineage is absent on the run
that most needs it, and a second admission path makes policy acknowledgement bypassable.

**Treat a one-hour token as the run.** A token has no purpose, sponsor chain, descendants, policy
revision or teardown result. Expiry also cannot revoke a child whose deadline is later unless the child
relationship exists durably.

**Copy sponsor capabilities into the run once.** That freezes authority at admission and defeats the
live waterfall. The run ceiling is an intersection, not a snapshot grant.

**Trust a repository policy file selected by the agent.** Repository content may narrow conduct but
cannot grant authority or choose the governing bytes. Only built-in and server-configured operator
sources are accepted.

**Let every run read `core.events.list`.** That root-only ledger is a workspace history oracle. The
inspector is a bounded projection over records the run sponsored.

**Use the browser when an action is inconvenient.** That makes the visible DOM a second control plane
with weaker schemas and attribution. Missing action-plane affordances are defects to fix at the door.

## Consequences

- Protocol gains `agents:delegate`, agent-run and policy schemas, lifecycle result types, `runAccess`,
  and the traced `policy_required` / `policy_stale` denial rules.
- SQLite schema 35 stores run lineage, bounds, state, cleanup facts and exact policy snapshots.
- `core.access` owns lifecycle actions. Its generic bootstrap and token-mint schemas are human-only.
- A configured operator policy becomes a runtime prerequisite: unreadable, invalid UTF-8, empty or
  oversized policy bytes stop startup or reload rather than silently falling back.
- Policy acknowledgement is honest evidence of exact delivery and assent only. Compliance still comes
  from least authority, traceability, teardown and review.
- #553 and #557 remain downstream obligations until their runner and inspector surfaces ship.

## Evidence

#559 and #558 are proven when a newly created run authenticates but every ordinary action is denied
`policy_required`; exact acknowledgement activates it; child widening is refused; parent settlement
revokes the child; changing the configured policy yields `policy_stale`; only the new exact bytes can
reactivate the run; and the generic principal/token schemas reject new agent identities.

#553 is proven when an external agent completes a bounded multi-action sequence using only discovered
actions and lifecycle doors, with no browser fallback. #557 is proven when self and direct-sponsor views
show the same lineage, action and cleanup facts while an unrelated principal cannot enumerate them.

## Revisit when

A legitimate autonomous task needs more than four delegation levels or 32 descendants, a non-file
operator policy source is required, or an action needs justification outside the closed selected-effect
list. Raising a budget or widening inspection is a new security decision, not a configuration tweak.
