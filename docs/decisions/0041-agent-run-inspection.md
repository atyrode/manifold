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
payload-free projection over authorized identities, not a second general journal reader. It adds
no migration, audit table, output reader or retention policy.

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

The Sessions inventory keeps its former root/revocable-identity view and adds only the exact
inspectable run-chain rows. Non-sponsors with neither relation nor credential-administration
permission remain refused.

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

### Declarations are claims only

Actions publish `agentJustification: "required"`. The smallest initial set covers
`core.access.createAgentRun`, `core.access.renewAgentRun`, `engine.jobs.execute` and
`engine.jobs.schedule`: creating delegated authority, extending it, exercising native execution
and authorizing deferred execution. Reads and cleanup remain unmarked.

An active accountable run may supply `x-manifold-agent-justification` through the shared action
transport. Existing policy/scope/capability/argument checks retain precedence. Both raw and
normalized text are bounded to 512 characters; normalization makes a safe single line and rejects
credential-like material without echoing or persisting the rejected bytes. Missing required text
is a traced `justification_required`; malformed text is traced `invalid_justification`.

Only the dispatcher can populate the reserved trace payload field `agentDeclaration`. The
inspector selects and revalidates that field, never returns the containing payload, and visibly
labels the text as an agent declaration. Human and native-lifecycle identities retain identical
mechanical traces with no fabricated reasoning. A declaration grants no capability, bypasses no
grant/consent requirement and proves neither intention nor compliance.

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
Browser cases cover opening an agent row, trace/lineage navigation and stale result isolation.
These cases are authored with this change; execution and visual verification are deliberately
reserved to the integration owner after #553 and #557 are combined. No unrun check is claimed green.
