# Audit brief: dead-code

Label: `audit`. Issue title prefix: `[audit:dead-code]`. Run protocol: [`README.md`](README.md).

## Purpose

`AGENTS.md` §Conventions: code that is neither tested nor documented is a defect, and the correct
fix may be deletion rather than a test. The typechecker does not report an export nobody imports,
a test that pins a contract nobody depends on, a comment that names a symbol deleted three waves
ago, or a branch that can no longer be entered. Each of those is weight a stranger's agent has to
read before it can tell what manifold is (invariant 12, roster restraint). This brief finds them
and proposes deletion, one issue each, so the operator decides what stays.

## Scope

In: every `.ts`/`.tsx`/`.css` file under `packages/` and `scripts/`, `package.json` `scripts`
entries, `.github/workflows/*.yml` steps, and the `allow` rows of `REGISTRY.md` §Lexicon (an
exemption suppressing nothing is dead, though S11 already fails those — confirm rather than
re-find). Out: `docs/**` prose (that is `docs-consistency.md`), `docs/spikes/**` (kept as evidence
by design), generated files (`packages/web/src/generated-changelog.ts`), `node_modules`, and
anything a `data-testid`/`data-action` literal reaches at runtime — a symbol the DOM joins by
string is live even when no import names it (S4, S15 are the readers there).

## Method

1. `git fetch origin && git rev-parse --short origin/main`; check out that revision;
   `bun install --frozen-lockfile`; `bun run check` must be green or stop.
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
   returning what it was given), read it against `AGENTS.md` §Conventions "Tests prove necessity".
   A test that would still pass if the feature were removed, or that only fails when the source
   text changes, is a candidate — the fix is deleting the test WITH its subject, never keeping
   the test so the subject "has coverage".
4. **Stale comments and names.** For every identifier a comment mentions in backticks
   (`grep -rn '\`[A-Za-z_][A-Za-z0-9_.]_\`' packages scripts --include='_.ts' --include='*.tsx'`),
confirm the identifier still exists; for a comment that says "removed", "no longer", "used to",
"legacy", "old", "temporary", "for now", or "until", run `git log -S'<phrase>' --oneline`and
check whether the thing it describes is still true at this revision. Same for file names: a file
whose name is a retired lexicon word survives only through an`allow` row.
5. **Latent branches.** Find conditions that can no longer be true. Known shapes:
   `scripts/generate-web-changelog.ts:12`'s `-dev` path (`webVersion.includes("-dev")`) — check
   whether any `package.json` version, `bun run release` step, or workflow ever produces a
   `-dev` version; environment reads (`process.env.X`) that no runtime contract, compose file or
   workflow sets; `switch` arms over a union member no producer emits; feature flags with one
   value; `MACHINE_PROTOCOL_COMPAT_VERSIONS` members older than any agent binary a release still
   publishes (check `gh release list` and the pin policy in `AGENTS.md` invariant 10 before
   proposing — a compat member is fleet policy, so this is an issue, never a PR).
6. **Scripts and workflow steps.** Every `package.json` `scripts` entry must be invoked by a
   human-facing doc (`AGENTS.md` §Commands), by `scripts/gate.ts`, or by a workflow; every
   `.github/workflows/*.yml` step must produce an artifact, a check, or a side effect something
   downstream reads. `bun run gate` calls what `scripts/gate.ts` lists — an entry in neither is a
   candidate.
7. **CSS.** Every class selector in every stylesheet under `packages/` must appear in a `.tsx`
   (S13 asserts ownership, not use). `grep -rn '\.<class>\b' packages --include='*.tsx'` per class.
8. Write each finding as its own issue (Output contract). Append the ledger row.

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
Labels: audit
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
- The testkit's adversarial harness (invariant 3) and gate scripts that only run in `bun run gate`.
- An `allow` row S11 accepts (it suppresses a real occurrence by construction).
- Code kept for a stated wave (`AXIOMS.md` §Roadmap) when the deferral is visible in-product; if
  it is prose-only, that is a `spec-drift.md` finding, not this brief's.
- Style: naming, file length, "could be simpler", duplication that both sides still reach.

## Revisit this brief when

A repository-wide unused-export check joins `bun run gate` (then step 2 becomes "confirm the check
is green" and the brief keeps steps 3–7), or a package is added or removed under `packages/`.
