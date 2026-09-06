import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

/**
 * FLIP — First, Last, Invert, Play: the one way a stack of contributed rows MOVES.
 *
 * The problem it answers is not decoration. A rail's row order is data now (a per-principal
 * arrangement, a roster's enabled set), so the same list re-renders into a different sequence
 * for three unrelated reasons — an arrange commit, a keyboard nudge, a plugin being switched
 * off — and a re-render teleports. A reader who nudged the wrong row cannot tell a swap from
 * a redraw, and a row that vanished because an administrator disabled its plugin looks like a
 * glitch. Motion is the only thing that says WHICH row went WHERE, and it has to come from
 * the same derivation the order does: measure the boxes, let React commit the new order,
 * measure again, put every row back where it was with a transform, and release it.
 *
 * ENGINE MECHANISM, not the shell's own. Two parties that may not import each other need it —
 * the plugin that draws a rail and any other plugin that stacks contributed rows — and the
 * measurement/inversion arithmetic is the part everyone would otherwise re-derive slightly
 * differently. The DOMAIN is entirely the caller's: this module knows an attribute name and a
 * signature string, and not one word about sections, sidebars or plugins.
 *
 * THREE DELIBERATE CHOICES, each with a failure it avoids:
 *
 *   `offsetLeft`/`offsetTop` rather than `getBoundingClientRect`. Offsets are LAYOUT boxes:
 *   they ignore transforms and they ignore scrolling, so a measurement taken while a previous
 *   FLIP is still playing is still the truth, and no cancel-then-measure dance is needed to
 *   keep the arithmetic honest. A rect-based version measures the PAINTED box and compounds
 *   its own animation into the next delta.
 *
 *   The Web Animations API rather than an inline transform plus a transition. There is no
 *   timer, no `requestAnimationFrame` chain and no inline style to clean up: an unmount
 *   cancels the handles it holds and the DOM is exactly as the caller wrote it. "No timers
 *   left running after unmount" is a property of the mechanism here, not of a careful caller.
 *
 *   A SIGNATURE, supplied by the caller, rather than a diff of the measured keys. Only the
 *   caller knows what counts as a reflow worth playing — for a rail it is the visible order —
 *   and asking it for one string keeps this module from guessing that a re-render which
 *   happened to move a box was a reorder rather than, say, a section folding shut.
 *
 * `prefers-reduced-motion: reduce` disables it ENTIRELY: no transform is ever applied, so the
 * reduced-motion path is the plain re-render, not a faster animation. It is read at play time
 * rather than cached, because a reader may change the setting while the tab is open.
 */

/**
 * One measured box, reduced to the two numbers a translate-only FLIP compares. Rows in a
 * stack change place, never size, so there is nothing here to scale — and a `scale` term
 * would distort the row's own text for the length of the motion.
 */
export interface FlipRect {
  readonly left: number;
  readonly top: number;
}

/** One row's INVERSION: the offset that makes its new place look like its old one. */
export interface FlipShift {
  readonly key: string;
  readonly dx: number;
  readonly dy: number;
}

/** Sub-pixel drift is not motion; below this a row is considered not to have moved. */
export const FLIP_EPSILON = 0.5;

/** Short enough to feel like the same gesture, long enough to be followed by an eye. */
export const FLIP_DURATION_MS = 170;

/** Fast out, settled in: the row leaves immediately and arrives without a bounce. */
export const FLIP_EASING = "cubic-bezier(0.2, 0, 0, 1)";

const NO_RECTS: ReadonlyMap<string, FlipRect> = new Map();

/**
 * THE PURE HALF, and the whole of the arithmetic: two measurements in, the inversions out.
 *
 * Iterated over `last`, so the answer is in the order the DOM is in now. A key present in
 * `last` but not in `first` gets NO shift — a row that has just appeared has no place to be
 * put back to, and inventing one (sliding it in from a neighbour's box) would animate a lie
 * about where it came from. A key that only `first` has is gone from the DOM; there is
 * nothing left to move.
 */
export function flipShifts(
  first: ReadonlyMap<string, FlipRect>,
  last: ReadonlyMap<string, FlipRect>,
  epsilon: number = FLIP_EPSILON,
): readonly FlipShift[] {
  const shifts: FlipShift[] = [];
  for (const [key, to] of last) {
    const from = first.get(key);
    if (from === undefined) continue;
    const dx = from.left - to.left;
    const dy = from.top - to.top;
    if (Math.abs(dx) <= epsilon && Math.abs(dy) <= epsilon) continue;
    shifts.push({ key, dx, dy });
  }
  return shifts;
}

/**
 * The two frames one row plays: its old place, then none at all.
 *
 * `translate` and nothing else, and the last frame is written out rather than left implicit,
 * so the animation is a closed statement about this row's transform instead of a blend with
 * whatever the stylesheet says.
 */
