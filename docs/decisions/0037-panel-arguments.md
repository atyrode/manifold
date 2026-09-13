# A panel leaf carries an opaque argument, and a panel opens its own panels beside itself

Date: 2026-09-13
Status: proposed

## Context

A panel is a leaf of a tile tree addressed by `{ kind: "panel", panelId }`, and `PanelProps` carried `host` and nothing else. So a panel had no way to be opened FOR something. Issue #516 found this building Babel's reading surface: the record panel draws whatever Home selected, because "what am I showing" has to live in a module the plugin's panels share. Three consequences, and each is a product fact rather than an inconvenience — a record cannot be linked to; two record tiles cannot show two records; and a plugin cannot offer "open this beside what I am reading", because the only spatial verbs a plugin had were the placement door (no panel form) and the workspace tree write (`core.space.setLayout`, which arrange mode owns).

`host.requestedRef` is the deep-link mechanism's inbound half: ONE consumed reference per route, published for whichever composed surface recognises it. It answers "the shell was asked to open this"; it cannot answer "this tile is showing that" for two tiles at once, and it is consumed, so it is not state a leaf can be painted from.

## Decision

A panel leaf MAY carry `arg`: an opaque `Record<string, unknown>` (`PanelArg`), stored on the TILE beside the panel id, bounded at `MAX_PANEL_ARG_BYTES` (4 KiB of JSON) and required to be JSON data all the way down. `validateTileLayout` refuses it on anything but a panel leaf and refuses a value the round trip would rewrite — an `undefined` member, `NaN`, a `Date`, a cycle — because a tree is persisted as JSON and read back as JSON, and an argument the panel never wrote is worse than a refusal. Absent ≡ no argument, so every stored tree and every manifest written before the field serializes and parses exactly as it did; nothing migrates.

A panel receives it as `PanelProps.arg`, following the LEAF: a second tile of one panel has its own, and a changed leaf is a changed prop rather than a remount. `host.openPanel({ panelId, arg?, beside?: "self" })` places one more seat for a panel of the CALLER'S OWN plugin, after the caller's seat along the axis its parent already splits on. It commits through `TileGeometryHandle.applyLayout` — the floor's own debounced `core.space.setLayout` — so an opening's authority and trace are a grip release's, and a plugin gains no door. When a seat already shows an argument naming the same thing, that seat is the answer and nothing is written; a DIFFERENT argument is a second tile, which is the point. Refusals are a closed set (`unknown_panel`, `other_plugin`, `invalid_arg`, `no_tile`), read back mechanically the way a placement denial is.

`arg` travels with the panel, not with the seat: a reader who opened a record and then rearranged keeps the record (`releasedTileLayout`, `tradedSeats`), exactly as a section arrangement already travels. The composition document writer keeps dropping both fields, because a per-principal fact written into shared room state would be everyone's.

## Refused alternatives

**A router inside a panel.** One panel per plugin, holding its own address state and drawing whichever subject was last selected. This is what Babel does today under duress, and it is the shape the tile tree exists to refuse: a second navigation plane inside a leaf, private to each plugin, with no address a reader can link to and no way for two tiles to show two subjects. It also makes the workspace's own arrangement a lie — the reader arranged two record tiles and got one record twice.

**Reusing `host.requestedRef`.** Publish the subject on the route and let the panel read it. Refused because it answers a different question: it is ONE reference for the whole route, consumed once as it is published, so two tiles cannot hold two subjects, a reopened tile cannot repaint from it after a reload, and a panel reading it would be reading a request meant for whichever surface recognises the form. Widening it into a per-tile store would be a second per-principal arrangement plane beside the tile tree.

**A `panel` form on `PlacementRef`.** The placement door deliberately has none: a workspace layout is written whole by `core.space.setLayout`, and the placement algebra's panel rules exist as the answer for a panel item rather than as a door. Adding a wire ref would put a second writer on the one per-principal tree and widen the placement executor for a case that never crosses a container. `openPanel` therefore computes the tree and commits it through the existing door instead.

**An argument on the `panel` REF rather than the leaf.** A ref is an item's ADDRESS, shared with `PlacementRef` and `ManifoldRef` (D7), and `sameTileRef`/`refKey` are identity over it. Two tiles of one panel showing two records are two SEATS of the same addressed panel; making the argument part of the address would fork panel identity, change what a carry and a FLIP animation consider "the same thing", and make every existing ref reader ask a question it has no business asking.

## Consequences

A panel's stored section arrangement stays keyed by panel id (`panelSections`, first leaf in key order), so two seats of one panel share one rail arrangement. That is unchanged behaviour — a layout could already hold a panel twice — and it is the honest scope of this record: an argument names a subject, not a second arrangement.

A HARDENED (isolated) plugin's panel does not receive `arg` and cannot call `openPanel`: both would have to cross the worker boundary (`WEB_HOST_METHODS`, the `mount` frame), which ADR 0016 §3's stage-1 surface does not carry. In-realm panels — the channel Babel's reading surface uses — have both. Extending the isolate bridge is a separate wave and a separate protocol change.

## Evidence

`packages/protocol/test/layout.test.ts` pins the wire: a panel leaf with and without an argument, the refusal on every other leaf kind and on a split, the byte bound measured in UTF-8 rather than code units, and the round-trip rule (dropped members, `NaN`, `Date`, `Set`, functions, symbols, cycles refused; a shared subobject still legal). `packages/plugin/test/layout.test.ts` pins the tree an opening means: flat after the caller in a row, downward in a column, a row out of a lone root leaf, dedup on an equal argument regardless of key order, a second tile for a different one, a third state for none, and the argument surviving a rearrangement. `packages/web/src/plugin-host.test.ts` renders the real outlet: the leaf's argument reaches the registered component, an opening lands beside the caller and commits exactly one tree through `applyLayout`, a repeat writes nothing, and each refusal is named. `packages/server/test/plugin-host.test.ts` proves the door stores an argument and refuses an unbounded one.
