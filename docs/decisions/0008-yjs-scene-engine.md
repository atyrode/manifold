# 0008 — Use Yjs for durable scene state

Date: 2026-08-28
Status: accepted

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
