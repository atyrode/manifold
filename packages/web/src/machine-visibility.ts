/**
 * Fleet visibility policy: deterministic machine colors (hashed into the SAME
 * palette principals pick from — one scheme, no second convention), name
 * resolution for terminal badges, and the offline-state rule for a session's
 * machine. Pure module, unit-tested; components only render the results.
 */

import type { MachineSummary } from "@manifold/protocol";
import { IDENTITY_COLORS } from "./identity.tsx";

/** FNV-1a over the machine id: stable across sessions, devices, and reloads. */
export function machineColor(machineId: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < machineId.length; index++) {
    hash ^= machineId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  const palette = IDENTITY_COLORS;
  return palette[(hash >>> 0) % palette.length] ?? palette[0];
}

export interface SessionMachine {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly online: boolean;
}

/**
 * Resolves a session's machine for the terminal badge and offline strip.
 * `machines === null` (never fetched) returns null — components must not
 * flash "offline" before the first fetch resolves. A machineId absent from a
 * fetched list is treated as offline (deleted or unknown machine).
 */
export function sessionMachine(
  machines: readonly MachineSummary[] | null,
  machineId: string,
): SessionMachine | null {
  if (machines === null) return null;
  const machine = machines.find((candidate) => candidate.id === machineId);
  if (machine === undefined) {
    return {
      id: machineId,
      name: "unknown machine",
      color: machineColor(machineId),
      online: false,
    };
  }
  return {
    id: machine.id,
    name: machine.name,
    color: machineColor(machine.id),
    online: machine.online,
  };
}
