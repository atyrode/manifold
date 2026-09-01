import {
  arrangedSectionIds,
  movedSectionIds,
  type ComposedBinding,
  type PanelProps,
  type SectionProps,
} from "@manifold/plugin";
import {
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { parseChangelogReferences } from "./changelog-references.ts";
import {
  Cluster,
  ControlIcon,
  Disclosure,
  ItemIcon,
  ScrollRegion,
  Stack,
  useVantage,
} from "@manifold/plugin/ui";
import { PluginPlaceholder, useAssembly, type WebSection } from "./plugin-host.tsx";
import { useWorkspaceShell } from "./workspace.tsx";
import type { WorkspaceSidebarState } from "@manifold/plugin/hooks";
import { WEB_CHANGELOG, WEB_VERSION_LABEL } from "./web-version.ts";

/**
 * The `core.shell.sidebar` panel — FLOOR, and deliberately so.
 *
 * The sidebar's CHROME (branding, the create affordances, the collapse control, the section
 * stack itself) is the workspace shell, not a contribution: it has to read the composition to
 * know which sections exist, and `useAssembly` is engine state a plugin may not touch. The
 * manifest still owns the vocabulary — `core.shell` declares this panel, the roster publishes
 * it, and a disabled shell renders a named placeholder like any other panel — so what lives
 * here is the component, never the declaration. It is attached to the manifest's `sidebar`
 * id in `assembly.ts`, the one web file allowed to name plugin packages.
 *
 * Everything BELOW the stack is a real plugin: each section is a `ComponentType<SectionProps>`
 * that fetches its own data through `host.client`. The stack knows only the order the
 * manifests declared and whether the owning plugin is enabled.
 */

/** Ambient connection and persistence state; intentionally compact and visually quiet. */
function WorkspaceStatus({
  status,
  savedAt,
  rev,
}: Pick<WorkspaceSidebarState, "status" | "savedAt" | "rev">) {
  const savedLabel = savedAt === null ? "Not saved yet" : new Date(savedAt).toLocaleTimeString();
  const statusLabel = status.charAt(0).toUpperCase() + status.slice(1);
  return (
    <div
      className="sidebar-status"
      title={`Connection ${status} · ${savedLabel} · revision ${rev}`}
      role="status"
      data-testid="connection-status"
    >
      <span className={`status-dot ${status}`} aria-hidden="true" />
      <span>
        <strong data-testid="connection-state">{statusLabel}</strong>
        <small>
          {savedAt === null ? "Not saved" : `Saved ${savedLabel}`} · rev {rev}
        </small>
      </span>
    </div>
  );
}

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

/** Per-section disclosure state. Device-LOCAL and in-memory: see the module note below. */
type CollapsedSections = Readonly<Record<string, boolean>>;

/** One live section grab: what is held, and the order the stack is showing because of it. */
interface SectionGrab {
  readonly moved: string;
  readonly order: readonly string[];
}

/**
 * Which section the pointer is over, read off the live stack by geometry.
 *
 * By RECT rather than by hit-testing, and that is forced rather than preferred: arrange mode
 * puts `pointer-events: none` on the pane content it disarms, and `elementFromPoint` skips
 * exactly the elements that opted out of the pointer — so the one obvious way to ask this
 * question returns nothing while the mode that needs the answer is on. Sections already carry
 * `data-section-id` for the gate's own queries, so the stack names itself and there is no ref
 * plumbing to keep in step with the order it is describing.
 */
function sectionIdAt(clientY: number): string | null {
  for (const element of document.querySelectorAll<HTMLElement>("[data-section-id]")) {
    const box = element.getBoundingClientRect();
    if (clientY >= box.top && clientY <= box.bottom) return element.dataset["sectionId"] ?? null;
  }
  return null;
}

interface SectionShellProps {
  readonly section: WebSection;
  /** The stack's height absorber and its icon-rail occupant; see {@link SidebarPanel}. */
  readonly grow: boolean;
  readonly collapsed: boolean;
  readonly onCollapsedChange: (id: string, collapsed: boolean) => void;
  readonly host: SectionProps["host"];
  readonly pluginTitle: string;
  /** Arrange mode is armed: this section is grabbable and nothing inside it is clickable. */
  readonly arranging: boolean;
  /** This is the section in hand right now. */
  readonly grabbed: boolean;
  readonly onGrab: (id: string, event: ReactPointerEvent<HTMLElement>) => void;
  readonly onGrabMove: (id: string, event: ReactPointerEvent<HTMLElement>) => void;
  readonly onGrabEnd: (id: string, event: ReactPointerEvent<HTMLElement>) => void;
  /** Keyboard arrangement: one slot up or down, committed immediately. */
  readonly onNudge: (id: string, delta: -1 | 1) => void;
}

/**
 * One shell for every section: a disclosure header over a scrollable body. The header is the
 * engine's one {@link Disclosure} — it carries the button role, `aria-expanded` and
 * `data-state` for free, and keeps a collapsed body's content in the DOM exactly as the
 * native `<details>` it replaced did, so a folded section's feeds survive the fold. The
 * body is the engine's one {@link ScrollRegion}: each section scrolls ITSELF, vertically
 * only — horizontal overflow is refused by contract, which is what obliges every label in a
 * section to declare ellipsis or wrap.
 *
 * A section supplies no header count and no header actions any more: a plugin renders its own
 * body and nothing else, so anything it wants to say about itself it says inside that body.
 */
function SectionShell({
  section,
  grow,
  collapsed,
  onCollapsedChange,
  host,
  pluginTitle,
  arranging,
  grabbed,
  onGrab,
  onGrabMove,
  onGrabEnd,
  onNudge,
}: SectionShellProps): ReactElement {
  const Component: ComponentType<SectionProps> | null = section.Component;
  return (
    <Disclosure
      className={`sidebar-section${grow ? " sidebar-section--grow" : ""}${
        grabbed ? " sidebar-section--grabbed" : ""
      }`}
      data-testid={`${section.id}-section`}
      data-section-id={section.id}
      data-plugin={section.plugin}
      open={!collapsed}
      onOpenChange={(open) => onCollapsedChange(section.id, !open)}
      headerClassName="sidebar-section-header"
      bodyClassName="sidebar-section-body"
      /*
        Arranging by KEYBOARD, on the section's own root: the arrow keys bubble up from the
        focused header, so the mode is operable without a pointer and the nudge goes through
        the very same policy function and the very same commit door the drag does. A mode
        reachable only by dragging would be a mode half the operators cannot use.
      */
      onKeyDown={
        arranging
          ? (event) => {
              const delta = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : null;
              if (delta === null) return;
              event.preventDefault();
              onNudge(section.id, delta);
            }
          : undefined
      }
      header={
        <>
          {/*
            THE GRAB SURFACE. It covers the whole section rather than a corner handle, because
            the mode's promise is that the section IS the thing you are holding — and covering
            it is also what stops the disclosure from folding under a grab, since the pointer
            never reaches the toggle underneath. It lives in the header slot for want of a
            sibling slot on the disclosure and positions against the section itself, which is
            what `.workspace.is-arranging .sidebar-section { position: relative }` is for.

            `aria-hidden` and no tab stop: the keyboard route is the arrow keys above, so this
            never becomes an interactive descendant of the header button.
          */}
          {arranging ? (
            <span
              className="sidebar-section-grip"
              aria-hidden="true"
              onPointerDown={(event) => onGrab(section.id, event)}
              onPointerMove={(event) => onGrabMove(section.id, event)}
              onPointerUp={(event) => onGrabEnd(section.id, event)}
              onPointerCancel={(event) => onGrabEnd(section.id, event)}
            >
              <ControlIcon kind="grip" size={14} />
            </span>
          ) : null}
          <span className="sidebar-section-chevron" aria-hidden="true">
            <ControlIcon kind="collapsed" size={13} />
          </span>
          <strong className="sidebar-section-title">{section.title}</strong>
        </>
      }
    >
      <ScrollRegion className="sidebar-section-scroll">
        {Component === null ? (
          <PluginPlaceholder name={pluginTitle} state="unavailable" />
        ) : (
          <Component host={host} />
        )}
      </ScrollRegion>
    </Disclosure>
  );
}

/**
 * THE KEY TABLE, as a reader sees it: every binding the composition composed, with the key, what
 * it does and which plugin owns it.
 *
 * It prints the registry rather than a hand-kept list, which is the whole point of declaring
 * keys: a plugin that ships a binding appears here for free, a disabled plugin's rows are gone
 * because composition dropped them, and a key nobody declared cannot be listed — it also cannot
 * be dispatched. Scope is shown only when a row narrows it: "canvas" beside a row that only
 * answers on a canvas is information, and "always" beside eleven rows is noise.
 */
function BindingsTable({
  bindings,
  pluginTitle,
}: {
  readonly bindings: readonly ComposedBinding[];
  readonly pluginTitle: (plugin: string) => string;
}): ReactElement {
  return (
    <Stack gap="0.5rem">
      {bindings.length === 0 ? (
        <p className="sidebar-bindings-empty">No plugin claims a key in this workspace.</p>
      ) : (
        bindings.map((binding) => (
          <Cluster key={binding.id} justify="space-between" gap="0.75rem">
            <span className="sidebar-bindings-label">
              {binding.label}
              <small>
                {pluginTitle(binding.plugin)}
                {binding.when === "always" ? "" : ` · ${binding.when} only`}
              </small>
            </span>
            <kbd className="sidebar-bindings-key">{binding.key}</kbd>
          </Cluster>
        ))
      )}
    </Stack>
  );
}

export function SidebarPanel({ host }: PanelProps): ReactElement {
  const assembly = useAssembly();
  /*
    Every field this panel reads is taken ONCE, here: `registerSidebarElement` is a ref
    callback, and reading further properties off the same object afterwards would be reading
    through a ref during render. The shell hands out plain values; naming them plainly is
    what keeps that true.
  */
  const {
    commitSectionOrder,
    createContainer,
    createFolder,
    creating,
    identity,
    registerSidebarElement,
    sectionOrder,
    setSidebarOpen,
    sidebarOpen,
    workspace,
  } = useWorkspaceShell();
  const { arranging } = useVantage();
  /*
   * Per-section disclosure is in-memory only. The sidebar's four private storage keys are gone
   * with the rest of its device-only state (D13): a section's ORDER now comes from
   * its manifest, its presence from the roster, and its width from the workspace layout —
   * all three observable by every principal. Which sections one tab happened to fold shut is
   * the one piece of that state nobody else can act on, so it is not worth a key, a register
   * entry, or a migration; it lasts as long as the tab does.
   */
  const [collapsedSections, setCollapsedSections] = useState<CollapsedSections>({});
  const [folderName, setFolderName] = useState<string | null>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [changelogOpen, setChangelogOpen] = useState(false);
  const versionButtonRef = useRef<HTMLButtonElement | null>(null);
  const changelogDialogRef = useRef<HTMLDialogElement | null>(null);
  const [bindingsOpen, setBindingsOpen] = useState(false);
  const bindingsButtonRef = useRef<HTMLButtonElement | null>(null);
  const bindingsDialogRef = useRef<HTMLDialogElement | null>(null);
  /**
   * THE SECTION IN HAND, and the order it has dragged the stack into so far.
   *
   * `order` is the WIRE FORM — the exact `readonly string[]` the layout tile stores — and the
   * stack below renders it without knowing whether it came from this pointer or from the
   * server (AGENTS.md invariant 11). That is what makes the live preview and the committed
   * arrangement one derivation instead of a drag path beside a render path.
   *
   * A REF BESIDE THE STATE, for the reason the workspace's layout drag keeps one: the state is
   * what renders, the ref is what the GESTURE reads. A grab writes state and the very next
   * pointer frame arrives before React has re-rendered, so a handler reading the state
   * variable through its closure sees `null` and drops the frame — which is exactly how a
   * quick flick committed nothing at all. The ref is the read; the state is the paint.
   */
  const [grab, setGrab] = useState<SectionGrab | null>(null);
  const grabRef = useRef<SectionGrab | null>(null);
  const holdSection = (next: SectionGrab | null): void => {
    grabRef.current = next;
    setGrab(next);
  };

  // Leaving the mode mid-grab drops what was in hand: the release is the commit, so a
  // gesture that never released must not survive as a pending arrangement. The STATE resets
  // during render (React's derived-state guidance — an effect would paint one stale frame
  // first); the REF resets in an effect, because a ref is for event handlers, and the next
  // pointer frame after leaving the mode must read "nothing in hand".
  if (!arranging && grab !== null) {
    setGrab(null);
  }
  useEffect(() => {
    if (!arranging) grabRef.current = null;
  }, [arranging]);

  useEffect(() => {
    if (!changelogOpen) return;
    const dialog = changelogDialogRef.current;
    if (dialog !== null && !dialog.open) dialog.showModal();
  }, [changelogOpen]);

  useEffect(() => {
    if (!bindingsOpen) return;
    const dialog = bindingsDialogRef.current;
    if (dialog !== null && !dialog.open) dialog.showModal();
  }, [bindingsOpen]);

  const closeChangelog = (): void => {
    setChangelogOpen(false);
    window.requestAnimationFrame(() => versionButtonRef.current?.focus());
  };

  const closeBindings = (): void => {
    setBindingsOpen(false);
    window.requestAnimationFrame(() => bindingsButtonRef.current?.focus());
  };

  const submitFolder = async (name: string): Promise<void> => {
    setCreatingFolder(true);
    try {
      await createFolder(name);
      setFolderName(null);
    } finally {
      setCreatingFolder(false);
    }
  };

  /**
   * WHAT ORDER THE STACK IS IN. Manifest order is the default; this principal's stored
   * arrangement overrides it; a live grab overrides that for as long as it is held. Three
   * inputs, one answer, and the merge itself is the tested policy module rather than
   * arithmetic inlined here (`arrangedSectionIds`, `packages/plugin/src/layout.ts`).
   *
   * The order is computed over EVERY declared section and filtered for enabled afterwards, so
   * a disabled plugin's slot closes without its stored place being forgotten — D4′ (ADR 0013):
   * chrome renders absence, and re-enabling restores the exact seat the principal chose.
   */
  const declaredIds = assembly.sections.map((section) => section.id);
  const arrangedIds = arrangedSectionIds(declaredIds, sectionOrder);
  const liveIds = grab?.order ?? arrangedIds;
  const declared = new Map(assembly.sections.map((section) => [section.id, section]));

  /**
   * The icon rail keeps ONE section mounted, and the stack's leftover height goes to that
   * same one: the section the ORDER puts first — the manifests' choice until the principal
   * makes one. One rule for both, read off the live order rather than a hardcoded id, which
   * is what makes the rail survive a plugin being disabled, added, or rearranged.
   */
  const sections: readonly WebSection[] = liveIds.flatMap((id) => {
    const section = declared.get(id);
    /*
     * D4′ (ADR 0013): chrome renders ABSENCE. A disabled plugin's section VANISHES from the
     * stack, and the Plugins section is the one ledger of what is off. A tombstone here would
     * make the floor look like it cannot exist without the plugin — the smell A1 forbids.
     */
    return section === undefined || !section.enabled ? [] : [section];
  });
  const railSection = sections[0];
  const visible = sidebarOpen ? sections : railSection === undefined ? [] : [railSection];

  /**
   * ONE ACTION PER GESTURE. The drag repaints per frame off `grab.order` and writes nothing;
   * the release compares what is in hand against what is stored and commits once, through the
   * workspace layout door — the plane rule's commit point (AGENTS.md invariant 13).
   */
  const commitIfMoved = (order: readonly string[]): void => {
    const moved =
      order.length !== arrangedIds.length || order.some((id, index) => id !== arrangedIds[index]);
    if (moved) commitSectionOrder(order);
  };

  const grabSection = (id: string, event: ReactPointerEvent<HTMLElement>): void => {
    // The grab surface sits over the disclosure's toggle: swallowing the event here is what
    // keeps a grab from folding the section it is about to move.
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    holdSection({ moved: id, order: arrangedIds });
  };

  const dragSection = (id: string, event: ReactPointerEvent<HTMLElement>): void => {
    const held = grabRef.current;
    if (held === null || held.moved !== id) return;
    const over = sectionIdAt(event.clientY);
    if (over === null) return;
    const next = movedSectionIds(held.order, held.moved, over);
    // Referential identity IS the "nothing moved" answer, so a frame over the section
    // already in hand costs one comparison and no render.
    if (next === held.order) return;
    holdSection({ moved: held.moved, order: next });
  };

  const releaseSection = (id: string, event: ReactPointerEvent<HTMLElement>): void => {
    const held = grabRef.current;
    if (held === null || held.moved !== id) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    commitIfMoved(held.order);
    holdSection(null);
  };

  const nudgeSection = (id: string, delta: -1 | 1): void => {
    const from = arrangedIds.indexOf(id);
    const over = arrangedIds[from + delta];
    if (over === undefined) return;
    commitIfMoved(movedSectionIds(arrangedIds, id, over));
  };

  return (
    <>
      <aside className="sidebar" aria-label="Sidebar" ref={registerSidebarElement}>
        <header className="sidebar-header">
          <span className="sidebar-brand">
            <span className="sidebar-mark" aria-hidden="true">
              M
            </span>
            {sidebarOpen ? (
              <span className="sidebar-brand-copy">
                <strong>manifold</strong>
                <button
                  ref={versionButtonRef}
                  className="sidebar-version"
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
            className="sidebar-icon-button"
            type="button"
            title={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
            aria-label={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
            onClick={() => setSidebarOpen(!sidebarOpen)}
          >
            <ControlIcon kind={sidebarOpen ? "sidebarCollapse" : "sidebarExpand"} />
          </button>
        </header>

        <div className="sidebar-create-buttons">
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
          <button
            className="sidebar-new container-sidebar-new-view"
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
          <button
            className="sidebar-new sidebar-new-folder"
            type="button"
            title="New folder"
            aria-label="New folder"
            onClick={() => {
              if (!sidebarOpen) setSidebarOpen(true);
              setFolderName("");
            }}
          >
            <ItemIcon kind="folder" />
            {sidebarOpen ? <span>New folder</span> : null}
          </button>
        </div>

        {/*
          Top-level folder creation is chrome, beside the button that opens it. It used to be
          rendered inside the Index section, which is no longer the shell's to reach into: the
          section subscribes to the index's node, so the folder's own creation event puts the
          new row there.
        */}
        {sidebarOpen && folderName !== null ? (
          <form
            className="sidebar-create sidebar-folder-create"
            onSubmit={(event) => {
              event.preventDefault();
              const trimmed = folderName.trim();
              if (trimmed === "") return;
              void submitFolder(trimmed);
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
            <Cluster justify="flex-end" gap="0.35rem">
              <button type="button" onClick={() => setFolderName(null)} disabled={creatingFolder}>
                Cancel
              </button>
              <button
                type="submit"
                data-action="core.index.createFolder"
                disabled={creatingFolder || folderName.trim() === ""}
              >
                {creatingFolder ? "Creating…" : "Create"}
              </button>
            </Cluster>
          </form>
        ) : null}

        <Stack className="sidebar-sections" gap="0.4rem">
          {visible.map((section) => (
            <SectionShell
              section={section}
              grow={section === railSection}
              collapsed={sidebarOpen && collapsedSections[section.id] === true}
              onCollapsedChange={(id, collapsed) => {
                // The icon rail force-opens its one section; that is layout, not a choice.
                if (!sidebarOpen) return;
                setCollapsedSections((current) =>
                  current[id] === collapsed ? current : { ...current, [id]: collapsed },
                );
              }}
              host={host}
              pluginTitle={assembly.pluginTitle(section.plugin) ?? section.plugin}
              /*
                The rail is one section and has nothing to reorder against, so arranging is
                offered only while the sidebar is open. The MODE stays on either way — the
                workspace is still armed, the panes still say so.
              */
              arranging={arranging && sidebarOpen}
              grabbed={grab?.moved === section.id}
              onGrab={grabSection}
              onGrabMove={dragSection}
              onGrabEnd={releaseSection}
              onNudge={nudgeSection}
              key={`${section.plugin}.${section.id}`}
            />
          ))}
        </Stack>

        {sidebarOpen && workspace !== null ? (
          <WorkspaceStatus
            status={workspace.status}
            savedAt={workspace.savedAt}
            rev={workspace.rev}
          />
        ) : null}

        {/*
          The key table's door, at the very bottom: the last thing in the rail, beside the
          identity it belongs to. It is chrome over an ENGINE registry — the composed binding
          table — so it lives here for the same reason the section stack does, and it names no
          plugin to do it.
        */}
        <button
          ref={bindingsButtonRef}
          className="sidebar-bindings"
          type="button"
          title="Keyboard bindings"
          aria-label="Show keyboard bindings"
          onClick={() => setBindingsOpen(true)}
        >
          <ControlIcon kind="bindings" />
          {sidebarOpen ? <span>Keys</span> : null}
        </button>

        <footer className="sidebar-identity" title={identity.principal.name}>
          <span className="identity-dot" style={{ backgroundColor: identity.principal.color }} />
          {sidebarOpen ? <span>{identity.principal.name}</span> : null}
        </footer>
      </aside>
      {typeof document !== "undefined" && changelogOpen
        ? createPortal(
            <dialog
              ref={changelogDialogRef}
              className="web-changelog-dialog"
              aria-labelledby="web-changelog-title"
              onCancel={(event) => {
                event.preventDefault();
                closeChangelog();
              }}
              onPointerDown={(event) => {
                if (event.target !== event.currentTarget) return;
                closeChangelog();
              }}
            >
              <section className="web-changelog-card">
                <header>
                  <div>
                    <span>Web application</span>
                    <h2 id="web-changelog-title">What’s new</h2>
                    <code>{WEB_VERSION_LABEL}</code>
                  </div>
                  <button type="button" aria-label="Close changelog" onClick={closeChangelog}>
                    <ControlIcon kind="close" />
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
      {typeof document !== "undefined" && bindingsOpen
        ? createPortal(
            <dialog
              ref={bindingsDialogRef}
              className="sidebar-bindings-dialog"
              aria-labelledby="sidebar-bindings-title"
              onCancel={(event) => {
                event.preventDefault();
                closeBindings();
              }}
              onPointerDown={(event) => {
                if (event.target !== event.currentTarget) return;
                closeBindings();
              }}
            >
              <section className="sidebar-bindings-card">
                <header>
                  <div>
                    <span>Workspace</span>
                    <h2 id="sidebar-bindings-title">Keyboard bindings</h2>
                  </div>
                  <button
                    type="button"
                    aria-label="Close keyboard bindings"
                    onClick={closeBindings}
                  >
                    <ControlIcon kind="close" />
                  </button>
                </header>
                <ScrollRegion className="sidebar-bindings-body">
                  <BindingsTable
                    bindings={assembly.bindings}
                    pluginTitle={(plugin) => assembly.pluginTitle(plugin) ?? plugin}
                  />
                </ScrollRegion>
              </section>
            </dialog>,
            document.body,
          )
        : null}
    </>
  );
}
