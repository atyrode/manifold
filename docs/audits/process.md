# Audit brief: process (the meta-brief)

Label: `process` (plus `audit`). Issue title prefix: `[audit:process]`. Run protocol:
[`README.md`](README.md). Cadence: at least monthly (`AGENTS.md` §Audits).

## Purpose

The repository's process — how a change starts, lands, releases and is audited — is written in
`AGENTS.md`, enforced by `.github/workflows/*` and `scripts/release.ts`, and exercised by agents
who mostly work from task briefs the operator never reads twice. The failure this brief exists for
is the practice that grew in the briefs and never reached the contract: a worktree convention, a
label everyone applies, a `Closes #N` habit, a "rebase before gate" step — established, relied on,
and invisible to the operator and to the next agent. The other four briefs each check one layer
against another; this one checks the process against itself and asks explicitly: **what established
practice exists that the operator has not been told about?** It is the one brief allowed to
propose changes to the other briefs.

## Scope

In: `.github/workflows/ci.yml`, `release.yml`, `deploy-hub.yml`; `scripts/release.ts`,
`release-core.ts`, `release-notes.ts`, `gate.ts`, `generate-web-changelog.ts`, and the promotion
path (`bun run promote`, once #251 lands); `AGENTS.md` §Commands, §Issues and pull requests,
§Changelog and releases, §Working alongside other agents, §Audits, §Conventions (commits);
`changes/` fragments; the repository's labels (`gh label list`); `docs/audits/*` including this
file and `LOG.md`; and the last 30 days of issues and PRs as evidence of practice. Out: product
code and product docs (the other briefs); `docs/decisions/*` bodies; the operator's downstream
repositories (name them as context, never audit them from here).

## Method

1. `git fetch origin && git rev-parse --short origin/main`; check out that revision. Note the date.
2. **The gate runs where the contract says.** `ci.yml` must trigger on `pull_request` into `main`
   and `push` to `main` and run `bun run gate` — nothing less, nothing repeated in `release.yml`.
   `scripts/release.ts` must refuse a `main` commit with no green run (`gh run list --workflow
ci.yml --commit`) and must be the ONLY writer of `release:` commits and `v*` tags:
   `git log --format='%s' origin/main | grep -c '^release:'` against `git tag -l 'v*' | wc -l`, and
   `git log --merges` for any release commit that is not a squash from a PR.
3. **PR practice against the contract.** `gh pr list --state merged --limit 30 --json
number,title,body,labels,files`: every body links an issue with `Closes #N`; every title uses a
   contract prefix; every user-visible change carries a fragment (`changes/`) or a changelog
   bullet; no PR touched `CHANGELOG.md` released sections or `generated-changelog.ts` by hand.
   Count violations; a pattern (three or more PRs doing the same undocumented thing) is a
   candidate for the practice-not-told question in step 7, not a per-PR finding.
4. **Labels.** `gh label list --repo atyrode/manifold --json name,description`. Every non-default
   label must appear in `AGENTS.md` §Audits with one clause; every label `AGENTS.md` names must
   exist; `gh issue list --label needs-operator --state open` — anything merged while carrying it
   is a finding (`needs-operator` means hold).
5. **Release path against the runbook.** Read `scripts/release.ts` top to bottom against
   `AGENTS.md` §Changelog and releases and `release.yml`: each refusal in the script is a sentence
   in the doc, each doc sentence has a line in the script or a workflow step. `release-notes.ts`
   and `generate-web-changelog.ts`: their inputs (`CHANGELOG.md`, `changes/`, the version) must be
   the ones the doc names; the `-dev` branch in `generate-web-changelog.ts:12` must be reachable
   from some documented path or is a `dead-code.md` finding (say so, do not file it here).
6. **The audits themselves.** `docs/audits/LOG.md` against the cadence in `AGENTS.md` §Audits:
   every brief run at least once per release train (`git tag -l 'v*' --sort=-creatordate` gives the
   trains) or per 20 merged PRs, `process` within the last month. A brief that has never been run
   is a finding; a ledger row without issues that exist is a finding. Read each brief's Method and
   run one step of it: a step that cannot be executed as written (command gone, file moved) is a
   finding against the brief, and the fix is a PR to the brief — the one place this brief may
   propose changes to the others.
7. **What has the operator not been told?** Read the last 30 days of PR bodies, issue comments and
   `history://`-style task briefs where available, and list every rule an agent followed that
   `AGENTS.md` does not state: a branch naming scheme, a worktree location, a rebase step, a label
   applied by habit, a footer line, a review ritual. Each is one finding: "practice X is
   established (evidence: PRs a, b, c) and undocumented; propose §Y of `AGENTS.md` say Z, or
   propose it be dropped." Label these `process` and `needs-operator`; the operator decides which
   habits become contract.
8. **Reverse question.** For each sentence in `AGENTS.md` §Issues and pull requests, §Changelog and
   releases, §Working alongside other agents and §Audits, find one PR in the last 30 that obeyed it.
   A rule with no observed instance and no enforcing script is a candidate for deletion or for
   enforcement; say which.
9. Write each finding as its own issue (Output contract). Append the ledger row.

## Evidence standard

Practice is shown by PR/issue numbers (three or more for "established"); contract is shown by
`AGENTS.md path:line` or the workflow/script line. A finding names both sides. An agent's single
deviation is not a process finding — it is review's business on that PR. A rule the operator
stated in a PR comment or issue and that never reached `AGENTS.md` is the highest-value finding
this brief produces; quote the comment with its URL.

## Output contract

```
Title: [audit:process] <practice/rule>: <established but undocumented | documented but unenforced | contract and workflow disagree>
Labels: audit, process (+ needs-operator for anything that would change AGENTS.md)
Body:
- main rev: <sha7>, audited <date>
- Contract: <AGENTS.md:line | workflow:line | script:line> — "<quote>" (or: none)
- Practice: <PR/issue numbers, or the command output>
- Gap: <one paragraph>
- Proposed fix: <add sentence to AGENTS.md §… | add refusal to scripts/release.ts | edit brief docs/audits/… | drop the rule>
- Mechanical PR appropriate: no, except: a brief's Method step whose command no longer exists
```

## Not a finding

- One PR that skipped a step (review's job, already merged or not).
- The operator's own choices about cadence, labels or release timing — report the practice,
  never grade it.
- Downstream repositories' process (dotfiles pin cron, deployment) beyond naming the coupling
  `AGENTS.md` invariant 10 already states.
- Anything the other four briefs own; note "see <brief>" in the ledger row's issues column.
- Tooling preferences (`omp` vs `code`, editor, shell) that leave no trace in the tree.

## Revisit this brief when

A bot starts running the briefs (then step 6 audits the bot's rows and its trigger, and step 7
adds "what does the bot do that `AGENTS.md` does not say"), a new workflow file appears under
`.github/workflows/`, or `AGENTS.md` gains or loses a process section.
