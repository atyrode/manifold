---
name: dispatch
description: Pick up ready manifold work — claim it, implement it to its acceptance criteria and open the pull request (docs/TRIAGE.md §Runbooks › dispatch).
---

Read [`docs/TRIAGE.md`](../../../docs/TRIAGE.md) and execute §Runbooks › **dispatch**.

Commands: `bun scripts/dispatch.ts --next --limit 5`, then `bun run gate` before marking any pull
request ready.

Claim before the first substantive commit, work in your own worktree on
`<prefix>/<issue>-<slug>`, take at most two claims at once, and stop with `Release: needs decision`
rather than guessing at one.
