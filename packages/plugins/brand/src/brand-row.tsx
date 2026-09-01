import { useWorkspaceShell } from "@manifold/plugin/hooks";
import { ControlIcon } from "@manifold/plugin/ui";
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { parseChangelogReferences } from "./changelog-references.ts";

/**
 * `core.brand.brand` — the mark, the wordmark, the running build's version, and the history
 * behind it. A PLAIN row: it draws itself end to end, so there is no disclosure header over
 * it and nothing to fold.
 *
 * It is a contribution rather than the panel's own JSX because that is what makes the sidebar
 * honest. The rail was a plugin already, but its top line was hand-written inside the panel,
 * which meant "the shell owns the brand" was a fact about a file rather than about the
 * assembly: nobody could read the sidebar's composition and see it, nothing ordered it beside
 * the rows below it, and arrange mode could not move it. Now it is one row of one registry,
 * in one order, with an owner the DOM names (`data-plugin`) — and a stranger's shell replacing
 * `core.shell` inherits it or drops it by declaration, not by editing a component.
 *
 * THE DIALOG STAYS THE ROW'S. A modal is chrome about the thing that opened it, so the row
 * that owns the version button owns the history it shows, and it reaches `document.body`
 * through the same portal the panel used — the rail is a narrow, clipping, scrolling box, and
 * a dialog inside it would be laid out by it.
 *
 * THIS FILE MOVED HERE FROM `core.shell` in the essential-seats wave: the row's ownership now
 * matches its seat, `core.brand`, rather than living inside the shell package that happened to
 * draw it first. Nothing about how it draws changed — the component, its props, and its DOM
 * are byte-identical to the row `core.shell` used to carry — only which package's name is on
 * the door.
 */

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

export function BrandRow(): ReactElement {
  /*
    The rail's own collapsed/open state and the build's identity are the HOST's facts, read
    off the one context the workspace host publishes above the tree (`WorkspaceShell`). A row
    that needs to know how wide the rail is drawn reads it there and nowhere else: a second
    channel for "is the sidebar collapsed" would be a second answer to it (invariant 14).
  */
  const { sidebarOpen, webChangelog, webVersionLabel } = useWorkspaceShell();
  const [changelogOpen, setChangelogOpen] = useState(false);
  const versionButtonRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    if (!changelogOpen) return;
    const dialog = dialogRef.current;
    if (dialog !== null && !dialog.open) dialog.showModal();
  }, [changelogOpen]);

  const close = (): void => {
    setChangelogOpen(false);
    window.requestAnimationFrame(() => versionButtonRef.current?.focus());
  };

  return (
    <>
      <span className="sidebar-brand">
        <span className="sidebar-mark" aria-hidden="true">
          M
        </span>
        {/* Collapsed to icons, the mark IS the row: the copy beside it has no width to live in. */}
        {sidebarOpen ? (
          <span className="sidebar-brand-copy">
            <strong>manifold</strong>
            <button
              ref={versionButtonRef}
              className="sidebar-version"
              type="button"
              aria-label={`Open web changelog for ${webVersionLabel}`}
              onClick={() => setChangelogOpen(true)}
            >
              {webVersionLabel}
            </button>
          </span>
        ) : null}
      </span>
      {typeof document !== "undefined" && changelogOpen
        ? createPortal(
            <dialog
              ref={dialogRef}
              className="web-changelog-dialog"
              aria-labelledby="web-changelog-title"
              onCancel={(event) => {
                event.preventDefault();
                close();
              }}
              onPointerDown={(event) => {
                if (event.target !== event.currentTarget) return;
                close();
              }}
            >
              <section className="web-changelog-card">
                <header>
                  <div>
                    <span>Web application</span>
                    <h2 id="web-changelog-title">What’s new</h2>
                    <code>{webVersionLabel}</code>
                  </div>
                  <button type="button" aria-label="Close changelog" onClick={close}>
                    <ControlIcon kind="close" />
                  </button>
                </header>
                <div className="web-changelog-releases">
                  {webChangelog.map((release) => (
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
