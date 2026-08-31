import { drawWebPlugin } from "@manifold-plugin/draw/web";
import { MachinesSection } from "@manifold-plugin/machines/web";
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
 * failing: `core.layout` contributes no panel, section, element or tool — it is one action
 * door over the workspace tree — while `core.terminals` and `core.presence` contribute only
 * actions this wave. Their affordances are floor chrome that dispatches those actions BY NAME,
 * which is why the door is vocabulary and not a component; the registry tags that chrome
 * `"until": "core.terminals"` / `"until": "core.presence"` so the remaining migration stays
 * visible.
 */
export const WEB_PLUGIN_DEFS: readonly WebPluginDef[] = [
  { id: "core.shell", panels: { sidebar: SidebarPanel, "pad-view": PadViewPanel } },
  { id: "core.views", sections: { views: ViewsSection } },
  { id: "core.machines", sections: { machines: MachinesSection } },
  { id: "core.plugins", sections: { plugins: PluginManagerSection } },
  drawWebPlugin,
  uriWebPlugin,
];
