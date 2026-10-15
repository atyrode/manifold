import { describe, expect, test } from "bun:test";
import { HeadlessGl } from "./headless.ts";
import {
  PLANT_SUMMER,
  PlantHabit,
  PlantRole,
  PlantTexture,
  RootedPlants,
  plantClimate,
  plantFitness,
  type PlantClimate,
  type PlantSpecies,
} from "./plants.ts";

const H = 1 / 60;

/** A stalk standing up (+y) from its site, a blade on its tip and a flower half way up. */
function stalked(overrides: Partial<PlantSpecies> = {}): PlantSpecies {
  return {
    id: "stalked",
    moisture: [0.3, 0.9],
    sway: { hz: 0.6, damping: 0.6, give: 0.2, limit: 0.6 },
    year: { shed: 1, turn: 0.55, bloom: [0.2, 0.6] },
    life: { unfold: 5, span: 60 },
    detail: { simple: 4, min: 1 },
    build(plant) {
      const stalk = plant.organ({ angle: plant.site.heading, length: 0.2, width: 0.01, form: 1 });
      plant.organ({
        parent: stalk,
        angle: 0.4,
        length: 0.08,
        form: 2,
        role: PlantRole.leaf,
        habit: PlantHabit.rigid,
      });
      plant.organ({
        parent: stalk,
        at: 0.5,
        angle: -0.3,
        length: 0.02,
        form: 3,
        role: PlantRole.bloom,
        habit: PlantHabit.rigid,
      });
    },
    ...overrides,
  };
}

/** `count` plants along the x axis, `gap` apart, growing up. */
function row(species: PlantSpecies, count: number, gap = 0.3): RootedPlants {
  const plants = new RootedPlants(64, 3);
  for (let i = 0; i < count; i++)
    plants.add(species, { x: i * gap, y: 0, heading: Math.PI / 2, moisture: 0.5 }, () => 0.5);
  return plants;
}

function run(plants: RootedPlants, climate: PlantClimate, seconds: number): void {
  climate.dt = H;
  for (let t = 0; t < seconds; t += H) {
    climate.time += H;
    plants.step(climate);
  }
}

/** Where organ o's tip is. */
function tip(plants: RootedPlants, o: number): [number, number] {
  const out = new Float64Array(3);
  plants.pointAt(o, 1, out);
  return [out[0] ?? 0, out[1] ?? 0];
}

