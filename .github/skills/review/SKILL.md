---
name: review
description: Review a manifold pull request against its issue's acceptance criteria and post the single Verdict comment (docs/TRIAGE.md §Runbooks › review).
---

Read [`docs/TRIAGE.md`](../../../docs/TRIAGE.md) and execute §Runbooks › **review**.

Commands: `gh pr view <n>`, `gh pr diff <n>`, `gh pr checks <n>`. This runbook writes one comment
and nothing else — never push to the branch under review.

Post exactly one comment per reviewed head, beginning `## Verdict: pass` or `## Verdict: fail`,
followed by the acceptance checklist with evidence per item and, on a fail, the blocking findings.
