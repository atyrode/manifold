import { expect, test } from "bun:test";
import { HeadlessGl } from "../../sims/headless.ts";
import { defaultsFor, paramDefaults, renderSettings } from "../../state.ts";
import type { SceneSim, SimFrame } from "../types.ts";
import { firefliesScene } from "./index.ts";
import { FIREFLIES_CELL } from "./sim.ts";

function frameFor(knobs: Record<string, number>): SimFrame {
  const params = { ...paramDefaults("fireflies"), ...knobs };
  return {
    dt: 0,
    time: 0,
    motionTime: 0,
    motion: 0.6,
    width: 960,
    height: 540,
    aspect: 16 / 9,
    params,
    values: renderSettings(defaultsFor("fireflies"), params).params,
    triggers: new Array<number>(8).fill(-1e4),
    fired: new Array<boolean>(8).fill(false),
    pointer: { x: 0.5, y: 0.5, inside: false, down: false, pressed: false, released: false },
    passage: { enter: 1, exit: 0 },
  };
}

/** The bank's fireflies as uSim0 has them: how many, and their mean height above the waterline. */
function census(sim: SceneSim, frame: SimFrame, headless: HeadlessGl): { count: number; height: number } {
  const swarm = headless.upload(sim.frame(frame)[0]);
  let count = 0;
  let height = 0;
  for (let i = 0; i < swarm.width * swarm.height; i++) {
    if ((swarm.data[4 * i] ?? -1) < 0) continue;
    count++;
    height += (Math.floor(i / swarm.width) + 0.5) * FIREFLIES_CELL;
  }
  return { count, height: height / Math.max(count, 1) };
}

/** A sim at these knobs once its opening seconds have run and a few seconds more. */
function settled(knobs: Record<string, number>): { sim: SceneSim; frame: SimFrame; headless: HeadlessGl } {
  const headless = new HeadlessGl();
  const sim = firefliesScene.sim?.(headless.gl);
  if (!sim) throw new Error("fireflies has no sim");
  const frame = frameFor(knobs);
  // Paused frames finish the (time-budgeted) warm-up; then three seconds of swarm.
  for (let f = 0; f < 20; f++) sim.frame(frame);
  frame.dt = 1 / 30;
  for (let f = 0; f < 90; f++) {
    frame.time += frame.dt;
    frame.motionTime += frame.dt * frame.motion;
    sim.frame(frame);
  }
  return { sim, frame, headless };
}

test("the open bank holds exactly as many fireflies as the dense crowns, lower over the bank", () => {
  for (const seed of [0, 7]) {
    for (const density of [0.1, 0.4, 0.65, 1]) {
      const crowns = settled({ seed, density, habitat: 0 });
      const open = settled({ seed, density, habitat: 1 });
      const a = census(crowns.sim, crowns.frame, crowns.headless);
      const b = census(open.sim, open.frame, open.headless);
      expect({ seed, density, count: b.count }).toEqual({ seed, density, count: a.count });
      expect(a.count).toBeGreaterThan(0);
      expect(b.height).toBeLessThan(a.height);
    }
  }
});

test("switching the bank keeps the swarm's size and moves it over", () => {
  const { sim, frame, headless } = settled({ seed: 3, habitat: 0 });
  const before = census(sim, frame, headless);
  frame.params = { ...frame.params, habitat: 1 };
  frame.values = renderSettings(defaultsFor("fireflies"), frame.params).params;
  // Ten seconds: the fireflies leaving fade out (they ease over under a second of swarm time).
  for (let f = 0; f < 300; f++) {
    frame.time += frame.dt;
    frame.motionTime += frame.dt * frame.motion;
    sim.frame(frame);
  }
  const after = census(sim, frame, headless);
  expect(after.count).toBe(before.count);
  expect(after.height).toBeLessThan(before.height);
});
