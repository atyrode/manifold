---
section: Fixed
issue: 401
---

Slow viewers now catch up through coalesced room edits and presence updates instead of filling their reliable queue and repeatedly rejoining. Incremental recovery keeps active editing intact; larger catch-up uses rate-limited full-state recovery, while sibling room channels remain isolated.
