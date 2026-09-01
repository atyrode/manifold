import { useSyncExternalStore } from "react";

/**
 * "TAKE ME TO THIS KEY" — one device-local slot naming the binding a reader asked to change,
 * and the mechanism two plugins that may not import each other use to hand that gesture over.
 *
 * A surface that LISTS a binding is not the surface that EDITS one. The composed key table is
 * the engine's read (`host.assembly.bindings`), so anything may print a row — a command
 * surface, a tooltip, a menu — while the write is one plugin's door and the editor around it
 * is that plugin's chrome. Without a slot like this, "rebind that" is either a private import
 * across the plugin boundary or a second editor, and both are the same bug (invariants 12 and
 * 14). With it, the lister names a BINDING ID — engine vocabulary, no plugin's noun — and
 * whoever owns the editor answers.
 *
 * NOT A {@link Vantage} FACET, and the line is worth stating: vantage is this device's view
 * state and it rides the presence plane, because a collaborator is owed the reason a
 * principal's panes stopped taking clicks. A request to open somebody's editor is a HANDOFF
 * that lives for one render and dies when it is consumed — publishing it would put a keystroke
 * of chrome navigation on the wire and give every peer a fact with no rendering.
 *
 * AN UNANSWERED REQUEST IS A NO-OP, by construction: nothing here knows whether an editor is
 * mounted, and a workspace whose binding editor has been swapped out or turned off simply has
 * nobody listening. The consumer clears the slot when it takes the request, so the same row can
 * be asked for twice.
 */
let requested: string | null = null;
const listeners = new Set<() => void>();

/** Asks whoever owns the binding editor to open on `binding`. */
export function requestRebind(binding: string): void {
  if (requested === binding) return;
  requested = binding;
  for (const listener of listeners) listener();
}

/** Consumed by the editor once it has armed the row; unknown ids are already null. */
export function clearRebindRequest(): void {
  if (requested === null) return;
  requested = null;
  for (const listener of listeners) listener();
}

export function currentRebindRequest(): string | null {
  return requested;
}

/** The pending request as a render input, for the editor that answers it. */
export function useRebindRequest(): string | null {
  return useSyncExternalStore(subscribe, currentRebindRequest, currentRebindRequest);
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}
