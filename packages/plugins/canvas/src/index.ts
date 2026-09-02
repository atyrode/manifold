import { type PluginManifest } from "@manifold/protocol";

/**
 * The infinite canvas, as a plugin — `core.canvas`.
 *
 * This is the renderer half of what used to be `core.shell.container-view`: the React Flow
 * projection boundary, the node-type map, the viewport and its per-container camera memory, the
 * tool strip, portal portals, and the gesture wiring that turns a pointer into document
 * traffic. It is one of the two plugins that decompose that panel (`core.compositions` is the
 * other), and after it there is no renderer left in the floor.
 *
 * THERE ARE NO ACTIONS, and that is the plane rule (D6) rather than an omission. Everything a
 * canvas does to a canvas is a per-element edit of the room's scene document: authoring a
 * note or a stroke, moving a box, resizing one, tombstoning one. Legality depends on nothing
 * the author cannot see and the worst-case merge is two people's edits both surviving, so it
 * is DOCUMENT traffic. Everything the canvas does that ISN'T a document edit already belongs
 * to somebody else's door and is dispatched by name: `core.terminals.rename` from a portal
 * titlebar, `core.views` for a container's life, `core.space.place` for every placement. A
 * canvas action would be a second door onto one of those (invariant 14).
 *
 * `scenes:write` is declared for the same reason `core.draw` and `core.notes` declare it: it is
 * the capability a viewer needs in order to author into a room, even though nothing here
 * dispatches an action.
 *
 * WHAT IT CONTRIBUTES, and what it deliberately does not:
 *
 * `tools` — `select` and `text` are the canvas's own two modes, declared here rather than left
 * as anonymous chrome so the vocabulary is READABLE: an agent asking `GET /api/plugins` sees
 * every mode the ref offers, not just the ones other plugins added. `core.draw`'s tool
 * arrives through the same registry, which is why the strip has no literal naming it.
 *
 * No `panels`. A container renderer is reached by LAYOUT, through the projection's container-ref
 * registry (`renderers` in the browser half): the routed shell asks for the ref of the
 * container it is showing, and a composition's tile leaf asks for exactly the same thing when
 * it embeds a canvas. One door onto "project a container of this discipline", used identically by
 * both — a panel row beside it would be a second door onto the same concept.
 *
 * No `elements`. The canvas paints two species that are not content: `portal`, which is
 * ADDRESSING — the projection of one container inside another — and nothing else. Its wire
 * schema stays protocol vocabulary and its renderer is the canvas's own, not a contribution
 * routed through the engine's element frame, because the engine's frame exists to give a
 * STRANGER's element a resizer and a commit path, and the canvas needs neither for its own
 * addressing species. Content elements — `text`, `draw` — belong to `core.notes` and
 * `core.draw`, and reach this ref through the element registry like any other plugin's.
 */
export const canvasManifest: PluginManifest = {
  id: "core.canvas",
  version: "1.0.0",
  title: "Canvas",
  description:
    "The infinite canvas: the React Flow renderer, portal portals, the tool strip and per-container camera memory.",
  capabilities: ["scenes:write"],
  contributes: {
    panels: [],
    /**
     * ONE ROW: the rail's "New canvas". A creator is an opinion about a DISCIPLINE, so it
     * belongs to the discipline's plugin rather than to whoever draws the rail — disable this
     * plugin and the offer to make a canvas goes with it (D4′), which is the reading the
     * shell's hand-written button could never give. `plain`, because a creator is a control
     * and not a collapsible block, and `order: 2` puts it where it has always been: under the
     * brand line, above the composition creator (`core.compositions`, `order: 3`).
     */
    sections: [
      {
        id: "new-canvas",
        title: "New canvas",
        order: 2,
        presentation: "plain",
        setting: "new-canvas",
      },
    ],
    /**
     * AND ONE PREFERENCE OVER IT (#133). A creator is an offer, and an offer a reader has
     * stopped needing should be theirs to put away — so the row is gated on a declared
     * boolean, dropped from the rail when it reads false and back when it does not, per
     * principal. `true` because that is what shipped; the operator's defaults-design pass
     * decides whether any row starts off.
     *
     * It is NOT a disable in miniature. Turning this off leaves `core.canvas` composed,
     * enabled and rendering every canvas in the workspace: what goes away is one button in
     * one rail, for one reader, and nothing else it contributes notices.
     */
    settings: [{ id: "new-canvas", title: "New canvas", kind: "boolean", default: true }],
    elements: [],
    /**
     * THE `canvas` DISCIPLINE, declared (#110, building the ruling ratified on #86). Until
     * this wave the placement algebra held these rows as literals in
     * `packages/protocol/src/placement.ts`, which is what made the renderer roster closed
     * at the wire; they are transcribed here verbatim, and `packages/protocol/test` pins
     * that the composed result is the same table the floor used to hold.
     *
     * `item` is what a CANVAS IS when it is the thing being dragged — the old
     * `ITEM_KINDS.canvas`. It tiles, it embeds live inside another container, it can always
     * be un-referenced without ceasing to exist, and it appears on another canvas as a
     * portal rather than as a copy. `no_self_embed` is the one rule containment cannot
     * state: a canvas never embeds itself, however the drop addresses it.
     *
     * `accepts` is what a canvas TAKES — the old `CONTAINER_KINDS.canvas`: free-floating
     * furniture, anything that can appear as a portal onto itself, and a tile pulled out of
     * some composition.
     *
     * `destinations` is the old `DESTINATION_KINDS[...].requires` column read from this
     * side: the `canvas` form points AT a canvas, and `compose` HOSTS the merge it authors
     * on one. A `tile` drop is refused here by the `discipline_match` guard rather than by
     * group containment, which is why the refusal says "cannot be placed that way" instead
     * of "does not go in".
     */
    disciplines: [
      {
        id: "canvas",
        title: "Canvas",
        item: {
          groups: ["tileable", "embeddable", "unplaceable", "canvas_item_as_portal"],
          guards: ["no_self_embed"],
          homed: "inline",
        },
        accepts: ["canvas_item", "canvas_item_as_portal", "extractable"],
        guards: ["discipline_match"],
        destinations: ["canvas", "compose"],
      },
    ],
    tools: [
      { id: "select", title: "Select" },
      { id: "text", title: "Text" },
    ],
    events: [],
  },
};
