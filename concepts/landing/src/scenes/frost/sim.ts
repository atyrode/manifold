// Frost on a window pane: when frost reaches every point of the glass, and where warmth melted it.
//
// uSim0  growth, rgba16f, about 512×288 texels, recomputed per pattern seed and frame shape:
//          r  growth-clock seconds at which the nearest crystal branch reached this texel
//          g  distance to that branch in frame heights, roughened with noise: the finer fur frost
//             spreads out from the branches at a pace the shader takes from the style knob
//          b  fern line: 1 on a crystal branch, falling off across its width
//          a  the branch's direction, angle / π (0..1)
// uSim1  melt, rgba8 at half that resolution, stepped every frame:
//          r  melt level (clear glass above MELT_CLEAR), g how recently the patch refroze,
//          b  warmth of the glass, a the M traced by the Manifold fingertip
// uSim2  clock, r16f 1×1: the growth clock in seconds
//
// Growth. Window frost grows as "fern frost": dendrites nucleate on the pane's edges, its coldest
// corners and scratches, then branch as they go. Ice is hexagonal, so side branches leave at ±60°
// and their own branches at ±60° again, every branch shorter than the one it grew from. All tips
// advance together on one clock, and a tip stops where it meets older ice: that competition is
// what packs real frost into feathered fronds rather than a tangle (see Libbrecht, "The physics
// of snow crystals", Rep. Prog. Phys. 68, 2005, on dendritic side-branching). The texel field is
// then a nearest-branch distance transform, the two-pass sequential propagation of Danielsson
// ("Euclidean distance mapping", CGIP 14, 1980), carrying each branch's arrival time and direction.
//
// Melt. A TrailField records the pointer's warmth. Where it is warm enough the frost melts; once
// it cools, the meltwater refreezes from the cleared patch's edges inward (only texels next to
// frozen glass refreeze quickly), and the new frost there starts thin and thickens back.
import type { ParamDef } from "../../params.ts";
import { DataTexture } from "../../sims/texture.ts";
import { TrailField } from "../../sims/trail.ts";
import type { SceneSim, SimFactory, SimFrame } from "../types.ts";

/** Width of the window frame round the screen, in frame heights; the glass starts inside it. */
export const FROST_FRAME = 0.035;
/** Melt level above which the glass is clear of frost. */
export const MELT_CLEAR = 0.5;
/**
 * Seconds the fur frost takes to spread one frame height out from a crystal branch, at the fern
 * end and the fur end of the style knob (the shader interpolates geometrically between them).
 */
export const FUR_SLOW_FERN = 2500;
export const FUR_SLOW_FUR = 150;
/** Seconds from the fur frost's arrival until it is at full thickness. */
export const FUR_RIPEN = 25;

/** The growth clock's pace for a style knob value, as the shader computes it. */
export function furSlowness(style: number): number {
  return FUR_SLOW_FERN * Math.pow(FUR_SLOW_FUR / FUR_SLOW_FERN, style);
}

/** Texels in the growth field, whatever the frame's shape (512×288 at 16:9). */
const GROWTH_TEXELS = 512 * 288;
/** Milliseconds per frame the growth may take: more while no frost is shown at all yet. */
const GROWTH_BUDGET_MS = 6;
const FIRST_GROWTH_BUDGET_MS = 20;

/** Growth-clock seconds per lockstep round of the dendrite growth, and texels per tip step. */
const ROUND = 0.5;
const STEP = 0.7;
/** Main stems grow this many frame heights per growth-clock second. */
const STEM_SPEED = 0.011;
/** Shortest branch worth growing, in frame heights. */
const MIN_BRANCH = 0.008;

interface Level {
  /** Half-width in texels at 288 texels high. */
  width: number;
  /** Distance between side-branch sites along the branch, in frame heights. */
  spacing: number;
  /** Length of its side branches, relative to its own. */
  ratio: number;
  /** Brightness of the line: thick stems scatter more light. */
  bright: number;
  /** How far it meanders, radians: stems curve, the finest needles grow straight. */
  wobble: number;
}

