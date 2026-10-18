import { expect, test } from "bun:test";
import { ATLAS_WIDTH } from "../../composer/caps.ts";
import { allocate, ATLAS_SLOT } from "../../composer/sim.ts";
import { HeadlessSim, type HeadlessFrame, type HeadlessUpload } from "../../sims/headless.ts";
import { loadScene } from "../index.ts";
import { gardenComposed } from "./index.ts";
import { GARDEN_BORDER, GARDEN_BORDER_FORM, GARDEN_ISLANDS, GARDEN_WOODS } from "./sim.ts";

const gardenScene = await loadScene("garden");

// Where the preset's layers keep their data in the records atlas, with its home layers on and with
// the border too: the gravel's row (its islands, then the drying clock), the woods' and the border's
// plant records, the boughs' row (their leaves).
const rowsOf = (on: readonly string[]) =>
  allocate(gardenComposed.place(new Set(on)).layers.map((placed) => placed.layer)).rows;
const HOME = rowsOf(gardenComposed.preset.layers);
const WITH_BORDER = rowsOf([...gardenComposed.preset.layers, "border"]);
const GRAVEL_ROW = HOME["gravel"]?.base ?? 0;
const WOODS_ROW = HOME["templeWoods"]?.base ?? 0;
const LEAF_ROW = HOME["boughs"]?.base ?? 0;
const BORDER_ROW = WITH_BORDER["border"]?.base ?? 0;

// The gravel's drying clock goes to the shader in its row (the texel after the islands): fresh
// gravel's damp fades with `clock - when raked`. These run the sim on the headless stand-in and read
// it there; `knobs` are as in the URL (a feature: 1 for on, and `<key>-amount`).

function dryingClock(knobs: Record<string, number>, seconds: number): number {
  const sim = new HeadlessSim(gardenScene);
  for (let n = 0; n < seconds * 60; n++) sim.step({ knobs, pointer: { inside: false } });
  const clock =
    sim.upload(ATLAS_SLOT).data[(GRAVEL_ROW * ATLAS_WIDTH + GARDEN_ISLANDS) * 4] ?? Number.NaN;
  sim.dispose();
  return clock;
}

test("by default fresh gravel dries on garden time, whatever the weather", () => {
  expect(dryingClock({}, 4)).toBeCloseTo(4, 2);
  expect(dryingClock({ rain: 1, "rain-amount": 0.7, time: 0 }, 4)).toBeCloseTo(4, 2);
});

test("drying with the weather: rain stops it, the night slows it, more weathering hurries it", () => {
  const on = { drying: 1, "drying-amount": 0.5, wind: 0 };
  expect(dryingClock({ ...on, rain: 1, "rain-amount": 0.7 }, 3)).toBe(0);
  const noon = dryingClock({ ...on, time: 0.5 }, 3);
  // A still midday at the weathering knob's default dries at the garden's own pace.
  expect(noon).toBeCloseTo(3, 2);
  expect(dryingClock({ ...on, time: 0 }, 3)).toBeLessThan(0.5 * noon);
  expect(dryingClock({ ...on, time: 0.5, soften: 1 }, 3)).toBeGreaterThan(2 * noon);
  expect(dryingClock({ ...on, time: 0.5, soften: 0 }, 3)).toBeLessThan(0.5 * noon);
});

test("drying with the weather: winter's rain comes down as snow, which dries the gravel as snow does", () => {
  const on = { drying: 1, "drying-amount": 0.5, wind: 0, time: 0.5 };
  const rain = { rain: 1, "rain-amount": 0.7 };
  const winterSnow = dryingClock({ ...on, season: 3, snow: 1, "snow-amount": 0.7 }, 3);
  expect(winterSnow).toBeGreaterThan(1);
  expect(dryingClock({ ...on, ...rain, season: 3 }, 3)).toBeCloseTo(winterSnow, 6);
  // Spring, summer and autumn rain is rain.
  for (const season of [0, 1, 2]) expect(dryingClock({ ...on, ...rain, season }, 3)).toBe(0);
});

