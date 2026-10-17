import { expect, test } from "bun:test";
import { HeadlessSim } from "../../sims/headless.ts";
import { loadScene } from "../index.ts";
import { FOREST_SPIRITS } from "./build.ts";

const forestScene = await loadScene("forest");

interface SpiritRow {
  x: number;
  y: number;
  z: number;
  alpha: number;
  yaw: number;
  sink: number;
  size: number;
}

/**
 * The forest at night with `shy` spirits: the pointer comes up just right of a seated spirit's head
 * for a second, then leaves. Returns that spirit's row as the shader sees it, near and after.
 */
function approach(shy: number): { near: SpiritRow; away: SpiritRow[] } {
  const sim = new HeadlessSim(forestScene);
  const aspect = 16 / 9;
  const pointer = { x: 0.5, y: 0.5, inside: false, down: false, pressed: false, released: false };
  const step = (): void => {
    sim.step({ aspect, height: 360, knobs: { shy }, pointer });
  };
  // The spirits' row (uSim0) as last uploaded.
  const row = (i: number): SpiritRow => {
    const data = sim.upload(0).data;
    const o = i * 12;
    return {
      x: data[o] ?? 0,
      y: data[o + 1] ?? 0,
      z: data[o + 2] ?? 1,
      alpha: data[o + 3] ?? 0,
      yaw: data[o + 5] ?? 0,
      sink: data[o + 8] ?? 0,
      size: data[o + 9] ?? 0,
    };
  };
  step();
  const seated = Array.from({ length: FOREST_SPIRITS }, (_, i) => i).find(
    (i) => row(i).alpha >= 1 && row(i).sink === 0,
  );
  if (seated === undefined) throw new Error("no spirit seated at night");
  const at = row(seated);
  pointer.inside = true;
  pointer.x = (at.x + 0.05) / aspect + 0.5;
  pointer.y = at.y + (0.75 * at.size) / at.z;
  for (let n = 0; n < 60; n++) step();
  const near = row(seated);
  pointer.inside = false;
  const away: SpiritRow[] = [];
  for (let second = 1; second <= 6; second++) {
    for (let n = 0; n < 60; n++) step();
    away.push(row(seated));
  }
  return { near, away };
}

test("a shy spirit ducks into the moss facing away from the pointer, and comes back up after it has gone", () => {
  const { near, away } = approach(1);
  // Deeper than any spirit rising out of the moss (sink <= 1): down to its eyes.
  expect(near.sink).toBeGreaterThan(1.1);
  expect(near.yaw).toBeLessThan(-0.3);
  expect(away[0]?.sink ?? 0).toBeGreaterThan(1.1);
  const last = away[away.length - 1];
  expect(last?.alpha).toBe(1);
  expect(last?.sink ?? 1).toBeLessThan(0.1);
});

test("with no shy spirits they stay up and turn to look at the pointer", () => {
  const { near, away } = approach(0);
  expect(near.sink).toBe(0);
  expect(near.yaw).toBeGreaterThan(0.3);
  for (const row of away) expect(row.sink).toBe(0);
});
