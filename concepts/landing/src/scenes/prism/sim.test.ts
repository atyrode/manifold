import { expect, test } from "bun:test";
import { HeadlessSim } from "../../sims/headless.ts";
import { loadScene } from "../index.ts";

const prismScene = await loadScene("prism");

const STEP = 1 / 30;

type Point = readonly [number, number];

/** A value the state texture (uSim1) carries as two halves, hi + lo. */
function pair(state: ArrayLike<number>, i: number): number {
  return (state[i] ?? 0) + (state[i + 1] ?? 0);
}

/** Prism k's centre from the state texture. */
function centre(state: ArrayLike<number>, k: number): Point {
  return [pair(state, 8 * k), pair(state, 8 * k + 2)];
}

/** Prism k's corners: its centre, the cos and sin of its turn, and the circumradius (texel 4.x). */
function corners(state: ArrayLike<number>, k: number): Point[] {
  const [x, y] = centre(state, k);
  const turn = Math.atan2(pair(state, 8 * k + 6), pair(state, 8 * k + 4));
  const radius = state[16] ?? 0;
  return [0, 1, 2].map((m): Point => {
    const a = turn + Math.PI / 2 + (m * 2 * Math.PI) / 3;
    return [x + radius * Math.cos(a), y + radius * Math.sin(a)];
  });
}

/** How far apart two triangles stand along their edges' normals: > 0 apart, < 0 interpenetrating. */
function separation(a: readonly Point[], b: readonly Point[]): number {
  let gap = Number.NEGATIVE_INFINITY;
  for (const shape of [a, b]) {
    shape.forEach((p, i) => {
      const q = shape[(i + 1) % 3] ?? p;
      const nx = q[1] - p[1];
      const ny = p[0] - q[0];
      const length = Math.hypot(nx, ny);
      const pa = a.map((v) => (v[0] * nx + v[1] * ny) / length);
      const pb = b.map((v) => (v[0] * nx + v[1] * ny) / length);
      gap = Math.max(gap, Math.min(...pb) - Math.max(...pa), Math.min(...pa) - Math.max(...pb));
    });
  }
  return gap;
}

/** One frame at the lab's motion, the pointer away; the state texture (uSim1) the shader samples after it. */
function stepState(
  sim: HeadlessSim,
  knobs: Record<string, number>,
  now: readonly string[] = [],
): ArrayLike<number> {
  return sim.step({ dt: STEP, motion: 0.6, knobs, now, pointer: { inside: false } }).upload(1).data;
}

/**
 * Both prisms through an eclipse played with "now" once the second prism has slid in: the closest
 * they come, and how far the second one's centre moves meanwhile.
 */
function throughEclipse(knobs: Record<string, number>): { closest: number; moved: number } {
  const sim = new HeadlessSim(prismScene);
  let state = stepState(sim, knobs);
  while (sim.time < 12) state = stepState(sim, knobs);
  if (state[17] !== 1) throw new Error("prism: the second prism did not slide in");
  const [x0, y0] = centre(state, 1);
  let now = ["eclipse"];
  let closest = Number.POSITIVE_INFINITY;
  let moved = 0;
  while (sim.time < 60) {
    state = stepState(sim, knobs, now);
    now = [];
    closest = Math.min(closest, separation(corners(state, 0), corners(state, 1)));
    const [x, y] = centre(state, 1);
    moved = Math.max(moved, Math.hypot(x - x0, y - y0));
  }
  sim.dispose();
  return { closest, moved };
}

test("sliding in, a close-set second prism comes along the fan beside the first, never through it", () => {
  const sim = new HeadlessSim(prismScene);
  let closest = Number.POSITIVE_INFINITY;
  let shown = 0;
  while (sim.time < 6) {
    const state = stepState(sim, { second: 1, "second-amount": 0.05 });
    if (state[17] !== 1) continue;
    shown++;
    closest = Math.min(closest, separation(corners(state, 0), corners(state, 1)));
  }
  sim.dispose();
  expect(shown).toBeGreaterThan(0);
  expect(closest).toBeGreaterThan(0);
});

test("a close-set second prism backs off as an eclipse turns the first, never passing through it", () => {
  const { closest, moved } = throughEclipse({ second: 1, "second-amount": 0.05 });
  expect(closest).toBeGreaterThan(0);
  expect(moved).toBeGreaterThan(0);
});

test("at the default gap the second prism holds its place through an eclipse", () => {
  const { closest, moved } = throughEclipse({ second: 1 });
  expect(closest).toBeGreaterThan(0);
  expect(moved).toBeLessThan(1e-6);
});
