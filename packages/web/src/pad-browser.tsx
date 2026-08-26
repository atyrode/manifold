import { DragDropProvider } from "@dnd-kit/react";
import { isSortableOperation, useSortable } from "@dnd-kit/react/sortable";
import { Button } from "@excalidraw/excalidraw";
import type { Pad, PadFolder, PadPresence, PadSessionSummary } from "@manifold/protocol";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  createPad,
  createPadFolder,
  deletePad,
  deletePadFolder,
  getPadPresence,
  getPadSessions,
  listPadFolders,
  listPads,
  movePadToFolder,
  renamePad,
  renamePadFolder,
  reorderPads,
  type StoredIdentity,
} from "./api.ts";
import { PadErrorBoundary } from "./error-boundary.tsx";
import { browserPadStorage, chooseInitialPad, forgetPad, rememberPad } from "./pad-memory.ts";
import { PadView } from "./pad-view.tsx";
import { projectLocalPresence } from "./presence-projection.ts";
import {
  MachinesSection,
  WorkspaceSessionRow,
  WorkspaceStatus,
  type WorkspaceSidebarState,
} from "./top-right.tsx";

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

type PadNavigationEntry =
  | { readonly kind: "pad"; readonly pad: Pad }
  | { readonly kind: "folder"; readonly folder: PadFolder; readonly pads: readonly Pad[] };

function buildPadNavigationEntries(
  pads: readonly Pad[],
  folders: readonly PadFolder[],
): readonly PadNavigationEntry[] {
  const folderByPadId = new Map<string, PadFolder>();
  folders.forEach((folder) => folder.padIds.forEach((padId) => folderByPadId.set(padId, folder)));
  const emittedFolders = new Set<string>();
  const entries: PadNavigationEntry[] = [];
  pads.forEach((pad) => {
    const folder = folderByPadId.get(pad.id);
    if (folder === undefined) {
      entries.push({ kind: "pad", pad });
    } else if (!emittedFolders.has(folder.id)) {
      emittedFolders.add(folder.id);
      entries.push({
        kind: "folder",
        folder,
        pads: pads.filter((candidate) => folder.padIds.includes(candidate.id)),
      });
    }
  });
  folders.forEach((folder) => {
    if (!emittedFolders.has(folder.id)) entries.push({ kind: "folder", folder, pads: [] });
  });
  return entries;
}

interface SortablePadShellProps {
  readonly id: string;
  readonly index: number;
  readonly group: string;
  readonly disabled: boolean;
  readonly name: string;
  readonly children: ReactNode;
}

function SortablePadShell({ id, index, group, disabled, name, children }: SortablePadShellProps) {
  const { ref, handleRef, isDragging, isDropTarget } = useSortable({
    id,
    index,
    group,
    disabled,
    transition: { duration: 160, easing: "ease" },
  });
  return (
    <div
      ref={ref}
      className={`pad-sortable${isDragging ? " is-dragging" : ""}${isDropTarget ? " is-drop-target" : ""}`}
      data-pad-id={id}
    >
      {disabled ? null : (
        <button
          ref={handleRef}
          className="pad-drag-handle"
          type="button"
          aria-label={`Reorder ${name}`}
          title={`Drag or use the keyboard to reorder ${name}`}
        >
          <span aria-hidden="true">⠿</span>
        </button>
      )}
      {children}
    </div>
  );
}

