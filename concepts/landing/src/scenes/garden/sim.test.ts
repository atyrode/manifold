import { expect, test } from "bun:test";
import { HeadlessSim, type HeadlessFrame, type HeadlessUpload } from "../../sims/headless.ts";
import { loadScene } from "../index.ts";
import {
  GARDEN_BORDER,
  GARDEN_BORDER_FORM,
  GARDEN_ISLANDS,
  GARDEN_RECORD_ROW,
  GARDEN_WOODS,
} from "./sim.ts";

const gardenScene = await loadScene("garden");

// The garden's drying clock goes to the shader in uSim1 (the texel after the islands): fresh gravel's
// damp fades with `clock - when raked`. These run the sim on the headless stand-in and read it there;
// `knobs` are as in the URL (a feature: 1 for on, and `<key>-amount`).

function dryingClock(knobs: Record<string, number>, seconds: number): number {
  const sim = new HeadlessSim(gardenScene);
  for (let n = 0; n < seconds * 60; n++) sim.step({ knobs, pointer: { inside: false } });
  // uSim1: its row 0 holds the islands, then the clock.
  const clock = sim.upload(1).data[GARDEN_ISLANDS * 4] ?? Number.NaN;
  sim.dispose();
  return clock;
}

test("by default fresh gravel dries on garden time, whatever the weather", () => {
  expect(dryingClock({}, 4)).toBeCloseTo(4, 3);
  expect(dryingClock({ rain: 1, "rain-amount": 0.7, time: 0 }, 4)).toBeCloseTo(4, 3);
});

