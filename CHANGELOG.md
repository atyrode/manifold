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
- One icon language across the app, drawn from Lucide: items (terminal, canvas, composition, note, machine, folder), titlebar controls, sidebar chrome, carry ghosts, and remote cursors all share it — the unicode glyphs, hand-drawn SVGs, and CSS shapes are gone. (#59)
- Destruction is direct: no more two-step confirmations on delete or kill anywhere, killing a terminal removes it everywhere instantly (no lingering "exited" husk — a naturally-exited shell still shows its real code), and creating a canvas or composition is one click with an "Untitled" name you rename in place. (#59)
- A composition widget on a canvas is now literally the composition renderer at a smaller scale: engage it and its tile dividers drag exactly like fullscreen; watching leaves them visibly inert. Composition and canvas icons refined (LayoutDashboard / dashed surface). (#59)
- The center drop zone now means "this exact spot": over an empty tile it fills as before, over an occupied one it swaps the two placements — shown with an orange highlight and a swap glyph instead of yesterday's guaranteed-failure full highlight. Tiles gained edge-drop rearranging inside and across compositions (an edge moves the tile, center trades places), and drags that carry nothing to trade simply snap to the nearest edge. (#59)
- Dropping onto a composition now aims at the exact tile under the pointer, at any depth: every tile offers its four edges and its center, and the area's outer band splits the whole composition at the top level. The preview is the real thing — the panes glide and squeeze into their prospective places while you hover, so the highlight IS the outcome you get on release. (#59)
- The exact spot of an occupied tile now also accepts items with nothing to trade: the carried item takes the tile and the displaced occupant moves out into its own composition at the top level of the index — previewed in violet with a "moves out" caption. A note cannot be displaced and says so in prose before you release. (#59)
- Splits can now grow FLAT: dropping on a tile's edge along its row's own direction joins that row as a new sibling instead of nesting a two-way split, and dividers are drop targets — release on a seam to wedge the item in exactly there. A seam's outer ends split the whole group the seam belongs to (how a nested `C | D` pair grows a pane across its full width), in both orientations. (#60)
- A terminal dragged FROM a canvas onto the exact spot of an occupied tile now TRADES instead of parking anyone: the displaced occupant moves into the carried terminal's home, and the canvas widget — same element, same geometry — simply starts showing it. Sidebar rows still displace, because they hold no seat to give back. (#62)
- Inserting between two panes now reads as BETWEEN: an interior same-axis drop takes a third from each neighbor, so the newcomer arrives an equal citizen (equal neighbors yield exact thirds) and the live preview shows both panes ceding — dropping on a pane's flank no longer looks like nesting into one side. End-of-row drops still split the edge pane's own space. (#60)
- Aims no longer flutter at zone boundaries: a held zone keeps the aim until the pointer travels a real margin past it, so centers stay easy to hold while the preview glides panes around. (#59)
- F9 toggles a debug view of the drop zones: a live-sampled painting of exactly what the drop resolver answers across a composition — ring, seams, seam ends, bands and centers — updating in real time with the layout. (#59)
- While a drop target is armed, the node you are holding eases into a ghost — and back — so the live preview underneath stays readable. (#59)
- Dividers are far easier to grab: a seam's pointer target is now wider than its slim paint at any zoom, and a watching widget's inert dividers explain how to make them live (click a tile to engage). (#59)
- The seam between two panes is now a real drop BAND — as wide as the area's outer ring at any zoom, not a hairline — and it is the only place that means "wedge in between": both neighbors cede a third. Deeper into a pane's flank the drop splits THAT pane alone (it cedes half, its neighbor untouched), so the grouped `(A|C)|B` shapes are reachable again alongside flat thirds, told apart purely by where you hover. The F9 debug view paints the seam band its own color. (#60)

### Fixed

- The Machines sidebar section no longer disappears on view routes or the workspace root; without a canvas to author into it lists machines read-only. (#15, #57)
- Collapsing the Pads sidebar section now releases its height instead of leaving a blank gap. (#15, #57)
- Closing a tab no longer strands a dead ghost cursor on the canvas when the same user keeps another tab open. (#15, #57)
- The workspace status now shows real autosave times instead of permanently reading "Not saved". (#15, #57)
- An unengaged view widget now dims its terminals like any resting terminal; engaging undims only the tile you clicked. (#59)
- Deleting a tile from a three-or-more-way split no longer leaves a dead black band: split ratios are relative, and the renderer now normalizes them, so the surviving panes always fill the area and the drop highlights line up with what is painted. (#60)
- Closing a canvas tile inside a composition no longer toasts "Could not delete this canvas" after a delete that succeeded: the server's delete already prunes the leaf, and the client stopped chasing it. (#59)
- Engaging and disengaging a view widget no longer refreshes its terminals: the tiles keep their DOM identity across the socket swap and replay in a single frame. (#59)
- Drop zones on a composition widget no longer count the title strip as part of the tiles, so edge and center drops land where the highlight says they will. (#59)
- A terminal tile's minimize button now really releases the terminal to the top level of the index; it used to be refused every time. (#59)
- Committing a split no longer rebuilds the terminals it rearranges: every pane keeps its screen, scrollback and selection across structural edits. (#59)

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
