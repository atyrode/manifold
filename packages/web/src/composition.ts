import type { WebPluginDef } from "./plugin-host.tsx";

/**
 * THE web registration point — and, with `packages/server/src/composition.ts`, one of the
 * only two files in the tree permitted to import `@manifold-plugin/*` (AXIOMS.md §Foundation,
 * enforced by `verify:axioms`). Everything else reaches plugins through the composition the
 * host derives from this list and the server's roster.
 *
 * The core plugins (`core.shell`, `core.machines`, `core.views`, `core.plugins`,
 * `core.terminals`, `core.draw`, `core.presence`, `core.uri`) register their web halves here
 * as their packages land. An empty list is a legal composition: every declared panel simply
 * renders a named placeholder, which is exactly the behaviour a plugin-less browser should
 * have.
 */
export const WEB_PLUGIN_DEFS: readonly WebPluginDef[] = [];
