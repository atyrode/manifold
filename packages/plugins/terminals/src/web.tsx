/**
 * `core.terminals`, browser half — one door onto everything a client needs in order to show
 * and reason about terminals.
 *
 * This plugin registers no COMPONENT in `packages/web/src/composition.ts`, and that is the
 * registry working rather than failing: terminals contribute no panel, section, element or
 * tool. What they contribute is doors (`src/index.ts`) plus the browser surfaces behind this
 * barrel, and the canvas and tiled renderers that mount those surfaces are themselves still
 * floor until `core.canvas` and `core.compositions`. Their imports of this module are the
 * visible remainder of that migration, not a design — the same shape
 * `@manifold-plugin/presence/web` already wears.
 *
 * Three surfaces, one concept each:
 *
 *   `TerminalView`       the viewer for one PTY: chrome, controls, focus presence, restart.
 *   `buildSessionRows`   the janitor projection — which terminals a caller can see and act on,
 *                        with `canKill` computed from the kill door's own rule.
 *   machine choice       per-pad, per-device memory of which machine a terminal is born on,
 *                        plus the default-machine policy.
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
