/**
 * Per-container, per-device machine memory and the default-machine policy for
 * terminal creation. Pure policy module — choice rules, serialization, and
 * storage-fault tolerance live here (unit-tested); the component only decides
 * WHEN to fetch machines and render the picker.
 *
 * Storage faults (privacy mode, quota, disabled storage) must never break the
 * container: every operation degrades to a no-op.
 */

import type { MachineSummary } from "@manifold/protocol";

/** Minimal Storage ref so tests can inject fakes (including throwing ones). */
export interface MachineStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function machineMemoryKey(containerId: string): string {
  return `manifold:machine:${containerId}`;
}

/**
 * Defers `window.localStorage` access to call time: evaluating the property
 * itself can throw (disabled storage, sandboxed frame), and deferring puts
 * that throw inside recall/remember's existing fault handling.
 */
export function browserMachineStorage(): MachineStorage {
  return {
    getItem: (key) => window.localStorage.getItem(key),
    setItem: (key, value) => window.localStorage.setItem(key, value),
  };
}

/**
 * Picks the machine for an implicit terminal restart:
 * the remembered machine when it is online, else the sole online machine,
 * else null so the server's selection rule remains authoritative.
 */
export function chooseDefaultMachine(
  machines: readonly MachineSummary[],
  lastUsedId: string | null,
): MachineSummary | null {
  const online = machines.filter((machine) => machine.online);
  if (lastUsedId !== null) {
    const remembered = online.find((machine) => machine.id === lastUsedId);
    if (remembered !== undefined) return remembered;
  }
  return online.length === 1 ? (online[0] ?? null) : null;
}

/** Remembers the picked machine for a container; silently a no-op on storage faults. */
export function rememberMachine(
  storage: MachineStorage,
  containerId: string,
  machineId: string,
): void {
  try {
    storage.setItem(machineMemoryKey(containerId), machineId);
  } catch {
    // quota/privacy mode: machine memory is a nicety, never worth breaking the container
  }
}

/** Loads the remembered machine id for a container; null on absence or storage fault. */
export function recallMachine(storage: MachineStorage, containerId: string): string | null {
  try {
    const stored = storage.getItem(machineMemoryKey(containerId));
    return stored !== null && stored.length > 0 ? stored : null;
  } catch {
    return null;
  }
}
