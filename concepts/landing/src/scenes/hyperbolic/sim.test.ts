import { expect, test } from "bun:test";
import { HeadlessSim } from "../../sims/headless.ts";
import { HYPERBOLIC_MODELS } from "./sim.ts";
import { hyperbolicScene } from "./index.ts";

// The state row's first two texels: screen disk → plane (coarse, then fine).
const motionOf = (state: unknown): number[] => Array.from((state as Float32Array).subarray(0, 8));

// With the glide at rest the plane only moves when the hand moves it: a drag held still while the
// screen turns or the map changes must neither jump the plane nor fling it off once let go.
const changes = [
  { label: "portrait", aspect: 9 / 16, model: "disk" },
  { label: "wider", aspect: 21 / 9, model: "disk" },
  { label: "band", aspect: 16 / 9, model: "band" },
  { label: "half-plane", aspect: 16 / 9, model: "half-plane" },
] as const;

for (const change of changes) {
  test(`a still drag across a change to ${change.label} keeps the plane in place`, () => {
    const sim = new HeadlessSim(hyperbolicScene);
    const knobs = { speed: 0 };
    const at = { x: 0.62, y: 0.58, inside: true, down: true };
    for (let i = 0; i < 10; i++) sim.step({ knobs });
    sim.step({ knobs, pointer: { ...at, pressed: true } });
    for (let i = 0; i < 20; i++) sim.step({ knobs, pointer: at });
    const held = motionOf(sim.step({ knobs, pointer: at })[0]);

    const after = { aspect: change.aspect, knobs: { ...knobs, model: HYPERBOLIC_MODELS.indexOf(change.model) } };
    expect(motionOf(sim.step({ ...after, pointer: at })[0])).toEqual(held);
    sim.step({ ...after, pointer: at });
    sim.step({ ...after, pointer: { ...at, down: false, released: true } });
    for (let i = 0; i < 120; i++) sim.step(after);
    expect(motionOf(sim.step(after)[0])).toEqual(held);
  });
}

test("after a change mid-drag the plane still follows the hand", () => {
  const sim = new HeadlessSim(hyperbolicScene);
  const knobs = { speed: 0 };
  const at = { x: 0.62, y: 0.58, inside: true, down: true };
  sim.step({ knobs, pointer: { ...at, pressed: true } });
  const held = motionOf(sim.step({ knobs, pointer: at })[0]);
  sim.step({ knobs, aspect: 9 / 16, pointer: at });
  const moved = motionOf(sim.step({ knobs, aspect: 9 / 16, pointer: { ...at, x: 0.45 } })[0]);
  expect(moved).not.toEqual(held);
});
