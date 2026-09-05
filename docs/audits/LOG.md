# Audit ledger

One row per run of a brief in this directory, appended by the agent that ran it as the last step of
the run protocol ([`README.md`](README.md)). `main rev` is the short sha the brief was run against;
`issues` lists every `[audit:<brief>]` issue the run filed, `none` when a run found nothing, and
`see <brief>` for anything noticed out of scope. An agent that finds the newest row for a brief
older than the cadence in `AGENTS.md` §Audits says so at the end of its task.

| date       | brief                | main rev | agent                    | issues                                                                                                             |
| ---------- | -------------------- | -------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| 2026-09-05 | process              | 7921f5b  | omp scout (orchestrated) | #265 #266 #267 #268; settings applied without a PR: ruleset on `main`, squash-only, secret scanning                |
| 2026-09-05 | dead-code            | 7921f5b  | omp scout (orchestrated) | #269; `SERVER_VERSION` → #251                                                                                      |
| 2026-09-05 | spec-drift           | 7921f5b  | omp scout (orchestrated) | none new: the `ADR 0023`/`ADR 0024` citations with no record on `main` are landed by #252 / #253 (renumbered 0025) |
| 2026-09-05 | decisions-compaction | 7921f5b  | omp scout (orchestrated) | #270 #271 #272 #273                                                                                                |
| 2026-09-05 | docs-consistency     | —        | —                        | not yet run; first run owed after #250/#251 rewrite the docs they touch                                            |
