# 0003 — Patch @xterm/xterm pointer scaling instead of forking or wrapping

Date: 2026-08-25
Status: accepted

## Context

xterm converts mouse events to cell coordinates by measuring the screen with
`getBoundingClientRect()` (post-transform visual pixels) and dividing by its
layout-space cell dimensions. manifold renders terminals inside Excalidraw
embeddables, which apply canvas zoom via an ancestor CSS transform — so at
non-100% zoom every selection lands `zoom × row` away from the pointer, an
error that grows with distance. No public xterm option injects a coordinate
transform, and wrapping events outside the library cannot fix its internal
hit-testing.

## Decision

`bun patch @xterm/xterm` (tracked at `patches/@xterm%2Fxterm@6.0.0.patch`,
wired via `patchedDependencies`): normalize pointer offsets by the
rendered-to-layout X/Y scale before cell conversion, in both ESM and CJS
bundles. Same policy as decision 0002 (patch over fork: re-derived guards,
byte-identical fallback, `bun install` fails loudly on version-bump drift).
Guarded by `bun run verify:terminal-selection` — a real-browser drag test
asserting selection paints the dragged row at 100% and 120% zoom.

## Limits / revisit

Independent X/Y scale handles axis-aligned zoom only; rotated or skewed
terminal ancestors would need full inverse-matrix mapping (not a manifold
use case today). Revisit on any xterm version bump or if upstream grows a
coordinate-transform hook.
