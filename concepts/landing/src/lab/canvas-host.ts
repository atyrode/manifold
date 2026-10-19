// What the lab's canvas mode needs of the page while an engine view is on screen (lab.ts
// attachCanvas): the view itself (its document, edits to it, what lies under a cell), the kinds its
// palette offers, the element the picture is drawn in (the lab takes the pointer there while
// attached), and how a pointer position maps to a cell of the view.
import type { EngineView, KindDef } from "../engine/types.ts";

export interface CanvasHost {
  view: EngineView;
  kinds: readonly KindDef[];
  element: HTMLElement;
  /**
   * The cell under a pointer position (client pixels), in the view's cell coordinates (origin
   * bottom left, a cell's centre at i + 0.5), or undefined off the picture.
   */
  cellAt(clientX: number, clientY: number): readonly [number, number] | undefined;
}
