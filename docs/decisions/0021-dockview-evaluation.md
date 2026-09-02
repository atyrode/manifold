# Dockview as the tile renderer: rejected, with a named trigger

**Date:** 2026-09-01
**Status:** RECORDED — an evaluation verdict, not a ratification (operator ruling, 2026-09-01: an
evaluation that concludes "change nothing" changes no law and takes no dependency, so it is
recorded for the next reader and never ratified; the ratification table is for yeses that oblige).
Issue #126 closed by this ruling; §8's reopen trigger is the living part of this file.
**Verdict:** **REJECT-with-reasons** for the renderer seat. §8 names a four-condition trigger
that would reopen it — conditions about a library's published API and DOM, not about our
appetite — and the trigger is scoped to the genre, not to Dockview.
**Spike:** [`docs/spikes/s126-dockview/`](../spikes/s126-dockview/) — disposable, quarantined,
with its own `package.json` so Dockview is pinned **there and nowhere in `packages/`**. Its
`findings.json` and four screenshots are the evidence this record cites. Delete the directory in
the commit that acts on this ADR.

## 1. What was asked, and what was actually run

The question was narrow on purpose: not "should we use a docking library", but "can Dockview's
core take the RENDERER seat under our own tile tree, doors and algebra". Tree, algebra and doors
were explicitly out of scope. Adoption was conditional on one thing — **collaborator drag
previews surviving intact** — and the instruction was that the verdict lands as a dated record
either way.

So the spike renders **one** `TileLayout` fixture through three renderers side by side and
measures them against each other:

| Pane                                      | What it is                                                             |
| ----------------------------------------- | ---------------------------------------------------------------------- |
| `TileTree`                                | the control, painted with the real `packages/plugin/src/ui/styles.css` |
| `GridviewComponent` (dockview-core 8.2.0) | the honest shape match: a recursive split of untabbed panes            |
| `DockviewComponent` (dockview-core 8.2.0) | the only component that has drag-and-drop, with headers hidden         |

The fixture is `A | (B / (C | D))` — the three-level shape `tile-geometry.test.ts` calls
`deepLayout()` — carrying the workspace's own `0.22 / 0.78` root ratio. Every leaf hosts a
stand-in for a live terminal: a React mount counter, uncontrolled DOM state standing for
scrollback, and a `requestAnimationFrame` loop. All three trees are driven by the **real**
kernel, imported by relative path — `resolveTileAim`, `tileRects`, `paneShifts`,
`releasedTileLayout`, `projectSectionArrangement`. Nothing about the geometry was
re-implemented for the spike, which is the only way the comparison means anything.

**The library, factually.** `dockview-core` 8.2.0 is MIT, has **zero runtime dependencies**,
and ships 374,130 bytes minified without styles (524,560 with, 98,731 gzipped). Its stylesheet
is 150,300 bytes and declares **164 distinct `.dv-*` selector families**. Its ESM entry point
exports 111 names. It is well engineered and actively maintained; nothing below is a complaint
about its quality. It is a report about a shape mismatch.

## 2. The seat under evaluation is narrower than it looks

Two seats get confused when people say "the tile renderer", and separating them is most of the
analysis:

- **The renderer seat** is the `TileTree` component (`packages/plugin/src/ui/tile-tree.tsx`,
  405 lines). It has exactly **three** consumers: `workspace.tsx:853`,
  `composition-view.tsx:1104`, and `portal-element.tsx:916`/`945`.
- **The kernel seat** is the seam/zone/release math — `resolveTileAim`, `tileRects`,
  `releasedTileLayout` — and it is called from **five** modules, three of which never touch the
  renderer: `use-tile-drop.ts:453` and `tile-zone-debug.tsx:108` (the composition's own drop
  path), `arrange-overlay.tsx:417`/`524` with `arrange-logic.ts:154`/`173` (core.arrange), and —
  the interesting one — `layout.ts:256` with `sidebar-panel.tsx:287`/`329`, which is the sidebar
  rail and renders none of its rows through `TileTree`.

