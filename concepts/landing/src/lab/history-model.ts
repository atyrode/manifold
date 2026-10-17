// One slot's undo history (lab.ts): the setups (minimal queries) before and after the committed one.
// A commit is one undo step unless it carries on the step before it: one that changes the same URL
// keys within COALESCE_MS of that step's last commit (a held arrow key, a run of clicks on one
// control), or a playing tour's own advance after another advance. Undo then means "the last thing
// I did", and a tour left playing is one step back to where it began.
import { setupDifferences } from "../compare.ts";

/** Milliseconds within which a commit to the same keys joins the step before it. */
export const COALESCE_MS = 1000;
/** The most undo steps a history keeps; the oldest go first. */
export const HISTORY_CAP = 100;

export interface History {
  undo: string[];
  redo: string[];
  committed: string;
  /** What the last step changed (its keys, or a tour's advance) and when it last grew. */
  last: { what: string; at: number } | undefined;
}

/** A history at `committed`, with nothing to undo or redo. */
export function historyAt(committed: string): History {
  return { undo: [], redo: [], committed, last: undefined };
}

/** How a commit came about: by hand, or as a playing tour's own advance to its next scene. */
export type CommitBy = "hand" | "advance";

/**
 * Make `query` the committed setup at `now` (milliseconds): a new undo step, or the step before it
 * grown (see the module comment); a step grown back to where it began goes. False when unchanged.
 */
export function record(
  history: History,
  query: string,
  now: number,
  by: CommitBy = "hand",
): boolean {
  if (query === history.committed) return false;
  const what =
    by === "advance" ? "advance" : setupDifferences(history.committed, query).sort().join(" ");
  const last = history.last;
  const joins =
    last !== undefined &&
    last.what === what &&
    history.undo.length > 0 &&
    (by === "advance" || now - last.at < COALESCE_MS);
  if (!joins) {
    history.undo.push(history.committed);
    if (history.undo.length > HISTORY_CAP) history.undo.shift();
  }
  history.redo.length = 0;
  history.committed = query;
  history.last = { what, at: now };
  if (joins && history.undo.at(-1) === query) {
    history.undo.pop();
    history.last = undefined;
  }
  return true;
}

/** Step back: the setup to apply, or undefined with nothing to undo. */
export function undoStep(history: History): string | undefined {
  const previous = history.undo.pop();
  if (previous === undefined) return undefined;
  history.redo.push(history.committed);
  history.committed = previous;
  history.last = undefined;
  return previous;
}

/** Step forward again: the setup to apply, or undefined with nothing to redo. */
export function redoStep(history: History): string | undefined {
  const next = history.redo.pop();
  if (next === undefined) return undefined;
  history.undo.push(history.committed);
  history.committed = next;
  history.last = undefined;
  return next;
}
