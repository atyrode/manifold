import { describe, expect, test } from "bun:test";
import type { ParamDef } from "../../params.ts";
import { HeadlessSim, type HeadlessUpload } from "../../sims/headless.ts";
import { weatherKnobs } from "../atmosphere.ts";
import type { SceneDef } from "../types.ts";
import { beesScene } from "./index.ts";
import { BEES_CODE, beesSim } from "./sim.ts";

/** Everything off but what a test is about. */
const QUIET = {
  bees: 0,
  butterflies: 0,
  bumblebees: 0,
  hoverflies: 0,
  dragonflies: 0,
  fireflies: 0,
};
const BEE_CODES: readonly number[] = [
  BEES_CODE.bee,
  BEES_CODE.beeDim,
  BEES_CODE.beeFaint,
  BEES_CODE.beeWing,
  BEES_CODE.beeLoaded,
  BEES_CODE.swarm,
];
const FIREFLY_CODES: readonly number[] = [BEES_CODE.firefly, BEES_CODE.fireflyGlow];

/** The cells of the map holding one of `codes`: how many, and their bounds. */
function cells(
  upload: HeadlessUpload,
  codes: readonly number[],
): { count: number; width: number; height: number } {
  let count = 0;
  let [left, right, bottom, top] = [Infinity, -Infinity, Infinity, -Infinity];
  for (let at = 0; at < upload.width * upload.height; at++) {
    if (!codes.includes(upload.data[2 * at] ?? 0)) continue;
    count++;
    const y = Math.floor(at / upload.width);
    const x = at - y * upload.width;
    left = Math.min(left, x);
    right = Math.max(right, x);
    bottom = Math.min(bottom, y);
    top = Math.max(top, y);
  }
  return { count, width: right - left + 1, height: top - bottom + 1 };
}

/** The scene with a rain knob, whether or not it has one of its own yet. */
function rainy(): SceneDef {
  if (beesScene.params.some((def) => def.key === "rain")) return beesScene;
  const params: readonly ParamDef[] = [...beesScene.params, ...weatherKnobs({ rain: true })];
  return { ...beesScene, params, sim: beesSim(params) };
}

describe("the swarm", () => {
  test("pours out, mills in a ball, hangs in a tree, lifts off and is gone", () => {
    const sim = new HeadlessSim(beesScene);
    sim.step({ knobs: QUIET });
    expect(cells(sim.upload(0), BEE_CODES).count).toBe(0);
    sim.step({ knobs: QUIET, now: ["swarm"] });
    let t = 0;
    const at = (seconds: number) => {
      for (; t < seconds; t += 0.1) sim.step({ knobs: QUIET, dt: 0.1 });
      return cells(sim.upload(0), BEE_CODES);
    };
    // Milling over the garden: a loose ball of a few hundred specks, a few metres (here some 50 to
    // 200 cells of 540) across.
    const ball = at(30);
    expect(ball.count).toBeGreaterThan(250);
    expect(ball.width).toBeGreaterThan(50);
    expect(ball.width).toBeLessThan(200);
    // Settled: the dark mass of a cluster, half a metre long at some 18 m (a dozen cells of 540).
    const cluster = at(100);
    const mass = cells(sim.upload(0), [BEES_CODE.swarm]);
    expect(mass.count).toBeGreaterThan(30);
    expect(mass.width).toBeLessThan(20);
    expect(mass.height).toBeLessThan(25);
    // A few scouts fly round it; nobody else is about.
    expect(cluster.width).toBeLessThan(60);
    // Off the branch and away: a ball again, then nothing.
    expect(at(150).count).toBeGreaterThan(200);
    expect(at(230).count).toBe(0);
    expect(at(260).count).toBe(0);
    sim.dispose();
  });

  test("plays the same at 60 and 144 frames a second, with the whole garden about", () => {
    const run = (rate: number): Uint8Array => {
      const sim = new HeadlessSim(beesScene);
      const knobs = { "bees-amount": 200 };
      sim.step({ knobs, dt: 0 });
      for (let f = 0; f < rate; f++) sim.step({ knobs, dt: 1 / rate });
      sim.step({ knobs, dt: 1 / rate, now: ["swarm"] });
      for (let f = 1; f < 40 * rate; f++) sim.step({ knobs, dt: 1 / rate });
      // A new size places every speck afresh, so the cells show the state, not the frames' history.
      const data = Uint8Array.from(sim.step({ knobs, dt: 0, height: 541 }).upload(0).data);
      sim.dispose();
      return data;
    };
    const slow = run(60);
    const fast = run(144);
    let drawn = 0;
    let differ = 0;
    for (let i = 0; i < slow.length; i += 2) {
      if ((slow[i] ?? 0) > 0) drawn++;
      if (slow[i] !== fast[i] || slow[i + 1] !== fast[i + 1]) differ++;
    }
    // The colony, the butterflies, the other insects and the swarm forty seconds in.
    expect(drawn).toBeGreaterThan(400);
    expect(differ).toBe(0);
  });
});

