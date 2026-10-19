// The beach as the shore's two halves both need it: its camera and its surf's timetable, constants
// the shader takes (shader.ts), and for the agents' cairns (cairns.ts) the reach of the swash up the
// sand, shader.ts's shoreWave, shoreRunup and shoreReach mirrored at a point of the beach.
import { glslHash12 } from "../../sims/math.ts";

export const SHORE_BEACH = {
  /** Screen height of the horizon, and the vertical field of view (rad): a long lens. */
  horizon: 0.6,
  fov: 0.7,
  /** The eye's height over still water (m). */
  eye: 1.8,
  /** The still-water line (m ahead), where each swell line comes into view, and the seconds between. */
  line: 9,
  far: 72,
  travel: 22,
  /** Waves tracked at once, from new swell to drained backwash. */
  waves: 9,
} as const;

/** Screen heights per unit of ray slope (the shader's focal). */
export const SHORE_FOCAL = 0.5 / Math.tan(0.5 * SHORE_BEACH.fov);

/**
 * The swash at a point of the beach: how far past it the water runs (m; negative while it is dry),
 * and the wave that runs furthest.
 */
export interface Swash {
  over: number;
  /** That wave's seed (0..1), and whether its swash still runs up (false: its backwash drains). */
  seed: number;
  rising: boolean;
}

const TAU = Math.PI * 2;

/**
 * The surf at ground point (x, z) (m: across, and ahead of the eye) at motion time tm, the camera
 * stepped camX along the beach, for the wave period (s) and size (0..1) knobs, into `out`. At rest
 * (no passage), as the shader's waves run.
 */
export function swashAt(
  x: number,
  z: number,
  camX: number,
  tm: number,
  period: number,
  size: number,
  out: Swash,
): void {
  const { line, travel, waves } = SHORE_BEACH;
  const height0 = 0.35 + 1.15 * size;
  const e = line - z;
  // The crest's x at the still-water line, along the ray through the point.
  const xw = camX + ((x - camX) * line) / z;
  const now = Math.floor(tm / period);
  out.over = -e;
  out.seed = 0;
  out.rising = false;
  for (let i = 0; i < waves; i++) {
    const k = now - (waves - 1 - i);
    const age = tm - (k + 0.45 * glslHash12(k, 3.7)) * period;
    // Still out at sea: its water is below the line.
    if (age < travel) continue;
    const seed = glslHash12(k, 11.3);
    const set = 0.5 + 0.5 * Math.sin((k * TAU) / 7 + 1.3);
    const peaks =
      1 + 0.22 * Math.sin(xw * 0.09 + seed * 31) + 0.12 * Math.sin(xw * 0.23 + seed * 7);
    const height = Math.min(height0 * (0.6 + 0.25 * set + 0.3 * seed) * peaks, 1.45);
    const cusps = 1 + 0.22 * Math.sin(x * 0.5 + seed * 13) + 0.12 * Math.sin(x * 1.3 + seed * 5);
    const runup = (0.9 + 1.5 * height) * cusps;
    const swash = age - travel;
    const duration = 1.5 + 2.2 * Math.sqrt(runup);
    const rise = 0.38 * duration;
    let reach: number;
    if (swash < rise) {
      const a = 1 - swash / rise;
      reach = runup * (1 - a * a);
    } else {
      const b = Math.min((swash - rise) / (duration - rise), 1.18);
      reach = runup * (1 - b * b);
    }
    if (reach - e > out.over) {
      out.over = reach - e;
      out.seed = seed;
      out.rising = swash < rise;
    }
  }
}
