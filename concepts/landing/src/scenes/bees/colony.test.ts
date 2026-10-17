import { describe, expect, test } from "bun:test";
import { HeadlessSim } from "../../sims/headless.ts";
import { Colony, pollenDrunk } from "./colony.ts";
import { Garden, STEP } from "./garden.ts";
import { beesScene } from "./index.ts";
import { beesStage } from "./layout.ts";

/** The median of a home leg's flown path over the straight line from its start to where it lands, over `seconds` of a colony of 96 at `silly`. */
function homeCurl(silly: number, seconds: number): number {
  const garden = new Garden();
  garden.stage = beesStage(16 / 9);
  garden.aspect = 16 / 9;
  const colony = new Colony(garden);
  colony.count = 96;
  colony.silly = silly;
  colony.seed();
  const legs = new Map<object, { x: number; z: number; h: number; path: number }>();
  const curls: number[] = [];
  for (let s = 0; s < seconds * 60; s++) {
    garden.tm += STEP;
    colony.step(STEP);
    for (const b of colony.bees) {
      const leg = legs.get(b);
      const flown = Math.hypot(b.x - b.px, b.z - b.pz, b.h - b.ph);
      if (b.mode === "home") {
        if (leg === undefined) legs.set(b, { x: b.px, z: b.pz, h: b.ph, path: flown });
        else leg.path += flown;
      } else if (leg !== undefined) {
        legs.delete(b);
        const line = Math.hypot(b.x - leg.x, b.z - leg.z, b.h - leg.h);
        if (b.mode === "land" && line > 1.5) curls.push(leg.path / line);
      }
    }
  }
  curls.sort((a, b) => a - b);
  expect(curls.length).toBeGreaterThan(50);
  return curls[curls.length >> 1] ?? 0;
}

describe("pollen-drunk bees", () => {
  test("none at 0, every leg at 1, and by default a few of the heavily loaded on their way home", () => {
    const giddy = Array.from({ length: 1000 }, (_, i) => (i + 0.5) / 1000);
    const share = (silly: number, heavy: boolean): number =>
      giddy.filter((g) => pollenDrunk(silly, g, heavy)).length / giddy.length;
    expect(share(0, true)).toBe(0);
    expect(share(0, false)).toBe(0);
    expect(share(1, true)).toBe(1);
    expect(share(1, false)).toBe(1);
    const knob = beesScene.params.find((def) => def.key === "silly");
    const silly = knob?.value ?? Number.NaN;
    expect(share(silly, true)).toBeGreaterThan(0.1);
    expect(share(silly, true)).toBeLessThan(0.6);
    expect(share(silly, false)).toBe(0);
  });

  test("a drunk bee flies home in big loops; a sober one in a nearly straight line", () => {
    expect(homeCurl(0, 120)).toBeLessThan(1.05);
    expect(homeCurl(1, 120)).toBeGreaterThan(1.4);
  });

  test("plays the same at 60 and 144 frames a second, every bee drunk", () => {
    const run = (rate: number): Uint8Array => {
      const sim = new HeadlessSim(beesScene);
      const knobs = { "bees-amount": 200, silly: 1 };
      sim.step({ knobs, dt: 0 });
      for (let f = 0; f < 20 * rate; f++) sim.step({ knobs, dt: 1 / rate });
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
    expect(drawn).toBeGreaterThan(200);
    expect(differ).toBe(0);
  });
});