test("the page stays light under winter's rain, which comes down as snow, and goes dark under the rest's", () => {
  const theme = gardenScene.theme;
  if (!theme) throw new Error("garden has no page theme");
  const noonRain = { time: 0.5, rain: 1, "rain-amount": 0.7 };
  expect(theme({ time: 0.5 })).toBe("paper");
  expect(theme({ ...noonRain, season: 3 })).toBe("paper");
  for (const season of [0, 1, 2]) expect(theme({ ...noonRain, season })).toBe("night");
  expect(theme({ ...noonRain, season: 3, time: 0 })).toBe("night");
});

// The boughs' row: four rgba16f texels a leaf: (x, y, z, alpha), (chord axis, radius), (span axis,
// kind), (hue, age on the ground 0..1, landed 0..1, 0); alpha 0: no leaf.
interface Leaf {
  x: number;
  chordUp: number;
  spanUp: number;
  hue: number;
  age: number;
  landed: boolean;
}

function leaves(sim: HeadlessSim): Leaf[] {
  const data = sim.upload(ATLAS_SLOT).data;
  const out: Leaf[] = [];
  for (let i = 0; i < 24; i++) {
    const o = (LEAF_ROW * ATLAS_WIDTH + 4 * i) * 4;
    if (!((data[o + 3] ?? 0) > 0)) continue;
    out.push({
      x: data[o] ?? 0,
      chordUp: data[o + 6] ?? 0,
      spanUp: data[o + 10] ?? 0,
      hue: data[o + 12] ?? 0,
      age: data[o + 13] ?? 0,
      landed: data[o + 14] === 1,
    });
  }
  return out;
}

test("leaves lying on the gravel lie flat, face up or face down", () => {
  const sim = new HeadlessSim(gardenScene);
  // Long enough down to have settled (age is the share of a life of at least 45 s).
  const settled = leaves(sim.step({ pointer: { inside: false } })).filter(
    (leaf) => leaf.landed && leaf.age > 0.02,
  );
  sim.dispose();
  expect(settled.length).toBeGreaterThanOrEqual(5);
  // Within the few degrees a leaf rests off flat (its rest pitch is within ±0.07 rad).
  for (const leaf of settled) {
    expect(Math.abs(leaf.chordUp)).toBeLessThan(0.0701);
    expect(Math.abs(leaf.spanUp)).toBeLessThan(0.0701);
  }
});

test("the composer's gusts blow the leaves lying on the gravel the way the wind is set", () => {
  // The same garden with its gusts off and on: each leaf lying there from the start (known by its
  // hue) ends up downwind of where it lies in the calm garden.
  const drift = (wind: number): number[] => {
    const calm = new HeadlessSim(gardenScene);
    const blown = new HeadlessSim(gardenScene);
    const still = { wind, leafFall: 0 };
    const gusty = { ...still, gusts: 1, "gusts-amount": 1, gustRate: 1 };
    const lying = leaves(calm.step({ knobs: still, pointer: { inside: false } }))
      .filter((leaf) => leaf.landed)
      .map((leaf) => leaf.hue);
    blown.step({ knobs: gusty, pointer: { inside: false } });
    for (let n = 1; n < 20 * 60; n++) {
      calm.step({ knobs: still, pointer: { inside: false } });
      blown.step({ knobs: gusty, pointer: { inside: false } });
    }
    const quiet = leaves(calm);
    const moved = leaves(blown);
    calm.dispose();
    blown.dispose();
    return lying.flatMap((hue) => {
      const a = quiet.find((leaf) => leaf.hue === hue);
      const b = moved.find((leaf) => leaf.hue === hue);
      return a && b && a.landed && b.landed ? [b.x - a.x] : [];
    });
  };
  const left = drift(-0.7);
  expect(left.length).toBeGreaterThanOrEqual(3);
  for (const dx of left) expect(dx).toBeLessThan(0);
  const right = drift(0.7);
  expect(right.length).toBeGreaterThanOrEqual(3);
  for (const dx of right) expect(dx).toBeGreaterThan(0);
});

