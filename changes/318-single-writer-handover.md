---
section: Breaking Changes
issue: 318
---

Replicated hub startup now proves its new writer claim in the replica before serving, even with a valid retained local database. Unavailable, untracked, conflicting or active restored history is refused rather than opened with uncertain acknowledged writes. Existing untracked replicas therefore need a reviewed offline adoption from an authenticated, quiesced full-state checkpoint into a new dedicated replica target; initialization intent is not a migration shortcut. Clean shutdown quiesces the application and proves a final replica seal, including matching auxiliary databases for an authenticated recovery image running the actual previous application. Compose now grants six minutes for that shutdown; other supervisors need equivalent grace and whole-process teardown. A local SQLite writer fence also prevents two handover-aware servers sharing one data directory from writing together, and admitted requests get a bounded completion window before new traffic receives `503` with `Retry-After: 1`. These changes do not provide cross-host fencing, reconstruct an unreplicated tail after disk loss, or eliminate the reconnect gap.
