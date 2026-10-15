import { expect, test } from "bun:test";
import { shaderValues } from "../../shaders/index.ts";
import { HeadlessSim, type HeadlessFrame, type HeadlessUpload } from "../../sims/headless.ts";
import { countryFeatures, countryScene } from "./index.ts";
import { COUNTRY_VERGE, COUNTRY_VERGE_FORM, countryVergeWindow } from "./verges.ts";

// uSim2: row 0 the near ridges' windows, then the organ records (sims/plants.ts PlantTexture).
interface Organ {
  bend: number;
  pheno: number;
  form: number;
  tier: number;
}

/** Every record of the verges' texture, in slot order. */
function organs({ width, height, data }: HeadlessUpload): Organ[] {
  const out: Organ[] = [];
  for (let r = 0; r < ((height - 1) / 4) * width; r++) {
    const texel = (row: number): number =>
      ((1 + 4 * Math.floor(r / width) + row) * width + (r % width)) * 4;
    out.push({
      bend: data[texel(2)] ?? 0,
      pheno: data[texel(2) + 3] ?? 0,
      form: data[texel(3)] ?? 0,
      tier: data[texel(3) + 3] ?? 0,
    });
  }
  return out;
}

/** The records' raw texels, for comparing two moments. */
const texels = (sim: HeadlessSim): number[] => Array.from(sim.upload(2).data);
const differing = (a: readonly number[], b: readonly number[]): number =>
  a.filter((v, i) => v !== b[i]).length;
const at = (knobs: Record<string, number>): HeadlessFrame => ({
  knobs,
  pointer: { inside: false },
});

test("the verges are off by default and then add nothing: no code in the program, no plants, no texture", () => {
  expect(countryFeatures(shaderValues(countryScene)).COUNTRY_HAS_VERGES).toBe(0);
  expect(countryFeatures(shaderValues(countryScene, { verges: 1 })).COUNTRY_HAS_VERGES).toBe(1);
  const sim = new HeadlessSim(countryScene);
  for (let n = 0; n < 30; n++) expect(sim.frame(at({ wind: 0.8 }))[2]).toBeUndefined();
  // Switched on and off again, it lets its plants go.
  expect(sim.frame(at({ verges: 1 }))[2]).toBeDefined();
  expect(sim.frame(at({ verges: 0 }))[2]).toBeUndefined();
  sim.dispose();
});

test("the windows cover both near ridges across the frame, the second's after the first's", () => {
  const sim = new HeadlessSim(countryScene).step(at({ verges: 1 }));
  const { width, height, data } = sim.upload(2);
  const near = countryVergeWindow(0, 16 / 9, 0, 0);
  const second = countryVergeWindow(1, 16 / 9, 0, 0);
  expect(Array.from(data.subarray(0, 8))).toEqual([
    near.x,
    near.y,
    near.cols,
    near.rows,
    second.x,
    second.y,
    second.cols,
    second.rows,
  ]);
  // Four borders a cell, two clumps a border, every slot its organs.
  const slots = (near.cols * near.rows + second.cols * second.rows) * 8;
  expect(width * ((height - 1) / 4)).toBeGreaterThanOrEqual(slots * COUNTRY_VERGE.organs);
  // A wider frame needs more cells across, never more down the slope.
  const wide = countryVergeWindow(1, 2.4, 0, 0);
  expect(wide.cols).toBeGreaterThan(second.cols);
  expect(wide.rows).toBe(second.rows);
  sim.dispose();
});

