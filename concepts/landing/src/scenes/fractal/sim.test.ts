import { expect, test } from "bun:test";
import { HeadlessSim, type HeadlessFrame } from "../../sims/headless.ts";
import { loadScene } from "../index.ts";
import { FRACTAL_GLOBAL_TEXELS } from "./sim.ts";

const fractalScene = await loadScene("fractal");

// The state row (sim.ts): texel 1 the pan, texel 2 the passage's focus, the incoming layer's +1 c.
const row = (sim: HeadlessSim): ArrayLike<number> => sim.upload(0).data;
const pan = (state: ArrayLike<number>): [number, number] => [state[4] ?? 0, state[5] ?? 0];
const juliaC = (state: ArrayLike<number>): [number, number] => [
  state[(FRACTAL_GLOBAL_TEXELS + 1) * 4] ?? 0,
  state[(FRACTAL_GLOBAL_TEXELS + 1) * 4 + 1] ?? 0,
];

const aspect = 16 / 9;
const knobs = { kind: 0, wander: 0 };

/** Full-width swipes left to right, each pressed, dragged over 20 frames and let go. */
function swipe(sim: HeadlessSim, times: number, from = 0.05, to = 0.95): void {
  for (let n = 0; n < times; n++) {
    sim.step({ knobs, pointer: { x: from, y: 0.5, down: true, pressed: true } });
    for (let i = 1; i <= 20; i++)
      sim.step({ knobs, pointer: { x: from + ((to - from) * i) / 20, y: 0.5, down: true } });
    sim.step({ knobs, pointer: { x: to, y: 0.5, released: true } });
  }
}

test("a drag within the frame carries the picture exactly with the hand", () => {
  const sim = new HeadlessSim(fractalScene);
  sim.step({ knobs, pointer: { x: 0.4, y: 0.45, down: true, pressed: true } });
  for (let i = 1; i < 20; i++)
    sim.step({ knobs, pointer: { x: 0.4 + (0.2 * i) / 20, y: 0.45 + (0.1 * i) / 20, down: true } });
  const [x, y] = pan(row(sim.step({ knobs, pointer: { x: 0.6, y: 0.55, down: true } })));
  expect(x).toBeCloseTo(0.2 * aspect * 2, 6);
  expect(y).toBeCloseTo(0.1 * 2, 6);
});

test("stacked swipes never carry the picture's centre out of the frame", () => {
  const sim = new HeadlessSim(fractalScene);
  swipe(sim, 6);
  // A mouse held down can travel on past the window's edge.
  sim.step({ knobs, pointer: { x: 0.5, y: 0.5, down: true, pressed: true } });
  for (let i = 1; i <= 40; i++)
    sim.step({ knobs, pointer: { x: 0.5 + (2 * i) / 40, y: 0.5 + i / 40, down: true } });
  const [x, y] = pan(row(sim.step({ knobs, pointer: { x: 2.5, y: 1.5, down: true } })));
  // Its centre may be stretched a little past the frame's edge, never a screen away.
  expect(Math.abs(x)).toBeLessThan(aspect + 0.4);
  expect(Math.abs(y)).toBeLessThan(1 + 0.4);
});

test("hovering after far drags nudges c no further than hovering alone ever can", () => {
  const still = new HeadlessSim(fractalScene);
  const corner = new HeadlessSim(fractalScene);
  const dragged = new HeadlessSim(fractalScene);
  const away: HeadlessFrame = { knobs, pointer: { inside: false } };
  for (let i = 0; i < 30; i++) for (const sim of [still, corner, dragged]) sim.step(away);
  swipe(dragged, 6);
  for (let i = 0; i < 6 * 22; i++) {
    still.step(away);
    corner.step(away);
  }
  let reach = 0;
  let pushed = 0;
  for (let i = 0; i < 600; i++) {
    const c = juliaC(row(still.step(away)));
    const atCorner = juliaC(row(corner.step({ knobs, pointer: { x: 0, y: 0 } })));
    const atCentre = juliaC(row(dragged.step({ knobs, pointer: { x: 0.5, y: 0.5 } })));
    reach = Math.max(reach, Math.hypot(atCorner[0] - c[0], atCorner[1] - c[1]));
    pushed = Math.max(pushed, Math.hypot(atCentre[0] - c[0], atCentre[1] - c[1]));
  }
  expect(reach).toBeGreaterThan(0);
  expect(pushed).toBeLessThanOrEqual(reach * 1.001);
});

test("leaving right after a drag falls into a point on screen", () => {
  for (const kind of [0, 2, 3]) {
    const sim = new HeadlessSim(fractalScene);
    for (let i = 0; i < 30; i++) sim.step({ knobs: { kind } });
    sim.step({ knobs: { kind }, pointer: { x: 0.1, y: 0.5, down: true, pressed: true } });
    for (let i = 1; i <= 20; i++)
      sim.step({ knobs: { kind }, pointer: { x: 0.1 + (0.85 * i) / 20, y: 0.5, down: true } });
    sim.step({ knobs: { kind }, pointer: { x: 0.95, y: 0.5, released: true } });
    for (let i = 1; i <= 20; i++) {
      const state = row(
        sim.step({ knobs: { kind }, pointer: { inside: false }, passage: { exit: i / 20 } }),
      );
      const [x, y] = pan(state);
      expect(Math.abs((state[9] ?? 0) + x)).toBeLessThan(aspect);
      expect(Math.abs((state[10] ?? 0) + y)).toBeLessThan(1);
    }
  }
});
