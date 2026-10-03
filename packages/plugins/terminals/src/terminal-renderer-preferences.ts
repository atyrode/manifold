export type TerminalRendererMode = "dom" | "webgl";

export const TERMINAL_RENDERERS_KEY = "manifold:terminal-renderers";
const MAX_ENTRIES = 128;

interface RendererStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Like terminal typography, renderer choice belongs to this device, not the shared scene. */
export function createTerminalRendererPreferences(storage: RendererStorage) {
  let enabled: Map<string, "webgl"> | undefined;
  const listeners = new Set<() => void>();
  const load = (): Map<string, "webgl"> => {
    const result = new Map<string, "webgl">();
    try {
      const parsed: unknown = JSON.parse(storage.getItem(TERMINAL_RENDERERS_KEY) ?? "{}");
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return result;
      for (const [id, mode] of Object.entries(parsed)) {
        if (id.length === 0 || id.length > 256 || mode !== "webgl") continue;
        result.set(id, "webgl");
        if (result.size > MAX_ENTRIES) {
          const oldest = result.keys().next().value;
          if (oldest !== undefined) result.delete(oldest);
        }
      }
    } catch {
      // Unavailable or malformed device storage cannot prevent ordinary DOM terminals.
    }
    return result;
  };
  return {
    get(terminalId: string): TerminalRendererMode {
      enabled ??= load();
      return enabled.has(terminalId) ? "webgl" : "dom";
    },
    set(terminalId: string, mode: TerminalRendererMode): void {
      if (terminalId.length === 0 || terminalId.length > 256) return;
      enabled ??= load();
      enabled.delete(terminalId);
      if (mode === "webgl") enabled.set(terminalId, "webgl");
      if (enabled.size > MAX_ENTRIES) {
        const oldest = enabled.keys().next().value;
        if (oldest !== undefined) enabled.delete(oldest);
      }
      // Keep the current view responsive when persistence fails; its caller reports the failure.
      for (const listener of listeners) listener();
      storage.setItem(TERMINAL_RENDERERS_KEY, JSON.stringify(Object.fromEntries(enabled)));
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reload(): void {
      enabled = load();
      for (const listener of listeners) listener();
    },
  };
}

export const terminalRendererPreferences = createTerminalRendererPreferences({
  getItem: (key) => window.localStorage.getItem(key),
  setItem: (key, value) => window.localStorage.setItem(key, value),
});
let subscribers = 0;
const onStorage = (event: StorageEvent): void => {
  if (event.key === TERMINAL_RENDERERS_KEY || event.key === null)
    terminalRendererPreferences.reload();
};

/** One cross-tab listener while a terminal representation or its preference control is live. */
export function subscribeTerminalRendererPreferences(listener: () => void): () => void {
  const unsubscribe = terminalRendererPreferences.subscribe(listener);
  if (subscribers++ === 0 && typeof window !== "undefined") {
    window.addEventListener("storage", onStorage);
    terminalRendererPreferences.reload();
  }
  return () => {
    unsubscribe();
    if (--subscribers === 0 && typeof window !== "undefined")
      window.removeEventListener("storage", onStorage);
  };
}
