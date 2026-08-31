/**
 * A tool id. Deliberately NOT a closed union: `select` and `text` are the two `core.canvas`
 * declares for itself, and everything else is contributed by another plugin's manifest
 * (`core.draw` is the first), so the strip's vocabulary comes from the composition rather
 * than from a literal type nobody outside this file could extend.
 */
export type CanvasTool = string;

/**
 * The two modes this plugin owns, in strip order. They are declared in `canvasManifest` like
 * any contributed tool — so the published vocabulary is complete — and listed again here
 * because ORDER is this surface's business: its own modes come first, then everybody else's
 * in roster order. Membership is also what {@link toolFlags} switches on.
 */
export const CANVAS_TOOLS: readonly CanvasTool[] = ["select", "text"];

export interface CanvasToolFlags {
  readonly nodesDraggable: boolean;
  readonly panOnDrag: boolean;
  readonly elementsSelectable: boolean;
}

/**
 * React Flow's interaction policy per tool. A tool this plugin does NOT own takes the
 * pointer: it is holding a gesture of its own, so nodes neither drag nor select and the pane
 * does not pan under it. That is the whole tool-behaviour contract — a contributed tool names
 * itself and gets a button, while the canvas still implements what a held pointer DOES.
 */
export function toolFlags(tool: CanvasTool): CanvasToolFlags {
  switch (tool) {
    case "select":
      return { nodesDraggable: true, panOnDrag: true, elementsSelectable: true };
    case "text":
      return { nodesDraggable: false, panOnDrag: true, elementsSelectable: false };
    default:
      return { nodesDraggable: false, panOnDrag: false, elementsSelectable: false };
  }
}

/**
 * Keyboard shortcuts. `d` names the draw tool from here because no manifest declares a key
 * binding yet; that is DATA, not an import, and the caller checks the answer against the live
 * composition, so pressing it with `core.draw` disabled selects nothing.
 */
export function toolForKey(key: string): CanvasTool | null {
  switch (key.toLowerCase()) {
    case "v":
      return "select";
    case "d":
      return "draw";
    case "t":
      return "text";
    default:
      return null;
  }
}
