---
section: Fixed
issue: 667
---

Nix packages build against the current locked dependencies without losing workspace command entrypoints. Cold dependency rebuilds and compiled package smoke checks now cover the supported Linux and macOS targets before integration, so a cached dependency tree cannot hide stale packaging hashes.
