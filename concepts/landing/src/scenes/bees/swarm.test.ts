import { describe, expect, test } from "bun:test";
import { HeadlessSim, type HeadlessUpload } from "../../sims/headless.ts";
import { loadScene } from "../index.ts";
import { BEES_CODE, BEES_TREES, beesStage } from "./layout.ts";

const beesScene = await loadScene("bees");

const QUIET = {
  bees: 0,
  butterflies: 0,
  bumblebees: 0,
  hoverflies: 0,
  dragonflies: 0,
  glowworms: 0,
  fireflies: 0,
};

/** The middle (cells across) of the cluster's mass. */
function middle(upload: HeadlessUpload): number {
  let sum = 0;
  let n = 0;
  for (let at = 0; at < upload.width * upload.height; at++) {
    if (upload.data[2 * at] !== BEES_CODE.swarm) continue;
    sum += at % upload.width;
    n++;
  }
  expect(n).toBeGreaterThan(30);
  return sum / n;
}

describe("the swarm", () => {
  test("a hung cluster keeps to its limb when the frame widens", () => {
    const sim = new HeadlessSim(beesScene);
    sim.step({ knobs: QUIET });
    sim.step({ knobs: QUIET, now: ["swarm"] });
    for (let t = 0; t < 100; t += 0.1) sim.step({ knobs: QUIET, dt: 0.1 });
    const narrow = sim.upload(0);
    const before = middle(narrow);
    const wide = sim.step({ knobs: QUIET, dt: 0, aspect: 21 / 9 }).upload(0);
    const after = middle(wide);
    sim.dispose();
    // A limb is its tree's foot, which stands at a share of the stage, and a reach out from it in
    // metres: on a wider stage the cluster moves with the foot alone.
    const moved = (f: number): number =>
      f * (beesStage(21 / 9) - beesStage(16 / 9)) * narrow.height +
      0.5 * (wide.width - narrow.width);
    const off = Math.min(
      ...[2, 3].map((tree) => Math.abs(after - before - moved(BEES_TREES[tree]?.[0] ?? 0))),
    );
    expect(off).toBeLessThan(1.5);
  });
});