// The plant records (sims/plants.ts writePlantRecords at ATLAS_WIDTH, from a layer's first row): the
// woods' stems (GARDEN_WOODS), the border's organs (GARDEN_BORDER).
interface PlantRecord {
  x: number;
  y: number;
  cos: number;
  sin: number;
  len: number;
  bend: number;
  pheno: number;
  form: number;
  tier: number;
}

/** Record r's texel `row` (0..3) from the layer's first row `base`. */
const recordTexel = (base: number, r: number, row: number): number =>
  ((base + 4 * Math.floor(r / ATLAS_WIDTH) + row) * ATLAS_WIDTH + (r % ATLAS_WIDTH)) * 4;

function plantRecord({ data }: HeadlessUpload, base: number, r: number): PlantRecord {
  const [t0, t1, t2, t3] = [0, 1, 2, 3].map((row) => recordTexel(base, r, row)) as [
    number,
    number,
    number,
    number,
  ];
  return {
    x: (data[t0] ?? 0) + (data[t0 + 1] ?? 0),
    y: (data[t0 + 2] ?? 0) + (data[t0 + 3] ?? 0),
    cos: data[t1] ?? 0,
    sin: data[t1 + 1] ?? 0,
    len: data[t1 + 2] ?? 0,
    bend: data[t2] ?? 0,
    pheno: data[t2 + 3] ?? 0,
    form: data[t3] ?? 0,
    tier: data[t3 + 3] ?? 0,
  };
}

/** How far across a woods crown stands carried, as the shader's gardenCrownShift reads its stem: the tip bent minus the tip unbent. */
function crownShift(stem: PlantRecord): number {
  const half = 0.5 * stem.bend;
  const chord = stem.len * (Math.abs(half) < 1e-4 ? 1 : Math.sin(half) / half);
  return chord * (stem.cos * Math.cos(half) - stem.sin * Math.sin(half)) - stem.len * stem.cos;
}

/** `count` records from the layer's first row `base`, as their raw texels. */
function recordTexels(sim: HeadlessSim, base: number, count: number): number[] {
  const { data } = sim.upload(ATLAS_SLOT);
  const out: number[] = [];
  for (let r = 0; r < count; r++)
    for (let row = 0; row < 4; row++)
      for (let c = 0; c < 4; c++) out.push(data[recordTexel(base, r, row) + c] ?? Number.NaN);
  return out;
}

/** How many of two runs of texels differ (-0 and 0 the same: both draw an unbent organ). */
const differing = (a: readonly number[], b: readonly number[]): number =>
  a.filter((v, i) => v !== b[i]).length;

const WOODS = 2 * GARDEN_WOODS.crowns;
const BORDER = GARDEN_BORDER.bins * GARDEN_BORDER.organs;
/** The woods' crowns in the default frame (16 / 9 wide): a row's crown k stands about (k + 0.5 - wobble / 2) / rate across. */
const shown = (row: typeof GARDEN_WOODS.far, k: number): number =>
  (k + 0.5 - 0.5 * row.wobble) / row.rate;
const ASPECT = 16 / 9;
const VISIBLE = [...Array(GARDEN_WOODS.crowns).keys()].filter(
  (k) => shown(GARDEN_WOODS.far, k) < ASPECT,
);

