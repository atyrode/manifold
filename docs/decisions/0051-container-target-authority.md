# 0051 — A governed door hands one named container's authority to the work it starts

Date: 2026-09-26
Status: accepted
Ratified: 2026-09-26, the operator's ruling recorded on atyrode/babel#469 and issue #883's agent-ready scope

Amends [ADR 0033](0033-governed-plugin-runtime.md) §Execution and authority (which container
targets governed admission discharges) and [ADR 0041](0041-sibling-action-calls.md) §2 (the
ceiling `ctx.jobs` carries and `onJobSettled` restores). Both records stay as written;
[CONTRACTS.md](../CONTRACTS.md#governed-machine-jobs) and
[PLUGINS.md](../PLUGINS.md#governed-jobs-and-continuous-streams) are the normative form.

## Context

A plugin could not start a Code or OMP session from the wake of a run it had started. Only the
operator's own request could, because of how authority reaches background work:

- A door's handler runs under its caller's `AuthContext`. Its native bridge — the context
  `ctx.jobs` and `ctx.services` are bound to — is that context with `caps` narrowed to
  `caller caps ∩ (door caps ∪ delegates)`, keeping the token, grant, scope and expiry
  (ADR 0041 §2).
- A job request stores `credentialReference(nativeBridge)`: principal, token, grant, the narrowed
  `caps`, scope and expiry. `onJobSettled` restores it with `restoreCredential`, and the wake's
  `ctx.jobs` and `ctx.actions.call` run under the result (ADR 0033 addendum; ADR 0041 §2).
- `delegates` are native-only (`NATIVE_DELEGATE_CAPS`), so no door can list `containers:*` there;
  and governed admission discharged a container target only for `terminals:*`. Any other container
  requirement resolved `job_node_unsupported`, so a governed door declaring
  `{ cap: "containers:write", target: ["profile"] }` was refused at the press with
  `explicit version-bound consent required`.
- Code's and OMP's `runSession` declare flat `caps: ["containers:write"]` and grade the caller in
  the handler: `hasCap(ctx.auth.caps, cap)` and `ctx.auth.allows(cap, { kind: "container", … })`.
  A wake's `caps` never held the cap, so the session was refused `scope_refused`.

One fact decides the shape of any fix. The grant waterfall (`effectiveCaps`) does not read a
context's flat `caps`: those are a ceiling that callers ask separately. Simply letting the cap into
the run's flat ceiling would therefore pass the callee's check at EVERY container the presser can
write — the widening the operator's ruling excludes.

## Decision

1. **Admission.** A governed door (its `caps` include a governed capability) may declare
   `containers:read` or `containers:write` with a `requirements` target. The target must be a
   container `ManifoldRef`; anything else is refused `invalid_args` naming the cap. The requirement
   is discharged against the CALLER at that container — its flat ceiling holds the cap and the
   waterfall allows it there — with no revision-bound consent, exactly as `terminals:*` already
   are: nothing is installed at a container, so there is no revision to consent to. A caller that
   lacks the cap there is refused `forbidden` at the press.

2. **Representation: container grants, carried by the lineage and kept hub-side.**
   `AuthContext.containerGrants` is a bounded list of `{ containerId, caps }` (`containers:read` /
   `containers:write`, at most 64 grants). A carried cap is NOT in the flat `caps`. The native
   bridge of a governed dispatch drops its container-targeted caps from the flat ceiling and
   carries exactly the grants its admission discharged. `CredentialReference` carries the list,
   so `credentialReference` and `restoreCredential` round-trip it and every existing refresh of a
   live context stays exactly as confined as the context. The one place a reference leaves the
   hub, the signed job request whose credential a machine owner parses strictly, omits it: the
   hub persists it beside the request (`machine_jobs.container_grants`, nullable;
   `JobScheduleSpec.containerGrants`, optional), every reservation must state it, and every
   restore of a job's authority that is handed onward (the wake, a deferred start, an invocation
   child) reads the request's credential together with that column. The owner RPC is unchanged.

3. **Evaluation: presence is confinement.** For a context carrying the list, even an empty one,
   `effectiveCaps` answers a container capability only at and beneath a container a grant names it
   for and removes it everywhere else, the workspace root included. Neither a flat cap nor the
   absence of a grant restores the unconfined answer. The waterfall still decides at the
   container. `ctx.auth.caps` lists the carried caps (they are held) in place of any flat
   container caps, while `allows` says where. A context carrying the list is never root-class,
   whoever pressed. An Agent's stored sponsor lineage has no room for the list, so such a context
   never sponsors an Agent or Run.

4. **Admission of other doors under carried authority.** A door graded by a `requirements`
   target is admitted by that target. A `scope: "container"` door with flat caps opens on carried
   authority only when exactly one container carries every container cap it declares. The
   dispatch then runs SCOPED to that container for every container question, as a
   container-scoped token's does: `ctx.containerScope`, `ctx.auth.containerScope` and
   `ctx.outsideScope` name it, and `ctx.auth.allows` asks a container capability, or any node
   inside a container, as if scoped to it, so every handler that already honours a scoped token
   confines itself. Every other question — a machine, operation, job or service node, or a
   non-container capability at the anchor — answers from the flat caps and grant rows exactly as
   before, so a session door's `machines:run` check at its machine still passes. A
   workspace-graded door never opens on carried authority.

5. **Carriage.** Every job the dispatch executes and every schedule it registers keeps the grants,
   and so does every occurrence, invocation child and terminal job the lineage starts.
   `onJobSettled` restores them with the job's credential, so the wake's `ctx.actions.call` is
   graded with them at the callee, and jobs the wake posts keep them. A door opened under a
   confined lineage lends that lineage's grants through the same intersection as its flat ceiling:
   only the container caps the door declares, and only at the container it was admitted at when
   carried authority admitted it. A door declaring none lends an empty list, confined and carrying
   nothing.

6. **Lineage.** Restoration never widens. Grants must be well formed, name no cap the reference
   already carries flat, and lie inside the token's caps, or nothing restores at all. Revocation
   or expiry of the pressing credential restores nothing, so there is no wake; an administered deny
   or a pause at the container withdraws the carried cap at use exactly as it does the presser's.
   A reference without grants restores exactly what it always did.

## Not changed

A dispatch whose caller carries no grants — every client dispatch — through a door that names no
container target keeps a byte-identical native bridge and job request. `delegates` stay
native-only. A non-governed door's requirements and its flat `caps` ceiling, including what that
ceiling already lends its jobs, are unchanged for such callers. Every other admission, consent and
ceiling rule holds, including the caller ceiling on sibling calls (ADR 0041 §3).

## Alternatives

- **Let `containers:*` be delegates, or lend them flat.** Rejected: the evaluator ignores the flat
  list, so the run would pass a callee's container check at every container the presser can write.
- **Carry the grants inside the job request's credential.** Rejected: the request is signed and
  its credential parsed strictly by machine owners, so it would need an owner protocol bump and
  would refuse older owners, for a fact only the hub uses.
- **Scope the job credential to the container.** Rejected: container scope confines every node,
  so the run could no longer reach the machine operation it exists to execute.

## Consequences

Work pressed by a root credential through a door with container targets is no longer root-class.
That is the point of binding it: root reaches every container. Consumers that need a run to open a
container door name that container on the door they press, and the run holds it there alone.
