import { drawWebPlugin } from "@manifold-plugin/draw/web";
import { MachinesSection } from "@manifold-plugin/machines/web";
import { notesWebPlugin } from "@manifold-plugin/notes/web";
import { PluginManagerSection } from "@manifold-plugin/plugin-manager/web";
import { uriWebPlugin } from "@manifold-plugin/uri/web";
import { ViewsSection } from "@manifold-plugin/views/web";
import { PadViewPanel } from "./pad-view-panel.tsx";
import { SidebarPanel } from "./sidebar-panel.tsx";
import type { WebPluginDef } from "./plugin-host.tsx";

/**
 * THE registration file, and the ONE file in `packages/web/src` allowed to name
 * `@manifold-plugin/*` (AXIOMS.md §Foundation; `verify:axioms` S2 asserts the exception is
 * exactly this file). Everything below it is engine floor that must not know a plugin exists;
 * everything above it is a plugin that must not know the engine's internals.
 *
 * A registration only ATTACHES components to names the SERVER's roster already published: the
 * roster is the vocabulary (which plugins exist, whether each is enabled, what each declares),
 * and this list is the browser's answer to "who draws it". Attaching a panel nobody declared
 * contributes nothing; a declared panel with no attachment renders a named placeholder.
 *
 * The shell's own two panels are FLOOR components (`sidebar-panel.tsx`, `pad-view-panel.tsx`)
 * attached to `core.shell`'s declared ids. That is deliberate and not a loophole: the sidebar
 * chrome reads the composition to know which sections exist, and the pad view still holds the
 * canvas/tiled renderers until `core.canvas` and `core.compositions` decompose them. The
 * manifest still owns the vocabulary, so disabling the shell (refused — it is `essential`)
 * would blank those panes exactly like any other plugin's.
 *
 * Three composed plugins register NOTHING here, and that is the registry working rather than
 * failing: a registration attaches COMPONENTS, and these three contribute none. `core.layout`
 * is one action door over the workspace tree. `core.presence` owns a package full of browser
 * code — the cursor overlay, remote gesture overrides, the roster island, the spotlight
 * receipt — but every piece of it is a module the canvas and tiled renderers IMPORT, not a
 * panel, section, element or tool the composition mounts; those renderers are themselves floor
 * until `core.canvas` and `core.compositions`, and their imports of
 * `@manifold-plugin/presence/web` are the visible remainder of that migration rather than a
 * design. `core.terminals` is now exactly the same shape: its browser half
 * (`@manifold-plugin/terminals/web` — the terminal viewer, the janitor projection, machine
 * choice) is imported by those same two renderers, and its doors are dispatched by name from
 * the chrome around them. Neither plugin contributes a mountable slot, so neither has a row
 * below; when `core.canvas` and `core.compositions` land, both sets of imports become
 * plugin-to-plugin questions instead of floor-to-plugin ones.
 */
export const WEB_PLUGIN_DEFS: readonly WebPluginDef[] = [
  { id: "core.shell", panels: { sidebar: SidebarPanel, "pad-view": PadViewPanel } },
  { id: "core.views", sections: { views: ViewsSection } },
  { id: "core.machines", sections: { machines: MachinesSection } },
  { id: "core.plugins", sections: { plugins: PluginManagerSection } },
  drawWebPlugin,
  notesWebPlugin,
  uriWebPlugin,
];