/** Per depth of branching: 0 the stem, 1 its side branches, 2 their twigs, 3 needles. */
const LEVELS: readonly Level[] = [
  { width: 1.35, spacing: 0.022, ratio: 0.42, bright: 1, wobble: 0.3 },
  { width: 0.9, spacing: 0.015, ratio: 0.45, bright: 0.85, wobble: 0.1 },
  { width: 0.65, spacing: 0.012, ratio: 0.4, bright: 0.72, wobble: 0.05 },
  { width: 0.55, spacing: 0, ratio: 0, bright: 0.62, wobble: 0.03 },
];

/** Melt rises this much per second at full warmth; warmth below ONSET only fogs the glass. */
const MELT_RATE = 5;
const MELT_ONSET = 0.38;
/** Refreezing per second: fast beside frozen glass, slow in the middle of a cleared patch. */
const FRONT_RATE = 0.09;
const BULK_RATE = 0.005;
/** Seconds the refrozen frost takes to thicken back to the pattern around it. */
const REGROW_SECONDS = 90;
/** Half-life of the glass's warmth after a touch, seconds. */
const HEAT_HALF_LIFE = 0.9;
/** Touch radius in frame heights at the low and high end of the warmth knob. */
const TOUCH_RADIUS = [0.035, 0.085] as const;

/** The Manifold M, as the shader's markDistance draws it (mark units), traced in this order. */
const MARK_PATH: readonly (readonly [number, number])[] = [
  [-0.47, -0.5],
  [-0.47, 0.5],
  [0, -0.08],
  [0.47, 0.5],
  [0.47, -0.5],
];
/**
 * Mark units per second the fingertip traces, its pause at each corner, the wait between tracings
 * while the M is on, and the growth-clock seconds before the first, so there is frost to write in.
 */
const MARK_SPEED = 1.5;
const MARK_PAUSE = 0.15;
const MARK_REPEAT = 80;
const MARK_FIRST = 20;

