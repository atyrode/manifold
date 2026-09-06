import { useWorkspaceShell } from "@manifold/plugin/hooks";
import { Cluster, ItemIcon } from "@manifold/ui";
import { useState, type ReactElement } from "react";

/**
 * `core.index.new-folder` — the rail's "New folder" creator and the form it opens, as one
 * PLAIN contributed row.
 *
 * TWO PIECES OF CHROME, ONE ROW, and that is the point of moving it here. The button was in
 * the sidebar panel's JSX and the form was rendered beside it, three siblings apart, so the
 * shell held state about a noun it does not own (`folderName`, `creatingFolder`) and the index
 * plugin — which owns folders, their door and every other affordance over them — could not see
 * either. Now the arming, the draft name, the submit and the cancel are one component in the
 * plugin that owns the concept, and the shell holds no state about folders at all.
 *
 * IT IS THE TOP-LEVEL creator specifically: the form the index's TREE renders is for a folder
 * inside a folder and carries the parent it was opened on. Same door, same wire shape, two
 * places a reader can be standing — which is why this one passes `parentId: null` through the
 * host's own `createFolder` and the nested one passes an id through the plugin's client.
 *
 * The new row does not appear from this call and must not: the folder's own creation event puts
 * it in the index section, which subscribes to the index's node. Chrome that painted its own
 * optimistic row would be a second answer to what exists (invariant 11).
 */
export function NewFolderRow(): ReactElement {
  const { createFolder, setSidebarOpen, sidebarOpen } = useWorkspaceShell();
  const [name, setName] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const submit = async (trimmed: string): Promise<void> => {
    setCreating(true);
    try {
      await createFolder(trimmed);
      setName(null);
    } finally {
      setCreating(false);
    }
  };

  return (
    <>
      <button
        className="sidebar-new"
        type="button"
        title="New folder"
        aria-label="New folder"
        onClick={() => {
          if (!sidebarOpen) setSidebarOpen(true);
          setName("");
        }}
      >
        <ItemIcon kind="folder" />
        {sidebarOpen ? <span>New folder</span> : null}
      </button>
      {/* A collapsed rail has no room to type in; the press above opened it, so this follows. */}
      {sidebarOpen && name !== null ? (
        <form
          className="sidebar-create sidebar-folder-create"
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = name.trim();
            if (trimmed === "") return;
            void submit(trimmed);
          }}
        >
          <input
            maxLength={120}
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            placeholder="Folder name"
            aria-label="Folder name"
            autoFocus
            disabled={creating}
          />
          <Cluster justify="flex-end" gap="0.35rem">
            <button type="button" onClick={() => setName(null)} disabled={creating}>
              Cancel
            </button>
            <button
              type="submit"
              data-action="core.index.createFolder"
              disabled={creating || name.trim() === ""}
            >
              {creating ? "Creating…" : "Create"}
            </button>
          </Cluster>
        </form>
      ) : null}
    </>
  );
}
