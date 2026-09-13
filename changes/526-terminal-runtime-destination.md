---
section: Fixed
issue: 526
---

Prepared terminal runtime descriptors now carry the exact machine they were reviewed for. Native terminal admission rejects a descriptor presented to a different destination before reserving a job or creating a terminal, even when both machines report identical installation and resource pins.
