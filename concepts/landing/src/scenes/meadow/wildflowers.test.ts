import { expect, test } from "bun:test";
import { ATLAS_WIDTH } from "../../composer/caps.ts";
import { allocate, ATLAS_SLOT, type Allocation } from "../../composer/sim.ts";
import { sceneFeatures, shaderValues } from "../../shaders/index.ts";
import { HeadlessSim, type HeadlessFrame } from "../../sims/headless.ts";
import { loadScene } from "../index.ts";
import { meadowComposed } from "./index.ts";
import { MEADOW_FLOWERS } from "./wildflowers.ts";

const meadowScene = await loadScene("meadow");

const at = (knobs: Record<string, number>): HeadlessFrame => ({
  knobs,
  pointer: { inside: false },
});
/** Where the layers keep their data with these switched on beside the meadow's own. */
const allocation = (...more: string[]): Allocation =>
  allocate(
    meadowComposed
      .place(new Set([...meadowComposed.preset.layers, ...more]))
      .layers.map((p) => p.layer),
  );
const WITH = allocation("wildflowers");
const WITHOUT = allocation();
const FLOWER_ROWS = WITH.rows["wildflowers"] ?? { base: 0, count: 0 };
/** A layer's rows of the records atlas, as last uploaded. */
const rows = (sim: HeadlessSim, alloc: Allocation, id: string): number[] => {
  const span = alloc.rows[id] ?? { base: 0, count: 0 };
  const row = ATLAS_WIDTH * 4;
  return Array.from(
    sim.upload(ATLAS_SLOT).data.subarray(span.base * row, (span.base + span.count) * row),
  );
};
const differing = (a: readonly number[], b: readonly number[]): number =>
  a.filter((v, i) => v !== b[i]).length;
/** The bends of the clumps' stems (records 0..2 of each clump, from the wildflowers' row 1). */
function stems(sim: HeadlessSim): number[] {
  const data = rows(sim, WITH, "wildflowers");
  const out: number[] = [];
  for (let c = 0; c < MEADOW_FLOWERS.slots; c++) {
    if ((data[c * 4 + 2] ?? 0) < 0.5) continue;
    for (let j = 0; j < 3; j++) {
      const r = c * MEADOW_FLOWERS.organs + j;
      out.push(
        data[((1 + 4 * Math.floor(r / ATLAS_WIDTH) + 2) * ATLAS_WIDTH + (r % ATLAS_WIDTH)) * 4] ??
          0,
      );
    }
  }
  return out;
}

test("the wildflowers are off by default and then add nothing: no code, no rows, the other layers' data unchanged", () => {
  expect(sceneFeatures(meadowScene, shaderValues(meadowScene)).LAYER_WILDFLOWERS).toBe(0);
  expect(
    sceneFeatures(meadowScene, shaderValues(meadowScene, { wildflowers: 1 })).LAYER_WILDFLOWERS,
  ).toBe(1);
  expect(WITHOUT.rows["wildflowers"]).toBeUndefined();
  expect(FLOWER_ROWS.count).toBeGreaterThan(0);
  const off = new HeadlessSim(meadowScene);
  const on = new HeadlessSim(meadowScene);
  for (let n = 0; n < 90; n++) {
    off.step(at({}));
    on.step(at({ wildflowers: 1 }));
  }
  expect(off.upload(ATLAS_SLOT).height).toBe(WITHOUT.atlasRows);
  expect(on.upload(ATLAS_SLOT).height).toBe(WITH.atlasRows);
  // The breath, the seeds, the clocks and the near grass are what they would be without the flowers.
  for (const id of ["grass", "dandelions"])
    expect({ id, differ: differing(rows(on, WITH, id), rows(off, WITHOUT, id)) }).toEqual({
      id,
      differ: 0,
    });
  const field = WITH.fields["grass"]?.[0] ?? 0;
  expect(WITHOUT.fields["grass"]?.[0]).toBe(field);
  expect(differing(Array.from(on.upload(field).data), Array.from(off.upload(field).data))).toBe(0);
  off.dispose();
  on.dispose();
});

test("the gusts bow the wildflowers and once the air is still they stand exactly as clumps grown in it", () => {
  const calm = { wildflowers: 1, "wildflowers-amount": 1, gusts: 0, wind: 0 };
  const still = new HeadlessSim(meadowScene).step(at(calm));
  const rest = rows(still, WITH, "wildflowers");
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
  expect(differing(rows(sim, WITH, "wildflowers"), rest)).toBeGreaterThan(0);
  for (let n = 0; n < 3 * 60; n++) sim.step(at(calm));
  expect(differing(rows(sim, WITH, "wildflowers"), rest)).toBe(0);
  sim.dispose();
  still.dispose();
});
