---
section: Changed
issue: 478
---

Replacing or disabling an instance service now lets its admitted workload finish before releasing ownership or starting a replacement. Services report `stopping` until whole-workload emptiness is verified, including after a disconnected completion. Explicit cancellation and authority revocation still force termination.