test("drying with the weather: rain stops it, the night slows it, more weathering hurries it", () => {
  const on = { drying: 1, "drying-amount": 0.5, wind: 0 };
  expect(dryingClock({ ...on, rain: 1, "rain-amount": 0.7 }, 3)).toBe(0);
  const noon = dryingClock({ ...on, time: 0.5 }, 3);
  // A still midday at the weathering knob's default dries at the garden's own pace.
  expect(noon).toBeCloseTo(3, 3);
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

// uSim2: 4 × GARDEN_LEAF_SLOTS rgba16f, a row per leaf: (x, y, z, alpha), (chord axis, radius),
// (span axis, kind), (hue, age on the ground 0..1, landed 0..1, 0); alpha 0: no leaf.
interface Leaf {
  x: number;
  chordUp: number;
  spanUp: number;
  hue: number;
  age: number;
  landed: boolean;
}

function leaves(sim: HeadlessSim): Leaf[] {
  const data = sim.upload(2).data;
  const out: Leaf[] = [];
  for (let o = 0; o + 16 <= data.length; o += 16) {
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

test("a 'now' gust blows the leaves lying on the gravel the way the wind is set", () => {
  // The same garden with and without the gust: each leaf lying there from the start (known by its
  // hue) ends up downwind of where it lies in the calm garden.
  const drift = (wind: number): number[] => {
    const calm = new HeadlessSim(gardenScene);
    const blown = new HeadlessSim(gardenScene);
    const knobs = { wind, leaves: 0 };
    const lying = leaves(calm.step({ knobs, pointer: { inside: false } }))
      .filter((leaf) => leaf.landed)
      .map((leaf) => leaf.hue);
    blown.step({ knobs, pointer: { inside: false } });
    for (let n = 1; n < 3 * 60; n++) {
      calm.step({ knobs, pointer: { inside: false } });
      blown.step({ knobs, pointer: { inside: false }, now: n === 1 ? ["leaves"] : [] });
    }
    const still = leaves(calm);
    const moved = leaves(blown);
    calm.dispose();
    blown.dispose();
    return lying.flatMap((hue) => {
      const a = still.find((leaf) => leaf.hue === hue);
      const b = moved.find((leaf) => leaf.hue === hue);
      return a && b ? [b.x - a.x] : [];
    });
  };
  const left = drift(-0.7);
  expect(left.length).toBeGreaterThanOrEqual(5);
  for (const dx of left) expect(dx).toBeLessThan(0);
  const right = drift(0.7);
  expect(right.length).toBeGreaterThanOrEqual(5);
  for (const dx of right) expect(dx).toBeGreaterThan(0);
});

// uSim1's plant records (sims/plants.ts PlantTexture, after GARDEN_RECORD_ROW rows of islands and
// stones): the woods' stems (GARDEN_WOODS), then the border's organs (GARDEN_BORDER).
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

function plantRecord({ width, data }: HeadlessUpload, r: number): PlantRecord {
  const texel = (row: number): number =>
    ((GARDEN_RECORD_ROW + 4 * Math.floor(r / width) + row) * width + (r % width)) * 4;
  const [t0, t1, t2, t3] = [texel(0), texel(1), texel(2), texel(3)];
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

/** The records of uSim1 from `first`, `count` of them, as their raw texels. */
function recordTexels(sim: HeadlessSim, first: number, count: number): number[] {
  const upload = sim.upload(1);
  const out: number[] = [];
  for (let r = first; r < first + count; r++) {
    const texel = (row: number): number =>
      ((GARDEN_RECORD_ROW + 4 * Math.floor(r / upload.width) + row) * upload.width +
        (r % upload.width)) *
      4;
    for (let row = 0; row < 4; row++)
      for (let c = 0; c < 4; c++) out.push(upload.data[texel(row) + c] ?? Number.NaN);
  }
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

test("in still air the woods stand as laid out; a gust bows them downwind one after another, then they stand exactly as laid out again", () => {
  const knobs = { wind: 0, border: 1, "border-amount": 1 };
  const at = (now?: string[]): HeadlessFrame => ({
    knobs,
    pointer: { inside: false },
    ...(now ? { now } : {}),
  });
  const sim = new HeadlessSim(gardenScene).step(at());
  const rest = recordTexels(sim, 0, WOODS + BORDER);
  // Every stem is drawn and unbent: the shader draws the crowns where it always drew them.
  for (let r = 0; r < WOODS; r++)
    expect(plantRecord(sim.upload(1), r)).toMatchObject({ tier: 2, bend: 0 });
  for (let n = 0; n < 120; n++) sim.step(at());
  expect(differing(recordTexels(sim, 0, WOODS + BORDER), rest)).toBe(0);

  // A "now" gust in still air blows to the right (sims/wind.ts windSign), its front setting out from
  // the garden's left end: the crowns on the frame's left go first.
  const aspect = 16 / 9;
  const visible = [...Array(GARDEN_WOODS.crowns).keys()].filter(
    (k) => shown(GARDEN_WOODS.far, k) < aspect,
  );
  const left = visible.filter((k) => shown(GARDEN_WOODS.far, k) < aspect / 3);
  const right = visible.filter((k) => shown(GARDEN_WOODS.far, k) > (2 * aspect) / 3);
  const mean = (ks: number[]): number =>
    ks.reduce((sum, k) => sum + crownShift(plantRecord(sim.upload(1), k)), 0) / ks.length;
  sim.step(at(["leaves"]));
  for (let n = 0; n < 60; n++) sim.step(at());
  // A second in, the front has bowed the left third and not yet reached the right third.
  expect(mean(left)).toBeGreaterThan(0.5 / 540);
  expect(Math.abs(mean(right))).toBeLessThan(0.1 / 540);
  let most = 0;
  let swayed = 0;
  for (let n = 0; n < 4 * 60; n++) {
    sim.step(at());
    for (const k of visible) most = Math.max(most, crownShift(plantRecord(sim.upload(1), k)));
    swayed = Math.max(swayed, differing(recordTexels(sim, WOODS, BORDER), rest.slice(16 * WOODS)));
  }
  // A few cells downwind at 540 cells high, never a crown's width; the border bows too.
  expect(most).toBeGreaterThan(3 / 540);
  expect(most).toBeLessThan(15 / 540);
  expect(swayed).toBeGreaterThan(0);
  // The gust is over within 14 s, and six seconds of still air later everything stands as laid out.
  for (let n = 0; n < 17 * 60; n++) sim.step(at());
  expect(differing(recordTexels(sim, 0, WOODS + BORDER), rest)).toBe(0);
  sim.dispose();
});

test("with motion off a gust still plays on the woods, and they stand exactly as laid out once it is over", () => {
  const at = (now?: string[]): HeadlessFrame => ({
    motion: 0,
    knobs: { wind: 0 },
    pointer: { inside: false },
    ...(now ? { now } : {}),
  });
  const sim = new HeadlessSim(gardenScene).step(at());
  const rest = recordTexels(sim, 0, WOODS);
  sim.step(at(["leaves"]));
  for (let n = 0; n < 2 * 60; n++) sim.step(at());
  expect(differing(recordTexels(sim, 0, WOODS), rest)).toBeGreaterThan(0);
  for (let n = 0; n < 13 * 60; n++) sim.step(at());
  expect(differing(recordTexels(sim, 0, WOODS), rest)).toBe(0);
  sim.dispose();
});

test("a breeze leans the woods downwind and stirs them crown by crown", () => {
  for (const wind of [-0.6, 0.6]) {
    const sim = new HeadlessSim(gardenScene);
    const knobs = { wind };
    const shifts = (): number[] =>
      [...Array(GARDEN_WOODS.crowns).keys()].map((k) => crownShift(plantRecord(sim.upload(1), k)));
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
  const off = run({});
  const on = run({ border: 1 });
  expect(recordTexels(off, WOODS, BORDER).every((v) => v === 0)).toBe(true);
  // The islands' rows and the woods are the same with the border on or off.
  const ownRows = (sim: HeadlessSim): number[] =>
    Array.from(sim.upload(1).data.subarray(0, GARDEN_RECORD_ROW * sim.upload(1).width * 4));
  expect(differing(ownRows(on), ownRows(off))).toBe(0);
  expect(differing(recordTexels(on, 0, WOODS), recordTexels(off, 0, WOODS))).toBe(0);
  off.dispose();
  on.dispose();

  /** The border's organs drawn at `knobs`: per form, how many, and the most any has turned. */
  const census = (
    knobs: Record<string, number>,
  ): { ferns: number; mondo: number; turned: number; bins: Set<number> } => {
    const sim = run({ border: 1, ...knobs });
    const upload = sim.upload(1);
    const out = { ferns: 0, mondo: 0, turned: 0, bins: new Set<number>() };
    for (let r = GARDEN_BORDER.first; r < GARDEN_BORDER.first + BORDER; r++) {
      const organ = plantRecord(upload, r);
      if (organ.tier <= 0) continue;
      const bin = Math.floor((r - GARDEN_BORDER.first) / GARDEN_BORDER.organs);
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
