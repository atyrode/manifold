import type { WebBinding } from "@manifold/plugin";
import { toggleArranging, toggleZoneProbe } from "@manifold/plugin/ui";
import { shellManifest } from "./index.ts";

/**
 * `core.shell`, browser half — the two panels the workspace tree is built from, plus the keys
 * the workspace itself answers to.
 *
 * THE PANELS LIVE HERE NOW, and that is the shell's carve-out ending rather than a file move.
 * Both were floor while the sidebar needed a read of the live composition that no plugin had a
 * door for; `host.assembly` is that door, declared and read-only, so the argument for the
 * exception expired and the components followed their manifest (A1, invariant 12). The floor
 * keeps only what a shell genuinely owns — the tile layout, the workspace index, and the two
 * contexts it publishes above the tree.
 *
 * `packages/web/src/assembly.ts` is still the one file that ATTACHES these to the manifest ids
 * the server's roster published; nothing here knows it is being registered.
 */
export { ContainerViewPanel } from "./container-view-panel.tsx";
export { SidebarPanel } from "./sidebar-panel.tsx";
/**
 * THE RAIL'S OWN ROWS, exported beside the panel that stacks them — and reached the same way
 * every other plugin's section is, through the registration in the web package's
 * `assembly.ts`. The panel does NOT import them: it asks the projection registry for the
 * component behind a section id, so `core.shell`'s four rows arrive by exactly the route a
 * stranger's rows do, and the shell has no privileged path into its own sidebar.
 */
export { BrandRow } from "./brand-row.tsx";
export { IdentityRow } from "./identity-row.tsx";
export { KeysRow } from "./keys-row.tsx";
export { StatusRow } from "./status-row.tsx";

/**
 * The shell's BROWSER half: the keys the workspace itself answers to.
 *
 * A binding row is a DECLARATION — key, label, scope — and the handler beside it is the shell's
 * own; the row holds no authority, so anything that mutates goes through a registered action at
 * its commit point (`@manifold/plugin`'s `BindingDef`). Declaring them here rather than
 * installing listeners wherever the behavior lives is what makes the keys collide loudly across
 * plugins, print in the sidebar's help table, and stop answering when a plugin is disabled.
 *
 * Ids are built from `shellManifest.id` rather than spelled: a binding is namespaced by its
 * owner exactly as an action name is, and composition refuses a row that is not.
 */
export const SHELL_BINDINGS: readonly WebBinding[] = [
  /*
    Arrange mode: the workspace's own panes become grabbable. The mode is published view state
    (`vantage.arranging`), so the handler is the vantage store's toggle and nothing here holds
    the flag — a second copy of "is this device arranging" is the drift invariant 14 forbids.
    Escape-to-exit is deliberately NOT a row: every mode's universal "never mind" belongs to
    whatever is armed at the moment, and a table row would claim it against every dialog too.
  */
  {
    id: `${shellManifest.id}.arrange`,
    key: "F8",
    label: "Arrange mode",
    when: "always",
    run: toggleArranging,
  },
  /*
    The drop-zone probe: a debug painting of what the drop resolver answers across a tile area.
    It reads as `always` because both disciplines hold tile areas — a composition's own tree and
    a canvas widget's — and the probe simply has nothing to paint anywhere else.
  */
  {
    id: `${shellManifest.id}.zone-probe`,
    key: "F9",
    label: "Drop-zone probe",
    when: "always",
    run: toggleZoneProbe,
  },
];
