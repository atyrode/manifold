import type { Container } from "@manifold/protocol";

export interface ContainerMemoryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const KEY_PREFIX = "manifold.last-container.";
export function browserContainerStorage(): ContainerMemoryStorage {
  return {
    getItem: (key) => window.localStorage.getItem(key),
    setItem: (key, value) => window.localStorage.setItem(key, value),
  };
}

export function containerMemoryKey(principalId: string): string {
  return `${KEY_PREFIX}${principalId}`;
}

/** Returns the remembered visible container, falling back to the server's first container. */
export function chooseInitialContainer(
  storage: ContainerMemoryStorage,
  principalId: string,
  containers: readonly Container[],
): Container | null {
  if (containers.length === 0) return null;
  try {
    const rememberedId = storage.getItem(containerMemoryKey(principalId));
    return containers.find((container) => container.id === rememberedId) ?? containers[0] ?? null;
  } catch {
    return containers[0] ?? null;
  }
}

export function rememberContainer(
  storage: ContainerMemoryStorage,
  principalId: string,
  containerId: string,
): void {
  try {
    storage.setItem(containerMemoryKey(principalId), containerId);
  } catch {
    // Last-used memory is optional and must never block navigation.
  }
}
