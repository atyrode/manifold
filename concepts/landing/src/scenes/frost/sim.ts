// Frost on a window pane: the crystals that grow over the glass, and where warmth melted them.
//
// uSim0  crystals, rgba16f, about 512×288 texels (a half-resolution pass comes first), per
//        pattern seed and frame shape. Each texel describes the nearest crystal branch:
//          r  growth-clock seconds at which the branch reached its point nearest this texel
//          g  signed distance across the branch, frame heights (+ on its left). It is linear
//             across a branch, so linear filtering reproduces it exactly and the shader draws
//             crisp lines from a coarse texture; it jumps where two branches' fields meet, and the
//             shader spots those seams by how fast it changes there
//          b  distance along the branch from its root, frame heights: the phase of its barbs
//          a  how far its barbs reach here, frame heights: longest near its root, none at its tip
// uSim1  melt, rgba8 at half the crystal field's resolution, stepped every frame:
//          r  melt level (clear glass above MELT_CLEAR), g how recently the patch refroze,
//          b  warmth of the glass, a the M traced by the Manifold fingertip
// uSim2  clock, r16f 1×1: the growth clock in seconds
// uSim3  crystal detail, rgba8 at uSim0's resolution:
//          r  fur lag × FUR_SCALE: the distance to the nearest branch in frame heights, roughened
//             by noise and shortened low on the pane, where the glass is coldest. The fur frost
//             reaches a texel this much behind its branch, at a pace the shader takes from the
//             style knob
//          g  the branch's half-width / WIDTH_SCALE
//          b  its brightness: thick stems scatter more light than fine needles
//          a  a random number per branch, varying the lengths of its barbs
//
// Growth. Window frost grows as "fern frost": dendrites nucleate on the pane's edges, its coldest
// corners and scratches, then branch as they go. Ice is hexagonal, so side branches leave at ±60°
// and their own branches at ±60° again, every branch shorter than the one it grew from. All tips
// advance together on one clock, and a tip stops where it meets older ice: that competition is
// what packs real frost into feathered fronds rather than a tangle (see Libbrecht, "The physics
// of snow crystals", Rep. Prog. Phys. 68, 2005, on dendritic side-branching). Big fronds start
// from every edge; then, as a frost front creeps in from the edges, fronds nucleate behind it and
// grow on into the clear glass left between, so the pane keeps frosting over until it is covered.
// Three levels of branches grow here, as points every STEP texels; the shader adds the fourth,
// the dense short barbs that make each frond feathery, from the distances along and across its
// branch. The texel field is a nearest-point distance transform, the two-pass sequential
// propagation of Danielsson ("Euclidean distance mapping", CGIP 14, 1980); each texel then
// measures itself against the branch through its nearest point.
//
// First frost. The pane opens at FROST_START on the growth clock, frosted along every edge and
// heaviest along the bottom. The branches grow and a half-resolution field is filled in within
// the first frame; the full field follows over the next frames, on a budget that grows with the
// time between frames, so a slow machine, whose frames are far apart, refines it in seconds too.
// The growth clock itself runs on real time between frames, so a slow machine frosts over at the
// same pace.
//
// Melt. A TrailField records the pointer's warmth. Where it is warm enough the frost melts; once
// it cools, the meltwater refreezes from the cleared patch's edges inward (only texels next to
// frozen glass refreeze quickly), and the new frost there starts thin and thickens back.
import { KnobReader, type ParamDef } from "../../params.ts";
import { smoothstep } from "../../sims/math.ts";
import { mulberry32 } from "../../sims/random.ts";
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
export const FUR_SLOW_FERN = 1500;
export const FUR_SLOW_FUR = 100;
/** Seconds from the fur frost's arrival until it is at full thickness. */
export const FUR_RIPEN = 15;
/**
 * Growth-clock second the pane opens at, and starts over from with a new pattern: frost along
 * every edge, heaviest along the bottom and in its corners, the first fronds climbing from them.
 */
export const FROST_START = 18;
/** Growth-clock seconds by which the thick frost along the frame has reached its full depth. */
export const RIME_GROWN = 150;
/**
 * Seconds the scene's entrance and exit take (SceneDef.passage). Entrance: the glass opens clear
 * and the frost grows in from the frame (the growth clock is run up from FROST_EMERGE_FROM to the
 * opening state, FROST_START, in these seconds, quickly at first and settling). Exit: a warm breath
 * clears a small patch that spreads over the whole pane.
 */
