import { expect, test } from "bun:test";
import { HeadlessSim } from "../../sims/headless.ts";
import { firefliesScene } from "./index.ts";

const POINTER = { inside: false };

/** The swarm after its warm-up (paused frames) and one second in frames of 1/rate s: uSim0. */
function second(rate: number): Float32Array {
  const sim = new HeadlessSim(firefliesScene);
  for (let f = 0; f < 20; f++) sim.step({ dt: 0, pointer: POINTER });
  for (let f = 0; f < rate; f++) sim.step({ dt: 1 / rate, pointer: POINTER });
  const swarm = Float32Array.from(sim.upload(0).data);
  sim.dispose();
  return swarm;
}

test("the fireflies flash and wander the same at 60 and 144 frames a second", () => {
  const slow = second(60);
  const fast = second(144);
  // B: each firefly's light; R, G: its place in its cell.
  let lit = 0;
  let light = 0;
  let place = 0;
  for (let i = 0; i < slow.length; i += 4) {
    lit = Math.max(lit, slow[i + 2] ?? 0);
    light = Math.max(light, Math.abs((slow[i + 2] ?? 0) - (fast[i + 2] ?? 0)));
    place = Math.max(place, Math.abs((slow[i] ?? 0) - (fast[i] ?? 0)));
    place = Math.max(place, Math.abs((slow[i + 1] ?? 0) - (fast[i + 1] ?? 0)));
  }
  expect(lit).toBeGreaterThan(0.2);
  expect(light).toBeLessThan(1e-3 * lit);
  expect(place).toBeLessThan(1e-4);
});
