import { expect, test } from "bun:test";
import { toHalf } from "../../sims/half.ts";
import { generateTerrain, sampleGrid } from "../../sims/terrain.ts";
import { COUNTRY_CAMERA } from "./camera.ts";
import { COUNTRY_MARCH } from "./shader.ts";
import { COUNTRY_MAP } from "./sim.ts";

// countryMarch (shader.ts) on the CPU over the bare land (the ground and the water as the GPU holds
// them, in half floats; no trees), every cell of a 640 × 360 frame of the default view, against a
// march that never steps over the land (no step longer than the steepest texel allows, finer floors)
// bisected to the crossing. The default landscape and the ones whose grazing rays ran out of steps
// most often under the far skyline before the march had steps enough for them.
const WIDTH = 640;
const HEIGHT = 360;
const SEEDS = [0, 3, 5] as const;

interface Ray {
  /** Distance to the land (-1: none: sky, or off the map). */
  t: number;
  /** The march ran out of steps still above the land (drawn there, in the air). */
  spent: boolean;
}

test("the march meets the land where a dense march does, and rays grazing it reach it", () => {
  const M = COUNTRY_MARCH;
  const { horizon, focal } = COUNTRY_CAMERA;
  for (const seed of SEEDS) {
    const t = generateTerrain({ seed, size: COUNTRY_MAP.size, extent: COUNTRY_MAP.extent });
    const m = t.size;
    const E = t.extent;
    const ground = Float32Array.from(t.ground, toHalf);
    const level = Float32Array.from(t.level, toHalf);
    const surface = (x: number, z: number): number =>
      Math.max(sampleGrid(ground, m, E, x, z), sampleGrid(level, m, E, x, z));
    // The steepest the bilinear surface rises: its gradient's parts are bounded by the largest
    // differences between neighbouring texels either way, the dense march's slope bound.
    let across = 0;
    let up = 0;
    for (let j = 0; j < m; j++)
      for (let i = 0; i < m; i++) {
        const q = j * m + i;
        const a = Math.max(ground[q] ?? 0, level[q] ?? 0);
        const east = Math.max(ground[q + 1] ?? 0, level[q + 1] ?? 0);
        const north = Math.max(ground[q + m] ?? 0, level[q + m] ?? 0);
        if (i + 1 < m) across = Math.max(across, Math.abs(east - a));
        if (j + 1 < m) up = Math.max(up, Math.abs(north - a));
      }
    const steepest = Math.hypot(across, up) / t.cell;
    const v = t.vantage;
    const eye = { x: v.x, y: toHalf(v.y), z: v.z };
    // The shader's march: shader.ts countryMarch, line for line, over the bare land.
    const march = (dx: number, dy: number, dz: number): Ray => {
      let at = 0;
      let last = 0;
      let above = 0;
      let below = 0;
      let hit = false;
      for (let i = 0; i < M.steps; i++) {
        const x = eye.x + dx * at;
        const y = eye.y + dy * at;
        const z = eye.z + dz * at;
        if (x < -40 || z < -40 || x > E + 40 || z > E + 40) return { t: -1, spent: false };
        const gap = y - surface(x, z);
        if (gap < 0) {
          below = gap;
          hit = true;
          break;
        }
        if (dy >= 0 && y > M.top) return { t: -1, spent: false };
        last = at;
        above = gap;
        at += Math.max(gap / (M.slope + Math.abs(dy)), M.relStep * at + M.minStep);
        if (at > M.far) return { t: -1, spent: false };
      }
      if (!hit) return { t: at, spent: true };
      let lo = last;
      let hi = at;
      for (let i = 0; i < M.refine; i++) {
        const mid = lo + ((hi - lo) * above) / (above - below);
        const gap = eye.y + dy * mid - surface(eye.x + dx * mid, eye.z + dz * mid);
        if (gap >= 0) {
          lo = mid;
          above = gap;
        } else {
          hi = mid;
          below = gap;
        }
      }
      return { t: lo + ((hi - lo) * above) / (above - below), spent: false };
    };
    const dense = (dx: number, dy: number, dz: number): number => {
      let at = 0;
      let last = 0;
      for (;;) {
        const x = eye.x + dx * at;
        const y = eye.y + dy * at;
        const z = eye.z + dz * at;
        if (x < -40 || z < -40 || x > E + 40 || z > E + 40) return -1;
        const gap = y - surface(x, z);
        if (gap < 0) break;
        if (dy >= 0 && y > M.top) return -1;
        last = at;
        at += Math.max(gap / (steepest + Math.abs(dy)), 0.25, 0.0004 * at);
        if (at > M.far) return -1;
      }
      let lo = last;
      let hi = at;
      for (let i = 0; i < 24; i++) {
        const mid = 0.5 * (lo + hi);
        if (eye.y + dy * mid > surface(eye.x + dx * mid, eye.z + dz * mid)) lo = mid;
        else hi = mid;
      }
      return 0.5 * (lo + hi);
    };
    // A cell's footprint at distance d: d · cell.
    const cell = 1 / HEIGHT / focal;
    let land = 0;
    let met = 0;
    let spent = 0;
    for (let py = 0; py < HEIGHT; py++) {
      for (let px = 0; px < WIDTH; px++) {
        // viewRay, turned onto the map by the vantage's heading (right = (dz, -dx)).
        const cx = ((px + 0.5) / WIDTH - 0.5) * (WIDTH / HEIGHT);
        const cy = (py + 0.5) / HEIGHT - horizon;
        const length = Math.hypot(cx, cy, focal);
        const dx = (v.dz * cx + v.dx * focal) / length;
        const dz = (-v.dx * cx + v.dz * focal) / length;
        const dy = cy / length;
        const truth = dense(dx, dy, dz);
        if (truth < 0) continue;
        land++;
        const ray = march(dx, dy, dz);
        if (ray.spent) spent++;
        if (ray.t > 0 && Math.abs(ray.t - truth) <= 2 * truth * cell) met++;
      }
    }
    expect(land).toBeGreaterThan(0.5 * WIDTH * HEIGHT);
    expect(met).toBeGreaterThanOrEqual(0.998 * land);
    expect(spent).toBeLessThanOrEqual(0.0005 * land);
  }
}, 60_000);
