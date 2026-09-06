import { useSyncExternalStore } from "react";

/**
 * "THIS STRUCTURE IS IN MY HAND" — one device-local slot naming the placed structure a grip
 * drag is carrying, and the mechanism two plugins that may not import each other use to hand
 * that carry over (issue #148). The palette is `core.arrange`'s chrome and the rail's grips are
 * `core.shell`'s: neither can name the other, so without this slot "drop it back on the
 * palette" is a private import across the boundary or a second palette — the same bug twice
 * (invariants 12 and 14). The holder names ONE VERB, the removal its own layout door performs;
 * whoever paints the palette paints "Drop to remove" and calls it at the release that lands
 * there. NOT A {@link Vantage} FACET, for {@link requestRebind}'s reason: it lives between a
 * grip's drag threshold and its release, and the write it can cause is the traced commit point.
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
