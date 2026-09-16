---
section: Fixed
issue: 633
---

Production promotion now requires an authenticated full-state checkpoint and restores it with the exact previous release when a one-way database migration makes code-only rollback unsafe.
