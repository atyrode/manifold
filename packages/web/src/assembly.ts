import { canvasWebPlugin } from "@manifold-plugin/canvas/web";
import { compositionsWebPlugin } from "@manifold-plugin/compositions/web";
import { drawWebPlugin } from "@manifold-plugin/draw/web";
import { MachinesSection } from "@manifold-plugin/machines/web";
import { notesWebPlugin } from "@manifold-plugin/notes/web";
import { PluginManagerSection } from "@manifold-plugin/plugin-manager/web";
import { presenceWebPlugin } from "@manifold-plugin/presence/web";
import { terminalsWebPlugin } from "@manifold-plugin/terminals/web";
import { uriWebPlugin } from "@manifold-plugin/uri/web";
import { IndexSection } from "@manifold-plugin/index/web";
import { indexManifest } from "@manifold-plugin/index";
import { machinesManifest } from "@manifold-plugin/machines";
import { presenceManifest } from "@manifold-plugin/presence";
import { shellManifest, spaceManifest } from "@manifold-plugin/shell";
import { terminalsManifest } from "@manifold-plugin/terminals";
import { panelRefId, type FeedTopics, type WorkspacePanels } from "@manifold/plugin";
import { ContainerViewPanel } from "./container-view-panel.tsx";
import { SidebarPanel } from "./sidebar-panel.tsx";
import type { WebPluginDef } from "./plugin-host.tsx";

/**
 * WHICH panels a default workspace tree is built from, for the browser's own boot fallback —
 * the one datum the floor's `workspaceLayout()` cannot know and must be handed.
 *
 * It lives here because this is the only file in `packages/web/src` allowed to name a plugin,
 * and a panel id IS a plugin's name: `core.shell.sidebar` is `core.shell`'s, spelled in the
 * same `<pluginId>.<panelId>` join the assembly claims panels under (`panelRefId`, so the
 * rule has one implementation). `workspace.tsx` reads it from here and is a sibling floor file
 * consuming exported data, which is the sanctioned direction; `workspace.tsx` spelling the
 * ids itself would make the shell's boot path name a favorite plugin, which is the neutrality
 * criterion of AXIOMS.md §Foundation law. The server's `assembly.ts` holds the matching pair
 * for the stored-layout default, and `verify:axioms` (S1) asserts both resolve.
 */
export const WORKSPACE_PANELS: WorkspacePanels = {
  sidebar: panelRefId(shellManifest.id, "sidebar"),
  main: panelRefId(shellManifest.id, "container-view"),
};

/**
 * WHICH NODES each shared feed subscribes to (ADR 0012). Every entry is a COLLECTION — a
 * plugin's own node — and each member lists every node that MOVES that reading, not only
 * its owner's. Two of them move readings that are not their own, and both are here because
 * the reading would otherwise go stale in a way no cadence is left to cover:
 *
 *   `core.space` — a placement commit births solo compositions, absorbs the emptied ones,
 *     and re-flags terminals, because `unplaced` is DERIVED from the containment graph. So
 *     the index and both terminal readings watch the spatial door's node beside their owners'.
 *   `core.terminals` — a terminal is BORN with a home composition and takes it away when it
 *     is killed (`createHome`, `dropContainer`), so a terminal's lifecycle adds and removes
 *     rows at the index's own top level.
 *
 * One subscription per node, rather than one per container, because all four answers are
 * workspace-wide readings taken from chrome outside every room they report on — which is also
 * why a node-addressed event never reaches them and the server delivers every emission to its
 * door's collection as well (`EventHub.fanOut`).
 *
 * It lives here for the same reason `WORKSPACE_PANELS` does, and it is the browser's exact
 * counterpart of the server's `FLOOR_EVENT_OWNERS`: a topic is `manifold://plugin/<owner>`,
 * so writing one is naming a plugin, and this is the only file in `packages/web/src` allowed
 * to (`verify:axioms` S2). The floor shell reads it from here as a sibling floor file; the
 * sections read it off `host.topics`, since a plugin may not name another plugin either.
 * Swapping in a stranger's terminals plugin is one line, here.
 */
export const FEED_TOPICS: FeedTopics = {
  index: [
    { kind: "plugin", pluginId: indexManifest.id },
    { kind: "plugin", pluginId: spaceManifest.id },
    { kind: "plugin", pluginId: terminalsManifest.id },
  ],
  terminals: [
    { kind: "plugin", pluginId: terminalsManifest.id },
    { kind: "plugin", pluginId: spaceManifest.id },
  ],
  attendance: [{ kind: "plugin", pluginId: presenceManifest.id }],
  machines: [{ kind: "plugin", pluginId: machinesManifest.id }],
};

/**
 * THE registration file, and the ONE file in `packages/web/src` allowed to name
 * `@manifold-plugin/*` (REGISTRY.md §Foundation; `verify:axioms` S2 asserts the exception is
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
 * because the canvas and composition renderers were floor and simply IMPORTED them. Both renderers
 * are plugins now, plugins may not import each other, and so every one of those reaches
 * matches a row below:
 *
 *   `core.canvas` / `core.compositions` register CONTAINER REFS, keyed by container discipline.
 *     Neither declares a panel: a renderer is reached by layout, and the routed shell and a
 *     tile leaf embedding a canvas ask for it identically.
 *   `core.terminals` registers the TERMINAL FACET — the viewer plus the machine-choice policy
 *     a ref needs in order to offer "new terminal" — instead of exporting a component two
 *     renderers imported.
 *   `core.presence` registers OVERLAYS: who is here, and the spotlight consent chip. What a
 *     ref paints in its own coordinate space (cursors, carry ghosts, selection outlines)
 *     it paints from engine plane mechanism, which is invariant 11 rather than a registration.
 *
 * The shell's own two panels stay FLOOR components (`sidebar-panel.tsx`, `container-view-panel.tsx`)
 * attached to `core.shell`'s declared ids, and that is not a loophole: the sidebar chrome reads
 * the composition to know which sections exist, and the container view resolves a route to a
 * discipline and asks the registry for it. Neither knows how anything is drawn.
 */
export const WEB_PLUGIN_DEFS: readonly WebPluginDef[] = [
  { id: "core.shell", panels: { sidebar: SidebarPanel, "container-view": ContainerViewPanel } },
  { id: "core.index", sections: { index: IndexSection } },
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
