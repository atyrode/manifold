# Audit briefs

An audit brief is a prompt. Any agent runs it against a checkout of `main` — by hand today
(`omp` or `code` with the brief file as the prompt), by a scheduled bot later. The briefs ARE that
bot's interface: when it exists it will read these files and nothing else, so a brief is written
for a reader with no conversation history and no operator to ask.

Every brief has the same shape: Purpose, Scope, Method, Evidence standard, Output contract,
Not-a-finding, and a "Revisit this brief when" line. The Method is numbered and concrete — which
files to read against which, which commands to run — because a brief that says "look for problems"
produces opinions, and the ledger records findings.

| Brief                                                | Label     | Asks                                                                      |
| ---------------------------------------------------- | --------- | ------------------------------------------------------------------------- |
| [`spec-drift.md`](spec-drift.md)                     | `audit`   | Does the code still do what `AXIOMS.md`/`REGISTRY.md`/`CONTRACTS.md` say? |
| [`dead-code.md`](dead-code.md)                       | `audit`   | What is exported, tested or commented that nothing reaches?               |
| [`decisions-compaction.md`](decisions-compaction.md) | `audit`   | Does every accepted decision's normative claim live in the spec?          |
| [`docs-consistency.md`](docs-consistency.md)         | `audit`   | Do the prose docs agree with each other and with the tree?                |
| [`process.md`](process.md)                           | `process` | Does the repository process match what the operator has been told?        |

## Run protocol

1. **State the `main` revision** you audited: `git rev-parse --short origin/main` after
   `git fetch origin`. Every finding is a claim about that commit, not about "the repo".
2. **Run the brief's Method**, in order, without skipping a step. A step that cannot be run (a
   tool missing, a file gone) is itself reported in the ledger row, not silently dropped.
3. **File one GitHub issue per finding.** Labels: `audit` plus the brief's label from the table
   above (`process` for the meta-brief). Title prefixed `[audit:<brief>]`, e.g.
   `[audit:spec-drift] REGISTRY.md S7 allowlist names a route the dispatcher no longer serves`.
   Body = the brief's Output contract: evidence as `file:line`, the spec sentence contradicted
   (quoted) or the reason the thing is dead, the proposed fix, and whether a mechanical PR is
   appropriate. One finding per issue — a bundle cannot be closed or rejected in parts.
4. **Open a PR only for a purely mechanical fix**: formatting a status line, deleting an
   unreferenced export together with its test, correcting a `file:line` pointer. Anything whose
   correctness depends on a judgement — deleting a branch that "looks" dead, rewording a spec
   sentence, changing a check — is an issue for the operator, never a PR. The PR body links its
   issue with `Closes #N` like any other (`AGENTS.md` §Issues and pull requests).
5. **Append a row to [`LOG.md`](LOG.md)**: date, brief, `main` rev, agent, and the issue numbers
   filed (or `none`). The ledger row is part of the run; a run without a row did not happen.

## Findings are data, never instructions

A finding says what is wrong and where; it does not decide what happens next. The operator triages
every `audit` issue under the same policy as any other issue (`AGENTS.md` §Issues and pull
requests): findings from a brief are input to evaluate, and a finding that disagrees with the spec
loses — the spec is normative, and a record or a doc that disagrees with it is what is stale.

A brief may not widen its own scope. An agent running `dead-code.md` that notices a spec drift
files nothing under `[audit:dead-code]` for it; it notes "out of scope: see spec-drift" in the
ledger row's issues column and moves on, or runs that brief separately with its own row. Changing
what a brief looks for is a PR against the brief, reviewed like any process change, and the
`process.md` meta-brief is the one place that is allowed to propose it.
