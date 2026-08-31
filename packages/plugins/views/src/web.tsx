import {
  dragAndDropFeature,
  hotkeysCoreFeature,
  isOrderedDragTarget,
  keyboardDragAndDropFeature,
  syncDataLoaderFeature,
  type ItemInstance,
  type TreeInstance,
} from "@headless-tree/core";
import {
  buildPadTree,
  projectPadTreeMove,
  samePadTreeItems,
  treeItemId,
  type SectionProps,
  type PadTreeNode,
} from "@manifold/plugin";
import { usePolledResource } from "@manifold/plugin/hooks";
import type {
  Pad,
  PadPresence,
  PadSessionSummary,
  PadTreeItem,
  TerminalSummary,
} from "@manifold/protocol";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Ellipsis,
  Folder,
  FolderOpen,
  LayoutDashboard,
  ListTree,
  Plus,
  SquareDashed,
  SquareTerminal,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { useHeadlessTree } from "./use-headless-tree.ts";

/**
 * The workspace index's browser half — the sidebar's largest section, and the plugin that
 * proves the boundary is real: it holds no shell state, receives no props but `host`, and
 * every question it asks (what exists, who is where, which terminals are alive) and every
 * write it performs (rename, delete, move, kill) goes through a door a stranger's agent has
 * too. What used to be 900 lines fused into the shell is now a plugin the shell only knows
 * the ORDER of.
 *
 * The index has no event channel yet, so it polls; when the event plane lands (wave 2) the
 * four `usePolledResource` calls below become four subscriptions and nothing else moves.
 */

/** Index cadence, matching what the shell used to poll on the section's behalf. */
const INDEX_POLL_MS = 2_000;

/** Device-local presentation memory. Both keys are listed in the AXIOMS.md register. */
const SESSION_TREE_KEY = "manifold:show-pad-sessions";
const EXPANDED_FOLDERS_KEY = "manifold:expanded-pad-folders";

const NO_SESSIONS: readonly PadSessionSummary[] = [];
const NO_TERMINALS: readonly TerminalSummary[] = [];
const NO_PRESENCE: readonly PadPresence[] = [];

/** The tree's own root, which is never a row: it exists so folders have a parent. */
const SIDEBAR_ROOT_ITEM: PadTreeItem = {
  kind: "folder",
  id: "__sidebar_root__",
  name: "Views",
  createdAt: 0,
  parentId: null,
  sortOrder: -1,
};

/** One stroke weight, one rhythm — the same the floor's icon vocabulary paints with. */
const ICON = { strokeWidth: 1.75, absoluteStrokeWidth: true, focusable: "false" } as const;

function Glyph({ icon: Icon, size = 14 }: { icon: LucideIcon; size?: number }): ReactElement {
  return <Icon className="mf-icon" size={size} {...ICON} />;
}

function initials(name: string): string {
  return [...name][0]?.toUpperCase() ?? "?";
}

function initialSessionTree(): boolean {
  try {
    return window.localStorage.getItem(SESSION_TREE_KEY) === "true";
  } catch {
    return false;
  }
}

function initialExpandedFolders(): string[] {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(EXPANDED_FOLDERS_KEY) ?? "[]");
    return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/** Ghost rows rather than the word “Loading”. */
function IndexSkeleton(): ReactElement {
  return (
    <div className="index-skeleton" role="presentation" aria-busy="true">
      <span className="index-skeleton-row" />
      <span className="index-skeleton-row" />
      <span className="index-skeleton-row" />
    </div>
  );
}

