---
name: ship
description: Merge the manifold pull requests that meet the standing merge grant, and hold the ones that do not (docs/TRIAGE.md §Runbooks › ship).
---

Read [`docs/TRIAGE.md`](../../../docs/TRIAGE.md) and execute §Runbooks › **ship**. §Merge's five
criteria are mechanical: evaluate them, never interpret them.

Commands: `gh pr view <n> --json labels,files,headRefOid,closingIssuesReferences,comments,isDraft`,
`gh pr checks <n> --required`, `gh run list`, `gh pr merge <n> --squash --delete-branch`.

A pull request excluded by criteria 4 or 5 is labelled `needs-operator` with a decision block, not
merged. After each merge, watch `deploy-dev.yml` for the merge commit.