/** One application shell: pad navigation stays mounted beside the active canvas. */
export function PadBrowser({ identity, requestedPadId, navigate }: PadBrowserProps) {
  const [pads, setPads] = useState<Pad[] | null>(null);
  const [folders, setFolders] = useState<readonly PadFolder[] | null>(null);
  const [padSessions, setPadSessions] = useState<readonly PadSessionSummary[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(initialSidebarOpen);
  const [creating, setCreating] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [folderCreateOpen, setFolderCreateOpen] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [deletingFolderId, setDeletingFolderId] = useState<string | null>(null);
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [folderRenameName, setFolderRenameName] = useState("");
  const [confirmFolderDeleteId, setConfirmFolderDeleteId] = useState<string | null>(null);
  const [showSessions, setShowSessions] = useState(initialSessionTree);
  const [sidebarWidth, setSidebarWidth] = useState(initialSidebarWidth);
  const [reordering, setReordering] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [presence, setPresence] = useState<readonly PadPresence[]>([]);
  const [workspace, setWorkspace] = useState<WorkspaceSidebarState | null>(null);
  const [collapsedPresence, setCollapsedPresence] = useState<CollapsedPresencePopover | null>(null);
  const [actionPadId, setActionPadId] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<Pad | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [renameName, setRenameName] = useState("");
  const dragPointerYRef = useRef<number | null>(null);
  const dragTargetsRef = useRef<
    readonly { readonly id: string; readonly top: number; readonly bottom: number }[]
  >([]);
  const [renaming, setRenaming] = useState(false);
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const [memory] = useState(browserPadStorage);

  useEffect(() => {
    let active = true;
    void Promise.all([listPads(identity.token), listPadFolders(identity.token)])
      .then(([nextPads, nextFolders]) => {
        if (!active) return;
        setPads(nextPads);
        setFolders(nextFolders);
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
          if (active) setPadSessions(sessions);
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

  useEffect(() => {
    let active = true;
    const refresh = (): void => {
      void getPadPresence(identity.token)
        .then((nextPresence) => {
          if (active) setPresence(nextPresence);
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
    const trackDragPointer = (event: PointerEvent): void => {
      if (event.buttons !== 0) dragPointerYRef.current = event.clientY;
    };
    document.addEventListener("pointermove", trackDragPointer, { capture: true });
    return () => document.removeEventListener("pointermove", trackDragPointer, { capture: true });
  }, []);

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

  const submit = async (): Promise<void> => {
    const trimmedName = name.trim();
    if (trimmedName.length === 0) return;
    setCreating(true);
    setError(null);
    try {
      const pad = await createPad(identity.token, trimmedName);
      setPads((current) => [...(current ?? []), pad]);
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
      const remaining = (pads ?? []).filter((candidate) => candidate.id !== pad.id);
      setPads(remaining);
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
      setPads((current) => current?.map((pad) => (pad.id === renamed.id ? renamed : pad)) ?? null);
      setRenameTarget(null);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "Could not rename the pad");
    } finally {
      setRenaming(false);
    }
  };

  const submitFolder = async (): Promise<void> => {
    const trimmedName = folderName.trim();
    if (trimmedName.length === 0) return;
    setCreatingFolder(true);
    setError(null);
    try {
      const folder = await createPadFolder(identity.token, trimmedName);
      setFolders((current) => [...(current ?? []), folder]);
      setFolderName("");
      setFolderCreateOpen(false);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "Could not create the folder");
    } finally {
      setCreatingFolder(false);
    }
  };

  const submitFolderRename = async (folder: PadFolder): Promise<void> => {
    const trimmedName = folderRenameName.trim();
    if (trimmedName.length === 0 || trimmedName === folder.name) {
      setRenamingFolderId(null);
      return;
    }
    setError(null);
    try {
      const renamed = await renamePadFolder(identity.token, folder.id, trimmedName);
      setFolders(
        (current) =>
          current?.map((candidate) => (candidate.id === renamed.id ? renamed : candidate)) ?? null,
      );
      setRenamingFolderId(null);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "Could not rename the folder");
    }
  };

  const removeFolder = async (folder: PadFolder): Promise<void> => {
    setDeletingFolderId(folder.id);
    setError(null);
    try {
      await deletePadFolder(identity.token, folder.id);
      setFolders((current) => current?.filter((candidate) => candidate.id !== folder.id) ?? null);
      setConfirmFolderDeleteId(null);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "Could not delete the folder");
    } finally {
      setDeletingFolderId(null);
    }
  };

  const movePad = async (padId: string, folderId: string | null): Promise<void> => {
    const previous = folders;
    setError(null);
    setFolders(
      (current) =>
        current?.map((folder) => ({
          ...folder,
          padIds: [
            ...folder.padIds.filter((candidate) => candidate !== padId),
            ...(folder.id === folderId ? [padId] : []),
          ],
        })) ?? null,
    );
    try {
      await movePadToFolder(identity.token, padId, folderId);
    } catch (reason: unknown) {
      setFolders(previous);
      setError(reason instanceof Error ? reason.message : "Could not move the pad");
    }
  };

  const commitPadOrder = async (sourceId: string, targetId: string): Promise<void> => {
    if (pads === null || sourceId === targetId || reordering) return;
    const sourceIndex = pads.findIndex((pad) => pad.id === sourceId);
    const targetIndex = pads.findIndex((pad) => pad.id === targetId);
    if (sourceIndex < 0 || targetIndex < 0) return;
    const previous = pads;
    const next = [...pads];
    const [moved] = next.splice(sourceIndex, 1);
    if (moved === undefined) return;
    next.splice(targetIndex, 0, moved);
    setPads(next);
    setReordering(true);
    try {
      await reorderPads(
        identity.token,
        next.map((pad) => pad.id),
      );
    } catch (reason: unknown) {
      setPads(previous);
      setError(reason instanceof Error ? reason.message : "Could not reorder pads");
    } finally {
      setReordering(false);
    }
  };

  const groupPadWithTarget = async (sourceId: string, targetId: string): Promise<void> => {
    if (pads === null || folders === null || sourceId === targetId || reordering) return;
    const targetFolder = folders.find((folder) => folder.padIds.includes(targetId)) ?? null;
    const sourceFolder = folders.find((folder) => folder.padIds.includes(sourceId)) ?? null;
    if (targetFolder !== null) {
      if (sourceFolder?.id === targetFolder.id) {
        await commitPadOrder(sourceId, targetId);
      } else {
        await movePad(sourceId, targetFolder.id);
      }
      return;
    }

    const previous = folders;
    const groupedIds = [sourceId, targetId].sort(
      (left, right) =>
        pads.findIndex((pad) => pad.id === left) - pads.findIndex((pad) => pad.id === right),
    );
    setReordering(true);
    setError(null);
    try {
      const folder = await createPadFolder(identity.token, "New folder", groupedIds);
      setFolders((current) => [
        ...(current ?? []).map((candidate) => ({
          ...candidate,
          padIds: candidate.padIds.filter((padId) => !groupedIds.includes(padId)),
        })),
        folder,
      ]);
      setRenamingFolderId(folder.id);
      setFolderRenameName(folder.name);
    } catch (reason: unknown) {
      setFolders(previous);
      setError(reason instanceof Error ? reason.message : "Could not group the pads");
    } finally {
      setReordering(false);
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
  const navigationEntries = pads === null ? [] : buildPadNavigationEntries(pads, folders ?? []);
  const navigationPads = navigationEntries.flatMap((entry) =>
    entry.kind === "pad" ? [entry.pad] : entry.pads,
  );
  const renderPad = (pad: Pad, groupIndex: number, folderId: string | null): ReactNode => {
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
    const sortableDisabled =
      !sidebarOpen || reordering || renameTarget?.id === pad.id || confirmDeleteId === pad.id;

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
          <Button
            className="pad-sidebar-inline-action is-primary"
            aria-label={`Save name for ${pad.name}`}
            title="Save"
            disabled={renaming || renameName.trim() === "" || renameName.trim() === pad.name}
            onSelect={() => void submitRename()}
          >
            <span aria-hidden="true">✓</span>
          </Button>
          <Button
            className="pad-sidebar-inline-action"
            aria-label={`Cancel renaming ${pad.name}`}
            title="Cancel"
            disabled={renaming}
            onSelect={() => setRenameTarget(null)}
          >
            <span aria-hidden="true">×</span>
          </Button>
        </div>
      );
    } else if (sidebarOpen && confirmDeleteId === pad.id) {
      row = (
        <div className={`pad-sidebar-row is-confirming${active ? " is-active" : ""}`}>
          <span className="pad-sidebar-confirm-label">Delete “{pad.name}”?</span>
          <Button
            className="pad-sidebar-confirm-delete"
            disabled={deletingId !== null}
            onSelect={() => void remove(pad)}
          >
            {deletingId === pad.id ? "Deleting…" : "Delete"}
          </Button>
          <Button
            className="pad-sidebar-confirm-cancel"
            disabled={deletingId !== null}
            onSelect={() => setConfirmDeleteId(null)}
          >
            Cancel
          </Button>
        </div>
      );
    } else {
      row = (
        <div className={`pad-sidebar-row${active ? " is-active" : ""}`}>
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
              <Button
                className="pad-sidebar-delete"
                title={`Pad actions for ${pad.name}`}
                aria-label={`Pad actions for ${pad.name}`}
                selected={actionPadId === pad.id}
                onSelect={() => setActionPadId((current) => (current === pad.id ? null : pad.id))}
              >
                <span aria-hidden="true">•••</span>
              </Button>
              {actionPadId === pad.id ? (
                <div className="pad-sidebar-action-menu" role="menu">
                  <Button role="menuitem" onSelect={() => openRename(pad)}>
                    Rename
                  </Button>
                  <label className="pad-sidebar-folder-picker">
                    <span>Folder</span>
                    <select
                      value={folderId ?? ""}
                      onChange={(event) => {
                        setActionPadId(null);
                        void movePad(pad.id, event.currentTarget.value || null);
                      }}
                    >
                      <option value="">No folder</option>
                      {folders?.map((folder) => (
                        <option value={folder.id} key={folder.id}>
                          {folder.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <Button
                    className="is-danger"
                    role="menuitem"
                    disabled={deletingId !== null}
                    onSelect={() => {
                      setActionPadId(null);
                      setConfirmDeleteId(pad.id);
                    }}
                  >
                    Delete
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      );
    }

    return (
      <SortablePadShell
        id={pad.id}
        index={pads?.findIndex((candidate) => candidate.id === pad.id) ?? groupIndex}
        group="pads"
        disabled={sortableDisabled}
        name={pad.name}
        key={pad.id}
      >
        {row}
        {sidebarOpen && showSessions && activeWorkspace?.status === "open"
          ? activeWorkspace.rows.map((session) => (
              <div className="pad-sidebar-session" key={session.id}>
                <WorkspaceSessionRow
                  row={session}
                  onFocus={activeWorkspace.onFocus}
                  onKill={activeWorkspace.onKill}
                  onRestore={activeWorkspace.onRestore}
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
      </SortablePadShell>
    );
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
        <aside className="pad-sidebar" aria-label="Pads">
          <header className="pad-sidebar-header">
            <span className="pad-sidebar-brand" aria-label="manifold">
              <span className="pad-sidebar-mark">M</span>
              {sidebarOpen ? <strong>manifold</strong> : null}
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

          {sidebarOpen && workspace !== null ? (
            <div className="workspace-sidebar workspace-machines">
              <MachinesSection
                machines={workspace.machines}
                onCreateTerminal={workspace.onCreateTerminal}
              />
            </div>
          ) : null}

          {sidebarOpen ? (
            <div className="pad-sidebar-section-heading">
              <strong>Pads</strong>
              <span>{pads?.length ?? 0}</span>
              <Button
                className="pad-sidebar-section-action"
                selected={showSessions}
                title={showSessions ? "Hide sessions under pads" : "Show sessions under pads"}
                aria-label={showSessions ? "Hide pad session tree" : "Show pad session tree"}
                onSelect={() => {
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
              </Button>
              <Button
                className="pad-sidebar-section-action"
                title="New folder"
                aria-label="New pad folder"
                onSelect={() => setFolderCreateOpen(true)}
              >
                <span aria-hidden="true">+</span>
              </Button>
            </div>
          ) : null}

          {sidebarOpen && folderCreateOpen ? (
            <form
              className="pad-sidebar-create pad-sidebar-folder-create"
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
                  onClick={() => setFolderCreateOpen(false)}
                  disabled={creatingFolder}
                >
                  Cancel
                </button>
                <button type="submit" disabled={creatingFolder || folderName.trim() === ""}>
                  {creatingFolder ? "Creating…" : "Create"}
                </button>
              </div>
            </form>
          ) : null}

          <DragDropProvider
            onDragStart={() => {
              dragPointerYRef.current = null;
              dragTargetsRef.current = [
                ...document.querySelectorAll<HTMLElement>(".pad-sortable[data-pad-id]"),
              ].flatMap((sortable) => {
                const row = sortable.querySelector(".pad-sidebar-row");
                const id = sortable.dataset.padId;
                if (row === null || id === undefined) return [];
                const bounds = row.getBoundingClientRect();
                return [{ id, top: bounds.top, bottom: bounds.bottom }];
              });
            }}
            onDragEnd={(event) => {
              const pointerY = dragPointerYRef.current;
              const pointerTarget =
                pointerY === null
                  ? null
                  : (dragTargetsRef.current.find(
                      (target) => pointerY >= target.top && pointerY <= target.bottom,
                    ) ?? null);
              dragPointerYRef.current = null;
              dragTargetsRef.current = [];
              if (event.canceled || !isSortableOperation(event.operation)) return;
              const source = event.operation.source;
              if (source === null) return;
              const targetPad =
                pointerTarget === null
                  ? navigationPads[source.index]
                  : navigationPads.find((pad) => pad.id === pointerTarget.id);
              if (targetPad === undefined || targetPad.id === source.id) return;
              const sourceId = String(source.id);
              const centerDrop =
                pointerY !== null &&
                pointerTarget !== null &&
                pointerY >= pointerTarget.top + (pointerTarget.bottom - pointerTarget.top) * 0.25 &&
                pointerY <=
                  pointerTarget.bottom - (pointerTarget.bottom - pointerTarget.top) * 0.25;
              if (centerDrop) {
                void groupPadWithTarget(sourceId, targetPad.id);
              } else {
                void commitPadOrder(sourceId, targetPad.id);
              }
            }}
          >
            <div className="pad-sidebar-list" data-testid="pad-sidebar-list">
              {sidebarOpen && pads === null ? (
                <p className="pad-sidebar-muted">Loading pads…</p>
              ) : null}
              {sidebarOpen && pads?.length === 0 ? (
                <p className="pad-sidebar-muted">No pads yet</p>
              ) : null}
              {(() => {
                if (pads === null) return null;
                if (!sidebarOpen) {
                  return pads.map((pad, index) => renderPad(pad, index, null));
                }

                return navigationEntries.map((entry) => {
                  if (entry.kind === "pad") {
                    return renderPad(
                      entry.pad,
                      navigationPads.findIndex((pad) => pad.id === entry.pad.id),
                      null,
                    );
                  }
                  const folder = entry.folder;
                  const folderPads = entry.pads;
                  return (
                    <details className="pad-sidebar-folder" open key={folder.id}>
                      <summary>
                        <span className="pad-sidebar-folder-icon" aria-hidden="true" />
                        <strong>{folder.name}</strong>
                        <span>{folderPads.length}</span>
                      </summary>
                      <div className="pad-sidebar-folder-content">
                        {folderPads.length === 0 ? (
                          <span className="pad-sidebar-folder-empty">
                            Drag pads here or use their ••• menu
                          </span>
                        ) : (
                          folderPads.map((pad) =>
                            renderPad(
                              pad,
                              navigationPads.findIndex((candidate) => candidate.id === pad.id),
                              folder.id,
                            ),
                          )
                        )}
                        <div className="pad-sidebar-folder-actions">
                          {renamingFolderId === folder.id ? (
                            <form
                              onSubmit={(event) => {
                                event.preventDefault();
                                void submitFolderRename(folder);
                              }}
                            >
                              <input
                                value={folderRenameName}
                                maxLength={120}
                                aria-label={`Rename folder ${folder.name}`}
                                autoFocus
                                onFocus={(event) => event.currentTarget.select()}
                                onChange={(event) => setFolderRenameName(event.currentTarget.value)}
                                onKeyDown={(event) => {
                                  if (event.key === "Escape") setRenamingFolderId(null);
                                }}
                              />
                              <button type="submit" disabled={folderRenameName.trim() === ""}>
                                Save
                              </button>
                              <Button onSelect={() => setRenamingFolderId(null)}>Cancel</Button>
                            </form>
                          ) : deletingFolderId === folder.id ? (
                            <span>Deleting…</span>
                          ) : confirmFolderDeleteId === folder.id ? (
                            <>
                              <span>Keep pads, delete folder?</span>
                              <Button
                                className="is-danger"
                                onSelect={() => void removeFolder(folder)}
                              >
                                Delete
                              </Button>
                              <Button onSelect={() => setConfirmFolderDeleteId(null)}>
                                Cancel
                              </Button>
                            </>
                          ) : (
                            <>
                              <Button
                                onSelect={() => {
                                  setRenamingFolderId(folder.id);
                                  setFolderRenameName(folder.name);
                                }}
                              >
                                Rename
                              </Button>
                              <Button
                                className="is-danger"
                                title={`Delete ${folder.name}; pads become ungrouped`}
                                onSelect={() => setConfirmFolderDeleteId(folder.id)}
                              >
                                Delete
                              </Button>
                            </>
                          )}
                        </div>
                      </div>
                    </details>
                  );
                });
              })()}
            </div>
          </DragDropProvider>

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
              <PadView
                padId={requestedPadId}
                identity={identity}
                onWorkspaceChange={setWorkspace}
              />
            </PadErrorBoundary>
          )}
        </section>
      </main>
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
