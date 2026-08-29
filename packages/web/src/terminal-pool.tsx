import {
  dragAndDropFeature,
  hotkeysCoreFeature,
  isOrderedDragTarget,
  keyboardDragAndDropFeature,
  syncDataLoaderFeature,
  type TreeInstance,
} from "@headless-tree/core";
import type { MachineSummary, TerminalPoolEntry } from "@manifold/protocol";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { ITEM_MIME, sealEnvelope } from "./item-envelope.ts";
import { useHeadlessTree } from "./use-headless-tree.ts";

const POOL_ROOT_ID = "__terminal_pool_root__";
const POOL_ROOT_ENTRY: TerminalPoolEntry = {
  id: POOL_ROOT_ID,
  machineId: POOL_ROOT_ID,
  name: "Terminals",
  createdAt: 0,
  status: "running",
  exitCode: null,
  sortOrder: -1,
};

/** Native drag handlers the sidebar's drop pipeline supplies for the pool as a whole. */
export interface PoolDropProps {
  readonly onDragOver: (event: DragEvent<HTMLDivElement>) => void;
  readonly onDragLeave: (event: DragEvent<HTMLDivElement>) => void;
  readonly onDrop: (event: DragEvent<HTMLDivElement>) => void;
}

interface TerminalPoolSectionProps {
  readonly terminals: readonly TerminalPoolEntry[];
  readonly machines: readonly MachineSummary[];
  readonly onKill: (sessionId: string) => void;
  /** Rejects when the server refused; the caller owns the error surface. */
  readonly onRename: (sessionId: string, name: string) => Promise<void>;
  /** Resolves once the canonical pool order is applied by the caller. */
  readonly onMove: (sessionId: string, index: number) => Promise<void>;
  /**
   * The pool as a placement DESTINATION. It is a container like any other — `pool accepts
   * parkable` — so releasing a terminal anywhere over this body parks it, and the section
   * shows the same legality cues every other target does.
   */
  readonly dropProps: PoolDropProps;
  /** True while the carried item would legally land here. */
  readonly dropTarget: boolean;
  /** Refusal attributes when it would not; empty otherwise. */
  readonly refusal: Readonly<Record<string, string | undefined>>;
}

interface PoolTreeData {
  readonly items: ReadonlyMap<string, TerminalPoolEntry>;
  readonly order: readonly string[];
  readonly machineNames: ReadonlyMap<string, string>;
}

/**
 * Workspace-global pool of container-less terminal sessions, rendered as a second
 * headless-tree instance so parked terminals carry the exact container-row grammar: menu
 * rename, two-step kill, keyboard navigation, and durable drag ordering. Rows also drag out
 * onto container rows and into both renderers, and the body itself accepts drops.
 * The collapsible header around this body comes from the sidebar's uniform `SidebarSection`.
 */
