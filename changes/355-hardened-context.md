---
section: Fixed
issue: 355
---

Hardened plugin bundles now fail loading with clear repacking guidance when they predate the bounded runner transport; current bundles retain their strict trace-bearing context, and future context additions require explicit negotiation.
