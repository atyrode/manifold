# Audit brief: spec-drift

Label: `audit`. Issue title prefix: `[audit:spec-drift]`. Run protocol: [`README.md`](README.md).

## Purpose

The living spec — `AXIOMS.md`, `REGISTRY.md`, `docs/CONTRACTS.md`, `docs/PLUGINS.md` — is the
normative form of every ratified decision, and `bun run verify:axioms` makes part of it
falsifiable. Only part. The S/R/T rows in `REGISTRY.md` §Gates cover registries the gate can read
mechanically; a prose sentence in `CONTRACTS.md` about what an endpoint returns, an `AGENTS.md`
invariant naming a file that has since moved, a `PLUGINS.md` code sample importing a symbol the
engine renamed — none of those fail a gate when the code changes under them. This brief is the
reader the gate is not: it finds sentences in the spec that the tree at `main` no longer makes
true, and sentences the tree makes true that the spec does not say.

## Scope

In: `AXIOMS.md`, `REGISTRY.md`, `docs/CONTRACTS.md`, `docs/PLUGINS.md`, `docs/SELF-HOST.md`,
`docs/ENROLL.md`, the process and invariant sections of `AGENTS.md`, and every file under
`packages/`, `scripts/`, `.github/workflows/` those documents name. Out: `docs/PLAN.md` (vision,
not contract), `docs/decisions/*` (reasoning, covered by `decisions-compaction.md`), `CHANGELOG.md`,
and prose-vs-prose disagreements between two docs (covered by `docs-consistency.md`). Anything the
gate already asserts is out: if `verify:axioms` is green on the audited revision, S1–S17 are not
findings here even when the prose around them reads oddly.

## Method

1. `git fetch origin && git rev-parse --short origin/main`; check out that revision. Confirm the
   gate ran green on it: `gh run list --workflow ci.yml --commit <sha> --status success --limit 1`.
   If it did not, stop and record that in the ledger row — auditing a red tree finds the red.
2. **HTTP surface.** Read `docs/CONTRACTS.md` §HTTP API row by row against the server's route
   dispatch (`grep -n '"/api/' packages/server/src` to find the dispatcher; follow each handler).
   For every row: method, path, auth cap and response shape must match the handler. For every
   `/api/` literal in the server: a row must exist. A response field the handler emits that the
   table omits is a finding; so is a documented field nothing emits.
3. **Wire frames.** Read `docs/CONTRACTS.md` §WS /ws/session, §WS /ws/machine and §WS /ws/instance
   against `packages/protocol/src/*.ts`. Every frame kind named in prose must be a schema member and
   every schema member must be named. Where the prose states a protocol version as CURRENT, it must
   equal `PROTOCOL_VERSION` in `packages/protocol/src/version.ts` (22 at the time of writing);
   a version named as history ("v19 changed…") is not a claim about now.
4. **Environment and processes.** `docs/CONTRACTS.md` §Runtime contracts lists every env variable
   with its default. `grep -rn 'process.env.MANIFOLD_\|Bun.env.MANIFOLD_' packages/ scripts/` and
   diff both ways. Same for `docs/SELF-HOST.md` against `compose.yaml`, `Dockerfile`,
   `flake.nix` and `infra/**`: every variable the install text tells a self-hoster to set must be
   read somewhere, and every variable read must be documented or deliberately internal.
5. **Persistence.** `docs/CONTRACTS.md` §Persistence's schema block against the `CREATE TABLE`
   statements and migrations in `packages/server/src`. Column added, column not documented, or
   documented as persisted but never written: finding. Invariant 5 (never persist presence, cursor
   traffic, terminal bytes) is checked here by reading every `INSERT`.
6. **Plugin authoring guide.** Every import path and identifier in a `docs/PLUGINS.md` code block
   must resolve: `@manifold/plugin`, `@manifold/plugin/hooks`, `@manifold/plugin/ui` exports in
   `packages/plugin/src/index.ts`, `hooks.ts`, `ui/`. Run each sample's imports through
   `bun run check` mentally or by pasting into a scratch file inside a plugin package (delete it
   after). §8 "What the gate checks" must list exactly the checks in `REGISTRY.md` §Gates that a
   plugin can fail.
7. **AGENTS.md invariants and `AXIOMS.md` prose.** Every file, symbol, script name and check
   number named in `AGENTS.md` §Invariants, §Map and §Commands, and in `AXIOMS.md` §Foundation law
   and §Change control, must exist at that path with that name. `bun run <script>` claims are
   checked against `package.json` `scripts`.
8. **REGISTRY.md prose, not rows.** The gate reads the tables; read the paragraphs. §Decisions
   awaiting ratification's "Nothing is waiting as of <date>" must agree with the `Status:` lines
   in `docs/decisions/`; the per-axiom round table must name only checks that exist in the table
   above it; every "(ADR NNNN §M)" pointer must land on a section that says what the row claims.
9. Write each finding as its own issue (Output contract). Append the ledger row.

## Evidence standard

A finding is a spec sentence and a tree location that cannot both be true. Quote the sentence,
give the `file:line` of both, and state which one you believe is stale and why. "The spec is
vague here" is not a finding; "the spec says X, the code does Y" is. A behavior the tree has and
the spec does not mention is a finding only when the spec section it belongs to enumerates its
siblings (a table of endpoints, a list of env vars, a frame grammar) — an exhaustive list with a
missing member is drift; a paragraph that happens not to mention something is not.

## Output contract

```
Title: [audit:spec-drift] <one line: what the spec says vs what the tree does>
Labels: audit
Body:
- main rev: <sha7>
- Spec: <path:line> — "<quoted sentence>"
- Tree: <path:line> — <what it actually does, one or two lines>
- Stale side: spec | tree, because <reason>
- Proposed fix: <edit the sentence to … | change the code to … | escalate: ADR needed>
- Mechanical PR appropriate: yes (pointer/version/name correction) | no (behavior or law)
```

## Not a finding

- Anything `verify:axioms`, `verify:trace` or `changelog:check` already asserts (they ran green).
- Wording, tone, ordering, table formatting, heading depth.
- A `docs/PLAN.md` bullet the tree has not built yet — the plan is a roadmap, not a contract.
- An ADR that disagrees with the spec — that is `decisions-compaction.md`'s finding, and the spec
  wins.
- A `TODO` or "wave N" deferral that is visible in-product as the spec requires
  (`AXIOMS.md` §Change control, deferrals are visible in-product). One that is prose-only IS a
  finding, filed here.

## Revisit this brief when

`REGISTRY.md` §Gates gains a check that mechanizes one of steps 2–8 (then delete that step), or
`docs/CONTRACTS.md` is split into more than one file (then update Scope).
