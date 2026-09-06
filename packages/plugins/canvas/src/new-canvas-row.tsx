import { useWorkspaceShell } from "@manifold/plugin/hooks";
import { ControlIcon } from "@manifold/ui";
import type { ReactElement } from "react";

/**
 * `core.canvas.new-canvas` — the rail's "New canvas" creator, as a PLAIN contributed row.
 *
 * IT BELONGS TO THIS PLUGIN because the affordance is an opinion about a DISCIPLINE, and this
 * plugin is the discipline. It sat in the sidebar panel's own JSX until this wave, which meant
 * the shell named a favourite kind of container in a file: a workspace with `core.canvas`
 * disabled still offered to make canvases, and a stranger's discipline had no way to put its
 * own creator in the rail without editing somebody else's component. Now the row lives and
 * dies with its plugin (D4′: disable it and the row VANISHES, the Plugins section stays the
 * ledger), and a new discipline ships one manifest row plus one component.
 *
 * THE DOOR IS UNCHANGED, and that is the invariant this move had to keep: creation still
 * commits through `core.index.createContainer`, which is what `data-action` names in the DOM
 * (AGENTS.md invariant 12; gate S4/R7 check every marker against the live roster). It is
 * dispatched through the workspace shell's own `createContainer`, because a birth is not only
 * an action call: the new container is remembered on this device, the index feed is refreshed
 * and the viewer LANDS inside it, and all three of those are the host's business rather than
 * this row's. A row that dispatched the door itself would create a container the operator is
 * left standing outside of.
 *
 * Collapsed to icons the label goes and the glyph stays, and a press opens the rail first: the
 * thing being created will appear in a list nobody can read at 64 pixels.
 */
export function NewCanvasRow(): ReactElement {
  const { createContainer, creating, setSidebarOpen, sidebarOpen } = useWorkspaceShell();
  return (
    <button
      className="sidebar-new"
      type="button"
      data-action="core.index.createContainer"
      title="New canvas"
      aria-label="New canvas"
      onClick={() => {
        if (!sidebarOpen) setSidebarOpen(true);
        createContainer("canvas");
      }}
      disabled={creating}
    >
      <ControlIcon kind="add" />
      {sidebarOpen ? <span>New canvas</span> : null}
    </button>
  );
}
