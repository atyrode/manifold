import { expect, test } from "bun:test";
import { Cast, Presence, principal } from "../../principals.ts";
import { HeadlessSim } from "../../sims/headless.ts";
import type { ScenePoint } from "../types.ts";
import { AUTUMN_CARPET, AUTUMN_VIEW } from "./layout.ts";
import { loadScene } from "../index.ts";

const autumnScene = await loadScene("autumn");

// A "now" gust as the park's shader reads it from uSim3's first texel (x: the gust's signed strength),
// sampled every frame for six seconds after the press: the shared gust pulse (sims/wind.ts) at the
// park's 1.6 s rise, blowing the way the wind is set, and played in real time whatever the motion.
function gust(knobs: Record<string, number>, motion: number): { peak: number; at: number } {
  const sim = new HeadlessSim(autumnScene);
  sim.step({ knobs, motion });
  let peak = 0;
  let at = 0;
  for (let n = 1; n <= 6 * 60; n++) {
    const value =
      sim.step({ knobs, motion, now: n === 1 ? ["gusts"] : [] }).upload(3).data[0] ?? Number.NaN;
    if (Math.abs(value) > Math.abs(peak)) {
      peak = value;
      at = n / 60;
    }
  }
  sim.dispose();
  return { peak, at };
}

test("a gust peaks 1.6 s after 'now' at its strength, blowing with the wind, motion or not", () => {
  // The default strength 0.5: a gust of 0.55 + 0.45 * 0.5.
  const left = gust({ wind: -0.6 }, 1);
  expect(left.peak).toBeCloseTo(-0.775, 3);
  expect(Math.abs(left.at - 1.6)).toBeLessThan(1.5 / 60);
  const right = gust({ wind: 0.4, "gusts-amount": 1 }, 0);
  expect(right.peak).toBeCloseTo(1, 3);
  expect(Math.abs(right.at - 1.6)).toBeLessThan(1.5 / 60);
  // A breath of wind to the left, inside the dead band, still blows right.
  expect(gust({ wind: -0.04 }, 1).peak).toBeGreaterThan(0);
});

// The rake, the agents' chore: where an interest point lies on the ground (the park's camera at rest,
// a 16:9 frame), and the leaves on the carpet within r metres of a ground point, both layers as the
// shader reads them (uSim1, uSim2: w is 0 for no leaf).
const ASPECT = 16 / 9;
function ground(point: ScenePoint): { x: number; z: number } {
  const { horizon, eye, focal } = AUTUMN_VIEW;
  const z = (eye * focal) / (horizon - point.y);
  return { x: ((point.x - 0.5) * Math.max(ASPECT, 1.45) * z) / focal, z };
}
function leavesNear(sim: HeadlessSim, x: number, z: number, r: number): number {
  const { cell, x0, z0, cols, rows } = AUTUMN_CARPET;
  let count = 0;
  for (const [slot, shift] of [
    [1, 0],
    [2, 0.5],
  ] as const) {
    const data = sim.upload(slot).data;
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols; i++) {
        const dx = x0 + (i + 0.5 + shift) * cell - x;
        const dz = z0 + (j + 0.5 + shift) * cell - z;
        if (Math.hypot(dx, dz) < r && Math.abs(data[(j * cols + i) * 4 + 3] ?? 0) >= 1) count++;
      }
  }
  return count;
}

test("an agent rakes leaves into a pile, a gust scatters it, the same every run", () => {
  // No leaves falling and no gusts but the one pressed, so the rake and the gust alone move leaves.
  const knobs = { fall: 0, gusts: 0 };
  const run = () => {
    const sim = new HeadlessSim(autumnScene);
    sim.step({ knobs });
    const [site] = sim.interest(ASPECT);
    if (site === undefined) throw new Error("the rake declares no station");
    const { x, z } = ground(site);
    const at = { x: site.x, y: site.y };
    // The pile's ground, as far out as a finished pile reaches.
    const before = leavesNear(sim, x, z, 0.8);
    // The band the first strokes rake, 1-1.6 m up and down the path (it runs nearly along z here).
    const band = () =>
      leavesNear(sim, x - 0.17, z + 1.3, 0.25) + leavesNear(sim, x + 0.17, z - 1.3, 0.25);
    const unraked = band();
    // Six visits, as an agent of the cast acts: a press held 0.45 s, then still for two seconds.
    for (let visit = 0; visit < 6; visit++)
      for (let n = 0; n < 150; n++)
        sim.step({ knobs, agents: [{ ...at, down: n < 27, pressed: n === 0 }] });
    const pile = leavesNear(sim, x, z, 0.8);
    const raked = band();
    sim.step({ knobs, agents: [at], now: ["gusts"] });
    for (let n = 0; n < 12 * 60; n++) sim.step({ knobs, agents: [at] });
    const blown = leavesNear(sim, x, z, 0.8);
    const carpet = Array.from(sim.upload(1).data);
    sim.dispose();
    return { before, unraked, pile, raked, blown, carpet };
  };
  const first = run();
  expect(first.unraked).toBeGreaterThan(2);
  expect(first.raked).toBe(0);
  expect(first.pile).toBeGreaterThanOrEqual(first.before + 8);
  expect(first.blown).toBeLessThan(first.pile * 0.6);
  expect(run()).toEqual(first);
});

test("the rake does nothing without agents; one agent of the cast goes to its stations", () => {
  const knobs = { fall: 0, gusts: 0 };
  const alone = new HeadlessSim(autumnScene);
  const off = new HeadlessSim(autumnScene);
  const sim = new HeadlessSim(autumnScene);
  const cast = new Cast(0);
  const presence = new Presence();
  const visitor = principal({ inside: true });
  sim.step({ knobs });
  const [site] = sim.interest(ASPECT);
  if (site === undefined) throw new Error("the rake declares no station");
  const { x, z } = ground(site);
  const before = leavesNear(sim, x, z, 0.8);
  for (let n = 0; n < 75 * 60; n++) {
    const poses = cast.poses(sim.motionTime, ASPECT, 1, sim);
    presence.update(visitor, -1e4, poses, 1 / 60, sim.time);
    sim.step({ knobs, agents: presence.principals.slice(1) });
    alone.step({ knobs });
    off.step({ knobs: { ...knobs, rake: 0 } });
  }
  expect(leavesNear(sim, x, z, 0.8)).toBeGreaterThanOrEqual(before + 8);
  // The rake on or off, a park without agents is the same park.
  expect(Array.from(alone.upload(1).data)).toEqual(Array.from(off.upload(1).data));
  expect(Array.from(alone.upload(2).data)).toEqual(Array.from(off.upload(2).data));
  for (const each of [sim, alone, off]) each.dispose();
});