export const FROST_PASSAGE: { enter: number; exit: number } = { enter: 2.8, exit: 1.6 };
/** Growth seconds the entrance starts behind the opening state; the clock is FROST_EMERGE_FROM then. */
const ENTER_LEAD = 34;
export const FROST_EMERGE_FROM = FROST_START - ENTER_LEAD;
/** Growth second by which the frame's rime and the condensation are fully formed (the shader's). */
export const FROST_EMERGE_TO = FROST_START - 0.3 * ENTER_LEAD;
/**
 * The breath: where on the pane it lands when the pointer is not on it (uv), the radius it starts
 * from (frame heights), how far it spreads as a multiple of the distance to the pane's farthest
 * corner (the cleared edge runs behind the warmth's reach), and the share of the exit it takes.
 */
const BREATH_AT = [0.46, 0.5] as const;
const BREATH_START = 0.05;
const BREATH_REACH = 1.7;
const BREATH_SPREAD = 0.8;
/** uSim3 scales: fur lag in frame heights × FUR_SCALE; half-width in units of WIDTH_SCALE. */
export const FUR_SCALE = 4;
export const WIDTH_SCALE = 0.004;

/** The growth clock's pace for a style knob value, as the shader computes it. */
export function furSlowness(style: number): number {
  return FUR_SLOW_FERN * Math.pow(FUR_SLOW_FUR / FUR_SLOW_FERN, style);
}

/** Texels in the crystal field, whatever the frame's shape (512×288 at 16:9). */
const GROWTH_TEXELS = 512 * 288;
/** The quick first field has this fraction of the full field's resolution, across and up. */
const COARSE_DIVISOR = 2;
/**
 * How the growth is spread over frames, counted in slices of work (a lockstep round of the branches,
 * or a few rows of the field), never in time, so the field on show after n frames does not depend on
 * the machine: until a pattern's first field is up, as many slices as that takes; after that
 * REFINE_SLICES a frame. The caps in milliseconds only bound how long one frame may block.
 */
const REFINE_SLICES = 8;
const FIRST_CAP_MS = 250;
const SLICE_CAP_MS = 50;
/**
 * Longest real time one frame may add to the growth clock, seconds. The clock runs on the time
 * between frames, not the scene clock, which the renderer holds to 0.1 s a frame: on a slow
 * machine the scene's motion slows, but the pane should still frost over in its few minutes.
 */
const MAX_FRAME_SECONDS = 1;

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
/** Spacing of the nucleation sites behind the front, frame heights. */
const NUCLEUS_SPACING = 0.07;

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
 * while the M is on, and the growth clock before the first, so there is frost to write in.
 */
const MARK_SPEED = 1.5;
const MARK_PAUSE = 0.15;
const MARK_REPEAT = 80;
const MARK_FIRST = FROST_START + 25;

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

interface Size {
  width: number;
  height: number;
}

