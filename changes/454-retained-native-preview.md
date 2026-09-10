---
section: Fixed
issue: 454
---

Integrated preview deployments now replace only a server-only hub, preserving identity, workload data and file ownership. The actual incumbent's volume, machine, networks and effective `/data` root must match the final Compose topology; owning or mismatched incumbents hold untouched. Retiring an old spoke remains a separate maintenance operation: admission stays closed, the independently reviewed transport must be proved non-owning and terminated, and the supervised owner exits only after its own atomic empty acknowledgement. Unknown work, implicit dependency teardown, non-terminating kill policy, unproved supervisor effects and replacement generations refuse the handoff.
