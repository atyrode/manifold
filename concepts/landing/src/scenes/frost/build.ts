// Frost's growth (sim.ts's header: "Growth", "First frost", "Resize") as a build (sims/build.ts),
// on the build worker: the branches grown for a pattern on a texel grid, then the crystal fields
// laid from them, a quick half-resolution one first. The page's sim (sim.ts) shows the fields as
// they land and melts them.
import type { BuildKind } from "../../sims/build.ts";
import { smoothstep } from "../../sims/math.ts";
import { Random } from "../../sims/random.ts";

/** Width of the window frame round the screen, in frame heights; the glass starts inside it. */
export const FROST_FRAME = 0.035;
/** uSim3 scales: fur lag in frame heights × FUR_SCALE; half-width in units of WIDTH_SCALE. */
export const FUR_SCALE = 4;
export const WIDTH_SCALE = 0.004;
/** The quick first field has this fraction of the full field's resolution, across and up. */
const COARSE_DIVISOR = 2;

/** Growth-clock seconds per lockstep round of the dendrite growth, and texels per tip step. */
const ROUND = 0.5;
const STEP = 0.7;
/** The growth clock the lockstep rounds start from: the oldest stems predate the pane's opening. */
const GROWTH_FROM = -16;
/** Main stems grow this many frame heights per growth-clock second. */
const STEM_SPEED = 0.011;
/** Shortest branch worth growing, in frame heights. */
const MIN_BRANCH = 0.01;
/**
 * The frost front, which new fronds nucleate behind as it creeps in from the edges: the growth
 * second it leaves the bottom, the sides and the top, and frame heights per growth second it
 * advances from each. At the default motion (0.6) the pane is largely covered within two to three
 * minutes and fully frosted in about four.
 */
const FRONT = { bottom: [-4, 0.0055], side: [6, 0.0055], top: [14, 0.0045] } as const;
/** Growth seconds over which the fronts from two edges blend, so corners frost first. */
const FRONT_BLEND = 5;
/**
 * Growth seconds after the first front to reach a site past which a later one no longer counts (its
 * weight would be under 0.3%), so a front never reaches across the pane: moving one edge leaves the
 * sites on the far half as they were.
 */
const FRONT_REACH = 6 * FRONT_BLEND;
/**
 * Where frost nucleates. Each site belongs to the nearer half of the pane and is counted in from
 * that half's edge (left or right) at a fixed spacing in frame heights, with random draws of its own
 * (siteSeed): a big frond every BOTTOM_SPACING along the bottom and TOP_SPACING along the top, a
 * scratch every SCRATCH_SPACING from SCRATCH_INSET in, a nucleus behind the front every
 * NUCLEUS_SPACING. A resize moves each half's sites with its own edge and leaves them as they were;
 * only down the middle, where the halves meet, do fronds meet new neighbours.
 */
const BOTTOM_SPACING = 0.12;
const TOP_SPACING = 0.25;
const SCRATCH_INSET = 0.25;
const SCRATCH_SPACING = 0.5;
const NUCLEUS_SPACING = 0.07;
/** The kinds of site, for their seeds. */
const SITE = { scratch: 1, bottom: 2, corner: 3, side: 4, top: 5, nucleus: 6 } as const;

interface Level {
  /** Half-width at its root, frame heights; it tapers to 55% of that at its tip. */
  width: number;
  /** Distance between side-branch sites along the branch, in frame heights (0: none). */
  spacing: number;
  /** Length of its side branches, relative to its own. */
  ratio: number;
  /** Brightness of the line: thick stems scatter more light. */
  bright: number;
  /** How far it meanders, radians: stems curve, the finest branches grow straight. */
  wobble: number;
  /** How far its barbs (drawn by the shader) reach, frame heights, before tapering to its tip. */
  barbs: number;
}

/** Per depth of branching: 0 the stem, 1 its side branches, 2 their twigs; barbs on all three. */
const LEVELS: readonly [Level, Level, Level] = [
  { width: 0.003, spacing: 0.018, ratio: 0.32, bright: 1, wobble: 0.3, barbs: 0.007 },
  { width: 0.0016, spacing: 0.016, ratio: 0.38, bright: 0.85, wobble: 0.1, barbs: 0.014 },
  { width: 0.0011, spacing: 0, ratio: 0, bright: 0.72, wobble: 0.05, barbs: 0.009 },
];

