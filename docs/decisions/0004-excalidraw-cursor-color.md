# 0004 — Excalidraw patch: collaborator cursors honor principal color

Date: 2026-08-25
Status: accepted

## Context

manifold principals carry a stable presence color (protocol `PrincipalSchema`,
assigned at creation, user-chosen at identity setup). Excalidraw 0.18.1 ignores
the collaborator color supplied to it when painting remote cursors: it hashes
the connection-scoped socket id into a pastel HSL. Every refresh mints a new
connId, so a user's cursor changed color for everyone else on each reload while
their chosen identity color stayed intact — the inconsistency was entirely in
the renderer.

## Decision

Extend the pinned `@excalidraw/excalidraw` patch (policy per decision 0002:
patch over fork, re-derived guards, loud failure on version drift): cursor
painting honors `collaborator.color.background` when supplied, keeping the
connId hash only as a fallback for collaborators without a color. Guarded by a
real-browser assertion in `bun run verify:convergence`: choose a color, refresh,
prove serialized identity unchanged AND the receiving canvas renders the chosen
RGB on the remote cursor.

## Revisit when

Any Excalidraw version bump (patch must be regenerated), or upstream accepting
collaborator color as authoritative.
