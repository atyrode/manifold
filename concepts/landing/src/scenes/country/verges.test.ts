import { RatePhases } from "../../rate-phase.ts";
import { expect, test } from "bun:test";
import { effective, type ParamDef } from "../../params.ts";
import { visitorAlone } from "../../principals.ts";
import { LAND_USES, LandModel, type LandOptions, packLand } from "../../sims/landuse.ts";
import {
  generateTerrain,
  packTerrain,
  sampleGrid,
  TERRAIN_RECORDS,
  type TerrainPacked,
} from "../../sims/terrain.ts";
import type { SimFrame } from "../types.ts";
import { countryScene } from "./index.ts";
import { COUNTRY_SEASONS } from "./constants.ts";
import { COUNTRY_MAP } from "./sim.ts";
import {
  COUNTRY_VERGE,
  COUNTRY_VERGE_FORM,
  countryVergeYear,
  CountryVerges,
  VergeParcels,
  type VergeParcel,
} from "./verges.ts";

// The default countryside's terrain, its land used as the knobs say.
const terrain = generateTerrain({ seed: 0, size: COUNTRY_MAP.size, extent: COUNTRY_MAP.extent });
const model = new LandModel(terrain, 0);
const DEFAULT_USES: LandOptions = { shares: { crops: 60, woodland: 30 }, pines: 0.25, cows: 0.5 };
function land(options: LandOptions): TerrainPacked {
  const packed = packTerrain(terrain);
  packLand(packed, terrain, model.allocate(options));
  return packed;
}
const use = (packed: TerrainPacked, s: number): number =>
  packed.records[
    4 * ((TERRAIN_RECORDS.sites + Math.floor(s / 32)) * TERRAIN_RECORDS.width + 2 * (s % 32)) + 6
  ] ?? 0;
const USE = (name: (typeof LAND_USES)[number]): number => LAND_USES.indexOf(name);

const params: readonly ParamDef[] = countryScene.params;

function frame(
  knobs: Record<string, number>,
  motionTime = 0,
  own: readonly ParamDef[] = params,
): SimFrame {
  const values = own.map((def) => effective(def, knobs));
  // The rate knobs' phases as the renderer would have integrated them over motionTime at these knobs.
  const phases = new RatePhases(own);
  phases.step(values, motionTime);
  return {
    dt: 1 / 60,
    time: motionTime,
    motionTime,
    motion: 1,
    now: motionTime * 1000,
    budget: Infinity,
    width: 960,
    height: 540,
    aspect: 16 / 9,
    values,
    params: knobs,
    phases: phases.byKey,
    triggers: new Array<number>(8).fill(-1e4),
    fired: new Array<boolean>(8).fill(false),
    ...visitorAlone(),
    passage: { enter: 1, exit: 0 },
  };
}

const ON = { verges: 1, "verges-amount": 1, wind: 0 };

/** Each grown organ's record fields, by form, after a frame. */
function organs(verges: CountryVerges): { form: number; bend: number; pheno: number }[] {
  const plants = verges.plants;
  if (!plants) return [];
  const out: { form: number; bend: number; pheno: number }[] = [];
  for (let i = 0; i < plants.count; i++) {
    if ((plants.tier[i] ?? 0) <= 0) continue;
    out.push({
      form: plants.form[i] ?? 0,
      bend: plants.theta[i] ?? 0,
      pheno: plants.pheno[i] ?? 0,
    });
  }
  return out;
}

