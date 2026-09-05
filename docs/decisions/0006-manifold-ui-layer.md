# 0006 — manifold owns the canvas chrome (UI layer on Excalidraw slots)

Date: 2026-08-25
Status: superseded
Superseded-by: 0007-react-flow-renderer.md
Ratified: superseded by the React Flow and native scene-record cutover (#15)

## Context

manifold rendered presence twice: Excalidraw's built-in `UserList` avatar stack
(mounted whenever `appState.collaborators` is non-empty under `isCollaborating`)
AND manifold's own `Roster` overlay absolutely positioned on top of it. The
`StatusBar` (open/rev/saved) was a hand-styled translucent pill matching neither.
The stock `UserList` is per-socket: manifold's collaborator map keys are synthetic
`principalId:connId` strings with no `Collaborator.id` set, so avatars duplicate
per connection, and the component has no way to express manifold's principal-level
semantics — human/agent kind, presence status, ×N connection counts.

## Decision

manifold owns canvas chrome — presence, sync status, and next the shapes toolbar —
as app-side components mounted through Excalidraw's official composition slots
(`renderTopRightUI` now; `MainMenu`/`Footer` as needed) and styled exclusively with
Excalidraw's design tokens (`--island-bg-color`, `--shadow-island`,
`--border-radius-lg`, `--text-primary-color`, `--color-primary`,
`--default-border-color`), which cascade because the slots render inside the
`.excalidraw` scope. Presence renders as one avatar stack (`PresenceIsland`) with a
click-to-toggle roster popover carrying kind/status/×N; the status readout
(`StatusIsland`) joins it in the same top-right cluster. Derivation logic lives in
the pure, unit-tested `roster-model.ts`.

The fork's contract (0005) extends to **additive `UIOptions` chrome-suppression
flags, default = stock**: `UIOptions.userList: false` and `UIOptions.toolbar: false`
shipped in `0.18.1-manifold.2`. manifold sets `userList: false` today; `toolbar`
is prep for the toolbar pass: `toolbar: false` plus a manifold-owned toolbar
component driving `api.setActiveTool` with an app-side tool subset, auto-hidden via
CSS `translateY(-100%)` with an always-visible hover notch, active tool read from
`appState.activeTool` in `onChange`.

## Alternatives rejected

- **Stock `UserList` only** (feeding `Collaborator.id = principalId` to fix dedup):
  still per-socket granularity in interaction affordances and cannot express
  principal kind, presence status, or connection counts.
- **In-fork `UserList` rewrite**: restructures upstream code, against the fork
  contract (0005); permanent drift cost on every upstream rebase.
- **Keep the sibling overlay** (status quo): two presence surfaces, doubled truth,
  and manifold UI outside the `.excalidraw` scope where design tokens do not cascade.

## Revisit when

Upstream ships the `ui`/`interaction` config (present on master, unreleased) — the
suppression flags should migrate to it. Click-to-follow (peer viewport lives in
`client.roster.payload.viewport`) is a natural later addition to the presence popover.
