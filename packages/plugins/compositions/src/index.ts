import { type PluginManifest } from "@manifold/protocol";

/**
 * THE TILED DISCIPLINE, as a plugin. A container is either a canvas or a composition; this
 * plugin owns the second half — the recursive tile tree over a room's layout key, the drop
 * gestures that land things in it, and the leaf chrome each occupant wears.
 *
 * It contributes no panel, section, element or tool, and that is not an empty manifest hiding
 * something: what it registers is a PAD SURFACE — the renderer for containers whose
 * `layout` is `tiled` — through the browser-only projection channel
 * (`@manifold/plugin/hooks`' `ProjectionRegistry`, `WebPluginDef.padSurfaces`). A pad surface
 * has no manifest row for the same reason a route has none: it is not a surface the WORKSPACE
 * composes, so no principal's layout and no sidebar order can name it. The roster still owns
 * the vocabulary that matters — whether this plugin is ENABLED — and disabling it makes every
 * tiled container paint the engine's named placeholder instead of a blank pane (ADR 0013 §4),
 * exactly as disabling `core.canvas` does for canvases.
 *
 * It declares no actions either, and the reason is the plane rule (D6) rather than
 * incompleteness: everything structural a composition does is already somebody's door.
 * Landing, moving and evicting an occupant is `core.layout.place`; removing a leaf is the
 * engine's own tile door; a divider drag is a ratio write straight into the document, because
 * its worst-case merge is a pane that ends up a few percent off. What is left for this plugin
 * is projection and gesture, which is precisely what a renderer is.
 *
 * `scene:write` is what a viewer needs in order to move a divider or author a leaf's occupant,
 * declared here because that is the authority this plugin's surface exercises even though it
 * dispatches nothing of its own.
 */
export const compositionsManifest: PluginManifest = {
  id: "core.compositions",
  version: "1.0.0",
  title: "Compositions",
  description:
    "The tiled container renderer: the tile tree, its drop and carry gestures, and the leaf chrome every occupant wears.",
  capabilities: ["scene:write"],
  contributes: {
    panels: [],
    sections: [],
    elements: [],
    tools: [],
    events: [],
  },
};