describe("the world's hours and weather", () => {
  /** The most cells holding one of `codes` at any tenth of a second over the next `seconds`, in frames 270 cells high. */
  const most = (
    sim: HeadlessSim,
    knobs: Readonly<Record<string, number>>,
    seconds: number,
    codes: readonly number[],
  ): number => {
    let seen = 0;
    for (let f = 0; f < seconds * 60; f++) {
      sim.step({ knobs, height: 270 });
      if (f % 6 === 0) seen = Math.max(seen, cells(sim.upload(0), codes).count);
    }
    return seen;
  };

  test("fireflies are out only at night", () => {
    const lit = (time: number): number => {
      const sim = new HeadlessSim(beesScene);
      const seen = most(sim, { ...QUIET, fireflies: 1, time }, 10, FIREFLY_CODES);
      sim.dispose();
      return seen;
    };
    expect(lit(0.5)).toBe(0);
    expect(lit(0.64)).toBe(0);
    expect(lit(0.85)).toBeGreaterThan(3);
    expect(lit(0)).toBeGreaterThan(3);
  });

  test("fireflies rise from the grass as the dusk deepens, and none are left by morning", () => {
    // The day cycle at 1, a day in 240 s, from 0.7, an hour before sunset: the sun is up for the
    // first 12 s, 36 s .. 96 s is night (0.85 .. 1.1), and from 150 s (1.325) it is morning.
    const sim = new HeadlessSim(beesScene);
    const knobs = { ...QUIET, fireflies: 1, time: 0.7, cycle: 1, "cycle-amount": 1 };
    expect(most(sim, knobs, 12, FIREFLY_CODES)).toBe(0);
    most(sim, knobs, 24, FIREFLY_CODES);
    expect(most(sim, knobs, 60, FIREFLY_CODES)).toBeGreaterThan(3);
    most(sim, knobs, 54, FIREFLY_CODES);
    expect(most(sim, knobs, 10, FIREFLY_CODES)).toBe(0);
    sim.dispose();
  }, 30_000);

  test("the bees stay in at night", () => {
    const sim = new HeadlessSim(beesScene);
    expect(most(sim, { ...QUIET, bees: 1, time: 0 }, 20, BEE_CODES)).toBe(0);
    sim.dispose();
  });

  test("the bees come home in the rain, stay in while it lasts, and come out after it", () => {
    const sim = new HeadlessSim(rainy());
    const dry = { ...QUIET, bees: 1 };
    const wet = { ...dry, rain: 1, "rain-amount": 0.4 };
    expect(most(sim, dry, 2, BEE_CODES)).toBeGreaterThan(20);
    // The farthest foragers are a long flight from home: all in within the minute.
    most(sim, wet, 60, BEE_CODES);
    expect(most(sim, wet, 20, BEE_CODES)).toBe(0);
    expect(most(sim, dry, 20, BEE_CODES)).toBeGreaterThan(10);
    sim.dispose();
  }, 30_000);
});
