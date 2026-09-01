import { type PluginManifest } from "@manifold/protocol";

/**
 * THE TILED DISCIPLINE, as a plugin. A container is either a canvas or a composition; this
 * plugin owns the second half — the recursive tile tree over a room's layout key, the drop
 * gestures that land things in it, and the leaf chrome each occupant wears.
 *
 * It contributes no panel, no element and no tool, and ONE section — the rail's creator for
 * its own discipline. What it does not contribute is the thing it is mostly made of: a
 * CONTAINER REF — the renderer for containers whose `discipline` is `composition` — reaches
 * the product through the browser-only projection channel (`@manifold/plugin/hooks`'
 * `ProjectionRegistry`, `WebPluginDef.renderers`) instead of a manifest row. A container ref
 * has no row for the same reason a route has none: it is not a ref the WORKSPACE composes, so
 * no principal's layout and no sidebar order can name it. The roster still owns the vocabulary
 * that matters — whether this plugin is ENABLED — and disabling it makes every composition
 * paint the engine's named placeholder instead of a blank pane (ADR 0013 §4), exactly as
 * disabling `core.canvas` does for canvases, and takes the creator row down with it.
 *
 * It declares no actions either, and the reason is the plane rule (D6) rather than
 * incompleteness: everything structural a composition does is already somebody's door.
 * Landing, moving and evicting an occupant is `core.space.place`; removing a leaf is
 * `core.space.removeTile`; a divider drag is a ratio write straight into the document, because
 * its worst-case merge is a pane that ends up a few percent off. What is left for this plugin
 * is projection and gesture, which is precisely what a renderer is.
 *
 * `scenes:write` is what a viewer needs in order to move a divider or author a leaf's occupant,
 * declared here because that is the authority this plugin's ref exercises even though it
 * dispatches nothing of its own.
 */
export const compositionsManifest: PluginManifest = {
  id: "core.compositions",
  version: "1.0.0",
  title: "Compositions",
  description:
    "The composition renderer: the tile tree, its drop and carry gestures, and the leaf chrome every occupant wears.",
  capabilities: ["scenes:write"],
  contributes: {
    panels: [],
    /**
     * ONE ROW: the rail's "New composition" — this discipline's own creator, and the exact
     * counterpart of `core.canvas`'s. It contributes a section while contributing no panel,
     * which is not an inconsistency: a RENDERER is reached by layout and has no manifest row,
     * while an offer to CREATE something is chrome somebody stacks, so it is ordered like all
     * other chrome. `order: 3` seats it directly under the canvas creator, where the rail's
     * hand-written pair used to sit.
     */
    sections: [
      { id: "new-composition", title: "New composition", order: 3, presentation: "plain" },
    ],
    elements: [],
    tools: [],
    events: [],
  },
};