/** A lattice hash to 0..1, after the murmur3 finaliser. */
export function hash(x: number, y: number, salt: number): number {
  let h =
    Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(salt | 0, 0x9e3779b1);
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

export interface Size {
  width: number;
  height: number;
}

/** `seed` with `value` folded in, through the murmur3 finaliser. */
function fold(seed: number, value: number): number {
  let h = seed ^ Math.imul(value | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return h ^ (h >>> 16);
}

/**
 * The seed of a site's draws: its pattern, its kind (SITE), its side or corner, and its place
 * counted in from there. Each branch from the site draws its own seed from the site's draws, and
 * each side branch from its parent's.
 */
function siteSeed(pattern: number, kind: number, side: number, index: number): number {
  return fold(fold(fold(fold(0x5bd1e995, pattern), kind), side), index);
}

/** Offsets of a skeleton point's fields in Skeleton.data. */
const P_X = 0;
const P_Y = 1;
const P_DX = 2;
const P_DY = 3;
const P_T = 4;
const P_ALONG = 5;
const P_BARBS = 6;
const P_WIDTH = 7;
const P_BRIGHT = 8;
const P_KIN = 9;
const P_ENDS = 10;
const STRIDE = 11;
/** P_ENDS flags: the point is its branch's root or its tip, past which its line must not run on. */
const ROOT = 1;
const TIP = 2;

/**
 * The grown branches as points along them: position (frame heights, from the bottom left of the
 * glass), heading (unit vector), arrival (growth seconds), distance from the branch's root (frame
 * heights), barb reach, half-width, brightness, the branch's random number and its end flags.
 */
class Skeleton {
  data = new Float32Array(STRIDE * 16384);
  count = 0;
  /** Latest arrival of any point. */
  latest = 0;
  /** Width / height of the glass it grew on. */
  readonly span: number;

  constructor(span: number) {
    this.span = span;
  }

  add(
    x: number,
    y: number,
    dx: number,
    dy: number,
    t: number,
    along: number,
    barbs: number,
    width: number,
    bright: number,
    kin: number,
  ): number {
    if ((this.count + 1) * STRIDE > this.data.length) {
      const grown = new Float32Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    const d = this.data;
    const o = this.count * STRIDE;
    d[o + P_X] = x;
    d[o + P_Y] = y;
    d[o + P_DX] = dx;
    d[o + P_DY] = dy;
    d[o + P_T] = t;
    d[o + P_ALONG] = along;
    d[o + P_BARBS] = barbs;
    d[o + P_WIDTH] = width;
    d[o + P_BRIGHT] = bright;
    d[o + P_KIN] = kin;
    d[o + P_ENDS] = 0;
    this.latest = Math.max(this.latest, t);
    return this.count++;
  }

  mark(index: number, end: number): void {
    const o = index * STRIDE + P_ENDS;
    this.data[o] = (this.data[o] ?? 0) | end;
  }
}

export interface GrowthField {
  width: number;
  height: number;
  /** rgba16f texels for uSim0 and rgba8 texels for uSim3, rows bottom to top (see the header). */
  data: Float32Array;
  detail: Uint8Array;
  /** Latest arrival of any crystal branch, and the longest fur lag (frame heights). */
  latest: number;
  reach: number;
}

/** A growing branch tip. */
interface Tip {
  id: number;
  /** The branch it grew from and that branch's parent: running into them is no collision. */
  parent: number;
  grand: number;
  level: number;
  spec: Level;
  /** Texels. */
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
  /** A random number of its own (uSim3 a). */
  kin: number;
  /** Its own draws, and their seed: its meander, its side branches and theirs. */
  seed: number;
  rand: Random;
  /** Its latest point in the skeleton; -1 before the first. */
  last: number;
  /** A nucleus behind the frost front: it only sprouts if the glass just ahead is still clear. */
  probe: boolean;
  alive: boolean;
}

/**
 * Grow the branches for one pattern on a width × height texel grid (one frame height = height
 * texels), yielding after every lockstep round. Deterministic for a seed and size. Every site
 * (scratch, frond, nucleus) draws from a stream of its own, seeded by where it is, and every branch
 * from one of its own, seeded by its parent's: a branch grows the same whatever changes elsewhere on
 * the pane, until it runs into something new.
 */
function* growSkeleton(
  pattern: number,
  width: number,
  height: number,
): Generator<undefined, Skeleton, undefined> {
  const unit = height;
  const frame = FROST_FRAME * unit;
  const half = width / 2;
  const skeleton = new Skeleton(width / height);
  // Which branch first claimed each texel (a plus round every point, so tips cannot slip between
  // the diagonal texels of another line): tips stop when they run into someone else's ice.
  const owner = new Int32Array(width * height).fill(-1);

  const claim = (px: number, py: number, id: number): void => {
    if (px < 0 || py < 0 || px >= width || py >= height) return;
    const k = py * width + px;
    if ((owner[k] ?? 0) < 0) owner[k] = id;
  };
  /** Record a point of branch `id` at texel coordinates (x, y), and claim the texels round it. */
  const plant = (
    x: number,
    y: number,
    dx: number,
    dy: number,
    t: number,
    along: number,
    barbs: number,
    w: number,
    bright: number,
    kin: number,
    id: number,
  ): number => {
    const px = Math.floor(x);
    const py = Math.floor(y);
    claim(px, py, id);
    claim(px - 1, py, id);
    claim(px + 1, py, id);
    claim(px, py - 1, id);
    claim(px, py + 1, id);
    return skeleton.add(x / unit, y / unit, dx, dy, t, along / unit, barbs, w, bright, kin);
  };
  /**
   * The x of a site `inset` texels in from the left (side 0) or the right (side 1) edge; undefined
   * past the middle, where the other half's sites are.
   */
  const inHalf = (side: number, inset: number): number | undefined =>
    inset >= half ? undefined : side === 0 ? inset : width - inset;

  const tips: Tip[] = [];
  let nextId = 0;
  /** A new branch tip, its own draws seeded from `from`: its site's draws, or its parent's. */
  const sprout = (
    x: number,
    y: number,
    angle: number,
    length: number,
    start: number,
    level: number,
    parent: Tip | undefined,
    origin: number,
    from: Random,
    probe = false,
  ): void => {
    const spec = LEVELS[level];
    if (!spec) return;
    const id = nextId++;
    const seed = from.int(4294967296) | 0;
    const rand = new Random(seed);
    const spacing = Math.max(2, spec.spacing * unit);
    const grace = parent ? 2.5 + parent.spec.width * unit * 2 : 5;
    tips.push({
      id,
      parent: parent ? parent.id : origin,
      grand: parent ? parent.parent : -1,
      level,
      spec,
      x,
      y,
      angle,
      heading: angle,
      length,
      walked: 0,
      start,
      speed: parent ? parent.speed * 0.8 : STEM_SPEED * unit,
      curl: parent
        ? parent.curl * 0.4 + (rand.next() - 0.5) * (0.3 / length)
        : (rand.next() - 0.5) * (2.2 / length),
      wobble: spec.wobble,
      grace,
      nextSprout: grace + spacing * rand.range(0.4, 0.8),
      side: rand.next() < 0.5 ? 1 : -1,
      paired: level === 0 ? rand.next() < 0.5 : level === 1 ? rand.next() < 0.65 : false,
      kin: rand.next(),
      seed,
      rand,
      last: -1,
      probe,
      alive: true,
    });
  };
  const stop = (tip: Tip): void => {
    tip.alive = false;
    if (tip.last >= 0) skeleton.mark(tip.last, TIP);
  };

  // Scratches: short lines of frost that nucleate later, each sending a few stems out sideways.
  for (const side of [0, 1]) {
    for (let i = 0; (SCRATCH_INSET + i * SCRATCH_SPACING) * unit < half; i++) {
      const rand = new Random(siteSeed(pattern, SITE.scratch, side, i));
      const cx = inHalf(side, (SCRATCH_INSET + (i + rand.next()) * SCRATCH_SPACING) * unit);
      if (cx === undefined) continue;
      const id = nextId++;
      const cy = rand.range(0.25, 0.8) * height;
      const length = rand.range(0.05, 0.14) * unit;
      const angle = rand.next() * Math.PI;
      const bend = (rand.next() - 0.5) * 0.8;
      const t = rand.range(16, 40);
      const kin = rand.next();
      const points: { x: number; y: number; heading: number }[] = [];
      let last = -1;
      for (let s = -length / 2; s <= length / 2; s += STEP) {
        const heading = angle + Math.atan((2 * bend * s) / length);
        const x =
          cx + Math.cos(angle) * s + (Math.cos(angle + Math.PI / 2) * bend * (s * s)) / length;
        const y =
          cy + Math.sin(angle) * s + (Math.sin(angle + Math.PI / 2) * bend * (s * s)) / length;
        const index = plant(
          x,
          y,
          Math.cos(heading),
          Math.sin(heading),
          t + Math.abs(s) * 0.02,
          s + length / 2,
          0.004,
          0.0012,
          0.6,
          kin,
          id,
        );
        if (last < 0) skeleton.mark(index, ROOT);
        last = index;
        points.push({ x, y, heading });
      }
      if (last >= 0) skeleton.mark(last, TIP);
      const stems = 3 + rand.int(2);
      for (let j = 0; j < stems; j++) {
        const at = points[rand.int(points.length)];
        if (!at) continue;
        const out =
          at.heading + (rand.next() < 0.5 ? 1 : -1) * (Math.PI / 2 + (rand.next() - 0.5) * 1.2);
        sprout(
          at.x,
          at.y,
          out,
          rand.range(0.12, 0.3) * unit,
          t + rand.range(0.5, 3.5),
          0,
          undefined,
          id,
          rand,
        );
      }
    }
  }

  // Big fronds from every edge: up from the bottom, fanning, and out of the corners, all frosting
  // before the pane opens (FROST_START); in from the sides and down from the top soon after.
  for (const side of [0, 1]) {
    for (let i = 0; frame + i * BOTTOM_SPACING * unit < half; i++) {
      const rand = new Random(siteSeed(pattern, SITE.bottom, side, i));
      const x = inHalf(side, frame + (i + rand.range(0.2, 0.8)) * BOTTOM_SPACING * unit);
      if (x === undefined) continue;
      sprout(
        x,
        frame + 1,
        Math.PI / 2 + (rand.next() - 0.5) * 1.7,
        rand.range(0.25, 0.45) * unit,
        rand.range(-14, 8),
        0,
        undefined,
        -1,
        rand,
      );
    }
  }
  for (const [corner, x, y, toward, start] of [
    [0, frame + 1, frame + 1, 0, -12],
    [1, width - frame - 1, frame + 1, Math.PI, -12],
    [2, frame + 1, height - frame - 1, 0, 0],
    [3, width - frame - 1, height - frame - 1, Math.PI, 0],
  ] as const) {
    const up = y < height / 2 ? 1 : -1;
    for (let j = 0; j < 3; j++) {
      const rand = new Random(siteSeed(pattern, SITE.corner, corner, j));
      const tilt = rand.range(0.3, 1.25) * up;
      const angle = toward === 0 ? tilt : Math.PI - tilt;
      const length = (up > 0 ? rand.range(0.3, 0.45) : rand.range(0.22, 0.35)) * unit;
      sprout(x, y, angle, length, start + rand.range(0, 12), 0, undefined, -1, rand);
    }
  }
  for (const [side, x, inward] of [
    [0, frame + 1, 0],
    [1, width - frame - 1, Math.PI],
  ] as const) {
    for (let j = 0; j < 3; j++) {
      const rand = new Random(siteSeed(pattern, SITE.side, side, j));
      sprout(
        x,
        ((j + rand.range(0.2, 0.8)) / 3) * (height - 2 * frame) + frame,
        inward + (rand.next() - 0.5) * 1.2,
        rand.range(0.18, 0.3) * unit,
        rand.range(2, 24),
        0,
        undefined,
        -1,
        rand,
      );
    }
  }
  for (const side of [0, 1]) {
    for (let i = 0; frame + i * TOP_SPACING * unit < half; i++) {
      const rand = new Random(siteSeed(pattern, SITE.top, side, i));
      const x = inHalf(side, frame + (i + rand.range(0.2, 0.8)) * TOP_SPACING * unit);
      if (x === undefined) continue;
      sprout(
        x,
        height - frame - 1,
        -Math.PI / 2 + (rand.next() - 0.5) * 1.2,
        rand.range(0.12, 0.25) * unit,
        rand.range(14, 34),
        0,
        undefined,
        -1,
        rand,
      );
    }
  }

  // Nuclei behind the frost front: as the front creeps in from the edges, fronds sprout from the
  // frost it has reached and grow on into whatever clear glass is left, so the pane keeps frosting
  // over long after the big fronds have run into one another.
  const span = width / unit;
  const rows = Math.max(1, Math.round((1 - 2 * FROST_FRAME) / NUCLEUS_SPACING));
  for (const side of [0, 1]) {
    for (let i = 0; (FROST_FRAME + i * NUCLEUS_SPACING) * unit < half; i++) {
      for (let j = 0; j < rows; j++) {
        const rand = new Random(siteSeed(pattern, SITE.nucleus, side, i * rows + j));
        const x = inHalf(
          side,
          (FROST_FRAME + (i + rand.range(0.15, 0.85)) * NUCLEUS_SPACING) * unit,
        );
        if (x === undefined) continue;
        const fx = x / unit;
        const fy = FROST_FRAME + ((j + rand.range(0.15, 0.85)) / rows) * (1 - 2 * FROST_FRAME);
        // Each edge's front reaches here at its own time; blended, the earliest wins, corners come
        // sooner still, and the frond heads the way the frost is creeping.
        const fronts = [
          [FRONT.bottom[0] + (fy - FROST_FRAME) / FRONT.bottom[1], 0, 1],
          [FRONT.side[0] + (fx - FROST_FRAME) / FRONT.side[1], 1, 0],
          [FRONT.side[0] + (span - FROST_FRAME - fx) / FRONT.side[1], -1, 0],
          [FRONT.top[0] + (1 - FROST_FRAME - fy) / FRONT.top[1], 0, -1],
        ] as const;
        const first = Math.min(...fronts.map((front) => front[0]));
        let weight = 0;
        let dx = 0;
        let dy = 0;
        for (const [t, ux, uy] of fronts) {
          if (t - first > FRONT_REACH) continue;
          const w = Math.exp((first - t) / FRONT_BLEND);
          weight += w;
          dx += w * ux;
          dy += w * uy;
        }
        const arrival = first - FRONT_BLEND * Math.log(weight);
        sprout(
          x,
          fy * unit,
          Math.atan2(dy, dx) + (rand.next() - 0.5) * 1.2,
          rand.range(0.1, 0.24) * unit,
          arrival + rand.range(-3, 3),
          0,
          undefined,
          -1,
          rand,
          true,
        );
      }
    }
  }

  // Grow every tip together, ROUND growth-seconds at a time, so whichever ice is older really was
  // there first when a younger tip runs into it.
  let active: Tip[] = tips.splice(0);
  for (let clock = GROWTH_FROM; active.length > 0 && clock < 900; clock += ROUND) {
    for (const tip of active) {
      if (tip.start > clock) continue;
      if (tip.probe) {
        // A nucleus sprouts only toward clear glass: where frost already lies just ahead, it never starts.
        tip.probe = false;
        const ahead = tip.grace + 3;
        const px = Math.floor(tip.x + Math.cos(tip.angle) * ahead);
        const py = Math.floor(tip.y + Math.sin(tip.angle) * ahead);
        if (
          px < 0 ||
          py < 0 ||
          px >= width ||
          py >= height ||
          (owner[py * width + px] ?? -1) >= 0
        ) {
          tip.alive = false;
          continue;
        }
      }
      const spec = tip.spec;
      const target = Math.min(tip.length, (clock - tip.start) * tip.speed);
      while (tip.alive && tip.walked + STEP <= target) {
        tip.walked += STEP;
        const s = tip.walked;
        const f = s / tip.length;
        tip.heading =
          tip.angle + tip.curl * s + tip.wobble * 2 * (noise(s / (0.05 * unit), tip.seed, 5) - 0.5);
        const dx = Math.cos(tip.heading);
        const dy = Math.sin(tip.heading);
        tip.x += dx * STEP;
        tip.y += dy * STEP;
        if (tip.x < frame || tip.x > width - frame || tip.y < frame || tip.y > height - frame) {
          stop(tip);
          break;
        }
        if (s > tip.grace) {
          const ahead = spec.width * unit + 1;
          const px = Math.floor(tip.x + dx * ahead);
          const py = Math.floor(tip.y + dy * ahead);
          if (px >= 0 && py >= 0 && px < width && py < height) {
            const other = owner[py * width + px] ?? -1;
            if (other >= 0 && other !== tip.id && other !== tip.parent && other !== tip.grand) {
              stop(tip);
              break;
            }
          }
        }
        const arrival = tip.start + s / tip.speed;
        // Barbs longest a little way out from the root, shortening to nothing at the tip.
        const barbs = spec.barbs * Math.sqrt(1 - f) * (0.5 + 0.5 * Math.min(1, f / 0.12));
        const index = plant(
          tip.x,
          tip.y,
          dx,
          dy,
          arrival,
          s,
          barbs,
          spec.width * (1 - 0.45 * f),
          spec.bright,
          tip.kin,
          tip.id,
        );
        if (tip.last < 0) skeleton.mark(index, ROOT);
        tip.last = index;
        // Side branches: longest a little way up the branch, shortening toward its tip, as on a
        // fern frond; each starts a moment after the tip has passed.
        if (spec.ratio > 0 && s >= tip.nextSprout) {
          const envelope = Math.pow(1 - f, 0.75) * (0.55 + 0.45 * Math.min(1, f / 0.15));
          const sides = tip.paired ? [1, -1] : [tip.side];
          tip.side = -tip.side;
          for (const side of sides) {
            const length = tip.length * spec.ratio * envelope * tip.rand.range(0.7, 1.3);
            if (length < MIN_BRANCH * unit) continue;
            const angle = tip.heading + side * (Math.PI / 3 + (tip.rand.next() - 0.5) * 0.14);
            const start = arrival + tip.rand.range(0.3, 1.3);
            sprout(tip.x, tip.y, angle, length, start, tip.level + 1, tip, -1, tip.rand);
          }
          tip.nextSprout = s + Math.max(2, spec.spacing * unit) * tip.rand.range(0.75, 1.25);
        }
      }
      if (tip.alive && tip.walked + STEP > tip.length) stop(tip);
    }
    active = active.filter((tip) => tip.alive).concat(tips.splice(0));
    yield;
  }
  for (const tip of active) if (tip.alive) stop(tip);
  return skeleton;
}

/**
 * Fill a width × height crystal field from the skeleton, yielding every few rows. Every texel
 * takes the nearest skeleton point and measures itself against that point's branch: across it
 * (signed), along it, and past its root or tip, where the line ends.
 */
function* rasterize(
  skeleton: Skeleton,
  width: number,
  height: number,
): Generator<undefined, GrowthField, undefined> {
  const count = width * height;
  const points = skeleton.data;
  // Texel centres in frame heights.
  const colX = new Float32Array(width);
  const rowY = new Float32Array(height);
  for (let x = 0; x < width; x++) colX[x] = ((x + 0.5) / width) * skeleton.span;
  for (let y = 0; y < height; y++) rowY[y] = (y + 0.5) / height;

  // Seeds: every texel keeps the skeleton point nearest its centre, of those inside it.
  const nearest = new Int32Array(count).fill(-1);
  const best = new Float32Array(count).fill(Infinity);
  for (let i = 0; i < skeleton.count; i++) {
    const o = i * STRIDE;
    const x = points[o + P_X] ?? 0;
    const y = points[o + P_Y] ?? 0;
    const px = Math.floor((x / skeleton.span) * width);
    const py = Math.floor(y * height);
    if (px < 0 || py < 0 || px >= width || py >= height) continue;
    const k = py * width + px;
    const dx = (colX[px] ?? 0) - x;
    const dy = (rowY[py] ?? 0) - y;
    const d = dx * dx + dy * dy;
    if (d < (best[k] ?? Infinity)) {
      best[k] = d;
      nearest[k] = i;
    }
  }

  // Seeds propagate forward then backward over the grid, each texel keeping whichever
  // neighbour's seed lies closer.
  const offer = (k: number, x: number, y: number, from: number): void => {
    const s = nearest[from] ?? -1;
    if (s < 0) return;
    const o = s * STRIDE;
    const dx = (colX[x] ?? 0) - (points[o + P_X] ?? 0);
    const dy = (rowY[y] ?? 0) - (points[o + P_Y] ?? 0);
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
    if (y % 24 === 23) yield;
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
    if (y % 24 === 0) yield;
  }

  // Pack the texels. Distances come from the branch's tangent line at the nearest point, which
  // is smooth where the points' own distances would bead; never nearer than the point allows
  // though (less a texel and a half), where a crossing branch took the texels between points.
  const data = new Float32Array(count * 4);
  const detail = new Uint8Array(count * 4);
  const slack = 1.5 / height;
  let reach = 0;
  for (let y = 0; y < height; y++) {
    const cy = rowY[y] ?? 0;
    const cold = 0.6 + 0.4 * smoothstep(0, 0.5, cy);
    for (let x = 0; x < width; x++) {
      const k = y * width + x;
      const q = k * 4;
      const s = nearest[k] ?? -1;
      if (s < 0) {
        data[q] = 1e4;
        data[q + 1] = 1;
        detail[q] = 255;
        continue;
      }
      const cx = colX[x] ?? 0;
      const o = s * STRIDE;
      const ox = cx - (points[o + P_X] ?? 0);
      const oy = cy - (points[o + P_Y] ?? 0);
      const dx = points[o + P_DX] ?? 1;
      const dy = points[o + P_DY] ?? 0;
      const along = ox * dx + oy * dy;
      const side = oy * dx - ox * dy;
      const ends = points[o + P_ENDS] ?? 0;
      const past =
        (ends & TIP) !== 0 && along > 0 ? along : (ends & ROOT) !== 0 && along < 0 ? along : 0;
      const dist = Math.max(
        Math.sqrt(side * side + past * past),
        Math.sqrt(ox * ox + oy * oy) - slack,
      );
      data[q] = points[o + P_T] ?? 0;
      data[q + 1] = side < 0 ? -dist : dist;
      data[q + 2] = (points[o + P_ALONG] ?? 0) + along;
      data[q + 3] = points[o + P_BARBS] ?? 0;
      // The fur's distance, roughened so it fills in by irregular, crystalline fronts, and
      // shortened low on the pane, where the glass is coldest.
      const rough =
        0.55 +
        0.9 * (0.6 * noise(cx / 0.05, cy / 0.05, 21) + 0.4 * noise(cx / 0.018, cy / 0.018, 22));
      const lag = Math.min(1 / FUR_SCALE, dist * rough * cold);
      detail[q] = Math.round(lag * FUR_SCALE * 255);
      detail[q + 1] = Math.round(Math.min(1, (points[o + P_WIDTH] ?? 0) / WIDTH_SCALE) * 255);
      detail[q + 2] = Math.round((points[o + P_BRIGHT] ?? 0) * 255);
      detail[q + 3] = Math.round((points[o + P_KIN] ?? 0) * 255);
      reach = Math.max(reach, lag);
    }
    if (y % 24 === 23) yield;
  }
  return { width, height, data, detail, latest: skeleton.latest, reach };
}

/**
 * The crystal field for one pattern and frame shape: the branches, then a quick half-resolution
 * field (yielded) when `quick`, then the full one (returned). Yields undefined between slices of
 * work.
 */
function* growFrost(
  pattern: number,
  size: Size,
  quick: boolean,
): Generator<GrowthField | undefined, GrowthField, undefined> {
  const skeleton = yield* growSkeleton(pattern, size.width, size.height);
  if (quick)
    yield yield* rasterize(
      skeleton,
      Math.max(16, Math.round(size.width / COARSE_DIVISOR)),
      Math.max(16, Math.round(size.height / COARSE_DIVISOR)),
    );
  return yield* rasterize(skeleton, size.width, size.height);
}

/** A growth asked for: the pattern, the field's texel size, and whether a quick field comes first. */
export interface FrostRequest {
  readonly pattern: number;
  readonly size: Readonly<Size>;
  readonly quick: boolean;
}

/** The growth as a build (sims/build.ts): growFrost, its quick field landing as an early result. */
export const frostGrowth: BuildKind<FrostRequest, GrowthField> = {
  name: "frost",
  builder: () => ({
    build: ({ pattern, size, quick }) => growFrost(pattern, size, quick),
  }),
};
