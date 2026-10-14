/**
 * THE SHELL'S DEVICE-LOCAL STORAGE SEAM: the minimal Storage shape its remembered choices read
 * and write, so tests can inject fakes, including throwing ones. Every key written through it
 * is registered in REGISTRY.md §Device-local register.
 */
export interface DeviceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Defers `window.localStorage` to call time: reading the property itself can throw. */
export function browserStorage(): DeviceStorage {
  return {
    getItem: (key) => window.localStorage.getItem(key),
    setItem: (key, value) => window.localStorage.setItem(key, value),
  };
}
