// The gravel's sim (`gravel`, the garden's ground): the raked field, its islands and the M, and
// nature's undo. It lends the raking chore and the leaves its affordances (`Gravel`, the sim
// itself): the layout's plan, the leveling board and the tines, where a leaf comes to rest, the view
// a hand is taken through.
//
// The gravel is a HeightField (src/sims/heightfield.ts) over a fixed garden 2.4 depths wide and 1
// deep (Y runs away from the veranda, X to the right; the rest level is 0). Behind the rake the
// grooves slump to the angle of repose (relax, a band of rows per frame) and soften slowly (smooth,
// every couple of seconds), so the garden is crisp where the rake has just been and softer the
// longer since it passed. A coarser grid (an AgeField) remembers when each spot was last raked:
// freshly turned gravel is darker and dries back on a drying clock, which runs with garden time,
// or, drying with the weather, faster with the weathering knob, in sun and wind, slower at dusk and
// night, not at all in rain (rain as it falls: in winter it comes down as snow, src/climate.ts).
//
// Raking the whole garden through the tool would cost a few hundred milliseconds, so a layout (the
// first, and when the pattern, the arrangement or the M change) is laid straight from the rake's
// plan, on the build worker (build.ts): each texel takes the groove phase the plan leaves there,
// with a weathered profile, then rounded here by one smoothing pass. The garden on show stays until
// a new layout lands; until the first has, the sim is not ready and nothing runs. Each layout lands
// as a new `generation`, so the chore sets its rake down afresh.
//
// Data: fields 0 (r16f heights, GARDEN.cols × rows) and 1 (r16f when each spot was last raked, on
// the drying clock, half resolution); a row of the records atlas: island i at texel i (x, y relative
// to the garden's centre, clear radius, tallest stone; clear 0 = none), the drying clock at texel
// GARDEN_ISLANDS, stone j of island i at GARDEN_STONE_TEXEL + 2 (GARDEN_STONES i + j) (x, y, rx,
// ry) and the next (height, angle, seed, 0); height 0 = none.
import type { LayerFrame, LayerSim } from "../../composer/types.ts";
import { climateCold, fallingRain, seasonKnob, yearAt, type SeasonKnob } from "../../climate.ts";
import { KnobReader, type ParamDef } from "../../params.ts";
import { AgeField, dryingPace } from "../../sims/agefield.ts";
import { BuildSlot } from "../../sims/build.ts";
import { Settle } from "../../sims/clock.ts";
import { HeightField, type RakeOptions } from "../../sims/heightfield.ts";
import { clamp, smoothstep } from "../../sims/math.ts";
import { DataTexture } from "../../sims/texture.ts";
import { dateShift, skyAnchor, skyState, timeOfDay, type SkyState } from "../../world-clock.ts";
import {
  GA,
  GARDEN_MARK,
  type GardenLaid,
  gardenLayout,
  type GardenStone,
  type Layout,
  markField,
  markSlate,
  OX,
  OY,
  type Stroke,
  TAU,
} from "./build.ts";
import { GARDEN, gardenPatterns, type GardenPattern } from "./constants.ts";
import {
  GARDEN_ISLANDS,
  GARDEN_MOSS,
  GARDEN_STONE_TEXEL,
  GARDEN_STONES,
  GardenView,
} from "./sim.ts";

/** The "when was it raked" grid (an AgeField): half the height field's resolution. */
const GARDEN_FRESH = { cols: 336, rows: 140 } as const;
/** Angle of repose of the gravel (rise over run), the slumping rate, and rows relaxed per frame. */
const TALUS = 0.8;
const SLUMP_RATE = 2.5;
const RELAX_ROWS = 6;
/** Seconds between weathering passes, and their diffusion per second at the knob's full travel. */
const SMOOTH_EVERY = 2;
const SMOOTH_RATE = 0.012;
/** Milliseconds between uploads of the heights and the drying grid while they change. */
const UPLOAD_EVERY_MS = 1000 / 30;
/** Knobs that re-lay the garden must rest this long first (a dragged slider). */
const RELAYOUT_MS = 220;
/** The leveling board's soft edge, garden depths. */
const LEVEL_SOFT = 0.008;

