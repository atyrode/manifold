import type { Pad } from "@manifold/protocol";

export interface PadMemoryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const KEY_PREFIX = "manifold.last-pad.";
export function browserPadStorage(): PadMemoryStorage {
  return {
    getItem: (key) => window.localStorage.getItem(key),
    setItem: (key, value) => window.localStorage.setItem(key, value),
    removeItem: (key) => window.localStorage.removeItem(key),
  };
}

export function padMemoryKey(principalId: string): string {
  return `${KEY_PREFIX}${principalId}`;
}

/** Returns the remembered visible pad, falling back to the server's first pad. */
export function chooseInitialPad(
  storage: PadMemoryStorage,
  principalId: string,
  pads: readonly Pad[],
): Pad | null {
  if (pads.length === 0) return null;
  try {
    const rememberedId = storage.getItem(padMemoryKey(principalId));
    return pads.find((pad) => pad.id === rememberedId) ?? pads[0] ?? null;
  } catch {
    return pads[0] ?? null;
  }
}

export function rememberPad(storage: PadMemoryStorage, principalId: string, padId: string): void {
  try {
    storage.setItem(padMemoryKey(principalId), padId);
  } catch {
    // Last-used memory is optional and must never block navigation.
  }
}

export function forgetPad(storage: PadMemoryStorage, principalId: string, padId: string): void {
  try {
    const key = padMemoryKey(principalId);
    if (storage.getItem(key) === padId) storage.removeItem(key);
  } catch {
    // Last-used memory is optional and must never block deletion.
  }
}
