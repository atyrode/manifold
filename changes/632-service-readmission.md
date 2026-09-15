---
section: Fixed
issue: 632
---

Enabled native instance services automatically recover after a plugin hold, installation interruption or owner restart clears, including when the hub rolls back to a build that never held the plugin. Recovery waits for confirmed workload closure and current admission checks, records the previous job and cancellation reason, and never overrides disabling, explicit credential revocation or retirement.
