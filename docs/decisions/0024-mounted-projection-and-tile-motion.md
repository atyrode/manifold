# 0024 — Mounted projection and tile motion

Date: 2026-09-05  
Status: Accepted implementation decision for #216, #219 and #222; reviewable with the change.

## Problem

Presence must follow the ancestry of a mounted renderer, not a second roster inferred from
room membership. A draggable surface must expose its own titlebar, without a separate grip.
Incoming previews, source departures and committed tile layouts must use one motion owner,
including fullscreen compositions and transitions between one and several leaves.

These requirements cross the canvas, composition, terminal and presence plugins. Putting the
shared mechanism in one of those plugins would either make the others import it or create a
second implementation. The policy still belongs to plugins: who is present, how an avatar is
painted, which objects a renderer offers, and which actions its controls invoke.

## Decision

Extend the existing `assembly-engine` pillar's renderer standard library, without admitting a
new pillar or a new core plugin:

- `projection.ts` carries a mounted `ProjectionScope`, canonical reference ancestry and an
  optional titlebar outlet. Renderers declare the ancestry they actually mount; the presence
  plugin consumes it. Disabling an optional contribution does not remove its host's chrome.
- `NodeTitleBar` accepts host-owned drag callbacks. The shared boundary excludes controls,
  editable content and selected text; it does not choose a placement or own a carry transport.
  A preview's PTY remains read-only independently of its host's titlebar actions.
- `TileTree` owns stable content hosts and their visual transitions. `TilePreviewOverlay`
  projects both incoming and departing layouts through that owner. Carry arbitration happens
  before motion: no downstream animation chooses a local or remote rendering variant.

The admission applies to these mechanisms, not to domain-specific rendering or a second
placement implementation. Existing `core.space` actions remain the authority at commit.

## Foundation litmus

### Bootstrap circularity

The host must name and mount contributions before those contributions can cooperate. Mounted
ancestry, optional outlets and stable layout hosts therefore exist even when the contributing
presence or element plugin is disabled. An optional plugin cannot supply the contract its own
mounting and absence handling require.

### Neutrality

The new contracts use reference paths, contribution metadata, host-supplied callbacks and tile
geometry. They do not select a plugin id, principal kind, avatar style or element species.
Replacing every plugin leaves these contracts meaningful; an absent contribution leaves its
host intact. Presence filtering and presentation remain in their existing plugin.

### Arbitration

Only the shared host can consistently decide which content host owns a tile, which selected
carry supplies a projection, and which titlebar interaction belongs to a control rather than
movement. Making one renderer arbitrate the other renderers' geometry or attention would make
a party its own referee. One motion owner also prevents preview and committed-layout animation
from competing over the same transform.

## Bounded size and rejected alternatives

The first S16 run counted 13,147 production TypeScript lines against a 12,700 ceiling.
Integrating the already-landed isolation work raises the base to 12,742 lines and its existing
ceiling to 12,800. With the preview/chrome contract clarified, this change admits exactly
**13,233**, a **491-line** production-source increment over that integrated base. The main
contributors are stable-host tile motion, mounted projection, titlebar gesture exclusion and
shared departure projection. They are reachable from multiple renderer owners.

Raise RED to 13,233 and leave WARN at 9,000. Keep the same counted source set and exclude no
additional files. Correct the stale S16 registry prose, which still named the older 12,000
ceiling. This is a bounded, reviewable defense, not permission for unrelated floor growth.

Rejected alternatives are parallel implementations in renderer plugins, extracting a shared
arbiter into one of the parties it serves, moving files to evade counting, and trimming useful
explanations or deleting behavioral proof to manufacture headroom.

## Required evidence

- `verify:tile-drop`: real titlebar carries, source departure, cancellation and committed layout.
- `verify:convergence`: real browser geometry and ink converge with the canonical document.
- `verify:terminal-mirror` and `verify:terminal-selection`: independent host controls, stable
  terminal viewers, and pointer-correct selection at actual canvas zoom.
- `verify:axioms`: live titlebar presence, contribution disable behavior, narrow-layout
  resilience, registry ownership and the unchanged source-counting rule.
- Real screenshot inspection: readable shared chrome, square internal seams, rounded external
  frames, and no extra floating grips.
