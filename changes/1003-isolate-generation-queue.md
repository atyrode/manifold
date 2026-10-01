---
section: Fixed
issue: 1003
---

A hardened plugin's replacement process no longer waits behind unfinished host calls from its killed predecessor. Each process owns its FIFO and backpressure accounting, while late replies and queued work remain fenced to their original request. A real-child deadline/respawn regression proves recovery before the old read finishes, without extending deadlines or bypassing hardening.
