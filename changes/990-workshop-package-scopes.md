---
section: Fixed
issue: 990
---

Live plugin authoring now keeps anonymous module-format and subpath-entry metadata within its enclosing dependency package. Valid sibling imports in modular dependencies such as Zod no longer cancel source leases and leave stylesheet imports unavailable. Named/private package boundaries, unregistered-file denial, and installation-required dependency edits remain enforced.
