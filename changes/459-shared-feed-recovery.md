---
section: Fixed
issue: 459
---

Shared-feed consumers can clear a transient read error after an unchanged successful response through the optional `onSuccess` callback. Unchanged data still keeps its existing snapshot, and held or detached reads do not report recovery.
