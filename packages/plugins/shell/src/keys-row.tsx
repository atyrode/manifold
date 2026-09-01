import type { ComposedBinding, SectionProps } from "@manifold/plugin";
import { useWorkspaceShell } from "@manifold/plugin/hooks";
import { Cluster, ControlIcon, ScrollRegion, Stack } from "@manifold/plugin/ui";
import { useEffect, useRef, useState, type ReactElement } from "react";
import { createPortal } from "react-dom";

/**
 * `core.shell.keys` — the key table's door, as a PLAIN row, and the table behind it.
 *
 * THE KEY TABLE, as a reader sees it: every binding the composition composed, with the key,
 * what it does and which plugin owns it. It prints the REGISTRY rather than a hand-kept list,
 * which is the whole point of declaring keys: a plugin that ships a binding appears here for
 * free, a disabled plugin's rows are gone because composition dropped them, and a key nobody
 * declared cannot be listed — it also cannot be dispatched. Scope is shown only when a row
 * narrows it: "canvas" beside a row that only answers on a canvas is information, and "always"
 * beside eleven rows is noise.
 *
 * It is chrome over an ENGINE registry — `host.assembly.bindings`, the read every plugin may
 * open — so it belongs to whichever plugin draws the rail, and it names no plugin to do it.
 * That is why the row is `core.shell`'s and not the engine's: the engine publishes the table,
 * the shell decides that a rail has a door onto it, and a stranger's shell may decide
 * otherwise without the engine changing.
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

export function KeysRow({ host }: SectionProps): ReactElement {
  const assembly = host.assembly;
  const { sidebarOpen } = useWorkspaceShell();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (dialog !== null && !dialog.open) dialog.showModal();
  }, [open]);

  const close = (): void => {
    setOpen(false);
    window.requestAnimationFrame(() => buttonRef.current?.focus());
  };

  return (
    <>
      <button
        ref={buttonRef}
        className="sidebar-bindings"
        type="button"
        title="Keyboard bindings"
        aria-label="Show keyboard bindings"
        onClick={() => setOpen(true)}
      >
        <ControlIcon kind="bindings" />
        {sidebarOpen ? <span>Keys</span> : null}
      </button>
      {typeof document !== "undefined" && open
        ? createPortal(
            <dialog
              ref={dialogRef}
              className="sidebar-bindings-dialog"
              aria-labelledby="sidebar-bindings-title"
              onCancel={(event) => {
                event.preventDefault();
                close();
              }}
              onPointerDown={(event) => {
                if (event.target !== event.currentTarget) return;
                close();
              }}
            >
              <section className="sidebar-bindings-card">
                <header>
                  <div>
                    <span>Workspace</span>
                    <h2 id="sidebar-bindings-title">Keyboard bindings</h2>
                  </div>
                  <button type="button" aria-label="Close keyboard bindings" onClick={close}>
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
