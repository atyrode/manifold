---
section: Fixed
issue: 817
---

Container image builds reuse the checksum-verified Litestream installation across application-only revisions instead of downloading the same pinned release again. The replicator version and runtime behavior are unchanged; cold-build download and checksum failures still stop the build.
