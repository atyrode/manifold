---
section: Fixed
issue: 949
---

Release publication refreshes tracked main after the checked rebase merge, so ordinary push policies recognize already-reviewed remote history without requiring a manual fetch and resume. Exact release-tree checks, immutable tags, local-work preservation and refusals for newly introduced disallowed commits remain in force.
