---
section: Fixed
issue: 454
---

Integrated preview deployments now replace only a server-only hub, preserving identity, workload data and file ownership instead of rebuilding or retiring native execution. An existing container that still owns execution is held untouched. Retiring an old spoke is a separate maintenance operation: admission stays closed, the reviewed transport must be proved non-owning, and the supervised owner exits only after its own atomic empty acknowledgement. Unknown work, unproved supervisor effects and replacement owner generations refuse the handoff.
