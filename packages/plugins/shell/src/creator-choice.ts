/**
 * WHICH CREATOR THE FACE OFFERS, and this device's memory of the last one picked. Pure policy
 * plus storage-fault tolerance, unit-tested; the row only decides when to read and write.
 *
 * Device-local on purpose (REGISTRY.md §Device-local register): "what did I last make from
 * this screen" is a convenience about one browser, it names an entry from an OPEN set any
 * plugin can declare, and a stale or foreign id costs nothing — it simply falls back.
 * Storage faults (privacy mode, quota, disabled storage) degrade to "no memory".
 */

import type { DeviceStorage } from "./device-storage.ts";

export const LAST_CREATOR_KEY = "manifold:last-creator";

/**
 * THE FACE: the remembered creator while it is still offered to this reader, otherwise the
 * first one offered, otherwise none. A pick that was hidden by a setting, belongs to a plugin
 * that is off or gone, or was never a creator at all is the same case — not offered — and
 * falls back without erasing the memory, so the entry returns to the face when it returns.
 */
export function creatorFace<T extends { readonly id: string }>(
  creators: readonly T[],
  lastPick: string | null,
): T | null {
  return creators.find((creator) => creator.id === lastPick) ?? creators[0] ?? null;
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

/** Remembers the picked creator; silently a no-op on storage faults. */
export function rememberCreator(storage: DeviceStorage, creatorId: string): void {
  try {
    storage.setItem(LAST_CREATOR_KEY, creatorId);
  } catch {
    // quota/privacy mode: the face's memory is a nicety, never worth breaking a creation
  }
}