export function flipKeyframes(shift: FlipShift): readonly Keyframe[] {
  return [
    { transform: `translate(${String(shift.dx)}px, ${String(shift.dy)}px)` },
    { transform: "translate(0px, 0px)" },
  ];
}

/** True when this reader has asked for less motion; false where there is no media query. */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export interface FlipOptions {
  /** The attribute that names a row, e.g. `data-section-id`. Direct children only. */
  readonly attribute: string;
  /**
   * HOLD STILL. While this is true the stack still MEASURES every commit — so the boxes a
   * later reflow inverts against stay current — but plays nothing, and cancels whatever was
   * already in flight.
   *
   * It exists because a live drag is the one reflow whose cause is already on screen: the
   * pointer is the motion, and a row sliding to its new seat under it is a second answer to
   * where that row is. Worse than redundant, it was WRONG (issue #94) — an animating row's
   * `getBoundingClientRect` reports the transform, so the gesture's own hit test read rows
   * mid-flight and swapped them back. Animation is for the reflows nobody's hand is on: an
   * arrange commit, a keyboard nudge, a plugin enabled or disabled.
   */
  readonly paused?: boolean;
  readonly duration?: number;
  readonly easing?: string;
}

/**
 * Each direct child that names itself, paired with its key, in DOM order.
 *
 * A child with NO LAYOUT BOX is not in the stack. `offsetParent` is null exactly when nothing
 * lays the element out (`display: none`, or an ancestor that is), and its offsets are then 0 —
 * so measuring it would record a box at the container's origin and a later reflow would slide
 * the row in from there. A row the caller has hidden simply does not take part.
 */
function flipRows(
  container: HTMLElement,
  attribute: string,
): readonly (readonly [string, HTMLElement])[] {
  const rows: (readonly [string, HTMLElement])[] = [];
  for (const row of Array.from(
    container.querySelectorAll<HTMLElement>(`:scope > [${attribute}]`),
  )) {
    const key = row.getAttribute(attribute);
    if (key !== null && row.offsetParent !== null) rows.push([key, row]);
  }
  return rows;
}

/**
 * FLIP over a container's direct children, as a ref callback.
 *
 * Hand the returned callback to the element that holds the rows and pass a `signature` that
 * changes exactly when the rows have been reflowed on purpose. Every commit re-measures — so
 * the "first" boxes are never stale — and only a changed signature plays.
 *
 * The FIRST signature never animates: a stack has to arrive somewhere before it can be seen
 * moving, and playing on mount would slide the whole rail in from nothing on every page load.
 */
export function useFlipStack(
  signature: string,
  options: FlipOptions,
): (element: HTMLElement | null) => void {
  const { attribute, paused = false, duration = FLIP_DURATION_MS, easing = FLIP_EASING } = options;
  const container = useRef<HTMLElement | null>(null);
  const first = useRef<ReadonlyMap<string, FlipRect>>(NO_RECTS);
  const played = useRef<string | null>(null);
  const running = useRef<Animation[]>([]);

  const stop = useCallback((): void => {
    for (const animation of running.current) animation.cancel();
    running.current = [];
  }, []);

  /*
    A LAYOUT effect with no dependency list, deliberately: the measurement has to happen after
    the browser has laid this commit out and before it paints, and it has to happen on EVERY
    commit, because the boxes a later reorder inverts against are the ones the last commit
    left behind. A dependency list keyed on the signature would measure the new order against
    boxes from whenever the signature last changed.
  */
  useLayoutEffect(() => {
    const element = container.current;
    if (element === null) return;
    const rows = flipRows(element, attribute);
    const last = new Map(
      rows.map(([key, row]) => [key, { left: row.offsetLeft, top: row.offsetTop }]),
    );
    const previous = first.current;
    const reflowed = played.current !== signature;
    first.current = last;
    played.current = signature;
    /*
      Paused, the measurement still lands and the signature is still marked played — the
      stack is kept honest so the first reflow AFTER the pause inverts against real boxes —
      but nothing plays, and anything mid-flight is cancelled so the rows snap to where the
      layout actually put them. A gesture measuring this stack must read layout, not a
      transform in progress.
    */
    if (paused) {
      stop();
      return;
    }
    if (!reflowed || previous === NO_RECTS || prefersReducedMotion()) return;
    // One reflow, one set of animations: whatever was still playing described the old order.
    stop();
    const byKey = new Map(rows);
    for (const shift of flipShifts(previous, last)) {
      const row = byKey.get(shift.key);
      if (row === undefined || typeof row.animate !== "function") continue;
      running.current.push(row.animate([...flipKeyframes(shift)], { duration, easing }));
    }
  });

  // The unmount contract: nothing of ours outlives the element it was moving.
  useEffect(() => stop, [stop]);

  return useCallback(
    (element: HTMLElement | null): void => {
      container.current = element;
      if (element !== null) return;
      stop();
      first.current = NO_RECTS;
      played.current = null;
    },
    [stop],
  );
}
