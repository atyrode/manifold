import "./styles.css";
import {
  bindingRebindRefusal,
  formatKeystroke,
  type ComposedBinding,
  type SectionProps,
} from "@manifold/plugin";
import {
  clearRebindRequest,
  keyCapLabel,
  useRebindRequest,
  useWorkspaceShell,
} from "@manifold/plugin/hooks";
import { ControlIcon, KeyCap, ScrollRegion, Stack } from "@manifold/ui";
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
 *   THE KEYSTROKE IS CAPTURED, never typed. Arming a row listens for the next keystroke and
 *   stores exactly what the dispatcher will compare against (`formatKeystroke`) — a text field
 *   would let a reader store `f9` or `F 9` and discover the difference as a key that does
 *   nothing. Holding the platform's primary modifier captures a CHORD (`Mod+k`), because the
 *   registry's grammar has one now and a table that could print a chord but not capture one
 *   would be an editor that cannot edit half its rows. A bare modifier is still ignored, since
 *   a chord is not a keystroke until it has a key.
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
 *
 * AND IT ANSWERS A REQUEST FROM OUTSIDE. Any surface may PRINT a binding — the composed table
 * is the engine's read — so any surface may want to send a reader here to change one. That
 * handoff is the engine's neutral slot (`requestRebind`, `@manifold/plugin/hooks`): a request
 * names a binding id and nothing else, this editor opens on it, arms it and clears the slot.
 * The asker never learns who answered, which is what lets a stranger's editor answer instead.
 */

/** The rows the collision check sees — the effective table, as the engine's row shape. */
function keyRows(
  bindings: readonly ComposedBinding[],
): { id: string; key: string; plugin: string }[] {
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
  return `rebinding to ${keyCapLabel(override)} is not in effect — another row answers that key`;
}

export function KeysRow({ host }: SectionProps): ReactElement {
  const assembly = host.assembly;
  const { sidebarOpen } = useWorkspaceShell();
  /*
    THE HANDOFF, answered by DERIVATION rather than by synchronisation. Somebody printed a key
    row somewhere else and the reader asked to change it (`requestRebind`): a pending request
    IS this editor being open on that row, so it is read during render instead of copied into
    state by an effect — the copy would be a second answer to "is the editor open", and a
    cascading render besides. An id the table no longer carries opens the editor and arms
    nothing, which is the honest answer: the row left with its plugin.

    `armed` is therefore THREE-valued. `undefined` is "this reader has not decided", which is
    what lets the request supply the row; `null` is a decision — they pressed Escape or the
    rebind landed — and it survives the request still sitting in the slot. The slot is cleared
    when the dialog closes, so the same row can be asked for again.
  */
  const requested = useRebindRequest();
  const [opened, setOpened] = useState(false);
  const [armedRow, setArmedRow] = useState<string | null | undefined>(undefined);
  const [pending, setPending] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  const open = opened || requested !== null;
  const armed =
    armedRow === undefined
      ? assembly.bindings.some((row) => row.id === requested)
        ? requested
        : null
      : armedRow;
  const setArmed = setArmedRow;

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (dialog !== null && !dialog.open) dialog.showModal();
  }, [open]);

  const close = (): void => {
    setOpened(false);
    setArmedRow(undefined);
    setRefusal(null);
    clearRebindRequest();
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
   * is armed. A bare MODIFIER is not a keystroke yet, so it is ignored instead of stored; the
   * primary modifier held WITH a key is, because the registry's grammar spells that stroke
   * (`Mod+k`) and the dispatcher answers it. Alt is refused rather than captured: it decorates
   * the character a layout produces, so what `event.key` reports under it is a different
   * character on every keyboard and the row would answer on one machine and not the next.
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
      if (event.key === "Meta" || event.altKey) return;
      setArmed(null);
      void rebind(armed, formatKeystroke({ mod: event.ctrlKey || event.metaKey, key: event.key }));
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
        onClick={() => setOpened(true)}
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
                  Plugins declare these keys; your rebindings are saved to your principal and follow
                  you to every device. Press Rebind, then press the key you want.
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
                                {overridden
                                  ? ` · declared ${keyCapLabel(binding.declaredKey)}`
                                  : ""}
                              </small>
                              {note === null ? null : <small className="keys-note">{note}</small>}
                            </span>
                            <span className="keys-controls">
                              {armed === binding.id ? (
                                <span className="keys-arming">press a key…</span>
                              ) : (
                                <KeyCap label={keyCapLabel(binding.key)} overridden={overridden} />
                              )}
                              <button
                                className="keys-action"
                                type="button"
                                data-action={KEYS_SET_ACTION}
                                data-testid="keys-rebind"
                                disabled={pending !== null}
                                onClick={() => setArmed(armed === binding.id ? null : binding.id)}
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
