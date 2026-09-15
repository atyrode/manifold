# Audit ledger

One row per run of a brief in this directory, appended by the agent that ran it as the last step of
the run protocol ([`README.md`](README.md)). `main rev` is the short sha the brief was run against;
`issues` lists every `[audit:<brief>]` issue the run filed, `none` when a run found nothing, and
`see <brief>` for anything noticed out of scope. Cadence checks belong to an audit or explicitly
scoped process-maintenance task under [`README.md` §Cadence and ownership](README.md#cadence-and-ownership),
not ordinary task completion. Existing rows are historical evidence and remain unchanged.

| date       | brief                | main rev | agent                    | issues                                                                                                             |
| ---------- | -------------------- | -------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| 2026-09-05 | process              | 7921f5b  | omp scout (orchestrated) | #265 #266 #267 #268; settings applied without a PR: ruleset on `main`, squash-only, secret scanning                |
| 2026-09-05 | dead-code            | 7921f5b  | omp scout (orchestrated) | #269; `SERVER_VERSION` → #251                                                                                      |
| 2026-09-05 | spec-drift           | 7921f5b  | omp scout (orchestrated) | none new: the `ADR 0023`/`ADR 0024` citations with no record on `main` are landed by #252 / #253 (renumbered 0025) |
| 2026-09-05 | decisions-compaction | 7921f5b  | omp scout (orchestrated) | #270 #271 #272 #273                                                                                                |
| 2026-09-05 | docs-consistency     | —        | —                        | not yet run; first run owed after #250/#251 rewrite the docs they touch                                            |
| 2026-09-08 | spec-drift           | 4b964a1  | omp scout (orchestrated) | #430 #433; #400 not duplicated; source/metadata only—no LSP/history or deployed user path                          |
| 2026-09-08 | dead-code            | 4b964a1  | omp scout (orchestrated) | none; dynamic/public roots retained; liveness not disproven; no exhaustive LSP proof                               |
| 2026-09-08 | decisions-compaction | 4b964a1  | omp scout (orchestrated) | #431 #435; existing #362 not duplicated; 38 records, 33 accepted and 5 superseded                                  |
| 2026-09-08 | docs-consistency     | 4b964a1  | omp scout (orchestrated) | #432; existing #397 not duplicated; #399 wording already absent                                                    |
| 2026-09-08 | process              | 4b964a1  | omp scout (orchestrated) | #434; #265/#392/#398/#400 not duplicated; authenticated metadata was read live                                     |