test("in still air the woods stand as laid out; the gusts bow them downwind, and once they are off the woods stand exactly as laid out again", () => {
  const calm = { wind: 0, border: 1, "border-amount": 1 };
  const gusty = { ...calm, gusts: 1, "gusts-amount": 1, gustRate: 1 };
  const at = (knobs: Record<string, number>): HeadlessFrame => ({
    knobs,
    pointer: { inside: false },
  });
  const sim = new HeadlessSim(gardenScene).step(at(calm));
  const rest = recordTexels(sim, WOODS_ROW, WOODS);
  const borderRest = recordTexels(sim, BORDER_ROW, BORDER);
  // Every stem is drawn and unbent (-0 and 0 alike): the shader draws the crowns where it always
  // drew them.
  for (let r = 0; r < WOODS; r++) {
    const stem = plantRecord(sim.upload(ATLAS_SLOT), WOODS_ROW, r);
    expect({ tier: stem.tier, unbent: stem.bend === 0 }).toEqual({ tier: 2, unbent: true });
  }
  for (let n = 0; n < 120; n++) sim.step(at(calm));
  expect(differing(recordTexels(sim, WOODS_ROW, WOODS), rest)).toBe(0);

  // The composer's gusts in still air blow to the right: the crowns bow a cell or more downwind at
  // 540 cells high, never a crown's width; the border bows too.
  let most = 0;
  let least = 0;
  let swayed = 0;
  for (let n = 0; n < 20 * 60; n++) {
    sim.step(at(gusty));
    for (const k of VISIBLE) {
      const shift = crownShift(plantRecord(sim.upload(ATLAS_SLOT), WOODS_ROW, k));
      most = Math.max(most, shift);
      least = Math.min(least, shift);
    }
    swayed = Math.max(swayed, differing(recordTexels(sim, BORDER_ROW, BORDER), borderRest));
  }
  expect(most).toBeGreaterThan(1.5 / 540);
  expect(most).toBeLessThan(15 / 540);
  expect(least).toBeGreaterThan(-most);
  expect(swayed).toBeGreaterThan(0);
  // The gusts off, six seconds of still air later everything stands as laid out.
  for (let n = 0; n < 12 * 60; n++) sim.step(at(calm));
  expect(differing(recordTexels(sim, WOODS_ROW, WOODS), rest)).toBe(0);
  expect(differing(recordTexels(sim, BORDER_ROW, BORDER), borderRest)).toBe(0);
  sim.dispose();
});

test("the exit's gust crosses the woods from the garden's upwind end, the crowns bowing one after another", () => {
  const sim = new HeadlessSim(gardenScene).step({ knobs: { wind: 0 }, pointer: { inside: false } });
  const left = VISIBLE.filter((k) => shown(GARDEN_WOODS.far, k) < ASPECT / 3);
  const right = VISIBLE.filter((k) => shown(GARDEN_WOODS.far, k) > (2 * ASPECT) / 3);
  const mean = (ks: number[]): number =>
    ks.reduce((sum, k) => sum + crownShift(plantRecord(sim.upload(ATLAS_SLOT), WOODS_ROW, k)), 0) /
    ks.length;
  // The exit's gust blows to the right in still air (sims/wind.ts windSign): most of the way through
  // the exit, its front has bowed the left third and not yet reached the right third.
  for (let n = 1; n <= 81; n++)
    sim.step({ knobs: { wind: 0 }, pointer: { inside: false }, passage: { exit: n / 90 } });
  expect(mean(left)).toBeGreaterThan(0.5 / 540);
  expect(Math.abs(mean(right))).toBeLessThan(0.1 / 540);
  sim.dispose();
});

test("with motion off the woods stand still, the gusts on or not", () => {
  const knobs = { wind: 0, gusts: 1, "gusts-amount": 1, gustRate: 1 };
  const sim = new HeadlessSim(gardenScene).step({ motion: 0, knobs, pointer: { inside: false } });
  const rest = recordTexels(sim, WOODS_ROW, WOODS);
  for (let n = 0; n < 5 * 60; n++) sim.step({ motion: 0, knobs, pointer: { inside: false } });
  expect(differing(recordTexels(sim, WOODS_ROW, WOODS), rest)).toBe(0);
  sim.dispose();
});

test("a breeze leans the woods downwind and stirs them crown by crown", () => {
  for (const wind of [-0.6, 0.6]) {
    const sim = new HeadlessSim(gardenScene);
    const knobs = { wind };
    const shifts = (): number[] =>
      [...Array(GARDEN_WOODS.crowns).keys()].map((k) =>
        crownShift(plantRecord(sim.upload(ATLAS_SLOT), WOODS_ROW, k)),
      );
    for (let n = 0; n < 5 * 60; n++) sim.step({ knobs, pointer: { inside: false } });
    const now = shifts();
    for (let n = 0; n < 2 * 60; n++) sim.step({ knobs, pointer: { inside: false } });
    const later = shifts();
    sim.dispose();
    for (const shift of [...now, ...later]) expect(Math.sign(shift)).toBe(Math.sign(wind));
    expect(new Set(now).size).toBeGreaterThan(GARDEN_WOODS.crowns / 2);
    expect(differing(now, later)).toBeGreaterThan(GARDEN_WOODS.crowns / 2);
  }
});

