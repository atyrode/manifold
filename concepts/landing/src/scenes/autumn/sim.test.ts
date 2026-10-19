import { expect, test } from "bun:test";
import { allocate, SPECK_SLOT } from "../../composer/sim.ts";
import { Cast, Presence, principal } from "../../principals.ts";
import { HeadlessSim } from "../../sims/headless.ts";
import type { ScenePoint } from "../types.ts";
import { loadScene } from "../index.ts";
import { autumnComposed } from "./index.ts";
import { AUTUMN_CARPET, AUTUMN_VIEW, AUTUMN_WIDE } from "./layout.ts";

const autumnScene = await loadScene("autumn");

// Where the preset's layers keep their data: the composer's falling things' codes in the speck map
// (the maple's leaves in the air), the litter's two fields (the carpet's layers).
const allocation = allocate(
  autumnComposed.place(new Set(autumnComposed.preset.layers)).layers.map((p) => p.layer),
);
const FALLING = allocation.falling ?? { base: 0, count: 0 };
const [CARPET_A = 2, CARPET_B = 3] = allocation.fields["litter"] ?? [];

/** The cells of leaves in the air or lying (the falling things' codes) in the speck map as last uploaded. */
function leafCells(sim: HeadlessSim): number {
  if (!sim.uploaded(SPECK_SLOT)) return 0;
  const data = sim.upload(SPECK_SLOT).data;
  let count = 0;
  for (let i = 0; i < data.length; i += 2) {
    const code = data[i] ?? 0;
    if (code > FALLING.base && code <= FALLING.base + FALLING.count) count++;
  }
  return count;
}

test("the gusts shake leaves loose as they reach the tree; at motion 0 the park stands still", () => {
  // No leaves let go but the gusts' showers: once the leaves already falling have landed and faded
  // where they lie (the litter is off), only a gust of the composer's field sends more down.
  const calm = { fall: 0, gusts: 0 };
  const gusty = { fall: 0, gusts: 1, "gusts-amount": 1, gustRate: 1 };
  const still = new HeadlessSim(autumnScene);
  const windy = new HeadlessSim(autumnScene);
  let prewarmed = 0;
  for (let n = 0; n < 30 * 60; n++) {
    prewarmed = Math.max(prewarmed, leafCells(still.step({ knobs: calm })));
    windy.step({ knobs: calm });
  }
  expect(prewarmed).toBeGreaterThan(30);
  expect(leafCells(still)).toBe(0);
  let shaken = 0;
  for (let n = 0; n < 60 * 60; n++) {
    still.step({ knobs: calm });
    shaken = Math.max(shaken, leafCells(windy.step({ knobs: gusty })));
  }
  expect(leafCells(still)).toBe(0);
  expect(shaken).toBeGreaterThan(30);
  // Frozen, nothing moves, gusts or not.
  const before = Array.from(windy.step({ knobs: gusty, motion: 0 }).upload(SPECK_SLOT).data);
  for (let n = 0; n < 120; n++) windy.step({ knobs: gusty, motion: 0 });
  expect(Array.from(windy.upload(SPECK_SLOT).data)).toEqual(before);
  for (const each of [still, windy]) each.dispose();
});

// The rake, the agents' chore: where an interest point lies on the ground (the park's camera at rest,
// a 16:9 frame), and the leaves on the carpet within r metres of a ground point, both layers as the
// shader reads them (the litter's fields: w is 0 for no leaf).
const ASPECT = 16 / 9;
function ground(point: ScenePoint): { x: number; z: number } {
  const { horizon, eye, focal } = AUTUMN_VIEW;
  const z = (eye * focal) / (horizon - point.y);
  return { x: ((point.x - 0.5) * Math.max(ASPECT, AUTUMN_WIDE) * z) / focal, z };
}
function leavesNear(sim: HeadlessSim, x: number, z: number, r: number): number {
  const { cell, x0, z0, cols, rows } = AUTUMN_CARPET;
  let count = 0;
  for (const [slot, shift] of [
    [CARPET_A, 0],
    [CARPET_B, 0.5],
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

test("an agent rakes leaves into a pile, the gusts scatter it, the same every run", () => {
  // No leaves falling and no gusts while the rake works, so the rake alone moves leaves; then ten
  // seconds of strong gusts of the composer's field come over the pile (before the leaves they lift
  // and shake loose have settled back round it).
  const knobs = { fall: 0, gusts: 0 };
  const gusty = { fall: 0, gusts: 1, "gusts-amount": 1, gustRate: 1 };
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
    for (let n = 0; n < 10 * 60; n++) sim.step({ knobs: gusty, agents: [at] });
    const blown = leavesNear(sim, x, z, 0.8);
    const carpet = Array.from(sim.upload(CARPET_A).data);
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
  expect(Array.from(alone.upload(CARPET_A).data)).toEqual(Array.from(off.upload(CARPET_A).data));
  expect(Array.from(alone.upload(CARPET_B).data)).toEqual(Array.from(off.upload(CARPET_B).data));
  for (const each of [sim, alone, off]) each.dispose();
});
