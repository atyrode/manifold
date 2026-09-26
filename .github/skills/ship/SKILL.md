---
name: ship
description: Merge the manifold pull requests that meet the standing merge grant, and hold the ones that do not (docs/TRIAGE.md §Runbooks › ship).
---

Read [`docs/TRIAGE.md`](../../../docs/TRIAGE.md) and execute §Runbooks › **ship**. That document
owns merge eligibility, recorded authority and post-merge follow-through; do not add a second
closing-link or protected-path approval rule here.

Commands: `gh pr view <n> --json body,labels,files,headRefOid,closingIssuesReferences,comments,isDraft`,
`gh pr checks <n> --required`, `gh run list`, `gh pr merge <n> --auto --squash`,
`gh pr list --json number,isDraft,autoMergeRequest`, `gh pr update-branch <n>`,
`gh pr merge <n> --disable-auto`.

Inspect claimed issues from the body as well as closing links. A complete `Refs` implementation can
merge with accountable operational acceptance still open, as the runbook specifies. Escalate a
concrete unresolved decision, not a path or an already-covered action. Arming squash auto-merge
enters the runbook's integration lane: only the head-of-line is updated from `main` and rerun, a
clean catch-up gets a refreshed verdict, and a failing or stalled head-of-line is diagnosed or
disarmed rather than left to block the lane. Each pass first reconciles lane merges since the last:
update the issue receipt, inspect `bun run ci:status` and reconcile
dependent PRs; full main verification and deployment run asynchronously for ordinary work. Wait
for exact-revision full proof when the task owns deployment or release, and handle assigned CI
repair issues promptly. Rebase and reverify branches you own; comment the required
base update on another owner's branch. Preserve unique work before closing empty or superseded
drafts, and never return to dispatch with non-draft PRs outside the lane still open.