export function ViewsSection({ host }: SectionProps): ReactElement {
  const client = host.client;
  const activePadId = host.padId;

  const [failure, setFailure] = useState<string | null>(null);
  const report = useCallback((reason: unknown, fallback: string): void => {
    setFailure(reason instanceof Error ? reason.message : fallback);
  }, []);

  const [showSessions, setShowSessions] = useState(initialSessionTree);
  const [actionPadId, setActionPadId] = useState<string | null>(null);
  const [renameTargetId, setRenameTargetId] = useState<string | null>(null);
  const [renameName, setRenameName] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [folderRenameName, setFolderRenameName] = useState("");
  const [deletingFolderId, setDeletingFolderId] = useState<string | null>(null);
  const [folderCreateParentId, setFolderCreateParentId] = useState<string | null>(null);
  const [folderName, setFolderName] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [initialExpandedItems] = useState<string[]>(initialExpandedFolders);
  const [, renderTreeState] = useState(0);
  const reorderingRef = useRef(false);
  const treeInstanceRef = useRef<TreeInstance<PadTreeItem> | null>(null);
  const dndFrameRef = useRef<number | null>(null);

  const fetchTree = useCallback(() => client.padTree(), [client]);
  const fetchSessions = useCallback(() => client.padSessions(), [client]);
  const fetchPresence = useCallback(() => client.padPresence(), [client]);
  const fetchTerminals = useCallback(() => client.terminals(), [client]);

  /**
   * The one question that tells a tree gesture apart from everything else. While a row is
   * held, the tree owns its own DOM and its own idea of the index: a poll that committed
   * underneath would rebuild the rows out from under the pointer. Held responses are dropped,
   * not queued — the tick after the gesture settles carries the truth.
   */
  const treeOwnsDrag = useCallback(
    (): boolean => treeInstanceRef.current?.getState().dnd != null,
    [],
  );

  const {
    value: treeItems,
    setValue: setTreeItems,
    refresh: refreshTree,
  } = usePolledResource<readonly PadTreeItem[] | null>(fetchTree, INDEX_POLL_MS, {
    initial: null,
    hold: treeOwnsDrag,
    equal: (current, incoming) =>
      current !== null && incoming !== null && samePadTreeItems(current, incoming),
    onError: (reason) => report(reason, "Could not load views"),
  });
  const { value: padSessions } = usePolledResource(fetchSessions, INDEX_POLL_MS, {
    initial: NO_SESSIONS,
    hold: treeOwnsDrag,
  });
  const { value: presence } = usePolledResource(fetchPresence, INDEX_POLL_MS, {
    initial: NO_PRESENCE,
    hold: treeOwnsDrag,
    restartKey: activePadId,
  });
  const { value: terminals, refresh: refreshTerminals } = usePolledResource(
    fetchTerminals,
    INDEX_POLL_MS,
    { initial: NO_TERMINALS, hold: treeOwnsDrag },
  );

  /**
   * A pad row IS a terminal when exactly one terminal calls it home: that is a solo
   * composition, and a composition of one is the item it holds — so the index shows the
   * terminal, with the terminal's name, glyph and destructive verb. A composition two
   * terminals call home is a real composition again, and falls out of this map by construction.
   */
  const terminalByHome = useMemo(() => {
    const homes = new Map<string, TerminalSummary>();
    const shared = new Set<string>();
    for (const terminal of terminals) {
      if (homes.has(terminal.homeId)) shared.add(terminal.homeId);
      homes.set(terminal.homeId, terminal);
    }
    for (const homeId of shared) homes.delete(homeId);
    return homes;
  }, [terminals]);

  /**
   * INDEX VISIBILITY: the top level is homes and the homeless. A container is a home and
   * always shows; an ITEM shows here only while nothing holds it, because a placed item is
   * already visible inside whatever holds it and listing it twice would make the index a
   * second, competing statement about where things are.
   */
  const indexedTreeItems = useMemo(
    () =>
      treeItems?.filter(
        (item) => item.kind === "folder" || (terminalByHome.get(item.pad.id)?.unplaced ?? true),
      ) ?? null,
    [terminalByHome, treeItems],
  );

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

  const renderSettledTreeState = useCallback((): void => {
    const tree = treeInstanceRef.current;
    if (tree === null) return;
    if (tree.getState().dnd !== null && tree.getState().dnd !== undefined) return;
    try {
      window.localStorage.setItem(
        EXPANDED_FOLDERS_KEY,
        JSON.stringify(tree.getState().expandedItems),
      );
    } catch {
      // Folder expansion memory is optional.
    }
    renderTreeState((revision) => revision + 1);
  }, []);

  useEffect(
    () => () => {
      if (dndFrameRef.current !== null) window.cancelAnimationFrame(dndFrameRef.current);
    },
    [],
  );

  useEffect(() => {
    if (actionPadId === null) return;
    const closeMenu = (event: PointerEvent): void => {
      if (event.target instanceof Element && event.target.closest(".pad-sidebar-actions") !== null) {
        return;
      }
      setActionPadId(null);
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setActionPadId(null);
    };
    document.addEventListener("pointerdown", closeMenu);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeMenu);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [actionPadId]);

  const treeData = useMemo(() => {
    const data = new Map<string, { item: PadTreeItem; children: string[] }>();
    const roots = buildPadTree(indexedTreeItems ?? []);
    const addNodes = (nodes: readonly PadTreeNode[]): string[] =>
      nodes.map((node) => {
        const id = `${node.item.kind}:${treeItemId(node.item)}`;
        data.set(id, { item: node.item, children: addNodes(node.children) });
        return id;
      });
    data.set("root", { item: SIDEBAR_ROOT_ITEM, children: addNodes(roots) });
    return data;
  }, [indexedTreeItems]);
  const treeDataRef = useRef(treeData);

  const tree = useHeadlessTree<PadTreeItem>({
    initialState: { expandedItems: initialExpandedItems },
    // Core owns drag targeting; this paints its state without routing ItemInstance objects
    // through React, which tears down the tree during native drags in React 19.
    setDndState: scheduleDndPresentation,
    rootItemId: "root",
    getItemName: (item) => {
      const data = item.getItemData();
      return item.getId() === "root" ? "Views" : data.kind === "pad" ? data.pad.name : data.name;
    },
    isItemFolder: (item) => item.getItemData().kind === "folder",
    dataLoader: {
      getItem: (itemId) => {
        const entry = treeDataRef.current.get(itemId);
        if (entry === undefined) throw new Error(`Unknown sidebar tree item: ${itemId}`);
        return entry.item;
      },
      getChildren: (itemId) => treeDataRef.current.get(itemId)?.children ?? [],
    },
    indent: 16,
    canReorder: true,
    seperateDragHandle: false,
    draggedItemOverwritesSelection: true,
    canDrag: (items) => {
      if (reorderingRef.current || items.length !== 1) return false;
      const data = items[0]?.getItemData();
      if (data === undefined || data === null) return false;
      return data.kind === "pad" ? renameTargetId !== data.pad.id : renamingFolderId !== data.id;
    },
    canDrop: (_items, target) => isOrderedDragTarget(target) || target.item.isFolder(),
    onDrop: (items, target) => {
      const moved = items[0]?.getItemData();
      if (moved === undefined || moved === null || reorderingRef.current || treeItems === null) {
        return;
      }
      const targetData = target.item.getItemData();
      const parentId =
        target.item.getId() === "root"
          ? null
          : targetData.kind === "folder"
            ? targetData.id
            : targetData.parentId;
      // The tree renders every stored sibling, so the insertion index needs no translation.
      const index = isOrderedDragTarget(target)
        ? target.insertionIndex
        : (treeDataRef.current.get(target.item.getId())?.children.length ?? 0);
      const item = { kind: moved.kind, id: treeItemId(moved) } as const;
      const previousTreeItems = treeItems;
      const optimisticTreeItems = projectPadTreeMove(treeItems, item, parentId, index);
      const request = client.movePadTreeItem(item, parentId, index).then(
        (nextTreeItems) => ({ ok: true, nextTreeItems }) as const,
        (reason: unknown) => ({ ok: false, reason }) as const,
      );

      reorderingRef.current = true;
      // Headless Tree clears native DnD state after onDrop returns. Paint the local
      // projection in the following task, then reconcile with the server response.
      window.setTimeout(() => {
        setTreeItems(optimisticTreeItems);
        void request.then((outcome) => {
          if (outcome.ok) {
            setTreeItems(outcome.nextTreeItems);
          } else {
            setTreeItems(previousTreeItems);
            report(outcome.reason, "Could not move the sidebar item");
          }
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

  /**
   * A row's mark: the object's own species icon, the same one it wears in its titlebar. A solo
   * composition wears the TERMINAL's mark, because a composition of one is the item it holds.
   * Liveness rides ON that mark for a terminal (`session-state` tints it) rather than beside it.
   */
  const containerMark = (pad: Pad): ReactNode => {
    const terminal = terminalByHome.get(pad.id);
    if (terminal !== undefined) {
      return (
        <span
          className={`pad-sidebar-item-mark session-state ${terminal.status === "running" ? "is-running" : ""}`}
          aria-hidden="true"
        >
          <Glyph icon={SquareTerminal} />
        </span>
      );
    }
    return (
      <span className="pad-sidebar-item-mark" aria-hidden="true">
        <Glyph icon={pad.layout === "tiled" ? LayoutDashboard : SquareDashed} />
      </span>
    );
  };

  /** What a row calls itself: a solo composition shows its terminal's name. */
  const rowName = (pad: Pad): string => terminalByHome.get(pad.id)?.name ?? pad.name;

  /** What a row IS, for every label that has to name it. */
  const rowNoun = (pad: Pad): string =>
    terminalByHome.has(pad.id) ? "terminal" : pad.layout === "tiled" ? "composition" : "canvas";

  const openRename = (pad: Pad): void => {
    setActionPadId(null);
    setRenameTargetId(pad.id);
    setRenameName(rowName(pad));
  };

  /**
   * One rename gesture, two doors. A solo composition and the terminal in it are one object to
   * the operator, and the terminal is the half that owns the name — so renaming that row
   * dispatches `core.terminals.rename`. Every other row renames the container over its own
   * route, which the index can apply locally at once.
   */
  const submitRename = async (pad: Pad): Promise<void> => {
    const trimmedName = renameName.trim();
    if (trimmedName.length === 0 || trimmedName === rowName(pad)) {
      setRenameTargetId(null);
      return;
    }
    const terminal = terminalByHome.get(pad.id);
    setRenaming(true);
    try {
      if (terminal !== undefined) {
        const outcome = await client.action("core.terminals.rename", {
          sessionId: terminal.id,
          name: trimmedName,
        });
        if (!outcome.ok) {
          setFailure(outcome.denial.message);
          return;
        }
        refreshTerminals();
        setRenameTargetId(null);
        return;
      }
      const renamed = await client.renamePad(pad.id, trimmedName);
      setTreeItems(
        (current) =>
          current?.map((item) =>
            item.kind === "pad" && item.pad.id === renamed.id ? { ...item, pad: renamed } : item,
          ) ?? null,
      );
      setRenameTargetId(null);
    } catch (reason: unknown) {
      report(reason, `Could not rename the ${rowNoun(pad)}`);
    } finally {
      setRenaming(false);
    }
  };

  /**
   * Destroying an index row is ONE gesture, whatever the row is — and for a terminal it really
   * is destruction: there is no pool to fall back into, so the PTY dies and the composition it
   * lived in goes with it. The verb on the menu item says so.
   */
  const destroyRow = async (pad: Pad): Promise<void> => {
    setActionPadId(null);
    const terminal = terminalByHome.get(pad.id);
    setDeletingId(pad.id);
    try {
      if (terminal !== undefined) {
        const outcome = await client.action("core.terminals.kill", { sessionId: terminal.id });
        if (!outcome.ok) setFailure(outcome.denial.message);
      } else {
        await client.deletePad(pad.id);
      }
      // Killing a terminal empties and deletes its home composition, so both listings change.
      refreshTerminals();
      refreshTree();
    } catch (reason: unknown) {
      report(reason, `Could not remove the ${rowNoun(pad)}`);
    } finally {
      setDeletingId(null);
    }
  };

  const submitFolder = async (parentId: string): Promise<void> => {
    const trimmedName = folderName.trim();
    if (trimmedName.length === 0) return;
    setCreatingFolder(true);
    try {
      setTreeItems(await client.createPadFolder(trimmedName, parentId));
      tree.getItemInstance(`folder:${parentId}`).expand();
      renderSettledTreeState();
      setFolderName("");
      setFolderCreateParentId(null);
    } catch (reason: unknown) {
      report(reason, "Could not create the folder");
    } finally {
      setCreatingFolder(false);
    }
  };

  const submitFolderRename = async (
    folder: Extract<PadTreeItem, { kind: "folder" }>,
  ): Promise<void> => {
    const trimmedName = folderRenameName.trim();
    if (trimmedName.length === 0 || trimmedName === folder.name) {
      setRenamingFolderId(null);
      return;
    }
    try {
      setTreeItems(await client.renamePadFolder(folder.id, trimmedName));
      setRenamingFolderId(null);
    } catch (reason: unknown) {
      report(reason, "Could not rename the folder");
    }
  };

  const removeFolder = async (folder: Extract<PadTreeItem, { kind: "folder" }>): Promise<void> => {
    setDeletingFolderId(folder.id);
    try {
      setTreeItems(await client.deletePadFolder(folder.id));
      setRenamingFolderId(null);
    } catch (reason: unknown) {
      report(reason, "Could not delete the folder");
    } finally {
      setDeletingFolderId(null);
    }
  };

  /** One inline editor for every index row: canvas, composition and terminal alike. */
  const renderContainerRenameRow = (pad: Pad, active: boolean): ReactNode => {
    const label = rowName(pad);
    const isTerminal = terminalByHome.has(pad.id);
    return (
      <div className={`pad-sidebar-row is-editing${active ? " is-active" : ""}`}>
        {containerMark(pad)}
        <input
          className="pad-sidebar-rename-input"
          aria-label={`Rename ${label}`}
          maxLength={120}
          value={renameName}
          disabled={renaming}
          autoFocus
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setRenameName(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void submitRename(pad);
            if (event.key === "Escape") setRenameTargetId(null);
          }}
        />
        <button
          className="pad-sidebar-inline-action is-primary"
          type="button"
          aria-label={`Save name for ${label}`}
          title="Save"
          {...(isTerminal ? { "data-action": "core.terminals.rename" } : {})}
          disabled={renaming || renameName.trim() === "" || renameName.trim() === label}
          onClick={() => void submitRename(pad)}
        >
          <Glyph icon={Check} />
        </button>
        <button
          className="pad-sidebar-inline-action"
          type="button"
          aria-label={`Cancel renaming ${label}`}
          title="Cancel"
          disabled={renaming}
          onClick={() => setRenameTargetId(null)}
        >
          <Glyph icon={X} />
        </button>
      </div>
    );
  };

  /** The row menu: rename inline, destroy on the click. */
  const renderContainerActions = (pad: Pad): ReactNode => {
    const label = rowName(pad);
    const kind = rowNoun(pad);
    const heading = `${kind[0]?.toUpperCase() ?? ""}${kind.slice(1)}`;
    const isTerminal = terminalByHome.has(pad.id);
    return (
      <div className="pad-sidebar-actions">
        <button
          className="pad-sidebar-delete"
          type="button"
          title={`${heading} actions for ${label}`}
          aria-label={`${heading} actions for ${label}`}
          aria-pressed={actionPadId === pad.id}
          onClick={() => setActionPadId((current) => (current === pad.id ? null : pad.id))}
        >
          <Glyph icon={Ellipsis} />
        </button>
        {actionPadId === pad.id ? (
          <div className="pad-sidebar-action-menu" role="menu">
            <button type="button" role="menuitem" onClick={() => openRename(pad)}>
              Rename
            </button>
            <button
              className="is-danger"
              type="button"
              role="menuitem"
              {...(isTerminal ? { "data-action": "core.terminals.kill" } : {})}
              disabled={deletingId !== null}
              onClick={() => void destroyRow(pad)}
            >
              {isTerminal ? "Kill" : "Delete"}
            </button>
          </div>
        ) : null}
      </div>
    );
  };

  /**
   * One row per thing that exists. A canvas, a composition and a terminal are all index rows
   * here: the glyph, the name and the destructive verb come from the row's own identity, and
   * nothing else about the row forks.
   */
  const renderContainerRow = (pad: Pad): ReactNode => {
    const active = pad.id === activePadId;
    const principals = presence.find((entry) => entry.padId === pad.id)?.principals ?? [];
    const visiblePrincipals = principals.slice(0, 3);
    const summaries = padSessions.filter((session) => session.padId === pad.id);
    const runningCount = summaries.filter((session) => session.status === "running").length;

    const row =
      renameTargetId === pad.id ? (
        renderContainerRenameRow(pad, active)
      ) : (
        <div
          className={`pad-sidebar-row${active ? " is-active" : ""}${terminalByHome.get(pad.id)?.status === "exited" ? " is-exited" : ""}`}
        >
          <button
            className="pad-sidebar-link"
            type="button"
            title={rowName(pad)}
            aria-label={`Open ${rowNoun(pad)} ${rowName(pad)}`}
            aria-current={active ? "page" : undefined}
            onClick={() => host.navigate(`manifold://pad/${encodeURIComponent(pad.id)}`)}
            onKeyDown={(event) => {
              // Enter is the button's own activation; F2 and Delete match the row menu's items.
              if (event.key === "F2") {
                event.preventDefault();
                openRename(pad);
              }
              if (event.key === "Delete") {
                event.preventDefault();
                void destroyRow(pad);
              }
            }}
          >
            {containerMark(pad)}
            <span className="pad-sidebar-pad-name">{rowName(pad)}</span>
            {runningCount > 0 ? (
              <span
                className="pad-sidebar-session-count"
                title={`${runningCount} open ${runningCount === 1 ? "session" : "sessions"}`}
              >
                {runningCount}
              </span>
            ) : null}
            {principals.length > 0 ? (
              <span
                className="pad-sidebar-presence"
                aria-label={`${principals.length} present in ${rowName(pad)}`}
              >
                {visiblePrincipals.map((principal) => (
                  <span
                    className={`presence-avatar${principal.kind === "agent" ? " is-agent" : ""}`}
                    style={{ backgroundColor: principal.color }}
                    title={`${principal.name} (${principal.kind})`}
                    key={principal.id}
                  >
                    {initials(principal.name)}
                  </span>
                ))}
                {principals.length > visiblePrincipals.length ? (
                  <span className="presence-avatar presence-overflow">
                    +{principals.length - visiblePrincipals.length}
                  </span>
                ) : null}
              </span>
            ) : null}
          </button>
          {renderContainerActions(pad)}
        </div>
      );

    return (
      <>
        {row}
        {showSessions
          ? summaries.map((session) => (
              <div
                className={`pad-sidebar-session is-summary${session.status === "exited" ? " is-exited" : ""}`}
                key={session.id}
              >
                <span
                  className={`session-state ${session.status === "running" ? "is-running" : ""}`}
                  aria-hidden="true"
                >
                  <Glyph icon={SquareTerminal} size={13} />
                </span>
                <span>{session.machineId}</span>
                <small>{session.status}</small>
                {session.status === "running" ? (
                  <button
                    className="pad-sidebar-inline-action"
                    type="button"
                    data-action="core.terminals.kill"
                    aria-label={`Kill session ${session.id}`}
                    title="Kill session"
                    onClick={() => {
                      void client
                        .action("core.terminals.kill", { sessionId: session.id })
                        .then((outcome) => {
                          if (!outcome.ok) setFailure(outcome.denial.message);
                          refreshTerminals();
                          refreshTree();
                        })
                        .catch((reason: unknown) => report(reason, "Could not kill the terminal"));
                    }}
                  >
                    <Glyph icon={X} size={12} />
                  </button>
                ) : null}
              </div>
            ))
          : null}
      </>
    );
  };

  const renderFolderCreateForm = (parentId: string): ReactNode => (
    <form
      className="pad-sidebar-create pad-sidebar-folder-create is-nested"
      onSubmit={(event) => {
        event.preventDefault();
        void submitFolder(parentId);
      }}
    >
      <input
        maxLength={120}
        value={folderName}
        onChange={(event) => setFolderName(event.currentTarget.value)}
        placeholder="Folder name"
        aria-label="Folder name"
        autoFocus
        disabled={creatingFolder}
      />
      <div>
        <button type="button" onClick={() => setFolderCreateParentId(null)} disabled={creatingFolder}>
          Cancel
        </button>
        <button type="submit" disabled={creatingFolder || folderName.trim() === ""}>
          {creatingFolder ? "Creating…" : "Create"}
        </button>
      </div>
    </form>
  );

  const renderFolder = (
    folder: Extract<PadTreeItem, { kind: "folder" }>,
    item: ItemInstance<PadTreeItem>,
  ): ReactNode => {
    const actionId = `folder:${folder.id}`;
    if (renamingFolderId === folder.id) {
      return (
        <div className="pad-sidebar-row is-editing">
          <span className="pad-sidebar-folder-icon" aria-hidden="true">
            <Glyph icon={Folder} />
          </span>
          <input
            className="pad-sidebar-rename-input"
            value={folderRenameName}
            maxLength={120}
            aria-label={`Rename folder ${folder.name}`}
            autoFocus
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setFolderRenameName(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submitFolderRename(folder);
              if (event.key === "Escape") setRenamingFolderId(null);
            }}
          />
          <button
            className="pad-sidebar-inline-action is-primary"
            type="button"
            aria-label={`Save name for ${folder.name}`}
            disabled={folderRenameName.trim() === ""}
            onClick={() => void submitFolderRename(folder)}
          >
            <Glyph icon={Check} />
          </button>
          <button
            className="pad-sidebar-inline-action"
            type="button"
            aria-label={`Cancel renaming ${folder.name}`}
            onClick={() => setRenamingFolderId(null)}
          >
            <Glyph icon={X} />
          </button>
        </div>
      );
    }
    /* No confirmation step: the menu item already said Delete, and children move up. */
    return (
      <>
        <div className="pad-sidebar-row pad-sidebar-folder-row">
          <button
            className="pad-sidebar-folder-toggle"
            type="button"
            aria-label={`${item.isExpanded() ? "Collapse" : "Expand"} folder ${folder.name}`}
            aria-expanded={item.isExpanded()}
            onClick={(event) => {
              event.stopPropagation();
              if (item.isExpanded()) item.collapse();
              else item.expand();
              renderSettledTreeState();
            }}
          >
            <span className="pad-sidebar-folder-chevron" aria-hidden="true">
              <Glyph icon={item.isExpanded() ? ChevronDown : ChevronRight} size={12} />
            </span>
            <span className="pad-sidebar-folder-icon" aria-hidden="true">
              <Glyph icon={item.isExpanded() ? FolderOpen : Folder} />
            </span>
            <strong>{folder.name}</strong>
          </button>
          <div className="pad-sidebar-actions" onClick={(event) => event.stopPropagation()}>
            <button
              className="pad-sidebar-folder-add"
              type="button"
              title={`New folder inside ${folder.name}`}
              aria-label={`New folder inside ${folder.name}`}
              onClick={() => {
                setFolderName("");
                setFolderCreateParentId(folder.id);
              }}
            >
              <Glyph icon={Plus} size={12} />
            </button>
            <button
              className="pad-sidebar-delete"
              type="button"
              title={`Folder actions for ${folder.name}`}
              aria-label={`Folder actions for ${folder.name}`}
              aria-pressed={actionPadId === actionId}
              onClick={() => setActionPadId((current) => (current === actionId ? null : actionId))}
            >
              <Glyph icon={Ellipsis} />
            </button>
            {actionPadId === actionId ? (
              <div className="pad-sidebar-action-menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setActionPadId(null);
                    setRenamingFolderId(folder.id);
                    setFolderRenameName(folder.name);
                  }}
                >
                  Rename
                </button>
                <button
                  className="is-danger"
                  type="button"
                  role="menuitem"
                  disabled={deletingFolderId === folder.id}
                  onClick={() => {
                    setActionPadId(null);
                    void removeFolder(folder);
                  }}
                >
                  Delete
                </button>
              </div>
            ) : null}
          </div>
        </div>
        {folderCreateParentId === folder.id ? renderFolderCreateForm(folder.id) : null}
      </>
    );
  };

  const padCount = indexedTreeItems?.filter((item) => item.kind === "pad").length ?? 0;

  return (
    <div className="views-section">
      <div className="views-section-bar">
        <span className="sidebar-section-count">{padCount}</span>
        <button
          className="pad-sidebar-section-action"
          type="button"
          aria-pressed={showSessions}
          title={showSessions ? "Hide sessions under views" : "Show sessions under views"}
          aria-label={showSessions ? "Hide session tree" : "Show session tree"}
          onClick={() => {
            setShowSessions((current) => {
              try {
                window.localStorage.setItem(SESSION_TREE_KEY, String(!current));
              } catch {
                // Session tree memory is optional.
              }
              return !current;
            });
          }}
        >
          <Glyph icon={ListTree} />
        </button>
      </div>
      {failure === null ? null : (
        <p className="views-section-error" role="alert">
          {failure}
        </p>
      )}
      <div
        {...tree.getContainerProps()}
        className="pad-sidebar-list pad-sidebar-tree"
        data-testid="pad-sidebar-list"
      >
        {indexedTreeItems === null ? <IndexSkeleton /> : null}
        {indexedTreeItems?.length === 0 ? (
          <p className="pad-sidebar-muted">Nothing here yet</p>
        ) : null}
        {indexedTreeItems === null
          ? null
          : tree.getItems().map((item) => {
              const data = item.getItemData();
              const itemProps = item.getProps();
              return (
                <div
                  {...itemProps}
                  className="pad-tree-item"
                  data-tree-kind={data.kind}
                  data-tree-id={treeItemId(data)}
                  style={{ marginInlineStart: `${item.getItemMeta().level * 0.75}rem` }}
                  key={item.getId()}
                >
                  {data.kind === "pad" ? renderContainerRow(data.pad) : renderFolder(data, item)}
                </div>
              );
            })}
        <div style={{ display: "none" }} className="pad-tree-drag-line" />
      </div>
    </div>
  );
}
