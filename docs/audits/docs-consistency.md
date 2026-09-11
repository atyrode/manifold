# Audit brief: docs-consistency

Label: `audit`. Issue title prefix: `[audit:docs-consistency]`. Run protocol:
[`README.md`](README.md).

## Purpose

manifold's documentation is layered on purpose: `AGENTS.md` gives concise operating instructions
and routes task-specific readers; `AXIOMS.md` is the constitution, `REGISTRY.md` its enforcement
data, `docs/CONTRACTS.md` the engineering and integration authority, `docs/PLUGINS.md` the authoring
guide, `docs/SELF-HOST.md` and `docs/ENROLL.md` the runbooks, `docs/PLAN.md` the roadmap and
`CHANGELOG.md` the release history. Each has one job and points at the others for details. Drift
is a contradictory rule, a dead pointer or a command that no longer exists — not the absence of a
full inventory in startup instructions. `spec-drift.md` compares contracts to product behavior;
this brief compares documentation and verifies its named paths, scripts, anchors and owners.

## Scope

In: `AGENTS.md`, `AXIOMS.md`, `REGISTRY.md` prose (not registry rows), `README.md`, the current
release-history shape in `CHANGELOG.md`, `changes/README.md`, `infra/previews/README.md`, and
`docs/` except historical `docs/decisions/*` bodies and `docs/spikes/*`. Audit briefs and their
index are included. Read `package.json` and named script/workflow entry points only to establish
command or source ownership; auditing their behavior belongs to `process.md` or `spec-drift.md`.
Historical evidence is not rewritten: ADR bodies, released changelog entries and ledger rows
remain intact. Registry table enforcement belongs to the gate.

## Method

1. Establish the audited `main` revision and date under the [run protocol](README.md#run-protocol);
   do not switch or overwrite another task's checkout.
2. **Pointers resolve.** Inventory Markdown links and named section references in the in-scope
   files. Resolve each relative path and anchor against the named document at this revision.
   For `§<Section>` prose references, use the explicitly named owner or the current document.
   Distinguish live instruction links from intentionally immutable historical citations. A
   renamed section is a mechanical correction only if the replacement preserves the meaning.
3. **Commands exist.** Match each documented `bun run <name>` to its `package.json` script, and
   each direct `bun scripts/<file>` invocation to the actual file. Follow named command owners
   rather than requiring every script in root Commands. For runbook `gh`, `git` and container
   commands, inspect current syntax or use a demonstrably read-only help mode. A `--dry-run`
   spelling alone does not prove no side effects; do not dispatch, deploy, release, authenticate
   or mutate a system to check prose. Record unavailable evidence.
4. **Paths exist.** Resolve concrete backticked source paths at the audited revision. Check globs
   against the tree, distinguishing illustrative placeholders, runtime-generated paths and
   explicitly planned files from promises of existing source. Name the exact missing referent;
   a substring search alone is not proof that a path is stale.
5. **Each rule has its owner.** Compare live references and summaries with these sources:
   - Common PR readiness and conditional closure: the generated common contract in `AGENTS.md`;
     local ownership and live-action boundaries: its Boundaries; local delivery: its Delivery.
   - Engineering rules: the named sections of `docs/CONTRACTS.md`, not retired numbered root
     invariants. Constitutional authority, precedence and amendments: `AXIOMS.md` §Change control;
     foundation/lexicon enforcement: `REGISTRY.md` and their corresponding axiom sections.
   - Fragments: `changes/README.md` and `scripts/release-core.ts`. Release writing and promotion:
     root Task-specific guidance, `scripts/release.ts`, `scripts/promote.ts` and their workflows.
   - Audit cadence, label semantics and run protocol: this directory's `README.md`.
   - Preview operations: `infra/previews/README.md`, with the root's conditional policy and
     workflows as its implementation sources.
     Check that a reader reaches the authoritative detail and that summaries do not contradict it.
     When the architecture calls for a pointer, report full duplicate rules as maintenance drift,
     even if their wording currently agrees. Do not infer a new rule from absent root detail.
6. **Discovery routes to source truth.** Root Commands must offer valid essential commands, not
   reproduce `scripts/gate.ts`. Package discovery must reach the actual tree and source owners;
   plugin composition belongs to the assembly sources, not a root package-count assertion. The
   audit index must name the actual briefs. Label inventory and practice are checked by
   `process.md` against audit README semantics and live GitHub, not against a mandatory root list.
   Follow root task-specific links and named owner references through to the requested detail;
   merely finding the same words in two files does not establish correct routing.
7. **README.md against runbooks.** Verify front-page install and development instructions agree
   with `docs/SELF-HOST.md`, the root's essential Commands and the commands' actual owners.
   An abbreviated quick start may omit detail; it must link to the authoritative procedure and
   must not create a conflicting third version.
8. **Release documentation shape.** Check current fragment and generated-changelog claims against
   `changes/README.md` and the actual release/generation sources. Where docs promise a relation
   between the current package version, released changelog and tags, verify that relation at the
   audited revision. Do not assume a pending section, a `-dev` branch or historical line number
   is still part of the implementation. Report contradictions without rewriting release history.
9. **These briefs.** Each actual brief has the seven sections the audit README promises; the
   README index and LOG are not briefs. Check Method references and command syntax under the same
   safety boundary as steps 2–4. Check that the ledger header points to the current run protocol
   and cadence owner; leave historical rows untouched. Audit-run cadence and ledger evidence
   review belong to a scoped `process.md` run, not an implicit second audit here.
10. Produce findings and the run's ledger row under the [run protocol](README.md#run-protocol),
    within the task's publication authority.

## Evidence standard

A finding is two quoted statements (`path:line` each) that cannot both be true, or one quoted
statement and evidence that its named referent or owner routing is broken. Name the authoritative
source and audited revision; include unavailable evidence. Restatement is a finding when the
layer's job is to point rather than copy. Differences in emphasis, ordering or examples are not
drift unless readers could act on them differently. Silence in a concise root is not a defect
when its task-specific pointer reaches the owner.

## Output contract

```
Title: [audit:docs-consistency] <doc A §x> and <doc B §y> disagree about <rule> | <doc> §x points at <missing target>
Labels: audit, documentation, needs-triage
Body:
- main rev: <sha7>
- Statement A: <path:line> — "<quote>"
- Statement B: <path:line> — "<quote>" (or: Referent/routing evidence: <source or read-only output>)
- Which is authoritative: <owner and section>, because <its role and source pointer>
- Evidence boundary: <unavailable evidence, or none>
- Proposed fix: <replace copy with pointer | correct pointer | correct command | reword B to match owner>
- Mechanical PR appropriate: yes (meaning-preserving pointer/path/command/anchor correction) | no (rule substance)
```

## Not a finding

- Tone, sentence length, heading depth or table alignment.
- A one-line summary in `AGENTS.md` that points to its detailed owner.
- `docs/PLAN.md` describing something not yet built — it is the roadmap.
- Historical ADR, audit-ledger or released-changelog wording; these are preserved evidence.
- A doc silent on something another reachable owner covers.
- Root Commands, task guidance or audit pointers omitting exhaustive gate, package or label lists.

## Revisit this brief when

A documentation owner is added, split or relocated, or a link checker joins `bun run gate`
(then reuse its evidence for the references it actually covers).
