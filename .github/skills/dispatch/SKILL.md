---
name: dispatch
description: Pick up ready manifold work — claim it, implement it to its acceptance criteria and open the pull request (docs/TRIAGE.md §Runbooks › dispatch).
---

Read [`docs/TRIAGE.md`](../../../docs/TRIAGE.md) and execute §Runbooks › **dispatch**.

Command: `bun scripts/dispatch.ts --next --limit 5`. A non-draft PR closes dispatch: review,
correct, hold or ship it before claiming anything new. Otherwise claim before the first substantive
commit, work in your own worktree on `<prefix>/<issue>-<slug>` from current `origin/main`, and take
at most two claims at once.

Use one draft per initiative and declare `## Dependencies` exactly as the runbook requires.
Inspect `bun run ci:plan -- --json`, run `bun run ci:check` and the change's behavioral proof,
then require the selected PR CI checks before readiness, **review** and **ship**. Full local
`bun run gate` is not an ordinary-PR prerequisite; high-risk selections remain blocking in CI.
Stop with `Release: needs decision` rather than guessing at one.
