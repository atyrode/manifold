// The flow network (network.ts) drawn into the sim's fields, in trail texels:
//   - the sketch: trail as the mould lays it along its tubes, for the opening picture (and the
//     whole picture without float targets). Veins by Murray's law, their radius with the cube root of
//     what they carry, from thin veins to trunks; the lace where the mesh carries nothing, thicker
//     beside the veins; a fan of spokes round each flake; the crowd on the flakes.
//   - the film: the floor the live trail never falls below (DIFFUSE in passes.ts): the veins at the
//     strength of thin veins, the lace and the fans at half theirs, so the specks ride the network as
//     it adapts and the veins to an eaten flake fade as their tubes wither. The lace does not adapt:
//     it is drawn once per grid and light, and each redraw lays the veins and fans over it.
//   - the distance along the veins from the heart, which the streaming runs on;
//   - the specks, seeded along it all.
// A tube is drawn as a curve between its junctions: at each junction the two strongest tubes run on
// through it and the rest leave at an angle (Hermite tangents), each wandering a little off its
// curve; a junction a vein just passes through is drawn toward the middle of its two neighbours, so
// a vein runs smooth over the mesh's jitter. Each tube's wander is its own (hashed from its index),
// so the network redraws the same as it adapts.
import { clamp, smoothstep } from "../../sims/math.ts";
import type { SketchNode } from "./food.ts";
import {
  AGENT_UNIT,
  type Grid,
  item,
  LIFE,
  PHYSARUM_FAR,
  PhysarumError,
  REFERENCE_AGENTS,
  TAU,
} from "./grid.ts";
import type { FlowNetwork } from "./network.ts";

/** Conductivities over which a tube becomes a vein (log-spaced): thinner ones are mesh, or withering. */
const VEIN_LOW = 0.02;
const VEIN_HIGH = 0.15;
/** A vein's conductivity in the distance field: about half a vein. */
const VEIN_CUT = 0.05;
/** What a thin vein and a trunk carry (|Q|): Murray's law spreads the widths between them. */
const FLOW_THIN = 0.5;
const FLOW_TRUNK = 2;
/** A fan's level at the flake (sketch units), tapering to nothing at its far end. */
const FAN_LEVEL = 0.35;
/** The lace beside a vein thickens into feeders, by up to this share, to at most FEEDER_MAX. */
const FEEDER = 0.7;
const FEEDER_MAX = 0.36;
/** The film: veins from thin to trunk (× the trunk level); the lace and the fans at this share of their level. */
const FILM_THIN = 0.38;
const FILM_TRUNK = 0.6;
const FILM_LACE = 0.5;
/** The lace's profile width (texels). */
const LACE_SIGMA = 0.6;
/** Straightening passes over the veins' junctions. */
const STRAIGHTEN = 3;
/** How far a tube wanders off its curve (share of its length): veins, lace, fans. */
const WANDER_VEIN = 0.02;
const WANDER_LACE = 0.012;
const WANDER_FAN = 0.12;
/** Texels between the points a curve is drawn through, and the most points a tube takes. */
const CURVE_STEP = 6;
const CURVE_POINTS = 64;
/** Specks seeded along the tubes, along the fans and at the flakes; the rest anywhere on the dish. */
const SEED_TUBES = 0.6;
const SEED_FANS = 0.1;
const SEED_FLAKES = 0.12;

/** exp(-u) over the Gaussian's reach (u = d² / 2σ² up to 4.5, three widths out), by table. */
const GAUSS_SLOTS = 4096;
const GAUSS_REACH = 4.5;
const GAUSS = Float32Array.from({ length: GAUSS_SLOTS + 1 }, (_, i) =>
  Math.exp((-i * GAUSS_REACH) / GAUSS_SLOTS),
);