describe("RootedPlants", () => {
  test("a plant keeps its root and every organ stays on its parent while it sways", () => {
    const plants = row(stalked(), 2);
    const climate = plantClimate();
    climate.air.x = 0.8;
    climate.air.eddy = 0.5;
    plants.settle(climate);
    const count = plants.count;
    run(plants, climate, 4);
    expect(plants.count).toBe(count);
    const at = new Float64Array(3);
    for (let i = 0; i < plants.count; i++) {
      const parent = plants.parent[i] ?? -1;
      if (parent < 0) {
        const site = plants.siteOf(plants.plantOf[i] ?? 0);
        expect(plants.x[i]).toBe(site.x);
        expect(plants.y[i]).toBe(site.y);
        continue;
      }
      plants.pointAt(parent, plants.at[i] ?? 1, at);
      expect(
        Math.hypot((plants.x[i] ?? 0) - (at[0] ?? 0), (plants.y[i] ?? 0) - (at[1] ?? 0)),
      ).toBeLessThan(1e-9);
    }
  });

  test("a steady breeze bends a stalk downwind and holds it at the spring's balance", () => {
    const plants = row(stalked(), 1);
    const climate = plantClimate();
    plants.settle(climate);
    const [still] = tip(plants, 0);
    climate.air.x = 0.5;
    run(plants, climate, 12);
    const [bent] = tip(plants, 0);
    expect(bent).toBeGreaterThan(still + 0.005);
    // Upright stalk, breeze along +x: the push across it is -0.5, so θ = limit · tanh(give · -0.5 / limit).
    const expected = 0.6 * Math.tanh((0.2 * -0.5) / 0.6);
    expect(plants.theta[0] ?? 0).toBeCloseTo(expected, 2);
    // A breeze from the other side bends it the other way.
    climate.air.x = -0.5;
    run(plants, climate, 12);
    expect(tip(plants, 0)[0]).toBeLessThan(still - 0.005);
  });

  test("with no time passing nothing moves, whatever the wind", () => {
    const plants = row(stalked(), 1);
    const climate = plantClimate();
    climate.air.x = 0.6;
    run(plants, climate, 1);
    const before = Float32Array.from(plants.theta);
    climate.dt = 0;
    climate.air.x = -1;
    for (let k = 0; k < 10; k++) plants.step(climate);
    expect(Array.from(plants.theta)).toEqual(Array.from(before));
  });

  test("a gust's front reaches the plants downwind later", () => {
    const plants = row(stalked(), 2, 1.2);
    const climate = plantClimate();
    climate.air.x = 0.01;
    climate.air.front = 0.6;
    plants.settle(climate);
    climate.air.gustNow = true;
    climate.dt = H;
    climate.time += H;
    plants.step(climate);
    climate.air.gustNow = false;
    // The upwind stalk (x = 0) bends hardest about 2 + rise seconds in; the downwind one (x = 1.2) two
    // seconds later.
    const peak = [0, 0];
    const when = [0, 0];
    for (let t = H; t < 12; t += H) {
      climate.time += H;
      plants.step(climate);
      for (const [k, stalk] of [0, 3].entries()) {
        const bend = Math.abs(plants.theta[stalk] ?? 0);
        if (bend > (peak[k] ?? 0)) {
          peak[k] = bend;
          when[k] = t;
        }
      }
    }
    expect(peak[0]).toBeGreaterThan(0.05);
    expect((when[1] ?? 0) - (when[0] ?? 0)).toBeGreaterThan(1.5);
    expect((when[1] ?? 0) - (when[0] ?? 0)).toBeLessThan(2.5);
  });

  test("high summer shows every organ out and green; winter strips a deciduous plant; flowers keep their season", () => {
    const plants = row(stalked(), 1);
    const climate = plantClimate();
    plants.settle(climate);
    expect(Array.from(plants.size.subarray(0, plants.count))).toEqual([1, 1, 1]);
    expect(Array.from(plants.pheno.subarray(0, plants.count))).toEqual([0, 0, 0]);
    climate.season = 0.68;
    plants.step(climate);
    expect(plants.pheno[1] ?? 0).toBeGreaterThan(0.4);
    climate.season = 0.9;
    plants.step(climate);
    expect(plants.size[0]).toBe(1);
    expect(plants.size[1]).toBe(0);
    expect(plants.size[2]).toBe(0);
    expect(plants.tier[1]).toBe(0);
    climate.season = PLANT_SUMMER;
    plants.step(climate);
    expect(plants.size[1]).toBe(1);
  });

  test("growth replaces each leaf in turn and holds still without it", () => {
    const plants = row(stalked({ year: { shed: 0, turn: 0.55, bloom: [0, 1] } }), 1);
    const climate = plantClimate();
    plants.settle(climate);
    climate.dt = 1;
    for (let k = 0; k < 30; k++) plants.step(climate);
    expect(plants.cycle[1]).toBe(0);
    expect(plants.size[1]).toBe(1);
    climate.growth = 1;
    let sawGap = false;
    let sawYoung = false;
    for (let k = 0; k < 120; k++) {
      plants.step(climate);
      if ((plants.size[1] ?? 1) === 0) sawGap = true;
      if ((plants.pheno[1] ?? 0) < -0.1) sawYoung = true;
    }
    expect(sawGap).toBe(true);
    expect(sawYoung).toBe(true);
    expect(plants.cycle[1] ?? 0).toBeGreaterThan(0);
    // The stalk is structure: it never goes.
    expect(plants.size[0]).toBe(1);
  });

  test("a water plant streams with the current and leans with it when upright", () => {
    const kelp: PlantSpecies = {
      ...stalked(),
      aquatic: true,
      build(plant) {
        plant.organ({ angle: plant.site.heading, length: 0.1, width: 0.02, form: 1 });
        plant.organ({ angle: 0, length: 0.03, form: 2, habit: PlantHabit.upright });
      },
    };
    const plants = row(kelp, 1);
    const climate = plantClimate();
    climate.air.x = 1;
    climate.current = (_x, _y, out) => {
      out[0] = 0.8;
      out[1] = 0;
    };
    plants.settle(climate);
    // Upright stalk in a flow toward +x: quadratic drag, |u| u = 0.64 across it.
    expect(plants.theta[0] ?? 0).toBeCloseTo(0.6 * Math.tanh((0.2 * -0.64) / 0.6), 5);
    expect(plants.theta[1] ?? 0).toBeGreaterThan(0.05);
    expect(Math.abs(plants.lean[1] ?? 1)).toBeLessThan(1e-9);
  });

  test("organs too small for a cell are not drawn", () => {
    const plants = row(stalked(), 1);
    plants.cells = 100;
    plants.settle(plantClimate());
    // Stalk 20 cells (full), blade 8 (full), flower 2 (simplified).
    expect(Array.from(plants.tier.subarray(0, 3))).toEqual([2, 2, 1]);
    plants.cells = 40;
    plants.pose();
    expect(Array.from(plants.tier.subarray(0, 3))).toEqual([2, 1, 0]);
  });

  test("organs on the site spring from their offsets, and the scene's own air bends them where it blows", () => {
    // Two stalks from one site: one a little left of it, one a little right, both 0.1 above.
    const pair: PlantSpecies = {
      ...stalked(),
      build(plant) {
        plant.organ({ offset: [-0.1, 0.1], angle: Math.PI / 2, length: 0.2, form: 1 });
        plant.organ({ offset: [0.1, 0.1], angle: Math.PI / 2, length: 0.2, form: 1 });
      },
    };
    const plants = new RootedPlants(8, 2);
    plants.add(pair, { x: 1, y: 0, heading: Math.PI / 2 }, () => 0.5);
    const climate = plantClimate();
    // Air of the scene's own, blowing right only right of x = 1: a front that has reached one stalk.
    climate.wind = (x, _y, out) => {
      out[0] = x > 1 ? 0.5 : 0;
    };
    plants.settle(climate);
    expect(
      [plants.x[0], plants.y[0], plants.x[1], plants.y[1]].map((v) => Number((v ?? 0).toFixed(9))),
    ).toEqual([0.9, 0.1, 1.1, 0.1]);
    run(plants, climate, 12);
    expect(plants.theta[0] ?? 1).toBe(0);
    expect(plants.theta[1] ?? 0).toBeCloseTo(0.6 * Math.tanh((0.2 * -0.5) / 0.6), 2);
    // The bases stay where they spring from.
    expect([plants.x[0], plants.x[1]].map((v) => Number((v ?? 0).toFixed(9)))).toEqual([0.9, 1.1]);
  });

  test("fitness fades out over a quarter beyond the band", () => {
    const species = stalked();
    expect(plantFitness(species, 0.5)).toBe(1);
    expect(plantFitness(species, 0.9 + 0.125)).toBeCloseTo(0.5, 9);
    expect(plantFitness(species, 0)).toBe(0);
  });
});

