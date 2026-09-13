---
name: triage
description: Run the manifold triage runbook — repair label drift, classify needs-triage issues, prepare and drain operator holds (docs/TRIAGE.md §Runbooks › triage).
---

Read [`docs/TRIAGE.md`](../../../docs/TRIAGE.md) and execute §Runbooks › **triage** end to end from
a checkout of `origin/main`.

Commands: `bun scripts/triage-policy.ts --fix`, then `--report`, then `--flow`.

Classify every `needs-triage` issue oldest first and write a decision block on every hold that lacks
one. With the operator present, use the interactive question tool to present concrete options and a
recommendation; record only the answer the operator actually gives. Finish with the hold digest and
flow snapshot. Held implementation stays draft and stopped.
