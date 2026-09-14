---
name: ship
description: Merge the manifold pull requests that meet the standing merge grant, and hold the ones that do not (docs/TRIAGE.md §Runbooks › ship).
---

Read [`docs/TRIAGE.md`](../../../docs/TRIAGE.md) and execute §Runbooks › **ship**. §Merge's five
criteria are mechanical: evaluate them, never interpret them.

Commands: `gh pr view <n> --json labels,files,headRefOid,closingIssuesReferences,comments,isDraft`,
`gh pr checks <n> --required`, `gh run list`, `gh pr merge <n> --squash --delete-branch`.

A pull request excluded by criteria 4 or 5 is labelled `needs-operator`, made draft and given a
decision block instead of being merged. After each merge, inspect `bun run ci:status` and reconcile
dependent PRs; full main verification and deployment run asynchronously for ordinary work. Wait
for exact-revision full proof when the task owns deployment or release, and handle assigned CI
repair issues promptly. Rebase and reverify branches you own; comment the required
base update on another owner's branch. Preserve unique work before closing empty or superseded
drafts, and never return to dispatch with non-draft PRs still open.