test("the border is off by default and then adds nothing; on, its clumps stand in the gutter's bins and follow the season", () => {
  const run = (knobs: Record<string, number>): HeadlessSim => {
    const sim = new HeadlessSim(gardenScene);
    for (let n = 0; n < 60; n++) sim.step({ knobs, pointer: { inside: false } });
    return sim;
  };
  expect(HOME["border"]).toBeUndefined();
  const off = run({});
  const on = run({ border: 1 });
  // The gravel's row and the woods are the same with the border on or off.
  const gravelRow = (sim: HeadlessSim, base: number): number[] =>
    Array.from(
      sim.upload(ATLAS_SLOT).data.subarray(base * ATLAS_WIDTH * 4, (base + 1) * ATLAS_WIDTH * 4),
    );
  expect(
    differing(gravelRow(on, WITH_BORDER["gravel"]?.base ?? 0), gravelRow(off, GRAVEL_ROW)),
  ).toBe(0);
  expect(
    differing(
      recordTexels(on, WITH_BORDER["templeWoods"]?.base ?? 0, WOODS),
      recordTexels(off, WOODS_ROW, WOODS),
    ),
  ).toBe(0);
  off.dispose();
  on.dispose();

  /** The border's organs drawn at `knobs`: per form, how many, and the most any has turned. */
  const census = (
    knobs: Record<string, number>,
  ): { ferns: number; mondo: number; turned: number; bins: Set<number> } => {
    const sim = run({ border: 1, ...knobs });
    const upload = sim.upload(ATLAS_SLOT);
    const out = { ferns: 0, mondo: 0, turned: 0, bins: new Set<number>() };
    for (let r = 0; r < BORDER; r++) {
      const organ = plantRecord(upload, BORDER_ROW, r);
      if (organ.tier <= 0) continue;
      const bin = Math.floor(r / GARDEN_BORDER.organs);
      // Rooted on the gutter's floor, in its own bin.
      expect(organ.y).toBe(0);
      expect(Math.floor(organ.x / GARDEN_BORDER.pitch)).toBe(bin);
      out.bins.add(bin);
      if (organ.form === GARDEN_BORDER_FORM.fern) out.ferns++;
      else out.mondo++;
      out.turned = Math.max(out.turned, organ.pheno);
    }
    sim.dispose();
    return out;
  };
  const summer = census({ "border-amount": 1, season: 1 });
  expect(summer.bins.size).toBe(GARDEN_BORDER.bins);
  expect(summer.ferns).toBeGreaterThan(0);
  expect(summer.mondo).toBeGreaterThan(0);
  expect(summer.turned).toBe(0);
  // Autumn turns the ferns gold; winter takes half their fronds and leaves the evergreen grass.
  expect(census({ "border-amount": 1, season: 2 }).turned).toBeGreaterThan(0.3);
  const winter = census({ "border-amount": 1, season: 3 });
  expect(winter.ferns).toBeLessThan(0.75 * summer.ferns);
  expect(winter.mondo).toBe(summer.mondo);
  // A sparser border keeps a fuller one's clumps where it has them.
  const fuller = census({ "border-amount": 0.6, season: 1 });
  const sparse = census({ "border-amount": 0.3, season: 1 });
  expect(sparse.bins.size).toBeGreaterThan(0);
  expect(sparse.bins.size).toBeLessThan(fuller.bins.size);
  expect(fuller.bins.size).toBeLessThan(summer.bins.size);
  for (const bin of sparse.bins) expect(fuller.bins.has(bin)).toBe(true);
});