Line counts make the asymmetry concrete. The part of the renderer a grid library could
plausibly take over is `TileSplit`'s flex/divider painting plus the three `dividerPx`
declarations: **about 200 lines**. What stays no matter who paints the boxes is
`tile-geometry.ts` (961), `use-tile-drop.ts` (545), `tile-preview-overlay.tsx` (292),
`tile-snap.ts` (260) and `tile-release.ts` (120) — **2,178 lines** of pure, DOM-free
unit-space math and one imperative paint pass. An adoption trades 200 lines of flexbox for a
374 KB dependency and leaves the 2,178 exactly where they are.

## 3. Can it host our leaf renderers? **Yes — measured, and this is the finding in its favour**

This was the real risk going in, and Dockview passes it cleanly.

Our own renderer solves leaf survival with a documented trick: a leaf's content is never
rendered inside its box, but once into a stable host element keyed by ref identity, which a
layout effect `appendChild`s into whatever box the current tree drew (`tile-tree.tsx:32-42`,
proved by `verify-tile-drop.ts`'s remount probe). The comment in that file says the move is
"the `appendChild` move flexlayout and dockview use", and the spike confirms it from the other
side.

Measured, after a structural edit on each side — a real `releasedTileLayout` insert on ours
(7 tiles → 10), an `addPanel({ position: { referencePanel: "tD", direction: "right" } })` on
Dockview's grid (`tA..tD` → `tA..tE`):

| Renderer            | leaves after the edit | any mount generation > 1 | scrollback preserved | rAF still ticking |
| ------------------- | --------------------- | ------------------------ | -------------------- | ----------------- |
| `TileTree`          | 4                     | no                       | yes                  | yes               |
| `GridviewComponent` | 5                     | no                       | yes                  | yes               |
| `DockviewComponent` | 4                     | no                       | yes                  | yes               |

Nothing appeared in the disposal log except the rail probe's own throwaway grid. Dockview's
splitview reparents a view's element rather than rebuilding it, and its
`OverlayRenderContainer` (`renderer: 'always'`) is a more general answer to the same problem
than our appendChild — it positions a panel's DOM as an absolute overlay tracking its group,
so the DOM never moves at all.

**But this is a capability we already have and already prove.** Passing the leaf-hosting test
buys nothing; failing it would have ended the evaluation on line one. It is recorded as the
one axis where Dockview is a peer, and as the idea worth stealing (§10).

## 4. What px-math would it retire? **Less than it adds — measured**

Dockview stores sizes as **pixel counts**, not weights. `SerializedGridObject.size?: number`,
`Splitview.layout(size, orthogonalSize)`, `resizeView(index, size)`, `IGridView.layout(width,
height)`, `minimumWidth`/`maximumHeight` — every one of them is px. Worse for a translator,
each level's `size` is measured along its **parent's** axis while its children's sizes are
measured along its **own**, the `(size, orthogonalSize)` flip splitview is built on.

Our ratio tree therefore cannot enter Dockview without being multiplied through a measured
container box, on both axes, at every depth. The spike's `toSerializedGrid` is that function
and it is new code, not retired code. Our own renderer needs none of it: flexbox distributes
`flex-grow`, so the stored ratios **are** the layout, and the only measurement in the paint
path is the one `getBoundingClientRect` a divider drag takes on pointer-down.

And the conversion is lossy in a way that shows. Two siblings stored at `0.5 / 0.5` must stay
equal at every viewport width, because a reader who has never dragged that divider must not
see it drift. Measured, resizing the host from 900 px to 560 px and back:

| width  | `TileTree` tC / tD | `GridviewComponent` tC / tD |
| ------ | ------------------ | --------------------------- |
| 900 px | 0.3836 / 0.3836    | 0.3900 / 0.3900             |
| 560 px | 0.3797 / 0.3797    | **0.3911 / 0.3893**         |
| 900 px | 0.3836 / 0.3836    | 0.3900 / 0.3900             |

`proportionalLayout: true` restores proportions approximately, on the way back. At the
intermediate width the two halves are no longer halves. Ours drift together, because they are
never anything but a ratio.

The honest ledger, then. **Retired:** `TileSplit`'s `flex-grow` normalisation, its
`beginDrag`/`moveDrag`/`endDrag` pointer capture, and `resizeRatios`/`dividerRatios` — replaced
by Dockview's sashes, at the cost of a new sash-position→ratio conversion so the stored tree
still holds ratios the door accepts. **Added:** the ratio→px translator above, on every layout
pass. **Untouched:** `areaUnits`' px→unit conversion (`use-tile-drop.ts:87-97`), `ROOT_RING_PX`,
and all 961 lines of `tile-geometry.ts`, because none of it is about who paints the boxes.

## 5. Can the carry pipeline's previews and collaborator drags survive? **No. This is the kill criterion, and it fails.**

### 5.1 What has to survive

`TilePreviewOverlay` (`tile-preview-overlay.tsx`) is one code path for a local drag and a
peer's. Its entire local-vs-remote logic is arbitration — choose whose `(aim, ref, label)`
triple enters the builder — and everything downstream "cannot ask who produced it", which is
invariant 11 discharged by construction. A collaborator's carry arrives as a wire aim with **no
local pointer at all**: `drop.previewOf(remote.aim, remote, remote.label)`.

What that one path then paints:

1. a **landing slot** as a percentage rect over the area, with the carried item's glyph and label;
2. an **`is-partner` box** for the far half of a swap;
3. a **denial** (`is-denied`, `.drop-denial-note`) with prose, when the peer's aim is refused;
4. a **replace caption** naming the occupant that moves out;
5. and the **FLIP**: for every `PaneShift`, a `transform: translate(%) scale()` written directly
   onto the box `TileTree` already owns, so the real panes glide and squeeze into their
   prospective places while only the slot is a ghost. Percentages, so it is scale-invariant
   under the portal's `scale(0.5)` and any canvas zoom.

### 5.2 Dockview's own facility, tried at its best

`GridviewComponent` — the shape match — has **no drag-and-drop at all**. Its entire option
surface is `{ disableAutoResizing, proportionalLayout, orientation, className, hideBorders }`.
The drop machinery lives on `DockviewComponent`, which imposes tab **groups**.

So the spike mounted the dock too, with `header.hidden = true` on every group, and drove
Dockview's best facility for painting a drag nobody local is performing:
`Droptarget.showOverlay(position)`, which exists expressly to "render the drop overlay at
`position` without a live drag, so keyboard docking shows the exact same preview as a mouse
drag". The `Droptarget` class is not among the 111 public exports — but
`group.model.contentDropTarget` is a public getter, so it is reachable, and the spike called it.

**It works, and it is not enough.** Measured: `showOverlay("left")` with no drag in flight
painted one `.dv-drop-target-dropzone`, 224 × 259 px, over the left half of one group. Vision
confirms a flat translucent rectangle with no glyph, no caption, no partner box, no denial
prose, and no pane motion of any kind. Against our five-item list above, it delivers a dimmer
version of item 1.

The codomain is the deeper problem. `showOverlay` takes one of **five** `Position` values
against **one** group: with four groups, **20** expressible destinations. Over the same 81 × 81
pointer field on the same tree, `resolveTileAim` produces **25** distinct outcomes, and the
difference is not size but kind — **8** of ours address an **ancestor split** (`root|left|…|0`,
`tCol|left|…|1`), **2** are **between-seam** wedges that insert between two siblings rather than
splitting one, and the action vocabulary includes `swap` and `replace` where Dockview has only
"dock here". Dockview 8.2.0 does publish a `PositionResolver` hook, and it is genuinely useful —
but its return type is `Position | null`, so it can change _which of five_ a pointer resolves to
and cannot ever return "the split two levels up, between children 1 and 2".

### 5.3 The FLIP, painted into both DOMs

The decisive test was to stop reasoning and paint it. The spike computes the real `PaneShift`
set for a root-ring aim — the maximal case, where every pane on screen glides at once — and
writes `tile-preview-overlay.tsx`'s exact transform strings into both DOMs, then screenshots.

Addressability first, because the FLIP needs a box per moving pane:

| consumer                                              | boxes needed | `TileTree` | `GridviewComponent` |
| ----------------------------------------------------- | ------------ | ---------- | ------------------- |
| preview FLIP (`paneShifts` pairs occupied **leaves**) | 4            | 4          | 4                   |
| arrange wireframe (`measureRects`, "splits too")      | 7            | 7          | **4**               |

The FLIP's four boxes resolve — but only because the spike stamps `data-tile-id` on the panel
element it owns. The wireframe's do not: `.dv-branch-node` carries a `class` attribute and
nothing else, so **0 of 3** splits are addressable, and `arrange-overlay.tsx`'s depth-stepped
outline over every split container has nothing to measure. That is core.arrange's headline
affordance, on the same surface, in the same gesture.

Then the paint itself. Three of the four moved panes landed **3–4 px** away from their computed
destination (`tA` drew `x=1381 w=98` against a wanted `x=1377 w=97`; `tB` drew `1477/346`
against `1480/344`; `tD` drew `1652/171` against `1655/169`), because Dockview's 4 px sash and
our 5.6 px divider account for the gutter differently. A preview that shows the pane landing
somewhere it will not land is precisely what `verify-tile-drop.ts`'s "highlight equals outcome"
round exists to forbid.

And visually it is worse than a 4 px error. Inspecting `shot-4-collaborator-preview.png`: the
control shows every pane compressed cleanly to the right of the blue landing slot, borders
meeting edge to edge, nothing clipped. Dockview's pane shows **two of the four moved panes
absent from the picture entirely**, a large undifferentiated dark band where they should be,
the slot rectangle **truncated** short of the tiles' bottom edge, and **two horizontal
scrollbars** that were not there before.

The cause is structural, in Dockview's own stylesheet, and it is not a tuning problem:

- `.dv-split-view-container { overflow: hidden }` — **every branch node clips**. Our FLIP
  routinely paints a pane outside its current parent's box, because that is what "this subtree
  gives up half its width" looks like mid-gesture. Dockview cuts it off at the branch.
- `.dv-split-view-container .dv-view-container .dv-view { overflow: auto }` — **every leaf
  scrolls**. A pane scaled up by the FLIP grows a scrollbar instead of overflowing, which is
  where the two scrollbars came from.
- `.dv-split-view-container.dv-animation .dv-view` and `.dv-pane-container.dv-animated .dv-view`
  both set `will-change: transform; transform: translate3d(0, 0, 0)`. In its animated modes
  Dockview is a **second writer on the exact CSS property our preview owns**.

Making the FLIP work inside Dockview means overriding `overflow` at every branch and leaf of the
vendor's grid, and keeping `transform` uncontested — that is, defeating the layout containment
its sizing model assumes. That is not integration; it is a fork with extra steps, and it is the
same defect class as the hand-rolled chrome this codebase just paid to delete, pointed the other
way.

**The kill criterion was "adoption ONLY if collaborator drag previews survive intact". They do
not survive intact. Under the terms of the spike, that settles it.**

## 6. What does the rail projection do inside it? **Nothing, because the rail was never a renderer caller**

This was the question with the most surprising answer. The sidebar rail is "a TILE TREE in
disguise" (`sidebar-panel.tsx:107-113`): `projectSectionArrangement` builds a **synthetic**
`TileLayout` per pointer frame — a column split whose tile ids are node paths, whose extents are
the measured row heights, and whose unpainted rows take `UNPAINTED_EXTENT` (1e-4) so a disabled
plugin's row keeps its place in the tree while being too small for any pointer to land on
(D4′) — hit-tests it with `resolveTileAim`, applies `releasedTileLayout`, reads the arrangement
back out, and throws the tree away. The doc comment says why: "there is one kernel and this is a
second caller of it (AGENTS.md invariants 11 and 14)".

`sidebar-panel.tsx` imports **zero** symbols from `tile-tree.tsx`. The rail paints its own rows,
disclosures, clusters and stacks. So a Dockview renderer would touch the rail not at all — which
sounds like good news and is actually the finding:

- The rail gets **no benefit**. Its cost is in the kernel it shares, and the kernel stays.
- If anyone later proposed pushing the _zone resolution_ into Dockview's `PositionResolver` to
  avoid keeping two resolvers (§7), **the rail loses its kernel**, because Dockview's drop
  resolution is a method on a `Droptarget` constructed over a live `HTMLElement`, and the rail's
  tree has no DOM: it is a projection that exists for the duration of one pointer frame.
- The spike proved this by doing it. Feeding the rail's projection to a `GridviewComponent`
  works numerically — asked for 359.9998 / 239.9998 / 0.0002 / 0.0002 px, got 360 / 240 / 0 / 0,
  with `minimumHeight: 0` throughout — but it required constructing and disposing an entire
  Dockview component to answer one hit-test. Those four panels are the **only** entries in the
  spike's disposal log.

Five callers of one kernel is invariant 14 satisfied. A renderer that can serve only the two
that actually paint through it, and that would cost the other three their kernel if pushed
further, is a renderer that makes the architecture worse in exchange for 200 lines.

## 7. What adoption would cost besides code

- **A second zone resolver in the tree.** Dockview's droptargets resolve their own quadrants on
  the group content. Either they run beside `resolveTileAim` — two mechanisms for "where does
  this carry land", which invariant 14 calls a bug and not a style choice — or `disableDnd:
true` switches them off, at which point we are taking 374 KB for flexbox and a sash.
- **164 unregistered CSS families.** S13 reads every `.css` file under `packages/` against
  §Lexicon `cssFamilies` and is RED for "a family with no row" and for "a rule defined by
  anyone but the owner of the leftmost family it scopes into". The vendor stylesheet itself
  lives in `node_modules` and is out of that scope — but the override rules §5.3 shows we would
  need are rules in **our** stylesheet whose leftmost family is `.dv-split-view-container`.
  Either S13 goes red, or a vendor's 164-name vocabulary enters our lexicon.
- **A DOM contract with a vendor's internals.** `TileGeometryHandle.getTreeElement()` hands
  plugins the tree's root element, and `core.arrange` queries `[data-tile-id]` through it. Under
  Dockview, the boxes on the other side of that handle are `.dv-view` and `.dv-branch-node` —
  class names with no stability promise, one of which carries no identity at all.
- **`verify-tile-drop.ts` rewritten wholesale.** Its eight rounds assert against `[data-tile-id]`
  and the class substrings `is-swap`, `is-denied`, `is-idle`, `is-replace`, `is-remote`,
  `is-carried-away`, `is-column`. Every one of those is our renderer's vocabulary.
- **Invariant 8's bill.** A runtime dependency needs "boring, small, pinned". Dockview is
  pinned-able and dependency-free, so two of three hold. 374 KB minified for the 200 lines
  identified in §2 is not small in the sense the invariant means.

## 8. Decision

**REJECT Dockview for the renderer seat.** Keep `TileTree`. The kill criterion the operator set
was collaborator drag previews surviving intact, and §5 measures them not surviving: the pane
FLIP is clipped by containment Dockview's grid depends on, the arrange wireframe loses 3 of 7
boxes to branch nodes with no identity, and the vendor's own no-drag overlay can express 20
destinations where our aim space has 25 of a different kind. Nothing here is a bug in Dockview.
It is a docking library — tabs, groups, floating panels, popouts, px sizing, contained
layout — and we are a ratio-tree renderer whose defining feature is a preview that repaints the
whole tree from a remote peer's serialized intent.

**DEFER trigger, named so this is not re-litigated by mood.** Reopen — for Dockview or for any
library in this genre — when _all four_ hold:

1. A drop preview that is **public in both halves** — the painter AND the geometry that decides
   what it paints — drivable from a serialized position with no live drag, on an instance that a
   local gesture does not share and hide. §9.1 is why both halves are named: Lumino publishes
   the painter and keeps the geometry private, which leaves us reimplementing the 961 lines the
   adoption was supposed to retire.
2. A codomain that can name a **non-leaf node** and a **between-sibling insertion**, not only
   one of five positions on one cell — because 8 of our 25 measured aims address an ancestor
   split and 2 are between-seam wedges.
3. A layout mode without `overflow` containment at branch nodes and leaves, so a consumer may
   paint a pane outside its current box, and no vendor writes to `transform` on the boxes it
   hands out.
4. Node sizes expressible as **weights**, not pixels, so a ratio tree is not lossy on the way
   in. (Both alternatives already pass this one; Dockview does not.)

Separately and independently: if the product ever wants **tabbed groups, floating panels or
popout windows**, this ADR does not apply, because the seat under evaluation changes from "the
split renderer" to "a new tab-group discipline", and Dockview would then be the leading
candidate on the strength of §3 alone.

**No code changes ship with this record.** No `packages/*/package.json` gains a dependency, no
`bun.lock` entry is added outside the quarantined spike directory, and `TileTree` is untouched.

## 9. Alternatives noted

The library round named two. Both were read at their source and their shipped `.d.ts` rather
than re-spiked, because the kill criterion is what does the work and it can be answered from an
entry point: **is there a public way to render this library's drop preview from a serialized
position, with no local drag in flight?**

### 9.1 Lumino 2.9.0 (BSD-3-Clause) — the closest anyone gets, and it still is not close

`@lumino/widgets` 2.9.0, published 2026-07-03, BSD-3-Clause, 11 first-party transitive
dependencies, actively maintained by JupyterLab (last commit 2026-08-03).

Lumino is the only one of the three that publishes the primitive. `DockPanel` exposes
`readonly overlay: DockPanel.IOverlay` (present in the shipped `types/dockpanel.d.ts:52`), whose
`show(geo: IOverlayGeometry): void` takes four absolute offsets and has **no dependency on a
drag gesture whatsoever**. `DockPanel.Overlay` is an exported, constructible class;
`DockPanel.IOptions.overlay` lets a consumer inject their own; and
`DockLayout.hitTestTabAreas(clientX, clientY)` is public. On paper that is a remote-drag painter.

It also gets §4 right where Dockview does not: `ISplitAreaConfig.sizes` is documented as "the
relative sizes of the children", and `SplitLayout.relativeSizes()` /
`setRelativeSizes()` normalise rather than store pixels. And DOM survives moves by two
independent guards — `Widget`'s parent setter early-returns on an unchanged parent
(`widget.ts:234-237`) and `DockLayout.attachWidget` early-returns when the node is already
parented correctly (`docklayout.ts:546-549`).

Four things then undo it, and they are the same four shapes §5 found in Dockview:

- **The rectangle is public; the math that decides the rectangle is not.** Turning a position
  into an `IOverlayGeometry` is `private _showOverlay(clientX, clientY)` over a module-private
  `Private.DropZone` (`dockpanel.ts:806-905`). We would reimplement the zone geometry — which
  is exactly the 961 lines we already own, so the library retires none of it.
- **One overlay instance, contested.** `this.overlay = options.overlay || new
DockPanel.Overlay()`, and `DockPanel`'s own drag handlers call `overlay.hide(0)` on
  `lm-dragleave`/`lm-drop`. A local drag and a peer's drag on the same panel fight over one
  node, so each remote carry needs its own `new DockPanel.Overlay()` — a second, parallel
  preview mechanism beside the library's own, which is invariant 14's failure mode by
  construction.
- **One rectangle is all it is.** No partner box, no denial prose, no replace caption, and above
  all **no pane motion**: our preview's headline is that the real panes glide and squeeze, and
  an overlay API paints over them, never with them.
- **Every `DockPanel` leaf is a tab area with a real `TabBar`.** Untabbed panes mean composing
  `SplitPanel`/`BoxPanel` yourself — which forfeits `DockPanel`'s dock behaviour and therefore
  its overlay, the one thing we came for. Add that `AreaConfig` embeds live `Widget[]`
  references (so `saveLayout()` is not serialisable), 11 transitive `@lumino/*` dependencies,
  and that it is not a React library at all but an imperative signal/message widget graph.

### 9.2 FlexLayout (`flexlayout-react` 0.10.8, MIT) — the best React citizen, categorically closed

`flexlayout-react` 0.10.8, published 2026-09-01, MIT, **zero** runtime dependencies, very
actively maintained (nine releases between 2026-07-14 and 2026-09-01 — which also means an ADR
that referenced it would have to pin hard).

FlexLayout is the nicest neighbour of the three: React 18/19 peers,
**relative weights** (`attributeDefinitions.add("weight", 100)` … "relative weight for sizing of
this row in parent row", on both `RowNode` and `TabSetNode`), effectively headerless panes via
`enableTabStrip: false`, and DOM preservation that is better than ours: each `TabNode` owns a
lazily created, cached `moveableElement` that content is portalled into, carried across model
replacement on purpose ("carry view state to keep mounted tab content on model replacement",
`TabNode.ts:389-391`).

One caveat worth recording because it is a real hazard for us and not for most consumers: the
DOM preservation holds **within a document**. Moving a pane into a popout window crosses
documents and does remount, which is what `enableWindowReMount` and the `moveablesHome` staging
div exist for. A live xterm would need re-attach handling for that path specifically.

And it is a categorical no on the criterion. The drop preview is `DragDropManager._outlineDiv`,
a private field created inside live pointer handling (`DragDropManager.tsx:306-368`);
`view/layout/DragDropManager` and `view/Overlay` are both absent from the 25 re-exports in
`src/index.ts`. The hit test that produces a `DropInfo` is `Model.findDropTargetNode`, marked
`@internal` and **stripped from the shipped types**. `IDropTarget` is re-exported but ships as a
literally empty interface, `stripInternal` having erased `canDrop`/`drop`/`isEnableDrop`. The
whole public imperative surface, `ILayoutApi`, has no overlay method, and its two drag entries
are documented as "must be called from within an HTML drag start handler" — i.e. they require a
real `DragEvent`, which a peer's carry does not have. `DropInfo` is exported with intact fields
and there is no public sink that renders one. It is also uncontrolled: `ILayoutProps.model` is a
mutable `Model` driven by `doAction`, with an `@internal protected` constructor.

### 9.3 What the three have in common

Reading the entry points back to back makes the pattern plain, and it is sharper than "they all
fail". **Every one of them treats a drop preview as feedback for a LOCAL gesture.** Dockview
publishes events that observe one; FlexLayout hides the machinery entirely; Lumino publishes a
rectangle painter and keeps private the geometry that decides which rectangle — while its own
local drag shares the single instance and hides it. Nobody publishes a drop preview as a
**projection of someone else's serialized intent**, because outside a multiplayer workspace
nobody needs one.

That is not a gap in three libraries. It is the assumption the genre is built on, and it is the
assumption this product exists to break. It is the strongest single argument that this renderer
is ours to own.

## 10. What we keep from the exercise

Rejecting the dependency is not the same as learning nothing:

- **`OverlayRenderContainer` is a better appendChild.** Dockview's `renderer: 'always'` mode
  keeps a panel's DOM in one absolutely-positioned container that tracks its group, so the DOM
  never moves and no reparent can tear it. Our stable-host-plus-`appendChild` achieves the same
  invariant by moving the host. If the remount probe ever gets fragile, that is the shape to
  move to, and it needs no dependency to adopt.
- **`PositionResolver` is the right seam, in the wrong place.** Dockview 8.2.0 made "how does a
  pointer location become a drop position" an injectable interface. That is exactly the
  factoring `tile-geometry.ts` already has; worth remembering as external corroboration that the
  seam belongs where we put it.
- **The spike's own instrument is reusable thinking.** Painting the real `PaneShift` transforms
  into a candidate DOM and screenshotting it turned a design argument into a picture in about an
  hour. Any future renderer proposal should be made to survive that test before it is discussed.

## Ratification asks

- **R1.** Is REJECT-with-reasons the verdict, on the kill criterion as measured in §5?
- **R2.** Are the four DEFER conditions in §8 the right ones, and is the trigger correctly
  scoped to the whole genre rather than to Dockview alone? Condition 3 (no `overflow`
  containment at branch nodes) is the one that asks a vendor to give up something its sizing
  model uses — is requiring it fair, or should the trigger rest on conditions 1 and 2 only?
- **R3.** Does the tabs/floating/popout carve-out at the end of §8 stand as written — that a
  future tab-group discipline is a **different** decision this record does not prejudge?
- **R4.** Is §6's finding accepted as the load-bearing one for architecture — that the rail
  being a second **kernel** caller and not a **renderer** caller is what makes the renderer seat
  not worth trading?
- **R5.** Delete `docs/spikes/s126-dockview/` on ratification, or keep it until the DEFER trigger
  is evaluated once?
