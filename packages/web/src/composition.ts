import { canvasWebPlugin } from "@manifold-plugin/canvas/web";
import { compositionsWebPlugin } from "@manifold-plugin/compositions/web";
import { drawWebPlugin } from "@manifold-plugin/draw/web";
import { MachinesSection } from "@manifold-plugin/machines/web";
import { notesWebPlugin } from "@manifold-plugin/notes/web";
import { PluginManagerSection } from "@manifold-plugin/plugin-manager/web";
import { presenceWebPlugin } from "@manifold-plugin/presence/web";
import { terminalsWebPlugin } from "@manifold-plugin/terminals/web";
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
 * THE LIST IS NOW THE WHOLE STORY, and that is the conversion finishing rather than a tidy-up.
 * Until this wave two plugins registered nothing here while owning piles of browser code,
 * because the canvas and tiled renderers were floor and simply IMPORTED them. Both renderers
 * are plugins now, plugins may not import each other, and so every one of those reaches
 * matches a row below:
 *
 *   `core.canvas` / `core.compositions` register PAD SURFACES, keyed by container discipline.
 *     Neither declares a panel: a renderer is reached by layout, and the routed shell and a
 *     tile leaf embedding a board ask for it identically.
 *   `core.terminals` registers the TERMINAL FACET — the viewer plus the machine-choice policy
 *     a surface needs in order to offer "new terminal" — instead of exporting a component two
 *     renderers imported.
 *   `core.presence` registers OVERLAYS: who is here, and the spotlight consent chip. What a
 *     surface paints in its own coordinate space (cursors, carry ghosts, selection outlines)
 *     it paints from engine plane mechanism, which is invariant 11 rather than a registration.
 *
 * The shell's own two panels stay FLOOR components (`sidebar-panel.tsx`, `pad-view-panel.tsx`)
 * attached to `core.shell`'s declared ids, and that is not a loophole: the sidebar chrome reads
 * the composition to know which sections exist, and the pad view resolves a route to a
 * discipline and asks the registry for it. Neither knows how anything is drawn.
 */
export const WEB_PLUGIN_DEFS: readonly WebPluginDef[] = [
  { id: "core.shell", panels: { sidebar: SidebarPanel, "pad-view": PadViewPanel } },
  { id: "core.views", sections: { views: ViewsSection } },
  { id: "core.machines", sections: { machines: MachinesSection } },
  { id: "core.plugins", sections: { plugins: PluginManagerSection } },
  canvasWebPlugin,
  compositionsWebPlugin,
  drawWebPlugin,
  notesWebPlugin,
  presenceWebPlugin,
  terminalsWebPlugin,
  uriWebPlugin,
];
