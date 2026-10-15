import { expect, test } from "bun:test";
import { sceneFeatures, shaderValues } from "../../shaders/index.ts";
import { HeadlessSim, type HeadlessFrame } from "../../sims/headless.ts";
import { meadowScene } from "./index.ts";
import { MEADOW_FLOWERS } from "./wildflowers.ts";

const at = (knobs: Record<string, number>): HeadlessFrame => ({
  knobs,
  pointer: { inside: false },
});
/** uSim3's texels, for comparing two moments. */
const texels = (sim: HeadlessSim): number[] => Array.from(sim.upload(3).data);
const differing = (a: readonly number[], b: readonly number[]): number =>
  a.filter((v, i) => v !== b[i]).length;
/** The bends of the clumps' stems (records 0..2 of each clump, from row 1). */
function stems(sim: HeadlessSim): number[] {
  const { width, data } = sim.upload(3);
  const out: number[] = [];
  for (let c = 0; c < MEADOW_FLOWERS.slots; c++) {
    if ((data[c * 4 + 2] ?? 0) < 0.5) continue;
    for (let j = 0; j < 3; j++) {
      const r = c * MEADOW_FLOWERS.organs + j;
      out.push(data[((1 + 4 * Math.floor(r / width) + 2) * width + (r % width)) * 4] ?? 0);
    }
  }
  return out;
}

test("the wildflowers are off by default and then add nothing: no code, no texture, the meadow's own textures unchanged", () => {
  expect(sceneFeatures(meadowScene, shaderValues(meadowScene)).MEADOW_HAS_WILDFLOWERS).toBe(0);
  expect(
    sceneFeatures(meadowScene, shaderValues(meadowScene, { wildflowers: 1 }))
      .MEADOW_HAS_WILDFLOWERS,
  ).toBe(1);
  const off = new HeadlessSim(meadowScene);
  const on = new HeadlessSim(meadowScene);
  for (let n = 0; n < 90; n++) {
    expect(off.frame(at({}))[3]).toBeUndefined();
    expect(on.frame(at({ wildflowers: 1 }))[3]).toBeDefined();
  }
  // The seeds, the near grass and the clocks are what they would be without the flowers.
  for (const slot of [0, 1, 2])
    expect(differing(Array.from(on.upload(slot).data), Array.from(off.upload(slot).data))).toBe(0);
  off.dispose();
  on.dispose();
});

test("the gusts bow the wildflowers and once the air is still they stand exactly as clumps grown in it", () => {
  const calm = { wildflowers: 1, "wildflowers-amount": 1, gusts: 0, wind: 0 };
  const still = new HeadlessSim(meadowScene).step(at(calm));
  const rest = texels(still);
  expect(stems(still).length).toBeGreaterThan(0);
  expect(stems(still).every((bend) => bend === 0)).toBe(true);
  const sim = new HeadlessSim(meadowScene);
  const gusty = { ...calm, gusts: 1, "gusts-amount": 1, gustRate: 1, wind: 0.6 };
  let most = 0;
  let changes = 0;
  let previous = stems(sim.step(at(gusty)));
  for (let n = 0; n < 20 * 60; n++) {
    const now = stems(sim.step(at(gusty)));
    most = Math.max(most, ...now.map(Math.abs));
    changes += differing(now, previous);
    previous = now;
  }
  expect(most).toBeGreaterThan(0.05);
  expect(changes).toBeGreaterThan(1000);
  // Gusts off and no wind: after six seconds of still air they stand as still-grown clumps do.
  for (let n = 0; n < 4 * 60; n++) sim.step(at(calm));
  expect(differing(texels(sim), rest)).toBeGreaterThan(0);
  for (let n = 0; n < 3 * 60; n++) sim.step(at(calm));
  expect(differing(texels(sim), rest)).toBe(0);
  sim.dispose();
  still.dispose();
});
