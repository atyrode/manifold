# Audit ledger

One row per run of a brief in this directory, appended by the agent that ran it as the last step of
the run protocol ([`README.md`](README.md)). `main rev` is the short sha the brief was run against;
`issues` lists every `[audit:<brief>]` issue the run filed, `none` when a run found nothing, and
`see <brief>` for anything noticed out of scope. An agent that finds the newest row for a brief
older than the cadence in `AGENTS.md` §Audits says so at the end of its task.

| date | brief | main rev | agent | issues |
| ---- | ----- | -------- | ----- | ------ |
