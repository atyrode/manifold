// When each spot of a surface was last disturbed (raked, trodden, splashed, turned over), so a shader
// can age it: damp fresh gravel drying back, a footprint filling, a scuff fading. Unlike TrailField,
// which fades its values every frame, this keeps one time stamp per cell and costs nothing between
// stamps: the shader takes `clock - texel` as the spot's age and decides what age looks like.
//
// The clock is the scene's to drive. Run it with the scene's time (dt × motion) for ages in seconds,
// or faster and slower, for a drying clock that hurries in sun and wind and stands still in rain
// (dryingPace): ages are then in drying seconds, and a spot stamped at noon keeps drying through the
// evening at the evening's pace instead of leaping back to damp when the pace drops. Packed for r16f
// (half floats), the clock is wound back by AGE_REBASE whenever it passes twice that, and every stamp
// with it, so ages stay good to a few seconds.
//
//   new AgeField(cols, rows, width, height)  a grid over the surface 0..width × 0..height (world units)
//   clock                                    the time now; send it to the shader with the texture
//   advance(seconds)                         run the clock on
//   reset()                                  forget every stamp: everywhere long ago, the clock at 0
//   stamp(ax, ay, bx, by, half)              cells whose centres lie within `half` of a–b were disturbed now
//   upload(texture)                          r16f cols × rows, only when stamped or rebased since the last
//
// Usage (a raked garden, X 0..aspect by Y 0..1):
//   const fresh = new AgeField(336, 140, aspect, 1);
//   const texture = new DataTexture(gl, { width: 336, height: 140, format: "r16f" });
//   // each frame:
//   fresh.advance(frame.dt * frame.motion * dryingPace(skyNow(clock), wind, rain));
//   fresh.stamp(rakeX0, rakeY0, rakeX1, rakeY1, swathHalfWidth);
//   fresh.upload(texture);
//   // GLSL: float age = clock - texture(uSim3, p / vec2(aspect, 1.0)).r;  damp = exp(-age / 45.0);
import { skyState, type SkyState } from "../world-clock.ts";
import { smoothstep } from "./math.ts";
import type { DataTexture } from "./texture.ts";

/** The clock is wound back by this much (seconds) once it passes twice that. */
export const AGE_REBASE = 3000;

export class AgeField {
  readonly cols: number;
  readonly rows: number;
  /** Clock time each cell was last stamped, rows bottom to top; -AGE_REBASE for long ago. */
  readonly data: Float32Array;
  readonly #cellW: number;
  readonly #cellH: number;
  #clock = 0;
  #dirty = true;

  constructor(cols: number, rows: number, width: number, height: number) {
    this.cols = cols;
    this.rows = rows;
    this.data = new Float32Array(cols * rows).fill(-AGE_REBASE);
    this.#cellW = width / cols;
    this.#cellH = height / rows;
  }

  get clock(): number {
    return this.#clock;
  }

  /** Run the clock on by `seconds` (negative counts as 0), winding it back when it grows large. */
  advance(seconds: number): void {
    if (seconds > 0) this.#clock += seconds;
    if (this.#clock <= 2 * AGE_REBASE) return;
    this.#clock -= AGE_REBASE;
    const data = this.data;
    for (let k = 0; k < data.length; k++)
      data[k] = Math.max(-AGE_REBASE, (data[k] ?? 0) - AGE_REBASE);
    this.#dirty = true;
  }

  /** Forget every stamp: everywhere disturbed long ago, the clock back at 0. */
  reset(): void {
    this.data.fill(-AGE_REBASE);
    this.#clock = 0;
    this.#dirty = true;
  }

  /** Every cell whose centre lies within `half` (world units) of the segment a–b was disturbed now. */
  stamp(ax: number, ay: number, bx: number, by: number, half: number): void {
    const cols = this.cols;
    const cw = this.#cellW;
    const ch = this.#cellH;
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - half) / cw));
    const i1 = Math.min(cols - 1, Math.floor((Math.max(ax, bx) + half) / cw));
    const j0 = Math.max(0, Math.floor((Math.min(ay, by) - half) / ch));
    const j1 = Math.min(this.rows - 1, Math.floor((Math.max(ay, by) + half) / ch));
    const ex = bx - ax;
    const ey = by - ay;
    const l2 = ex * ex + ey * ey;
    const now = this.#clock;
    for (let j = j0; j <= j1; j++) {
      const py = (j + 0.5) * ch;
      for (let i = i0; i <= i1; i++) {
        const px = (i + 0.5) * cw;
        const t = l2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * ex + (py - ay) * ey) / l2)) : 0;
        if (Math.hypot(px - ax - t * ex, py - ay - t * ey) < half) this.data[j * cols + i] = now;
      }
    }
    this.#dirty = true;
  }

  /** Upload to an r16f texture of cols × rows if stamped or rebased since the last upload; true if it was. */
  upload(texture: DataTexture): boolean {
    if (!this.#dirty) return false;
    texture.upload(this.data);
    this.#dirty = false;
    return true;
  }
}

/** The staged noon sun's elevation sine: the sun's height at which dryingPace's sun counts 1. */
const NOON_SUN = skyState(0.5).sun[1];

/**
 * How fast damp ground dries, against a still, sunny midday (1): slower as the sun sinks and at night
 * (0.35 in the dark), faster in wind (up to 1.8× at full wind), and not at all once it rains (gone by
 * rain 0.15). `sky` is the sky now as the shader has it (skyNow in src/world-clock.ts): its daylight
 * and how high its sun stands against the staged noon's, so a dated sky's summer sun dries faster.
 */
export function dryingPace(sky: SkyState, wind: number, rain: number): number {
  const high = Math.max(0, sky.sun[1]) / NOON_SUN;
  const sun = 0.35 + 0.65 * sky.day * (0.4 + 0.6 * high);
  return sun * (1 + 0.8 * Math.min(1, Math.abs(wind))) * (1 - smoothstep(0, 0.15, rain));
}
