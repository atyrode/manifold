# Use `@dnd-kit/react` for pad ordering

**Date:** 2026-08-26  
**Status:** Accepted

**Lexicon addendum 2026-08-31 (#69):** this record is history and is not rewritten, title
included; superseded by `2026-08-26-headless-tree.md`. What it calls "pad ordering" is ordering
the workspace **index** of **containers** and folders. Canon is `REGISTRY.md` §Lexicon.

## Context

Pad navigation needs pointer and keyboard-accessible reordering. Hand-rolled HTML drag events do not provide a coherent keyboard interaction, collision handling, or screen-reader announcements, and would leave manifold owning a subtle input state machine.

The current official dnd-kit React adapter consolidates draggable, droppable, and sortable behavior in `@dnd-kit/react`. Version 0.5.0 explicitly supports React 18 and 19 and exports `useSortable` from `@dnd-kit/react/sortable`. The older `@dnd-kit/core` plus `@dnd-kit/sortable` package pair is the legacy API and would add two direct dependencies for the same behavior.

## Decision

Pin `@dnd-kit/react` to `0.5.0` in `@manifold/web` and use its sortable primitive for pad rows. Persist only the resulting ordered pad IDs through manifold's HTTP API; no dnd-kit types or state cross the UI boundary.

## Why this beats boring local code

A local pointer-only implementation would be smaller but inaccessible. A complete local implementation would need sensors, cancellation, focus retention, collision calculation, drag previews, announcements, and touch behavior. That is not boring code; it is a reusable interaction system with many failure modes. The pinned library is narrowly scoped, has no effect outside the pad list, and can be removed without changing the persistence contract.

## Consequences

- The web bundle gains dnd-kit's React adapter and its small internal packages.
- Pad order remains server-owned and independent of the library.
- Upgrades are deliberate; the dependency stays exactly pinned until re-evaluated.
