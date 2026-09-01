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
      {
        id: "new-composition",
        title: "New composition",
        order: 3,
        presentation: "plain",
        setting: "new-composition",
      },
    ],
    /**
     * AND ONE PREFERENCE OVER IT (#133), the exact counterpart of `core.canvas`'s: the offer
     * is gated on a declared boolean, dropped from the rail per principal when it reads
     * false, and shipped `true`. The discipline, its renderer and every composition in the
     * workspace are untouched by it — this is a row's visibility, not a disable.
     */
    settings: [{ id: "new-composition", title: "New composition", kind: "boolean", default: true }],
    elements: [],
    /**
     * THE `composition` DISCIPLINE, declared (#110, building the ruling ratified on #86),
     * and the exact counterpart of `core.canvas`'s. These rows were literals in
     * `packages/protocol/src/placement.ts` until this wave — which is what made the
     * renderer roster closed at the wire — and are transcribed verbatim;
     * `packages/protocol/test` pins that the composed result matches what the floor held.
     *
     * Note the id is `composition` while this plugin is `core.compositions`. That mismatch
     * is the counterexample that retired the "value IS the plugin's last id segment"
     * invariant, and `packages/protocol/src/layout.ts` records the ruling: who renders a
     * discipline is answered by the assembly's registry, not by a spelling.
     *
     * `item` — the old `ITEM_KINDS.composition` — is the whole of "compositions MERGE,
     * never nest": no `tileable`, so no composition enters another's tree; `mergeable` plus
     * `solo_only`, so a composition holding exactly ONE item is absorbed AS that item and
     * one holding several or none is refused by name.
     *
     * `accepts` — the old `CONTAINER_KINDS.composition` — is what a tile tree takes, and
     * `destinations: ["tile"]` is the old `requires` column from this side: the only form
     * that points into a composition is the one that names a leaf.
     */
    disciplines: [
      {
        id: "composition",
        title: "Composition",
        item: {
          groups: ["mergeable", "unplaceable", "canvas_item_as_portal"],
          guards: ["no_self_embed", "solo_only"],
          homed: "inline",
        },
        accepts: ["tileable", "mergeable"],
        guards: ["discipline_match"],
        destinations: ["tile"],
      },
    ],
    tools: [],
    events: [],
  },
};