/** A 0..1 hash of a whole number and a salt. */
function hash(n: number, salt: number): number {
  let h = Math.imul(n + 1, 0x9e3779b1) ^ Math.imul(salt + 1, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

/** The network as drawn now. */
export interface Picture {
  readonly net: FlowNetwork;
  /** Junctions, trail texels (veins straightened). */
  readonly xs: Float64Array;
  readonly ys: Float64Array;
  /** Per tube: sketch level (0: not drawn) and profile width (texels). */
  readonly level: Float32Array;
  readonly sigma: Float32Array;
  /** Per tube: 1 where it is drawn as a vein rather than lace. */
  readonly vein: Uint8Array;
  /** Per tube: its vein's film level (× the trunk level; 0 for lace). */
  readonly film: Float32Array;
  /** Per spoke: its fan's sketch level at the flake (0 for the mesh's tubes and eaten food). */
  readonly fan: Float32Array;
  /** Per tube: the unit tangents leaving its first junction and leaving its second (x, y, x, y). */
  readonly tangent: Float32Array;
  /** Per junction: how much the veins swell or narrow there (0.75..1.25), so no tube is even. */
  readonly swell: Float32Array;
}

/** The network as drawn on this grid now. */
export function picture(net: FlowNetwork, grid: Grid): Picture {
  const tubes = net.tubes;
  const strength = new Float32Array(tubes);
  const share = new Float32Array(tubes);
  const veinness = new Float32Array(net.nodes);
  const low = Math.log(VEIN_LOW);
  const span = Math.log(VEIN_HIGH) - low;
  const thin = Math.cbrt(FLOW_THIN);
  const range = Math.cbrt(FLOW_TRUNK) - thin;
  for (let e = 0; e < tubes; e++) {
    if (!net.isOpen(e)) continue;
    const v = smoothstep(0, 1, (Math.log(net.conductivity[e] ?? 0) - low) / span);
    strength[e] = v;
    share[e] = clamp((Math.cbrt(net.flow[e] ?? 0) - thin) / range, 0, 1);
    const a = net.ea[e] ?? 0;
    const b = net.eb[e] ?? 0;
    veinness[a] = Math.max(veinness[a] ?? 0, v);
    veinness[b] = Math.max(veinness[b] ?? 0, v);
  }
  const level = new Float32Array(tubes);
  const sigma = new Float32Array(tubes);
  const vein = new Uint8Array(tubes);
  const film = new Float32Array(tubes);
  const fan = new Float32Array(tubes);
  for (let e = 0; e < tubes; e++) {
    if (!net.isOpen(e)) continue;
    const v = strength[e] ?? 0;
    const s = share[e] ?? 0;
    const veinLevel = v * (0.45 + 0.9 * Math.pow(s, 0.9));
    const a = net.ea[e] ?? 0;
    const b = net.eb[e] ?? 0;
    const near = Math.max(veinness[a] ?? 0, veinness[b] ?? 0);
    const lace = Math.min(FEEDER_MAX, (net.lace[e] ?? 0) * (1 + FEEDER * near));
    level[e] = Math.max(veinLevel, lace);
    vein[e] = veinLevel > lace ? 1 : 0;
    sigma[e] = veinLevel > lace ? 0.8 + 0.55 * s : LACE_SIGMA;
    film[e] = v * (FILM_THIN + (FILM_TRUNK - FILM_THIN) * s);
    if (e >= net.meshTubes) fan[e] = FAN_LEVEL * net.presence(a);
  }
  // Junctions in trail texels; those a vein just runs through drawn toward the middle of its two.
  const xs = new Float64Array(net.nodes);
  const ys = new Float64Array(net.nodes);
  for (let i = 0; i < net.nodes; i++) {
    xs[i] = grid.trailX(net.xs[i] ?? 0);
    ys[i] = grid.trailY(net.ys[i] ?? 0);
  }
  const through = new Int32Array(net.meshNodes * 2);
  const count = new Uint8Array(net.meshNodes);
  const pass = (here: number, there: number): void => {
    if (here >= net.meshNodes) return;
    const k = count[here] ?? 0;
    if (k < 2) through[2 * here + k] = there;
    count[here] = k + 1;
  };
  for (let e = 0; e < tubes; e++) {
    if ((strength[e] ?? 0) < 0.5) continue;
    pass(net.ea[e] ?? 0, net.eb[e] ?? 0);
    pass(net.eb[e] ?? 0, net.ea[e] ?? 0);
  }
  for (let round = 0; round < STRAIGHTEN; round++) {
    for (let i = 0; i < net.meshNodes; i++) {
      if (count[i] !== 2) continue;
      const f0 = through[2 * i] ?? 0;
      const f1 = through[2 * i + 1] ?? 0;
      xs[i] = (xs[i] ?? 0) + 0.5 * (((xs[f0] ?? 0) + (xs[f1] ?? 0)) / 2 - (xs[i] ?? 0));
      ys[i] = (ys[i] ?? 0) + 0.5 * (((ys[f0] ?? 0) + (ys[f1] ?? 0)) / 2 - (ys[i] ?? 0));
    }
  }
  // Tangents: chords, then at each junction the two strongest tubes run on through it.
  const tangent = new Float32Array(tubes * 4);
  const weight = (e: number): number => Math.max(level[e] ?? 0, fan[e] ?? 0);
  // The drawn tubes at each junction, as offsets into one list.
  const starts = new Int32Array(net.nodes + 1);
  for (let e = 0; e < tubes; e++) {
    if (weight(e) <= 0) continue;
    const a = net.ea[e] ?? 0;
    const b = net.eb[e] ?? 0;
    starts[a + 1] = (starts[a + 1] ?? 0) + 1;
    starts[b + 1] = (starts[b + 1] ?? 0) + 1;
    const dx = (xs[b] ?? 0) - (xs[a] ?? 0);
    const dy = (ys[b] ?? 0) - (ys[a] ?? 0);
    const length = Math.max(Math.sqrt(dx * dx + dy * dy), 1e-6);
    tangent[4 * e] = dx / length;
    tangent[4 * e + 1] = dy / length;
    tangent[4 * e + 2] = -dx / length;
    tangent[4 * e + 3] = -dy / length;
  }
  for (let i = 0; i < net.nodes; i++) starts[i + 1] = (starts[i + 1] ?? 0) + (starts[i] ?? 0);
  const incident = new Int32Array(starts[net.nodes] ?? 0);
  const filled = starts.slice(0, net.nodes);
  for (let e = 0; e < tubes; e++) {
    if (weight(e) <= 0) continue;
    for (const v of [net.ea[e] ?? 0, net.eb[e] ?? 0]) {
      const at = filled[v] ?? 0;
      incident[at] = e;
      filled[v] = at + 1;
    }
  }
  /** Where tube e's tangent leaving junction v is kept. */
  const end = (e: number, v: number): number => ((net.ea[e] ?? 0) === v ? 4 * e : 4 * e + 2);
  const chord = Float32Array.from(tangent);
  for (let v = 0; v < net.nodes; v++) {
    const from = starts[v] ?? 0;
    const to = starts[v + 1] ?? 0;
    if (to - from < 2) continue;
    let first = incident[from] ?? 0;
    for (let k = from; k < to; k++) {
      const e = incident[k] ?? 0;
      if (weight(e) > weight(first)) first = e;
    }
    const at1 = end(first, v);
    const u1x = chord[at1] ?? 0;
    const u1y = chord[at1 + 1] ?? 0;
    let second = -1;
    let best = -Infinity;
    for (let k = from; k < to; k++) {
      const e = incident[k] ?? 0;
      if (e === first) continue;
      const at = end(e, v);
      const score =
        -(u1x * (chord[at] ?? 0) + u1y * (chord[at + 1] ?? 0)) +
        (0.5 * weight(e)) / Math.max(weight(first), 1e-6);
      if (score > best) {
        best = score;
        second = e;
      }
    }
    if (second < 0) continue;
    const at2 = end(second, v);
    const u2x = chord[at2] ?? 0;
    const u2y = chord[at2 + 1] ?? 0;
    const spread = Math.hypot(u1x - u2x, u1y - u2y);
    if (spread < 1e-6) continue;
    const tx = (u1x - u2x) / spread;
    const ty = (u1y - u2y) / spread;
    const o1x = 0.5 * u1x + 0.5 * tx;
    const o1y = 0.5 * u1y + 0.5 * ty;
    const o2x = 0.5 * u2x - 0.5 * tx;
    const o2y = 0.5 * u2y - 0.5 * ty;
    const l1 = Math.max(Math.hypot(o1x, o1y), 1e-6);
    const l2 = Math.max(Math.hypot(o2x, o2y), 1e-6);
    tangent[at1] = o1x / l1;
    tangent[at1 + 1] = o1y / l1;
    tangent[at2] = o2x / l2;
    tangent[at2 + 1] = o2y / l2;
  }
  const swell = new Float32Array(net.nodes);
  for (let i = 0; i < net.nodes; i++) swell[i] = 0.75 + 0.5 * hash(i, 7);
  return { net, xs, ys, level, sigma, vein, film, fan, tangent, swell };
}

/**
 * The point at `t` (0..1) along tube e as drawn, into out[0], out[1] (trail texels): a Hermite curve
 * between its junctions with their tangents, wandering a little to one side (a bow and a slow wave,
 * pinned at both ends).
 */
function curveAt(pic: Picture, e: number, t: number, out: Float64Array): void {
  const net = pic.net;
  const a = net.ea[e] ?? 0;
  const b = net.eb[e] ?? 0;
  const ax = pic.xs[a] ?? 0;
  const ay = pic.ys[a] ?? 0;
  const bx = pic.xs[b] ?? 0;
  const by = pic.ys[b] ?? 0;
  const dx = bx - ax;
  const dy = by - ay;
  const span = Math.max(Math.sqrt(dx * dx + dy * dy), 1e-6);
  const amplitude =
    pic.vein[e] === 1 ? WANDER_VEIN : (pic.level[e] ?? 0) > 0 ? WANDER_LACE : WANDER_FAN;
  const bow = (hash(e, 1) - 0.5) * 1.2 * amplitude;
  const a1 = amplitude * (0.5 + hash(e, 2));
  const f1 = 1 + hash(e, 3);
  const p1 = hash(e, 4) * TAU;
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  const m0x = (pic.tangent[4 * e] ?? 0) * span;
  const m0y = (pic.tangent[4 * e + 1] ?? 0) * span;
  const m1x = -(pic.tangent[4 * e + 2] ?? 0) * span;
  const m1y = -(pic.tangent[4 * e + 3] ?? 0) * span;
  const side = span * Math.sin(Math.PI * t) * (bow + a1 * Math.sin(TAU * f1 * t + p1));
  out[0] = h00 * ax + h10 * m0x + h01 * bx + h11 * m1x - (dy / span) * side;
  out[1] = h00 * ay + h10 * m0y + h01 * by + h11 * m1y + (dx / span) * side;
}

/** Points along tube e as drawn, CURVE_STEP texels or so apart, into xs/ys; returns how many. */
function trace(pic: Picture, e: number, xs: Float64Array, ys: Float64Array): number {
  const net = pic.net;
  const a = net.ea[e] ?? 0;
  const b = net.eb[e] ?? 0;
  const chord = Math.hypot(
    (pic.xs[b] ?? 0) - (pic.xs[a] ?? 0),
    (pic.ys[b] ?? 0) - (pic.ys[a] ?? 0),
  );
  const n = Math.min(CURVE_POINTS - 1, Math.max(2, Math.ceil(chord / CURVE_STEP)));
  const at = new Float64Array(2);
  for (let k = 0; k <= n; k++) {
    curveAt(pic, e, k / n, at);
    xs[k] = at[0] ?? 0;
    ys[k] = at[1] ?? 0;
  }
  return n + 1;
}

/**
 * A soft segment from a to b (trail texels) into `field`, keeping the larger values: a Gaussian
 * profile `sigma` wide, `levelA` high at a moving linearly to `levelB` at b. A drawn curve is short
 * segments, so its width may change from one to the next.
 */
function stampSegment(
  field: Float32Array,
  grid: Grid,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  levelA: number,
  levelB: number,
  sigma: number,
): void {
  const width = grid.width;
  const reach = 3 * sigma;
  const reach2 = reach * reach;
  const y0 = Math.max(0, Math.floor(Math.min(ay, by) - reach));
  const y1 = Math.min(grid.height - 1, Math.ceil(Math.max(ay, by) + reach));
  const dx = bx - ax;
  const dy = by - ay;
  const along = 1 / Math.max(dx * dx + dy * dy, 1e-9);
  // d² in table slots: d² / 2σ² of GAUSS_REACH spread over GAUSS_SLOTS.
  const slots = GAUSS_SLOTS / (GAUSS_REACH * 2 * sigma * sigma);
  const rise = levelB - levelA;
  for (let y = y0; y <= y1; y++) {
    const py = y + 0.5 - ay;
    // Only points of the segment within reach of this row matter: they bound its columns.
    let lo = 0;
    let hi = 1;
    if (Math.abs(dy) > 1e-9) {
      const t0 = (py - reach) / dy;
      const t1 = (py + reach) / dy;
      lo = clamp(Math.min(t0, t1), 0, 1);
      hi = clamp(Math.max(t0, t1), 0, 1);
    }
    const x0 = Math.max(0, Math.floor(ax + Math.min(lo * dx, hi * dx) - reach));
    const x1 = Math.min(width - 1, Math.ceil(ax + Math.max(lo * dx, hi * dx) + reach));
    const row = y * width;
    for (let x = x0; x <= x1; x++) {
      const px = x + 0.5 - ax;
      let t = (px * dx + py * dy) * along;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ox = px - t * dx;
      const oy = py - t * dy;
      const d2 = ox * ox + oy * oy;
      if (d2 > reach2) continue;
      const v = (levelA + rise * t) * (GAUSS[(d2 * slots + 0.5) | 0] ?? 0);
      if (v > (field[row + x] ?? 0)) field[row + x] = v;
    }
  }
}

/** Which strokes to lay, and at which levels: the sketch's, or the film's lace, or its veins and fans. */
type Strokes = "sketch" | "lace" | "veins";

/** Tubes and fans into `field` at their levels for these strokes. */
function stampTubes(pic: Picture, grid: Grid, field: Float32Array, strokes: Strokes): void {
  const net = pic.net;
  const xs = new Float64Array(CURVE_POINTS);
  const ys = new Float64Array(CURVE_POINTS);
  for (let e = 0; e < net.tubes; e++) {
    let level = 0;
    let sigma = pic.sigma[e] ?? LACE_SIGMA;
    switch (strokes) {
      case "sketch":
        level = pic.level[e] ?? 0;
        break;
      case "lace":
        level = net.isOpen(e) ? FILM_LACE * (net.lace[e] ?? 0) : 0;
        sigma = LACE_SIGMA;
        break;
      case "veins":
        level = pic.vein[e] === 1 ? (pic.film[e] ?? 0) : 0;
        break;
      default: {
        const unreachable: never = strokes;
        throw new PhysarumError(`physarum: unknown strokes ${String(unreachable)}`);
      }
    }
    const fan = strokes === "lace" ? 0 : (pic.fan[e] ?? 0) * (strokes === "sketch" ? 1 : FILM_LACE);
    if (level <= 0.005 && fan <= 0.005) continue;
    const count = trace(pic, e, xs, ys);
    const last = count - 1;
    if (level > 0.005) {
      const sa = pic.swell[net.ea[e] ?? 0] ?? 1;
      const sb = pic.swell[net.eb[e] ?? 0] ?? 1;
      for (let k = 0; k < last; k++) {
        // Swelling from one junction's to the other's along the tube.
        const s0 = sa + ((sb - sa) * k) / last;
        const s1 = sa + ((sb - sa) * (k + 1)) / last;
        stampSegment(
          field,
          grid,
          xs[k] ?? 0,
          ys[k] ?? 0,
          xs[k + 1] ?? 0,
          ys[k + 1] ?? 0,
          level * s0,
          level * s1,
          sigma * (0.7 + 0.15 * (s0 + s1)),
        );
      }
    }
    // A fan leaves its flake (a spoke's first junction) and peters out in the agar.
    if (fan > 0.005) {
      for (let k = 0; k < last; k++) {
        const t0 = k / last;
        const t1 = (k + 1) / last;
        stampSegment(
          field,
          grid,
          xs[k] ?? 0,
          ys[k] ?? 0,
          xs[k + 1] ?? 0,
          ys[k + 1] ?? 0,
          fan * Math.pow(1 - t0, 0.7),
          fan * Math.pow(1 - t1, 0.7),
          0.8 * (0.6 + 0.2 * (2 - t0 - t1)),
        );
      }
    }
  }
}

/** A soft dot at (x, y) (trail texels), keeping the larger value; the Gaussian taken apart by axis. */
function splat(
  field: Float32Array,
  grid: Grid,
  x: number,
  y: number,
  level: number,
  sigma: number,
): void {
  const reach = Math.ceil(3 * sigma);
  const x0 = Math.max(0, Math.floor(x - reach));
  const x1 = Math.min(grid.width - 1, Math.ceil(x + reach));
  const y0 = Math.max(0, Math.floor(y - reach));
  const y1 = Math.min(grid.height - 1, Math.ceil(y + reach));
  const k = -1 / (2 * sigma * sigma);
  const across = new Float64Array(Math.max(0, x1 - x0 + 1));
  for (let xx = x0; xx <= x1; xx++) across[xx - x0] = Math.exp(k * (xx + 0.5 - x) ** 2);
  for (let yy = y0; yy <= y1; yy++) {
    const down = level * Math.exp(k * (yy + 0.5 - y) ** 2);
    const row = yy * grid.width;
    for (let xx = x0; xx <= x1; xx++) {
      const v = down * (across[xx - x0] ?? 0);
      if (v > (field[row + xx] ?? 0)) field[row + xx] = v;
    }
  }
}

/** Nothing grows past the dish's wall: every texel whose centre lies beyond it is cleared. */
function clipToDish(field: Float32Array, grid: Grid): void {
  const cx = grid.trailX(0.5);
  const cy = grid.trailY(0.5);
  const dish = grid.dish;
  for (let y = 0; y < grid.height; y++) {
    const dy = y + 0.5 - cy;
    const row = y * grid.width;
    if (Math.abs(dy) > dish) {
      field.fill(0, row, row + grid.width);
      continue;
    }
    // Texel x is inside while |x + 0.5 - cx| <= half.
    const half = Math.sqrt(dish * dish - dy * dy);
    const first = clamp(Math.ceil(cx - half - 0.5), 0, grid.width);
    const last = clamp(Math.floor(cx + half - 0.5), first - 1, grid.width - 1);
    field.fill(0, row, row + first);
    field.fill(0, row + last + 1, row + grid.width);
  }
}

/**
 * The sketch: trail in sketch units (lace ≤ 0.36, fans 0.35 at the flake, thin veins ~0.5, trunks to
 * ~1.35, the crowd on a flake 1 with a faint pad of plasmodium round it), cleared past the dish.
 */
export function stampSketch(pic: Picture, flakes: readonly SketchNode[], grid: Grid): Float32Array {
  const sketch = new Float32Array(grid.width * grid.height);
  stampTubes(pic, grid, sketch, "sketch");
  for (const p of flakes) {
    splat(sketch, grid, p.x, p.y, 1, Math.max(1, 0.7 * p.r));
    splat(sketch, grid, p.x, p.y, 0.3, 1.6 * p.r);
  }
  clipToDish(sketch, grid);
  return sketch;
}

/**
 * The film (× the trunk level), redrawn as the network adapts: its lace drawn once per network,
 * grid and light, the veins and fans laid over a copy of it each time.
 */
export class Film {
  #data: Float32Array = new Float32Array(0);
  #lace: Float32Array = new Float32Array(0);
  #laceNet: FlowNetwork | undefined = undefined;
  #laceLight = true;

  /** The film for the network as drawn now, over the whole trail grid (the array is reused). */
  draw(pic: Picture, grid: Grid): Float32Array {
    const size = grid.width * grid.height;
    const net = pic.net;
    if (this.#lace.length !== size || this.#laceNet !== net || this.#laceLight !== net.lightOn) {
      this.#lace = new Float32Array(size);
      this.#data = new Float32Array(size);
      this.#laceNet = net;
      this.#laceLight = net.lightOn;
      stampTubes(pic, grid, this.#lace, "lace");
    }
    this.#data.set(this.#lace);
    stampTubes(pic, grid, this.#data, "veins");
    clipToDish(this.#data, grid);
    return this.#data;
  }

  /** The lace `draw` drew last (its own array, handed over with the field: `adopt`). */
  get lace(): Float32Array {
    return this.#lace;
  }

  /**
   * Go on from a film drawn elsewhere (the build worker) for `net` as it stands, its lace and field
   * as `draw` left them, so the next draw reuses that lace as though drawn here.
   */
  adopt(net: FlowNetwork, lace: Float32Array, data: Float32Array): void {
    this.#lace = lace;
    this.#data = data;
    this.#laceNet = net;
    this.#laceLight = net.lightOn;
  }
}

/**
 * Distance along the veins from the heart (screen heights) at half resolution, PHYSARUM_FAR off
 * them: along each vein and fan, and across the flakes the veins reach.
 */
export function stampDistance(
  pic: Picture,
  flakes: readonly SketchNode[],
  grid: Grid,
): Float32Array {
  const net = pic.net;
  const ew = grid.envWidth;
  const eh = grid.envHeight;
  const field = new Float32Array(ew * eh).fill(PHYSARUM_FAR);
  const along = net.veinDistances(VEIN_CUT);
  const sx = ew / grid.width;
  const sy = eh / grid.height;
  // Half-resolution texels to screen heights, per axis.
  const unitX = 1 / (sx * grid.perHeight);
  const unitY = 1 / (sy * grid.perHeight);
  /** A segment a–b (half-res texels), `fromA` and `fromB` heights along the veins at its ends. */
  const stamp = (
    ax: number,
    ay: number,
    bx: number,
    by: number,
    fromA: number,
    fromB: number,
    reach: number,
  ): void => {
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - reach));
    const x1 = Math.min(ew - 1, Math.ceil(Math.max(ax, bx) + reach));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by) - reach));
    const y1 = Math.min(eh - 1, Math.ceil(Math.max(ay, by) + reach));
    const dx = bx - ax;
    const dy = by - ay;
    const length2 = Math.max(dx * dx + dy * dy, 1e-9);
    for (let y = y0; y <= y1; y++) {
      const py = y + 0.5 - ay;
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5 - ax;
        const t = clamp((px * dx + py * dy) / length2, 0, 1);
        const ox = (px - t * dx) * unitX;
        const oy = (py - t * dy) * unitY;
        const d = fromA + t * (fromB - fromA) + Math.sqrt(ox * ox + oy * oy);
        const at = y * ew + x;
        if (d < (field[at] ?? PHYSARUM_FAR)) field[at] = d;
      }
    }
  };
  const xs = new Float64Array(CURVE_POINTS);
  const ys = new Float64Array(CURVE_POINTS);
  const lengths = new Float64Array(CURVE_POINTS);
  for (let e = 0; e < net.tubes; e++) {
    const vein = net.isOpen(e) && (net.conductivity[e] ?? 0) >= VEIN_CUT;
    if (!vein && !((pic.fan[e] ?? 0) > 0)) continue;
    const fromA = along[net.ea[e] ?? 0] ?? Infinity;
    // A vein is reached from both ends; a fan only out of its flake.
    const fromB = vein ? (along[net.eb[e] ?? 0] ?? Infinity) : Infinity;
    if (!Number.isFinite(fromA) && !Number.isFinite(fromB)) continue;
    const count = trace(pic, e, xs, ys);
    // Heights along the curve to each point.
    for (let k = 1; k < count; k++) {
      const dx = ((xs[k] ?? 0) - (xs[k - 1] ?? 0)) / grid.perHeight;
      const dy = ((ys[k] ?? 0) - (ys[k - 1] ?? 0)) / grid.perHeight;
      lengths[k] = (lengths[k - 1] ?? 0) + Math.sqrt(dx * dx + dy * dy);
    }
    const total = lengths[count - 1] ?? 0;
    let previous = Math.min(fromA, fromB + total);
    for (let k = 0; k + 1 < count; k++) {
      const next = Math.min(fromA + (lengths[k + 1] ?? 0), fromB + total - (lengths[k + 1] ?? 0));
      stamp(
        (xs[k] ?? 0) * sx,
        (ys[k] ?? 0) * sy,
        (xs[k + 1] ?? 0) * sx,
        (ys[k + 1] ?? 0) * sy,
        previous,
        next,
        2.5,
      );
      previous = next;
    }
  }
  for (const p of flakes) {
    const node = net.foodNode(p.id);
    const base = node < 0 ? Infinity : (along[node] ?? Infinity);
    if (Number.isFinite(base))
      stamp(p.x * sx, p.y * sy, p.x * sx, p.y * sy, base, base, p.r * sx + 2);
  }
  return field;
}

