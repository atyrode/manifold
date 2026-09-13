---
section: Added
issue: 520
---

Build integrations can compile a plugin entirely in memory through the kit's existing bundle and artifact verification. Generated manifests and bounded artifact members are snapshotted before asynchronous work, and both compiled halves receive the same root manifest as the final bundle. The file packer uses that same compiler; callers no longer need to copy and mutate plugin source to prepare native artifacts.
