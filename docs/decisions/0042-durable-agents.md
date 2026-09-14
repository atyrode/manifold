# Agents are durable identities; Runs are bounded invocations

Date: 2026-09-14
Status: accepted
Ratified: operator-directed durable Agent/Run cutover in #578.

## Context

The accountable-run mechanism made autonomous work attributable and revocable, but equated one Run
with one newly minted agent principal. A repeated assistant therefore appeared as unrelated identities,
and any operation keyed by principal could not safely distinguish concurrent invocations once identity
became durable. The external runner also accepted model-visible startup authority declarations instead
of beginning from an Agent selected by a trusted launcher.

A durable Agent needs a sponsor, purpose, harness, standing grant and context that survive individual
Runs. A Run still needs its own policy acknowledgement, bounded authority, credential lineage, activity
and cleanup. A harness session and model selection describe execution; neither is an identity or grant.

This record supersedes **the one-fresh-principal-per-Run identity and sponsor-directed renewal decisions
in ADR 0039** and **the model-visible startup/admission portion of ADR 0040**. It retains their live
authority intersection, exact policy acknowledgement, bounded delegation, action transport and teardown
obligations. ADR 0041's
safe inspection allowlist remains, with Run-only lookup and self/direct-child visibility replacing the
broader ancestor/descendant reading. The normative contracts are
[Automation credential lifecycle](../CONTRACTS.md#automation-credential-lifecycle) and
[Agent run inspection and declarations](../CONTRACTS.md#agent-run-inspection-and-declarations).

## Decision

### 1. Register identity once; admit each Run separately

`core.access.registerAgent` creates the durable Agent and one `kind: "agent"` principal. The request
contains `name`, `purpose`, `harness`, `grant` and `context`. The grant bounds capabilities, target URIs,
reach, maximum Run lifetime, delegation depth/descendant budgets and expiry. Context contains optional
instructions and a profile validated by the selected harness. Repeating the same sponsor/name returns
that Agent with `created: false` and no credential; registration is not a token recovery or rotation door.
Only root or a human sponsor may register. A Run, runner credential or legacy agent principal cannot
register another standing identity and thereby escape the originating Run's delegation and cleanup tree.

The first registration may return the trusted runner credential to its registering human/root sponsor,
including a browser bootstrap. That credential carries Agent-specific `agents:run` admission, not
ordinary effect authority and not the power to reproduce the standing grant. Agent getters and
lifecycle mutations return `{agent,canManage}`. Disabling withdraws current Runs; enabling admits future
work without resurrecting settled Runs. Retirement blocks future admission while preserving the
identity and its history. Human Sessions retain their separate credential administration surface.

`core.access.createRun` selects a registered Agent and optionally narrows caps, target, reach, lifetime
and delegation. It may also bind a typed session and model through trusted admission. Every Run reuses
its Agent principal but has its own `id`, `agentId`, nullable `session`, optional `model`, `activity`,
policy state, expiry and credential binding. Multiple concurrent Runs must never become one authority
or audit record because they share a principal.

Only the matching Agent runner receives the new Run bearer. Owner/browser admission returns `{run}`;
raw registration credentials and Run credentials are not fields in Agent or inspection inventories.
`createChildRun` names a parent Run, defaults to that same Agent and requires bounded justification and
`agents:delegate`. Naming a different registered Agent also requires authority to run that Agent.
The public result permits an absent credential because browser/root admission must not disclose one;
trusted runner consumers require a credential when their own admission contract promises it.

### 2. Live authority and cleanup are Run-specific

The standing grant is a ceiling, never a replacement permission evaluator. Admission and every effect
intersect the sponsor's live waterfall authority, the Agent's current grant, the Run ceiling and policy
state, and every parent Run at the actual target. Named refusals such as `agent_disabled`,
`grant_expired`, `cap_exceeds_grant` and `session_binding_untrusted` remain identity answers under the
action ladder's generic refused rung. The Access handlers relay; they do not re-authorize.

Registration declares no workspace capability check and uses `runAccess: "delegate"` so the identity
mechanism evaluates the proposed target grant. Run admission, launch, input, activity and renewal use
`runAccess: "runner"`; Agent and Run getters use `inspect`; child creation uses `delegate`. These are
lifecycle admission categories, not bypasses for the mechanism's actor-relative checks.

Runs begin `pending_policy`. Exact bundle acknowledgement activates them; changed trusted policy makes
open work stale until it acknowledges the replacement bytes. A durable Agent's acknowledgement summary
does not silently acknowledge another Run. Renewal stays bounded by the current grant, parent expiry,
one-hour maximum lease and 24-renewal limit. Child delegation retains the maximum four levels and 32
descendants, including stricter ancestor budgets.

Renewal is a harness concern: only the Run's own credential or its matching Agent runner may receive
the replacement bearer. Browser sponsors, root and a parent Run acting only as parent cannot renew.
Refusal neither mints a replacement nor revokes the harness's existing credential. Renewal replaces only
the selected Run's credentials and their grants. Finishing or expiring a Run withdraws only its Run
subtree. Sibling Runs, the durable Agent runner credential and supplied sponsor credentials are not
cleanup targets. Generic principal revocation fences every affected descendant principal, including
cross-Agent children, once after settlement commits. Credential and trace attribution use Run bindings
rather than a principal-wide lookup. Activity is a separate trusted observation: `done` is not a finish
operation and `unknown` is not proof of either work or idleness.

### 3. Harness integration is typed and keeps launch secrets private

Harnesses publish profile schemas and typed `SessionRef {harness,sessionId,machineId}` values through the
existing host interface. `listHarnesses`, `listHarnessSessions` and `resolveHarnessSession` expose those
contracts; `sendRunInput` uses the selected harness, and `reportRunActivity` is restricted to its trusted
runner or the Run's own credential. Agent profile/context and harness input have opaque traces.
Session enumeration returns at most 100 bindings and an explicit `truncated` flag; retained history
beyond that bound must not turn a valid inventory into an output-validation failure.

For an owner/browser-created Run, `launchRun` returns a secret-free terminal runtime, destination,
SessionRef and review digest. The trusted terminal admission path injects `MANIFOLD_RUN_TOKEN`,
`MANIFOLD_RUN_ID` and `MANIFOLD_ORIGIN` through a private machine-launch environment seam. Public terminal
runtime/environment fields, browser results, prompts and trace payloads never carry that bearer. A
client cannot turn a copied public runtime into authority by supplying an arbitrary private environment.

Private launch carriers require machine protocol 32 and native owner RPC 35. The hub keeps protocol
30/31 transports connected for existing work but refuses managed launch on older transports or owners
before sending any credential. Deploy the hub first and upgrade spokes when their work permits.

This is not same-OS-user isolation. Where Linux permits same-user process inspection, the wrapper's
initial Run credential may remain readable through `/proc/<pid>/environ` even after environment entries
are deleted. It is an expiring, Run-scoped credential, never a sponsor or Agent-runner secret; its
authority remains bounded by scope and expiry. Model-authored native code requires a separate OS-user
or equivalent isolation boundary if it must not observe the wrapper's credential.

The trusted external launcher binds an existing Agent or adopts an already admitted Run before reading
untrusted model input. The model does not choose the sponsor, standing grant or root identity in a start
frame. Child requests remain narrowing, and the runner keeps credentials out of its model-facing output.
The explicit `external` harness still supports `taskRef`, labeled **legacy external task reference**;
that string is neither a typed session nor proof that a session was resolved. Native typed harnesses do
not accept it as a substitute for session binding.

### 4. Inspection stays a bounded projection, not a second journal

`listRuns({agentId?})` returns `observedAt`, at most 100 authorized summaries and `truncated`. Summaries
include Agent/session/model/activity, normalized purpose/name, parent, expiry and action/refusal counts.
`inspectRun({runId,...pagination})` uses the retained #557 allowlist. It has no principal-id selector:
a principal can own several Runs, so that lookup cannot select one invocation truthfully.

Root sees all Runs. A Run sees only itself and direct children, never ancestors, grandchildren or
siblings. Sponsors see descendants through verified sponsorship; an Agent runner sees its Agent's Runs.
Every lineage link and source record is narrowed to the viewer. No bearer, credential reference, profile,
raw argument, native environment, terminal output or policy body enters this projection. Retained-only
history, unavailable native origins, pending traces and unconfirmed cleanup keep their explicit labels.
The Agents section owns Agent/Run navigation; human Sessions keep the existing credential inventory.

Agent and Run changes publish empty-payload `agent_changed` and `run_changed` notifications through
the existing event plane. Native Agent/Run topics, including their Access collection fan-out, recheck
the same sponsor and Run-relative visibility at delivery; collection subscriptions are not an oracle
for another sponsor's profiles. A Run mutation also announces its owning Agent so profile counts and
activity can refresh without polling.

### 5. Migrate retained facts; remove superseded doors

Migration 37 maps each legacy Run principal to a durable external Agent with that principal's id as its
Agent id. It preserves Run ids, sponsor/tree/credential lineage, policy snapshots and the declaration
trust cutoff. Legacy `taskRef` stays on its original Run; session starts null, model absent and activity
unknown. Run-specific token/event/native correlations preserve retained attribution before the old
one-Run-per-principal uniqueness constraint is removed. The migration is transactional and refuses loss
or corrupted lineage rather than fabricating a replacement history.

`createAgentRun`, `listAgentRuns` and `inspectAgentRun` are removed, not aliases. Consumers register an
Agent, then create or adopt a Run, and inspect by Run id. The existing policy, acknowledgement, renewal,
finish and reload doors remain. This is a coordinated breaking action/schema cutover, not a second
identity admission mechanism alongside the old one.

## Alternatives and dependency assessment

**Keep a fresh principal for every invocation and group by name.** A display grouping cannot supply a
stable owner, standing grant or harness context, and name matching is not authorization.

**Use the durable Agent's principal as the Run key.** Concurrent Runs then share renewal, revocation,
activity and history. Credential/Run bindings are necessary to preserve independent lifecycles.

**Return the launch bearer to the browser in the runtime environment.** This makes inspectable launch
metadata a credential carrier. The private terminal admission seam keeps public launch plans reusable
as data without giving them authority.

**Retain model-visible root startup alongside trusted binding.** Two admission modes would let the less
trusted actor choose sponsor or grant material the launcher was meant to own. The cutover removes it.

No new general-purpose dependency is selected by this decision. Durable records use the existing SQLite
store, authority uses the existing AuthService waterfall, schemas use protocol Zod contracts and harness
launch uses the existing plugin/terminal host interfaces. No new foundation pillar or control plane is
introduced.

## Evidence boundary

This record defines the coordinated server, protocol, runner and browser contract. The integration must
prove repeated registration returns no second credential; concurrent Runs survive sibling renewal and
settlement; browser admission and launch disclose no bearer; child widening is refused; exact policy
still gates ordinary actions; and self/direct-child inspection cannot cross branches. Migration must
preserve retained ids and policy/trace attribution. A source change alone is not deployed or live harness
verification, and a public runtime schema alone does not prove the private launch seam.