describe("PlantTexture", () => {
  test("records land at their slots, positions to half-float pairs, hidden ones zero", () => {
    const headless = new HeadlessGl();
    const plants = new RootedPlants(16, 1);
    const species = stalked();
    plants.add(species, { x: 1.2345, y: -0.4321, heading: 0.3, slot: 5 }, () => 0.5);
    plants.cells = 40;
    plants.settle(plantClimate());
    const records = new PlantTexture(headless.gl, 8, { width: 4, rowBase: 2 });
    records.pack(plants);
    records.upload();
    const { width, height, data } = headless.upload(records.texture);
    expect([width, height]).toEqual([4, 2 + 8]);
    // Default slots are the organ indices: the stalk at record 0, the blade at 1; the flower (tier 0) hidden.
    const texel = (r: number, k: number) =>
      Array.from(
        data.subarray(
          ((2 + 4 * Math.floor(r / 4) + k) * 4 + (r % 4)) * 4,
          ((2 + 4 * Math.floor(r / 4) + k) * 4 + (r % 4)) * 4 + 4,
        ),
      );
    const [xh = 0, xl = 0, yh = 0, yl = 0] = texel(0, 0);
    expect(Math.abs(xh + xl - 1.2345)).toBeLessThan(1e-6);
    expect(Math.abs(yh + yl + 0.4321)).toBeLessThan(1e-6);
    expect(texel(0, 1)[0]).toBeCloseTo(Math.cos(0.3), 6);
    expect(texel(1, 3)[3]).toBe(1);
    expect(texel(2, 3)).toEqual([0, 0, 0, 0]);
    // The scene's own rows stay as it wrote them.
    expect(Array.from(data.subarray(0, 32)).every((v) => v === 0)).toBe(true);
  });

  test("two systems share one texture, each at its slots; an organ with a negative slot is never packed", () => {
    const headless = new HeadlessGl();
    const species = stalked();
    const near = new RootedPlants(8, 1);
    near.add(species, { x: 0.5, y: 0, heading: Math.PI / 2, slot: 0 }, () => 0.5);
    const far: PlantSpecies = {
      ...species,
      build(plant) {
        const stem = plant.organ({ angle: Math.PI / 2, length: 0.3, form: 7, slot: -1 });
        plant.organ({ parent: stem, angle: 0.2, length: 0.1, form: 8, slot: 0 });
      },
    };
    const back = new RootedPlants(8, 2);
    back.add(far, { x: 3, y: 1, heading: Math.PI / 2, slot: 4 }, () => 0.5);
    for (const plants of [near, back]) {
      plants.cells = 100;
      plants.settle(plantClimate());
    }
    const records = new PlantTexture(headless.gl, 8, { width: 8 });
    records.pack(near, back);
    records.upload();
    const { data } = headless.upload(records.texture);
    const form = (r: number): number => data[(3 * 8 + r) * 4] ?? -1;
    const tier = (r: number): number => data[(3 * 8 + r) * 4 + 3] ?? -1;
    // The near stalk, blade and flower at their records 0..2, the far system's blade at 4; its stem nowhere.
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(form)).toEqual([1, 2, 3, 0, 8, 0, 0, 0]);
    expect(tier(4)).toBe(2);
    expect(Math.abs((data[4 * 4] ?? 0) + (data[4 * 4 + 1] ?? 0) - 3)).toBeLessThan(1e-6);
  });
});
