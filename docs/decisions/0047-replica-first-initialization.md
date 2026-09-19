# 0047 — Replica first initialization requires a one-attempt acknowledgement

Date: 2026-09-19
Status: accepted
Ratified: 2026-09-19, issue #385's approved fail-closed replica-bootstrap contract

## Context

The ordinary replicated-container entrypoint previously asked Litestream to restore only if a
replica existed and then started the server either way. When both the local volume and the configured
replica contained no history — including when configuration named the wrong empty location — opening
the server created a new hub and replication made that database the new history.
The same outcome represented two incompatible operator intentions: deliberately create the first
database for a new hub, or recover an existing hub whose history must not be replaced.

The replica contains authority-bearing state. Silence at restore time is therefore not evidence that
new authority may be created. At the same time, a genuinely new replicated installation needs one
explicit path through the otherwise fail-closed gate. That path must survive the short gap between a
Compose one-shot command and service startup, but must not become ambient permission for an empty
boot days or failures later.

This decision concerns ordinary `manifold.db` replica bootstrap only. It does not change the
full-state checkpoint and recovery-image procedure, recover files outside `manifold.db`, authenticate
an untrusted replica, permit overlapping writers, or grant authority to exercise against a live
instance.

## Decision

### 1. Preparation is the only replicated startup gate

With replica configuration present, the ordinary entrypoint runs
`bun scripts/replica-bootstrap.ts prepare` before it may execute either Litestream replication or the
server. Preparation has four terminal states:

- **valid local** — an existing `manifold.db` passes a read-only SQLite integrity check and carries a
  positive schema version supported by this image;
- **restored** — no local database existed, the bounded real Litestream restore produced a usable
  staged database, and that file was published exclusively;
- **initialized** — the restore succeeded but produced no database, and this attempt had already
  consumed a valid first-initialization acknowledgement, so the existing exported database opener
  initialized the staged database before exclusive publication; or
- **refused** — every other outcome, including zero-byte, foreign, corrupt, or future-schema local
  data; an invalid acknowledgement; restore failure or timeout; or an empty replica without an
  acknowledgement.

Refusal is terminal for that container start: neither `litestream replicate` nor the server runs.
An existing local file is never interpreted as absence and is left in place. Restore occurs in a
private directory on the same data filesystem, uses a 300-second timeout and Litestream's full
integrity check, and publishes without replacing a concurrently created destination. Cleanup removes
only staging owned by that run.

### 2. Acknowledgement grants one empty-replica attempt, not a mode

`bun scripts/replica-bootstrap.ts acknowledge` is the explicit first-initialization command. It
refuses while a local database exists and otherwise exclusively creates
`<MANIFOLD_DATA_DIR>/.replica-init-once.json` with mode 0600. The record expires after 15 minutes and
binds by digest to the configured replica target. The command neither starts a hub nor contacts or
modifies the replica.

At the beginning of the next preparation attempt, a valid acknowledgement is consumed and its removal
synchronized before the restore. It is consumed whether that restore succeeds with history,
succeeds empty, fails, or times out. An invalid, expired, or target-mismatched record refuses rather
than being ignored. Only a zero-exit restore that produces no database may use the consumed intent to
initialize. A restore failure is never converted into an empty-replica result.

The ordinary Compose runbook invokes `acknowledge` with the service's normal image, data volume, and
environment, then starts the service within the expiry. Before doing so, the operator inspects the
configured bucket or prefix and confirms it is the intended new replica. There is no long-lived
environment boolean that enables initialization.

### 3. Recovery, integrity, and observability remain separate

First initialization does not authorize deleting or replacing replica history. Invalid local data is
preserved; an operator snapshots or quarantines it for inspection as a recovery act and inspects the
intended replica rather than clearing the store to get past the gate. Full-state recovery remains the
separate authenticated recovery-image procedure and retains its setting refusals in the ordinary
image.

The existing operational assumptions remain: one writer owns a replica path, the replica store and
its write administration are trusted for integrity, and Litestream covers `manifold.db` rather than
the rest of `/data`. Bootstrap diagnostics are structured non-secret `evt`/state records. Raw child
stderr, object-store endpoints, credentials, and database content are not logged.

The normative operator procedure is in `docs/SELF-HOST.md` §Replicate the database. The normative
runtime and persistence rules are in `docs/CONTRACTS.md` §Persistence.

## Alternatives rejected

- **Keep permissive boot and strengthen the warning.** A warning cannot distinguish an intentional
  empty replica from missing history before the new server writes replacement history. Authority-
  bearing persistence must fail closed.
- **A persistent environment boolean such as `MANIFOLD_ALLOW_EMPTY_REPLICA=1`.** Deployment
  configuration is copied, retained, and reused. It would turn a one-time decision into permission
  for every later empty boot, including a wrong endpoint or lost bucket.
- **Accept a marker until initialization eventually succeeds.** Intent left after a failed restore
  can authorize a later, materially different attempt. Consume-before-attempt makes every retry a
  new operator decision after inspection.
- **Treat any existing path as a database.** A zero-byte, foreign, corrupt, or future-schema file
  would bypass restore and fail later under less controlled conditions. Read-only validation keeps
  invalid evidence intact and prevents server migrations from changing it.
- **Restore directly onto the live pathname.** Failure, cancellation, or a concurrent writer could
  expose a partial database or overwrite evidence. Same-filesystem private staging plus exclusive
  publication gives a single visible transition.
- **Use first initialization as recovery.** It cannot recover adjacent files, authenticate hostile
  storage, or prove missing history is intentional. Conflating it with the full-state procedure
  would weaken both contracts.

## Consequences and proof boundary

A brand-new replicated hub now requires an explicit one-shot command before its first service start.
Existing replicated hubs with a valid local or restorable database need no acknowledgement. Missing
or failed history, invalid local data, and newer schemas refuse before replication or service
startup, so operators must inspect the configured target and choose the appropriate recovery path.

This decision requires proof with isolated fixtures and automated coverage; it does not claim
verification against a live deployment, production bucket, or provider control plane. Provider
versioning, retention, encryption, restore rehearsal, trusted-storage integrity, and the
single-writer rule remain operator responsibilities documented in `docs/SELF-HOST.md`.
