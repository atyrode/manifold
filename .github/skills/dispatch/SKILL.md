---
name: dispatch
description: Pick up ready manifold work — claim it, implement it to its acceptance criteria and open the pull request (docs/TRIAGE.md §Runbooks › dispatch).
---

Read [`docs/TRIAGE.md`](../../../docs/TRIAGE.md) and execute §Runbooks › **dispatch**.

Command: `bun scripts/dispatch.ts --next --limit 5`. A non-draft PR outside the ship integration
lane closes dispatch: review, correct, hold or ship it before claiming anything new. A PR with
squash auto-merge armed and a pass verdict newer than its head commit is in the lane and counts as
drained. Otherwise claim before the first substantive commit, work in your own worktree on
`<prefix>/<issue>-<slug>` from current `origin/main`, and take at most two claims at once.

Read the issue's latest follow-through first. An already-merged implementation needs its recorded
operational action, not a duplicate implementation PR; defects follow the runbook's repair path.
Check a pending trigger once, keep its receipt and owner
current, release the execution claim when handing off, and continue other ready work rather than
polling or inventing an operator hold.

Use one draft per initiative and declare `## Dependencies` exactly as the runbook requires.
Inspect `bun run ci:plan -- --json`, run `bun run ci:check` and the change's behavioral proof,
then require the selected PR CI checks before readiness, **review** and **ship**. Full local
`bun run gate` is not an ordinary-PR prerequisite; high-risk selections remain blocking in CI.
Stop with `Release: needs decision` rather than guessing at one.
