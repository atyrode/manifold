---
section: Fixed
issue: 386
---

Clarify the durable pre-migration checkpoint and operator-controlled retention required for volume-less deployments. Database replication does not preserve adjacent migration snapshots or provide full-state rollback; retain and verify the checkpoint, recovery material and compatible release image independently of the disposable volume.
