# 0002 — Patch @excalidraw/excalidraw instead of forking it

Date: 2026-08-24
Status: superseded by the React Flow and native scene-record cutover (#15)

## Context

Terminal embeds carry `link: "manifold://terminal"` as their embeddable discriminator
(`validateEmbeddable` requires a link at Excalidraw 0.18.1). Stock Excalidraw
unconditionally paints a link badge into the canvas at the element's top-right corner,
shows a pointer cursor over it, and navigates on click. There is no prop, `UIOptions`
member, or CSS hook to suppress it: the badge is bitmap-painted (`renderLinkIcon`) and
hit-tested (`isPointHittingLinkIcon`) inside the package. This is the single behavior
from the v1 pad.ws fork survey (manifold#15) that cannot be reproduced app-side.

## Decision

Use `bun patch @excalidraw/excalidraw` (tracked at
`patches/@excalidraw%2Fexcalidraw@0.18.1.patch`, wired via `patchedDependencies`)
rather than maintaining a fork. The patch adds one re-derived guard to each of the two
functions, in both the dev and prod bundles: elements with
`customData.showHyperlinkIcon === false` skip badge painting and link hit-testing.
Default behavior for every other element is unchanged (`!== false` keeps stock
semantics). The web layer sets the flag on terminal elements at creation and at
session-bind; the protocol's `TerminalCustomDataSchema` is a loose object, so the key
survives the wire (guarded by a protocol test).

### Addendum (same date): terminal interaction model

Stock 0.18.1 gates embeddable interaction behind a hover pill ("Click to
interact") plus a quick (<300 ms) click inside the element's **center third**
(`isIframeLikeElementCenter`), applies activation through a 100 ms `setTimeout`,
and pops the hyperlink editor when a linked element is selected. For terminals
we want macOS-multiplexer semantics: idle = readable under a faint veil with
the canvas owning pan/wheel/draw, one click-release anywhere = focused and
typeable instantly, drag = move without focusing. That behavior lives in the
same patched-guard family, all keyed on the two customData flags:

- `fullInteractionTarget: true` — `isIframeLikeElementCenter` treats the whole
  bounds as the activation target (all quick-click callsites funnel through
  that one predicate); the pointer-up gate drops the <300 ms limit for flagged
  elements unless a drag occurred (`pointerDownState.drag.hasOccurred`); the
  activation `setTimeout` becomes 0 ms so click→focus→type has no dead window.
  Mobile's separate quick-tap path is deliberately left stock.
- `showHyperlinkIcon: false` — badge painting, link hit-testing (0002 proper),
  and every `showHyperlinkPopup: "info"` setter skip flagged elements, so
  focusing a terminal never surfaces the internal `manifold://terminal` URL.

Absent the flags every predicate is byte-identical to stock. The rest is
app-owned: the idle veil and focus handoff render from
`appState.activeEmbeddable` in our `renderEmbeddable`/`TerminalView`
(xterm `cursorBlink` signals readiness), and the now-redundant hover pill is
hidden with plain CSS (it is DOM, not canvas).

## Alternatives rejected

- **Fork (v1 approach)**: bought the same behavior at the cost of a publish pipeline,
  15 release bumps, and 327 commits of upstream drift. See manifold#15 forensics.
- **Overlay/CSS**: cannot affect canvas-painted pixels or canvas hit-testing.
- **`onLinkOpen` preventDefault only**: stops navigation but leaves the painted badge
  and pointer cursor.

## Revisit when

Upstream ships the `ui`/`interaction` config (present on master, unreleased). On any
Excalidraw version bump the patch must be regenerated against the new bundles; `bun
install` fails loudly if it no longer applies.
