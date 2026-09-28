---
section: Fixed
issue: 914
---

A replicated hub whose previous instance was stopped before it could seal its replica now starts again on its own instead of refusing. This covers the hosted provider's ten-second stop, a crash, or a lost disk. The new instance waits until the replica has been unchanged for 30 seconds, then takes over. Writes the stopped instance had not replicated are lost (normally at most about one second). A replica that keeps changing still refuses, because another instance is live. A clean shutdown's seal remains the immediate, lossless path. Recovery images from v0.24.0 and v0.25.0 are adopted with `bun run promote vX.Y.Z --adopt-recovery --takeover-writer UUID`. v0.25.0 also sent a hub's replication to the bucket root when `MANIFOLD_REPLICA_PATH` was unset, while restores read `manifold.db`. Replication now uses `manifold.db` as documented. A hub that ran v0.25.0 that way keeps its retained volume as the authoritative history; without a retained volume, set the path explicitly before relying on restore.
