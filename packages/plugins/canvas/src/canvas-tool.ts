import type { CanvasTool } from "./contract.ts";

/** Canvas-owned modes precede contributed modes in the strip. */
export const CANVAS_TOOLS: readonly CanvasTool[] = ["select"];

export interface CanvasToolFlags {
  readonly nodesDraggable: boolean;
  readonly panOnDrag: boolean;
  readonly elementsSelectable: boolean;
}

/** Point tools allow idle panning; continuous gestures own the held pointer. */
export function toolFlags(tool: CanvasTool, point = false): CanvasToolFlags {
  switch (tool) {
    case "select":
      return { nodesDraggable: true, panOnDrag: true, elementsSelectable: true };
    default:
      return { nodesDraggable: false, panOnDrag: point, elementsSelectable: false };
  }
}
