# Agent run inspection is a scoped projection, not another journal

Date: 2026-09-13
Status: accepted
Ratified: the operator's “Broader delegation now” answer for #557 on 2026-09-13 grants self-chain and durable sponsor-descendant inspection plus bounded declarations for selected high-impact effects; workspace-wide journal access remains root-only.

## Context

An unfamiliar Sessions row was attributable but not reviewable. The workspace already retained
run sponsorship, policy acknowledgement, hashed credentials, grants, action traces and native job
lifecycles. A second audit database would duplicate their authority and retention; demanding hidden
reasoning would not make those facts stronger. The missing capability was a bounded, authorized
projection and a gesture onto that same headless door.

ADR 0039's implementation-stage direct-descendant wording did not fully express the operator's
ratification recorded in issue #557: self sees its own run chain, a sponsor sees descendants it
actually authorized, and unrelated principals learn nothing. This record makes that exact relation
explicit. It does not grant journal access or amend the permission waterfall.

## Decision

### One headless projection

`core.access.inspectAgentRun` is the only run-inspection action. Its request names one run or one
principal, with optional exact trace selection or an older-trace cursor. The existing Sessions
section calls it and renders its result; no SDK-side ledger, browser history store or polling loop
is introduced. An agent row is an accessible button; ordinary human rows retain their behavior.

The existing `events` table remains the one journal and the dispatcher remains its trace writer.
`core.events.list` remains its root-only workspace-wide read door. The inspector is a purpose-built,
payload-free projection over authorized identities, not a second general journal reader. Metadata-only
migration 36 records the declaration provenance cutover; no audit table, output reader or retention policy is added.

### Identity-relative authorization

Root may inspect any run. A live authenticated accountable run may inspect itself and verified
ancestors/descendants, not siblings. A human or agent sponsor may inspect descendants reached through
durable sponsorship. Each traversed edge verifies parent id, authorizing principal, root id and
depth; sharing a root id or having minted an unrelated token is insufficient. Every lineage link is
independently authorized, so opening an ancestor does not reveal its other branches.

Missing and unauthorized runs return the same refusal. Within an authorized run, a missing, pruned
or foreign trace returns the same unavailable selection. No workspace trace count, searched actor,
credential reference or foreign result accompanies that answer. Expired or revoked credentials are
not viewers. Pending/stale policy runs may inspect without regaining ordinary effect authority.

`core.access.listCredentials` keeps its former root/revocable-identity fields and audience, including
credential references for those administrators only. `core.access.listAgentRuns` is a separate bounded
discovery projection: the newest 100 authorized run summaries, sanitized names/purposes, and a
truncation flag, with no credential ids or raw principal text. Both reads restore current credentials
at point of use. Unrelated viewers discover no runs. Sessions uses these summaries for chain-only
viewers; the ordinary administrator credential view and human revocation controls remain unchanged.

### Safe facts, honest incompleteness

The projection explicitly selects fields from existing run/principal/token/grant/policy rows,
trace rows, native jobs and retained terminals. The live session gateway contributes only matching
connection ids. Fields are bounded: run/sponsor ids, purpose/task claims, scope/caps/expiry/budgets,
policy revision and acknowledgement time, credential/grant life, observed connection state,
action/authority/target/outcome/timestamp/trace ids, native job revision/artifact pins and
job/terminal lineage, and cleanup counts/state/time.

Credential values, ids, hashes and prefixes; raw action arguments and trace payloads; input,
environment, terminal bytes, retained output, policy bodies and cleanup exception text are not
projection fields. Credential-like free text is withheld rather than echoed. Artifact and policy
pins are intentionally non-secret and are not credential hashes.

History is retained-only. A null trace outcome is pending-or-crashed; it cannot distinguish an
in-flight handler from a process lost before settlement. A connection not currently observed is
closed-or-unavailable, with trace observation times rather than invented connection timestamps.
A legacy principal has an unavailable run origin; pruned native origins remain unavailable.
Expired authority may coexist with pending cleanup. A retained terminal, failed cleanup and a
closed native owner are separate facts, never collapsed into a successful run outcome.
Native job ids, including deterministic scheduled-job ids, are mechanical correlation facts, not
declarations. Jobs and other non-place references render as text rather than broken navigation;
retained trace references expand through the inspector and navigable terminal/place references use
the existing navigation door.

### Declarations are claims only

Actions publish `agentJustification: "required"`. The smallest initial set covers
`core.access.createAgentRun`, `core.access.renewAgentRun`, `engine.jobs.execute` and
`engine.jobs.schedule`: creating delegated authority, extending it, exercising native execution
and authorizing deferred execution. Reads and cleanup remain unmarked.

An active accountable run may supply `x-manifold-agent-justification` through the shared action
transport. Existing policy/scope/capability/argument checks retain precedence, including real
target-relative delegation/renewal and full native admission. A reusable host continuation runs
immediately before the effect; isolated actions perform their real Zod parse exactly once before
the host admits execution. Both raw and normalized text are bounded to 512 characters. Detection
uses a Unicode skeleton to recognize obfuscated credential keywords and Basic/Bearer syntax;
the attributed normalized text is otherwise preserved. Credential-like bytes are never echoed or
persisted. Missing required text is traced `justification_required`; malformed text is traced
`invalid_justification`.

Only the dispatcher can populate the reserved trace payload field `agentDeclaration`. Migration 36
atomically records the last pre-cutover event id in existing metadata, accounting for pruned rows
and SQLite's sequence without JavaScript number rounding. The inspector trusts only later rows
and revalidates the selected declaration. Old/unknown provenance and missing/corrupt metadata
withhold declarations; reopening never repairs or moves the boundary. No containing payload is
returned. Human and native-lifecycle identities retain identical mechanical traces with no
fabricated reasoning. A declaration grants no capability, bypasses no grant/consent requirement
and proves neither intention nor compliance.

## Alternatives declined

- Root-only inspection would not implement the ratified broader-delegation choice.
- Letting sponsors read `core.events.list` would expose unrelated workspace history.
- Joining by principal name, shared root id or approximate time would invent lineage and permit
  cross-branch disclosure. Stable native and durable sponsorship ids are required.
- Returning `AgentRun`, `PublicJob` or a general trace payload wholesale would expose more than
  the inspection contract, including credential references or retained-output metadata.
- Storing connection presence, copied trace summaries or agent explanations in another table
  would create a second retention/authority answer.
- Treating a declaration as authorization or verified reasoning confuses claims with facts.

## Evidence boundary

Focused deterministic regressions cover self/sponsor/root authorization, sibling and missing-id
indistinguishability, declaration bounds/redaction and authority precedence, trace paging/exact
selection, native origin pruning, live versus unavailable connections and incomplete cleanup.
Browser cases cover opening an agent row, trace/lineage navigation, safe chain inventory and client/
viewer replacement. Privileged rows and snapshots clear synchronously, and late prior-client
responses cannot revive them.
These cases are authored with this change; execution and visual verification are deliberately
reserved to the integration owner after #553 and #557 are combined. No unrun check is claimed green.
