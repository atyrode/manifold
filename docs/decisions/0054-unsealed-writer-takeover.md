# 0054 — A stopped unsealed replica writer is taken over with bounded loss

Date: 2026-09-28
Status: accepted
Ratified: 2026-09-28, operator decision recorded on issue #914

Amends the replica freshness contract from [#318](https://github.com/atyrode/manifold/issues/318).
The living specifications remain [CONTRACTS.md](../CONTRACTS.md#persistence-sqlite-wal-server-only) (Replica freshness
before serving) and [SELF-HOST.md](../SELF-HOST.md#replicate-the-database-optional).

## Context

Since v0.24.0 the replica supervisor admitted restored history only when the previous writer had
sealed it. The seal is the last step of a shutdown sequence that stops the application, stops
replication, restores and fingerprints any auxiliary database, writes the seal, replicates it and
confirms it by a further restore. Compose grants six minutes for this.

The hosted provider sends SIGTERM and kills the container about ten seconds later. This was
measured on a disposable application for three cases: a failed deploy, a healthy instance replaced
by a deploy, and a restart. In every case the replacement started only after the kill. Production's
recovery instance was stopped that way during a promotion, so its seal never landed and the
candidate refused with `replica_writer_unsealed`.

The rule therefore made every restart, crash and deploy of a replicated hub without a durable
volume fail closed. Production could neither upgrade nor survive a provider restart. The seal
answered a real question, whether the restored history is complete, but refusing was the wrong
default answer where the stop grace cannot fit the proof.

## Decision

The sealed handoff remains the zero-loss path. It is no longer a start precondition.

While the application runs, the supervisor advances a heartbeat bound to its claim,
`meta['replica-writer-heartbeat']`, every five seconds. The heartbeat is replicated like any
other write.

When restored main history names an `active` writer, startup observes the replica's latest
position: the maximum transaction id over every level of every configured database.

- If that position stays unchanged for 30 seconds within a 150-second deadline, startup restores
  again, requires the same writer identity, and publishes that history. It logs
  `replica_takeover`, and the supervisor claims the next epoch as usual.
- If the position keeps advancing, a writer is still live: startup refuses `replica_writer_active`.

A writer that stops without sealing loses only the writes it had not yet replicated. That is
normally Litestream's one-second sync interval, and longer if a replication outage was in
progress at the stop.

Writers from v0.24.0 to v0.25.0 wrote no heartbeat, so an idle live one cannot be told from a
dead one. Taking over such a writer also requires `MANIFOLD_REPLICA_TAKEOVER` to name that
record's UUID. The promotion workflow sets this value only for an adoption the operator names,
and clears it afterwards. The candidate's own claim changes the UUID, so the value cannot
authorize a later takeover.

To make the zero-loss path likely under a ten-second grace, a configuration without auxiliary
databases writes its seal as soon as the application stops, before replication stops. A kill
that lands earlier leaves a heartbeat-bearing claim, which the next start takes over.

## Consequences

- Restarts, crashes and deploys on the hosted provider recover without an operator. The cost is
  the bounded loss above, plus at least a 30-second quiet window and the restores around it; a
  replica still settling after the stop can extend the wait up to the 150-second deadline.
- Unchanged refusals:
  - a live writer sharing the replica
  - newer or conflicting epochs
  - untracked or empty history without initialization intent
  - invalid records
  - unavailable storage
- Not solved: a writer that is cut off from storage for longer than the quiet window and later
  reconnects is not fenced. The single-instance, stop-before-start topology that the promotion
  workflow requires remains the boundary, as it was for the seal.
- A completed seal still admits immediately with no loss. Operators whose orchestrators grant
  the longer grace keep today's behaviour.

## Evidence boundary

The provider behaviour is measured, not documented. Correctness of the takeover rests on unit
coverage of the admission policy and on a real-image rehearsal with Litestream against S3-compatible
storage. Production evidence is recorded on #914 and #906.
