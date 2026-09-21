---
section: Fixed
issue: 718
---

Native jobs now refuse already-exhausted named-output storage before launch and retain bounded storage diagnoses when preparation fails before admission. The owner checks both available blocks and inodes without deleting retained output, resizing storage or weakening whole-backing output budgets. Later workload failures still require their own diagnostic evidence; captured text is not treated as a kernel error report.
