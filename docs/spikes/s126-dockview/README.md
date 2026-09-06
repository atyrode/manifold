# s126-dockview — DISPOSABLE spike (issue #126)

**This directory is throwaway evidence, not application code.** Nothing under `packages/`
imports it, no `package.json` script runs it, no gate reads it. It exists so that
[`docs/decisions/0021-dockview-evaluation.md`](../../decisions/0021-dockview-evaluation.md)
can say "measured" instead of "presumably", and it should be deleted in the commit that
ratifies or supersedes that record.

It has its own `package.json` and its own `node_modules` precisely so that the evaluation
never touches the shipped dependency set: Dockview is pinned **here** and nowhere else, and
`@manifold/web` is unchanged. If you are reading this and Dockview appears in a
`packages/*/package.json`, that happened somewhere else and for some other reason.

## What it does

Renders **one** `TileLayout` fixture twice — once through our own `TileTree`
(`packages/plugin/src/tile-tree.tsx`, the control, painted with the real
`packages/plugin/src/styles.css`) and once through Dockview's `GridviewComponent` — then
runs eight probes against both DOMs and writes the answers to `findings.json` plus four
screenshots.

The fixture is `A | (B / (C | D))`: the three-level shape `tile-geometry.test.ts` calls
`deepLayout()`, carrying the workspace's own `0.22 / 0.78` root ratio. Each leaf hosts a
stand-in for a live terminal — a React mount counter, uncontrolled DOM state standing for
scrollback, and a `requestAnimationFrame` loop — so "did the renderer tear my leaf down"
is a number rather than an impression.

Both trees are driven by the REAL kernel, imported by relative path: `resolveTileAim`,
`tileRects`, `paneShifts`, `releasedTileLayout`, `projectSectionArrangement`. Nothing about
the geometry is re-implemented for the spike, which is the only way the comparison means
anything.

## Running it

```sh
cd docs/spikes/s126-dockview && bun install   # once; installs dockview 8.2.0 HERE only
bun docs/spikes/s126-dockview/run.ts          # from the repository root
```

It bundles `harness.tsx` with `Bun.build`, serves it on `:9426`, drives it through the
repository's own CDP client (`scripts/cdp.ts` — the one `verify-tile-drop.ts` uses) on
`:9427`, and prints the findings. One react instance is forced by a resolver plugin in
`run.ts`: the spike directory and `packages/plugin` both import react, and two copies would
break hooks across the boundary.

`harness.tsx` imports from `dockview-core` only. The `dockview` package is installed for one
file — `dist/styles/dockview.css` — because a candidate judged without its own stylesheet is a
candidate judged unfairly, and `overflow` rules in that sheet turn out to be the finding (ADR
§5.3).

## The files

| File            | What it is                                                              |
| --------------- | ----------------------------------------------------------------------- |
| `harness.tsx`   | Both renderers, the leaf stand-in, the ratio→px translator, the probes  |
| `run.ts`        | Bundle, serve, drive, screenshot, dump `findings.json`                  |
| `index.html`    | Loads `dockview.css`, the real `plugin.css`, and the spike's own chrome |
| `harness.css`   | Spike-local chrome ONLY; the control's skin is the application's own    |
| `findings.json` | The measured answers the ADR cites                                      |
| `shot-*.png`    | Baseline, resized, after-split, and the collaborator-preview paint      |
