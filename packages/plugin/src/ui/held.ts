import { useSyncExternalStore } from "react";

/**
 * "THIS STRUCTURE IS IN MY HAND" — one device-local slot naming the placed structure a grip
 * drag is carrying, and the mechanism two plugins that may not import each other use to hand
 * that carry over (issue #148).
 *
 * The palette is where structure comes from and where it goes back to, and the palette is
 * `core.arrange`'s chrome — but the structures a reader can pick up are painted by whichever
 * arrangement they sit in: the workspace tree's by that same plugin, a panel's own by the
 * panel (`core.shell`'s rail). The rail's grip cannot name the palette and the palette cannot
 * read the rail's hold, so without a slot like this "drop it back on the palette" is either
 * a private import across the plugin boundary or a second palette, and both are the same bug
 * (invariants 12 and 14). With it, the holder names ONE VERB — the removal its own arrangement
 * door performs — and whoever paints the palette answers by painting "Drop to remove" and by
 * calling it at the release that lands there.
 *
 * NOT A {@link Vantage} FACET, for {@link requestRebind}'s reason: vantage is view state a
 * collaborator is owed. This is the continuous half of one pointer gesture — it exists between
 * a grip's drag threshold and its release, dies with the release whether or not the palette
 * took it, and the layout write it can cause is the traced commit point (the plane rule's
 * continuous-stream clause). Publishing it would put every frame of a hand on the wire.
 */
export interface HeldStructure {
  /** Takes the structure out of its own arrangement through its own layout door. */
  readonly remove: () => void;
}

let held: HeldStructure | null = null;
const listeners = new Set<() => void>();

/** The grip that crossed its drag threshold with structure in hand says so here. */
export function holdStructure(next: HeldStructure): void {
  held = next;
  for (const listener of listeners) listener();
}

/** Every end of that gesture — release, cancel, Escape — clears the hand. */
export function releaseStructure(): void {
  if (held === null) return;
  held = null;
  for (const listener of listeners) listener();
}

export function heldStructure(): HeldStructure | null {
  return held;
}

/** What is in hand, as a render input for the palette that paints its state. */
export function useHeldStructure(): HeldStructure | null {
  return useSyncExternalStore(subscribe, heldStructure, heldStructure);
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}