/** Crystal field size for a frame shape: about GROWTH_TEXELS, rounded so small resizes reuse it. */
function growthSize(aspect: number): Size {
  const shape = Math.min(4, Math.max(0.25, Math.round(aspect * 50) / 50));
  const width = Math.max(16, Math.round(Math.sqrt(GROWTH_TEXELS * shape)));
  return { width, height: Math.max(16, Math.round(width / shape)) };
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

  add(x: number, y: number, dx: number, dy: number, t: number, along: number, barbs: number, width: number, bright: number, kin: number): number {
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

interface GrowthField {
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
  /** Its latest point in the skeleton; -1 before the first. */
  last: number;
  /** A nucleus behind the frost front: it only sprouts if the glass just ahead is still clear. */
  probe: boolean;
  alive: boolean;
}

/**
 * Grow the branches for one pattern on a width × height texel grid (one frame height = height
 * texels), yielding after every lockstep round. Deterministic for a seed and size.
 */
function* growSkeleton(pattern: number, width: number, height: number): Generator<undefined, Skeleton, undefined> {
  const unit = height;
  const frame = FROST_FRAME * unit;
  const rand = mulberry32(Math.imul(pattern + 1, 0x9e3779b1) ^ 0x5bd1e995);
  const range = (lo: number, hi: number): number => lo + (hi - lo) * rand();
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
  const plant = (x: number, y: number, dx: number, dy: number, t: number, along: number, barbs: number, w: number, bright: number, kin: number, id: number): number => {
    const px = Math.floor(x);
    const py = Math.floor(y);
    claim(px, py, id);
    claim(px - 1, py, id);
    claim(px + 1, py, id);
    claim(px, py - 1, id);
    claim(px, py + 1, id);
    return skeleton.add(x / unit, y / unit, dx, dy, t, along / unit, barbs, w, bright, kin);
  };

  const tips: Tip[] = [];
  let nextId = 0;
  const sprout = (x: number, y: number, angle: number, length: number, start: number, level: number, parent: Tip | undefined, origin: number, probe = false): void => {
    const spec = LEVELS[level];
    if (!spec) return;
    const id = nextId++;
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
      curl: parent ? parent.curl * 0.4 + (rand() - 0.5) * (0.3 / length) : (rand() - 0.5) * (2.2 / length),
      wobble: spec.wobble,
      grace,
      nextSprout: grace + spacing * range(0.4, 0.8),
      side: rand() < 0.5 ? 1 : -1,
      paired: level === 0 ? rand() < 0.5 : level === 1 ? rand() < 0.65 : false,
      kin: rand(),
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
  const scratches = 2 + Math.floor(rand() * 2);
  for (let i = 0; i < scratches; i++) {
    const id = nextId++;
    const cx = range(0.15, 0.85) * width;
    const cy = range(0.25, 0.8) * height;
    const length = range(0.05, 0.14) * unit;
    const angle = rand() * Math.PI;
    const bend = (rand() - 0.5) * 0.8;
    const t = range(16, 40);
    const kin = rand();
    const points: { x: number; y: number; heading: number }[] = [];
    let last = -1;
    for (let s = -length / 2; s <= length / 2; s += STEP) {
      const heading = angle + Math.atan((2 * bend * s) / length);
      const x = cx + Math.cos(angle) * s + Math.cos(angle + Math.PI / 2) * bend * (s * s) / length;
      const y = cy + Math.sin(angle) * s + Math.sin(angle + Math.PI / 2) * bend * (s * s) / length;
      const index = plant(x, y, Math.cos(heading), Math.sin(heading), t + Math.abs(s) * 0.02, s + length / 2, 0.004, 0.0012, 0.6, kin, id);
      if (last < 0) skeleton.mark(index, ROOT);
      last = index;
      points.push({ x, y, heading });
    }
    if (last >= 0) skeleton.mark(last, TIP);
    const stems = 3 + Math.floor(rand() * 2);
    for (let j = 0; j < stems; j++) {
      const at = points[Math.floor(rand() * points.length)];
      if (!at) continue;
      const out = at.heading + (rand() < 0.5 ? 1 : -1) * (Math.PI / 2 + (rand() - 0.5) * 1.2);
      sprout(at.x, at.y, out, range(0.12, 0.3) * unit, t + range(0.5, 3.5), 0, undefined, id);
    }
  }

  // Big fronds from every edge: up from the bottom, fanning, and out of the corners, all frosting
  // before the pane opens (FROST_START); in from the sides and down from the top soon after.
  const along = width - 2 * frame;
  const bottom = Math.max(2, Math.round(along / (0.12 * unit)));
  for (let i = 0; i < bottom; i++) {
    const x = frame + ((i + range(0.2, 0.8)) / bottom) * along;
    sprout(x, frame + 1, Math.PI / 2 + (rand() - 0.5) * 1.7, range(0.25, 0.45) * unit, range(-14, 8), 0, undefined, -1);
  }
  for (const [x, y, toward, start] of [
    [frame + 1, frame + 1, 0, -12],
    [width - frame - 1, frame + 1, Math.PI, -12],
    [frame + 1, height - frame - 1, 0, 0],
    [width - frame - 1, height - frame - 1, Math.PI, 0],
  ] as const) {
    const up = y < height / 2 ? 1 : -1;
    for (let j = 0; j < 3; j++) {
      const tilt = range(0.3, 1.25) * up;
      const angle = toward === 0 ? tilt : Math.PI - tilt;
      const length = (up > 0 ? range(0.3, 0.45) : range(0.22, 0.35)) * unit;
      sprout(x, y, angle, length, start + range(0, 12), 0, undefined, -1);
    }
  }
  for (const [x, inward] of [[frame + 1, 0], [width - frame - 1, Math.PI]] as const) {
    for (let j = 0; j < 3; j++) {
      sprout(x, ((j + range(0.2, 0.8)) / 3) * (height - 2 * frame) + frame, inward + (rand() - 0.5) * 1.2, range(0.18, 0.3) * unit, range(2, 24), 0, undefined, -1);
    }
  }
  const top = Math.max(1, Math.round(along / (0.25 * unit)));
  for (let i = 0; i < top; i++) {
    const x = frame + ((i + range(0.2, 0.8)) / top) * along;
    sprout(x, height - frame - 1, -Math.PI / 2 + (rand() - 0.5) * 1.2, range(0.12, 0.25) * unit, range(14, 34), 0, undefined, -1);
  }

  // Nuclei behind the frost front: as the front creeps in from the edges, fronds sprout from the
  // frost it has reached and grow on into whatever clear glass is left, so the pane keeps frosting
  // over long after the big fronds have run into one another.
  const span = width / unit;
  const columns = Math.max(1, Math.round((span - 2 * FROST_FRAME) / NUCLEUS_SPACING));
  const rows = Math.max(1, Math.round((1 - 2 * FROST_FRAME) / NUCLEUS_SPACING));
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < columns; i++) {
      const fx = FROST_FRAME + ((i + range(0.15, 0.85)) / columns) * (span - 2 * FROST_FRAME);
      const fy = FROST_FRAME + ((j + range(0.15, 0.85)) / rows) * (1 - 2 * FROST_FRAME);
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
        const w = Math.exp((first - t) / FRONT_BLEND);
        weight += w;
        dx += w * ux;
        dy += w * uy;
      }
      const arrival = first - FRONT_BLEND * Math.log(weight);
      sprout(fx * unit, fy * unit, Math.atan2(dy, dx) + (rand() - 0.5) * 1.2, range(0.1, 0.24) * unit, arrival + range(-3, 3), 0, undefined, -1, true);
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
        if (px < 0 || py < 0 || px >= width || py >= height || (owner[py * width + px] ?? -1) >= 0) {
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
        tip.heading = tip.angle + tip.curl * s + tip.wobble * 2 * (noise(s / (0.05 * unit), tip.id, 5) - 0.5);
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
        const index = plant(tip.x, tip.y, dx, dy, arrival, s, barbs, spec.width * (1 - 0.45 * f), spec.bright, tip.kin, tip.id);
        if (tip.last < 0) skeleton.mark(index, ROOT);
        tip.last = index;
        // Side branches: longest a little way up the branch, shortening toward its tip, as on a
        // fern frond; each starts a moment after the tip has passed.
        if (spec.ratio > 0 && s >= tip.nextSprout) {
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
function* rasterize(skeleton: Skeleton, width: number, height: number): Generator<undefined, GrowthField, undefined> {
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
      const past = (ends & TIP) !== 0 && along > 0 ? along : (ends & ROOT) !== 0 && along < 0 ? along : 0;
      const dist = Math.max(Math.sqrt(side * side + past * past), Math.sqrt(ox * ox + oy * oy) - slack);
      data[q] = points[o + P_T] ?? 0;
      data[q + 1] = side < 0 ? -dist : dist;
      data[q + 2] = (points[o + P_ALONG] ?? 0) + along;
      data[q + 3] = points[o + P_BARBS] ?? 0;
      // The fur's distance, roughened so it fills in by irregular, crystalline fronts, and
      // shortened low on the pane, where the glass is coldest.
      const rough = 0.55 + 0.9 * (0.6 * noise(cx / 0.05, cy / 0.05, 21) + 0.4 * noise(cx / 0.018, cy / 0.018, 22));
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
 * field (yielded), then the full one (returned). Yields undefined between slices of work.
 */
function* growFrost(pattern: number, size: Size): Generator<GrowthField | undefined, GrowthField, undefined> {
  const skeleton = yield* growSkeleton(pattern, size.width, size.height);
  yield yield* rasterize(skeleton, Math.max(16, Math.round(size.width / COARSE_DIVISOR)), Math.max(16, Math.round(size.height / COARSE_DIVISOR)));
  return yield* rasterize(skeleton, size.width, size.height);
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
 * The frost simulation. `params` are the scene's knobs, so it can read its own knobs from
 * `SimFrame.values` by key.
 */
export function frostSim(params: readonly ParamDef[]): SimFactory {
  const knobs = new KnobReader("frost", params, ["speed", "style", "pattern", "warmth", "mark"]);
  const markTrigger = knobs.trigger("mark");

  return (gl): SceneSim => {
    const growthTexture = new DataTexture(gl, { width: 1, height: 1, format: "rgba16f" });
    const meltTexture = new DataTexture(gl, { width: 1, height: 1, format: "rgba8" });
    const clockTexture = new DataTexture(gl, { width: 1, height: 1, format: "r16f", filter: "nearest" });
    const detailTexture = new DataTexture(gl, { width: 1, height: 1, format: "rgba8" });
    const clockData = new Float32Array(1);
    let field: GrowthField | undefined;
    let job: Generator<GrowthField | undefined, GrowthField, undefined> | undefined;
    let jobKey = "";
    /** The job key of the field on show: until it matches, the job races to its first field. */
    let shownKey = "";
    let lastFrame: number | undefined;
    let pattern: number | undefined;
    let clock = FROST_START;
    let uploadedClock = Number.NaN;
    let melt: MeltField | undefined;
    let hasLast = false;
    let lastX = 0;
    let lastY = 0;
    let traceStart: number | undefined;
    let traceSize = 0.4;
    let nextTrace: number | undefined;
    /** Whether the entrance is still on, and seconds of it gone since the first field was on show. */
    let arriving: boolean | undefined;
    let arrived = 0;
    /** Where the exit's breath landed. */
    let breath: { x: number; y: number } | undefined;

    const show = (next: GrowthField): void => {
      field = next;
      growthTexture.resize(next.width, next.height);
      growthTexture.upload(next.data);
      detailTexture.resize(next.width, next.height);
      detailTexture.upload(next.detail);
    };

    /** Warm the glass under the pointer: a held fingertip melts, a passing hand only breathes on it. */
    const touch = (frame: SimFrame, glass: MeltField): void => {
      const warmth = knobs.value(frame, "warmth");
      const { pointer, aspect, dt } = frame;
      if (warmth <= 0 || !pointer.inside || dt <= 0) {
        glass.heat.lift();
        hasLast = false;
        return;
      }
      const radius = TOUCH_RADIUS[0] + (TOUCH_RADIUS[1] - TOUCH_RADIUS[0]) * warmth;
      const moved = hasLast ? Math.hypot((pointer.x - lastX) * aspect, pointer.y - lastY) : 0;
      if (pointer.pressed) glass.heat.lift();
      if (pointer.down) {
        glass.heat.stroke(pointer.x, pointer.y, radius, Math.min(1, dt * 40) * (0.55 + 0.45 * warmth), aspect);
      } else if (moved > 1e-3) {
        // Warmth in proportion to the distance moved, so passing over the glass leaves it below
        // the melting point however slowly the pointer goes; rubbing back and forth does melt it.
        glass.heat.stroke(pointer.x, pointer.y, radius * 1.25, 0.22 * Math.min(1, moved / radius), aspect);
      }
      lastX = pointer.x;
      lastY = pointer.y;
      hasLast = true;
    };

    /** The Manifold M: a fingertip writes it in the frost on "now", and now and then while on. */
    const trace = (frame: SimFrame, glass: MeltField): void => {
      const size = knobs.value(frame, "mark");
      if (frame.fired[markTrigger]) {
        // "now": start over, even halfway through a tracing.
        glass.finger.lift();
        traceStart = frame.time;
      }
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

    /**
     * Growth seconds the shown clock is behind the real one: FROST_EMERGE_FROM's worth at the start
     * of the entrance, easing to exactly 0 over FROST_PASSAGE.enter seconds that begin once the first
     * field is up (so a slow first frame does not use the entrance up). 0 when not entered with a passage.
     */
    const enterLead = (frame: SimFrame): number => {
      if (arriving === undefined) arriving = frame.passage.enter < 1;
      if (!arriving) return 0;
      if (field) arrived += Math.max(0, frame.dt);
      const progress = arrived / FROST_PASSAGE.enter;
      if (progress >= 1) {
        arriving = false;
        return 0;
      }
      return ENTER_LEAD * (1 - progress) * (1 - progress);
    };

    /** The exit: a warm breath lands on the glass and its warmth spreads, melting the frost out of its way. */
    const breathe = (frame: SimFrame, glass: MeltField): void => {
      const { exit } = frame.passage;
      if (!(exit > 0)) {
        breath = undefined;
        return;
      }
      if (frame.dt <= 0) return;
      const { pointer, aspect } = frame;
      breath ??= pointer.inside ? { x: pointer.x, y: pointer.y } : { x: BREATH_AT[0], y: BREATH_AT[1] };
      const far = Math.hypot(Math.max(breath.x, 1 - breath.x) * aspect, Math.max(breath.y, 1 - breath.y));
      const radius = BREATH_START + (BREATH_REACH * far - BREATH_START) * smoothstep(0, 1, exit / BREATH_SPREAD);
      glass.heat.lift();
      glass.heat.stroke(breath.x, breath.y, radius, Math.min(1, frame.dt * 40) * 0.9, aspect);
      glass.heat.lift();
    };

    return {
      frame(frame) {
        const now = performance.now();
        const interval = lastFrame === undefined ? 16 : Math.min(1000, Math.max(0, now - lastFrame));
        lastFrame = now;
        const { aspect } = frame;
        if (!(aspect > 0) || !Number.isFinite(aspect)) {
          return [field ? growthTexture.texture : undefined, melt ? meltTexture.texture : undefined, clockTexture.texture, field ? detailTexture.texture : undefined];
        }

        // A new pattern frosts over afresh from the opening state; a new frame shape regrows it.
        const seed = Math.round(knobs.value(frame, "pattern"));
        if (pattern !== undefined && seed !== pattern) clock = FROST_START;
        pattern = seed;
        const size = growthSize(aspect);
        const key = `${seed}|${size.width}x${size.height}`;
        if (key !== jobKey) {
          jobKey = key;
          job = growFrost(seed, size);
        }
        if (job) {
          // Race to this pattern's first field, then refine a few slices a frame (REFINE_SLICES).
          const first = shownKey !== jobKey;
          const until = now + (first ? FIRST_CAP_MS : SLICE_CAP_MS);
          let slices = 0;
          for (;;) {
            const step = job.next();
            if (step.value) {
              show(step.value);
              shownKey = jobKey;
            }
            if (step.done) {
              job = undefined;
              break;
            }
            slices++;
            if (first ? step.value !== undefined : slices >= REFINE_SLICES) break;
            if (performance.now() >= until) break;
          }
        }

        // The growth clock: real time between frames while the scene runs (see MAX_FRAME_SECONDS),
        // paced by the speed knob and the lab's motion, held once all is frosted.
        const elapsed = frame.dt > 0 ? Math.max(frame.dt, Math.min(interval / 1000, MAX_FRAME_SECONDS)) : 0;
        clock += elapsed * frame.motion * knobs.value(frame, "speed");
        if (field) clock = Math.min(clock, Math.max(RIME_GROWN, field.latest + field.reach * furSlowness(knobs.value(frame, "style")) + FUR_RIPEN + 5));
        clock = Math.min(clock, 60000);
        const shown = clock - enterLead(frame);
        if (shown !== uploadedClock) {
          clockData[0] = shown;
          clockTexture.upload(clockData);
          uploadedClock = shown;
        }

        const meltWidth = Math.ceil(size.width / 2);
        const meltHeight = Math.ceil(size.height / 2);
        if (!melt || melt.width !== meltWidth || melt.height !== meltHeight) {
          melt = new MeltField(meltWidth, meltHeight);
          meltTexture.resize(meltWidth, meltHeight);
          meltTexture.upload(melt.bytes);
          hasLast = false;
        }
        touch(frame, melt);
        breathe(frame, melt);
        trace(frame, melt);
        if (melt.step(frame.dt, frame.dt * frame.motion)) meltTexture.upload(melt.bytes);

        return [field ? growthTexture.texture : undefined, meltTexture.texture, clockTexture.texture, field ? detailTexture.texture : undefined];
      },
      dispose() {
        growthTexture.dispose();
        meltTexture.dispose();
        clockTexture.dispose();
        detailTexture.dispose();
        job = undefined;
      },
    };
  };
}
