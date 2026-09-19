---
section: Breaking Changes
issue: 385
---

A replicated container no longer creates a new hub when both its local database and configured replica history are absent. Startup now validates any local database, restores into private staging, and refuses before replication or the server on invalid local data, restore failure, timeout, or an unacknowledged empty replica. Operators creating an actually new replicated hub must first run `docker compose run --rm --no-deps --entrypoint bun manifold scripts/replica-bootstrap.ts acknowledge`, then start the service within 15 minutes; that target-bound acknowledgement is consumed by the next attempt even if restore fails and is not a recovery or replica-overwrite mechanism.
Orphan SQLite journals are preserved and refused rather than applied to restored history. If an acknowledgement expires or the replica configuration changes, use the same Compose command with `discard` to withdraw it before inspecting the target and making a fresh initialization decision; discarding alone never permits an empty boot.