/**
 * A stone's height at (x, y): a steep-sided dome on a wobbly footprint, cut by a tilted top plane
 * and three steep side planes, so it stands as a weathered block with flat faces. The shader's
 * gardenStone is the same shape.
 */
function stoneHeight(stone: GardenStone, x: number, y: number): number {
  const dx = x - stone.x;
  const dy = y - stone.y;
  const c = Math.cos(stone.angle);
  const s = Math.sin(stone.angle);
  const qx = (c * dx + s * dy) / stone.rx;
  const qy = (-s * dx + c * dy) / stone.ry;
  const angle = Math.atan2(qy, qx);
  const r =
    Math.hypot(qx, qy) /
    (1 +
      0.1 * Math.sin(3 * angle + TAU * stone.seed) +
      0.06 * Math.sin(5 * angle + 2 * TAU * stone.seed));
  if (r >= 1) return 0;
  const tilt = TAU * stone.seed * 3.1;
  let h = Math.min(
    1.25 * Math.pow(1 - Math.pow(r, 2.6), 0.45),
    0.88 + 0.14 * (qx * Math.cos(tilt) + qy * Math.sin(tilt)),
  );
  for (let k = 0; k < 3; k++) {
    const a = TAU * (stone.seed + k / 3) + 0.4 * Math.sin(17 * stone.seed + k);
    h = Math.min(h, 2.2 * (1.08 - (qx * Math.cos(a) + qy * Math.sin(a))));
  }
  return stone.height * Math.max(h, 0);
}

const KNOBS = [
  "pattern",
  "soften",
  "drying",
  "moss",
  "gravelCamera",
  "gravelMark",
  "seed",
  "season",
  "time",
  "rain",
  "wind",
] as const;
type Knob = (typeof KNOBS)[number];

/** The gravel's knobs as it reads them, rewritten in place each frame. */
interface Settings {
  pattern: GardenPattern;
  seed: number;
  /** Diffusion per second for weathering, and the weathering knob itself, 0..1. */
  soften: number;
  weathering: number;
  /** "Drying with weather": its dampness while on, 0 while off. */
  drying: number;
  moss: number;
  overhead: boolean;
  /**
   * The sky clock: the hour knob and the days the day cycle has run (its phase), the date (SKY_YEAR;
   * -1 none) and the rain as it falls (snow in winter), for the drying pace.
   */
  time: number;
  days: number;
  year: number;
  rain: number;
  wind: number;
  /** The M's height, 0 when off. */
  mark: number;
  /** What a layout is made from: a change lays the garden out afresh. */
  signature: string;
}

