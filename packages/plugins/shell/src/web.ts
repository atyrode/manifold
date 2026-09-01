/**
 * `core.shell`, browser half — the two panels the workspace tree is built from, and the rail
 * rows it fills in its own sidebar.
 *
 * THE PANELS LIVE HERE NOW, and that is the shell's carve-out ending rather than a file move.
 * Both were floor while the sidebar needed a read of the live composition that no plugin had a
 * door for; `host.assembly` is that door, declared and read-only, so the argument for the
 * exception expired and the components followed their manifest (A1, invariant 12). The floor
 * keeps only what a shell genuinely owns — the tile layout, the workspace index, and the two
 * contexts it publishes above the tree.
 *
 * IT CLAIMS NO KEYS ANY MORE, and that is the shell shedding what was never its own rather
 * than a shrunken registration. Two binding rows lived here: arrange mode's F8, which left with
 * the rest of arrange mode for `core.arrange` (issue #89), and the drop-zone probe's F9, which
 * left for `core.debug` (issue #90) — a probe is an instrument you bring TO the workspace frame,
 * and the shell owns the frame. `SHELL_BINDINGS` is deleted rather than left empty: an exported
 * empty table is a claim that the shell has keys to declare, and it has none.
 *
 * `packages/web/src/assembly.ts` is still the one file that ATTACHES these to the manifest ids
 * the server's roster published; nothing here knows it is being registered.
 */
export { ContainerViewPanel } from "./container-view-panel.tsx";
export { SidebarPanel } from "./sidebar-panel.tsx";
/**
 * THE RAIL ROWS IT STILL OWNS, exported beside the panel that stacks them — and reached the
 * same way every other plugin's section is, through the registration in the web package's
 * `assembly.ts`. The panel does NOT import them: it asks the projection registry for the
 * component behind a section id, so `core.shell`'s rows arrive by exactly the route a
 * stranger's rows do, and the shell has no privileged path into its own sidebar.
 *
 * TWO ROWS LEFT WITH THEIR SEATS: the brand line is `@manifold-plugin/brand` and the key table
 * is `@manifold-plugin/keys`, each an essential seat of its own (issue #91). What remains is
 * what the shell itself answers for — its connection, and this device's identity.
 */
export { IdentityRow } from "./identity-row.tsx";
export { StatusRow } from "./status-row.tsx";


