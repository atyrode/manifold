import "./styles.css";
import { bindingRebindRefusal, type ComposedBinding, type SectionProps } from "@manifold/plugin";
import { useWorkspaceShell } from "@manifold/plugin/hooks";
import { ControlIcon, ScrollRegion, Stack } from "@manifold/plugin/ui";
import { useEffect, useRef, useState, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { KEYS_RESET_ACTION, KEYS_SET_ACTION } from "./index.ts";

/**
 * `core.keys`, browser half: the rail's key row, and the BINDING EDITOR behind it.
 *
 * WHAT A READER SEES is still the registry: every binding the composition composed, with the
 * key it answers to, what it does and which plugin owns it. It prints the REGISTRY rather than
 * a hand-kept list, which is the whole point of declaring keys — a plugin that ships a binding
 * appears here for free, a disabled plugin's rows are gone because composition dropped them,
 * and a key nobody declared cannot be listed, because it also cannot be dispatched. Scope is
 * shown only when a row narrows it: "canvas" beside a row that only answers on a canvas is
 * information, and "always" beside eleven rows is noise.
 *
 * WHAT IS NEW is that the table is now an EDITOR: plugins declare the defaults, the principal
 * rebinds (issue #91). Three constraints shape every line of it:
 *
 *   THE KEY IS CAPTURED, never typed. Arming a row listens for the next keystroke and takes
 *   `KeyboardEvent.key` verbatim, so the stored value is exactly what the dispatcher will
 *   compare against — a text field would let a reader store `f9` or `F 9` and discover the
 *   difference as a key that does nothing.
 *
 *   A COLLISION REFUSES LOUDLY, naming both offenders, and never writes. The check is the
 *   engine's own (`bindingRebindRefusal`), run here against the whole EFFECTIVE table because
 *   this is where the whole table exists; the door runs the same function over the caller's
 *   stored overrides, which is all a server can see of a browser-side registry. Same function,
 *   same sentence, two vantage points.
 *
 *   THE WRITE IS A DOOR, and the read is the engine's. Nothing here mutates: a rebind
 *   dispatches `core.keys.setBinding` and then asks the engine to re-read the stored map
 *   (`assembly.refreshBindings`), so the effective table this modal is printing and the table
 *   the dispatcher answers from are the same one object, recomposed at the one seam.
 */

/** The rows the collision check sees — the effective table, as the engine's row shape. */
function keyRows(bindings: readonly ComposedBinding[]): { id: string; key: string; plugin: string }[] {
  return bindings.map((binding) => ({ id: binding.id, key: binding.key, plugin: binding.plugin }));
}

/**
 * WHY THIS ROW IS NOT SHOWING ITS OVERRIDE, or null when there is nothing to say. A stored
 * override loses to a declaration that has since claimed its key (`effectiveBindings` drops it
 * rather than throwing at boot), and the reader has to be told: the alternative is a row that
 * silently answers its default while the editor claims it was rebound.
 */
function shadowedNote(binding: ComposedBinding, override: string | undefined): string | null {
  if (override === undefined || override === binding.key) return null;
  return `rebinding to ${override} is not in effect — another row answers that key`;
}

export function KeysRow({ host }: SectionProps): ReactElement {
  const assembly = host.assembly;
  const { sidebarOpen } = useWorkspaceShell();
  const [open, setOpen] = useState(false);
  /** The row waiting for a keystroke, or null. Device-local by nature: it is a gesture. */
  const [armed, setArmed] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (dialog !== null && !dialog.open) dialog.showModal();
  }, [open]);

  const close = (): void => {
    setOpen(false);
    setArmed(null);
    setRefusal(null);
    window.requestAnimationFrame(() => buttonRef.current?.focus());
  };

  const rebind = async (binding: string, key: string): Promise<void> => {
    const collision = bindingRebindRefusal(keyRows(assembly.bindings), binding, key);
    if (collision !== null) {
      setRefusal(collision);
      return;
    }
    setRefusal(null);
    setPending(binding);
    const outcome = await host.client.action(KEYS_SET_ACTION, { binding, key });
    setPending(null);
    if (!outcome.ok) {
      setRefusal(outcome.denial.message);
      return;
    }
    assembly.refreshBindings();
  };

  const reset = async (binding: string | null): Promise<void> => {
    setRefusal(null);
    setPending(binding ?? "");
    const outcome = await host.client.action(KEYS_RESET_ACTION, { binding });
    setPending(null);
    if (!outcome.ok) {
      setRefusal(outcome.denial.message);
      return;
    }
    assembly.refreshBindings();
  };

  /**
   * THE CAPTURE, on the window in the CAPTURE phase, for as long as one row is armed.
   *
   * The phase is the whole trick and it is not a preference: the floor's dispatcher listens for
   * keydown on the window while bubbling, so a bare listener here would arm F9 and then WATCH
   * the drop-zone probe toggle on the way past. Capturing first and stopping the event is what
   * makes "press the key you want" mean pressing a key that is currently bound to something.
   *
   * Escape cancels rather than binds — every mode's universal "never mind" belongs to whatever
   * is armed — and a bare modifier is not a keystroke yet, so it is ignored instead of stored:
   * a chord is a different key than the one it decorates (the dispatcher refuses chords), so
   * the editor must not let one be captured either.
   */
  useEffect(() => {
    if (armed === null) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === "Escape") {
        setArmed(null);
        return;
      }
      if (event.key === "Shift" || event.key === "Control" || event.key === "Alt") return;
      if (event.key === "Meta" || event.ctrlKey || event.metaKey || event.altKey) return;
      setArmed(null);
      void rebind(armed, event.key);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  });

  const overrides = assembly.bindingOverrides;
  /*
    Stored deltas whose binding the table no longer carries: a disabled plugin's row, or a
    plugin that renamed its own. They are KEPT rather than pruned — re-enabling restores the
    reader's choice, exactly as a stored section arrangement keeps a disabled plugin's seat —
    and named here, because a global reset is the only thing that clears them and a footer that
    said nothing would make that verb look like it did nothing.
  */
  const listed = new Set(assembly.bindings.map((binding) => binding.id));
  const dormant = Object.keys(overrides).filter((id) => !listed.has(id)).length;
  const reboundCount = Object.keys(overrides).length;

  return (
    <>
      <button
        ref={buttonRef}
        className="sidebar-opener"
        type="button"
        title="Keyboard bindings"
        aria-label="Show keyboard bindings"
        data-testid="keys-open"
        onClick={() => setOpen(true)}
      >
        <ControlIcon kind="bindings" />
        {sidebarOpen ? <span>Keys</span> : null}
      </button>
      {typeof document !== "undefined" && open
        ? createPortal(
            <dialog
              ref={dialogRef}
              className="keys-dialog"
              aria-labelledby="keys-title"
              data-testid="keys-modal"
              onCancel={(event) => {
                event.preventDefault();
                close();
              }}
              onPointerDown={(event) => {
                if (event.target !== event.currentTarget) return;
                close();
              }}
            >
              <section className="keys-card">
                <header>
                  <div>
                    <span>Workspace</span>
                    <h2 id="keys-title">Keyboard bindings</h2>
                  </div>
                  <button type="button" aria-label="Close keyboard bindings" onClick={close}>
                    <ControlIcon kind="close" />
                  </button>
                </header>
                <p className="keys-lede">
                  Plugins declare these keys; your rebindings are saved to your principal and
                  follow you to every device. Press Rebind, then press the key you want.
                </p>
                {refusal === null ? null : (
                  <p className="keys-refusal" role="alert" data-testid="keys-refusal">
                    {refusal}
                  </p>
                )}
                <ScrollRegion className="keys-body">
                  <Stack gap="0.35rem">
                    {assembly.bindings.length === 0 ? (
                      <p className="keys-empty">No plugin claims a key in this workspace.</p>
                    ) : (
                      assembly.bindings.map((binding) => {
                        const override = overrides[binding.id];
                        const note = shadowedNote(binding, override);
                        const overridden = binding.key !== binding.declaredKey;
                        return (
                          <div
                            className="keys-row"
                            key={binding.id}
                            data-keys-binding={binding.id}
                            data-keys-armed={armed === binding.id}
                          >
                            <span className="keys-label">
                              {binding.label}
                              <small>
                                {assembly.pluginTitle(binding.plugin) ?? binding.plugin}
                                {binding.when === "always" ? "" : ` · ${binding.when} only`}
                                {overridden ? ` · declared ${binding.declaredKey}` : ""}
                              </small>
                              {note === null ? null : <small className="keys-note">{note}</small>}
                            </span>
                            <span className="keys-controls">
                              <kbd className="keys-cap" data-keys-overridden={overridden}>
                                {armed === binding.id ? "press a key…" : binding.key}
                              </kbd>
                              <button
                                className="keys-action"
                                type="button"
                                data-action={KEYS_SET_ACTION}
                                data-testid="keys-rebind"
                                disabled={pending !== null}
                                onClick={() =>
                                  setArmed(armed === binding.id ? null : binding.id)
                                }
                              >
                                {armed === binding.id ? "Cancel" : "Rebind"}
                              </button>
                              {override === undefined ? null : (
                                <button
                                  className="keys-action"
                                  type="button"
                                  data-action={KEYS_RESET_ACTION}
                                  data-testid="keys-reset"
                                  disabled={pending !== null}
                                  onClick={() => void reset(binding.id)}
                                >
                                  Reset
                                </button>
                              )}
                            </span>
                          </div>
                        );
                      })
                    )}
                  </Stack>
                </ScrollRegion>
                <footer>
                  <span>
                    {reboundCount === 0
                      ? "Every key is at its declared default."
                      : `${reboundCount} rebound${dormant === 0 ? "" : `, ${dormant} waiting on a disabled plugin`}.`}
                  </span>
                  <button
                    className="keys-action"
                    type="button"
                    data-action={KEYS_RESET_ACTION}
                    data-testid="keys-reset-all"
                    disabled={pending !== null || reboundCount === 0}
                    onClick={() => void reset(null)}
                  >
                    Reset all
                  </button>
                </footer>
              </section>
            </dialog>,
            document.body,
          )
        : null}
    </>
  );
}
