import type { PanelProps, SectionProps } from "@manifold/plugin";
import {
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { parseChangelogReferences } from "./changelog-references.ts";
import { ControlIcon, ItemIcon } from "@manifold/plugin/ui";
import { PluginPlaceholder, useComposition, type WebSection } from "./plugin-host.tsx";
import { useWorkspaceShell } from "./pad-browser.tsx";
import type { WorkspaceSidebarState } from "@manifold/plugin/hooks";
import { WEB_CHANGELOG, WEB_VERSION_LABEL } from "./web-version.ts";

/**
 * The `core.shell.sidebar` panel — FLOOR, and deliberately so.
 *
 * The sidebar's CHROME (branding, the create affordances, the collapse control, the section
 * stack itself) is the workspace shell, not a contribution: it has to read the composition to
 * know which sections exist, and `useComposition` is engine state a plugin may not touch. The
 * manifest still owns the vocabulary — `core.shell` declares this panel, the roster publishes
 * it, and a disabled shell renders a named placeholder like any other panel — so what lives
 * here is the component, never the declaration. It is attached to the manifest's `sidebar`
 * id in `composition.ts`, the one web file allowed to name plugin packages.
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
      className="workspace-status"
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

interface SectionShellProps {
  readonly section: WebSection;
  /** The stack's height absorber and its icon-rail occupant; see {@link SidebarPanel}. */
  readonly grow: boolean;
  readonly collapsed: boolean;
  readonly onCollapsedChange: (id: string, collapsed: boolean) => void;
  readonly host: SectionProps["host"];
  readonly pluginTitle: string;
}

/**
 * One shell for every section: a disclosure header over a body. The native `summary` stays
 * the collapse control — it carries the button role and expanded state for free, keeps
 * content in the DOM while collapsed, and holds the chevron marker.
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
}: SectionShellProps): ReactElement {
  const Component: ComponentType<SectionProps> | null = section.Component;
  return (
    <details
      className={`sidebar-section${grow ? " sidebar-section--grow" : ""}`}
      data-testid={`${section.id}-section`}
      data-section-id={section.id}
      data-plugin={section.plugin}
      open={!collapsed}
      onToggle={(event) => onCollapsedChange(section.id, !event.currentTarget.open)}
    >
      <summary className="sidebar-section-header">
        <span className="sidebar-section-chevron" aria-hidden="true">
          <ControlIcon kind="collapsed" size={13} />
        </span>
        <strong className="sidebar-section-title">{section.title}</strong>
      </summary>
      <div className="sidebar-section-body">
        {!section.enabled ? (
          <PluginPlaceholder name={pluginTitle} state="disabled" />
        ) : Component === null ? (
          <PluginPlaceholder name={pluginTitle} state="unavailable" />
        ) : (
          <Component host={host} />
        )}
      </div>
    </details>
  );
}

export function SidebarPanel({ host }: PanelProps): ReactElement {
  const composition = useComposition();
  /*
    Every field this panel reads is taken ONCE, here: `registerSidebarElement` is a ref
    callback, and reading further properties off the same object afterwards would be reading
    through a ref during render. The shell hands out plain values; naming them plainly is
    what keeps that true.
  */
  const {
    createContainer,
    createFolder,
    creating,
    identity,
    registerSidebarElement,
    setSidebarOpen,
    sidebarOpen,
    workspace,
  } = useWorkspaceShell();
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

  useEffect(() => {
    if (!changelogOpen) return;
    const dialog = changelogDialogRef.current;
    if (dialog !== null && !dialog.open) dialog.showModal();
  }, [changelogOpen]);

  const closeChangelog = (): void => {
    setChangelogOpen(false);
    window.requestAnimationFrame(() => versionButtonRef.current?.focus());
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
   * The icon rail keeps ONE section mounted, and the stack's leftover height goes to that
   * same one: the section the manifests ordered first. One rule for both, read off the
   * declared order rather than a hardcoded id — which is what makes the rail survive a
   * plugin being disabled, added, or reordered.
   */
  const sections = composition.sections;
  const railSection = sections[0];
  const visible = sidebarOpen ? sections : railSection === undefined ? [] : [railSection];

  return (
    <>
      <aside className="pad-sidebar" aria-label="Sidebar" ref={registerSidebarElement}>
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
            aria-label={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
            onClick={() => setSidebarOpen(!sidebarOpen)}
          >
            <ControlIcon kind={sidebarOpen ? "sidebarCollapse" : "sidebarExpand"} />
          </button>
        </header>

        <div className="pad-sidebar-create-buttons">
          <button
            className="pad-sidebar-new"
            type="button"
            data-action="core.views.createPad"
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
            className="pad-sidebar-new pad-sidebar-new-view"
            type="button"
            data-action="core.views.createPad"
            title="New composition"
            aria-label="New composition"
            onClick={() => {
              if (!sidebarOpen) setSidebarOpen(true);
              createContainer("tiled");
            }}
            disabled={creating}
          >
            <ItemIcon kind="composition" />
            {sidebarOpen ? <span>New composition</span> : null}
          </button>
          <button
            className="pad-sidebar-new pad-sidebar-new-folder"
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
          rendered inside the Views section, which is no longer the shell's to reach into: the
          section polls the index, so a new folder appears there on the next tick.
        */}
        {sidebarOpen && folderName !== null ? (
          <form
            className="pad-sidebar-create pad-sidebar-folder-create"
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
            <div>
              <button type="button" onClick={() => setFolderName(null)} disabled={creatingFolder}>
                Cancel
              </button>
              <button
                type="submit"
                data-action="core.views.createFolder"
                disabled={creatingFolder || folderName.trim() === ""}
              >
                {creatingFolder ? "Creating…" : "Create"}
              </button>
            </div>
          </form>
        ) : null}

        <div className="pad-sidebar-sections">
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
              pluginTitle={composition.pluginTitle(section.plugin) ?? section.plugin}
              key={`${section.plugin}.${section.id}`}
            />
          ))}
        </div>

        {sidebarOpen && workspace !== null ? (
          <WorkspaceStatus
            status={workspace.status}
            savedAt={workspace.savedAt}
            rev={workspace.rev}
          />
        ) : null}

        <footer className="pad-sidebar-identity" title={identity.principal.name}>
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
    </>
  );
}
