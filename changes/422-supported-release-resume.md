---
section: Fixed
issue: 422
---

Release publication can now resume with `bun run release --resume vX.Y.Z` from its existing prepared commit, branch, checked PR or matching tag, instead of requiring manual tag construction. Recovery retains the original version and tree, rechecks full-source CI and merged-PR provenance before tagging, and neither rewinds later main commits nor overwrites conflicting state. New and resumed publication share the same checked path; publishing still does not promote production.
