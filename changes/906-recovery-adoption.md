---
section: Fixed
issue: 906
---

A replicated hub that fell back to the authenticated recovery image after a failed promotion can now return to the ordinary image without a durable volume. The optional `MANIFOLD_REPLICA_PATH` selects the replica object path (default `manifold.db`, validated before any restore), and `bun run promote vX.Y.Z --adopt-recovery --recovery-receipt PATH` continues the recovery image's sealed history using a fresh checkpoint captured from that image, rather than refusing every promotion while recovery settings are active. Unsealed, inherited or stale recovery state and candidates that cannot read the path are still refused.