test("switched on, clumps flower and brown with the farming year, and a sparser verge keeps a fuller one's clumps", () => {
  const census = (
    knobs: Record<string, number>,
  ): { forms: Map<number, number>; slots: Set<number>; turned: number } => {
    const sim = new HeadlessSim(countryScene);
    for (let n = 0; n < 10; n++) sim.step(at({ verges: 1, wind: 0, ...knobs }));
    const out = { forms: new Map<number, number>(), slots: new Set<number>(), turned: 0 };
    organs(sim.upload(2)).forEach((organ, r) => {
      if (organ.tier <= 0) return;
      out.forms.set(organ.form, (out.forms.get(organ.form) ?? 0) + 1);
      out.slots.add(Math.floor(r / COUNTRY_VERGE.organs));
      out.turned = Math.max(out.turned, organ.pheno);
    });
    sim.dispose();
    return out;
  };
  const F = COUNTRY_VERGE_FORM;
  const summer = census({ season: 0 });
  const harvest = census({ season: 1 });
  const autumn = census({ season: 2 });
  // Every species grows; in summer the parsley's umbels are out, the campion's flowers and the
  // grass's heads too.
  for (const form of Object.values(F)) expect(summer.forms.get(form) ?? 0).toBeGreaterThan(0);
  expect(summer.turned).toBe(0);
  // At harvest the parsley has seeded (no umbels, its leaves turning), the campion still flowers.
  expect(harvest.forms.get(F.umbel) ?? 0).toBe(0);
  expect(harvest.forms.get(F.campion) ?? 0).toBeGreaterThan(0);
  expect(harvest.turned).toBeGreaterThan(0.3);
  // In autumn no flower is left and the parsley's leaves are gone.
  expect(autumn.forms.get(F.campion) ?? 0).toBe(0);
  expect(autumn.forms.get(F.panicle) ?? 0).toBe(0);
  expect(autumn.forms.get(F.parsleyLeaf) ?? 0).toBe(0);
  // The stems and the grass stay.
  expect(autumn.forms.get(F.parsleyStem)).toBe(summer.forms.get(F.parsleyStem));
  expect(autumn.forms.get(F.blade)).toBe(summer.forms.get(F.blade));
  const sparse = census({ season: 0, "verges-amount": 0.3 });
  expect(sparse.slots.size).toBeGreaterThan(0);
  expect(sparse.slots.size).toBeLessThan(summer.slots.size);
  for (const slot of sparse.slots) expect(summer.slots.has(slot)).toBe(true);
});

test("the wind sways them downwind and the gust bands stir them; once it drops they stand exactly as clumps grown in still air", () => {
  const still = new HeadlessSim(countryScene).step(at({ verges: 1, wind: 0 }));
  const rest = texels(still);
  // At rest nothing is bent.
  expect(organs(still.upload(2)).every((organ) => organ.bend === 0)).toBe(true);
  for (const wind of [0.8, -0.8]) {
    const sim = new HeadlessSim(countryScene);
    for (let n = 0; n < 3 * 60; n++) sim.step(at({ verges: 1, wind }));
    const stems = (): number[] =>
      organs(sim.upload(2))
        .filter((organ) => organ.tier > 0 && organ.form === COUNTRY_VERGE_FORM.parsleyStem)
        .map((organ) => organ.bend);
    const now = stems();
    for (let n = 0; n < 60; n++) sim.step(at({ verges: 1, wind }));
    const later = stems();
    // An upright stem bends clockwise (negative) as the wind blows to the right.
    const downwind = now.filter((bend) => Math.sign(bend) === -Math.sign(wind)).length;
    expect(downwind).toBeGreaterThan(0.9 * now.length);
    // The gust bands and the eddies keep them moving, each its own way.
    expect(new Set(now).size).toBeGreaterThan(now.length / 2);
    expect(differing(now, later)).toBeGreaterThan(now.length / 2);
    // The wind drops: after six seconds of still air they stand as still-grown clumps do.
    for (let n = 0; n < 4 * 60; n++) sim.step(at({ verges: 1, wind: 0 }));
    expect(differing(texels(sim), rest)).toBeGreaterThan(0);
    for (let n = 0; n < 3 * 60; n++) sim.step(at({ verges: 1, wind: 0 }));
    expect(differing(texels(sim), rest)).toBe(0);
    sim.dispose();
  }
  still.dispose();
});
