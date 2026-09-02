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
 * placeholders on the canvas; enabling it brings both back, live, with no reload (D4/R3).
 *
 * It DEPENDS on `core.canvas`, `required`, and that declaration is the whole point of the
 * dependency axis rather than a formality: a stroke is a canvas element, so with the canvas
 * renderer gone the draw tool has nothing to paint on and the ink has nowhere to live. The
 * refusal that falls out of it is the one §5 promises — disabling `core.canvas` while this
 * plugin is on is refused `dependency_disabled: core.draw`, naming the plugin in the way,
 * instead of leaving a tool in the strip whose surface has quietly gone. `docs/PLUGINS.md`
 * has shown this exact declaration as its worked example since the contract was ratified;
 * this is the code catching up to the document rather than the document to the code.
 */
export const drawManifest: PluginManifest = {
  id: "core.draw",
  version: "1.0.0",
  title: "Draw",
  description: "Freehand ink: the draw tool and the stroke element renderer.",
  capabilities: ["scenes:write"],
  dependencies: {
    "core.canvas": {
      type: "required",
      reason: "strokes are canvas elements; without the canvas renderer the tool has no surface",
    },
  },
  contributes: {
    panels: [],
    sections: [],
    elements: [{ type: "draw", title: "Draw stroke" }],
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
