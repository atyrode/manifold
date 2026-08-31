import { pluginManagerActions, pluginManagerManifest } from "@manifold-plugin/plugin-manager";
import { pluginManagerHandlers } from "@manifold-plugin/plugin-manager/server";
import { presenceActions, presenceManifest } from "@manifold-plugin/presence";
import { presenceHandlers } from "@manifold-plugin/presence/server";
import { layoutActions, layoutManifest, shellManifest } from "@manifold-plugin/shell";
import { layoutHandlers } from "@manifold-plugin/shell/server";
import { terminalsActions, terminalsManifest } from "@manifold-plugin/terminals";
import { terminalsHandlers } from "@manifold-plugin/terminals/server";
import type { ServerPluginDef } from "./plugin-host.ts";

/**
 * THE registration point, and the only server file allowed to import `@manifold-plugin/*`
 * (AXIOMS.md floor registry, enforced by `verify:axioms`). Everything above the floor
 * arrives here or does not exist.
 *
 * This is also where the sandbox shape is CHECKED. Each plugin's handlers are typed against
 * minimal structural slices declared inside the plugin — `{ broker: { rename(...) } }`,
 * `{ rooms: { sharedPadIds(...) } }` — and assigning them into `ServerPluginDef` here is
 * what proves those slices are satisfied by the real `ActionCtx`. A plugin that widens its
 * demands fails this assignment rather than quietly reaching further into the server.
 */
export const SERVER_PLUGIN_DEFS: readonly ServerPluginDef[] = [
  // The shell contributes the two panels every workspace layout is built from and declares
  // no actions: chrome is not authority.
  { manifest: shellManifest, actions: [], handlers: {} },
  { manifest: layoutManifest, actions: layoutActions, handlers: layoutHandlers },
  {
    manifest: pluginManagerManifest,
    actions: pluginManagerActions,
    handlers: pluginManagerHandlers,
  },
  { manifest: terminalsManifest, actions: terminalsActions, handlers: terminalsHandlers },
  { manifest: presenceManifest, actions: presenceActions, handlers: presenceHandlers },
];
