// The bonsai's life on the CPU: the tree grown for its species and seed (tree.ts) and drawn into the
// maps (raster.ts); the year turning (leaves out, colour, leaf fall, snow lying and melting); each
// spring's new shoots reaching out of the pads and the invisible gardener trimming them back; the
// pads swaying on springs in the breeze, gusts and every hand's passing (SimFrame.principals);
// leaves, petals and needles fluttering down and settling on the moss, the stand and the floor,
// where they rot away in patches through the season; and pruning: a press, anyone's, snips the
// twig under it, which falls and lies with them.
// Everything steps STEP at a time on a FixedStep (sims/clock.ts), so the bonsai sways the same at 60
// and at 144 Hz; the pads' sway, the falling leaves and the cut twigs are drawn between their last
// two steps by the clock's alpha. A tree is grown and drawn on the build worker (build.ts): until
// the first is up the sim is not ready, nothing runs and the stand stands bare where the entrance
// has it; a new species or seed keeps the tree on show until its own lands.
//
// Textures (layout in geometry.ts):
//   uSim0  rgba16f map, linear: wood (distance, radius, front depth, deadness).
//   uSim1  rgba16f map, linear: foliage (field, dome normal x, y, tuft index).
//   uSim2  rgba16f atlas: the litter (BONSAI_LITTER, read with texelFetch) and two cut-twig sprites.
//   uSim3  rgba16f, linear for the field rows: rows 0..FIELD.height-1 (sway x, y, wood and foliage
//          silhouettes); then, read with texelFetch, the tuft table (x, screen y, front depth, r),
//          (r1, r2, outer, regrow); shoots (base x, y, angle, length), (bend, grown, leaves, hash);
//          motes (x, y, angle, size), (kind + hue, flip, alpha, -); litter slot decay (4 a texel);
//          the state row: 0 (year, snow lying, snow falling, leafiness), 1 (snip x, y, age, gust),
//          2 (blossom, -, -, -), 3 (the box round every mote: x0, y0, x1, y1), 4 + 2k / 5 + 2k
//          twig k (x, y, angle, alpha), (active, -, -, -);
//          then the shoot grid (up to four shoot indices + 1 per cell).
import { climateCold, climateLying } from "../../climate.ts";
import type { ParamDef } from "../../params.ts";
import { BuildSlot } from "../../sims/build.ts";
import { MAX_PRINCIPALS } from "../../principals.ts";
import { FixedStep } from "../../sims/clock.ts";
import { easeFactor, smoothstep } from "../../sims/math.ts";
import { mulberry32 } from "../../sims/random.ts";
import { DataTexture } from "../../sims/texture.ts";
import type { PrincipalState, SceneSim, SimFactory, SimFrame, ScenePoint } from "../types.ts";
import { type BonsaiGrowth, bonsaiGrowth } from "./build.ts";
import {
  BONSAI_ATLAS,
  BONSAI_FIELD,
  BONSAI_GRID,
  BONSAI_GRID_CELL,
  BONSAI_LITTER,
  BONSAI_LITTER_SLOTS,
  BONSAI_MAP,
  BONSAI_MAPLE,
  BONSAI_MAX_MOTES,
  BONSAI_MAX_SHOOTS,
  BONSAI_PER_UNIT,
  BONSAI_PINE,
  BONSAI_REGION,
  BONSAI_ROWS,
  BONSAI_SAKURA,
  BONSAI_SPRITE,
  BONSAI_TILT,
  bonsaiPlacement,
  bonsaiSurface,
} from "./geometry.ts";
import {
  BARE_LEAF,
  BARE_WOOD,
  type LitterMark,
  TreeMaps,
  drawSprite,
  eraseLitter,
  stampLitter,
} from "./raster.ts";
import {
  bonsaiBlossom,
  bonsaiHue,
  bonsaiLeafiness,
  bonsaiPetalFall,
  bonsaiShedding,
} from "./season.ts";
import { type Tree, subtree } from "./tree.ts";
import { BONSAI_PASSAGE } from "./constants.ts";

const TAU = Math.PI * 2;
const FW = BONSAI_FIELD.width;
const FH = BONSAI_FIELD.height;

// ---- sway ----
/** Pads' natural frequencies (Hz) and damping ratio: slow, soft, a few swings after a push. */
const PAD_HZ = [0.32, 0.55] as const;
const PAD_DAMPING = 0.16;
/** Deflection (units) per unit of breeze at the knob's top. */
const BREEZE_SWAY = 0.016;
/** A gust (scheduled, a "now", the stand leaving) blows at least this much breeze's worth, so it still
 *  shakes the pads in air that is otherwise still; the breeze's own waves scale with the knob and stop
 *  when it is off. */
const GUST_FLOOR = 0.08;
/** A hand's push: force per unit of its speed (units/s), its reach (pad radii), and the cap. */
const HOVER_GAIN = 0.3;
const HOVER_REACH = 1.5;
const SWAY_LIMIT = 0.03;
/** The fixed step (s), and the most steps one frame catches up (a quarter of a second). */
const STEP = 1 / 60;
const MAX_STEPS = 15;

// ---- the year ----
/** Real seconds per year when the seasons stand still (for lifetimes measured in years). */
const NOMINAL_YEAR = 720;
/** Snow: how fast it settles (per second at full fall), melts in winter and outside it. */
const SNOW_SETTLE = 0.07;
const SNOW_MELT_COLD = 0.0015;
const SNOW_MELT_WARM = 0.03;
/** A "now" flurry lasts this long (s). */
const FLURRY = 45;

// ---- falling things ----
/** Leaves (petals, needles) coming down over a whole season at the knob's middle. */
const LEAVES_PER_YEAR: Readonly<Record<number, number>> = {
  [BONSAI_PINE]: 34,
  [BONSAI_MAPLE]: 130,
  [BONSAI_SAKURA]: 110,
};
const PETALS_PER_YEAR = 260;
/** Litter lifetimes, in years. */
const LEAF_LIFE = 0.42;
const PETAL_LIFE = 0.12;
const TWIG_LIFE = 0.5;
/** A cut twig falls under this gravity and drag (units/s^2, 1/s). */
const TWIG_GRAVITY = 0.9;
const TWIG_DRAG = 2.2;

// ---- shoots ----
/** New shoots per spring, and how long the gardener takes to trim one back (year). */
const SHOOTS_PER_YEAR = 30;
const TRIM_SPAN = 0.022;

/** How far right (display units) the stand stands off the frame: it slides in from there and out to there. */
const SLIDE = 1.25;
/** The pads' lag behind the stand's acceleration: the share of it felt as a push on a pad. */
const SLIDE_PUSH = 0.2;
/** Leaves a leaving stand shakes loose over its first half. */
const SHAKEN_LEAVES = 5;

type KnobKey =
  "species" | "treeSeed" | "breeze" | "growth" | "season" | "year" | "leaves" | "snowfall";

export class BonsaiSimError extends Error {}

interface PadState {
  omega: number;
  x: number;
  vx: number;
  y: number;
  vy: number;
  /** Its sway a step before: drawn between that and x, y. */
  wx: number;
  wy: number;
  phase: number;
  /** Screen centre and radii for the hands. */
  sx: number;
  sy: number;
  rx: number;
  ry: number;
}

interface Shoot {
  x: number;
  y: number;
  angle: number;
  length: number;
  bend: number;
  start: number;
  trim: number;
  hash: number;
  pad: number;
  cut: boolean;
  grown: number;
  leaves: number;
}

const MOTE_LEAF = 0;
const MOTE_PETAL = 1;
const MOTE_NEEDLE = 2;
const MOTE_WOOD = 3;

interface Mote {
  live: boolean;
  kind: number;
  x: number;
  y: number;
  z: number;
  x0: number;
  phase: number;
  rate: number;
  amp: number;
  sink: number;
  dive: number;
  tilt: number;
  spin: number;
  size: number;
  hue: number;
  angle: number;
  flip: number;
  /** Its place, angle and flip a step before: drawn between those and these. */
  wx: number;
  wy: number;
  wangle: number;
  wflip: number;
}

interface Twig {
  live: boolean;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  angle: number;
  spin: number;
  reach: number;
  /** Its place and angle a step before: drawn between those and these. */
  wx: number;
  wy: number;
  wangle: number;
}

interface LitterSlot {
  used: boolean;
  age: number;
  life: number;
  bounds: readonly [number, number, number, number];
}