/** Mulberry32: a small, fast, seedable PRNG. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A lattice hash to 0..1, after the murmur3 finaliser. */
function hash(x: number, y: number, salt: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(salt | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise, 0..1. */
function noise(x: number, y: number, salt: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy, salt);
  const b = hash(ix + 1, iy, salt);
  const c = hash(ix, iy + 1, salt);
  const d = hash(ix + 1, iy + 1, salt);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Growth field size for a frame shape: about GROWTH_TEXELS, rounded so small resizes reuse it. */
function growthSize(aspect: number): { width: number; height: number } {
  const shape = Math.min(4, Math.max(0.25, Math.round(aspect * 50) / 50));
  const width = Math.max(16, Math.round(Math.sqrt(GROWTH_TEXELS * shape)));
  return { width, height: Math.max(16, Math.round(width / shape)) };
}

interface GrowthField {
  width: number;
  height: number;
  /** rgba16f texels, rows bottom to top (see the header). */
  data: Float32Array;
  /** Latest arrival of any crystal branch, and the furthest any texel is from one (g). */
  latest: number;
  reach: number;
}

/** A growing branch tip. */
interface Tip {
  id: number;
  /** The branch it grew from and that branch's parent: running into them is no collision. */
  parent: number;
  grand: number;
  x: number;
  y: number;
  /** Starting direction, and the direction it is heading now (radians, 0 = right, y up). */
  angle: number;
  heading: number;
  /** Texels: its full length, and how far it has grown. */
  length: number;
  walked: number;
  /** Growth-clock second it starts growing, and texels per second. */
  start: number;
  speed: number;
  level: number;
  /** Half-width in texels at its base. */
  width: number;
  /** Steady turn in radians per texel, and meander amplitude in radians. */
  curl: number;
  wobble: number;
  /** Texels it grows before it may collide: it starts inside the ice it sprouted from. */
  grace: number;
  /** Where along it the next side branch sprouts, and which side (+1 left, -1 right). */
  nextSprout: number;
  side: number;
  /** Side branches in opposite pairs, or alternating sides. */
  paired: boolean;
  alive: boolean;
}

/**
 * Grow the frost for one pattern and frame shape, yielding every so often so the caller can
 * spread the work over frames. Deterministic for a seed and size.
 */
function* growFrost(pattern: number, width: number, height: number): Generator<undefined, GrowthField, undefined> {
  const count = width * height;
  const unit = height;
  const scale = height / 288;
  const frame = FROST_FRAME * height;
  const rand = random(Math.imul(pattern + 1, 0x9e3779b1) ^ 0x5bd1e995);
  const range = (lo: number, hi: number): number => lo + (hi - lo) * rand();

  // Crystal seeds, at most one per texel: the earliest ice to pass through it.
  const seedT = new Float32Array(count).fill(Infinity);
  const seedX = new Float32Array(count);
  const seedY = new Float32Array(count);
  const seedW = new Float32Array(count);
  const seedA = new Float32Array(count);
  const seedB = new Float32Array(count);
  // Which branch first claimed each texel (a plus-shaped footprint, so tips cannot slip between
  // the diagonal texels of another line): tips stop when they run into someone else's ice.
  const owner = new Int32Array(count).fill(-1);

  const claim = (px: number, py: number, id: number): void => {
    if (px < 0 || py < 0 || px >= width || py >= height) return;
    const k = py * width + px;
    if ((owner[k] ?? 0) < 0) owner[k] = id;
  };
  const plant = (x: number, y: number, t: number, w: number, angle: number, bright: number, id: number): void => {
    const px = Math.floor(x);
    const py = Math.floor(y);
    if (px < 0 || py < 0 || px >= width || py >= height) return;
    const k = py * width + px;
    if (t < (seedT[k] ?? Infinity)) {
      seedT[k] = t;
      seedX[k] = x;
      seedY[k] = y;
      seedW[k] = w;
      seedA[k] = angle;
      seedB[k] = bright;
    }
    claim(px, py, id);
    claim(px - 1, py, id);
    claim(px + 1, py, id);
    claim(px, py - 1, id);
    claim(px, py + 1, id);
  };

  // Rime along the glass's edges, coldest at the bottom, where it is there from the start (negative
  // arrival times), then up the sides and last along the top. Ids 0..2.
  for (let x = frame; x <= width - frame; x += STEP) {
    const lift = 0.4 + 1.3 * noise(x / (0.02 * unit), 0, 11);
    plant(x, frame + lift, -30 + 14 * noise(x / (0.06 * unit), 3, 12), 1.6 * scale, 0, 0.8, 0);
    plant(x, height - frame - lift, 45 + 15 * noise(x / (0.06 * unit), 5, 13), 1.2 * scale, 0, 0.7, 2);
  }
  for (let y = frame; y <= height - frame; y += STEP) {
    const climb = y / height;
    for (const [x, salt] of [[frame + 0.4, 14], [width - frame - 0.4, 15]] as const) {
      const inset = 1.3 * noise(y / (0.02 * unit), salt, 16);
      plant(x + (x < width / 2 ? inset : -inset), y, -12 + 55 * climb + 10 * noise(y / (0.06 * unit), salt, 17), 1.3 * scale, Math.PI / 2, 0.72, 1);
    }
  }

  const tips: Tip[] = [];
  let nextId = 3;
  const sprout = (x: number, y: number, angle: number, length: number, start: number, level: number, parent: Tip | undefined, origin: number): void => {
    const spec = LEVELS[level];
    if (!spec) return;
    const id = nextId++;
    const spacing = Math.max(2, spec.spacing * unit);
    const grace = parent ? 2.5 + parent.width * 2 : 5;
    tips.push({
      id,
      parent: parent ? parent.id : origin,
      grand: parent ? parent.parent : -1,
      x,
      y,
      angle,
      heading: angle,
      length,
      walked: 0,
      start,
      speed: parent ? parent.speed * 0.8 : STEM_SPEED * unit,
      level,
      width: Math.max(0.5, parent ? Math.min(spec.width * scale, parent.width * 0.7) : spec.width * scale),
      curl: parent ? parent.curl * 0.4 + (rand() - 0.5) * (0.3 / length) : (rand() - 0.5) * (2.2 / length),
      wobble: spec.wobble,
      grace,
      nextSprout: grace + spacing * range(0.4, 0.8),
      side: rand() < 0.5 ? 1 : -1,
      paired: level === 0 ? rand() < 0.5 : level === 1 ? rand() < 0.65 : false,
      alive: true,
    });
  };

  // Scratches: short lines of rime that nucleate later, each sending a few stems out sideways.
  const scratches = 2 + Math.floor(rand() * 2);
  for (let i = 0; i < scratches; i++) {
    const id = nextId++;
    const cx = range(0.15, 0.85) * width;
    const cy = range(0.25, 0.8) * height;
    const length = range(0.05, 0.14) * unit;
    const angle = rand() * Math.PI;
    const bend = (rand() - 0.5) * 0.8;
    const t = range(10, 35);
    const points: { x: number; y: number; heading: number }[] = [];
    for (let s = -length / 2; s <= length / 2; s += STEP) {
      const heading = angle + (bend * s) / length;
      const x = cx + Math.cos(angle) * s + Math.cos(angle + Math.PI / 2) * bend * (s * s) / length;
      const y = cy + Math.sin(angle) * s + Math.sin(angle + Math.PI / 2) * bend * (s * s) / length;
      plant(x, y, t + Math.abs(s) * 0.02, 0.6 * scale, heading, 0.55, id);
      points.push({ x, y, heading });
    }
    const stems = 3 + Math.floor(rand() * 2);
    for (let j = 0; j < stems; j++) {
      const at = points[Math.floor(rand() * points.length)];
      if (!at) continue;
      const out = at.heading + (rand() < 0.5 ? 1 : -1) * (Math.PI / 2 + (rand() - 0.5) * 1.2);
      sprout(at.x, at.y, out, range(0.12, 0.3) * unit, t + range(0.5, 3.5), 0, undefined, id);
    }
  }

  // Stems from the bottom edge, fanning upward, then the corners, the sides and the top.
  const along = width - 2 * frame;
  const bottom = Math.max(2, Math.round(along / (0.085 * unit)));
  for (let i = 0; i < bottom; i++) {
    const x = frame + ((i + range(0.2, 0.8)) / bottom) * along;
    sprout(x, frame + 1, Math.PI / 2 + (rand() - 0.5) * 1.3, range(0.22, 0.55) * unit, range(0, 10), 0, undefined, 0);
  }
  for (const [x, y, toward, start] of [
    [frame + 1, frame + 1, 0, 0],
    [width - frame - 1, frame + 1, Math.PI, 0],
    [frame + 1, height - frame - 1, 0, 30],
    [width - frame - 1, height - frame - 1, Math.PI, 30],
  ] as const) {
    const up = y < height / 2 ? 1 : -1;
    const stems = up > 0 ? 3 : 2;
    for (let j = 0; j < stems; j++) {
      const tilt = range(0.35, 1.2) * up;
      const angle = toward === 0 ? tilt : Math.PI - tilt;
      const length = (up > 0 ? range(0.3, 0.5) : range(0.2, 0.35)) * unit;
      sprout(x, y, angle, length, start + range(0, up > 0 ? 6 : 15), 0, undefined, 1);
    }
  }
  for (const [x, inward] of [[frame + 1, 0], [width - frame - 1, Math.PI]] as const) {
    for (let j = 0; j < 2; j++) {
      sprout(x, range(0.25, 0.75) * height, inward + (rand() - 0.5) * 1.2, range(0.18, 0.32) * unit, range(15, 40), 0, undefined, 1);
    }
  }
  const top = Math.max(1, Math.round(along / (0.3 * unit)));
  for (let i = 0; i < top; i++) {
    const x = frame + ((i + range(0.2, 0.8)) / top) * along;
    sprout(x, height - frame - 1, -Math.PI / 2 + (rand() - 0.5) * 1.2, range(0.12, 0.25) * unit, range(45, 70), 0, undefined, 2);
  }

  // Grow every tip together, ROUND growth-seconds at a time, so whichever ice is older really was
  // there first when a younger tip runs into it.
  let active: Tip[] = tips.splice(0);
  for (let clock = 0; active.length > 0 && clock < 900; clock += ROUND) {
    for (const tip of active) {
      if (tip.start > clock) continue;
      const target = Math.min(tip.length, (clock - tip.start) * tip.speed);
      while (tip.alive && tip.walked + STEP <= target) {
        tip.walked += STEP;
        const s = tip.walked;
        const f = s / tip.length;
        tip.heading = tip.angle + tip.curl * s + tip.wobble * 2 * (noise(s / (0.05 * unit), tip.id, 5) - 0.5);
        const dx = Math.cos(tip.heading);
        const dy = Math.sin(tip.heading);
        tip.x += dx * STEP;
        tip.y += dy * STEP;
        if (tip.x < frame || tip.x > width - frame || tip.y < frame || tip.y > height - frame) {
          tip.alive = false;
          break;
        }
        if (s > tip.grace) {
          const ahead = tip.width + 1;
          const px = Math.floor(tip.x + dx * ahead);
          const py = Math.floor(tip.y + dy * ahead);
          if (px >= 0 && py >= 0 && px < width && py < height) {
            const other = owner[py * width + px] ?? -1;
            if (other >= 0 && other !== tip.id && other !== tip.parent && other !== tip.grand) {
              tip.alive = false;
              break;
            }
          }
        }
        const arrival = tip.start + s / tip.speed;
        const spec = LEVELS[tip.level];
        plant(tip.x, tip.y, arrival, tip.width * (1 - 0.45 * f), tip.heading, spec ? spec.bright : 0.6, tip.id);
        // Side branches: longest a little way up the branch, shortening toward its tip, as on a
        // fern frond; each starts a moment after the tip has passed.
        if (spec && spec.ratio > 0 && s >= tip.nextSprout) {
          const envelope = Math.pow(1 - f, 0.75) * (0.55 + 0.45 * Math.min(1, f / 0.15));
          const sides = tip.paired ? [1, -1] : [tip.side];
          tip.side = -tip.side;
          for (const side of sides) {
            const length = tip.length * spec.ratio * envelope * range(0.7, 1.3);
            if (length < MIN_BRANCH * unit) continue;
            const angle = tip.heading + side * (Math.PI / 3 + (rand() - 0.5) * 0.14);
            sprout(tip.x, tip.y, angle, length, arrival + range(0.3, 1.3), tip.level + 1, tip, -1);
          }
          tip.nextSprout = s + Math.max(2, spec.spacing * unit) * range(0.75, 1.25);
        }
      }
      if (tip.walked + STEP > tip.length) tip.alive = false;
    }
    active = active.filter((tip) => tip.alive).concat(tips.splice(0));
    yield;
  }

  // Nearest crystal for every texel: seeds propagate forward then backward over the grid, each
  // texel keeping whichever neighbour's seed lies closer.
  const nearest = new Int32Array(count).fill(-1);
  const best = new Float32Array(count).fill(Infinity);
  for (let k = 0; k < count; k++) {
    if ((seedT[k] ?? Infinity) < Infinity) {
      nearest[k] = k;
      const dx = (k % width) + 0.5 - (seedX[k] ?? 0);
      const dy = Math.floor(k / width) + 0.5 - (seedY[k] ?? 0);
      best[k] = dx * dx + dy * dy;
    }
  }
  const offer = (k: number, x: number, y: number, from: number): void => {
    const s = nearest[from] ?? -1;
    if (s < 0) return;
    const dx = x + 0.5 - (seedX[s] ?? 0);
    const dy = y + 0.5 - (seedY[s] ?? 0);
    const d = dx * dx + dy * dy;
    if (d < (best[k] ?? Infinity)) {
      best[k] = d;
      nearest[k] = s;
    }
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const k = y * width + x;
      if (x > 0) offer(k, x, y, k - 1);
      if (y > 0) {
        if (x > 0) offer(k, x, y, k - width - 1);
        offer(k, x, y, k - width);
        if (x < width - 1) offer(k, x, y, k - width + 1);
      }
    }
    for (let x = width - 2; x >= 0; x--) offer(y * width + x, x, y, y * width + x + 1);
    if (y % 32 === 31) yield;
  }
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const k = y * width + x;
      if (x < width - 1) offer(k, x, y, k + 1);
      if (y < height - 1) {
        if (x < width - 1) offer(k, x, y, k + width + 1);
        offer(k, x, y, k + width);
        if (x > 0) offer(k, x, y, k + width - 1);
      }
    }
    for (let x = 1; x < width; x++) offer(y * width + x, x, y, y * width + x - 1);
    if (y % 32 === 0) yield;
  }

  // Pack the texels. The fur's distance is roughened by noise so it fills in by irregular,
  // crystalline fronts, and shortened low on the pane, where the glass is coldest.
  const data = new Float32Array(count * 4);
  let latest = 0;
  let reach = 0;
  for (let y = 0; y < height; y++) {
    const cold = 0.6 + 0.4 * smoothstep(0, 0.5, y / height);
    for (let x = 0; x < width; x++) {
      const k = y * width + x;
      const s = nearest[k] ?? -1;
      const o = k * 4;
      if (s < 0) {
        data[o] = 1e4;
        continue;
      }
      const d = Math.sqrt(best[k] ?? 0);
      const t = seedT[s] ?? 0;
      const w = seedW[s] ?? 1;
      const rough = 0.55 + 0.9 * (0.6 * noise(x / (0.05 * unit), y / (0.05 * unit), 21) + 0.4 * noise(x / (0.018 * unit), y / (0.018 * unit), 22));
      const g = (d / unit) * rough * cold;
      const turn = (seedA[s] ?? 0) / Math.PI;
      data[o] = t;
      data[o + 1] = g;
      data[o + 2] = (seedB[s] ?? 0) * (1 - smoothstep(w * 0.4, w + 1.1, d));
      data[o + 3] = turn - Math.floor(turn);
      latest = Math.max(latest, t);
      reach = Math.max(reach, g);
    }
    if (y % 48 === 47) yield;
  }
  return { width, height, data, latest, reach };
}

