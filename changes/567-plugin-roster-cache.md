---
section: Fixed
issue: 567
---

Reloading a workspace now revalidates its authenticated plugin roster instead of reusing a response authorized before an identity was revoked, so native preview admission begins immediately while preserving local content.