/** A lying thing's outline: > 0 inside, in units of its size. Maple leaves have five lobes. */
function litterShape(kind: number): (lx: number, ly: number) => number {
  switch (kind) {
    case MOTE_LEAF:
      return (lx, ly) => {
        const r = Math.hypot(lx, ly);
        const a = Math.atan2(ly, lx);
        return (0.62 + 0.38 * Math.pow(Math.abs(Math.cos(2.5 * a)), 0.7) - r) * 3;
      };
    case MOTE_PETAL:
      return (lx, ly) => (1 - Math.hypot(lx / 0.55, ly / 0.36)) * 2;
    case MOTE_NEEDLE:
      return (lx, ly) => Math.min(0.12 - Math.abs(ly), 1 - Math.abs(lx)) * 8;
    default:
      return (lx, ly) => 1 - Math.hypot(lx, ly);
  }
}

class BonsaiSim implements SceneSim {
  readonly #woodTexture: DataTexture;
  readonly #leafTexture: DataTexture;
  readonly #atlasTexture: DataTexture;
  readonly #dataTexture: DataTexture;
  /** The textures handed to the renderer every frame, in slot order. */
  readonly #textures: readonly (WebGLTexture | undefined)[];
  readonly #atlas = new Float32Array(BONSAI_ATLAS.width * BONSAI_ATLAS.height * 4);
  readonly #data = new Float32Array(FW * BONSAI_ROWS.total * 4);
  /** The tree on show's maps; undefined until the first tree is up. */
  #maps: TreeMaps | undefined;
  /** Growing a tree for a new species or seed, on the build worker (sims/build.ts). */
  readonly #growing = new BuildSlot(bonsaiGrowth);
  readonly #knob: Readonly<Record<KnobKey, number>>;

  #tree: Tree = { nodes: [], pads: [], tufts: [], tip: 0.002 };
  #pads: PadState[] = [];
  /** Each pad's sway as drawn this frame (x, y), for the field. */
  #sway = new Float64Array(0);
  #shoots: Shoot[] = [];
  readonly #motes: Mote[] = [];
  readonly #twigs: Twig[] = [];
  readonly #slots: LitterSlot[] = [];

  // Knobs as the sim follows them.
  #species = -1;
  #seed = -1;
  #breeze = 0.35;
  #growth = true;
  #seasonKnob = Number.NaN;
  #minutes = 3;
  #leafAmount = 0.5;
  #snowAmount = 0.5;

  /** The year: phase = fract(season knob + elapsed), index = floor of it. */
  #elapsed = 0;
  #yearIndex = Number.NaN;
  #clock = 0;
  readonly #steps = new FixedStep(STEP, MAX_STEPS);
  #random = mulberry32(1);
  #lying = 0;
  #falling = 0;
  #flurryLeft = 0;
  #release = 0;
  #gust = 0;
  #gustAt = Number.NEGATIVE_INFINITY;
  #gustStrength = 0;
  #nextGust = 20;
  #snip = { x: 0, y: 0, at: -1e4 };
  #cutsThisYear = 0;
  #nextSprite = 0;

  /** The hands, by place in SimFrame.principals: display point (x NaN while off the page) and smoothed velocity. */
  readonly #handX = new Float64Array(MAX_PRINCIPALS).fill(Number.NaN);
  readonly #handY = new Float64Array(MAX_PRINCIPALS);
  readonly #handVX = new Float64Array(MAX_PRINCIPALS);
  readonly #handVY = new Float64Array(MAX_PRINCIPALS);
  /** The pads' centres in uv, as interest() hands them out (grown as the tree's pads need). */
  readonly #interest: { x: number; y: number }[] = [];

  #primed = false;
  #seenGust = 0;
  #seenSnip = 0;
  #seenLeaves = 0;
  #seenSnow = 0;
  #mapsDirty = true;
  #atlasDirty = true;
  #atlasWait = 0;

  // The passage: the stand's slide on the sim's own frame clock (like a growth that starts after the
  // first, heavy frame), how far right it stands off now, and the push its acceleration gives the pads.
  #arriving: boolean | undefined = undefined;
  #arrived = 0;
  #shift = 0;
  #push = 0;
  #leaving = false;
  #shaken = 0;

