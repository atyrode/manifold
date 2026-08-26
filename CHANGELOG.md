# Changelog

## [Unreleased]

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
