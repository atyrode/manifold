// The drag and key rules of fader chips and scrub readouts (chips.ts, controls.ts), apart from their
// elements. A press is a click until it moves across far enough, then a drag: the value moves with
// the pointer from where the press went down (a tenth as fast with Shift) and stays within its
// bounds, so turning back at an end moves it at once. A fader chip's drag runs the whole range across
// the chip (the fill's edge keeps pace with the pointer), a readout's across SCRUB_SPAN pixels.
import { keyStep, snap } from "./dom.ts";

/** A knob's range and step: a range knob, or a feature's amount. */
export interface Bounds {
  min: number;
  max: number;
  step: number;
}

/** How far (px) a press moves across, more across than down, before it is a drag, not a click. */
export const DRAG_THRESHOLD = 4;

/** A readout's scrub runs its whole range over this many pixels. */
export const SCRUB_SPAN = 200;

/** Shift's share of a drag's pace. */
export const FINE = 0.1;

/** A press: where it went down and the value then, and its drag once it drags (a click until then). */
export interface Press {
  x: number;
  y: number;
  value: number;
  /** Where the pointer was last and the value there, unsnapped. */
  scrub: { x: number; value: number } | undefined;
}

/** Whether a press that has moved (dx, dy) since it went down drags across. */
export function dragsAcross(dx: number, dy: number): boolean {
  return Math.abs(dx) >= DRAG_THRESHOLD && Math.abs(dx) > Math.abs(dy);
}

/** The value per pixel that runs the whole range over `pixels`. */
export function pace(bounds: Bounds, pixels: number): number {
  return (bounds.max - bounds.min) / Math.max(1, pixels);
}

/**
 * The press with the pointer at (x, y): once it drags across, the value moves by the distance across
 * since the last move (counting from where it went down) times `perPixel`, a tenth of that with
 * `fine`, held within the bounds. A press that never drags stays a click.
 */
export function pressMove(
  press: Press,
  x: number,
  y: number,
  perPixel: number,
  fine: boolean,
  bounds: Bounds,
): Press {
  const scrub =
    press.scrub ??
    (dragsAcross(x - press.x, y - press.y) ? { x: press.x, value: press.value } : undefined);
  if (!scrub) return press;
  const value = scrub.value + (x - scrub.x) * perPixel * (fine ? FINE : 1);
  return { ...press, scrub: { x, value: Math.min(bounds.max, Math.max(bounds.min, value)) } };
}

/**
 * The amount a key gives a fader chip (switching it on), or undefined for a key it leaves alone
 * (Space and Enter toggle it, as a button). Arrows step it (with Shift a tenth of the range), Page Up
 * and Page Down a tenth of the range, Home and End take it to its ends. A chip that is off comes on at
 * the amount it had, so the first key shows the amount before the next one changes it.
 */
export function chipKey(
  event: KeyboardEvent,
  on: boolean,
  amount: number,
  bounds: Bounds,
): number | undefined {
  const delta = keyStep(event, bounds.step, bounds.max - bounds.min);
  const next =
    delta !== undefined
      ? amount + delta
      : event.key === "Home"
        ? bounds.min
        : event.key === "End"
          ? bounds.max
          : undefined;
  if (next === undefined) return undefined;
  return on ? snap(next, bounds.min, bounds.max, bounds.step) : amount;
}
