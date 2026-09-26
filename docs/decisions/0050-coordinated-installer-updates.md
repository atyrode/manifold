# 0050 — Coordinated, installer-owned Manifold updates

Date: 2026-09-26
Status: proposed

## Problem and boundary

A release publishes immutable artifacts; deployment promotes a hub build; a fleet source pin names
future desired input; local activation changes a running generation; and a process restart may not
change any of these. None alone is an update of the hub and its machines. The current machine doors
manage enrollment and admission, not software installation. A successful switch or healthy socket
does not prove the expected build is serving, machine transport rejoined, or retained terminal and
job work survived. Operators need one reviewed plan, one bounded apply, inspectable progress, and a
recovery route that works even when the hub or reporting transport is unavailable.

This is a **proposed design, not implemented behavior or installation authority**. The operator's
2026-09-26 decision on [#689](https://github.com/atyrode/manifold/issues/689) authorizes design
review only. Later implementation slices require their own triage. In particular, this record does
not authorize a provider operation, production/fleet installation, owner stop, version bump, or
unattended policy. Existing deployment and maintenance contracts in
[SELF-HOST](../SELF-HOST.md#environments) and [CONTRACTS](../CONTRACTS.md#terminal-host-lifecycle)
remain authoritative.

## Options and tradeoffs

| Option                                                                             | Benefit                                                                                                                              | Cost and disposition                                                                                                                                    |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Document the existing release, fleet-pin and manual SSH choreography as the update | No new privileged surface                                                                                                            | Cannot bind one approval or show installed versus serving state; a dropped browser, transport or hub loses the sequence. Reject.                        |
| Give the hub or a machine job a generic package writer/provider credential         | One apparent command for every target                                                                                                | Machine tokens and job permissions would become host replacement authority, duplicate Nix/provider ownership, and risk killing retained owners. Reject. |
| Add a separate always-on fleet deployment controller                               | Can continue while the hub is down                                                                                                   | Competes with installer/provider desired state and introduces another credential store, audit plane and durable writer. Reject.                         |
| **Compose one product operation with installer-owned activation**                  | Common review/status surface; the existing installer or provider remains the sole writer, and its receipt can outlive the connection | Needs narrow local/provider integrations, continuation receipts and explicit recovery per target; supported modes are finite. **Recommend.**            |

## Recommended contract

### One operation, four verbs

The product-facing update domain belongs above the foundation as a discoverable plugin/action
integration. A single typed plan/apply/status/recovery contract is presented by the UI and by
API/CLI through the **same** action, permission and trace path; no UI-only installer shortcut,
hidden administrative HTTP route or generic shell door. Any neutral foundation addition must
separately satisfy [AXIOMS.md §Foundation law](../../AXIOMS.md#foundation-law), with its own ADR
and registry change. The following fields are design obligations, not published wire schemas:

| Verb                 | Input and result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Plan** (read-only) | Select an exact published release/image and explicit hub/machine IDs; resolve platform, active build, staged/installed candidate, source pin, installer owner, incumbent generation/process, compatibility and required artifact provenance. Return per-target exact candidate digest/revision and incumbent identity, effects/disruption fingerprint, expected interruption, dependency/order, recoverable checkpoint, offline/unsupported/refused targets and any retained-owner hold. Never assume a pin or installed candidate is active. No mutation or credential disclosure.                                                                                                                                   |
| **Apply**            | Supply the plan identity and a separate review/approval reference (or, in a later separately ratified bounded policy, its exact policy decision). Re-read the incumbent, candidate, installer-owned effect report, authority, compatibility and recovery availability under that owner's activation lock immediately before mutation; changed or unknown evidence invalidates approval and requires a new plan. Stage immutable verified artifacts before activation; ask the owning installer/provider to perform only its reviewed step. Return a durable operation ID immediately; the requesting browser is not its executor.                                                                                     |
| **Status**           | Read the operation and per-target receipts: `not_started`, `staged`, `activating`, `interrupted`, `applied_unverified`, `verified`, `deferred`, `unsupported`, `refused`, `recovery_required`, `recovered` or `recovery_failed`, with timestamps, installer identity, candidate/incumbent, current observation, holds and next safe action. `verified` requires active build plus effect/continuity proofs; a green workflow, source-pin PR, installed artifact, live PID or socket alone is not success. Offline and externally managed targets cannot be counted as upgraded.                                                                                                                                       |
| **Recovery**         | Inspect the exact operation, target, incumbent and installer/provider receipt; fence competing or superseding attempts. If activation is known not to have started, leave incumbent alone; if state is uncertain, reconcile actual owner/provider and active-build evidence before any retry. Use the owner's supported compare-and-swap rollback or authenticated full-state recovery where code-only rollback is unsafe. The hub-available verb and the documented local/provider recovery route interpret the same operation/receipt, so a dead hub cannot be the only keeper of the next action. Recovery is separately authorized for its exact effects and never blindly replays an uncertain destructive step. |

A plan is immutable for approval purposes: bind the target IDs, release/tag/source SHA and artifact
digests, each incumbent's active build and owner/generation identity, installer identity, all
disruptive effects (including services outside Manifold), compatibility policy, checkpoint and
recovery method, and an expiry. A changed candidate, incumbent, effect fingerprint, target set,
revoked grant, expired plan or changed policy invalidates the authorization; narrowing a target
must not silently repurpose a broader approval. Installer-side compare-and-set/idempotency keyed
to the exact target and candidate protects duplicate delivery. An interrupted attempt must be
reconciled from installer/provider receipts and current observations, not reissued blindly.
Preserve non-secret references to credentials and artifacts in plans/traces; existing installer,
provider, machine and owner tools keep the actual keys. Ordinary job execution, `machines:mint`,
a machine enrollment token, owner-key possession, release publication and CI success do **not**
confer software replacement or provider authority. Product permission to request an update is
necessary but not sufficient: a separately granted local installer or provider principal must
approve the exact effect at its boundary, with revalidation there.

The governed operation records intent and attribution durably through existing action/trace/job
mechanisms, while the installation owner records execution and outcome. The transport being
replaced cannot be the only executor or receipt carrier. For hub replacement, continuation must
be in an already authorized provider workflow/local installer outside hub process memory; only
one SQLite writer may serve at a time, including rollback. Status reconciles both receipt and
observed hub/machine build after reconnect; it must not imply that a platform-specific provider
step or native job is itself the general update authority. Do not expose privileged provider
credentials, owner keys, signed permits or their values in args, plans, logs or traces.

### Supported installer matrix for the first implementation

This is the **proposed first-wave matrix**, not a claim that these integrations exist. A target
without an identifiable owning installer, effective authorization or a recovery route returns
`unsupported`/`refused` at planning, before any disruptive step; compatibility does not silently
upgrade a target into the matrix.

| Target / installation mode                                                  | Owner and candidate-bound activation                                                                                                                                                                                                                                                                                                                                                                        | Continuity and recovery boundary                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux x64 spoke under NixOS or standalone Home Manager                      | Its existing Nix/Home Manager generation and `atyrode apply` path build and analyze an exact candidate closure; the disruption report fingerprint binds host, incumbent generation, candidate generation and every service effect. Activation rechecks under the existing lock. Manifold asks this authority to apply the reviewed generation; it never rewrites a unit, store path, pin or profile itself. | Ordinary transport replacement preserves the separate terminal/job owner process and old store roots. If the report includes owner disruption, hold for the distinct owner procedure. Existing installer rollback/recovery must be candidate/incumbent bound. A source-pin PR is desired input, not activation evidence.                                                   |
| Darwin arm64 spoke under nix-darwin (and its configured Home Manager layer) | `atyrode apply` analyzes the exact candidate before invoking nix-darwin's own profile/activation path. Use its launchd and generation effect report, not Linux `systemctl` assumptions or a downloaded executable replacing the managed process.                                                                                                                                                            | Same owner-versus-transport distinction; prove owner identity, retained work and usable terminal I/O. Reconcile the activated generation and running build; unsupported supervision or missing impact evidence holds.                                                                                                                                                      |
| Hosted hub on the existing Clever Cloud provider                            | The existing release attestation, immutable OCI digest, installed-bundle check, `deploy-hub.yml`/Clever Cloud activation and exact-CI/promotion gates remain the authority. A reviewed update invokes that route; it does not create another provider writer or turn an Actions job into a machine grant.                                                                                                   | Reuse the exact incumbent image and pre-switch authenticated full-state checkpoint/receipt, live snapshot, `verify-live` and the established provider rollback/recovery path. One durable SQLite writer; #318's safe handoff and availability work is a separate prerequisite for a no-503 claim. A failed recovery remains failed and visible, not a successful rollback. |
| Explicit retained terminal/native-job owner maintenance                     | **Not an ordinary transport update.** `core.machines.drain` closes admission, ordinary terminal/job lifecycles resolve all retained work, then `manifold-agent --maintenance shutdown` binds exact terminal-host ID and expected supervisor PID and accepts only an atomic drained-and-empty acknowledgement. The owning supervisor/installer alone replaces the approved owner.                            | A mismatch, nonempty terminal or native workload, unknown protocol or absent acknowledgement is a hold, not a signal/force fallback. Keep admission drained through activation and proof of the named new owner and its work, then explicitly reopen. Owner shutdown, lost terminal work and package activation never hide inside ordinary approval.                       |

These two spoke architectures are the published fleet binary assets, not the whole Nix build
matrix. Linux arm64 and Darwin x64 have flake build outputs (and the native NixOS module covers
Linux arm64), but no published fleet binary assets; they require a separately specified exact
artifact/provenance and installation path before entering this coordinated release-binary flow.
Existing `atyrode fleet apply` is Linux-only; the Darwin adapter must use a narrowly authorized
local activation path, not assume Linux remote apply exists.

Self-hosted native hubs and arbitrary containers/package managers/providers may continue using
existing documented release and manual recovery procedures, but are **not** implicitly supported
by this first-wave coordinated operation. A later adapter needs an explicit installer, privilege,
artifact-trust, supervisor and rollback contract; no arbitrary download-and-execute or SSH command
is a substitute. SSH remains a documented local/bootstrap recovery route for an unavailable hub,
not a machine enrollment or routine-update prerequisite. The hosted hub's fleet-pin dispatch
proposes source state only; it must wait for verified activation rather than count a dispatched pin
as every spoke updated. Offline machines remain deferred with a named catch-up decision; no
unbounded automatic activation on reconnect.

### Transition and existing-work ordering

Plan compatibility across the hub, machine transport, local terminal-host IPC and native job-owner
RPC independently. For an ordinary compatible release, stage and verify the local transport
activation/recovery path before moving the hub; after hub activation replace only transport seats
through the installer, and require original owner/terminal identity, workload PID, terminal IDs,
I/O and native-service readiness after reconnect. An owner can remain on an older supported RPC;
its owner-only features may be held without refusing a compatible transport update. For a
cross-protocol change, prepare executable spoke activation and recovery **before** the hub switch;
if the native owner must change, first drain and resolve retained work with the incumbent hub,
then obtain exact-owner empty shutdown before new owner, hub and transport activation, readiness
and reopening. No plan may depend on a source-pin merge or human timed shell command inside the
hub's live-verification deadline; missing preparation is a refusal, not a stranded fleet.

Reuse rather than absorb adjacent work: [#318](https://github.com/atyrode/manifold/issues/318)
owns safe single-writer cutover and measured public availability, so this design promises no zero
downtime; [#238](https://github.com/atyrode/manifold/issues/238) owns third-party plugin release
feeds, consent/diffs and family-set replacement, while core plugins ride the Manifold release and
this operation consumes compatibility/hold evidence; [#633](https://github.com/atyrode/manifold/issues/633)
retains its immediate authorized maintenance path and bootstrap/repack gate, with authenticated
full-state recovery from [#687](https://github.com/atyrode/manifold/issues/687).
Do not make #633 wait for an unimplemented updater or treat its explicit exception as ordinary
verified readiness. The broader configuration integration of
[atyrode/dotfiles#603](https://github.com/atyrode/dotfiles/issues/603) remains separately owned:
this operation governs lifecycle and audit, and its installer remains the only declarative writer.

## Non-goals

- No implementation, fleet/provider mutation, automatic update policy or standing privilege grant
  follows from this record. Start with explicit operator-triggered approval; any unattended policy
  requires separate review of artifact trust, compatibility, maintenance eligibility and bounded
  effects without weakening verification.
- No arbitrary OS/package update, generic remote shell, Nix-store or managed-unit rewrite, second
  desired-state controller, or promise that every native/self-hosted installation is supported.
- No owner hot-swap, automatic PTY cancellation, forced supervisor teardown or assumption that a
  preserved tile proves its original workload survived.
- No standalone plugin updater; no weakening of installed-bundle holds, release attestation,
  existing provider gates or the distinct promotion/fleet authorization boundaries.

## Verification and evidence expected of later slices

Show fail-closed planning for unsupported/ambiguous installers, offline machines, mismatched or
revoked/expired approvals and changed incumbent/candidate/disruption fingerprint **before** any
installer write. Demonstrate duplicate delivery and interruption around each owner/provider
boundary: receipts distinguish not-started, applied-but-unverified and verified; reconcile an
unknown outcome without a second destructive activation. Prove browser and headless clients use
the same discoverable authority path and can resume status after disconnection. Exercise two
consecutive ordinary updates through real NixOS/Home Manager Linux and nix-darwin supervisors and
the hosted provider, inspecting installed candidate, source pin and **actual active** builds
separately. Verify owner ID, workload PIDs, terminal IDs, subsequent input/output, native job and
service readiness, and offline catch-up/refusal after replacement. Exercise candidate start/admission
failure, cross-protocol ordering, hub loss, owner-held work, provider rollback and incompatible
schema recovery using the exact authenticated full-state receipt; measure public HTTP/action,
WebSocket and terminal continuity for #318 rather than claiming zero downtime. Keep secrets out of
evidence, and retain regression coverage only where a plausible authority, state, delivery or
ownership bug would fail. No such runtime evidence is claimed by this design PR.

## Ordered implementation slices for separate triage

1. **Contracts and authority:** ratify the living spec/API/CLI/UI schemas and discoverable plugin
   doors, installer/provider adapters, exact plan/approval permission, credential custody, durable
   receipt shape and support/refusal matrix. Admit a foundation change only through its existing
   ADR/registry process. Explicit operator-triggered mode first.
2. **Read-only inventory and planning:** observe active versus installed versus pinned builds,
   installer/incumbent/effect evidence, immutable artifacts, plugin compatibility, owner holds,
   checkpoint availability and offline machines; reject ambiguity without mutation.
3. **Candidate-bound staging and local adapters:** stage verified artifacts and implement the
   narrowly authorized Linux/Home Manager and nix-darwin `atyrode apply` integration and
   installer-owned compare-and-set receipts, plus candidate start/failure recovery, without
   touching retained owners.
4. **Durable apply/status/recovery:** join action/trace/job lifecycle with installer/provider
   receipts, duplicate-delivery fencing, reconnect reconciliation and the local/provider command
   usable without the hub; prove browser disconnect and transport replacement do not erase truth.
5. **Hosted hub and fleet coordination:** compose the existing exact-CI, release image, installed
   bundles, checkpoint, provider switch/rollback, live verification and separately authorized
   pin follow-through; stage cross-protocol transports before switch and preserve #318's one-writer
   handoff and #238's independent plugin-update authority.
6. **Exceptional owner maintenance:** expose an explicit separate reviewed owner effect using
   `manifold-agent --maintenance`, atomic exact-ID/PID empty acknowledgement, installer replacement,
   verification and deliberate reopen; never promote a routine transport approval to that effect.
7. **End-to-end proof and runbook cutover:** exercise two actual Linux/Darwin/provider updates,
   interrupted and failed transitions, original workload continuity and authenticated recovery;
   only then remove obsolete per-machine ordinary-update choreography and keep concise offline
   local/provider recovery instructions. Reconcile #633's already-authorized work without
   reclassifying its bootstrap exception as an updater success.
