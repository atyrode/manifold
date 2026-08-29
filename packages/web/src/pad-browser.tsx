import {
  dragAndDropFeature,
  hotkeysCoreFeature,
  isOrderedDragTarget,
  keyboardDragAndDropFeature,
  syncDataLoaderFeature,
  type ItemInstance,
  type TreeInstance,
} from "@headless-tree/core";
import type {
  Pad,
  PadPresence,
  PadSessionSummary,
  PadTreeItem,
  TerminalPoolEntry,
} from "@manifold/protocol";
import {
  useCallback,
  useEffect,
  useRef,
  useMemo,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  bindTerminal,
  createPad,
  createPadFolder,
  deletePad,
  deletePadFolder,
  getPadPresence,
  getPadSessions,
  killPooledTerminal,
  listPadTree,
  listTerminals,
  movePadTreeItem,
  moveTerminalPool,
  renamePad,
  renamePadFolder,
  renameTerminal,
  type StoredIdentity,
} from "./api.ts";
import { parseChangelogReferences } from "./changelog-references.ts";
import { PadErrorBoundary } from "./error-boundary.tsx";
import { browserPadStorage, chooseInitialPad, forgetPad, rememberPad } from "./pad-memory.ts";
import { FlowPadView } from "./flow-pad-view.tsx";
import { projectLocalPresence } from "./presence-projection.ts";
import { buildPadTree, projectPadTreeMove, treeItemId, type PadTreeNode } from "./pad-tree.ts";
import {
  MachinesSection,
  WorkspaceSessionRow,
  WorkspaceStatus,
  type WorkspaceSidebarState,
} from "./top-right.tsx";
import { TerminalPoolSection, TERMINAL_DRAG_MIME } from "./terminal-pool.tsx";
import {
  initialCollapsedSections,
  initialSectionOrder,
  rememberCollapsedSections,
  rememberSectionOrder,
  SidebarSection,
  useSectionStackDrag,
  type CollapsedSections,
  type SidebarSectionId,
} from "./sidebar-section.tsx";
import { WEB_CHANGELOG, WEB_VERSION_LABEL } from "./web-version.ts";
import { useHeadlessTree } from "./use-headless-tree.ts";

function renderChangelogChange(change: string): ReactNode {
  return parseChangelogReferences(change).map((part, index) =>
    part.kind === "text" ? (
      part.text
    ) : (
      <a
        key={`${part.href}-${index}`}
        href={part.href}
        target="_blank"
        rel="noreferrer"
        aria-label={`${part.text} on GitHub`}
      >
        {part.text}
      </a>
    ),
  );
}

interface NavigateOptions {
  readonly replace?: boolean;
}

interface PadBrowserProps {
  readonly identity: StoredIdentity;
  readonly requestedPadId: string | null;
  readonly navigate: (path: string, options?: NavigateOptions) => void;
}
interface CollapsedPresencePopover {
  readonly padId: string;
  readonly top: number;
  readonly left: number;
}

function SidebarIcon({ kind }: { readonly kind: "collapse" | "expand" | "plus" }) {
  if (kind === "plus") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 5v14M5 12h14" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
      <path d={kind === "collapse" ? "m15 9-3 3 3 3" : "m13 9 3 3-3 3"} />
    </svg>
  );
}
function initials(name: string): string {
  return [...name][0]?.toUpperCase() ?? "?";
}

function initialSidebarOpen(): boolean {
  try {
    return window.localStorage.getItem("manifold:sidebar-collapsed") !== "true";
  } catch {
    return true;
  }
}
const DEFAULT_SIDEBAR_WIDTH = 280;
const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 480;
const SIDEBAR_ROOT_ITEM: PadTreeItem = {
  kind: "folder",
  id: "__sidebar_root__",
  name: "Pads",
  createdAt: 0,
  parentId: null,
  sortOrder: -1,
};

/** Icon rail: only the pad tree survives, so its container never leaves the pad section. */
const COLLAPSED_RAIL_SECTIONS: readonly SidebarSectionId[] = ["pads"];

function initialSidebarWidth(): number {
  try {
    const raw = window.localStorage.getItem("manifold:sidebar-width");
    if (raw === null) return DEFAULT_SIDEBAR_WIDTH;
    const stored = Number(raw);
    return Number.isFinite(stored)
      ? Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, stored))
      : DEFAULT_SIDEBAR_WIDTH;
  } catch {
    return DEFAULT_SIDEBAR_WIDTH;
  }
}
function rememberSidebarWidth(width: number): void {
  try {
    window.localStorage.setItem("manifold:sidebar-width", String(width));
  } catch {
    // Sidebar memory is optional.
  }
}

function initialSessionTree(): boolean {
  try {
    return window.localStorage.getItem("manifold:show-pad-sessions") === "true";
  } catch {
    return false;
  }
}

