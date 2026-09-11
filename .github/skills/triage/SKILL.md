---
name: triage
description: Run the manifold triage runbook — repair label drift, classify needs-triage issues, prepare and drain operator holds (docs/TRIAGE.md §Runbooks › triage).
---

Read [`docs/TRIAGE.md`](../../../docs/TRIAGE.md) and execute §Runbooks › **triage** end to end from
a checkout of `origin/main`.

Commands: `bun scripts/triage-policy.ts --fix`, then `--report`, then `--flow`.

Classify every `needs-triage` issue oldest first, write a decision block on every hold that lacks
one, and finish with the hold digest for the operator and the flow snapshot. Never record a
decision the operator did not give.