test("every clump stands at a hedge's foot as the shader finds it, off the roads, streams, water, yards, woods and pastures", () => {
  const packed = land({ ...DEFAULT_USES, shares: { crops: 40, woodland: 20, pasture: 60 } });
  const verges = new CountryVerges(params);
  expect(verges.frame(frame(ON), terrain, packed, true)).toBe(true);
  const parcels = new VergeParcels(terrain);
  const hit: VergeParcel = { best: -1, next: -1, border: 0, nx: 1, nz: 0 };
  const { size, extent } = terrain;
  const farmed = (u: number) => u >= USE("crops") && u <= USE("pasture");
  let beside = 0;
  for (const clump of verges.clumps) {
    parcels.at(clump.x, clump.z, hit);
    // In its own parcel, the hedge's line (between it and the parcel across) the inset away.
    expect(hit.best).toBe(clump.into);
    expect(hit.next).toBe(clump.other);
    expect(Math.abs(hit.border - COUNTRY_VERGE.inset)).toBeLessThanOrEqual(COUNTRY_VERGE.slack);
    const own = use(packed, clump.into);
    const across = use(packed, clump.other);
    expect(farmed(own) || farmed(across)).toBe(true);
    expect([USE("pasture"), USE("woodland")]).not.toContain(own);
    // Across a pasture's hedge only where the eye looks past the clump toward it (its fence
    // stands behind the clump, not in front): the lookup's normal points into the clump's own
    // parcel, away from the pasture.
    if (across === USE("pasture")) {
      beside++;
      const v = terrain.vantage;
      expect((clump.x - v.x) * hit.nx + (clump.z - v.z) * hit.nz).toBeLessThan(0);
    }
    expect(sampleGrid(terrain.road, size, extent, clump.x, clump.z)).toBeGreaterThanOrEqual(
      COUNTRY_VERGE.road,
    );
    expect(sampleGrid(terrain.stream, size, extent, clump.x, clump.z)).toBeGreaterThanOrEqual(
      COUNTRY_VERGE.stream,
    );
    expect(sampleGrid(terrain.level, size, extent, clump.x, clump.z)).toBeLessThan(clump.y - 0.3);
    expect(sampleGrid(terrain.yard, size, extent, clump.x, clump.z)).toBeLessThanOrEqual(0.05);
    expect(clump.depth).toBeGreaterThanOrEqual(COUNTRY_VERGE.near);
    expect(clump.depth).toBeLessThanOrEqual(COUNTRY_VERGE.far);
  }
  expect(verges.clumps.length).toBeGreaterThan(100);
  // Pastures' hedges carry clumps on their other side, where the eye sees past them to the fence.
  expect(beside).toBeGreaterThan(5);
});

test("a fuller verge keeps a sparser one's clumps where they stood; off, the verges let them go", () => {
  const packed = land(DEFAULT_USES);
  const verges = new CountryVerges(params);
  const at = (amount: number) => {
    verges.frame(frame({ ...ON, "verges-amount": amount }), terrain, packed, false);
    return new Set(verges.clumps.map((clump) => `${clump.x.toFixed(3)},${clump.z.toFixed(3)}`));
  };
  const sparse = at(0.3);
  const full = at(0.9);
  expect(sparse.size).toBeGreaterThan(30);
  expect(full.size).toBeGreaterThan(2 * sparse.size);
  for (const clump of sparse) expect(full.has(clump)).toBe(true);
  expect(verges.frame(frame({ verges: 0 }), terrain, packed, false)).toBe(false);
  expect(verges.plants).toBeUndefined();
});

test("the verges' plant year is each key's own, the year itself from winter to summer, and never turns back", () => {
  expect(countryVergeYear(COUNTRY_SEASONS.summer)).toBe(0.3);
  expect(countryVergeYear(COUNTRY_SEASONS.harvest)).toBe(0.47);
  expect(countryVergeYear(COUNTRY_SEASONS.autumn)).toBe(0.66);
  for (const date of [0, 0.1, 0.2, 0.25, 0.75, 0.875, 0.99])
    expect(countryVergeYear(date)).toBe(date);
  let last = -1;
  for (let date = 0; date < 1; date += 0.001) {
    const year = countryVergeYear(date);
    expect(year).toBeGreaterThan(last);
    // No jump anywhere: a step of the date moves the plant year by at most twice as much.
    if (last >= 0) expect(year - last).toBeLessThan(0.002 + 1e-9);
    last = year;
  }
});