/** One application shell: pad navigation stays mounted beside the active canvas. */
export function PadBrowser({ identity, requestedPadId, navigate }: PadBrowserProps) {
  const [treeItems, setTreeItems] = useState<readonly PadTreeItem[] | null>(null);
  const pads = useMemo(
    () =>
      treeItems === null
        ? null
        : treeItems
            .filter((item): item is Extract<PadTreeItem, { kind: "pad" }> => item.kind === "pad")
            .map((item) => item.pad),
    [treeItems],
  );
  const [padSessions, setPadSessions] = useState<readonly PadSessionSummary[]>([]);
  const [poolTerminals, setPoolTerminals] = useState<readonly TerminalPoolEntry[]>([]);
  const [terminalDropPadId, setTerminalDropPadId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(initialSidebarOpen);
  const [creating, setCreating] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [folderCreateParentId, setFolderCreateParentId] = useState<string | null | undefined>();
  const [folderName, setFolderName] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [deletingFolderId, setDeletingFolderId] = useState<string | null>(null);
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [folderRenameName, setFolderRenameName] = useState("");
  const [confirmFolderDeleteId, setConfirmFolderDeleteId] = useState<string | null>(null);
  const [showSessions, setShowSessions] = useState(initialSessionTree);
  const [sidebarWidth, setSidebarWidth] = useState(initialSidebarWidth);
  const [sectionOrder, setSectionOrder] =
    useState<readonly SidebarSectionId[]>(initialSectionOrder);
  // Destructured because the rule tracking ref reads taints every member access on an
  // object holding one; separate bindings keep the render-safe pieces render-usable.
  const {
    stackRef: sectionStackRef,
    reordering: sectionReordering,
    stackProps: sectionStackProps,
    dragProps: sectionDragProps,
  } = useSectionStackDrag(sectionOrder, (next) => {
    setSectionOrder(next);
    rememberSectionOrder(next);
  });
  const [collapsedSections, setCollapsedSections] =
    useState<CollapsedSections>(initialCollapsedSections);
  const reorderingRef = useRef(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [, renderTreeState] = useState(0);
  const dndFrameRef = useRef<number | null>(null);
  const treeInstanceRef = useRef<TreeInstance<PadTreeItem> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [presence, setPresence] = useState<readonly PadPresence[]>([]);
  const [workspace, setWorkspace] = useState<WorkspaceSidebarState | null>(null);
  const [collapsedPresence, setCollapsedPresence] = useState<CollapsedPresencePopover | null>(null);
  const [actionPadId, setActionPadId] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<Pad | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [renameName, setRenameName] = useState("");
  const [initialExpandedItems] = useState<string[]>(() => {
    try {
      const stored: unknown = JSON.parse(
        window.localStorage.getItem("manifold:expanded-pad-folders") ?? "[]",
      );
      return Array.isArray(stored)
        ? stored.filter((id): id is string => typeof id === "string")
        : [];
    } catch {
      return [];
    }
  });
  const [renaming, setRenaming] = useState(false);
  const [changelogOpen, setChangelogOpen] = useState(false);
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const versionButtonRef = useRef<HTMLButtonElement | null>(null);
  const changelogDialogRef = useRef<HTMLDialogElement | null>(null);
  const sidebarRef = useRef<HTMLElement | null>(null);
  const [memory] = useState(browserPadStorage);

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
        "manifold:expanded-pad-folders",
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
    let active = true;
    void listPadTree(identity.token)
      .then((items) => {
        if (active) setTreeItems(items);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : "Could not load pads");
      });
    return () => {
      active = false;
    };
  }, [identity.token]);

  useEffect(() => {
    let active = true;
    const refresh = (): void => {
      void getPadSessions(identity.token)
        .then((sessions) => {
          if (active && treeInstanceRef.current?.getState().dnd == null) {
            setPadSessions(sessions);
          }
        })
        .catch(() => {
          // Session inventory keeps its last successful snapshot across transient failures.
        });
    };
    refresh();
    const interval = window.setInterval(refresh, 2_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [identity.token]);

  const refreshPool = useCallback((): void => {
    void listTerminals(identity.token)
      .then((terminals) => setPoolTerminals(terminals))
      .catch(() => {
        // The parked pool keeps its last successful snapshot across transient failures.
      });
  }, [identity.token]);

  /** Park and bind move sessions in and out of the active pad, so its row count is the pool signal. */
  const activeSessionCount = workspace?.status === "open" ? workspace.rows.length : null;

  useEffect(() => {
    refreshPool();
    const interval = window.setInterval(refreshPool, 2_000);
    return () => {
      window.clearInterval(interval);
    };
  }, [activeSessionCount, refreshPool]);

  const killPooled = useCallback(
    (sessionId: string): void => {
      void killPooledTerminal(identity.token, sessionId)
        .catch((reason: unknown) => {
          // A 409 means the session already died; the refetch below settles the row either way.
          console.error("evt=pool_terminal_kill_failed", reason);
        })
        .finally(refreshPool);
    },
    [identity.token, refreshPool],
  );

  const renamePooled = useCallback(
    async (sessionId: string, name: string): Promise<void> => {
      try {
        await renameTerminal(identity.token, sessionId, name);
        setError(null);
      } catch (reason: unknown) {
        setError(reason instanceof Error ? reason.message : "Could not rename the terminal");
        throw reason;
      } finally {
        refreshPool();
      }
    },
    [identity.token, refreshPool],
  );

  const movePooled = useCallback(
    async (sessionId: string, index: number): Promise<void> => {
      try {
        setPoolTerminals(await moveTerminalPool(identity.token, sessionId, index));
        setError(null);
      } catch (reason: unknown) {
        setError(reason instanceof Error ? reason.message : "Could not reorder the terminal");
        refreshPool();
        throw reason;
      }
    },
    [identity.token, refreshPool],
  );

  const acceptsTerminalDrag = (transfer: DataTransfer): boolean =>
    transfer.types.includes(TERMINAL_DRAG_MIME);

  /** Pad rows accept pooled terminals only; every other drag falls through to headless-tree. */
  const terminalDropProps = (padId: string) => ({
    onDragOver: (event: ReactDragEvent<HTMLDivElement>): void => {
      if (!acceptsTerminalDrag(event.dataTransfer)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      setTerminalDropPadId(padId);
    },
    onDragLeave: (event: ReactDragEvent<HTMLDivElement>): void => {
      if (!acceptsTerminalDrag(event.dataTransfer)) return;
      setTerminalDropPadId((current) => (current === padId ? null : current));
    },
    onDrop: (event: ReactDragEvent<HTMLDivElement>): void => {
      if (!acceptsTerminalDrag(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      setTerminalDropPadId(null);
      const sessionId = event.dataTransfer.getData(TERMINAL_DRAG_MIME);
      if (sessionId === "") return;
      void bindTerminal(identity.token, sessionId, padId)
        .catch((reason: unknown) => {
          console.error("evt=terminal_bind_failed", reason);
        })
        .finally(refreshPool);
    },
  });

  useEffect(() => {
    let active = true;
    const refresh = (): void => {
      void getPadPresence(identity.token)
        .then((nextPresence) => {
          if (active && treeInstanceRef.current?.getState().dnd == null) {
            setPresence(nextPresence);
          }
        })
        .catch(() => {
          // Presence is ephemeral; keep the last successful snapshot.
        });
    };
    refresh();
    const interval = window.setInterval(refresh, 1_500);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [identity.token, requestedPadId]);

  useEffect(() => {
    if (pads === null) return;
    if (requestedPadId !== null) {
      if (pads.some((pad) => pad.id === requestedPadId)) {
        rememberPad(memory, identity.principal.id, requestedPadId);
      }
      return;
    }
    const initialPad = chooseInitialPad(memory, identity.principal.id, pads);
    if (initialPad !== null) {
      navigate(`/p/${encodeURIComponent(initialPad.id)}`, { replace: true });
    }
  }, [identity.principal.id, memory, navigate, pads, requestedPadId]);

  useEffect(() => {
    if (createOpen) nameInputRef.current?.focus();
  }, [createOpen]);
  useEffect(() => {
    if (actionPadId === null) return;
    const closeMenu = (event: PointerEvent): void => {
      if (
        event.target instanceof Element &&
        event.target.closest(".pad-sidebar-actions") !== null
      ) {
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

  useEffect(() => {
    if (!changelogOpen) return;
    const dialog = changelogDialogRef.current;
    if (dialog !== null && !dialog.open) dialog.showModal();
  }, [changelogOpen]);

  useEffect(() => {
    if (renameTarget === null) return;
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [renameTarget]);

  const setOpen = (open: boolean): void => {
    setSidebarOpen(open);
    if (open) setCollapsedPresence(null);
    try {
      window.localStorage.setItem("manifold:sidebar-collapsed", String(!open));
    } catch {
      // Sidebar memory is optional.
    }
  };

  const toggleSection = (id: SidebarSectionId, collapsed: boolean): void => {
    // The icon rail force-opens the pad section; that is layout, not a user collapse choice.
    if (!sidebarOpen) return;
    setCollapsedSections((current) => {
      if (current[id] === collapsed) return current;
      const next = { ...current, [id]: collapsed };
      rememberCollapsedSections(next);
      return next;
    });
  };

  const submit = async (): Promise<void> => {
    const trimmedName = name.trim();
    if (trimmedName.length === 0) return;
    setCreating(true);
    setError(null);
    try {
      const pad = await createPad(identity.token, trimmedName);
      setTreeItems(await listPadTree(identity.token));
      setName("");
      setCreateOpen(false);
      rememberPad(memory, identity.principal.id, pad.id);
      navigate(`/p/${encodeURIComponent(pad.id)}`);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "Could not create the pad");
    } finally {
      setCreating(false);
    }
  };

  const remove = async (pad: Pad): Promise<void> => {
    setDeletingId(pad.id);
    setError(null);
    try {
      await deletePad(identity.token, pad.id);
      const nextTree = await listPadTree(identity.token);
      const remaining = nextTree
        .filter((item): item is Extract<PadTreeItem, { kind: "pad" }> => item.kind === "pad")
        .map((item) => item.pad);
      setTreeItems(nextTree);
      forgetPad(memory, identity.principal.id, pad.id);
      if (requestedPadId === pad.id) {
        const deletedIndex = (pads ?? []).findIndex((candidate) => candidate.id === pad.id);
        const fallback = remaining[Math.min(deletedIndex, remaining.length - 1)] ?? null;
        if (fallback === null) {
          navigate("/", { replace: true });
        } else {
          rememberPad(memory, identity.principal.id, fallback.id);
          navigate(`/p/${encodeURIComponent(fallback.id)}`, { replace: true });
        }
      }
      setConfirmDeleteId(null);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "Could not delete the pad");
    } finally {
      setDeletingId(null);
    }
  };

  const openRename = (pad: Pad): void => {
    setActionPadId(null);
    setRenameTarget(pad);
    setRenameName(pad.name);
  };

  const submitRename = async (): Promise<void> => {
    if (renameTarget === null) return;
    const trimmedName = renameName.trim();
    if (trimmedName.length === 0 || trimmedName === renameTarget.name) {
      setRenameTarget(null);
      return;
    }
    setRenaming(true);
    setError(null);
    try {
      const renamed = await renamePad(identity.token, renameTarget.id, trimmedName);
      setTreeItems(
        (current) =>
          current?.map((item) =>
            item.kind === "pad" && item.pad.id === renamed.id ? { ...item, pad: renamed } : item,
          ) ?? null,
      );
      setRenameTarget(null);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "Could not rename the pad");
    } finally {
      setRenaming(false);
    }
  };

  const submitFolder = async (): Promise<void> => {
    const trimmedName = folderName.trim();
    if (trimmedName.length === 0 || folderCreateParentId === undefined) return;
    setCreatingFolder(true);
    setError(null);
    try {
      const nextTree = await createPadFolder(identity.token, trimmedName, folderCreateParentId);
      setTreeItems(nextTree);
      if (folderCreateParentId !== null) {
        tree.getItemInstance(`folder:${folderCreateParentId}`).expand();
        renderSettledTreeState();
      }
      setFolderName("");
      setFolderCreateParentId(undefined);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "Could not create the folder");
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
    setError(null);
    try {
      setTreeItems(await renamePadFolder(identity.token, folder.id, trimmedName));
      setRenamingFolderId(null);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "Could not rename the folder");
    }
  };

  const removeFolder = async (folder: Extract<PadTreeItem, { kind: "folder" }>): Promise<void> => {
    setDeletingFolderId(folder.id);
    setError(null);
    try {
      setTreeItems(await deletePadFolder(identity.token, folder.id));
      setConfirmFolderDeleteId(null);
      setRenamingFolderId(null);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "Could not delete the folder");
    } finally {
      setDeletingFolderId(null);
    }
  };

  const beginSidebarResize = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (!sidebarOpen || event.button !== 0) return;
    event.preventDefault();
    const move = (pointer: PointerEvent): void => {
      const max = Math.min(MAX_SIDEBAR_WIDTH, window.innerWidth - 320);
      setSidebarWidth(Math.max(MIN_SIDEBAR_WIDTH, Math.min(max, pointer.clientX)));
    };
    const finish = (pointer: PointerEvent): void => {
      move(pointer);
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", finish);
      const max = Math.min(MAX_SIDEBAR_WIDTH, window.innerWidth - 320);
      const width = Math.max(MIN_SIDEBAR_WIDTH, Math.min(max, pointer.clientX));
      rememberSidebarWidth(width);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", finish);
  };

  const selectPad = (pad: Pad): void => {
    rememberPad(memory, identity.principal.id, pad.id);
    navigate(`/p/${encodeURIComponent(pad.id)}`);
  };
  const displayedPresence = projectLocalPresence(presence, identity.principal, requestedPadId);
  const treeData = useMemo(() => {
    const data = new Map<string, { item: PadTreeItem; children: string[] }>();
    const roots = buildPadTree(treeItems ?? []);
    const addNodes = (nodes: readonly PadTreeNode[]): string[] =>
      nodes.map((node) => {
        const id = `${node.item.kind}:${treeItemId(node.item)}`;
        data.set(id, { item: node.item, children: addNodes(node.children) });
        return id;
      });
    data.set("root", { item: SIDEBAR_ROOT_ITEM, children: addNodes(roots) });
    return data;
  }, [treeItems]);
  const treeDataRef = useRef(treeData);
  const tree = useHeadlessTree<PadTreeItem>({
    initialState: { expandedItems: initialExpandedItems },
    // Core owns drag targeting; this paints its state without routing ItemInstance objects
    // through React, which tears down the tree during native drags in React 19.
    setDndState: scheduleDndPresentation,
    rootItemId: "root",
    getItemName: (item) => {
      const data = item.getItemData();
      return item.getId() === "root" ? "Pads" : data.kind === "pad" ? data.pad.name : data.name;
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
      return data.kind === "pad"
        ? renameTarget?.id !== data.pad.id && confirmDeleteId !== data.pad.id
        : renamingFolderId !== data.id && confirmFolderDeleteId !== data.id;
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
      const index = isOrderedDragTarget(target)
        ? target.insertionIndex
        : (treeDataRef.current.get(target.item.getId())?.children.length ?? 0);
      const item = { kind: moved.kind, id: treeItemId(moved) } as const;
      const previousTreeItems = treeItems;
      const optimisticTreeItems = projectPadTreeMove(treeItems, item, parentId, index);
      const request = movePadTreeItem(identity.token, item, parentId, index).then(
        (nextTreeItems) => ({ ok: true, nextTreeItems }) as const,
        (reason: unknown) => ({ ok: false, reason }) as const,
      );

      reorderingRef.current = true;
      // Headless Tree clears native DnD state after onDrop returns. Paint the local
      // projection in the following task, then reconcile with the server response.
      window.setTimeout(() => {
        setError(null);
        setTreeItems(optimisticTreeItems);
        void request.then((outcome) => {
          if (outcome.ok) {
            setTreeItems(outcome.nextTreeItems);
          } else {
            setTreeItems(previousTreeItems);
            setError(
              outcome.reason instanceof Error
                ? outcome.reason.message
                : "Could not move the sidebar item",
            );
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

  const renderPad = (pad: Pad): ReactNode => {
    const active = pad.id === requestedPadId;
    const principals = displayedPresence.find((entry) => entry.padId === pad.id)?.principals ?? [];
    const otherPrincipals = principals.filter(
      (principal) => principal.id !== identity.principal.id,
    );
    const visiblePrincipals = principals.slice(0, 3);
    const summaries = padSessions.filter((session) => session.padId === pad.id);
    const activeWorkspace = active ? workspace : null;
    const liveRows = activeWorkspace?.status === "open" ? activeWorkspace.rows : null;
    const displayedSessions = liveRows ?? summaries;
    const runningCount = displayedSessions.filter((session) => session.status === "running").length;

    let row: ReactNode;
    if (sidebarOpen && renameTarget?.id === pad.id) {
      row = (
        <div className={`pad-sidebar-row is-editing${active ? " is-active" : ""}`}>
          <span className="pad-sidebar-pad-mark" aria-hidden="true" />
          <input
            ref={renameInputRef}
            className="pad-sidebar-rename-input"
            aria-label={`Rename ${pad.name}`}
            maxLength={120}
            value={renameName}
            disabled={renaming}
            onChange={(event) => setRenameName(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submitRename();
              if (event.key === "Escape") setRenameTarget(null);
            }}
          />
          <button
            className="pad-sidebar-inline-action is-primary"
            aria-label={`Save name for ${pad.name}`}
            title="Save"
            disabled={renaming || renameName.trim() === "" || renameName.trim() === pad.name}
            onClick={() => void submitRename()}
          >
            <span aria-hidden="true">✓</span>
          </button>
          <button
            className="pad-sidebar-inline-action"
            aria-label={`Cancel renaming ${pad.name}`}
            title="Cancel"
            disabled={renaming}
            onClick={() => setRenameTarget(null)}
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
      );
    } else if (sidebarOpen && confirmDeleteId === pad.id) {
      row = (
        <div className={`pad-sidebar-row is-confirming${active ? " is-active" : ""}`}>
          <span className="pad-sidebar-confirm-label">Delete “{pad.name}”?</span>
          <button
            className="pad-sidebar-confirm-delete"
            aria-label={`Confirm deleting ${pad.name}`}
            disabled={deletingId !== null}
            onClick={() => void remove(pad)}
          >
            {deletingId === pad.id ? "Deleting…" : "Delete"}
          </button>
          <button
            className="pad-sidebar-confirm-cancel"
            aria-label={`Cancel deleting ${pad.name}`}
            disabled={deletingId !== null}
            onClick={() => setConfirmDeleteId(null)}
          >
            Cancel
          </button>
        </div>
      );
    } else {
      row = (
        <div
          className={`pad-sidebar-row${active ? " is-active" : ""}${terminalDropPadId === pad.id ? " pad-sidebar-row--terminal-target" : ""}`}
          {...terminalDropProps(pad.id)}
        >
          <button
            className="pad-sidebar-link"
            type="button"
            title={pad.name}
            aria-label={`Open pad ${pad.name}`}
            aria-current={active ? "page" : undefined}
            onClick={() => selectPad(pad)}
          >
            <span className="pad-sidebar-pad-mark" aria-hidden="true" />
            {sidebarOpen ? <span className="pad-sidebar-pad-name">{pad.name}</span> : null}
            {sidebarOpen && runningCount > 0 ? (
              <span
                className="pad-sidebar-session-count"
                title={`${runningCount} open ${runningCount === 1 ? "session" : "sessions"}`}
              >
                {runningCount}
              </span>
            ) : null}
            {sidebarOpen && principals.length > 0 ? (
              <span
                className="pad-sidebar-presence"
                aria-label={`${principals.length} present on ${pad.name}`}
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
          {!sidebarOpen && otherPrincipals.length > 0 ? (
            <button
              className="pad-sidebar-collapsed-presence"
              type="button"
              aria-label={`${otherPrincipals.length} other ${otherPrincipals.length === 1 ? "participant" : "participants"} on ${pad.name}`}
              aria-describedby={
                collapsedPresence?.padId === pad.id ? "collapsed-presence-popover" : undefined
              }
              onPointerEnter={(event) => {
                const bounds = event.currentTarget.getBoundingClientRect();
                setCollapsedPresence({ padId: pad.id, top: bounds.top, left: bounds.right + 8 });
              }}
              onPointerLeave={() => setCollapsedPresence(null)}
              onFocus={(event) => {
                const bounds = event.currentTarget.getBoundingClientRect();
                setCollapsedPresence({ padId: pad.id, top: bounds.top, left: bounds.right + 8 });
              }}
              onBlur={() => setCollapsedPresence(null)}
            >
              +{otherPrincipals.length}
            </button>
          ) : null}
          {sidebarOpen ? (
            <div className="pad-sidebar-actions">
              <button
                className="pad-sidebar-delete"
                title={`Pad actions for ${pad.name}`}
                aria-label={`Pad actions for ${pad.name}`}
                aria-pressed={actionPadId === pad.id}
                onClick={() => setActionPadId((current) => (current === pad.id ? null : pad.id))}
              >
                <span aria-hidden="true">•••</span>
              </button>
              {actionPadId === pad.id ? (
                <div className="pad-sidebar-action-menu" role="menu">
                  <button role="menuitem" onClick={() => openRename(pad)}>
                    Rename
                  </button>
                  <button
                    className="is-danger"
                    role="menuitem"
                    disabled={deletingId !== null}
                    onClick={() => {
                      setActionPadId(null);
                      setConfirmDeleteId(pad.id);
                    }}
                  >
                    Delete
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      );
    }

    return (
      <>
        {row}
        {sidebarOpen && showSessions && activeWorkspace?.status === "open"
          ? activeWorkspace.rows.map((session) => (
              <div className="pad-sidebar-session" key={session.id}>
                <WorkspaceSessionRow
                  row={session}
                  onFocus={activeWorkspace.onFocus}
                  onKill={activeWorkspace.onKill}
                  onRemoveCopy={activeWorkspace.onRemoveCopy}
                  onRemoveAllCopies={activeWorkspace.onRemoveAllCopies}
                  onHighlight={activeWorkspace.onHighlight}
                />
              </div>
            ))
          : null}
        {sidebarOpen && showSessions && activeWorkspace?.status !== "open"
          ? summaries.map((session) => {
              const machine = workspace?.machines?.find(
                (candidate) => candidate.id === session.machineId,
              );
              return (
                <button
                  className={`pad-sidebar-session is-summary${session.status === "exited" ? " is-exited" : ""}`}
                  type="button"
                  onClick={() => selectPad(pad)}
                  key={session.id}
                >
                  <span aria-hidden="true">{session.status === "running" ? "●" : "○"}</span>
                  <span>{machine?.name ?? session.machineId}</span>
                  <small>{session.status}</small>
                </button>
              );
            })
          : null}
      </>
    );
  };

  const renderFolderCreateForm = (nested: boolean): ReactNode => (
    <form
      className={`pad-sidebar-create pad-sidebar-folder-create${nested ? " is-nested" : ""}`}
      onSubmit={(event) => {
        event.preventDefault();
        void submitFolder();
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
        <button
          type="button"
          onClick={() => setFolderCreateParentId(undefined)}
          disabled={creatingFolder}
        >
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
    if (!sidebarOpen) {
      return (
        <div className="pad-sidebar-row">
          <button
            className="pad-sidebar-link"
            type="button"
            title={folder.name}
            aria-label={`${item.isExpanded() ? "Collapse" : "Expand"} folder ${folder.name}`}
            onClick={(event) => {
              event.stopPropagation();
              if (item.isExpanded()) item.collapse();
              else item.expand();
              renderSettledTreeState();
            }}
          >
            <span className="pad-sidebar-folder-icon" aria-hidden="true" />
          </button>
        </div>
      );
    }
    if (renamingFolderId === folder.id) {
      return (
        <div className="pad-sidebar-row is-editing">
          <span className="pad-sidebar-folder-icon" aria-hidden="true" />
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
            aria-label={`Save name for ${folder.name}`}
            disabled={folderRenameName.trim() === ""}
            onClick={() => void submitFolderRename(folder)}
          >
            <span aria-hidden="true">✓</span>
          </button>
          <button
            className="pad-sidebar-inline-action"
            aria-label={`Cancel renaming ${folder.name}`}
            onClick={() => setRenamingFolderId(null)}
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
      );
    }
    if (confirmFolderDeleteId === folder.id) {
      return (
        <div className="pad-sidebar-row is-confirming">
          <span className="pad-sidebar-confirm-label">Delete folder? Children move up.</span>
          <button
            className="pad-sidebar-confirm-delete"
            aria-label={`Confirm deleting folder ${folder.name}`}
            disabled={deletingFolderId === folder.id}
            onClick={() => void removeFolder(folder)}
          >
            {deletingFolderId === folder.id ? "Deleting…" : "Delete"}
          </button>
          <button
            className="pad-sidebar-confirm-cancel"
            aria-label={`Cancel deleting folder ${folder.name}`}
            disabled={deletingFolderId === folder.id}
            onClick={() => setConfirmFolderDeleteId(null)}
          >
            Cancel
          </button>
        </div>
      );
    }
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
              {item.isExpanded() ? "⌄" : "›"}
            </span>
            <span className="pad-sidebar-folder-icon" aria-hidden="true" />
            <strong>{folder.name}</strong>
          </button>
          <div className="pad-sidebar-actions" onClick={(event) => event.stopPropagation()}>
            <button
              className="pad-sidebar-folder-add"
              title={`New folder inside ${folder.name}`}
              aria-label={`New folder inside ${folder.name}`}
              onClick={() => {
                setFolderName("");
                setFolderCreateParentId(folder.id);
              }}
            >
              <span aria-hidden="true">+</span>
            </button>
            <button
              className="pad-sidebar-delete"
              title={`Folder actions for ${folder.name}`}
              aria-label={`Folder actions for ${folder.name}`}
              aria-pressed={actionPadId === actionId}
              onClick={() => setActionPadId((current) => (current === actionId ? null : actionId))}
            >
              <span aria-hidden="true">•••</span>
            </button>
            {actionPadId === actionId ? (
              <div className="pad-sidebar-action-menu" role="menu">
                <button
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
                  role="menuitem"
                  onClick={() => {
                    setActionPadId(null);
                    setConfirmFolderDeleteId(folder.id);
                  }}
                >
                  Delete
                </button>
              </div>
            ) : null}
          </div>
        </div>
        {folderCreateParentId === folder.id ? renderFolderCreateForm(true) : null}
      </>
    );
  };

  const padTreeBody = (
    <div
      {...tree.getContainerProps()}
      className="pad-sidebar-list pad-sidebar-tree"
      data-testid="pad-sidebar-list"
    >
      {sidebarOpen && treeItems === null ? (
        <p className="pad-sidebar-muted">Loading pads…</p>
      ) : null}
      {sidebarOpen && treeItems?.length === 0 ? (
        <p className="pad-sidebar-muted">No pads yet</p>
      ) : null}
      {treeItems === null
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
                style={
                  sidebarOpen
                    ? { marginInlineStart: `${item.getItemMeta().level * 0.75}rem` }
                    : undefined
                }
                key={item.getId()}
              >
                {data.kind === "pad" ? renderPad(data.pad) : renderFolder(data, item)}
              </div>
            );
          })}
      <div style={{ display: "none" }} className="pad-tree-drag-line" />
    </div>
  );

  /**
   * One shell per section, ordered by the user's stack. Collapsing the sidebar keeps only the
   * pad section mounted (header hidden by CSS) so the tree container never reparents.
   */
  const renderSidebarSection = (section: SidebarSectionId): ReactNode => {
    if (section === "machines") {
      if (workspace === null) return null;
      const machines = workspace.machines;
      const online = machines?.filter((machine) => machine.online).length ?? 0;
      return (
        <SidebarSection
          id="machines"
          title="Machines"
          testId="machines-section"
          count={`${online}/${machines?.length ?? 0} online`}
          collapsed={collapsedSections.machines === true}
          onCollapsedChange={toggleSection}
          {...sectionDragProps("machines")}
          key="machines"
        >
          <div className="workspace-sidebar workspace-machines">
            <MachinesSection machines={machines} onCreateTerminal={workspace.onCreateTerminal} />
          </div>
        </SidebarSection>
      );
    }
    if (section === "pads") {
      return (
        <SidebarSection
          id="pads"
          title="Pads"
          testId="pads-section"
          count={pads?.length ?? 0}
          collapsed={sidebarOpen && collapsedSections.pads === true}
          grow
          actions={
            sidebarOpen ? (
              <button
                className="pad-sidebar-section-action"
                aria-pressed={showSessions}
                title={showSessions ? "Hide sessions under pads" : "Show sessions under pads"}
                aria-label={showSessions ? "Hide pad session tree" : "Show pad session tree"}
                onClick={(event) => {
                  // Inside the disclosure header: never toggle the section on an action click.
                  event.preventDefault();
                  event.stopPropagation();
                  setShowSessions((current) => {
                    try {
                      window.localStorage.setItem("manifold:show-pad-sessions", String(!current));
                    } catch {
                      // Session tree memory is optional.
                    }
                    return !current;
                  });
                }}
              >
                <span aria-hidden="true">⌘</span>
              </button>
            ) : undefined
          }
          onCollapsedChange={toggleSection}
          {...sectionDragProps("pads")}
          key="pads"
        >
          {sidebarOpen && folderCreateParentId === null ? renderFolderCreateForm(false) : null}
          {padTreeBody}
        </SidebarSection>
      );
    }
    if (section === "terminals") {
      return (
        <SidebarSection
          id="terminals"
          title="Terminals"
          testId="terminals-section"
          count={poolTerminals.length}
          collapsed={collapsedSections.terminals === true}
          onCollapsedChange={toggleSection}
          {...sectionDragProps("terminals")}
          key="terminals"
        >
          <TerminalPoolSection
            terminals={poolTerminals}
            machines={workspace?.machines ?? []}
            onKill={killPooled}
            onRename={renamePooled}
            onMove={movePooled}
          />
        </SidebarSection>
      );
    }
    // "views" is a reserved slot in the stored order until the first view exists.
    return null;
  };

  const collapsedPresencePrincipals =
    collapsedPresence === null
      ? []
      : (
          displayedPresence.find((entry) => entry.padId === collapsedPresence.padId)?.principals ??
          []
        ).filter((principal) => principal.id !== identity.principal.id);

  return (
    <>
      <main
        className={`pad-browser${sidebarOpen ? "" : " is-collapsed"}`}
        style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
      >
        <aside className="pad-sidebar" aria-label="Pads" ref={sidebarRef}>
          <header className="pad-sidebar-header">
            <span className="pad-sidebar-brand">
              <span className="pad-sidebar-mark" aria-hidden="true">
                M
              </span>
              {sidebarOpen ? (
                <span className="pad-sidebar-brand-copy">
                  <strong>manifold</strong>
                  <button
                    ref={versionButtonRef}
                    className="pad-sidebar-version"
                    type="button"
                    aria-label={`Open web changelog for ${WEB_VERSION_LABEL}`}
                    onClick={() => setChangelogOpen(true)}
                  >
                    {WEB_VERSION_LABEL}
                  </button>
                </span>
              ) : null}
            </span>
            <button
              className="pad-sidebar-icon-button"
              type="button"
              title={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
              aria-label={sidebarOpen ? "Collapse pad sidebar" : "Expand pad sidebar"}
              onClick={() => setOpen(!sidebarOpen)}
            >
              <SidebarIcon kind={sidebarOpen ? "collapse" : "expand"} />
            </button>
          </header>

          <div className="pad-sidebar-create-buttons">
            <button
              className="pad-sidebar-new"
              type="button"
              title="New pad"
              aria-label="New pad"
              onClick={() => {
                if (!sidebarOpen) setOpen(true);
                setCreateOpen(true);
              }}
            >
              <SidebarIcon kind="plus" />
              {sidebarOpen ? <span>New pad</span> : null}
            </button>
            <button
              className="pad-sidebar-new pad-sidebar-new-folder"
              type="button"
              title="New folder"
              aria-label="New folder"
              onClick={() => {
                if (!sidebarOpen) setOpen(true);
                setFolderName("");
                setFolderCreateParentId(null);
              }}
            >
              <span className="pad-sidebar-folder-icon" aria-hidden="true" />
              {sidebarOpen ? <span>New folder</span> : null}
            </button>
          </div>

          {sidebarOpen && createOpen ? (
            <form
              className="pad-sidebar-create"
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <input
                ref={nameInputRef}
                maxLength={120}
                value={name}
                onChange={(event) => setName(event.currentTarget.value)}
                placeholder="Pad name"
                aria-label="Pad name"
                disabled={creating}
              />
              <div>
                <button type="button" onClick={() => setCreateOpen(false)} disabled={creating}>
                  Cancel
                </button>
                <button type="submit" disabled={creating || name.trim() === ""}>
                  {creating ? "Creating…" : "Create"}
                </button>
              </div>
            </form>
          ) : null}

          <div
            ref={sectionStackRef}
            className={`pad-sidebar-sections${sectionReordering ? " is-reordering" : ""}`}
            {...sectionStackProps}
          >
            {(sidebarOpen ? sectionOrder : COLLAPSED_RAIL_SECTIONS).map(renderSidebarSection)}
          </div>

          {sidebarOpen && workspace !== null ? (
            <WorkspaceStatus
              status={workspace.status}
              savedAt={workspace.savedAt}
              rev={workspace.rev}
            />
          ) : null}

          {sidebarOpen && error !== null ? <p className="pad-sidebar-error">{error}</p> : null}
          <footer className="pad-sidebar-identity" title={identity.principal.name}>
            <span className="identity-dot" style={{ backgroundColor: identity.principal.color }} />
            {sidebarOpen ? <span>{identity.principal.name}</span> : null}
          </footer>
        </aside>
        {sidebarOpen ? (
          <button
            className="pad-sidebar-resize"
            type="button"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize pad sidebar"
            aria-valuemin={MIN_SIDEBAR_WIDTH}
            aria-valuemax={MAX_SIDEBAR_WIDTH}
            aria-valuenow={Math.round(sidebarWidth)}
            onPointerDown={beginSidebarResize}
            onDoubleClick={() => {
              setSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
              rememberSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
            }}
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              event.preventDefault();
              const delta = event.key === "ArrowLeft" ? -16 : 16;
              setSidebarWidth((current) => {
                const next = Math.max(
                  MIN_SIDEBAR_WIDTH,
                  Math.min(MAX_SIDEBAR_WIDTH, current + delta),
                );
                rememberSidebarWidth(next);
                return next;
              });
            }}
          />
        ) : null}

        <section className="pad-browser-canvas" aria-label="Active pad">
          {requestedPadId === null ? (
            <div className="pad-browser-empty">
              {pads === null ? (
                <p>Loading your workspace…</p>
              ) : pads.length === 0 ? (
                <>
                  <span className="pad-browser-empty-mark">M</span>
                  <h1>Your canvas starts here</h1>
                  <p>Create a pad from the sidebar to begin.</p>
                  <button
                    className="primary-button"
                    type="button"
                    onClick={() => {
                      setOpen(true);
                      setCreateOpen(true);
                    }}
                  >
                    Create your first pad
                  </button>
                </>
              ) : null}
            </div>
          ) : (
            <PadErrorBoundary key={requestedPadId}>
              <FlowPadView
                padId={requestedPadId}
                identity={identity}
                onWorkspaceChange={setWorkspace}
                isOverSidebar={(clientX, clientY) => {
                  const bounds = sidebarRef.current?.getBoundingClientRect();
                  return (
                    bounds !== undefined &&
                    clientX >= bounds.left &&
                    clientX <= bounds.right &&
                    clientY >= bounds.top &&
                    clientY <= bounds.bottom
                  );
                }}
              />
            </PadErrorBoundary>
          )}
        </section>
      </main>
      {typeof document !== "undefined" && changelogOpen
        ? createPortal(
            <dialog
              ref={changelogDialogRef}
              className="web-changelog-dialog"
              aria-labelledby="web-changelog-title"
              onCancel={(event) => {
                event.preventDefault();
                setChangelogOpen(false);
                window.requestAnimationFrame(() => versionButtonRef.current?.focus());
              }}
              onPointerDown={(event) => {
                if (event.target !== event.currentTarget) return;
                setChangelogOpen(false);
                window.requestAnimationFrame(() => versionButtonRef.current?.focus());
              }}
            >
              <section className="web-changelog-card">
                <header>
                  <div>
                    <span>Web application</span>
                    <h2 id="web-changelog-title">What’s new</h2>
                    <code>{WEB_VERSION_LABEL}</code>
                  </div>
                  <button
                    type="button"
                    aria-label="Close changelog"
                    onClick={() => {
                      setChangelogOpen(false);
                      window.requestAnimationFrame(() => versionButtonRef.current?.focus());
                    }}
                  >
                    ×
                  </button>
                </header>
                <div className="web-changelog-releases">
                  {WEB_CHANGELOG.map((release) => (
                    <article key={release.version}>
                      <div>
                        <h3>Version {release.version}</h3>
                        <time dateTime={release.date}>{release.date}</time>
                      </div>
                      <ul>
                        {release.changes.map((change) => (
                          <li key={change}>{renderChangelogChange(change)}</li>
                        ))}
                      </ul>
                    </article>
                  ))}
                </div>
              </section>
            </dialog>,
            document.body,
          )
        : null}
      {typeof document !== "undefined" &&
      collapsedPresence !== null &&
      collapsedPresencePrincipals.length > 0
        ? createPortal(
            <div
              id="collapsed-presence-popover"
              className="collapsed-presence-popover"
              role="tooltip"
              style={{ top: collapsedPresence.top, left: collapsedPresence.left }}
            >
              {collapsedPresencePrincipals.map((principal) => (
                <div className="collapsed-presence-popover-row" key={principal.id}>
                  <span
                    className={`presence-avatar${principal.kind === "agent" ? " is-agent" : ""}`}
                    style={{ backgroundColor: principal.color }}
                  >
                    {initials(principal.name)}
                  </span>
                  <span>
                    <strong>{principal.name}</strong>
                    <small>{principal.kind}</small>
                  </span>
                </div>
              ))}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
