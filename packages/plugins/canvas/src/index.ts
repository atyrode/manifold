import { type PluginManifest } from "@manifold/protocol";

/**
 * The infinite canvas owns its camera, selection, coordinates and element frames.
 * Content and point authoring arrive through the contribution registry. Its note child
 * owns the text tool; its drawing child owns strokes. Portals remain addressing rather
 * than content: they project an existing container instead of copying its document.
 *
 * Geometry and continuous gestures are document traffic. Resource lifecycle and placement
 * use their existing owners' action doors; this renderer declares no second action surface.
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
    tools: [{ id: "select", title: "Select" }],
    events: [],
  },
};