/** Melting and refreezing on a grid at half the growth field's resolution. */
class MeltField {
  readonly width: number;
  readonly height: number;
  /** The pointer's warmth, and the fingertip tracing the Manifold M. */
  readonly heat: TrailField;
  readonly finger: TrailField;
  /** rgba8 texels for upload (see the header). */
  readonly bytes: Uint8Array;
  readonly #melt: Float32Array;
  readonly #regrow: Float32Array;
  readonly #mark: Float32Array;
  /** Per-texel refreezing pace, so the frost closes in by a ragged, crystalline edge. */
  readonly #pace: Float32Array;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.heat = new TrailField(width, height);
    this.finger = new TrailField(width, height);
    this.bytes = new Uint8Array(width * height * 4);
    this.#melt = new Float32Array(width * height);
    this.#regrow = new Float32Array(width * height);
    this.#mark = new Float32Array(width * height);
    this.#pace = new Float32Array(width * height);
    for (let k = 0; k < this.#pace.length; k++) this.#pace[k] = 0.55 + 0.9 * hash(k % width, Math.floor(k / width), 31);
  }

  /**
   * Melt where the glass is warm (`dt`, real seconds) and refreeze elsewhere (`cool`, seconds
   * scaled by motion). Returns whether the texels changed.
   */
  step(dt: number, cool: number): boolean {
    this.heat.decay(dt, HEAT_HALF_LIFE);
    this.finger.decay(dt, HEAT_HALF_LIFE);
    if (dt <= 0) return false;
    const { width, height, bytes } = this;
    const melt = this.#melt;
    const regrow = this.#regrow;
    const mark = this.#mark;
    const heat = this.heat.data;
    const finger = this.finger.data;
    let changed = false;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const k = y * width + x;
        const traced = (finger[k] ?? 0) / 255;
        const warmth = Math.max((heat[k] ?? 0) / 255, traced);
        let level = melt[k] ?? 0;
        if (warmth > MELT_ONSET) {
          level = Math.min(1, level + ((warmth - MELT_ONSET) / (1 - MELT_ONSET)) * MELT_RATE * dt);
        } else if (level > 0 && warmth < 0.05) {
          // Only texels beside frozen glass (or the frame) refreeze quickly: the front moves inward.
          const front =
            x === 0 || y === 0 || x === width - 1 || y === height - 1 ||
            (melt[k - 1] ?? 0) < MELT_CLEAR || (melt[k + 1] ?? 0) < MELT_CLEAR ||
            (melt[k - width] ?? 0) < MELT_CLEAR || (melt[k + width] ?? 0) < MELT_CLEAR;
          level = Math.max(0, level - (front ? FRONT_RATE : BULK_RATE) * (this.#pace[k] ?? 1) * cool);
        }
        melt[k] = level;
        const young = level >= MELT_CLEAR ? 1 : Math.max(0, (regrow[k] ?? 0) - cool / REGROW_SECONDS);
        regrow[k] = young;
        const traceMark = traced > MELT_ONSET ? 1 : Math.min(mark[k] ?? 0, young);
        mark[k] = traceMark;
        const o = k * 4;
        const r = Math.round(level * 255);
        const g = Math.round(young * 255);
        const b = Math.round(warmth * 255);
        const a = Math.round(traceMark * 255);
        if (bytes[o] !== r || bytes[o + 1] !== g || bytes[o + 2] !== b || bytes[o + 3] !== a) {
          bytes[o] = r;
          bytes[o + 1] = g;
          bytes[o + 2] = b;
          bytes[o + 3] = a;
          changed = true;
        }
      }
    }
    return changed;
  }
}

