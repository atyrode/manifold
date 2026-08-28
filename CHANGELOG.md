# Changelog

## [Unreleased]

### Changed

- Replaced the dev branch's normal pad renderer with React Flow, removed the Excalidraw runtime dependency, and kept existing terminal scene records compatible while the new drawing surface is prototyped (#15, #57).

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