/**
 * The specks: SEED_TUBES laid along the tubes in proportion to each one's length and level, heading
 * either way, SEED_FANS out along the fans, SEED_FLAKES at the flakes heading out, the rest anywhere
 * on the dish, any way; ages spread so they do not all starve at once. Also returns the trail level
 * (raw units per sketch unit) they will keep up, to scale the seeded trail by.
 */
export function seedAgents(
  shape: { width: number; height: number },
  pic: Picture,
  flakes: readonly SketchNode[],
  grid: Grid,
  rand: () => number,
): { data: Float32Array; level: number } {
  const net = pic.net;
  const total = shape.width * shape.height;
  const data = new Float32Array(total * 4);
  // Cumulative mass (texels × level) over the drawn tubes, and over the fans; each one's points.
  const tubes: number[] = [];
  const tubeEnds: number[] = [];
  const fans: number[] = [];
  const fanEnds: number[] = [];
  const first = new Int32Array(net.tubes);
  const points = new Int32Array(net.tubes);
  const px: number[] = [];
  const py: number[] = [];
  const xs = new Float64Array(CURVE_POINTS);
  const ys = new Float64Array(CURVE_POINTS);
  let mass = 0;
  let fanMass = 0;
  for (let e = 0; e < net.tubes; e++) {
    const level = pic.level[e] ?? 0;
    const fan = pic.fan[e] ?? 0;
    if (level <= 0.005 && fan <= 0.005) continue;
    const a = net.ea[e] ?? 0;
    const b = net.eb[e] ?? 0;
    const dx = (pic.xs[b] ?? 0) - (pic.xs[a] ?? 0);
    const dy = (pic.ys[b] ?? 0) - (pic.ys[a] ?? 0);
    const length = Math.sqrt(dx * dx + dy * dy);
    const count = trace(pic, e, xs, ys);
    first[e] = px.length;
    points[e] = count;
    for (let k = 0; k < count; k++) {
      px.push(xs[k] ?? 0);
      py.push(ys[k] ?? 0);
    }
    if (level > 0.005) {
      mass += length * level;
      tubes.push(e);
      tubeEnds.push(mass);
    }
    if (fan > 0.005) {
      fanMass += length * fan;
      fans.push(e);
      fanEnds.push(fanMass);
    }
  }
  const pick = (list: readonly number[], ends: readonly number[], of: number): number => {
    const at = rand() * of;
    let lo = 0;
    let hi = list.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((ends[mid] ?? 0) < at) lo = mid + 1;
      else hi = mid;
    }
    return item(list, lo);
  };
  const onTubes = mass > 0 ? Math.floor(total * SEED_TUBES) : 0;
  const onFans = onTubes + (fanMass > 0 ? Math.floor(total * SEED_FANS) : 0);
  const atFlakes = onFans + (flakes.length > 0 ? Math.floor(total * SEED_FLAKES) : 0);
  const cx = grid.trailX(0.5);
  const cy = grid.trailY(0.5);
  const dish = grid.dish - 2;
  for (let i = 0; i < total; i++) {
    let x: number;
    let y: number;
    let heading: number;
    if (i < onFans) {
      const fan = i >= onTubes;
      const e = fan ? pick(fans, fanEnds, fanMass) : pick(tubes, tubeEnds, mass);
      // A point along one of its segments.
      const k = (first[e] ?? 0) + Math.floor(rand() * ((points[e] ?? 2) - 1));
      const x0 = px[k] ?? 0;
      const y0 = py[k] ?? 0;
      const tx = (px[k + 1] ?? 0) - x0;
      const ty = (py[k + 1] ?? 0) - y0;
      const tl = Math.max(Math.sqrt(tx * tx + ty * ty), 1e-6);
      const u = rand();
      const side = (rand() - 0.5) * 2.4;
      x = x0 + u * tx - (ty / tl) * side;
      y = y0 + u * ty + (tx / tl) * side;
      heading = Math.atan2(ty, tx) + (!fan && rand() < 0.5 ? Math.PI : 0) + (rand() - 0.5) * 0.3;
    } else if (i < atFlakes) {
      const p = item(flakes, Math.min(flakes.length - 1, Math.floor(rand() * flakes.length)));
      const a = rand() * TAU;
      const r = p.r * (0.3 + 0.6 * rand());
      x = p.x + Math.cos(a) * r;
      y = p.y + Math.sin(a) * r;
      heading = a + (rand() - 0.5) * 1.2;
    } else {
      do {
        x = rand() * grid.width;
        y = rand() * grid.height;
      } while ((x - cx) ** 2 + (y - cy) ** 2 > dish * dish);
      heading = rand() * TAU;
    }
    const o = i * 4;
    data[o] = clamp(x / grid.width, 0, 1);
    data[o + 1] = clamp(y / grid.height, 0, 1);
    data[o + 2] = ((heading % TAU) + TAU) % TAU;
    data[o + 3] = LIFE * (0.2 + 0.8 * rand());
  }
  // Specks per texel along a tube of level 1, each keeping up AGENT_UNIT × REF / N over about three texels' width.
  const level =
    mass > 0 ? (AGENT_UNIT * REFERENCE_AGENTS * onTubes) / (total * 3 * mass) : AGENT_UNIT;
  return { data, level };
}
