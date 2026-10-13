import type { DeviceStorage } from "../src/device-storage.ts";

/** An in-memory device store whose contents a test can read back. */
export function memoryStorage(): DeviceStorage & { readonly items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
  };
}

/** A store that faults on every call, as privacy mode, quota or disabled storage do. */
export const brokenStorage: DeviceStorage = {
  getItem: () => {
    throw new Error("storage disabled");
  },
  setItem: () => {
    throw new Error("quota");
  },
};
