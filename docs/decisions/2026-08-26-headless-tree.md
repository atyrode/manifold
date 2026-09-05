# Use Headless Tree for recursive sidebar organization

Date: 2026-08-26
Status: accepted
Ratified: supersedes `2026-08-26-dnd-kit-react.md`

**Lexicon addendum 2026-08-31 (#69):** this record is history and is not rewritten; the names it
cites moved in the lexicon cut. The sidebar tree it decides is the workspace **index**, its rows
are `IndexEntry` (was `PadTreeItem`) and `IndexBranch`, and a "pad" here is a **container** whose
discipline is `canvas`. Canon is `REGISTRY.md` §Lexicon.

## Context

The sidebar is an ordered recursive tree: pads and folders are siblings, folders may contain pads or folders, and users may reorder any item or move it into an existing folder. Dropping a pad on another pad must never create a folder. The first implementation used `@dnd-kit/react` sortable primitives over a synthetic two-state pad/folder projection. That made nested DOM ownership and persistence our responsibility and produced visual duplication after folder deletion.

## Evidence

We evaluated current live projects and documentation rather than designing another drag engine:

- Headless Tree is active (GitHub updated 2026-08-23), MIT licensed, declares React 19 in its peer range, and explicitly provides recursive trees, ordered drag-and-drop, expansion, hotkeys, and keyboard drag-and-drop: https://github.com/lukasbach/headless-tree
- Its official DnD guide defines the exact two targets needed here: an ordered target with `item` + `insertionIndex`, and an item target for reparenting into a folder. It also supplies `canDrop`, drag-line positioning, cycle protection, and keyboard DnD: https://headless-tree.lukasbach.com/dnd/overview/
- Its official React story demonstrates arbitrary nested children through `dataLoader.getChildren`, ordered DnD, keyboard DnD, and a separate drag handle: https://github.com/lukasbach/headless-tree/blob/main/packages/sb-react/src/dnd/seperate-drag-handle.stories.tsx
- `dnd-kit-sortable-tree` was rejected because its latest npm release is from 2023 and it depends on the legacy `@dnd-kit/core`/`sortable` API rather than this repository's newer `@dnd-kit/react` package: https://www.npmjs.com/package/dnd-kit-sortable-tree
- React Complex Tree is superseded by Headless Tree according to the maintainer. React Aria Tree now has DnD, but adopting React Aria's collection model and interaction surface would be a larger UI-system change than a headless tree adapter: https://github.com/lukasbach/headless-tree and https://react-spectrum.adobe.com/releases/2025-06-05.html

## Model mapping

The server remains the authority and returns a flat discriminated collection:

```text
PadTreeItem = pad|folder + parentId + sibling sortOrder
```

A pure adapter validates cycles/orphans and exposes the library's synchronous loader:

```text
root -> ordered IDs where parentId = null
folder:<id> -> ordered IDs where parentId = <id>
pad:<id> -> []
```

The core tree consumes that loader through a small React lifecycle adapter with:

- `syncDataLoaderFeature` for the authoritative in-memory response;
- `dragAndDropFeature` with `canReorder: true`;
- `keyboardDragAndDropFeature` and `hotkeysCoreFeature` for accessible movement;
- `seperateDragHandle: true` so row activation and dragging are distinct;
- initial expansion state persisted locally after settled expansion changes.

Headless Tree 1.7.0's bundled `useTree` stores the core's mutable state object in React
state. Its native DnD state contains `ItemInstance` references; in the React 19 application,
rendering while that state is active reproducibly clears the React root. Manifold therefore
uses `createTree` through a 25-line mount/config adapter and paints the library-computed drag
target and drag line directly during the native drag. No targeting, ordering, collision, or
keyboard movement policy is reimplemented.

The `onDrop` adapter sends one `MovePadTreeItem` command using the library's `insertionIndex`. Unordered item drops are accepted only when `target.item` is an existing folder. Ordered drops remain available between any sibling items. Therefore pad-on-pad never creates a folder, while pads and folders can be moved into existing folders at arbitrary depth.

## Decision

Pin `@headless-tree/core` and `@headless-tree/react` at `1.7.0`. Remove `@dnd-kit/react` and the handwritten collision/hover/grouping policy. Manifold owns its domain persistence, the protocol-to-loader adapter, and the React 19 lifecycle/presentation bridge described above; Headless Tree owns tree flattening, expansion semantics, drag targeting, cycle-safe interaction, hotkeys, keyboard DnD, ARIA props, and assistive descriptions.
