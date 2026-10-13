/**
 * WHICH SIDEBAR DISCLOSURES ARE FOLDED on this device. Pure policy plus storage-fault
 * tolerance, unit-tested; the panel only decides when to read and write.
 *
 * A row nobody here has touched follows its manifest: folded unless it declares `defaultOpen`
 * (`SectionDefSchema`). A row the reader folded or unfolded keeps that choice across reloads.
 *
 * Device-local on purpose (REGISTRY.md §Device-local register): what one screen keeps open is
 * about that screen's room, changes nothing anybody else can see or act on, and a section id
 * from a plugin that is gone costs one stale boolean. Storage faults degrade to "no memory",
 * which is the manifest defaults.
 */

import type { DeviceStorage } from "./device-storage.ts";

export const SECTION_FOLDS_KEY = "manifold:sidebar-folds";

/** The reader's own choices, by global section id: `true` is folded, `false` is open. */
export type SectionFolds = Readonly<Record<string, boolean>>;

/** Whether a disclosure is folded: the reader's choice when there is one, else its manifest's. */
export function isFolded(
  section: { readonly id: string; readonly defaultOpen?: boolean },
  folds: SectionFolds,
): boolean {
  return folds[section.id] ?? section.defaultOpen !== true;
}

/** The remembered choices; absence, a storage fault or anything but `{id: boolean}` is none. */
export function recallFolds(storage: DeviceStorage): SectionFolds {
  let parsed: unknown;
  try {
    const stored = storage.getItem(SECTION_FOLDS_KEY);
    if (stored === null) return {};
    parsed = JSON.parse(stored);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const folds: Record<string, boolean> = {};
  for (const [id, folded] of Object.entries(parsed)) {
    if (typeof folded === "boolean") folds[id] = folded;
  }
  return folds;
}

/** Remembers the choices; silently a no-op on storage faults. */
export function rememberFolds(storage: DeviceStorage, folds: SectionFolds): void {
  try {
    storage.setItem(SECTION_FOLDS_KEY, JSON.stringify(folds));
  } catch {
    // quota/privacy mode: the rail falls back to the manifest defaults on the next load
  }
}
