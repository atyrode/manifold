---
name: dispatch
description: Pick up ready manifold work — claim it, implement it to its acceptance criteria and open the pull request (docs/TRIAGE.md §Runbooks › dispatch).
---

Read [`docs/TRIAGE.md`](../../../docs/TRIAGE.md) and execute §Runbooks › **dispatch**.

Command: `bun scripts/dispatch.ts --next --limit 5`. A non-draft PR closes dispatch: review,
correct, hold or ship it before claiming anything new. Otherwise claim before the first substantive
commit, work in your own worktree on `<prefix>/<issue>-<slug>` from current `origin/main`, and take
at most two claims at once.

Use one draft per initiative and declare `## Dependencies` exactly as the runbook requires. Run
`bun run gate` before marking it ready, then invoke **review** and **ship**. Stop with
`Release: needs decision` rather than guessing at one.
