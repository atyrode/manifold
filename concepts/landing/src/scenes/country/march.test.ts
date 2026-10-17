import { expect, test } from "bun:test";
import { toHalf } from "../../sims/half.ts";
import { clamp, glslHash12, smoothstep } from "../../sims/math.ts";
import {
  generateTerrain,
  packTerrain,
  sampleGrid,
  type TerrainBase,
  TERRAIN_RECORDS,
} from "../../sims/terrain.ts";
import { COUNTRY_CAMERA } from "./camera.ts";
import { COUNTRY_MARCH, COUNTRY_RING } from "./shader.ts";
import { COUNTRY_MAP } from "./sim.ts";

/** common.ts vnoise and fbm3, on the CPU (to the march, any smooth noise of their shape will do). */
function vnoise(x: number, z: number): number {
  const i = Math.floor(x);
  const j = Math.floor(z);
  const u = (x - i) * (x - i) * (3 - 2 * (x - i));
  const v = (z - j) * (z - j) * (3 - 2 * (z - j));
  const a = glslHash12(i, j);
  const b = glslHash12(i + 1, j);
  const c = glslHash12(i, j + 1);
  const d = glslHash12(i + 1, j + 1);
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
}
function fbm3(x: number, z: number): number {
  return (
    (0.5 * vnoise(x, z) +
      0.25 * vnoise(x * 2.03 + 17.1, z * 2.03 + 9.2) +
      0.125 * vnoise(x * 4.11 + 4.3, z * 4.11 + 31.7)) /
    0.875
  );
}

// countryMarch (shader.ts) on the CPU over the bare land (the ground and the water as the GPU holds
// them, in half floats; no trees) and the ring of hills beyond it (countryRing), every cell of a
// 640 × 360 frame of the default view, against a march that never steps over the land (no step
// longer than the steepest texel or the ring allows, finer floors) bisected to the crossing. Every
// shape of land: its default landscape or the ones whose grazing rays take the most steps under the
// far skyline (the hills' run past COUNTRY_MARCH.late).
const WIDTH = 640;
const HEIGHT = 360;
const LANDSCAPES: readonly (readonly [TerrainBase, readonly number[]])[] = [
  ["valley", [0, 3, 5]],
  ["coast", [3]],
  ["plateau", [3]],
  ["hills", [3, 5]],
];

interface Ray {
  /** Distance to the land or its ring (-1: none: sky). */
  t: number;
  /** The march ran out of steps still above the land (drawn there, in the air). */
  spent: boolean;
}

test("the shortest steps alone carry a ray past the farthest look before the steps run out", () => {
  const M = COUNTRY_MARCH;
  // The slowest a ray goes: every step the shortest (the gap to the land only lengthens one), from
  // the eye (a ray starting farther on, above COUNTRY_TOP, only goes faster).
  let t = 0;
  let grow = 1;
  for (let i = 0; i < M.steps && t <= M.far; i++) {
    if (i >= M.late) grow *= M.growth;
    t += (M.relStep * t + M.minStep) * grow;
  }
  expect(t).toBeGreaterThan(M.far);
});

for (const [base, seeds] of LANDSCAPES) {
  test(`${base}: the march meets the land as a dense march does; no ray runs out of steps`, () => {
    const M = COUNTRY_MARCH;
    const { horizon, focal } = COUNTRY_CAMERA;
    for (const seed of seeds) {
      const t = generateTerrain({ seed, size: COUNTRY_MAP.size, extent: COUNTRY_MAP.extent, base });
      const m = t.size;
      const E = t.extent;
      const ground = Float32Array.from(t.ground, toHalf);
      const level = Float32Array.from(t.level, toHalf);
      // terrainTop as the records hold it, in half floats.
      const records = packTerrain(t).records;
      const top = toHalf(records[4 * TERRAIN_RECORDS.misc * TERRAIN_RECORDS.width + 21] ?? 0);
      const R = COUNTRY_RING;
      // The bare land, and beyond it its ring (shader.ts countryRing).
      const surface = (x: number, z: number): number => {
        const past = Math.hypot(Math.max(-x, x - E, 0), Math.max(-z, z - E, 0));
        const g = sampleGrid(ground, m, E, clamp(x, 0, E), clamp(z, 0, E));
        const l = sampleGrid(level, m, E, clamp(x, 0, E), clamp(z, 0, E));
        if (past <= 0) return Math.max(g, l);
        const hills = (fbm3(x / R.scale, z / R.scale) - 0.5) * R.relief * Math.max(top - g, 0);
        const land = Math.min(g + smoothstep(0, R.rise, past) * hills, top);
        return Math.max(land, l > g ? l : land - 1);
      };
      // No trees here, so no trees' bound over it.
      const ceiling = Math.min(M.top, top + M.headroom);
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
      // The ring rises no steeper than this (its noise and its rise from the edge together).
      const steepest = Math.max(Math.hypot(across, up) / t.cell, 1);
      const v = t.vantage;
      const eye = { x: v.x, y: toHalf(v.y), z: v.z };
      // The shader's march: shader.ts countryMarch, line for line, over the bare land.
      const march = (dx: number, dy: number, dz: number): Ray => {
        let at = 0;
        let last = 0;
        let above = 0;
        let below = 0;
        let grow = 1;
        let hit = false;
        for (let i = 0; i < M.steps; i++) {
          const x = eye.x + dx * at;
          const y = eye.y + dy * at;
          const z = eye.z + dz * at;
          const gap = y - surface(x, z);
          if (gap < 0) {
            below = gap;
            hit = true;
            break;
          }
          if (dy >= 0 && y > ceiling) return { t: -1, spent: false };
          last = at;
          above = gap;
          let least = M.relStep * at + M.minStep;
          if (i >= M.late) {
            grow *= M.growth;
            least *= grow;
          }
          at += Math.max(gap / (M.slope + Math.abs(dy)), least);
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
          const ray = march(dx, dy, dz);
          if (ray.spent) spent++;
          if (truth < 0) continue;
          land++;
          if (ray.t > 0 && Math.abs(ray.t - truth) <= 2 * truth * cell) met++;
        }
      }
      expect(land).toBeGreaterThan(0.5 * WIDTH * HEIGHT);
      expect(met).toBeGreaterThanOrEqual(0.998 * land);
      expect(spent).toBe(0);
    }
  }, 60_000);
}
