---
section: Fixed
issue: 454
---

Integrated preview deployments now replace only a server-only hub, preserving identity, workload data and file ownership. The actual incumbent's volume, machine, networks and effective `/data` root must match the final Compose topology; owning or mismatched incumbents hold untouched. Retiring an old spoke remains a separate maintenance operation: admission stays closed, the independently reviewed transport must be proved non-owning and terminated, and the supervised owner exits only after its own atomic empty acknowledgement. Unknown work, implicit dependency teardown, non-terminating kill policy, unproved supervisor effects and replacement generations refuse the handoff.
Sidebar palette drops keep their live preview when a newly mounted descendant emits a drag-leave event under the pointer, while genuine exits still clear it. The native Stack column gesture and the browser identity-startup scenarios now pass without retries or weakened assertions. (#464, #465)
Remote cursor and gesture clocks stop when their room has no live records and resume on incoming activity, without weakening smoothing, expiry or idle budgets. (#467)
Rejected or expired preview browser identities return through ordinary production admission, including reload after an interrupted handoff. Recovery never deletes a concurrently replaced credential or falls back to a cached owner key; existing preview content and other instance credentials remain untouched. (#468)
Retained hub candidates are built from the selected Git revision, with their final image and Compose configuration sealed before incumbent mutation. Unsupported build recipes, execution overrides and configured owner-key replacements refuse before cutover; retained `/data/owner.key` remains authoritative. (#469)
