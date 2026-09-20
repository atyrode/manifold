---
section: Fixed
issue: 395
---

CI and release now refuse stale workspace version metadata in `bun.lock`, even when frozen dependency installation succeeds. Regenerate the lock with the supported Bun runtime before committing workspace version changes.
