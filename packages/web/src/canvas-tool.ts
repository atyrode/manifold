/**
 * A tool id. Deliberately NOT a closed union any more: `select` and `text` are the two the
 * engine still owns this wave, and everything else is contributed by a plugin manifest
 * (`core.draw` is the first), so the toolbar's vocabulary comes from the composition rather
 * than from a literal type nobody outside this file could extend.
 */
export type CanvasTool = string;

/** The tools the engine itself provides; a contributed tool is any id outside this set. */
export const FLOOR_TOOLS: readonly CanvasTool[] = ["select", "text"];

export interface CanvasToolFlags {
  readonly nodesDraggable: boolean;
  readonly panOnDrag: boolean;
  readonly elementsSelectable: boolean;
}

/**
 * React Flow's interaction policy per tool. A CONTRIBUTED tool takes the pointer: it is
 * holding a gesture of its own, so nodes neither drag nor select and the pane does not pan
 * under it. That is the whole tool-behaviour contract this wave — tools contribute their
 * name and their icon-less button, while the canvas still implements what a held pointer
 * DOES (see the stroke handlers in `flow-pad-view.tsx`, tagged for `core.canvas`).
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
 * Keyboard shortcuts. `d` still names the draw tool from here because a manifest declares no
 * key binding yet; the CALLER checks the answer against the live composition, so pressing it
 * with `core.draw` disabled selects nothing (`until core.canvas tool-behavior contributions`).
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
