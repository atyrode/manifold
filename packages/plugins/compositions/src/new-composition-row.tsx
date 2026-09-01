import { useWorkspaceShell } from "@manifold/plugin/hooks";
import { ItemIcon } from "@manifold/plugin/ui";
import type { ReactElement } from "react";

/**
 * `core.compositions.new-composition` — the rail's "New composition" creator, as a PLAIN
 * contributed row.
 *
 * The exact counterpart of `core.canvas`'s creator, and deliberately a SEPARATE row in a
 * separate package rather than one parameterised creator: a canvas and a composition are told
 * apart by their discipline, and each discipline's plugin owns the offer to make one. That is
 * what lets the rail's creators follow the roster — disable this plugin and this row VANISHES
 * while the canvas creator stays, which is the reading D4′ asks chrome to give.
 *
 * The two rows LOOK alike and that is not duplication worth removing across a plugin
 * boundary: a shared creator would be a fourth party both disciplines import, and the moment
 * a third discipline wanted a different glyph, a different label or a confirmation step it
 * would grow a switch on the discipline — the shell naming favourites again, one level down.
 *
 * Creation commits through `core.index.createContainer` (named in the DOM as `data-action`,
 * AGENTS.md invariant 12), dispatched through the workspace shell's door so the new
 * composition is remembered, the index refreshed and the viewer landed inside it.
 */
export function NewCompositionRow(): ReactElement {
  const { createContainer, creating, setSidebarOpen, sidebarOpen } = useWorkspaceShell();
  return (
    <button
      className="sidebar-new"
      type="button"
      data-action="core.index.createContainer"
      title="New composition"
      aria-label="New composition"
      onClick={() => {
        if (!sidebarOpen) setSidebarOpen(true);
        createContainer("composition");
      }}
      disabled={creating}
    >
      <ItemIcon kind="composition" />
      {sidebarOpen ? <span>New composition</span> : null}
    </button>
  );
}
