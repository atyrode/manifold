import { expect, test } from "bun:test";
import { HeadlessSim } from "../../sims/headless.ts";
import { loadScene } from "../index.ts";
import { BONSAI_FIELD } from "./geometry.ts";

const bonsaiScene = await loadScene("bonsai");

const KNOBS = { breeze: 1 };

/**
 * The tree's field 3 (slot 5, after the composed sim's speck map, records atlas and the tree's
 * fields 0–2): its field rows (sway x, y per texel) after one second of breeze in frames of 1/rate s.
 */
function second(rate: number): Float32Array {
  const sim = new HeadlessSim(bonsaiScene);
  for (let f = 0; f < rate; f++)
    sim.step({ dt: 1 / rate, knobs: KNOBS, pointer: { inside: false } });
  const field = Float32Array.from(
    sim.upload(5).data.subarray(0, BONSAI_FIELD.width * BONSAI_FIELD.height * 4),
  );
  sim.dispose();
  return field;
}

test("the pads sway the same at 60 and 144 frames a second", () => {
  const slow = second(60);
  const fast = second(144);
  let sway = 0;
  let worst = 0;
  for (let k = 0; k < slow.length; k += 4) {
    for (const c of [0, 1]) {
      sway = Math.max(sway, Math.abs(slow[k + c] ?? 0));
      worst = Math.max(worst, Math.abs((slow[k + c] ?? 0) - (fast[k + c] ?? 0)));
    }
  }
  expect(sway).toBeGreaterThan(1e-3);
  expect(worst).toBeLessThan(1e-3 * sway);
});
