// A fading field of where the principals have been: stir water, melt frost, wake the plankton.
// Values 0..1 in an r8 grid (row 0 = uv.y 0), deposited along each hand's path and decaying.
//
// Ink is laid per unit of path. `stroke` splats every half radius along the segment from the last
// point, each its share of the segment's ink, so one pass leaves `strength` along its middle (before
// the cap of 1) however fast it went and however many frames it took: the same mark at 60 and at
// 144 Hz. A pointer held still lays nothing by a stroke; `hold` lays an amount at one point, which
// the caller makes a rate times the frame's seconds, so that too is the same at any frame rate.
// Each principal carries a stroke of its own (`hand`, its index in SimFrame.principals: 0 the
// visitor), so two hands never ink the path between them.
//
// Usage (a frame of hands that leave a wake, and glow where they are held):
//   for (let i = 0; i < MAX_PRINCIPALS; i++) {
//     const hand = frame.principals[i];
//     if (hand === undefined || !hand.inside) trail.lift(i);
//     else {
//       trail.stroke(hand.x, hand.y, 0.035, 0.3, aspect, i);
//       if (hand.down) trail.hold(hand.x, hand.y, 0.05, 7 * dt, aspect);
//     }
//   }
//   trail.decay(dt, 1.4);
import { MAX_PRINCIPALS } from "../principals.ts";

/** A splat's falloff (1 − d²)² summed along a straight pass through its middle, in radii: ∫ over −1..1. */
const PASS = 16 / 15;

export class TrailField {
  readonly width: number;
  readonly height: number;
  /** r8 texels, rows bottom to top. */
  readonly data: Uint8Array;
  readonly #value: Float32Array;
  /** Where each hand's stroke last reached, while one is under way. */
  readonly #strokes = Array.from({ length: MAX_PRINCIPALS }, () => ({ on: false, x: 0, y: 0 }));
  /** Bumped whenever `data` changes, so uploads can be skipped when nothing moved. */
  version = 0;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.data = new Uint8Array(width * height);
    this.#value = new Float32Array(width * height);
  }

  /**
   * Carry hand `hand`'s stroke on to (x, y), in uv (0..1, y up), inking the path from where it last
   * reached (a stroke's first point only marks where it starts). `radius` is in uv heights;
   * `strength` is what one pass leaves along its middle, added to what is there and capped at 1.
   */
  stroke(x: number, y: number, radius: number, strength: number, aspect: number, hand = 0): void {
    const last = this.#strokes[hand];
    if (last === undefined) return;
    const fromX = last.x;
    const fromY = last.y;
    const started = last.on;
    last.on = true;
    last.x = x;
    last.y = y;
    if (!started || !(strength > 0)) return;
    const length = Math.hypot((x - fromX) * aspect, y - fromY);
    if (!(length > 0)) return;
    const r = Math.max(radius, 2e-4);
    const steps = Math.ceil(length / (0.5 * r));
    const each = (strength * length) / (steps * r * PASS);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      this.#splat(fromX + (x - fromX) * t, fromY + (y - fromY) * t, radius, each, aspect);
    }
    this.version++;
  }

  /** Lay `amount` (0..1, at the middle, capped at 1) in one splat at (x, y), apart from any stroke. */
  hold(x: number, y: number, radius: number, amount: number, aspect: number): void {
    if (!(amount > 0)) return;
    this.#splat(x, y, radius, amount, aspect);
    this.version++;
  }

  /** End hand `hand`'s stroke: its next one starts fresh instead of joining it. */
  lift(hand = 0): void {
    const last = this.#strokes[hand];
    if (last !== undefined) last.on = false;
  }

  /** Fade everything with the given half-life in seconds. */
  decay(dt: number, halfLife: number): void {
    if (dt <= 0) return;
    const keep = Math.pow(0.5, dt / Math.max(halfLife, 1e-3));
    const value = this.#value;
    const data = this.data;
    let any = false;
    for (let i = 0; i < value.length; i++) {
      const v = (value[i] ?? 0) * keep;
      value[i] = v < 0.002 ? 0 : v;
      const byte = Math.round(Math.min(1, value[i] ?? 0) * 255);
      if (byte !== data[i]) {
        data[i] = byte;
        any = true;
      }
    }
    if (any) this.version++;
  }

  #splat(x: number, y: number, radius: number, strength: number, aspect: number): void {
    const w = this.width;
    const h = this.height;
    const cx = x * w;
    const cy = y * h;
    const rx = (radius / aspect) * w;
    const ry = radius * h;
    const x0 = Math.max(0, Math.floor(cx - rx));
    const x1 = Math.min(w - 1, Math.ceil(cx + rx));
    const y0 = Math.max(0, Math.floor(cy - ry));
    const y1 = Math.min(h - 1, Math.ceil(cy + ry));
    const value = this.#value;
    const data = this.data;
    for (let j = y0; j <= y1; j++) {
      for (let i = x0; i <= x1; i++) {
        const d = Math.hypot(
          (i + 0.5 - cx) / Math.max(rx, 1e-3),
          (j + 0.5 - cy) / Math.max(ry, 1e-3),
        );
        if (d >= 1) continue;
        const k = j * w + i;
        const fall = (1 - d * d) * (1 - d * d);
        value[k] = Math.min(1, (value[k] ?? 0) + strength * fall);
        data[k] = Math.round((value[k] ?? 0) * 255);
      }
    }
  }
}
