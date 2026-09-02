# 0007 — Use React Flow for the terminal canvas

Date: 2026-08-28
Status: accepted

## Context

manifold's canvas is now terminal-only. The previous general-purpose drawing renderer imposed
an incompatible element model, fork maintenance, and UI behavior that the product no longer
needs. The replacement must provide an infinite viewport, node drag and resize, deterministic
stacking, and React integration without owning manifold's protocol or terminal state.

## Decision

Use exact-pinned `@xyflow/react` 12.11.5 as the web canvas renderer. manifold owns strict
native terminal records in `@manifold/protocol`; `core.canvas`'s `flow-scene.ts` is the pure
projection and mutation boundary. React Flow owns viewport and node interaction only. xterm
instances and all server/socket state remain manifold-owned.

This is a hard cutover: protocol v5 rejects legacy drawing records, there is no migration or
compatibility reader, and the old renderer dependency and fork-specific integration code are
removed.

## Alternatives rejected

- **Maintain the previous renderer fork:** retains drawing-system complexity and permanent
  fork drift for a terminal-only product.
- **Build pan/zoom/drag/resize from scratch:** duplicates mature interaction machinery and
  expands the browser correctness surface without product benefit.
- **DOM absolute positioning alone:** does not provide a complete infinite-canvas interaction
  model or viewport tooling.

## Revisit when

React Flow prevents a required terminal interaction, becomes materially heavier than the
owned functionality it replaces, or cannot preserve the five-view convergence contract.
