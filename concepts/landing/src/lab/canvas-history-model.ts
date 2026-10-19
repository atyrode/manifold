// The undo history of the lab's canvas mode (lab.ts attachCanvas): one timeline of the document on
// screen and the lab's own setup beside it (the look, as a minimal query), so an undo steps back
// whichever of them the last change was. As the setup's history (history-model.ts) it coalesces: a
// commit of the same change (`what`: an object's move, a knob's value, the camera) within
// COALESCE_MS of that step's last commit grows the step, so a drag, a wheel run or a held key is
// one step, and a step grown back to where it began goes.
import type { EngineDoc } from "../engine/types.ts";
import { COALESCE_MS, HISTORY_CAP } from "./history-model.ts";

/** What the canvas mode can step back to: the document and the setup beside it. */
export interface CanvasStep {
  readonly doc: EngineDoc;
  readonly query: string;
  /** The change that led here, in a few words for the undo and redo buttons. */
  readonly words: string;
}

export interface CanvasHistory {
  undo: CanvasStep[];
  redo: CanvasStep[];
  committed: CanvasStep;
  /** What the last step changed and when it last grew. */
  last: { what: string; at: number } | undefined;
}

/** A history at `committed`, with nothing to undo or redo. */
export function canvasHistoryAt(committed: CanvasStep): CanvasHistory {
  return { undo: [], redo: [], committed, last: undefined };
}

/** Whether two steps hold the same document and setup. */
function same(a: CanvasStep, b: CanvasStep): boolean {
  return (
    a.query === b.query && (a.doc === b.doc || JSON.stringify(a.doc) === JSON.stringify(b.doc))
  );
}

/**
 * Make `step` the committed one at `now` (milliseconds), a change of `what`: a new undo step, or
 * the step before it grown (the module comment). False when nothing changed.
 */
export function recordCanvas(
  history: CanvasHistory,
  step: CanvasStep,
  now: number,
  what: string,
): boolean {
  if (same(step, history.committed)) return false;
  const last = history.last;
  const joins =
    last !== undefined &&
    last.what === what &&
    history.undo.length > 0 &&
    now - last.at < COALESCE_MS;
  if (!joins) {
    history.undo.push(history.committed);
    if (history.undo.length > HISTORY_CAP) history.undo.shift();
  }
  history.redo.length = 0;
  history.committed = step;
  history.last = { what, at: now };
  const before = history.undo.at(-1);
  if (joins && before && same(before, step)) {
    history.undo.pop();
    history.committed = before;
    history.last = undefined;
  }
  return true;
}

/** Step back: the step to show, or undefined with nothing to undo. */
export function undoCanvas(history: CanvasHistory): CanvasStep | undefined {
  const previous = history.undo.pop();
  if (previous === undefined) return undefined;
  history.redo.push(history.committed);
  history.committed = previous;
  history.last = undefined;
  return previous;
}

/** Step forward again: the step to show, or undefined with nothing to redo. */
export function redoCanvas(history: CanvasHistory): CanvasStep | undefined {
  const next = history.redo.pop();
  if (next === undefined) return undefined;
  history.undo.push(history.committed);
  history.committed = next;
  history.last = undefined;
  return next;
}
