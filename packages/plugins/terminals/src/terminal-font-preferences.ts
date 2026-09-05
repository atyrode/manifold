import { TERMINAL_FONT_SIZE } from "./terminal-font";

export const TERMINAL_FONT_SIZES_KEY = "manifold:terminal-font-sizes";
export const MIN_TERMINAL_FONT_SIZE = 8;
export const MAX_TERMINAL_FONT_SIZE = 32;
const MAX_ENTRIES = 128;

interface FontStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Device typography, not document state: aliases share a store, never a server action. */
export function createTerminalFontPreferences(storage: FontStorage) {
  let sizes: Map<string, number> | undefined;
  const listeners = new Set<() => void>();

  const load = (): Map<string, number> => {
    const result = new Map<string, number>();
    try {
      const parsed: unknown = JSON.parse(storage.getItem(TERMINAL_FONT_SIZES_KEY) ?? "{}");
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return result;
      for (const [id, size] of Object.entries(parsed)) {
        if (
          id.length === 0 ||
          id.length > 256 ||
          typeof size !== "number" ||
          !Number.isInteger(size) ||
          size < MIN_TERMINAL_FONT_SIZE ||
          size > MAX_TERMINAL_FONT_SIZE ||
          size === TERMINAL_FONT_SIZE
        )
          continue;
        result.set(id, size);
        if (result.size > MAX_ENTRIES) {
          const oldest = result.keys().next().value;
          if (oldest !== undefined) result.delete(oldest);
        }
      }
    } catch {
      // Malformed or unavailable storage must not prevent opening a terminal.
    }
    return result;
  };

  return {
    get(terminalId: string): number {
      sizes ??= load();
      return sizes.get(terminalId) ?? TERMINAL_FONT_SIZE;
    },
    set(terminalId: string, value: number): void {
      if (terminalId.length === 0 || terminalId.length > 256 || !Number.isFinite(value)) return;
      sizes ??= load();
      const size = Math.min(
        MAX_TERMINAL_FONT_SIZE,
        Math.max(MIN_TERMINAL_FONT_SIZE, Math.round(value)),
      );
      sizes.delete(terminalId);
      if (size !== TERMINAL_FONT_SIZE) sizes.set(terminalId, size);
      if (sizes.size > MAX_ENTRIES) {
        const oldest = sizes.keys().next().value;
        if (oldest !== undefined) sizes.delete(oldest);
      }
      // Apply locally even when persistence fails; the caller reports the write error.
      for (const listener of listeners) listener();
      storage.setItem(TERMINAL_FONT_SIZES_KEY, JSON.stringify(Object.fromEntries(sizes)));
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reload(): void {
      sizes = load();
      for (const listener of listeners) listener();
    },
  };
}

export const terminalFontPreferences = createTerminalFontPreferences({
  getItem: (key) => window.localStorage.getItem(key),
  setItem: (key, value) => window.localStorage.setItem(key, value),
});

let subscribers = 0;
const onStorage = (event: StorageEvent): void => {
  if (event.key === TERMINAL_FONT_SIZES_KEY || event.key === null) terminalFontPreferences.reload();
};

/** One cross-tab listener while any terminal representation is mounted. */
export function subscribeTerminalFontPreferences(listener: () => void): () => void {
  const unsubscribe = terminalFontPreferences.subscribe(listener);
  if (subscribers++ === 0 && typeof window !== "undefined") {
    window.addEventListener("storage", onStorage);
    terminalFontPreferences.reload();
  }
  return () => {
    unsubscribe();
    if (--subscribers === 0 && typeof window !== "undefined") {
      window.removeEventListener("storage", onStorage);
    }
  };
}
