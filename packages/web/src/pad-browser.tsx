import { Button } from "@excalidraw/excalidraw";
import type { Pad, PadPresence } from "@manifold/protocol";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  createPad,
  deletePad,
  getPadPresence,
  listPads,
  renamePad,
  type StoredIdentity,
} from "./api.ts";
import { PadErrorBoundary } from "./error-boundary.tsx";
import { browserPadStorage, chooseInitialPad, forgetPad, rememberPad } from "./pad-memory.ts";
import { PadView } from "./pad-view.tsx";
import { WorkspacePanel, type WorkspacePanelProps } from "./top-right.tsx";

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

/** One application shell: pad navigation stays mounted beside the active canvas. */
export function PadBrowser({ identity, requestedPadId, navigate }: PadBrowserProps) {
  const [pads, setPads] = useState<Pad[] | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(initialSidebarOpen);
  const [creating, setCreating] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [presence, setPresence] = useState<readonly PadPresence[]>([]);
  const [workspace, setWorkspace] = useState<WorkspacePanelProps | null>(null);
  const [collapsedPresence, setCollapsedPresence] = useState<CollapsedPresencePopover | null>(null);
  const [actionPadId, setActionPadId] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<Pad | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [renameName, setRenameName] = useState("");
  const [renaming, setRenaming] = useState(false);
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const [memory] = useState(browserPadStorage);

  useEffect(() => {
    let active = true;
    void listPads(identity.token)
      .then((nextPads) => {
        if (active) setPads(nextPads);
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
      void getPadPresence(identity.token)
        .then((nextPresence) => {
          if (active) setPresence(nextPresence);
        })
        .catch(() => {
          // Presence is ephemeral; keep the last successful snapshot.
        });
    };
    refresh();
    const interval = window.setInterval(refresh, 3_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [identity.token]);

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

  const selectPad = (pad: Pad): void => {
    rememberPad(memory, identity.principal.id, pad.id);
    navigate(`/p/${encodeURIComponent(pad.id)}`);
  };
  const collapsedPresencePrincipals =
    collapsedPresence === null
      ? []
      : (
          presence.find((entry) => entry.padId === collapsedPresence.padId)?.principals ?? []
        ).filter((principal) => principal.id !== identity.principal.id);

  return (
    <>
      <main className={`pad-browser${sidebarOpen ? "" : " is-collapsed"}`}>
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

          <div className="pad-sidebar-list" data-testid="pad-sidebar-list">
            {sidebarOpen && pads === null ? (
              <p className="pad-sidebar-muted">Loading pads…</p>
            ) : null}
            {sidebarOpen && pads?.length === 0 ? (
              <p className="pad-sidebar-muted">No pads yet</p>
            ) : null}
            {pads?.map((pad) => {
              const active = pad.id === requestedPadId;
              const principals = presence.find((entry) => entry.padId === pad.id)?.principals ?? [];
              const otherPrincipals = principals.filter(
                (principal) => principal.id !== identity.principal.id,
              );
              const visiblePrincipals = principals.slice(0, 3);
              if (sidebarOpen && renameTarget?.id === pad.id) {
                return (
                  <div
                    className={`pad-sidebar-row is-editing${active ? " is-active" : ""}`}
                    key={pad.id}
                  >
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
                      disabled={
                        renaming || renameName.trim() === "" || renameName.trim() === pad.name
                      }
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
              }
              if (sidebarOpen && confirmDeleteId === pad.id) {
                return (
                  <div
                    className={`pad-sidebar-row is-confirming${active ? " is-active" : ""}`}
                    key={pad.id}
                  >
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
              }
              return (
                <div className={`pad-sidebar-row${active ? " is-active" : ""}`} key={pad.id}>
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
                        collapsedPresence?.padId === pad.id
                          ? "collapsed-presence-popover"
                          : undefined
                      }
                      onPointerEnter={(event) => {
                        const bounds = event.currentTarget.getBoundingClientRect();
                        setCollapsedPresence({
                          padId: pad.id,
                          top: bounds.top,
                          left: bounds.right + 8,
                        });
                      }}
                      onPointerLeave={() => setCollapsedPresence(null)}
                      onFocus={(event) => {
                        const bounds = event.currentTarget.getBoundingClientRect();
                        setCollapsedPresence({
                          padId: pad.id,
                          top: bounds.top,
                          left: bounds.right + 8,
                        });
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
                        onSelect={() =>
                          setActionPadId((current) => (current === pad.id ? null : pad.id))
                        }
                      >
                        <span aria-hidden="true">•••</span>
                      </Button>
                      {actionPadId === pad.id ? (
                        <div className="pad-sidebar-action-menu" role="menu">
                          <Button role="menuitem" onSelect={() => openRename(pad)}>
                            Rename
                          </Button>
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
            })}
          </div>
          {sidebarOpen && workspace !== null ? (
            <WorkspacePanel key={requestedPadId} {...workspace} />
          ) : null}

          {sidebarOpen && error !== null ? <p className="pad-sidebar-error">{error}</p> : null}
          <footer className="pad-sidebar-identity" title={identity.principal.name}>
            <span className="identity-dot" style={{ backgroundColor: identity.principal.color }} />
            {sidebarOpen ? <span>{identity.principal.name}</span> : null}
          </footer>
        </aside>

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
