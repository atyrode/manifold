import type { TileLayout } from "@manifold/protocol";

/**
 * The workspace a principal gets before it has ever arranged one: sidebar left, container view
 * right, at the width the hand-written shell used to hard-code.
 *
 * It is a plain `TileLayout` whose leaves are PANEL refs, which is the whole point — the
 * shell is not a bespoke frame with a resizable sidebar inside it, it is one tile tree
 * rendered by the same component every composition uses, and the sidebar is a plugin
 * panel like any other. Dragging the divider therefore edits ratios, and a plugin can be
 * given half the workspace without the shell learning a new arrangement.
 *
 * The two panel ids name `core.shell`'s contributions. A layout referencing a panel that no
 * live plugin provides is legal and renders a placeholder (protocol layout.ts:33-41), so
 * this default stays writable even with plugins missing — but `verify:axioms` (S1) asserts
 * both of these resolve, because the DEFAULT must never be the broken case.
 */
export const DEFAULT_WORKSPACE_LAYOUT: TileLayout = {
  root: {
    id: "root",
    dir: "row",
    ratios: [0.22, 0.78],
    children: ["ws-sidebar", "ws-main"],
    ref: null,
  },
  "ws-sidebar": {
    id: "ws-sidebar",
    dir: null,
    ratios: [],
    children: [],
    ref: { kind: "panel", panelId: "core.shell.sidebar" },
  },
  "ws-main": {
    id: "ws-main",
    dir: null,
    ratios: [],
    children: [],
    ref: { kind: "panel", panelId: "core.shell.container-view" },
  },
};