  constructor(gl: WebGL2RenderingContext, params: readonly ParamDef[]) {
    const index = (key: KnobKey): number => {
      const at = params.findIndex((def) => def.key === key);
      if (at < 0) throw new BonsaiSimError(`bonsai: the scene has no '${key}' knob`);
      return at;
    };
    this.#knob = {
      species: index("species"),
      treeSeed: index("treeSeed"),
      breeze: index("breeze"),
      growth: index("growth"),
      season: index("season"),
      year: index("year"),
      leaves: index("leaves"),
      snowfall: index("snowfall"),
    };
    // Bare (one texel of nothing drawn) until the first tree's maps are uploaded.
    this.#woodTexture = new DataTexture(gl, { width: 1, height: 1, format: "rgba16f" });
    this.#woodTexture.upload(Float32Array.from(BARE_WOOD));
    this.#leafTexture = new DataTexture(gl, { width: 1, height: 1, format: "rgba16f" });
    this.#leafTexture.upload(Float32Array.from(BARE_LEAF));
    this.#atlasTexture = new DataTexture(gl, {
      width: BONSAI_ATLAS.width,
      height: BONSAI_ATLAS.height,
      format: "rgba16f",
      filter: "nearest",
    });
    this.#dataTexture = new DataTexture(gl, {
      width: FW,
      height: BONSAI_ROWS.total,
      format: "rgba16f",
    });
    this.#textures = [
      this.#woodTexture.texture,
      this.#leafTexture.texture,
      this.#atlasTexture.texture,
      this.#dataTexture.texture,
    ];
    for (let i = 0; i < BONSAI_MAX_MOTES; i++) {
      this.#motes.push({
        live: false,
        kind: 0,
        x: 0,
        y: 0,
        z: 0,
        x0: 0,
        phase: 0,
        rate: 1,
        amp: 0,
        sink: 0,
        dive: 0,
        tilt: 0,
        spin: 0,
        size: 0,
        hue: 0,
        angle: 0,
        flip: 1,
        wx: 0,
        wy: 0,
        wangle: 0,
        wflip: 1,
      });
    }
    for (let i = 0; i < 2; i++)
      this.#twigs.push({
        live: false,
        x: 0,
        y: 0,
        z: 0,
        vx: 0,
        vy: 0,
        angle: 0,
        spin: 0,
        reach: 0.05,
        wx: 0,
        wy: 0,
        wangle: 0,
      });
    for (let i = 0; i < BONSAI_LITTER_SLOTS; i++)
      this.#slots.push({ used: false, age: 0, life: 1, bounds: [0, 0, -1, -1] });
  }

  frame(frame: SimFrame): readonly (WebGLTexture | undefined)[] {
    const aspect = frame.aspect > 0 ? frame.aspect : 16 / 9;
    const advance = Math.max(0, frame.dt) * Math.max(0, frame.motion);
    this.#readKnobs(frame.values, frame.budget);
    const maps = this.#maps;
    if (maps === undefined) {
      // No tree yet: nothing runs, and the stand stands bare where the entrance has it.
      this.#stepPassage(frame, true);
      this.#pack(0);
      this.#dataTexture.upload(this.#data);
      return this.#textures;
    }
    this.#watchTriggers(frame.triggers);
    this.#stepPassage(frame, false);
    this.#trackHands(frame.principals, frame.dt, aspect);
    for (let s = 0, n = this.#steps.advance(advance); s < n; s++) {
      this.#keepDrawn();
      this.#advance(STEP);
    }
    this.#pack(this.#steps.alpha);
    if (this.#mapsDirty) {
      if (this.#woodTexture.width !== BONSAI_MAP.width) {
        this.#woodTexture.resize(BONSAI_MAP.width, BONSAI_MAP.height);
        this.#leafTexture.resize(BONSAI_MAP.width, BONSAI_MAP.height);
      }
      this.#woodTexture.upload(maps.wood);
      this.#leafTexture.upload(maps.leaf);
      this.#mapsDirty = false;
    }
    this.#atlasWait -= frame.dt;
    if (this.#atlasDirty && this.#atlasWait <= 0) {
      this.#atlasTexture.upload(this.#atlas);
      this.#atlasDirty = false;
      this.#atlasWait = 0.25;
    }
    this.#dataTexture.upload(this.#data);
    return this.#textures;
  }

  /** The sim shows its tree once the first has been grown (on the build worker). */
  ready(): boolean {
    return this.#maps !== undefined;
  }

  /** The pads, where a press snips the shoot or twig it lands on: the gardener's rounds. */
  interest(aspect: number): readonly ScenePoint[] {
    const place = bonsaiPlacement(aspect);
    const points = this.#interest;
    points.length = this.#pads.length;
    for (const [i, s] of this.#pads.entries()) {
      const x = (s.sx * place.scale + place.x) / aspect + 0.5;
      const y = s.sy * place.scale + place.y;
      const point = points[i];
      if (point === undefined) points[i] = { x, y };
      else {
        point.x = x;
        point.y = y;
      }
    }
    return points;
  }

  dispose(): void {
    this.#growing.dispose();
    this.#woodTexture.dispose();
    this.#leafTexture.dispose();
    this.#atlasTexture.dispose();
    this.#dataTexture.dispose();
  }

  get #year(): number {
    const y = this.#seasonKnob + this.#elapsed;
    return y - Math.floor(y);
  }

  /** Real seconds per year at the current pace. */
  get #yearSeconds(): number {
    return this.#minutes > 0 ? this.#minutes * 240 : NOMINAL_YEAR;
  }

  #readKnobs(values: readonly number[], budget: number): void {
    const k = this.#knob;
    const species = Math.round(values[k.species] ?? BONSAI_MAPLE);
    const seed = Math.round(values[k.treeSeed] ?? 0);
    this.#breeze = values[k.breeze] ?? this.#breeze;
    this.#growth = (values[k.growth] ?? 1) > 0.5;
    this.#minutes = values[k.year] ?? this.#minutes;
    this.#leafAmount = values[k.leaves] ?? this.#leafAmount;
    this.#snowAmount = values[k.snowfall] ?? this.#snowAmount;
    const season = values[k.season] ?? 0.62;
    // The tree for the species and seed, grown on the build worker while the one on show stays up.
    if (species === this.#species && seed === this.#seed) this.#growing.cancel();
    else this.#growing.request(`${species}|${seed}`, { species, seed });
    const landed = this.#growing.advance(budget);
    if (landed) this.#plant(landed.result);
    if (this.#maps === undefined) {
      this.#seasonKnob = season;
      return;
    }
    if (landed || season !== this.#seasonKnob) {
      // A new tree or a jump through the year: start the moment over as if it had been running.
      this.#seasonKnob = season;
      this.#elapsed = 0;
      this.#yearIndex = Number.NaN;
      this.#settle();
    }
  }

  /** A grown tree (bonsaiGrowth) on show: its pads set swaying, its maps and tufts uploaded. */
  #plant({ species, seed, tree, maps }: BonsaiGrowth): void {
    this.#species = species;
    this.#seed = seed;
    this.#random = mulberry32(0x73656173 ^ Math.imul(seed + 3, 0x9e3779b1));
    this.#tree = tree;
    this.#pads = tree.pads.map((pad, i) => {
      const size = Math.min(1, pad.long / 0.25);
      return {
        omega: TAU * (PAD_HZ[1] + (PAD_HZ[0] - PAD_HZ[1]) * size) * (0.9 + 0.2 * this.#random()),
        x: 0,
        vx: 0,
        y: 0,
        vy: 0,
        wx: 0,
        wy: 0,
        phase: i * 1.7 + this.#random() * TAU,
        sx: pad.x,
        sy: pad.y + BONSAI_TILT * pad.z,
        rx: Math.max(pad.long, pad.side),
        ry: pad.tall * 1.6 + 0.02,
      };
    });
    this.#maps = new TreeMaps(maps);
    this.#mapsDirty = true;
    this.#writeTufts();
  }

  /** Bring everything to where the year stands: shoots, snow, litter, a few leaves in the air, swaying. */
  #settle(): void {
    const y = this.#year;
    this.#newYear(Math.floor(this.#seasonKnob + this.#elapsed), false);
    for (const mote of this.#motes) mote.live = false;
    for (const twig of this.#twigs) twig.live = false;
    // Snow: replay this winter's falls at the nominal pace.
    this.#lying = 0;
    if (y > 0.74) {
      const seconds = (y - 0.74) * this.#yearSeconds;
      const steps = Math.min(400, Math.ceil(seconds));
      const dt = seconds / Math.max(steps, 1);
      for (let s = 0; s < steps; s++) this.#stepSnow(0.74 + ((s + 0.5) / steps) * (y - 0.74), dt);
    }
    this.#seedLitter(y);
    // The pads have been swaying a while, and a few leaves are on their way down.
    for (let s = 0; s < 180; s++) this.#stepPads(STEP, 0);
    const expected = this.#releaseRate(y) * 6;
    for (let k = 0; k < Math.min(6, Math.round(expected)); k++) {
      const mote = this.#launch(y);
      if (!mote) break;
      const fall = 1 + this.#random() * 4;
      for (let s = 0; s < fall * 10; s++) this.#stepMote(mote, 0.1);
    }
    // Shown as it now stands, nothing to draw between.
    this.#keepDrawn();
  }

  #watchTriggers(triggers: readonly number[]): void {
    const gust = triggers[0] ?? -1e4;
    const snip = triggers[1] ?? -1e4;
    const leaves = triggers[3] ?? -1e4;
    const snow = triggers[4] ?? -1e4;
    if (this.#primed) {
      if (gust !== this.#seenGust && gust > -1e3) this.#launchGust(1.3);
      if (snip !== this.#seenSnip && snip > -1e3) this.#gardenerSnip();
      if (leaves !== this.#seenLeaves && leaves > -1e3) {
        for (let k = 0; k < 7; k++) this.#launch(this.#year, true);
      }
      if (snow !== this.#seenSnow && snow > -1e3 && this.#snowAmount > 0) this.#flurryLeft = FLURRY;
    }
    this.#primed = true;
    this.#seenGust = gust;
    this.#seenSnip = snip;
    this.#seenLeaves = leaves;
    this.#seenSnow = snow;
  }

  /** Every hand in display units; moving over a pad stirs it, a press prunes what is under it. */
  #trackHands(principals: readonly PrincipalState[], dt: number, aspect: number): void {
    const place = bonsaiPlacement(aspect);
    for (let i = 0; i < MAX_PRINCIPALS; i++) {
      const hand = principals[i];
      if (hand === undefined || !hand.inside) {
        this.#handX[i] = Number.NaN;
        this.#handVX[i] = 0;
        this.#handVY[i] = 0;
        continue;
      }
      const x = ((hand.x - 0.5) * aspect - place.x) / place.scale - this.#shift;
      const y = (hand.y - place.y) / place.scale;
      const wasX = this.#handX[i] ?? Number.NaN;
      if (!Number.isNaN(wasX) && dt > 0) {
        const k = easeFactor(dt, 0.1);
        const vx = this.#handVX[i] ?? 0;
        const vy = this.#handVY[i] ?? 0;
        this.#handVX[i] = vx + (Math.max(-3, Math.min(3, (x - wasX) / dt)) - vx) * k;
        this.#handVY[i] =
          vy + (Math.max(-3, Math.min(3, (y - (this.#handY[i] ?? 0)) / dt)) - vy) * k;
      }
      this.#handX[i] = x;
      this.#handY[i] = y;
      if (hand.pressed) this.#prune(x, y);
    }
  }

  /** One fixed step of dt seconds: the year, the gusts, the pads, the snow, the shoots, everything falling. */
  #advance(dt: number): void {
    this.#clock += dt;
    if (this.#minutes > 0) this.#elapsed += dt / this.#yearSeconds;
    const index = Math.floor(this.#seasonKnob + this.#elapsed);
    if (index !== this.#yearIndex) this.#newYear(index, true);
    const y = this.#year;
    this.#scheduleGusts();
    this.#gust = this.#gustStrength * gustSwell(this.#clock - this.#gustAt);
    this.#stepPads(dt, this.#push);
    this.#stepSnow(y, dt);
    this.#stepShoots(y);
    // Leaves let go at the season's pace, more in a gust.
    this.#release += this.#releaseRate(y) * (1 + 3 * this.#gust) * dt;
    while (this.#release >= 1) {
      this.#release -= 1;
      this.#launch(y);
    }
    for (const mote of this.#motes) if (mote.live) this.#stepMote(mote, dt);
    for (const twig of this.#twigs) if (twig.live) this.#stepTwig(twig, dt);
    for (const [slot, s] of this.#slots.entries()) {
      if (!s.used) continue;
      s.age += dt;
      if (s.age >= s.life) {
        eraseLitter(this.#atlas, slot, s.bounds);
        s.used = false;
        this.#atlasDirty = true;
      }
    }
  }

  /** What is drawn as it stands becomes the step before: the pads' sway, the leaves and twigs in the air. */
  #keepDrawn(): void {
    for (const pad of this.#pads) {
      pad.wx = pad.x;
      pad.wy = pad.y;
    }
    for (const mote of this.#motes) if (mote.live) keepMote(mote);
    for (const twig of this.#twigs) {
      if (!twig.live) continue;
      twig.wx = twig.x;
      twig.wy = twig.y;
      twig.wangle = twig.angle;
    }
  }

  // ---- passage ----

  /**
   * Where the stand stands: entering it eases out of SLIDE to rest (cubic, braking all the way),
   * leaving it accelerates back out to SLIDE (cubic, from rest and fastest as the exit ends); zero
   * exactly once arrived and not leaving. Leaves in the air stay where they are in the room as the
   * stand goes, so they are moved the other way in the stand's own frame; leaves still in the air as
   * it arrives ride in with it. `held`: the entrance waits (no tree is up yet).
   */
  #stepPassage(frame: SimFrame, held: boolean): void {
    const enter = BONSAI_PASSAGE.enter;
    const exit = BONSAI_PASSAGE.exit;
    if (this.#arriving === undefined) this.#arriving = frame.passage.enter < 1;
    else if (this.#arriving && !held) this.#arrived += Math.max(0, frame.dt);
    if (this.#arrived >= enter) this.#arriving = false;
    const rest = this.#arriving ? 1 - this.#arrived / enter : 0;
    const q = Math.min(1, Math.max(0, frame.passage.exit));
    const before = this.#shift;
    this.#shift = SLIDE * (rest * rest * rest + q * q * q);
    this.#push = SLIDE_PUSH * SLIDE * ((6 * rest) / (enter * enter) + (6 * q) / (exit * exit));
    if (q <= 0) return;
    if (!this.#leaving) {
      this.#leaving = true;
      this.#launchGust(1);
    }
    const moved = this.#shift - before;
    for (const mote of this.#motes) if (mote.live) mote.x0 -= moved;
    for (const twig of this.#twigs) {
      if (!twig.live) continue;
      twig.x -= moved;
      twig.wx -= moved;
    }
    const target = Math.min(SHAKEN_LEAVES, Math.floor(q * 10));
    while (this.#shaken < target) {
      this.#shaken++;
      this.#launch(this.#year, true);
    }
  }

  // ---- the tree ----

  /** Draw the tree on show into its maps again (after a cut, or cut twigs growing back). */
  #redraw(): void {
    const maps = this.#maps;
    if (maps === undefined) throw new BonsaiSimError("bonsai: no tree is up to draw");
    maps.draw(this.#tree);
    this.#mapsDirty = true;
  }

  #writeTufts(): void {
    const data = this.#data;
    const row = BONSAI_ROWS.tufts * FW * 4;
    data.fill(0, row, BONSAI_ROWS.shoots * FW * 4);
    for (const [i, t] of this.#tree.tufts.entries()) {
      const o = row + i * 8;
      data[o] = t.x;
      data[o + 1] = t.y + BONSAI_TILT * t.z;
      data[o + 2] = t.z - t.r;
      data[o + 3] = t.r;
      data[o + 4] = t.r1;
      data[o + 5] = t.r2;
      data[o + 6] = t.outer;
      data[o + 7] = t.regrow ? 1 : 0;
    }
  }

  /** A new year: cut twigs grow back (their foliage filling in through spring), new shoots. */
  #newYear(index: number, restore: boolean): void {
    this.#yearIndex = index;
    this.#cutsThisYear = 0;
    let restored = false;
    for (const t of this.#tree.tufts) t.regrow = false;
    if (restore) {
      for (const n of this.#tree.nodes) {
        if (n.removed) {
          n.removed = false;
          restored = true;
        }
      }
      for (const t of this.#tree.tufts) {
        if (t.removed) {
          t.removed = false;
          t.regrow = true;
        }
      }
    }
    if (restored) this.#redraw();
    this.#writeTufts();
    this.#growShoots(index);
  }

  /** This year's shoots: from outer tufts on the tops and sides of the pads, outward and up. */
  #growShoots(index: number): void {
    this.#shoots = [];
    const rand = mulberry32(
      0x73686f6f ^ Math.imul(this.#seed + 11, 0x9e3779b1) ^ Math.imul(index + 1013, 0x85ebca6b),
    );
    const species = this.#species;
    const tufts = this.#tree.tufts;
    const pads = this.#tree.pads;
    const candidates = tufts
      .map((_, i) => i)
      .filter((i) => {
        const t = tufts[i];
        const pad = pads[t?.pad ?? -1];
        return (
          t !== undefined &&
          pad !== undefined &&
          !t.removed &&
          t.outer > 0.45 &&
          t.y > pad.y - 0.2 * pad.tall
        );
      });
    const count = Math.min(BONSAI_MAX_SHOOTS, SHOOTS_PER_YEAR, candidates.length);
    for (let k = 0; k < count; k++) {
      const pick = Math.floor(rand() * candidates.length);
      const index2 = candidates.splice(pick, 1)[0] ?? 0;
      const t = tufts[index2];
      const pad = pads[t?.pad ?? -1];
      if (!t || !pad) continue;
      const ox = t.x - pad.x;
      const oy = (t.y - pad.y) * 1.5;
      const ol = Math.max(Math.hypot(ox, oy), 1e-4);
      const up = species === BONSAI_PINE ? 0.9 : species === BONSAI_MAPLE ? 0.5 : 0.4;
      const dx = (ox / ol) * (1 - up);
      const dy = (oy / ol) * (1 - up) + up;
      const angle = Math.atan2(dy, dx) + (rand() - 0.5) * 0.5;
      const length = species === BONSAI_PINE ? 0.026 + 0.02 * rand() : 0.045 + 0.04 * rand();
      const startX = t.x + Math.cos(angle) * t.r * 0.55;
      const startY = t.y + BONSAI_TILT * (t.z - t.r * 0.5) + Math.sin(angle) * t.r * t.flat * 0.55;
      const start =
        species === BONSAI_PINE
          ? 0.02 + 0.04 * rand()
          : species === BONSAI_SAKURA
            ? 0.12 + 0.05 * rand()
            : 0.05 + 0.06 * rand();
      const trim = species === BONSAI_PINE ? 0.23 + 0.08 * rand() : 0.3 + 0.24 * rand();
      this.#shoots.push({
        x: startX,
        y: startY,
        angle,
        length,
        bend: species === BONSAI_PINE ? (rand() - 0.5) * 0.15 : (rand() - 0.5) * 0.9,
        start,
        trim,
        hash: rand(),
        pad: t.pad,
        cut: false,
        grown: 0,
        leaves: 0,
      });
    }
    // The shoot grid: each cell lists up to four shoots whose reach overlaps it.
    const grid = BONSAI_ROWS.grid * FW * 4;
    this.#data.fill(0, grid, BONSAI_ROWS.total * FW * 4);
    for (const [i, s] of this.#shoots.entries()) {
      const mx = s.x + Math.cos(s.angle) * s.length * 0.5;
      const my = s.y + Math.sin(s.angle) * s.length * 0.5;
      const ex = mx + Math.cos(s.angle + s.bend) * s.length * 0.5;
      const ey = my + Math.sin(s.angle + s.bend) * s.length * 0.5;
      const pad = 0.02;
      const g0 = Math.max(
        0,
        Math.floor((Math.min(s.x, mx, ex) - pad - BONSAI_REGION.x0) / BONSAI_GRID_CELL),
      );
      const g1 = Math.min(
        BONSAI_GRID.width - 1,
        Math.floor((Math.max(s.x, mx, ex) + pad - BONSAI_REGION.x0) / BONSAI_GRID_CELL),
      );
      const h0 = Math.max(
        0,
        Math.floor((Math.min(s.y, my, ey) - pad - BONSAI_REGION.y0) / BONSAI_GRID_CELL),
      );
      const h1 = Math.min(
        BONSAI_GRID.height - 1,
        Math.floor((Math.max(s.y, my, ey) + pad - BONSAI_REGION.y0) / BONSAI_GRID_CELL),
      );
      for (let gy = h0; gy <= h1; gy++) {
        for (let gx = g0; gx <= g1; gx++) {
          const o = grid + (gy * BONSAI_GRID.width + gx) * 4;
          for (let c = 0; c < 4; c++) {
            if (this.#data[o + c] === 0) {
              this.#data[o + c] = i + 1;
              break;
            }
          }
        }
      }
    }
  }

  #stepShoots(y: number): void {
    for (const s of this.#shoots) {
      if (!this.#growth || s.cut) {
        s.grown = 0;
        continue;
      }
      const grow = smoothstep(s.start, s.start + 0.13, y);
      s.grown = grow * (1 - smoothstep(s.trim, s.trim + TRIM_SPAN, y));
      s.leaves = smoothstep(s.start + 0.03, s.start + 0.15, y);
    }
  }

  // ---- sway ----

  #scheduleGusts(): void {
    if (this.#breeze <= 0) return;
    if (this.#clock >= this.#nextGust) {
      this.#launchGust(0.8 + 0.6 * this.#random());
      this.#nextGust =
        this.#clock + (34 - 22 * Math.min(1, this.#breeze)) * (0.6 + 0.8 * this.#random());
    }
  }

  #launchGust(strength: number): void {
    this.#gustAt = this.#clock;
    this.#gustStrength = strength;
  }

  #stepPads(h: number, push: number): void {
    const t = this.#clock;
    const amp = BREEZE_SWAY * Math.max(this.#breeze, GUST_FLOOR);
    // The breeze's share of that: all of it from GUST_FLOOR up, fading to none with the breeze off.
    const calm = Math.min(1, Math.max(0, this.#breeze) / GUST_FLOOR);
    const hands = this.#handX;
    for (const [i, s] of this.#pads.entries()) {
      const pad = this.#tree.pads[i];
      if (!pad) continue;
      // The breeze: slow waves rolling across from the left, each pad feeling them a little late.
      const lag = t - pad.x * 1.6;
      const wind =
        calm *
          (0.5 * Math.sin(0.62 * lag + s.phase * 0.25) +
            0.3 * Math.sin(1.07 * lag + 1.3) +
            0.2 * Math.sin(0.29 * lag + s.phase)) +
        1.6 * gustSwell(t - this.#gustAt - pad.x * 1.2) * this.#gustStrength;
      let fx = s.omega * s.omega * amp * wind * (0.6 + 0.4 * Math.min(1, pad.long / 0.2));
      let fy = s.omega * s.omega * amp * 0.3 * calm * Math.sin(0.83 * lag + s.phase);
      if (push !== 0) fx -= push * (0.6 + 0.4 * Math.min(1, pad.long / 0.2));
      for (let k = 0; k < MAX_PRINCIPALS; k++) {
        const px = hands[k] ?? Number.NaN;
        if (Number.isNaN(px)) continue;
        const ex = (px - s.sx) / s.rx;
        const ey = ((this.#handY[k] ?? 0) - s.sy) / s.ry;
        const e = Math.hypot(ex, ey);
        if (e < HOVER_REACH) {
          const near = 1 - e / HOVER_REACH;
          fx += HOVER_GAIN * (this.#handVX[k] ?? 0) * near;
          fy += HOVER_GAIN * 0.5 * (this.#handVY[k] ?? 0) * near;
        }
      }
      const z = PAD_DAMPING;
      s.vx += (fx - s.omega * s.omega * s.x - 2 * z * s.omega * s.vx) * h;
      s.vy += (fy - s.omega * s.omega * s.y - 2 * z * s.omega * s.vy) * h;
      s.x = Math.max(-SWAY_LIMIT, Math.min(SWAY_LIMIT, s.x + s.vx * h));
      s.y = Math.max(-SWAY_LIMIT, Math.min(SWAY_LIMIT, s.y + s.vy * h));
    }
  }

  // ---- snow ----

  #stepSnow(y: number, dt: number): void {
    let falling = 0;
    if (this.#snowAmount > 0) {
      const rand = mulberry32(0x736e6f77 ^ Math.imul(this.#yearIndex + 77, 0x9e3779b1));
      const falls: [number, number, number][] = [
        [0.775 + 0.02 * rand(), 0.035 + 0.015 * rand(), 0.7 + 0.3 * rand()],
        [0.87 + 0.03 * rand(), 0.03 + 0.02 * rand(), 0.6 + 0.4 * rand()],
      ];
      for (const [start, span, strength] of falls)
        falling +=
          strength *
          smoothstep(start, start + 0.006, y) *
          (1 - smoothstep(start + span - 0.006, start + span, y));
      if (this.#flurryLeft > 0) {
        this.#flurryLeft -= dt;
        const f = this.#flurryLeft / FLURRY;
        falling = Math.max(falling, 0.75 * smoothstep(0, 0.15, f) * smoothstep(1, 0.85, f));
      }
      falling *= this.#snowAmount * 1.2;
    } else {
      this.#flurryLeft = 0;
    }
    this.#falling = Math.min(1, falling);
    // Snow keeps while the climate's cold would lay snow of its own (src/climate.ts).
    const cold = climateLying(climateCold(y)) > 0;
    const melt = cold ? SNOW_MELT_COLD : SNOW_MELT_WARM;
    this.#lying += (SNOW_SETTLE * this.#falling * (1 - this.#lying) - melt * this.#lying) * dt;
    this.#lying = Math.max(0, Math.min(1, this.#lying));
  }

  // ---- falling leaves, petals, needles ----

  /** Leaves (or petals) per second letting go now. */
  #releaseRate(y: number): number {
    const tufts = this.#tree.tufts;
    if (tufts.length === 0 || this.#leafAmount <= 0) return 0;
    let shed = 0;
    let petals = 0;
    for (const t of tufts) {
      if (t.removed) continue;
      shed += bonsaiShedding(this.#species, y, t.r1, t.outer);
      petals += bonsaiPetalFall(this.#species, y, t.r1);
    }
    const perYear = 1 / this.#yearSeconds;
    const scale = this.#leafAmount / 0.5;
    const leaves = (LEAVES_PER_YEAR[this.#species] ?? 100) * (shed / tufts.length);
    return (
      (leaves + PETALS_PER_YEAR * (petals / tufts.length)) *
      perYear *
      scale *
      (this.#minutes > 0 ? 1 : 0)
    );
  }

  /** Send one leaf (petal, needle) down from a tuft that is losing them; `any` takes any leafy tuft. */
  #launch(y: number, any = false): Mote | undefined {
    const mote = this.#motes.find((m) => !m.live);
    const tufts = this.#tree.tufts;
    if (!mote || tufts.length === 0) return undefined;
    const species = this.#species;
    let pick = -1;
    let petal = false;
    for (let attempt = 0; attempt < 24 && pick < 0; attempt++) {
      const i = Math.floor(this.#random() * tufts.length);
      const t = tufts[i];
      if (!t || t.removed) continue;
      const shed = bonsaiShedding(species, y, t.r1, t.outer);
      const fall = bonsaiPetalFall(species, y, t.r1);
      const leafy = bonsaiLeafiness(species, y, t.r1, t.outer, t.regrow);
      if (any ? leafy > 0.3 || fall > 0 : this.#random() * 25 < shed + fall) {
        pick = i;
        petal = fall > shed;
      }
    }
    const t = tufts[pick];
    if (!t) return undefined;
    const rand = this.#random;
    const kind = petal ? MOTE_PETAL : species === BONSAI_PINE ? MOTE_NEEDLE : MOTE_LEAF;
    mote.live = true;
    mote.kind = kind;
    mote.x0 = t.x + (rand() - 0.5) * t.r;
    mote.x = mote.x0;
    mote.y = t.y - 0.3 * t.r * t.flat;
    mote.z = t.z - 0.4 * t.r;
    mote.phase = rand() * TAU;
    mote.rate = kind === MOTE_NEEDLE ? 0 : 1.5 + rand() * (kind === MOTE_PETAL ? 1.6 : 1.0);
    mote.amp =
      kind === MOTE_PETAL
        ? 0.012 + 0.012 * rand()
        : kind === MOTE_NEEDLE
          ? 0.004
          : 0.018 + 0.02 * rand();
    mote.sink =
      kind === MOTE_PETAL
        ? 0.03 + 0.012 * rand()
        : kind === MOTE_NEEDLE
          ? 0.1 + 0.03 * rand()
          : 0.045 + 0.02 * rand();
    mote.dive = kind === MOTE_NEEDLE ? 0 : mote.sink * 0.8;
    mote.tilt = (rand() - 0.5) * 0.8;
    mote.spin = kind === MOTE_NEEDLE ? (rand() - 0.5) * 3 : rand() * TAU;
    mote.size =
      kind === MOTE_PETAL
        ? 0.0065 + 0.0015 * rand()
        : kind === MOTE_NEEDLE
          ? 0.013
          : (species === BONSAI_SAKURA ? 0.0115 : 0.0105) * (0.85 + 0.3 * rand());
    mote.hue =
      kind === MOTE_PETAL
        ? 0.15 + 0.3 * rand()
        : kind === MOTE_NEEDLE
          ? 0.75 + 0.2 * rand()
          : bonsaiHue(species, y, t.r1, t.r2, t.outer);
    mote.angle = mote.tilt;
    mote.flip = 1;
    keepMote(mote);
    return mote;
  }

  #stepMote(m: Mote, dt: number): void {
    m.phase += m.rate * dt;
    m.x0 += (0.012 * this.#breeze + 0.03 * this.#gust) * dt;
    m.x = m.x0 + m.amp * Math.sin(m.phase);
    m.y -= (m.sink + m.dive * Math.abs(Math.cos(m.phase))) * dt;
    if (m.kind === MOTE_NEEDLE) {
      m.angle += m.spin * dt;
      m.flip = 1;
    } else {
      m.angle = m.tilt + 0.7 * Math.cos(m.phase);
      m.flip = 0.4 + 0.6 * Math.abs(Math.cos(0.5 * m.phase + m.spin));
    }
    const ground = bonsaiSurface(m.x, m.z);
    if (m.y <= ground) {
      m.live = false;
      this.#lay(
        {
          x: m.x,
          y: ground + BONSAI_TILT * m.z,
          angle: this.#random() * TAU,
          size: m.size,
          kind: m.kind,
          hue: m.hue,
          slot: 0,
        },
        m.kind === MOTE_PETAL ? PETAL_LIFE : LEAF_LIFE,
        0,
      );
    }
  }

  /** Lay something on the litter for `life` years, `age` seconds into it. */
  #lay(mark: LitterMark, life: number, age: number): void {
    let slot = this.#slots.findIndex((s) => !s.used);
    if (slot < 0) {
      let most = -1;
      for (const [i, s] of this.#slots.entries()) {
        const share = s.age / s.life;
        if (share > most) {
          most = share;
          slot = i;
        }
      }
      const old = this.#slots[slot];
      if (old) eraseLitter(this.#atlas, slot, old.bounds);
    }
    const s = this.#slots[slot];
    if (!s) return;
    const bounds = stampLitter(this.#atlas, { ...mark, slot }, litterShape(mark.kind));
    if (!bounds) {
      s.used = false;
      return;
    }
    s.used = true;
    s.life = life * this.#yearSeconds;
    s.age = age;
    s.bounds = bounds;
    this.#atlasDirty = true;
  }

  /** The litter as it would lie at year phase y: what has come down this season and not yet rotted. */
  #seedLitter(y: number): void {
    this.#atlas.fill(0, 0);
    for (const s of this.#slots) s.used = false;
    this.#clearSprites();
    const tufts = this.#tree.tufts;
    if (tufts.length === 0 || this.#leafAmount <= 0) {
      this.#atlasDirty = true;
      return;
    }
    const rand = mulberry32(0x6c697474 ^ Math.imul(this.#seed + 5, 0x9e3779b1));
    const species = this.#species;
    const scale = this.#leafAmount / 0.5;
    const total = (LEAVES_PER_YEAR[species] ?? 100) * scale;
    const petals = PETALS_PER_YEAR * scale;
    // Walk back through the year in small steps, laying what fell in each.
    const span = species === BONSAI_SAKURA ? 0.5 : 0.45;
    for (let k = 0; k < 90; k++) {
      const at = y - ((k + 0.5) / 90) * span;
      const yy = at - Math.floor(at);
      const ageYears = y - at;
      let shed = 0;
      let fall = 0;
      for (let i = 0; i < tufts.length; i += 3) {
        const t = tufts[i];
        if (!t) continue;
        shed += bonsaiShedding(species, yy, t.r1, t.outer);
        fall += bonsaiPetalFall(species, yy, t.r1);
      }
      const n3 = Math.ceil(tufts.length / 3);
      const leaves = total * (shed / n3) * (span / 90);
      const flowers = petals * (fall / n3) * (span / 90);
      for (const [count, kind, life] of [
        [leaves, species === BONSAI_PINE ? MOTE_NEEDLE : MOTE_LEAF, LEAF_LIFE],
        [flowers, MOTE_PETAL, PETAL_LIFE],
      ] as const) {
        if (ageYears >= life) continue;
        let n = Math.floor(count + rand());
        while (n-- > 0) {
          const t = tufts[Math.floor(rand() * tufts.length)];
          if (!t) continue;
          const x = t.x + (rand() - 0.5) * 0.08;
          const z = t.z - 0.4 * t.r;
          const ground = bonsaiSurface(x, z);
          const hue =
            kind === MOTE_PETAL
              ? 0.15 + 0.3 * rand()
              : kind === MOTE_NEEDLE
                ? 0.75 + 0.2 * rand()
                : bonsaiHue(species, yy, t.r1, t.r2, t.outer);
          const size =
            kind === MOTE_PETAL
              ? 0.007
              : kind === MOTE_NEEDLE
                ? 0.013
                : 0.0105 * (0.85 + 0.3 * rand());
          this.#lay(
            { x, y: ground + BONSAI_TILT * z, angle: rand() * TAU, size, kind, hue, slot: 0 },
            life,
            ageYears * this.#yearSeconds,
          );
        }
      }
    }
    this.#atlasDirty = true;
  }

  // ---- pruning ----

  /** A press at display point (x, y): snip the shoot or twig under it. */
  #prune(x: number, y: number): void {
    const year = this.#year;
    // A shoot first: they are what the gardener is after.
    let best = 0.016;
    let shoot: Shoot | undefined;
    for (const s of this.#shoots) {
      if (s.grown < 0.25 || s.cut) continue;
      const d = shootDistance(s, x, y);
      if (d < best) {
        best = d;
        shoot = s;
      }
    }
    if (shoot) {
      this.#cutShoot(shoot);
      return;
    }
    // Else the frontmost tuft under the pointer, or a bare twig.
    let front = Number.POSITIVE_INFINITY;
    let node = -1;
    for (const t of this.#tree.tufts) {
      if (t.removed) continue;
      if (
        bonsaiLeafiness(this.#species, year, t.r1, t.outer, t.regrow) < 0.25 &&
        bonsaiBlossom(this.#species, year, t.r1) < 0.25
      )
        continue;
      const qx = (x - t.x) / t.r;
      const qy = (y - t.y - BONSAI_TILT * t.z) / (t.r * t.flat);
      if (qx * qx + qy * qy < 1 && t.z - t.r < front) {
        front = t.z - t.r;
        node = t.node;
      }
    }
    if (node < 0) {
      let near = 0.012;
      for (const [i, n] of this.#tree.nodes.entries()) {
        if (n.removed || n.kind !== "twig") continue;
        const d = Math.hypot(n.x - x, n.y + BONSAI_TILT * n.z - y);
        if (d < near) {
          near = d;
          node = i;
        }
      }
    }
    if (node >= 0) this.#cutTwig(node);
  }

  /** The invisible gardener's snip, on demand: the longest shoot, else a random outer twig. */
  #gardenerSnip(): void {
    let longest: Shoot | undefined;
    for (const s of this.#shoots)
      if (
        !s.cut &&
        s.grown > 0.3 &&
        s.grown * s.length > (longest ? longest.grown * longest.length : 0)
      )
        longest = s;
    if (longest) {
      this.#cutShoot(longest);
      return;
    }
    const outer = this.#tree.tufts.filter((t) => !t.removed && t.outer > 0.6);
    const t = outer[Math.floor(this.#random() * outer.length)];
    if (t) this.#cutTwig(t.node);
  }

  #cutShoot(s: Shoot): void {
    s.cut = true;
    const reach = s.grown * s.length;
    const ex = s.x + Math.cos(s.angle) * reach * 0.6;
    const ey = s.y + Math.sin(s.angle) * reach * 0.6;
    // The shoot falls as a little wood-and-leaf sprite.
    const slot = this.#nextSprite;
    this.#nextSprite = 1 - slot;
    const twig = this.#twigs[slot];
    if (!twig) return;
    this.#drawShootSprite(slot, s, ex, ey);
    Object.assign(twig, {
      live: true,
      x: ex,
      y: ey,
      z: -0.05,
      vx: (this.#random() - 0.5) * 0.06,
      vy: 0.03,
      angle: 0,
      spin: (this.#random() - 0.5) * 2.5,
      reach: reach * 0.5,
      wx: ex,
      wy: ey,
      wangle: 0,
    });
    this.#snip = {
      x: s.x + Math.cos(s.angle) * 0.004,
      y: s.y + Math.sin(s.angle) * 0.004,
      at: this.#clock,
    };
    const pad = this.#pads[s.pad];
    if (pad) pad.vx += (this.#random() - 0.5) * 0.05;
  }

  #cutTwig(start: number): void {
    const tree = this.#tree;
    // Climb to a twig carrying a small sprig: a few tufts, never a structural branch.
    let root = start;
    for (let k = 0; k < 6; k++) {
      const n = tree.nodes[root];
      const p = tree.nodes[n?.parent ?? -1];
      if (!n || !p || p.kind !== "twig") break;
      const count = tree.tufts.filter(
        (t) => !t.removed && subtree(tree, root).includes(t.node),
      ).length;
      if (count >= 3) break;
      root = n.parent;
    }
    const nodes = subtree(tree, root).filter((i) => !tree.nodes[i]?.removed);
    const set = new Set(nodes);
    const tufts = tree.tufts
      .map((_, i) => i)
      .filter((i) => {
        const t = tree.tufts[i];
        return t !== undefined && !t.removed && set.has(t.node);
      });
    const padIndex = tree.nodes[root]?.pad ?? -1;
    const padTufts = tree.tufts.filter((t) => t.pad === padIndex);
    const gone = padTufts.filter((t) => t.removed).length + tufts.length;
    if (
      tufts.length > 12 ||
      nodes.length > 60 ||
      gone > 0.4 * padTufts.length ||
      this.#cutsThisYear >= 24
    )
      return;
    // Where it falls from: the middle of what was cut, in screen terms.
    let cx = 0;
    let cy = 0;
    let w = 0;
    for (const i of nodes) {
      const n = tree.nodes[i];
      if (!n) continue;
      cx += n.x;
      cy += n.y + BONSAI_TILT * n.z;
      w++;
    }
    if (w === 0) return;
    cx /= w;
    cy /= w;
    const year = this.#year;
    const slot = this.#nextSprite;
    this.#nextSprite = 1 - slot;
    drawSprite(this.#atlas, slot, tree, nodes, tufts, cx, cy, {
      hue: (i) => {
        const t = tree.tufts[i];
        return t ? bonsaiHue(this.#species, year, t.r1, t.r2, t.outer) : 0;
      },
      leafiness: (i) => {
        const t = tree.tufts[i];
        return t
          ? Math.max(
              bonsaiLeafiness(this.#species, year, t.r1, t.outer, t.regrow),
              bonsaiBlossom(this.#species, year, t.r1),
            )
          : 0;
      },
    });
    this.#atlasDirty = true;
    this.#atlasWait = 0;
    for (const i of nodes) {
      const n = tree.nodes[i];
      if (n) n.removed = true;
    }
    for (const i of tufts) {
      const t = tree.tufts[i];
      if (t) t.removed = true;
    }
    this.#cutsThisYear++;
    const cut = tree.nodes[root];
    const twig = this.#twigs[slot];
    if (twig && cut) {
      let reach = 0.02;
      for (const i of nodes) {
        const n = tree.nodes[i];
        if (n) reach = Math.max(reach, Math.hypot(n.x - cx, n.y + BONSAI_TILT * n.z - cy));
      }
      Object.assign(twig, {
        live: true,
        x: cx,
        y: cy,
        z: cut.z,
        vx: (this.#random() - 0.5) * 0.05,
        vy: 0.02,
        angle: 0,
        spin: (this.#random() - 0.5) * 1.6,
        reach: Math.min(reach, BONSAI_SPRITE.span * 0.45),
        wx: cx,
        wy: cy,
        wangle: 0,
      });
      const parent = tree.nodes[cut.parent];
      this.#snip = {
        x: parent ? (parent.x + cut.x) / 2 : cut.x,
        y: parent ? (parent.y + cut.y + BONSAI_TILT * (parent.z + cut.z)) / 2 : cut.y,
        at: this.#clock,
      };
    }
    const pad = this.#pads[padIndex];
    if (pad) pad.vx += (this.#random() - 0.5) * 0.08;
    this.#redraw();
    this.#writeTufts();
  }

  #drawShootSprite(slot: number, s: Shoot, px: number, py: number): void {
    const size = BONSAI_SPRITE.size;
    const x0 = BONSAI_LITTER.width + slot * size;
    const year = this.#year;
    const hue =
      this.#species === BONSAI_PINE ? 0.25 : bonsaiHue(this.#species, year, s.hash, s.hash, 1);
    const reach = s.grown * s.length;
    const ax = s.x - px;
    const ay = s.y - py;
    const bx = ax + Math.cos(s.angle) * reach;
    const by = ay + Math.sin(s.angle) * reach;
    for (let j = 0; j < size; j++) {
      const y = (j + 0.5) / BONSAI_PER_UNIT - BONSAI_SPRITE.span / 2;
      for (let i = 0; i < size; i++) {
        const x = (i + 0.5) / BONSAI_PER_UNIT - BONSAI_SPRITE.span / 2;
        const ex = bx - ax;
        const ey = by - ay;
        const t = Math.min(
          1,
          Math.max(0, ((x - ax) * ex + (y - ay) * ey) / Math.max(ex * ex + ey * ey, 1e-9)),
        );
        const d =
          Math.hypot(x - ax - ex * t, y - ay - ey * t) -
          (this.#species === BONSAI_PINE ? 0.0045 : 0.0022);
        const leaf = s.leaves * (1 - Math.hypot(x - bx, y - by) / 0.016) - 0.2;
        const o = (j * BONSAI_ATLAS.width + x0 + i) * 4;
        this.#atlas[o] = d;
        this.#atlas[o + 1] = this.#species === BONSAI_PINE ? -1 : leaf;
        this.#atlas[o + 2] = hue;
        this.#atlas[o + 3] = d < 0 || leaf > 0 ? 1 : 0;
      }
    }
    this.#atlasDirty = true;
    this.#atlasWait = 0;
  }

  /** Clear both sprites (a new tree). */
  #clearSprites(): void {
    const size = BONSAI_SPRITE.size;
    for (let j = 0; j < size; j++) {
      for (let i = BONSAI_LITTER.width; i < BONSAI_ATLAS.width; i++) {
        const o = (j * BONSAI_ATLAS.width + i) * 4;
        this.#atlas[o] = 0.05;
        this.#atlas[o + 1] = -1;
        this.#atlas[o + 2] = 0;
        this.#atlas[o + 3] = 0;
      }
    }
  }

  #stepTwig(twig: Twig, dt: number): void {
    twig.vy -= TWIG_GRAVITY * dt;
    const drag = Math.exp(-TWIG_DRAG * dt);
    twig.vx *= drag;
    twig.vy *= drag;
    twig.x += twig.vx * dt;
    twig.y += twig.vy * dt;
    twig.angle += twig.spin * dt;
    const ground = bonsaiSurface(twig.x, twig.z) + BONSAI_TILT * twig.z;
    if (twig.y - twig.reach * 0.25 <= ground) {
      twig.live = false;
      this.#layTwig(twig, ground);
    }
  }

  /** A landed twig lies on the litter: its sprite turned into wood and leaf marks. */
  #layTwig(twig: Twig, ground: number): void {
    const slot = this.#twigs.indexOf(twig);
    const size = BONSAI_SPRITE.size;
    const x0 = BONSAI_LITTER.width + slot * size;
    const litterSlot = this.#slots.findIndex((s) => !s.used);
    if (litterSlot < 0) return;
    const c = Math.cos(twig.angle);
    const s = Math.sin(twig.angle);
    let i0: number = BONSAI_LITTER.width;
    let j0: number = BONSAI_LITTER.height;
    let i1 = -1;
    let j1 = -1;
    for (let j = 0; j < size; j += 1) {
      const ly = (j + 0.5) / BONSAI_PER_UNIT - BONSAI_SPRITE.span / 2;
      for (let i = 0; i < size; i += 1) {
        const o = (j * BONSAI_ATLAS.width + x0 + i) * 4;
        if ((this.#atlas[o + 3] ?? 0) === 0) continue;
        const lx = (i + 0.5) / BONSAI_PER_UNIT - BONSAI_SPRITE.span / 2;
        const wx = twig.x + c * lx - s * ly * 0.5;
        const wy = ground + (s * lx + c * ly) * 0.5;
        const ti = Math.floor((wx - BONSAI_LITTER.x0) * BONSAI_PER_UNIT);
        const tj = Math.floor((wy - BONSAI_LITTER.y0) * BONSAI_PER_UNIT);
        if (ti < 0 || tj < 0 || ti >= BONSAI_LITTER.width || tj >= BONSAI_LITTER.height) continue;
        const wood = (this.#atlas[o] ?? 1) < 0;
        const t = (tj * BONSAI_ATLAS.width + ti) * 4;
        this.#atlas[t] = wood
          ? (MOTE_WOOD + 0.5) / 4
          : (MOTE_LEAF + Math.min(0.999, this.#atlas[o + 2] ?? 0)) / 4;
        this.#atlas[t + 1] = litterSlot;
        this.#atlas[t + 2] = 0.3 + (0.4 * ((ti * 7 + tj * 13) % 10)) / 10;
        this.#atlas[t + 3] = 0.85;
        i0 = Math.min(i0, ti);
        j0 = Math.min(j0, tj);
        i1 = Math.max(i1, ti);
        j1 = Math.max(j1, tj);
      }
    }
    const entry = this.#slots[litterSlot];
    if (entry && i1 >= 0) {
      entry.used = true;
      entry.age = 0;
      entry.life = TWIG_LIFE * this.#yearSeconds;
      entry.bounds = [i0, j0, i1, j1];
    }
    this.#atlasDirty = true;
  }

  // ---- packing ----

  /** Everything the shader reads, the moving parts `alpha` of the way through their last step. */
  #pack(alpha: number): void {
    const data = this.#data;
    const maps = this.#maps;
    const y = this.#year;
    // Each pad's sway as drawn.
    const pads = this.#pads;
    if (this.#sway.length !== 2 * pads.length) this.#sway = new Float64Array(2 * pads.length);
    const sway = this.#sway;
    for (const [i, pad] of pads.entries()) {
      sway[2 * i] = pad.wx + (pad.x - pad.wx) * alpha;
      sway[2 * i + 1] = pad.wy + (pad.y - pad.wy) * alpha;
    }
    // The field: sway per texel from its two pads, and the silhouettes (none before a tree is up).
    if (maps !== undefined) {
      for (let f = 0; f < FW * FH; f++) {
        const flex = maps.flex[f] ?? 0;
        const a = maps.padA[f] ?? -1;
        const b = maps.padB[f] ?? -1;
        const wa = maps.weightA[f] ?? 1;
        const o = f * 4;
        data[o] = flex * ((sway[2 * a] ?? 0) * wa + (sway[2 * b] ?? 0) * (1 - wa));
        data[o + 1] = flex * ((sway[2 * a + 1] ?? 0) * wa + (sway[2 * b + 1] ?? 0) * (1 - wa));
        data[o + 2] = maps.woodSil[f] ?? 0;
        data[o + 3] = maps.leafSil[f] ?? 0;
      }
    }
    // Shoots.
    const shootRow = BONSAI_ROWS.shoots * FW * 4;
    data.fill(0, shootRow, BONSAI_ROWS.motes * FW * 4);
    for (const [i, s] of this.#shoots.entries()) {
      const o = shootRow + i * 8;
      data[o] = s.x;
      data[o + 1] = s.y;
      data[o + 2] = s.angle;
      data[o + 3] = s.length;
      data[o + 4] = s.bend;
      data[o + 5] = s.grown;
      data[o + 6] = s.leaves;
      data[o + 7] = s.hash;
    }
    // Motes, and the box they are all in (the shader skips its loop outside it).
    const moteRow = BONSAI_ROWS.motes * FW * 4;
    data.fill(0, moteRow, BONSAI_ROWS.litter * FW * 4);
    let x0 = 1;
    let y0 = 1;
    let x1 = -1;
    let y1 = -1;
    for (const [i, m] of this.#motes.entries()) {
      if (!m.live) continue;
      const o = moteRow + i * 8;
      const x = m.wx + (m.x - m.wx) * alpha;
      const sy = m.wy + (m.y - m.wy) * alpha + BONSAI_TILT * m.z;
      data[o] = x;
      data[o + 1] = sy;
      data[o + 2] = m.wangle + (m.angle - m.wangle) * alpha;
      data[o + 3] = m.size;
      data[o + 4] = m.kind + Math.min(0.999, Math.max(0, m.hue));
      data[o + 5] = m.wflip + (m.flip - m.wflip) * alpha;
      data[o + 6] = 1;
      data[o + 7] = 0;
      x0 = Math.min(x0, x - 1.5 * m.size);
      y0 = Math.min(y0, sy - 1.5 * m.size);
      x1 = Math.max(x1, x + 1.5 * m.size);
      y1 = Math.max(y1, sy + 1.5 * m.size);
    }
    // Litter decay per slot.
    const litterRow = BONSAI_ROWS.litter * FW * 4;
    for (const [i, s] of this.#slots.entries())
      data[litterRow + i] = s.used ? Math.min(1, s.age / Math.max(s.life, 1e-3)) : 1;
    // State.
    let leafy = 0;
    let blossom = 0;
    let n = 0;
    for (const t of this.#tree.tufts) {
      if (t.removed) continue;
      leafy += bonsaiLeafiness(this.#species, y, t.r1, t.outer, t.regrow);
      blossom += bonsaiBlossom(this.#species, y, t.r1);
      n++;
    }
    const state = BONSAI_ROWS.state * FW * 4;
    data[state] = y;
    data[state + 1] = this.#lying;
    data[state + 2] = this.#falling;
    data[state + 3] = n > 0 ? leafy / n : 0;
    data[state + 4] = this.#snip.x;
    data[state + 5] = this.#snip.y;
    data[state + 6] = Math.min(60, this.#clock - this.#snip.at);
    data[state + 7] = this.#gust;
    data[state + 9] = this.#shift;
    data[state + 8] = n > 0 ? blossom / n : 0;
    data[state + 12] = x0;
    data[state + 13] = y0;
    data[state + 14] = x1;
    data[state + 15] = y1;
    for (const [k, twig] of this.#twigs.entries()) {
      const o = state + (4 + 2 * k) * 4;
      data[o] = twig.wx + (twig.x - twig.wx) * alpha;
      data[o + 1] = twig.wy + (twig.y - twig.wy) * alpha;
      data[o + 2] = twig.wangle + (twig.angle - twig.wangle) * alpha;
      data[o + 3] = twig.live ? 1 : 0;
      data[o + 4] = twig.live ? 1 : 0;
    }
  }
}

/** A leaf (petal, needle) as it is becomes the step before: what its next step is drawn from. */
function keepMote(mote: Mote): void {
  mote.wx = mote.x;
  mote.wy = mote.y;
  mote.wangle = mote.angle;
  mote.wflip = mote.flip;
}

/**
 * A bonsai gust's swell and fade over its age in seconds: up in 1.5 s, gone over ~6. Its own shape,
 * not sims/wind.ts gustPulse (garden's and autumn's).
 */
function gustSwell(age: number): number {
  if (age < 0) return 0;
  return (1 - Math.exp(-age / 1.5)) * Math.exp(-age / 4);
}

/** Distance from a display point to a shoot's grown stem. */
function shootDistance(s: Shoot, x: number, y: number): number {
  const reach = s.grown * s.length;
  const half = s.length * 0.5;
  const ax = s.x;
  const ay = s.y;
  const first = Math.min(reach, half);
  const bx = ax + Math.cos(s.angle) * first;
  const by = ay + Math.sin(s.angle) * first;
  const cx = bx + Math.cos(s.angle + s.bend) * Math.max(0, reach - half);
  const cy = by + Math.sin(s.angle + s.bend) * Math.max(0, reach - half);
  return Math.min(segment(x, y, ax, ay, bx, by), segment(x, y, bx, by, cx, cy));
}

function segment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const ex = bx - ax;
  const ey = by - ay;
  const t = Math.min(
    1,
    Math.max(0, ((px - ax) * ex + (py - ay) * ey) / Math.max(ex * ex + ey * ey, 1e-12)),
  );
  return Math.hypot(px - ax - ex * t, py - ay - ey * t);
}

/** The bonsai's simulation for a scene whose knobs are `params` (looked up by key). */
export function bonsaiSim(params: readonly ParamDef[]): SimFactory {
  return (gl) => new BonsaiSim(gl, params);
}
