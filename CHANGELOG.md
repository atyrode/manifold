# Changelog

## [Unreleased]

### Changed

- Replaced the terminal-only canvas with a React Flow collaborative canvas backed by Yjs, adding smooth live terminal moves and resizes, text editing, freehand drawing, selection presence, and undo. Terminals resize from their frame border like a desktop window, with no selection step. (#15, #57)
- Dragging follows the pointer without trailing: only the moved element re-renders per drag frame instead of the whole canvas. (#15, #57)
- Remote cursors and gestures now favor accuracy over smoothing: twice the update rate with just enough easing to round the edges. (#15, #57)
- A user's sibling tabs now render numbered cursor labels ("name (2)") so several tabs of one identity stay tellable apart. (#15, #57)
- Terminals are now first-class workspace citizens: the park button minimizes a terminal into a sidebar "Terminals" pool unbound from any pad, and pool rows drag back onto any canvas or pad. The X button now deliberately kills the terminal, and Backspace parks instead of deleting. (#15, #57)
- Terminals are presented like pads: renameable, durably ordered sidebar rows with the same menu, inline rename, keyboard, and drag grammar; terminal names show in titlebars and session rows. (#15, #57)
- Terminals and pads compose into views: drag one terminal over another and release on a snap zone to build a tiled split, expand a terminal to transmute it into a shared view in place (its canvas slot becomes a live widget with occupant avatars), drag tiles back out onto the canvas, and pin, rename, or split a view to keep it forever — unsplit ephemeral views pop back to a plain terminal when everyone leaves. Views tile terminals and live pad canvases side by side with draggable dividers, and portal elements embed any container on any canvas. (#15, #57)
- Sidebar sections (Machines, Pads, Terminals) are uniform, collapsible, and reorderable by dragging their headers; row drag handles are gone — the cursor is the cue. Freehand drawings are now selected by clicking the ink itself, not their bounding box. (#15, #57)
- Live cursors now render in composed views too: presence moved up to the renderer, so canvases and tiled views both show collaborators' pointers (view cursors track tiles across any window size). The sidebar stays personal — no cursors over it. (#15, #57)
- Every node carries one standardized titlebar — icon, name (double-click to rename in place), origin, then minimize / maximize / close — on terminals, view widgets, and the view renderer alike; view widgets on a canvas gained real minimize (back to the sidebar) and close, and views now live in their own sidebar "Views" section while Pads lists only canvases. (#15, #57)
- View widgets on a canvas are now fully interactive: click a tile to engage — your keystrokes reach the terminal and your avatar appears inside the view; click elsewhere to disengage back to watching. Watching alone never occupies a view. (#15, #57)
- The Machines "+" works inside composed views too: the new terminal is born straight into the view as a tile. (#15, #57)
- One vocabulary for arranging work: a "view" is any way to see your items — a freeform "pad" or a tiled "composition" — and the sidebar now indexes them all in one Views section (folders hold either kind, discipline glyphs tell them apart, old sidebar arrangements migrate automatically). (#59)
- Placement is now an algebra, not a feature list: every item kind declares what it composes with, one `POST /api/place` places anything anywhere legality allows, refusals come back as named rules ("views never nest"), and the whole vocabulary is discoverable through the protocol schema — for humans, agents, and future mods alike. (#59)
- Pad tiles inside a composition carry their own titlebar: jump into the pad, detach the tile, or delete the pad — full parity with every other item. (#59)
- Dragging is one grammar everywhere: a single typed payload carries any item, every target previews legality live during the drag (illegal drops show their named rule as prose, mid-hover), and the old per-pair drop handlers are gone — a composition row drops onto a canvas as a live widget, a terminal drops onto a sidebar composition row as a tile, and text blocks now tile into compositions alongside terminals. (#59)
- Errors and notices are one system: a bottom-center toast layer with auto-fading notices and sticky failures (with ✕), visible regardless of sidebar state; a burst of refusals can never bury a real failure, and previously-silent failures (pool kills, drop failures) now report. (#59)
- View widgets resize from their frame border exactly like terminals. (#59)
- One WebSocket per tab: session traffic is multiplexed over channels (protocol v12), so widgets, previews, and engagement never open extra connections and role changes are instant. (#59)
- Every terminal now lives in its own composition from birth: what sits on a canvas is a live window onto it, so "fullscreen" is just entering something that already exists — no temporary views, no pinning, nothing appears or vanishes when you look closer. Dragging one terminal onto another merges their compositions ("A + B"); pulling a tile out re-homes it; compositions merge, never nest. (#59)
- The Terminals section folded into the one sidebar index: an unparked terminal shows under the composition or canvas that holds it, and an unplaced one stands at the top level with its own icon — the sidebar lists what exists, wherever it lives. (#59)
- Grabbing anything by its titlebar now shows collaborators the carried item live — a ghost with its name tracks the pointer in canvases and compositions alike, and the source mutates in real time. (#59)
- Double-clicking a titlebar only renames when you double-click the name itself; anywhere else on the bar triggers the bar's action. The sidebar updates live when others create or delete things, and navigation mounts the right renderer instantly instead of showing loading text. (#59)

### Fixed

- The Machines sidebar section no longer disappears on view routes or the workspace root; without a canvas to author into it lists machines read-only. (#15, #57)
- Collapsing the Pads sidebar section now releases its height instead of leaving a blank gap. (#15, #57)
- Closing a tab no longer strands a dead ghost cursor on the canvas when the same user keeps another tab open. (#15, #57)
- The workspace status now shows real autosave times instead of permanently reading "Not saved". (#15, #57)
- An unengaged view widget now dims its terminals like any resting terminal; engaging undims only the tile you clicked. (#59)
- Engaging and disengaging a view widget no longer refreshes its terminals: the tiles keep their DOM identity across the socket swap and replay in a single frame. (#59)

## [0.4.4] - 2026-08-27

### Added

- Releases now attach a compiled `manifold-agent-linux-x64` binary for fleet consumers; the nix flake's bun-deps derivation proved non-reproducible across machines and stays development-only (#51, #52).

## [0.4.3] - 2026-08-27

### Changed

- Duplicate machine rows are now retired by rename instead of deleted during the uniqueness migration, preserving machine and session history (#48, #49).

## [0.4.2] - 2026-08-27

### Fixed

- Machine names are now unique in storage; duplicate enrollments left by the old always-mint path are deduplicated to the most recently seen machine, and their stale tokens revoked (#46, #47).

## [0.4.1] - 2026-08-27

### Fixed

- Fixed release verification failing to start the browser on GitHub's updated CI image (#44, #45).

## [0.4.0] - 2026-08-27

### Added

- Added Nix flake packages that build `manifold-agent` and `manifold-server` as standalone binaries for fleet machines (#40, #43).
- Added `MANIFOLD_MACHINE_TOKEN_FILE` so an agent can read its machine token from a private file instead of the environment (#40, #43).

### Changed

- Re-enrolling an existing machine name now returns the enrolled machine unchanged; pass `rotateToken` to explicitly replace a lost token (#40, #43).
- Cut per-frame validation cost on the terminal and canvas hot paths: the server serializes each terminal frame once per broadcast, and the SDK and canvas skip re-validating payloads they constructed or already deduplicated (#38, #39).
- Stopped re-sending full terminal snapshots on same-connection scene resyncs (#38, #39).

### Fixed

- Terminals that exit while their machine is disconnected now report their real exit code after reconnect instead of a signal death (protocol v4) (#38, #39).
- The agent now bounds its memory under a slow server connection, shuts down within a grace period even when a child traps signals, and no longer leaks terminal mirrors on failed spawns (#38, #39).
- Reconnecting to a restarted server no longer restores stale presence, and secrets are verified absent from process logs (#38, #39).

## [0.3.1] - 2026-08-26

### Fixed

- Restored the trail behind the eraser during right-button drags (#34, #35).

## [0.3.0] - 2026-08-26

### Changed

- Standardized issue and pull-request references across the repository and in-app changelogs (#31, #33).

### Fixed

- Restored the eraser cursor while erasing with a right-button drag (#30, #32).

## [0.2.2] - 2026-08-26

### Changed

- Removed the drag-and-drop instruction text above the pad list.

## [0.2.1] - 2026-08-26

### Fixed

- Fixed canvas right-clicks opening the browser context menu on top of Excalidraw’s menu.

## [0.2.0] - 2026-08-26

### Added

- Added recursive folders that organize pads and folders together in one ordered sidebar tree.
- Added inline pad and folder creation, renaming, and delete confirmation without modal dialogs.
- Added pointer and keyboard reordering for pads and folders, including moving either into nested folders.

### Changed

- Unified pads, machines, terminal sessions, presence, connection state, and release information in the persistent workspace sidebar.
- Made the full tree row draggable and applied pad and folder moves optimistically before the server response arrives.
- Made right-button dragging activate the canvas eraser on the first pointer movement while preserving the context menu for a stationary click.

### Fixed

- Fixed prolonged folder hover during a native drag unmounting the React root and blanking the canvas.
- Fixed sidebar drag targeting failing because the virtual root returned nullable item data to Headless Tree.
- Fixed container builds showing an unknown web build identifier instead of the deployed revision.

## [0.1.0] - 2026-08-26

### Added

- Added multiplayer Excalidraw canvases with presence, viewport memory, and embedded terminals.
- Added persistent pads, machine-backed terminal sessions, and reconnect-safe scene storage.
- Added an authenticated self-hosted web application with public-origin verification.
