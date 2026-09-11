# Audit brief: dead-code

Label: `audit`. Issue title prefix: `[audit:dead-code]`. Run protocol: [`README.md`](README.md).

## Purpose

[`CONTRACTS.md` §Testability (agent-facing)](../CONTRACTS.md#testability-agent-facing)
requires code to justify its existence through a tested or documented contract; the correct fix
may be deletion rather than a test. The typechecker does not report an export nobody imports,
a test that pins a contract nobody depends on, a stale comment or an unreachable branch.
These add weight without a consumer; see
[`CONTRACTS.md` §Roster restraint](../CONTRACTS.md#roster-restraint). This brief proposes deletion
one finding at a time, so the operator decides what stays.

## Scope

In: every `.ts`/`.tsx`/`.css` file under `packages/` and `scripts/`, `package.json` `scripts`
entries, `.github/workflows/*.yml` steps, and the `allow` rows of `REGISTRY.md` §Lexicon (an
exemption suppressing nothing is dead, though S11 already fails those — confirm rather than
re-find). Out: `docs/**` prose (that is `docs-consistency.md`), `docs/spikes/**` (kept as evidence
by design), generated files (`packages/web/src/generated-changelog.ts`), `node_modules`, and
anything a `data-testid`/`data-action` literal reaches at runtime — a symbol the DOM joins by
string is live even when no import names it (S4, S15 are the readers there).

## Method

1. Establish the audited `main` revision under the [run protocol](README.md#run-protocol).
   In that isolated checkout, `bun install --frozen-lockfile` and `bun run check` establish the
   baseline when authorized. Stop liveness conclusions that depend on a failing or unavailable
   baseline and record the evidence boundary; do not alter another task's checkout.
2. **Unreferenced exports, per package.** For each package under `packages/` and
   `packages/plugins/`, list the named exports of every source file
   (`grep -n '^export ' <file>`; `index.ts` barrels included). For each symbol, find references
   outside its defining file: an LSP `references` request if your harness has one, else
   `grep -rn '\b<symbol>\b' packages scripts --include='*.ts' --include='*.tsx'`. A symbol with
   zero references outside its file, its own test, and a barrel re-export is a candidate. Then
   check the runtime joins before calling it dead: is it named in a manifest, an `assembly.ts`,
   a `LOG_EVENTS`/`TRACE_OUTCOMES`/`ITEM_KINDS`-style vocabulary constant, a `data-*` literal, or
   `docs/PLUGINS.md` (a documented plugin API is live even with zero in-tree callers)?
3. **Tests without a contract.** For each `*.test.ts` whose subject was a candidate in step 2, or
   whose assertions only restate the implementation (a field copied, a default echoed, a mock
   returning what it was given), read it against
   [`CONTRACTS.md` §Testability (agent-facing)](../CONTRACTS.md#testability-agent-facing).
   A test that would still pass if the feature were removed, or that only fails when the source
   text changes, is a candidate. Propose removing an obsolete test together with its subject only
   when the subject is independently proven unreachable; a weak test alone does not prove its
   subject dead. Never keep an obsolete test merely so dead code "has coverage".
4. **Stale comments and names.** Inventory identifiers mentioned in comments under `packages/`
   and `scripts/` (`.ts` and `.tsx`), and confirm that their named subjects still exist. For
   "removed", "no longer", "used to", "legacy", "old", "temporary", "for now" or "until" claims,
   use `git log -S'<phrase>' --oneline -- <path>` and current source to establish whether the
   claim is still true. A file whose name is a retired lexicon word requires a live `allow` row.
5. **Latent branches.** Find conditions that can no longer be true: environment reads
   (`process.env.X`) that no runtime contract, compose file or workflow sets; `switch` arms over
   a union member no producer emits; feature flags with one value. Derive candidates from current
   source, not a presumed `-dev` branch or old generator line number. For
   `MACHINE_PROTOCOL_COMPAT_VERSIONS`, check release evidence and
   [`CONTRACTS.md` §Protocol and compatibility](../CONTRACTS.md#protocol-and-compatibility)
   before proposing deletion. A compatibility member is fleet policy: missing release access is
   an evidence boundary, and this is an issue, never a mechanical PR.
6. **Scripts and workflow steps.** Find the consumers of each `package.json` script: human-facing
   command documentation at its actual owner, `scripts/gate.ts`, workflows or other source callers.
   Root Commands is essential discovery, not an exhaustive inventory. A script absent there is
   not thereby dead. For each workflow step identify its artifact, check or required side effect
   and its consumer; no identified consumer is a candidate requiring the evidence standard below.
7. **CSS.** For each class selector under `packages/`, search for class-name consumers in source,
   templates and runtime-generated markup, not just the dotted selector spelling in `.tsx`.
   S13 asserts ownership, not use. Account for dynamic class construction before calling a
   selector dead, under the same static-reference and runtime-join evidence standard.
8. Produce findings and the run's ledger row under the [run protocol](README.md#run-protocol),
   within the task's publication authority.

## Evidence standard

Dead means unreachable, shown two ways: no static reference (the grep or LSP result, quoted) AND no
runtime join (the vocabularies and literals of step 2 checked and named). One without the other is
"possibly dead" and is reported as such, with the missing half stated. For a latent branch, evidence
is the condition plus the enumeration of every producer that could make it true and why none does.
For a stale comment, evidence is the comment's `file:line` and the commit (`git log -S`) that made
it false. "This looks unused" is not evidence; the reference search is.

## Output contract

```
Title: [audit:dead-code] <symbol|file|branch> in <package> is unreachable
Labels: audit, needs-triage
Body:
- main rev: <sha7>
- Subject: <path:line> — <export | test | comment | branch | script | selector>
- Static references: <none | list> (search: `<command run>`)
- Runtime joins checked: <manifest, assembly, vocab constants, data-* literals, PLUGINS.md — result>
- Why it is dead: <one paragraph; for a branch, why the condition cannot hold>
- Proposed fix: delete <what, including its test and any REGISTRY.md row it leaves stale>
- Mechanical PR appropriate: yes (export/test/comment with zero references and zero joins) |
  no (branch, compat member, anything whose liveness depends on a fleet or a stranger's plugin)
```

## Not a finding

- A documented plugin API (`docs/PLUGINS.md`, `packages/plugin-kit`) with no in-tree caller.
- The testkit's adversarial harness
  ([`CONTRACTS.md` §Testability (agent-facing)](../CONTRACTS.md#testability-agent-facing))
  and gate scripts that only run in `bun run gate`.
- An `allow` row S11 accepts (it suppresses a real occurrence by construction).
- Code kept for a stated wave (`AXIOMS.md` §Roadmap) when the deferral is visible in-product; if
  it is prose-only, that is a `spec-drift.md` finding, not this brief's.
- Style: naming, file length, "could be simpler", duplication that both sides still reach.

## Revisit this brief when

A repository-wide unused-export check joins `bun run gate` (then step 2 becomes "confirm the check
is green" and the brief keeps steps 3–7), or a package is added or removed under `packages/`.