export function TerminalPoolSection({
  terminals,
  machines,
  onKill,
  onRename,
  onMove,
  dropProps,
  dropTarget,
  refusal,
}: TerminalPoolSectionProps) {
  const [optimisticOrder, setOptimisticOrder] = useState<readonly string[] | null>(null);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameName, setRenameName] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [confirmKillId, setConfirmKillId] = useState<string | null>(null);
  const [actionId, setActionId] = useState<string | null>(null);
  const reorderingRef = useRef(false);
  const dndFrameRef = useRef<number | null>(null);
  const treeInstanceRef = useRef<TreeInstance<TerminalPoolEntry> | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  const treeData = useMemo<PoolTreeData>(() => {
    const items = new Map<string, TerminalPoolEntry>([[POOL_ROOT_ID, POOL_ROOT_ENTRY]]);
    for (const entry of terminals) items.set(entry.id, entry);
    const serverOrder = terminals.map((entry) => entry.id);
    // An in-flight reorder paints locally until the caller applies the canonical order.
    const projected =
      optimisticOrder === null
        ? serverOrder
        : [
            ...optimisticOrder.filter((id) => items.has(id)),
            ...serverOrder.filter((id) => !optimisticOrder.includes(id)),
          ];
    return {
      items,
      order: projected,
      machineNames: new Map(machines.map((machine) => [machine.id, machine.name] as const)),
    };
  }, [machines, optimisticOrder, terminals]);
  const treeDataRef = useRef(treeData);

  const scheduleDndPresentation = useCallback((): void => {
    if (dndFrameRef.current !== null) return;
    dndFrameRef.current = window.requestAnimationFrame(() => {
      dndFrameRef.current = null;
      const tree = treeInstanceRef.current;
      if (tree === null) return;
      const container = tree.getElement();
      if (container === null || container === undefined) return;

      for (const element of container.querySelectorAll(".pad-tree-item.is-drop-target")) {
        element.classList.remove("is-drop-target");
      }
      for (const item of tree.getItems()) {
        item
          .getElement()
          ?.closest(".pad-tree-item")
          ?.classList.toggle("is-drop-target", item.isDragTarget());
      }

      const dragLine = container.querySelector<HTMLElement>(".pad-tree-drag-line");
      if (dragLine !== null) {
        dragLine.removeAttribute("style");
        Object.assign(dragLine.style, tree.getDragLineStyle());
      }
    });
  }, []);

  const tree = useHeadlessTree<TerminalPoolEntry>({
    // Core owns drag targeting; this paints its state without routing ItemInstance objects
    // through React, which tears down the tree during native drags in React 19.
    setDndState: scheduleDndPresentation,
    rootItemId: POOL_ROOT_ID,
    getItemName: (item) => {
      const entry = item.getItemData();
      if (entry.id === POOL_ROOT_ID) return "Terminals";
      return entry.name ?? treeDataRef.current.machineNames.get(entry.machineId) ?? entry.machineId;
    },
    isItemFolder: () => false,
    dataLoader: {
      getItem: (itemId) => {
        const entry = treeDataRef.current.items.get(itemId);
        if (entry === undefined) throw new Error(`Unknown terminal pool item: ${itemId}`);
        return entry;
      },
      getChildren: (itemId) => (itemId === POOL_ROOT_ID ? [...treeDataRef.current.order] : []),
    },
    indent: 0,
    canReorder: true,
    seperateDragHandle: false,
    draggedItemOverwritesSelection: true,
    canDrag: (items) => {
      if (reorderingRef.current || items.length !== 1) return false;
      const entry = items[0]?.getItemData();
      if (entry === undefined || entry.id === POOL_ROOT_ID) return false;
      return renameId !== entry.id && confirmKillId !== entry.id;
    },
    canDrop: (_items, target) =>
      isOrderedDragTarget(target) || target.item.getId() === POOL_ROOT_ID,
    // A tree-managed row drag also seals the ONE item envelope, so the same gesture that
    // reorders inside the pool drops onto container rows, either renderer, or a tile.
    // `createForeignDragObject` is the only source shape with no handler to run, which is
    // why sealing and beginning the carry are one call.
    createForeignDragObject: (items) => ({
      format: ITEM_MIME,
      data: sealEnvelope({ kind: "terminal", sessionId: items[0]?.getId() ?? "" }),
      effectAllowed: "move",
    }),
    onDrop: (items, target) => {
      const moved = items[0]?.getItemData();
      if (moved === undefined || moved.id === POOL_ROOT_ID || reorderingRef.current) return;
      const current = treeDataRef.current.order;
      const from = current.indexOf(moved.id);
      if (from === -1) return;
      const index = isOrderedDragTarget(target) ? target.insertionIndex : current.length;
      const projected = [...current];
      projected.splice(from, 1);
      // Server semantics: the index counts siblings with the moved row already removed.
      projected.splice(Math.max(0, Math.min(index, projected.length)), 0, moved.id);
      const request = onMove(moved.id, index);

      reorderingRef.current = true;
      // Headless Tree clears native DnD state after onDrop returns. Paint the local
      // projection in the following task, then hand back to the caller's canonical order.
      window.setTimeout(() => {
        setOptimisticOrder(projected);
        void request
          .catch(() => {
            // The caller surfaces the failure; dropping the projection restores server order.
          })
          .finally(() => {
            setOptimisticOrder(null);
            reorderingRef.current = false;
          });
      }, 0);
    },
    features: [
      syncDataLoaderFeature,
      dragAndDropFeature,
      keyboardDragAndDropFeature,
      hotkeysCoreFeature,
    ],
  });

  useEffect(() => {
    treeInstanceRef.current = tree;
    treeDataRef.current = treeData;
    tree.rebuildTree();
    return () => {
      treeInstanceRef.current = null;
    };
  }, [tree, treeData]);

  useEffect(
    () => () => {
      if (dndFrameRef.current !== null) window.cancelAnimationFrame(dndFrameRef.current);
    },
    [],
  );

  useEffect(() => {
    if (renameId === null) return;
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [renameId]);

  useEffect(() => {
    if (actionId === null) return;
    const closeMenu = (event: PointerEvent): void => {
      if (
        event.target instanceof Element &&
        event.target.closest(".pad-sidebar-actions") !== null
      ) {
        return;
      }
      setActionId(null);
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setActionId(null);
    };
    document.addEventListener("pointerdown", closeMenu);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeMenu);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [actionId]);

  const submitRename = async (entry: TerminalPoolEntry): Promise<void> => {
    const trimmedName = renameName.trim();
    if (trimmedName.length === 0 || trimmedName === entry.name) {
      setRenameId(null);
      return;
    }
    setRenaming(true);
    try {
      await onRename(entry.id, trimmedName);
      setRenameId(null);
    } catch {
      // The caller owns the error surface; keep the inline editor open for a retry.
    } finally {
      setRenaming(false);
    }
  };

  const renderRow = (entry: TerminalPoolEntry) => {
    const machine = treeData.machineNames.get(entry.machineId) ?? entry.machineId;
    const label = entry.name ?? machine;
    const secondary =
      entry.status === "exited"
        ? `${machine} · exited${entry.exitCode === null ? "" : ` ${entry.exitCode}`}`
        : machine;
    if (renameId === entry.id) {
      return (
        <div className="pad-sidebar-row is-editing">
          <span
            className={`session-state ${entry.status === "running" ? "is-running" : ""}`}
            aria-hidden="true"
          >
            {entry.status === "running" ? "●" : "○"}
          </span>
          <input
            ref={renameInputRef}
            className="pad-sidebar-rename-input"
            aria-label={`Rename ${label}`}
            maxLength={120}
            value={renameName}
            disabled={renaming}
            onChange={(event) => setRenameName(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submitRename(entry);
              if (event.key === "Escape") setRenameId(null);
            }}
          />
          <button
            className="pad-sidebar-inline-action is-primary"
            aria-label={`Save name for ${label}`}
            title="Save"
            disabled={renaming || renameName.trim() === "" || renameName.trim() === entry.name}
            onClick={() => void submitRename(entry)}
          >
            <span aria-hidden="true">✓</span>
          </button>
          <button
            className="pad-sidebar-inline-action"
            aria-label={`Cancel renaming ${label}`}
            title="Cancel"
            disabled={renaming}
            onClick={() => setRenameId(null)}
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
      );
    }
    if (confirmKillId === entry.id) {
      return (
        <div className="pad-sidebar-row is-confirming">
          <span className="pad-sidebar-confirm-label">Kill “{label}”?</span>
          <button
            className="pad-sidebar-confirm-delete"
            aria-label={`Confirm killing ${label}`}
            onClick={() => {
              setConfirmKillId(null);
              onKill(entry.id);
            }}
          >
            Kill
          </button>
          <button
            className="pad-sidebar-confirm-cancel"
            aria-label={`Cancel killing ${label}`}
            onClick={() => setConfirmKillId(null)}
          >
            Cancel
          </button>
        </div>
      );
    }
    return (
      <div
        className={`pad-sidebar-row terminal-pool-row${entry.status === "exited" ? " is-exited" : ""}`}
        data-session-id={entry.id}
      >
        <span
          className={`session-state ${entry.status === "running" ? "is-running" : ""}`}
          title={entry.status}
          aria-hidden="true"
        >
          {entry.status === "running" ? "●" : "○"}
        </span>
        <div className="pad-sidebar-link terminal-pool-label" title={label}>
          <span className="terminal-pool-name">{label}</span>
          <span className="terminal-pool-machine">{secondary}</span>
        </div>
        <div className="pad-sidebar-actions">
          <button
            className="pad-sidebar-delete"
            title={`Terminal actions for ${label}`}
            aria-label={`Terminal actions for ${label}`}
            aria-pressed={actionId === entry.id}
            onClick={() => setActionId((current) => (current === entry.id ? null : entry.id))}
          >
            <span aria-hidden="true">•••</span>
          </button>
          {actionId === entry.id ? (
            <div className="pad-sidebar-action-menu" role="menu">
              <button
                role="menuitem"
                onClick={() => {
                  setActionId(null);
                  setRenameId(entry.id);
                  setRenameName(entry.name ?? label);
                }}
              >
                Rename
              </button>
              <button
                className="is-danger"
                role="menuitem"
                onClick={() => {
                  setActionId(null);
                  setConfirmKillId(entry.id);
                }}
              >
                Kill
              </button>
            </div>
          ) : null}
        </div>
      </div>
    );
  };

  return (
    <div
      className={`pad-sidebar-terminal-pool${dropTarget ? " is-drop-target" : ""}`}
      {...refusal}
      {...dropProps}
    >
      <div
        {...tree.getContainerProps()}
        className="pad-sidebar-list pad-sidebar-tree"
        data-testid="terminal-pool-list"
      >
        {treeData.order.length === 0 ? (
          <span className="terminal-pool-empty">No parked terminals</span>
        ) : null}
        {tree
          .getItems()
          .filter((item) => item.getId() !== POOL_ROOT_ID)
          .map((item) => (
            <div
              {...item.getProps()}
              className="pad-tree-item"
              data-tree-kind="terminal"
              data-tree-id={item.getId()}
              key={item.getId()}
            >
              {/* No drag affordance glyph: the row itself is the handle (cursor: grab). */}
              {renderRow(item.getItemData())}
            </div>
          ))}
        <div style={{ display: "none" }} className="pad-tree-drag-line" />
      </div>
    </div>
  );
}