test("the clumps flower and brown with the farming year, and pass with it: the harvest without a season knob", () => {
  const packed = land(DEFAULT_USES);
  const census = (knobs: Record<string, number>, own = params, motionTime = 0) => {
    const verges = new CountryVerges(own);
    for (let n = 0; n < 3; n++)
      verges.frame(frame({ ...ON, ...knobs }, motionTime, own), terrain, packed, n === 0);
    const forms = new Map<number, number>();
    let turned = 0;
    for (const organ of organs(verges)) {
      forms.set(organ.form, (forms.get(organ.form) ?? 0) + 1);
      turned = Math.max(turned, organ.pheno);
    }
    return { forms, turned };
  };
  const F = COUNTRY_VERGE_FORM;
  const summer = census({ season: COUNTRY_SEASONS.summer });
  const harvest = census({ season: COUNTRY_SEASONS.harvest });
  const autumn = census({ season: COUNTRY_SEASONS.autumn });
  const winter = census({ season: 0.875 });
  const spring = census({ season: 0.15 });
  // In summer every species is out: the parsley's umbels, the campion's flowers, the grass's heads.
  for (const form of Object.values(F)) expect(summer.forms.get(form) ?? 0).toBeGreaterThan(0);
  expect(summer.turned).toBe(0);
  // At harvest the parsley has seeded (no umbels, its leaves turning), the campion still flowers.
  expect(harvest.forms.get(F.umbel) ?? 0).toBe(0);
  expect(harvest.forms.get(F.campion) ?? 0).toBeGreaterThan(0);
  expect(harvest.turned).toBeGreaterThan(0.3);
  // In autumn no flower is left and the parsley's leaves are gone; the stems and the grass stay.
  expect(autumn.forms.get(F.campion) ?? 0).toBe(0);
  expect(autumn.forms.get(F.panicle) ?? 0).toBe(0);
  expect(autumn.forms.get(F.parsleyLeaf) ?? 0).toBe(0);
  expect(autumn.forms.get(F.parsleyStem)).toBe(summer.forms.get(F.parsleyStem));
  expect(autumn.forms.get(F.blade)).toBe(summer.forms.get(F.blade));
  // Through winter only dead stems and the tussocks' blades stand.
  for (const form of [F.umbel, F.campion, F.panicle, F.parsleyLeaf])
    expect(winter.forms.get(form) ?? 0).toBe(0);
  expect(winter.forms.get(F.blade)).toBe(summer.forms.get(F.blade));
  // In spring the parsley is back in leaf and flowers before the grass heads.
  expect(spring.forms.get(F.parsleyLeaf) ?? 0).toBeGreaterThan(0);
  expect(spring.forms.get(F.umbel) ?? 0).toBeGreaterThan(0);
  expect(spring.forms.get(F.panicle) ?? 0).toBe(0);
  // The passing year (two minutes a season) carries them from the harvest round to midwinter.
  const passed = census(
    { year: 1, "year-amount": 2 },
    params,
    (0.875 - COUNTRY_SEASONS.harvest) * 480,
  );
  expect(passed.forms).toEqual(winter.forms);
  // A scene without the knob keeps the harvest.
  const plain = census(
    {},
    params.filter((def) => def.key !== "season" && def.key !== "year"),
  );
  expect(plain.forms).toEqual(harvest.forms);
});

test("the wind sways them downwind and its gusts stir them; once it drops they stand exactly as clumps grown in still air", () => {
  const packed = land(DEFAULT_USES);
  const stems = (verges: CountryVerges) =>
    organs(verges)
      .filter((organ) => organ.form === COUNTRY_VERGE_FORM.parsleyStem)
      .map((organ) => organ.bend);
  const still = new CountryVerges(params);
  still.frame(frame(ON), terrain, packed, true);
  const rest = organs(still).map((organ) => organ.bend);
  expect(rest.every((bend) => bend === 0)).toBe(true);
  for (const wind of [0.8, -0.8]) {
    const verges = new CountryVerges(params);
    let time = 0;
    const run = (seconds: number, w: number) => {
      for (let n = 0; n < seconds * 60; n++, time += 1 / 60)
        verges.frame(frame({ ...ON, wind: w }, time), terrain, packed, time === 0);
    };
    run(3, wind);
    const now = stems(verges);
    run(1, wind);
    const later = stems(verges);
    // An upright stem bends clockwise (negative) as the wind blows to the right.
    expect(now.filter((bend) => Math.sign(bend) === -Math.sign(wind)).length).toBeGreaterThan(
      0.9 * now.length,
    );
    // The gust bands and the eddies keep them moving, each its own way.
    expect(new Set(now).size).toBeGreaterThan(now.length / 2);
    expect(now.filter((bend, i) => bend !== later[i]).length).toBeGreaterThan(now.length / 2);
    // The wind drops: after six seconds of still air they stand as still-grown clumps do.
    run(4, 0);
    expect(organs(verges).some((organ, i) => organ.bend !== rest[i])).toBe(true);
    run(3, 0);
    expect(organs(verges).filter((organ, i) => organ.bend !== rest[i]).length).toBe(0);
  }
});
