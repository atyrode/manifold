import type { TileLayout } from "@manifold/protocol";

/**
 * The two panels a default workspace is built from, as DATA the caller supplies.
 *
 * `sidebar` and `main` are the two roles the arrangement below has, not two plugins: a
 * fully-qualified panel id goes in each, and the floor never learns which plugin wrote it.
 */
export interface WorkspacePanels {
  readonly sidebar: string;
  readonly main: string;
}

/**
 * The workspace a principal gets before it has ever arranged one: sidebar left, main view
 * right, at the width the hand-written shell used to hard-code.
 *
 * It returns a plain `TileLayout` whose leaves are PANEL refs, which is the whole point — the
 * shell is not a bespoke frame with a resizable sidebar inside it, it is one tile tree
 * rendered by the same component every composition uses, and the sidebar is a panel like any
 * other. Dragging the divider therefore edits ratios, and a plugin can be given half the
 * workspace without the shell learning a new arrangement.
 *
 * THE FLOOR OWNS THE ARRANGEMENT; THE REGISTRATION FILES OWN THE NAMES. Two leaves in a row
 * at `[0.22, 0.78]`, under the tile ids `root`, `ws-sidebar` and `ws-main`, is engine grammar:
 * it is unchanged if every plugin in the tree is replaced by different plugins, which is the
 * neutrality criterion (AXIOMS.md §Foundation law). WHICH panels fill the two leaves is plugin
 * data, and plugin data reaches the floor only as an argument — the two `assembly.ts` files
 * are the sole places allowed to name a plugin (REGISTRY.md §Foundation, gate S2), so they pass the ids in
 * and this function stays a function of them.
 *
 * A layout referencing a panel no live plugin provides is legal and renders a placeholder
 * (protocol layout.ts:33-41), so a default built from ids the assembly happens not to hold is
 * still a writable tree rather than a boot failure — that is what keeps this function honest
 * with plugins missing. `verify:axioms` (S1) nonetheless asserts the ids the real assemblies
 * pass do resolve, because the DEFAULT must never be the broken case.
 */
export function workspaceLayout(panels: WorkspacePanels): TileLayout {
  return {
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
      ref: { kind: "panel", panelId: panels.sidebar },
    },
    "ws-main": {
      id: "ws-main",
      dir: null,
      ratios: [],
      children: [],
      ref: { kind: "panel", panelId: panels.main },
    },
  };
}
