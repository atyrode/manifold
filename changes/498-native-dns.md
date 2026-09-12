---
section: Fixed
issue: 498
---

Host-network native jobs now use compatible DNS resolver defaults, allowing provider authentication and other hostname-based connections without weakening descriptor-export confinement. Explicitly reviewed resolver settings remain authoritative.