/** Where the fingertip is `elapsed` seconds into tracing the M, in mark units; undefined once done. */
function markPoint(elapsed: number): readonly [number, number] | undefined {
  let left = elapsed;
  for (let i = 0; i + 1 < MARK_PATH.length; i++) {
    const a = MARK_PATH[i];
    const b = MARK_PATH[i + 1];
    if (!a || !b) break;
    const span = Math.hypot(b[0] - a[0], b[1] - a[1]) / MARK_SPEED;
    if (left <= span) {
      // Slowing into each corner, as a hand does.
      const u = smoothstep(0, 1, left / span);
      return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
    }
    left -= span;
    if (left <= MARK_PAUSE) return b;
    left -= MARK_PAUSE;
  }
  return undefined;
}

/**
 * The frost simulation. `knobs` are the scene's params, so it can read its own knobs from
 * `SimFrame.values` by key.
 */
export function frostSim(knobs: readonly ParamDef[]): SimFactory {
  const slot = (key: string): number => {
    const index = knobs.findIndex((knob) => knob.key === key);
    if (index < 0) throw new Error(`landing: the frost scene has no "${key}" knob`);
    return index;
  };
  const at = { speed: slot("speed"), style: slot("style"), pattern: slot("pattern"), warmth: slot("warmth"), mark: slot("mark") };

  return (gl): SceneSim => {
    const growthTexture = new DataTexture(gl, { width: 1, height: 1, format: "rgba16f" });
    const meltTexture = new DataTexture(gl, { width: 1, height: 1, format: "rgba8" });
    const clockTexture = new DataTexture(gl, { width: 1, height: 1, format: "r16f", filter: "nearest" });
    const clockData = new Float32Array(1);
    let field: GrowthField | undefined;
    let job: Generator<undefined, GrowthField, undefined> | undefined;
    let jobKey = "";
    let pattern: number | undefined;
    let clock = 0;
    let uploadedClock = Number.NaN;
    let melt: MeltField | undefined;
    let last: { x: number; y: number } | undefined;
    let lastTrigger: number | undefined;
    let traceStart: number | undefined;
    let traceSize = 0.4;
    let nextTrace: number | undefined;

    /** Warm the glass under the pointer: a held fingertip melts, a passing hand only breathes on it. */
    const touch = (frame: SimFrame, glass: MeltField): void => {
      const warmth = frame.values[at.warmth] ?? 0;
      const { pointer, aspect, dt } = frame;
      if (warmth <= 0 || !pointer.inside || dt <= 0) {
        glass.heat.lift();
        last = undefined;
        return;
      }
      const radius = TOUCH_RADIUS[0] + (TOUCH_RADIUS[1] - TOUCH_RADIUS[0]) * warmth;
      const moved = last ? Math.hypot((pointer.x - last.x) * aspect, pointer.y - last.y) : 0;
      if (pointer.pressed) glass.heat.lift();
      if (pointer.down) {
        glass.heat.stroke(pointer.x, pointer.y, radius, Math.min(1, dt * 40) * (0.55 + 0.45 * warmth), aspect);
      } else if (moved > 1e-3) {
        // Warmth in proportion to the distance moved, so passing over the glass leaves it below
        // the melting point however slowly the pointer goes; rubbing back and forth does melt it.
        glass.heat.stroke(pointer.x, pointer.y, radius * 1.25, 0.22 * Math.min(1, moved / radius), aspect);
      }
      last = { x: pointer.x, y: pointer.y };
    };

    /** The Manifold M: a fingertip writes it in the frost on "now", and now and then while on. */
    const trace = (frame: SimFrame, glass: MeltField): void => {
      const size = frame.values[at.mark] ?? 0;
      const fired = frame.triggers[0] ?? -1e4;
      if (lastTrigger !== undefined && fired !== lastTrigger && fired > -1e3) {
        // "now": start over, even halfway through a tracing.
        glass.finger.lift();
        traceStart = frame.time;
      }
      lastTrigger = fired;
      if (size <= 0) nextTrace = undefined;
      else if (traceStart === undefined && clock >= MARK_FIRST && (nextTrace === undefined || frame.time >= nextTrace)) traceStart = frame.time;
      if (traceStart === undefined) return;
      const elapsed = frame.time - traceStart;
      if (elapsed < 0) {
        traceStart = undefined;
        glass.finger.lift();
        return;
      }
      if (elapsed === 0 || frame.dt > 0) {
        if (elapsed === 0) traceSize = 0.24 + 0.32 * (size > 0 ? size : 0.5);
        const point = markPoint(elapsed);
        if (!point) {
          traceStart = undefined;
          glass.finger.lift();
          nextTrace = frame.time + MARK_REPEAT;
          return;
        }
        const x = 0.5 + (point[0] * traceSize) / frame.aspect;
        const y = 0.52 + point[1] * traceSize;
        glass.finger.stroke(x, y, traceSize * 0.085, 0.85, frame.aspect);
      }
    };

    return {
      frame(frame) {
        const { aspect } = frame;
        if (!(aspect > 0) || !Number.isFinite(aspect)) return [field ? growthTexture.texture : undefined, melt ? meltTexture.texture : undefined, clockTexture.texture];

        // A new pattern frosts over from scratch; a new frame shape regrows the same pattern.
        const seed = Math.round(frame.values[at.pattern] ?? 0);
        if (pattern !== undefined && seed !== pattern) clock = 0;
        pattern = seed;
        const size = growthSize(aspect);
        const key = `${seed}|${size.width}x${size.height}`;
        if (key !== jobKey) {
          jobKey = key;
          job = growFrost(seed, size.width, size.height);
        }
        if (job) {
          const until = performance.now() + (field ? GROWTH_BUDGET_MS : FIRST_GROWTH_BUDGET_MS);
          for (;;) {
            const step = job.next();
            if (step.done) {
              field = step.value;
              job = undefined;
              growthTexture.resize(field.width, field.height);
              growthTexture.upload(field.data);
              break;
            }
            if (performance.now() >= until) break;
          }
        }

        // The growth clock: paced by the speed knob and the lab's motion, held once all is frosted.
        clock += frame.dt * frame.motion * (frame.values[at.speed] ?? 1);
        if (field) clock = Math.min(clock, field.latest + field.reach * furSlowness(frame.values[at.style] ?? 0.35) + FUR_RIPEN + 5);
        clock = Math.min(clock, 60000);
        if (clock !== uploadedClock) {
          clockData[0] = clock;
          clockTexture.upload(clockData);
          uploadedClock = clock;
        }

        const meltWidth = Math.ceil(size.width / 2);
        const meltHeight = Math.ceil(size.height / 2);
        if (!melt || melt.width !== meltWidth || melt.height !== meltHeight) {
          melt = new MeltField(meltWidth, meltHeight);
          meltTexture.resize(meltWidth, meltHeight);
          meltTexture.upload(melt.bytes);
          last = undefined;
        }
        touch(frame, melt);
        trace(frame, melt);
        if (melt.step(frame.dt, frame.dt * frame.motion)) meltTexture.upload(melt.bytes);

        return [field ? growthTexture.texture : undefined, meltTexture.texture, clockTexture.texture];
      },
      dispose() {
        growthTexture.dispose();
        meltTexture.dispose();
        clockTexture.dispose();
        job = undefined;
      },
    };
  };
}