/** The gravel's sim, and the affordances it lends the chore and the leaves (see the header). */
export class Gravel implements LayerSim {
  readonly #knobs: KnobReader<Knob>;
  /** The season knob, whose time of year sets what falls (src/climate.ts). */
  readonly #seasonDef: SeasonKnob | undefined;
  readonly #current: Settings = {
    pattern: "waves",
    seed: 0,
    soften: 0,
    weathering: 0,
    drying: 0,
    moss: 0,
    overhead: false,
    time: 0,
    days: 0,
    year: -1,
    rain: 0,
    wind: 0,
    mark: 0,
    signature: "",
  };
  /** What `#current.signature` was last built from, so the string is built only when one changes. */
  #signedPattern: GardenPattern | undefined = undefined;
  #signedSeed = -1;
  #signedMark = -1;

  readonly #field = new HeightField(GARDEN.cols, GARDEN.rows, GA);
  readonly #heights: DataTexture;
  /**
   * When each spot was last raked, on the drying clock: seconds of garden time (dt × motion), or,
   * drying with the weather, run at the weather's pace (#dryingRate).
   */
  readonly #fresh = new AgeField(GARDEN_FRESH.cols, GARDEN_FRESH.rows, GA, 1);
  readonly #freshTexture: DataTexture;
  #freshAt = -Infinity;
  #heightsAt = -Infinity;
  #smoothDue = 0;

  #layout: Layout = { pattern: "waves", islands: [], mark: 0 };
  #plan: readonly Stroke[] = [];
  /** Laying out a garden on the build worker (sims/build.ts), and how many have landed. */
  readonly #laying = new BuildSlot(gardenLayout);
  #generation = 0;
  readonly #settle = new Settle<string>(RELAYOUT_MS);
  readonly #grad = new Float64Array(2);

  /** The view hands are taken through and leaves seen in: the veranda's or from above (its camera). */
  readonly view = new GardenView();

  /** The sky's staged date (skyAnchor; -1 none); the sky the drying last read, its hour and date. */
  readonly #anchor: number;
  #sky: SkyState | undefined = undefined;
  #skyTod = Number.NaN;
  #skyYear = Number.NaN;

  constructor(gl: WebGL2RenderingContext, params: readonly ParamDef[]) {
    this.#knobs = new KnobReader("garden gravel", params, KNOBS);
    this.#seasonDef = seasonKnob(params);
    this.#anchor = skyAnchor(params) ?? -1;
    this.#heights = new DataTexture(gl, {
      width: GARDEN.cols,
      height: GARDEN.rows,
      format: "r16f",
    });
    this.#freshTexture = new DataTexture(gl, {
      width: GARDEN_FRESH.cols,
      height: GARDEN_FRESH.rows,
      format: "r16f",
    });
  }

  get affordances(): Gravel {
    return this;
  }

  /** A garden has been laid (the first layout landed): until then nothing runs. */
  get laid(): boolean {
    return this.#generation > 0;
  }

  /** How many layouts have landed: a new one is a fresh garden for the rake. */
  get generation(): number {
    return this.#generation;
  }

  /** The rake's plan for the garden on show (build.ts). */
  get plan(): readonly Stroke[] {
    return this.#plan;
  }

  frame(frame: LayerFrame): void {
    const settings = this.#settings(frame);
    if (frame.aspect > 0 && Number.isFinite(frame.aspect)) this.view.aspect = frame.aspect;
    this.view.overhead = settings.overhead;
    const dt = Math.min(Math.max(frame.dt, 0), 0.1);
    const step = dt * frame.motion;
    const now = frame.now;

    // Nature's undo: the grooves slump and weather (the rake's cuts, the chore's, come after).
    if (this.laid && step > 0) {
      this.#field.relax(TALUS, SLUMP_RATE, step, RELAX_ROWS);
      this.#smoothDue -= step;
      if (this.#smoothDue <= 0) {
        this.#field.smooth(settings.soften * (SMOOTH_EVERY - this.#smoothDue));
        this.#smoothDue = SMOOTH_EVERY;
      }
    }

    // The garden for the pattern, the arrangement and the M, laid out on the build worker: the first
    // at once, a change once its knob has rested RELAYOUT_MS, the garden on show staying meanwhile.
    const signature = settings.signature;
    if (this.#settle.stands(signature)) this.#laying.cancel();
    else if (this.#settle.due(signature, now)) {
      const { pattern, seed, mark } = settings;
      this.#laying.request(signature, { pattern, seed, mark });
    }
    const laid = this.#laying.advance(frame.budget);
    if (laid) this.#relay(laid.key, laid.result);
    if (this.laid) {
      this.#fresh.advance(settings.drying > 0 ? step * this.#dryingRate(settings) : step);
      if (now - this.#heightsAt >= UPLOAD_EVERY_MS && this.#field.upload(this.#heights))
        this.#heightsAt = now;
      if (now - this.#freshAt >= UPLOAD_EVERY_MS && this.#fresh.upload(this.#freshTexture))
        this.#freshAt = now;
    }
    this.#packIslands(frame.records.data);
    frame.records.touch();
    const [heights, fresh] = frame.fields;
    if (heights) heights.texture = this.#heights.texture;
    if (fresh) fresh.texture = this.#freshTexture.texture;
  }

  /** Ready once the first garden is laid out (on the build worker). */
  ready(): boolean {
    return this.laid;
  }

  dispose(): void {
    this.#laying.dispose();
    this.#heights.dispose();
    this.#freshTexture.dispose();
  }

  // ---- affordances ---------------------------------------------------------------------------------

  /**
   * The leveling board: drawn from (ax, ay) to (bx, by), it eases the gravel within `half` of its
   * centre line back to the rest level, softly at its ends of the board, so the old pattern goes
   * before the tines cut the new one. Half-open along the stroke, so consecutive pieces tile.
   */
  level(ax: number, ay: number, bx: number, by: number, half: number): void {
    const field = this.#field;
    const w = field.width;
    const h = field.height;
    const data = field.data;
    const tw = GA / w;
    const th = 1 / h;
    let ux = bx - ax;
    let uy = by - ay;
    const length = Math.hypot(ux, uy);
    if (!(length > 1e-9)) return;
    ux /= length;
    uy /= length;
    const nx = -uy;
    const ny = ux;
    const i0 = Math.max(0, Math.ceil((Math.min(ax, bx) - half) / tw - 0.5));
    const i1 = Math.min(w - 1, Math.floor((Math.max(ax, bx) + half) / tw - 0.5));
    const j0 = Math.max(0, Math.ceil((Math.min(ay, by) - half) / th - 0.5));
    const j1 = Math.min(h - 1, Math.floor((Math.max(ay, by) + half) / th - 0.5));
    if (i0 > i1 || j0 > j1) return;
    const inner = half - LEVEL_SOFT;
    for (let j = j0; j <= j1; j++) {
      const py = (j + 0.5) * th - ay;
      const row = j * w;
      for (let i = i0; i <= i1; i++) {
        const px = (i + 0.5) * tw - ax;
        const t = px * ux + py * uy;
        if (t < 0 || t >= length) continue;
        const d = Math.abs(px * nx + py * ny);
        if (d >= half) continue;
        const e = d <= inner ? 1 : (half - d) / LEVEL_SOFT;
        const k = row + i;
        data[k] = (data[k] ?? 0) * (1 - e * e * (3 - 2 * e));
      }
    }
    field.touch();
  }

  /** Tines cutting from (ax, ay) to (bx, by): fresh grooves, the gravel turned over `half` either side stamped fresh. */
  groove(ax: number, ay: number, bx: number, by: number, tines: RakeOptions, half: number): void {
    this.#field.rake(ax / GA, ay, bx / GA, by, tines);
    this.#fresh.stamp(ax, ay, bx, by, half);
  }

  /** Within an island's clear radius, or on the slate M, where a rake is lifted. */
  onStone(x: number, y: number): boolean {
    for (const island of this.#layout.islands) {
      if (Math.hypot(x - island.x, y - island.y) < island.clear * 0.85) return true;
    }
    return (
      this.#layout.mark > 0 &&
      markField(x, y, this.#layout.mark, this.#grad) < markSlate(this.#layout.mark) + 0.01
    );
  }

  /** What a leaf comes to rest on at (x, y): gravel, a moss cushion, a stone or the slate. */
  groundAt(x: number, y: number): number {
    const moss = this.#current.moss;
    let top = this.#field.sample(x / GA, y);
    const cover = smoothstep(0, 0.15, moss);
    for (const island of this.#layout.islands) {
      const r = Math.hypot(x - island.x, y - island.y);
      if (r >= island.clear) continue;
      const reach = island.clear * (GARDEN_MOSS.base + GARDEN_MOSS.grow * moss);
      if (r < reach) {
        const s = 1 - (r / reach) * (r / reach);
        top = Math.max(top, GARDEN_MOSS.height * cover * s * s);
      }
      for (const stone of island.stones) top = Math.max(top, stoneHeight(stone, x, y));
    }
    if (
      this.#layout.mark > 0 &&
      markField(x, y, this.#layout.mark, this.#grad) < markSlate(this.#layout.mark)
    )
      top = Math.max(top, GARDEN_MARK.slate);
    return top;
  }

  // ---- knobs ---------------------------------------------------------------------------------------

  #settings(frame: LayerFrame): Settings {
    const knobs = this.#knobs;
    const s = this.#current;
    const pattern = gardenPatterns[Math.round(knobs.value(frame, "pattern"))] ?? "waves";
    const seed = Math.max(0, Math.round(knobs.value(frame, "seed")));
    const markKnob = knobs.value(frame, "gravelMark");
    const mark = markKnob > 0 ? GARDEN_MARK.small + GARDEN_MARK.grow * markKnob : 0;
    s.pattern = pattern;
    s.seed = seed;
    s.soften = SMOOTH_RATE * clamp(knobs.value(frame, "soften"), 0, 1);
    s.weathering = clamp(knobs.value(frame, "soften"), 0, 1);
    s.drying = knobs.value(frame, "drying");
    s.moss = clamp(knobs.value(frame, "moss"), 0, 1);
    s.overhead = knobs.value(frame, "gravelCamera") > 0.5;
    s.time = knobs.value(frame, "time");
    s.days = frame.phases?.["cycle"] ?? 0;
    const season = this.#seasonDef;
    s.year = season ? yearAt(season, knobs.value(frame, "season")) : -1;
    s.rain = fallingRain(knobs.value(frame, "rain"), climateCold(s.year));
    s.wind = clamp(knobs.value(frame, "wind"), -1, 1);
    s.mark = mark;
    if (pattern !== this.#signedPattern || seed !== this.#signedSeed || mark !== this.#signedMark) {
      this.#signedPattern = pattern;
      this.#signedSeed = seed;
      this.#signedMark = mark;
      s.signature = `${pattern}|${seed}|${mark.toFixed(3)}`;
    }
    return s;
  }

  /**
   * The drying clock's pace while drying with the weather: dryingPace for the sky as the shader has
   * it (skyState at its hour and, the garden's sky being dated, its date), the wind and the rain,
   * times the weathering knob's own pace, 1 at its default and doubling with every 0.3 more, so the
   * one knob ages a mark's relief and its damp alike. The sky is worked out again only as its hour or
   * date moves.
   */
  #dryingRate(settings: Settings): number {
    const tod = timeOfDay(settings.time, settings.days);
    if (this.#sky === undefined || tod !== this.#skyTod || settings.year !== this.#skyYear) {
      this.#sky = skyState(tod, { shift: dateShift(settings.year, this.#anchor) });
      this.#skyTod = tod;
      this.#skyYear = settings.year;
    }
    const weathering = 2 ** ((settings.weathering - this.#knobs.initial("soften")) / 0.3);
    return weathering * dryingPace(this.#sky, settings.wind, settings.rain);
  }

  // ---- laying out ----------------------------------------------------------------------------------

  /** A garden laid out (gardenLayout, under `signature`) set down: its islands and plan, the gravel laid from it and rounded off. */
  #relay(signature: string, { layout, plan, heights }: GardenLaid): void {
    this.#settle.lay(signature);
    this.#layout = layout;
    this.#plan = plan;
    const field = this.#field;
    field.data.set(heights);
    field.touch();
    // Round the profile off, as weather would.
    field.smooth(0.6);
    this.#fresh.reset();
    this.#smoothDue = SMOOTH_EVERY;
    this.#generation++;
  }

  /** The gravel's row of the records atlas (see the header). */
  #packIslands(data: Float32Array): void {
    data.fill(0, 0, (GARDEN_STONE_TEXEL + 2 * GARDEN_ISLANDS * GARDEN_STONES) * 4);
    const islands = this.#layout.islands;
    for (let i = 0; i < GARDEN_ISLANDS; i++) {
      const island = islands[i];
      if (island === undefined) continue;
      let tallest = 0;
      for (let j = 0; j < Math.min(GARDEN_STONES, island.stones.length); j++) {
        const stone = island.stones[j];
        if (stone === undefined) continue;
        tallest = Math.max(tallest, stone.height);
        const a = (GARDEN_STONE_TEXEL + 2 * (GARDEN_STONES * i + j)) * 4;
        data[a] = stone.x - OX;
        data[a + 1] = stone.y - OY;
        data[a + 2] = stone.rx;
        data[a + 3] = stone.ry;
        data[a + 4] = stone.height;
        data[a + 5] = stone.angle;
        data[a + 6] = stone.seed;
      }
      const k = i * 4;
      data[k] = island.x - OX;
      data[k + 1] = island.y - OY;
      data[k + 2] = island.clear;
      data[k + 3] = 1.03 * tallest + 0.004;
    }
    data[GARDEN_ISLANDS * 4] = this.#fresh.clock;
  }
}

/** The gravel layer's sim (LayerCode.sim). */
export function gravelSim(gl: WebGL2RenderingContext, params: readonly ParamDef[]): LayerSim {
  return new Gravel(gl, params);
}
