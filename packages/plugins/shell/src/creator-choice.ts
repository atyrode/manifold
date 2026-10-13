/**
 * WHICH CREATOR THE DRAFT ENTRY OPENS ON, how the choice steps while drafting, and this
 * device's memory of the last creator run. Pure policy plus storage-fault tolerance,
 * unit-tested; the row only decides when to read and write.
 *
 * Device-local on purpose (REGISTRY.md §Device-local register): "what did I last make from
 * this screen" is a convenience about one browser, it names an entry from an OPEN set any
 * plugin can declare, and a stale or foreign id costs nothing — it simply falls back.
 * Storage faults (privacy mode, quota, disabled storage) degrade to "no memory".
 */

import type { DeviceStorage } from "./device-storage.ts";

export const LAST_CREATOR_KEY = "manifold:last-creator";

/**
 * THE CREATOR A NEW DRAFT OPENS ON: the remembered one while it is still offered to this
 * reader, otherwise the first one offered, otherwise none. A pick that was hidden by a setting,
 * belongs to a plugin that is off or gone, or was never a creator at all is the same case — not
 * offered — and falls back without erasing the memory, so the pick returns when it does.
 */
export function draftCreator<T extends { readonly id: string }>(
  creators: readonly T[],
  lastPick: string | null,
): T | null {
  return creators.find((creator) => creator.id === lastPick) ?? creators[0] ?? null;
}

/**
 * THE NEXT CREATOR IN DECLARED ORDER, wrapping at both ends — Tab and the draft's mark step
 * forward, Shift+Tab back. A current id no longer offered (its plugin went away mid-draft)
 * steps from the first entry, as if the draft had opened on it.
 */
export function cycleCreator<T extends { readonly id: string }>(
  creators: readonly T[],
  currentId: string,
  step: 1 | -1,
): T | null {
  if (creators.length === 0) return null;
  const at = Math.max(
    0,
    creators.findIndex((creator) => creator.id === currentId),
  );
  return creators[(at + step + creators.length) % creators.length] ?? null;
}

/** The remembered creator id, or null on absence or a storage fault. */
export function recallCreator(storage: DeviceStorage): string | null {
  try {
    const stored = storage.getItem(LAST_CREATOR_KEY);
    return stored !== null && stored.length > 0 ? stored : null;
  } catch {
    return null;
  }
}

/** Remembers the creator just run; silently a no-op on storage faults. */
export function rememberCreator(storage: DeviceStorage, creatorId: string): void {
  try {
    storage.setItem(LAST_CREATOR_KEY, creatorId);
  } catch {
    // quota/privacy mode: the draft's memory is a nicety, never worth breaking a creation
  }
}
