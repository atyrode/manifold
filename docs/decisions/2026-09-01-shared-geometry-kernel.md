# Where geometry two sibling plugins both need is allowed to live

Date: 2026-09-01
Status: accepted

## Context

Sibling plugins may not import each other. `verify:axioms` S2 holds a package under
`packages/plugins/*` to `@manifold/protocol`, `@manifold/scene`, `@manifold/sdk`,
`@manifold/plugin` (plus `/hooks` and `/ui`) and its own sources, and that is correct law:
`core.draw` reaching into `core.canvas` would make one plugin's disablement break the other's
build, which is exactly what A1 denies.

The law had the wrong outcome twice (issue #117):

1. `packages/plugins/draw/src/web.tsx` re-implemented `strokePath` and `strokeViewBox`
   byte-for-byte equivalent to `packages/plugins/canvas/src/stroke.ts`'s `pointsToPath` and
   `strokeViewBox`, justified by a comment citing a floor-import restriction that did not apply
   to it — `stroke.ts` was a sibling plugin's module, not a floor module. The comment was stale
   AND the duplication was real.
2. `portal-element.tsx`'s `soloTerminalLeaf` and `composition-view.tsx`'s `soloOccupancy` walked
   the same `TileLayout` for the same arity fact, with the same edge case (an EMPTY second leaf
   still ends solo), written independently.

Both are silent-divergence shapes: nothing throws when two copies of a viewBox formula or two
copies of an arity rule drift, the two surfaces just disagree about where the ink is or about
whether a container is still one thing.

## Decision

The two facts go to DIFFERENT floors, because the litmus gives them different answers.

### The arity fact joins the `protocol` pillar

`soloLeaf(layout): { tileId, ref } | null` lands in `packages/protocol/src/layout.ts`, beside
`validateTileLayout`, in the file that declares `TileLayout`.

- **Bootstrap circularity** — it is a derivation of `TileLayout`, a type nothing in the tree can
  read a container without. It presupposes no plugin; every renderer of a container presupposes
  it.
- **Neutrality** — it reads `dir` and `ref`, both fields this file defines, and names no plugin
  and no element kind. Replace every plugin in the tree and it is unchanged.
- **Arbitration** — the pillar's admitted verdict is that protocol "arbitrates by being the
  single definition every party is measured against". Two hand-rolled walks that could disagree
  about whether an empty second leaf counts is precisely the arbitration that was missing.

No file crosses the floor boundary and no pillar glob changes: `packages/protocol/src/**`
already claims the file. `soloLeaf` is deliberately distinct from `censusSolo`, which counts a
container's OCCUPANTS and therefore calls a terminal beside an empty leaf solo. The two answer
different questions — "what does it hold" versus "is it still one thing" — and both doc comments
say so, so the next reader does not unify them by accident.

### The geometry joins the `assembly-engine` pillar — as POLYLINE, never as STROKE

`packages/plugin/src/polyline.ts` (`polylineBounds`, `polylineViewBox`, `polylineRelativeTo`,
`polylinePath`), published through `@manifold/plugin/hooks`.

- **Bootstrap circularity** — element-plane mechanism. The protocol carries a scene element as a
  neutral envelope and bounds its payload without reading it (ADR 0013 §16); what a renderer and
  an author both need from a coordinate payload — extents, and the path data that paints them —
  is the plane's own geometry, exactly as `tile-geometry.ts` is the tile plane's, and both halves
  are already reachable only through the engine's element host.
- **Neutrality** — THIS is the criterion that decided the name, and it is the reason the move is
  not the one the issue's prose sketched. "Stroke" is `core.draw`'s domain noun (REGISTRY.md
  §Lexicon: "one freehand ink record"), and the pillar whose verdict is "it names no plugin" may
  not learn it — `SceneElementSchema` deliberately UNLEARNED `draw` for the same reason. A
  polyline is a coordinate sequence. So the module speaks polylines, `margin` is a number rather
  than a stroke width, and the ink stayed behind: `STROKE_MIN_DISTANCE`, `DEFAULT_STROKE_WIDTH`,
  `appendPoint` and the commit into a scene record remain `core.canvas`'s.
- **Arbitration** — it is the single definition the two renderers of one coordinate list are
  measured against, and neither party could be trusted to hold the other's copy.

`packages/plugin/src/**` already claims the file, so this costs the floor row's `why` (naming
what the module is) and a `polyline` lexicon row (saying what the word means and that it is not
`stroke`) rather than a pillar edit. S16's budget is the standing counterweight: the floor grew
by ~45 source lines and shed two copies of the same math.

## Consequences

- `@manifold-plugin/draw` gains `@manifold/plugin` as a dependency; its renderer imports the two
  string producers and owns only the STROKE — which payload fields carry one, what an older
  client's record falls back to, and that the ink is its own hit target. The stale
  floor-import comment is deleted.
- `core.canvas` keeps the gesture sampling and the scene commit and calls the shared geometry for
  both, so the in-flight preview and the committed element cannot diverge.
- `core.compositions` and `core.canvas` both call `soloLeaf` and keep only their own translation
  of the result — a `PlacementItem` kind in one, a terminal species test in the other.
- Unit coverage moved with the code: `packages/plugin/test/polyline.test.ts` for the geometry,
  the arity edges in `packages/protocol/test/messages.test.ts`, and
  `packages/plugins/canvas/test/stroke.test.ts` reduced to the sampling rule it still owns.

## What this decision does NOT license

A helper is not floor because two plugins want it. The test is the litmus, and the neutrality
criterion is the one that does the work: if removing every plugin from the tree would leave the
module talking about something that no longer exists, it is a plugin's code and the duplication
must be solved another way — by giving the concept a single owning plugin, or by the projection
registry, which is already the door through which one renderer paints another plugin's occupant.
`packages/plugin/src` is where growth lands first because every plugin reaches it with no
boundary crossing to notice; S16 counts it for exactly that reason.
