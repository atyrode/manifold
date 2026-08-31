import type { MachineSummary } from "@manifold/protocol";
import type { TerminalFacet } from "@manifold/plugin/hooks";

import { TerminalView } from "./terminal-view.tsx";
import {
  browserMachineStorage,
  chooseDefaultMachine,
  recallMachine,
  rememberMachine,
} from "./machine-choice.ts";

/**
 * `core.terminals`, browser half — one door onto everything a client needs in order to show
 * and reason about terminals.
 *
 * Three surfaces, one concept each:
 *
 *   `TerminalView`       the viewer for one PTY: chrome, controls, focus presence, restart.
 *   `buildSessionRows`   the janitor projection — which terminals a caller can see and act on,
 *                        with `canKill` computed from the kill door's own rule.
 *   machine choice       per-pad, per-device memory of which machine a terminal is born on,
 *                        plus the default-machine policy.
 *
 * The first and the third reach the surfaces that need them through the engine's PROJECTION
 * registry rather than through an import: a container renderer paints terminals it does not
 * own and offers to open one, and no plugin may import another (AXIOMS §Foundation). So
 * {@link terminalsWebPlugin} registers one facet — the viewer plus the birth policy — and a
 * canvas or a composition asks for it by name. Disabling this plugin therefore makes every
 * terminal on screen paint the engine's named placeholder and every "new terminal" affordance
 * fall silent, which is exactly the disable contract (ADR 0013 §4) rather than a special case
 * anybody had to write.
 */
export { TerminalView } from "./terminal-view.tsx";
export {
  buildSessionRows,
  type SessionInventoryInput,
  type SessionRow,
} from "./session-inventory.ts";
export {
  browserMachineStorage,
  chooseDefaultMachine,
  machineMemoryKey,
  recallMachine,
  rememberMachine,
  type MachineStorage,
} from "./machine-choice.ts";

/**
 * The birth policy, as a surface sees it: this device's memory for the container, then the
 * composed default, then null — which the server reads as "wherever you like" and answers
 * with its own selection rule. `machines === null` is "the inventory has not arrived", and it
 * answers null rather than guessing.
 */
const terminalFacet: TerminalFacet = {
  View: TerminalView,
  defaultMachine: (containerId, machines): MachineSummary | null =>
    machines === null
      ? null
      : chooseDefaultMachine(machines, recallMachine(browserMachineStorage(), containerId)),
  rememberMachine: (containerId, machineId) =>
    rememberMachine(browserMachineStorage(), containerId, machineId),
};

export const terminalsWebPlugin = {
  id: "core.terminals",
  terminals: terminalFacet,
};
