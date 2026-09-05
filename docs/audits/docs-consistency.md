# Audit brief: docs-consistency

Label: `audit`. Issue title prefix: `[audit:docs-consistency]`. Run protocol:
[`README.md`](README.md).

## Purpose

manifold's documentation is layered on purpose: `AGENTS.md` is the operating contract, `AXIOMS.md`
the constitution, `REGISTRY.md` its enforcement data, `docs/CONTRACTS.md` the integration authority,
`docs/PLUGINS.md` the authoring guide, `docs/SELF-HOST.md` and `docs/ENROLL.md` the runbooks,
`docs/PLAN.md` the roadmap, `CHANGELOG.md` the release history. Each has one job and points at the
others for everything else. Drift between layers is the failure: the same rule stated twice in
different words, a pointer to a section that was renamed, a command that no longer exists, a claim
one doc makes that another contradicts. `spec-drift.md` compares docs to code; this brief compares
docs to docs, and docs to the tree's own shape (paths, script names, section anchors).

## Scope

In: `AGENTS.md`, `AXIOMS.md`, `REGISTRY.md` (prose paragraphs, not registry rows), `README.md`,
`CHANGELOG.md` (the `[Unreleased]` and most recent released section only), everything under `docs/`
except `docs/decisions/*` and `docs/spikes/*`, and `docs/audits/*` (these briefs are docs too).
Out: code, tests, workflow YAML (that is `spec-drift.md` or `process.md`); `docs/decisions/*` bodies
(`decisions-compaction.md`); registry TABLE rows (the gate reads those).

## Method

1. `git fetch origin && git rev-parse --short origin/main`; check out that revision.
2. **Pointers resolve.** Every `§<Section>` reference and every Markdown link in the in-scope files
   must land: `grep -rno '§[A-Z][^.,;)]*' AGENTS.md AXIOMS.md REGISTRY.md docs/*.md` and for each
   confirm a `## `/`### ` heading with that text exists in the named file (the file is the one
   named just before the `§`, else the current file). `grep -rno '\](\([^)]*\.md[^)]*\))'` for
   relative links; each target file (and `#anchor`, if any) must exist. A pointer to a heading
   that was renamed is a finding with a mechanical fix.
3. **Commands exist.** Every `bun run <name>` and `bun scripts/<file>` in the in-scope files must
   match a `package.json` `scripts` key or a file under `scripts/`. Every `gh`, `git`, `docker
   compose` invocation in a runbook must be syntactically runnable as written (run it with
   `--help`/`--dry-run` where one exists; otherwise read it).
4. **Paths exist.** Every backticked path (`packages/…`, `scripts/…`, `.github/…`, `docs/…`,
   `infra/…`) must exist at this revision: extract with
   `grep -rho '\`\(packages\|scripts\|docs\|infra\|\.github\)/[^\` ]*\`' <files> | sort -u` and
   test each with `test -e`. Glob-shaped paths (`packages/plugins/*`) must match at least one file.
5. **One statement per rule.** For each of these rules, find every place it is stated and check
   the statements agree in substance (not wording): the issue → PR → `Closes #N` flow; the changelog
   bullet format and where fragments live; the release path and what it refuses; the commit prefix
   list; the precedence rule (axioms > decisions > scope notes); what `docs/decisions/` is for;
   the worktree-per-agent rule. Two statements that disagree are one finding naming both; two that
   agree but one is a full restatement of the other where a pointer was intended (`AGENTS.md` §Map:
   "never restate the boundary here") is a finding whose fix is replacing the copy with the pointer.
6. **AGENTS.md against its own claims.** §Commands must list exactly what `bun run gate` runs
   (`scripts/gate.ts`); §Map's package table must have one row per directory under `packages/`
   (plugins excepted, by its own rule); §Audits must name the briefs that exist in `docs/audits/`;
   the labels list must equal `gh label list --repo atyrode/manifold` minus GitHub's defaults.
7. **README.md against the runbooks.** The front-page install and dev instructions must be a
   subset of `docs/SELF-HOST.md` and `AGENTS.md` §Commands, never a third version.
8. **CHANGELOG.md shape.** `[Unreleased]` sections appear in the documented order (Breaking Changes,
   Added, Changed, Fixed, Removed); every released bullet ends `(#issue, #pr)`; the newest released
   version equals `packages/web/package.json` `version` and has a `v<version>` tag
   (`git tag -l 'v*' | sort -V | tail -1`). `changelog:check` covers the generated file, not this.
9. **These briefs.** `docs/audits/*.md` each have the seven sections `README.md` promises; every
   command in a Method step is runnable at this revision; `LOG.md` rows name issues that exist and
   carry the `audit` label (`gh issue view N --json labels`).
10. Write each finding as its own issue (Output contract). Append the ledger row.

## Evidence standard

A finding is two quoted statements (`path:line` each) that cannot both be true, or one quoted
statement and the command/`test -e` output showing its referent does not exist. Restatement is a
finding only when the docs' own layering rule says that layer must point rather than copy. A
difference in emphasis, ordering or example between two docs that agree in substance is not
drift; a difference a reader could act on differently is.

## Output contract

```
Title: [audit:docs-consistency] <doc A §x> and <doc B §y> disagree about <rule> | <doc> §x points at <missing target>
Labels: audit, documentation
Body:
- main rev: <sha7>
- Statement A: <path:line> — "<quote>"
- Statement B: <path:line> — "<quote>"   (or: Referent: <command/test output>)
- Which is authoritative: <doc>, because <its role per AGENTS.md §Map>
- Proposed fix: <replace copy with pointer | correct pointer | correct command | reword B to match A>
- Mechanical PR appropriate: yes (pointer, path, command name, anchor) | no (any rule substance)
```

## Not a finding

- Tone, sentence length, heading depth, table alignment, Prettier's business.
- A rule stated in `AGENTS.md` and again in a `docs/` file when `AGENTS.md`'s statement is the
  one-line summary and the doc is the pointed-at authority.
- `docs/PLAN.md` describing something not yet built — it is the roadmap.
- `CHANGELOG.md` released sections' wording; they are immutable.
- A doc that is silent on something another doc covers; only contradiction and dead pointers count.

## Revisit this brief when

A doc is added under `docs/` or a top-level doc is split, or a link checker joins `bun run gate`
(then steps 2 and 4 become "confirm it is green").
