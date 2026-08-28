export type CanvasTool = "select" | "draw" | "text";

export interface CanvasToolFlags {
  readonly nodesDraggable: boolean;
  readonly panOnDrag: boolean;
  readonly elementsSelectable: boolean;
}

export function toolFlags(tool: CanvasTool): CanvasToolFlags {
  switch (tool) {
    case "select":
      return { nodesDraggable: true, panOnDrag: true, elementsSelectable: true };
    case "draw":
      return { nodesDraggable: false, panOnDrag: false, elementsSelectable: false };
    case "text":
      return { nodesDraggable: false, panOnDrag: true, elementsSelectable: false };
  }
}

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
