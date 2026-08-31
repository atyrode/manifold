import { type PluginManifest } from "@manifold/protocol";

/**
 * Freehand ink, as a plugin. It is the smallest complete contribution in the workspace and
 * therefore the worked example in `docs/PLUGINS.md`: one element type, one tool, no actions.
 *
 * There are no actions because a stroke is a DOCUMENT edit (D6): it is authored on the canvas
 * inside a Yjs transaction, its worst-case merge is two strokes both surviving, and no other
 * principal's authority is consulted. `scenes:write` is declared for exactly that reason — the
 * capability a viewer needs to author one — even though nothing here dispatches.
 *
 * Disabling this plugin removes the tool from the strip and turns existing strokes into named
 * placeholders on the canvas; enabling it brings both back, live, with no reload (D4/R3).
 */
export const drawManifest: PluginManifest = {
  id: "core.draw",
  version: "1.0.0",
  title: "Draw",
  description: "Freehand ink: the draw tool and the stroke element renderer.",
  capabilities: ["scenes:write"],
  contributes: {
    panels: [],
    sections: [],
    elements: [{ type: "draw", title: "Draw stroke" }],
    tools: [{ id: "draw", title: "Draw" }],
    events: [],
  },
};
