# 0005 — Maintain a source-level Excalidraw fork instead of patching dist bundles

Date: 2026-08-25
Status: superseded by the React Flow and native scene-record cutover (#15)

## Context

Decisions 0002 and 0004 shipped product-critical Excalidraw behavior as a `bun patch`
against the minified dist bundles of `@excalidraw/excalidraw@0.18.1`. That patch grew
to a 157-line diff over the dev AND prod bundles carrying real product semantics
(link affordance off, whole-element click-to-activate, collaborator cursor color) as
regex-brittle edits to generated code no reviewer can read. Two further behaviors
lived as CSS overrides on undocumented internal class names
(`.excalidraw__embeddable-hint`, `.selected-shape-actions` keyed off an app-managed
root class) — seams that break silently on any upstream markup change. The
composable-UI roadmap (manifold#15 §3) is fork-territory regardless.

## Decision

Maintain `atyrode/excalidraw-manifold`: a **fresh mirror** of upstream at tag
`v0.18.1` (commit `a2ec2889`), branch `manifold` — NOT the pad.ws-era
`atyrode/excalidraw` fork (clean-room invariant; that lineage is never consulted).
This supersedes the **mechanism** of 0002/0004 only; every behavior's semantics are
unchanged, re-derived as readable, typed source changes following one rule:
per-element `customData` gates, stock behavior when the flag is absent, additive
diffs only. The two CSS seams became proper gates in the fork: the hover hint is not
rendered for `fullInteractionTarget` elements, and `showSelectedShapeActions` returns
false when a non-empty selection consists entirely of `showShapeActions: false`
elements (mixed selections still show the panel, matching the old app logic).

- Package name stays `@excalidraw/excalidraw` (zero import churn); versions are
  `0.18.1-manifold.N`.
- Distribution: GitHub release tarball URL dependency in `packages/web/package.json`
  (`releases/download/v0.18.1-manifold.1/excalidraw-excalidraw-0.18.1-manifold.1.tgz`);
  bun resolves it into `bun.lock`. The orphan `dist-*` tag git-dep fallback was not
  needed.
- Sync policy: deliberate and infrequent — rebase `manifold` onto a new upstream tag,
  re-run the fork's release procedure (see its AGENTS.md), bump the dep URL here, and
  `bun run gate` must be green before the sync is real.

## Alternatives rejected

- **Continuing the bun patch**: unreadable minified-bundle diffs, regex-brittle
  regeneration on every version bump, and structurally unable to carry UI
  composition work.
- **Reusing `atyrode/excalidraw`**: pad.ws-era lineage violates the clean room, and
  it occupies the account's one GitHub fork slot.
- **`@zsviczian/excalidraw`**: maintained for Obsidian's priorities, not manifold's.

## Revisit when

Upstream releases the `ui`/`interaction` config (manifold#15 §5, present on master,
unreleased) — a candidate to shrink the fork diff on the next sync.
