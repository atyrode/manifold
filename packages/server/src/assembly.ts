import { accessActions, accessManifest } from "@manifold-plugin/access";
import { accessHandlers } from "@manifold-plugin/access/server";
import { canvasManifest } from "@manifold-plugin/canvas";
import { compositionsManifest } from "@manifold-plugin/compositions";
import { drawManifest } from "@manifold-plugin/draw";
import { machinesActions, machinesManifest } from "@manifold-plugin/machines";
import { machinesHandlers } from "@manifold-plugin/machines/server";
import { notesManifest } from "@manifold-plugin/notes";
import { pluginManagerManifest } from "@manifold-plugin/plugin-manager";
import { presenceActions, presenceManifest } from "@manifold-plugin/presence";
import { presenceHandlers } from "@manifold-plugin/presence/server";
import { spaceActions, spaceManifest, shellManifest } from "@manifold-plugin/shell";
import { spaceHandlers } from "@manifold-plugin/shell/server";
import { terminalsActions, terminalsManifest } from "@manifold-plugin/terminals";
import { terminalsHandlers } from "@manifold-plugin/terminals/server";
import { uriManifest } from "@manifold-plugin/uri";
import { indexActions, indexManifest } from "@manifold-plugin/index";
import { indexHandlers } from "@manifold-plugin/index/server";
import type { ServerPluginDef } from "./plugin-host.ts";

/**
 * THE registration point, and the only server file allowed to import `@manifold-plugin/*`
 * (AXIOMS.md floor registry, enforced by `verify:axioms`). Everything above the floor
 * arrives here or does not exist.
 *
 * This table is the input to the ASSEMBLY: the join the host computes over the enabled
 * roster, turning a list of plugin definitions into one vocabulary of actions, panels,
 * elements and sections. Nothing named here is in the assembly by virtue of being listed —
 * it is a candidate the roster admits or an administrator disables.
 *
 * This is also where the sandbox shape is CHECKED. Each plugin's handlers are typed against
 * minimal structural slices declared inside the plugin — `{ broker: { rename(...) } }`,
 * `{ rooms: { sharedContainerIds(...) } }` — and assigning them into `ServerPluginDef` here
 * is what proves those slices are satisfied by the real `ActionCtx`. A plugin that widens
 * its demands fails this assignment rather than quietly reaching further into the server.
 */
export const SERVER_PLUGIN_DEFS: readonly ServerPluginDef[] = [
  // The shell contributes the two panels every workspace layout is built from and declares
  // no actions: chrome is not authority.
  { manifest: shellManifest, actions: [], handlers: {} },
  { manifest: spaceManifest, actions: spaceActions, handlers: spaceHandlers },
  // The plugin manager is a UI over the assembly and owns no door: enablement and purge
  // are the ENGINE's builtin row (`engine.plugins`), registered by the host itself rather
  // than here, because administration of the assembly cannot be a member of it.
  { manifest: pluginManagerManifest, actions: [], handlers: {} },
  { manifest: terminalsManifest, actions: terminalsActions, handlers: terminalsHandlers },
  { manifest: presenceManifest, actions: presenceActions, handlers: presenceHandlers },
  { manifest: accessManifest, actions: accessActions, handlers: accessHandlers },
  // The index owns both halves: the sidebar section that lists everything, and the doors
  // that create, rename, delete and move it.
  { manifest: indexManifest, actions: indexActions, handlers: indexHandlers },
  // The fleet owns both halves too: the section that lists it, and the doors that read the
  // inventory and enroll into it.
  { manifest: machinesManifest, actions: machinesActions, handlers: machinesHandlers },
  /*
    Browser-only plugins, registered here all the same: the ROSTER is what publishes a
    plugin's existence, its title and its contributions, and what an administrator toggles.
    A plugin the server never heard of cannot be named in a placeholder, cannot be disabled,
    and its element type would read as "unknown plugin" on every canvas.
  */
  { manifest: drawManifest, actions: [], handlers: {} },
  { manifest: notesManifest, actions: [], handlers: {} },
  { manifest: uriManifest, actions: [], handlers: {} },
  // The two container renderers are browser-only for the same reason: what they draw is a
  // projection, and every write they make is somebody else's declared door.
  { manifest: canvasManifest, actions: [], handlers: {} },
  { manifest: compositionsManifest, actions: [], handlers: {} },
];
