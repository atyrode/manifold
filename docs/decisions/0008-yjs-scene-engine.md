# 0008 — Use Yjs for durable scene state

Date: 2026-08-28
Status: accepted
Ratified: 2026-09-15 — operator decision in issue #254; addendum below

## Context

manifold needs durable collaborative scene state whose concurrent field and text edits converge without whole-record last-writer-wins conflicts. The scene engine must run in browsers and Bun, preserve the existing authenticated session WebSocket, and avoid weakening manifold's server-stamped principal identity for ephemeral collaboration state.

## Decision

Use exact-pinned `yjs` 13.6.32 as the durable scene engine shared by the browser, SDK, and server. Yjs is MIT-licensed, pure JavaScript, requires no WASM or asynchronous runtime initialization, and has one direct runtime dependency, `lib0`, which depends on `isomorphic.js`.

Durable elements live in a Yjs document and travel as document updates over manifold's existing authenticated session WebSocket. Ephemeral gestures, cursors, selections, and viewports remain on manifold's server-stamped presence transport; they are neither written to the document nor persisted.

Do not use `y-protocols` awareness. Its client-asserted `clientID` cannot be bound to an authenticated manifold principal, while the existing presence channel stamps identity at the server boundary.

## Alternatives rejected

- **`loro-crdt` 1.15.0:** requires an approximately 3.2 MB runtime WASM artifact, a Vite WASM loader, and asynchronous initialization.
- **`@automerge/automerge` 3.4.1:** requires an approximately 3.6 MB runtime WASM artifact, a Vite WASM loader, and asynchronous initialization.
- **`y-protocols` awareness:** duplicates manifold's presence transport and permits identity to originate from client-asserted state rather than the authenticated server boundary.

## Revisit when

Yjs cannot preserve the browser/SDK/server convergence contract, its document growth is unacceptable under measured manifold workloads, or a materially simpler pure-JavaScript engine provides equivalent field-level and collaborative-text semantics.

## Ratification addendum — 2026-09-15

The operator ratified retaining Yjs and the `scene` noun after re-checking this decision against
the plane rule. The evidence is the shipped, bounded document plane rather than a fresh library
benchmark: one Yjs document per room merges independently authored element fields, nested
collaborative `Y.Text`, and composition tile layouts; updates are capped at 512 KiB and full
documents at 12 MiB. These are durable per-element edits whose worst-case merge a person can
accept, while cursors, live drags, selections, and viewports remain ephemeral channel traffic.

The approximately 3.2 MB Loro 1.15.0 and 3.6 MB Automerge 3.4.1 WASM figures above remain
historical measurements from the original decision, not current-version benchmark claims. They
do not need refreshing unless a revisit condition is met. Yjs 13.6.32 still satisfies the actual
browser/Bun, field-merge, collaborative-text, synchronous-startup, and maintenance requirements
without adding a WASM toolchain or a second presence model.

The original follow-up's request for fresh current-version size, update-cost, subdocument,
maintenance, and dev-hub measurements was superseded by this ratification choice; no such
benchmark was run or is claimed here. The shipped requirement is nested collaborative text, not
subdocuments. A future proposal that meets a revisit condition owns its own reproducible
comparison against then-current versions and workloads.

`scene` remains the canonical lexicon noun for a room document: its element map includes
collaborative text and its layout map includes composition structure, so the word does not mean
“canvas.” React Flow is likewise not the document engine; under ADR 0007 it is a plugin-local web
renderer owned by `core.canvas`. The ratified boundary is therefore unchanged: Yjs through
`@manifold/scene` is floor document machinery, while React Flow stays optional plugin machinery.
