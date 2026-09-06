import { HEX_COLOR, MAX_STROKE_POINT_VALUES, type PluginManifest } from "@manifold/protocol";
import { z } from "zod";

/**
 * Freehand ink, as a plugin. It is the smallest complete contribution in the workspace and
 * therefore the worked example in `docs/PLUGINS.md`: one element type, one tool, no actions.
 *
 * There are no actions because a stroke is a DOCUMENT edit (D6): it is authored on the canvas
 * inside a Yjs transaction, its worst-case merge is two strokes both surviving, and no other
 * principal's authority is consulted. `scenes:write` is declared for exactly that reason — the
 * capability a viewer needs to author one — even though nothing here dispatches.
 * Disabling this plugin removes the tool from the strip and turns existing strokes into named
 * placeholders wherever they are placed; enabling it brings both back with no reload (D4/R3).
 *
 * A stroke is `tileable` as well as `canvas_item`, and its payload moves intact into a
 * composition through the generic element reference. `on_claim` means its home is established
 * only when placement claims the inline element. Canvas draws its body without a titlebar;
 * composition supplies the titlebar and tile geometry.
 *
 * Draw is a child of `core.canvas`: its required parent edge governs the whole contribution,
 * including strokes placed in composition leaves. Placement and stored payloads stay intact.
 */
export const drawManifest: PluginManifest = {
  id: "core.canvas.draw",
  version: "1.0.0",
  title: "Draw",
  description: "Freehand ink: the draw tool and the stroke element renderer.",
  capabilities: ["scenes:write"],
  dependencies: {
    "core.canvas": {
      type: "required",
      reason: "freehand ink belongs to the canvas family and its tool needs the canvas surface",
    },
  },
  contributes: {
    panels: [],
    sections: [],
    elements: [
      {
        type: "draw",
        title: "Draw stroke",
        presentation: { canvas: "body", composition: "titlebar" },
        placement: { groups: ["tileable", "canvas_item"], guards: [], homed: "on_claim" },
      },
    ],
    tools: [{ id: "draw", title: "Draw" }],
    events: [],
  },
};

/** The `draw` payload; see the note on `notesElements` for why it lives on the registration. */
export const drawElements = {
  draw: z.strictObject({
    points: z.array(z.number().finite()).min(4).max(MAX_STROKE_POINT_VALUES),
    strokeWidth: z.number().finite().positive(),
    color: z.string().regex(HEX_COLOR),
  }),
};
