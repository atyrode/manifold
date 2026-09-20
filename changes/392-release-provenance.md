---
section: Breaking Changes
issue: 392
---

Release publication now verifies its merged release-only changes and full-CI predecessor before building artifacts. Production promotion requires immutable published releases with cryptographically verified artifacts and exact-tag full-main CI for both the candidate and its recovery release. Older releases without this evidence are refused, including as rollback targets; production consumes the verified image instead of rebuilding application source.
