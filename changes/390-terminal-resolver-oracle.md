---
section: Fixed
issue: 390
---

Terminal reference resolution no longer reveals whether an unreadable terminal exists: scoped readers now receive the same successful nonexistence response for foreign and missing terminal IDs, while readable terminals still resolve normally.
