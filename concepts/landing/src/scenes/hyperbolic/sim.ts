// The hyperbolic plane behind the tiling scene, on the CPU:
//
//  - the geometry the shader (shader.ts) shares: the {p,q} tilings, folded into one fundamental
//    triangle by repeated mirroring; the strands woven through each tile; the three maps of the
//    plane onto the screen (disk, band, half-plane);
//  - the glide: the motion taking the screen onto the plane, moved each frame by a slow flow, by
//    the pointer's drags and their coasting; the tile carrying the M; the light pulse;
//  - one small state texture handing all of it to the shader (layout: HYPERBOLIC_TEXELS).
//
// The motion never wanders off into huge numbers: the tiling looks the same from every tile, so
// whenever the screen's centre leaves the central tile the motion is traded for the equivalent one
// that brings it back (`settle`). The picture does not change, and the numbers the shader gets stay
// small and precise however long the plane glides.
import { KnobReader, type ParamDef } from "../../params.ts";
import { mulberry32 } from "../../sims/random.ts";
import { approach, clamp, easeFactor, smoothstep } from "../../sims/math.ts";
import { DataTexture } from "../../sims/texture.ts";
import type {
  PrincipalState,
  SceneSim,
  ScenePassageProgress,
  SimFactory,
  SimFrame,
} from "../types.ts";

// ---- Complex numbers ------------------------------------------------------------------------------

interface Complex {
  readonly re: number;
  readonly im: number;
}

const complex = (re: number, im = 0): Complex => ({ re, im });
const ZERO = complex(0);
const ONE = complex(1);
const I = complex(0, 1);
const plus = (a: Complex, b: Complex): Complex => complex(a.re + b.re, a.im + b.im);
const minus = (a: Complex, b: Complex): Complex => complex(a.re - b.re, a.im - b.im);
const times = (a: Complex, b: Complex): Complex =>
  complex(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
const scaled = (a: Complex, k: number): Complex => complex(a.re * k, a.im * k);
const conj = (a: Complex): Complex => complex(a.re, -a.im);
const norm = (a: Complex): number => a.re * a.re + a.im * a.im;
const size = (a: Complex): number => Math.hypot(a.re, a.im);
const angle = (a: Complex): number => Math.atan2(a.im, a.re);
const polar = (radius: number, theta: number): Complex =>
  complex(radius * Math.cos(theta), radius * Math.sin(theta));

function quotient(a: Complex, b: Complex): Complex {
  const d = norm(b);
  return complex((a.re * b.re + a.im * b.im) / d, (a.im * b.re - a.re * b.im) / d);
}

/** The principal square root. */
function root(a: Complex): Complex {
  const r = size(a);
  const re = Math.sqrt(Math.max(0, (r + a.re) / 2));
  const im = Math.sqrt(Math.max(0, (r - a.re) / 2));
  return complex(re, a.im < 0 ? -im : im);
}

function tanhOf(a: Complex): Complex {
  const d = Math.cosh(2 * a.re) + Math.cos(2 * a.im);
  return complex(Math.sinh(2 * a.re) / d, Math.sin(2 * a.im) / d);
}

/** atanh z = ½ log((1 + z) / (1 − z)). */
function atanhOf(a: Complex): Complex {
  const r = quotient(plus(ONE, a), minus(ONE, a));
  return complex(0.5 * Math.log(size(r)), 0.5 * angle(r));
}

// ---- Motions of the plane -------------------------------------------------------------------------

/** A motion of the plane seen in the disk: z ↦ (a z + b) / (b̄ z + ā), with |a|² − |b|² = 1. */
interface Motion {
  readonly a: Complex;
  readonly b: Complex;
}

const STILL: Motion = { a: ONE, b: ZERO };

/** f after g. */
function compose(f: Motion, g: Motion): Motion {
  return {
    a: plus(times(f.a, g.a), times(f.b, conj(g.b))),
    b: plus(times(f.a, g.b), times(f.b, conj(g.a))),
  };
}

function inverse(f: Motion): Motion {
  return { a: conj(f.a), b: scaled(f.b, -1) };
}

function carry(f: Motion, z: Complex): Complex {
  return quotient(plus(times(f.a, z), f.b), plus(times(conj(f.b), z), conj(f.a)));
}

/** Back onto |a|² − |b|² = 1, against rounding. */
function tidy(f: Motion): Motion {
  const k = 1 / Math.sqrt(Math.max(norm(f.a) - norm(f.b), 1e-12));
  return { a: scaled(f.a, k), b: scaled(f.b, k) };
}

/** The translation taking 0 to `to`, along the line through both. */
function shift(to: Complex): Motion {
  const k = 1 / Math.sqrt(Math.max(1 - norm(to), 1e-12));
  return { a: complex(k), b: scaled(to, k) };
}

/**
 * A steady motion's velocity X = [[i·turn, push], [p̄ush, −i·turn]]: after t seconds the plane has
 * moved by exp(tX). A pure push slides the plane along a line through the centre at 2|push| units a
 * second; a pure turn wheels it about the centre at 2·turn radians a second.
 */
interface Velocity {
  readonly turn: number;
  readonly push: Complex;
}

const REST: Velocity = { turn: 0, push: ZERO };
const sum = (u: Velocity, v: Velocity): Velocity => ({
  turn: u.turn + v.turn,
  push: plus(u.push, v.push),
});
const faster = (v: Velocity, k: number): Velocity => ({
  turn: v.turn * k,
  push: scaled(v.push, k),
});

/** exp(tX): X² = (|push|² − turn²)·1, so the series sums to cosh / cos and sinh / sin. */
function after(v: Velocity, t: number): Motion {
  const turn = v.turn * t;
  const push = scaled(v.push, t);
  const d = norm(push) - turn * turn;
  let c: number;
  let s: number;
  if (d > 1e-12) {
    const r = Math.sqrt(d);
    c = Math.cosh(r);
    s = Math.sinh(r) / r;
  } else if (d < -1e-12) {
    const r = Math.sqrt(-d);
    c = Math.cos(r);
    s = Math.sin(r) / r;
  } else {
    c = 1 + d / 2;
    s = 1 + d / 6;
  }
  return { a: complex(c, s * turn), b: scaled(push, s) };
}

/** The velocity m X m⁻¹: the same flow, carried by the motion m. */
function seenFrom(m: Motion, v: Velocity): Velocity {
  const { a, b } = m;
  const x = v.push;
  const turn = v.turn * (norm(a) + norm(b)) + 2 * times(times(conj(a), b), conj(x)).im;
  const push = minus(
    minus(times(times(a, a), x), times(times(b, b), conj(x))),
    times(complex(0, 2 * v.turn), times(a, b)),
  );
  return { turn, push };
}

/** How fast a velocity moves the screen's centre, in units a second (counting its turn too). */
const pace = (v: Velocity): number => 2 * Math.hypot(size(v.push), v.turn);

// ---- Mirrors --------------------------------------------------------------------------------------

/**
 * A product of the tiling's mirrors: z ↦ (a ẑ + b) / (c ẑ + d), where ẑ = z̄ when it turns the plane
 * over. `edges` counts the tile edges it reflects across: tiles alternate colour with each one.
 */
interface Mirrors {
  readonly a: Complex;
  readonly b: Complex;
  readonly c: Complex;
  readonly d: Complex;
  readonly flip: boolean;
  readonly edges: number;
}

const UNMIRRORED: Mirrors = { a: ONE, b: ZERO, c: ZERO, d: ONE, flip: false, edges: 0 };
/** The mirror along the real axis. */
const ACROSS_AXIS: Mirrors = { a: ONE, b: ZERO, c: ZERO, d: ONE, flip: true, edges: 0 };

const rotation = (theta: number): Mirrors => ({
  a: polar(1, theta / 2),
  b: ZERO,
  c: ZERO,
  d: polar(1, -theta / 2),
  flip: false,
  edges: 0,
});

/** The mirror in the central tile's edge across the positive real axis: z ↦ (c z̄ − 1) / (z̄ − c). */
const acrossEdge = (t: Tiling): Mirrors => ({
  a: complex(t.c),
  b: complex(-1),
  c: ONE,
  d: complex(-t.c),
  flip: true,
  edges: 1,
});

/** f after g. */
function mirrored(f: Mirrors, g: Mirrors): Mirrors {
  const ga = f.flip ? conj(g.a) : g.a;
  const gb = f.flip ? conj(g.b) : g.b;
  const gc = f.flip ? conj(g.c) : g.c;
  const gd = f.flip ? conj(g.d) : g.d;
  return {
    a: plus(times(f.a, ga), times(f.b, gc)),
    b: plus(times(f.a, gb), times(f.b, gd)),
    c: plus(times(f.c, ga), times(f.d, gc)),
    d: plus(times(f.c, gb), times(f.d, gd)),
    flip: f.flip !== g.flip,
    edges: f.edges + g.edges,
  };
}

/** An even number of mirrors as a motion (one more mirror along the axis first if odd). */
function asMotion(m: Mirrors): Motion {
  const even = m.flip ? mirrored(ACROSS_AXIS, m) : m;
  const k = root(minus(times(even.a, even.d), times(even.b, even.c)));
  const a = quotient(even.a, k);
  const b = quotient(even.b, k);
  const c = quotient(even.c, k);
  const d = quotient(even.d, k);
  return tidy({ a: scaled(plus(a, conj(d)), 0.5), b: scaled(plus(b, conj(c)), 0.5) });
}

// ---- Tilings --------------------------------------------------------------------------------------

export interface TilingDef {
  readonly label: string;
  /** Sides of a tile. */
  readonly p: number;
  /** Tiles meeting at each corner (1/p + 1/q < 1/2: hyperbolic). */
  readonly q: number;
}

export const HYPERBOLIC_TILINGS: readonly TilingDef[] = [
  { label: "{7,3}", p: 7, q: 3 },
  { label: "{8,3}", p: 8, q: 3 },
  { label: "{5,4}", p: 5, q: 4 },
  { label: "{6,4}", p: 6, q: 4 },
  { label: "{4,5}", p: 4, q: 5 },
  { label: "{3,8}", p: 3, q: 8 },
];

const FIRST_TILING: TilingDef = HYPERBOLIC_TILINGS[0] ?? { label: "{7,3}", p: 7, q: 3 };

/** A {p,q} tiling's central tile in the disk: centred on 0, an edge straddling the positive real axis. */
export interface Tiling {
  readonly p: number;
  readonly q: number;
  /** The circle carrying that edge: centre (c, 0), radius r, meeting the rim square on (c² = 1 + r²). */
  readonly c: number;
  readonly r: number;
  /** Distance of a corner, and of an edge's midpoint, from the centre (disk units). */
  readonly corner: number;
  readonly mid: number;
  /** Half an edge's length, and the tile's inradius (hyperbolic units). */
  readonly half: number;
  readonly inradius: number;
  /** 2π/p. */
  readonly sector: number;
}

export function tilingOf(def: TilingDef): Tiling {
  const { p, q } = def;
  const coshCorner = 1 / (Math.tan(Math.PI / p) * Math.tan(Math.PI / q));
  const corner = Math.sqrt((coshCorner - 1) / (coshCorner + 1));
  const c = (1 + corner * corner) / (2 * corner * Math.cos(Math.PI / p));
  const r = Math.sqrt(c * c - 1);
  const mid = c - r;
  return {
    p,
    q,
    c,
    r,
    corner,
    mid,
    half: Math.acosh(Math.cos(Math.PI / p) / Math.sin(Math.PI / q)),
    inradius: 2 * Math.atanh(mid),
    sector: (2 * Math.PI) / p,
  };
}

/**
 * The mirrors taking w into the wedge 0 ≤ arg ≤ π/p of the central tile, the way the shader folds
 * each pixel: turn into the edge's sector, mirror into its upper half, and if beyond the edge,
 * mirror across it; repeat until inside.
 */
function foldOf(w: Complex, t: Tiling): Mirrors {
  let x = w;
  let map = UNMIRRORED;
  for (let pass = 0; pass < 64; pass++) {
    const k = Math.floor(angle(x) / t.sector + 0.5);
    if (k !== 0) {
      x = times(x, polar(1, -k * t.sector));
      map = mirrored(rotation(-k * t.sector), map);
    }
    if (x.im < 0) {
      x = conj(x);
      map = mirrored(ACROSS_AXIS, map);
    }
    const d = minus(x, complex(t.c));
    const d2 = norm(d);
    if (d2 >= t.r * t.r) break;
    x = plus(complex(t.c), scaled(d, (t.r * t.r) / d2));
    map = mirrored(acrossEdge(t), map);
  }
  return map;
}

// ---- Strands --------------------------------------------------------------------------------------

export const HYPERBOLIC_MOTIFS = ["weave", "star", "rings", "lattice"] as const;
type Motif = (typeof HYPERBOLIC_MOTIFS)[number];

/** Shading the shader applies and the tile's average (below) must count in. */
export const HYPERBOLIC_SHADE = {
  /** The ground is lit like a cushion: this bright at a tile's centre... */
  cushion: 1.04,
  /** ...this much darker at its corners. */
  cushionFall: 0.14,
  /** Lattice tiles with an odd number at each corner glow from the middle: tone 1 − lantern·r². */
  lantern: 1.2,
  /**
   * A strand's dark outline reaches this many times its half-width. Strands are flat, like a
   * woodcut's: shading across a moving strand would make the dither crawl.
   */
  outline: 1.6,
} as const;

/** Defaults the fallback picture (and the knobs in index.ts) start from. */
export const HYPERBOLIC_DEFAULTS = { spread: 0.5, weight: 0.65 } as const;

/**
 * The strands of a tile. Each crosses the tile's edges square on, at two ports per edge `spread` of
 * the way from the edge's midpoint to its corners, so mirrored into the next tile it carries on
 * smoothly. Strand j runs on a circle from edge j's upper port to edge j+k's lower port: k = 1
 * curls round a corner (rings), k = 2 crosses its neighbours once each (a weave), more crosses
 * more (a star). Strand 0's circle is centred on the bisector between edges 0 and k.
 */
interface Strands {
  /** Edges each strand spans (0: the lattice, drawn along the edges instead). */
  readonly k: number;
  /** Strand 0's circle: centre `s` along the bisector, radius `rho` (disk units). */
  readonly s: number;
  readonly rho: number;
  /** +1 when the cap a strand cuts off (towards the edges it spans) lies inside its circle. */
  readonly side: number;
  /** Half-width of a strand, and of it with its dark outline (hyperbolic units). */
  readonly body: number;
  readonly outline: number;
  /** Distance between neighbouring strands (hyperbolic): the size of the regions between them. */
  readonly spacing: number;
  /** The M's half-height in its tile (disk units, the tile centred on 0). */
  readonly markHalf: number;
  /** The tile's average colour, as weights of the two grounds, the outline and the strand. */
  readonly average: readonly [number, number, number, number];
}

function motifSpan(motif: Motif, p: number): number {
  switch (motif) {
    case "weave":
      return 2;
    case "star":
      return Math.max(2, Math.floor(p / 2));
    case "rings":
      return 1;
    case "lattice":
      return 0;
    default: {
      const unreachable: never = motif;
      throw new Error(`hyperbolic: unknown motif ${String(unreachable)}`);
    }
  }
}

function strandsOf(t: Tiling, motif: Motif, spread: number, weight: number): Strands {
  const k = motifSpan(motif, t.p);
  if (k === 0) {
    const body = 0.3 * weight * Math.min(t.half, t.inradius);
    const outline = body * HYPERBOLIC_SHADE.outline;
    return {
      k,
      s: 0,
      rho: 0,
      side: 1,
      body,
      outline,
      spacing: t.inradius,
      markHalf: 0.62 * t.mid,
      average: tileAverage(t, k, 0, 0, 1, body, outline),
    };
  }
  // The port on edge 0: the edge's midpoint slid along the edge (the line square to the real axis
  // there) by `spread` of half an edge.
  const u = Math.tanh((spread * t.half) / 2);
  const port = quotient(complex(t.mid, u), complex(1, t.mid * u));
  // The strand's circle meets the edge's circle square on at the port, so its centre lies on the
  // edge's tangent there, and on the bisector by symmetry: port + a·tangent = s·bisector.
  const radial = minus(port, complex(t.c));
  const tangent = scaled(times(I, radial), 1 / size(radial));
  const bisector = polar(1, (k * Math.PI) / t.p);
  const det = bisector.re * tangent.im - tangent.re * bisector.im;
  const s = (port.re * tangent.im - tangent.re * port.im) / det;
  const rho = size(minus(scaled(bisector, s), port));
  // The rim point midway along the edges the strand spans: inside the circle when the cap is.
  const between = scaled(bisector, k % 2 === 0 ? t.mid : t.corner);
  const side = size(minus(between, scaled(bisector, s))) < rho ? 1 : -1;
  // Strands sit 2·spread half-edges apart across an edge's middle, and about 2 sin(π/q)(1 − spread)
  // apart round a corner.
  const spacing = Math.min(2 * spread, 2 * Math.sin(Math.PI / t.q) * (1 - spread)) * t.half;
  const body = 0.36 * weight * spacing;
  const outline = body * HYPERBOLIC_SHADE.outline;
  // The M fits in the clear middle of its tile where it can, and overlaps the strands where not.
  const free = Math.abs(Math.abs(s) - rho);
  const markHalf = clamp(
    0.8 * (free - (outline * (1 - free * free)) / 2),
    0.38 * t.mid,
    0.62 * t.mid,
  );
  return {
    k,
    s,
    rho,
    side,
    body,
    outline,
    spacing,
    markHalf,
    average: tileAverage(t, k, s, rho, side, body, outline),
  };
}

/**
 * The tile's average colour, which its detail dissolves into as it shrinks toward the rim: sampled
 * over the fundamental triangle, weighted by hyperbolic area, shaded as the shader shades it.
 */
function tileAverage(
  t: Tiling,
  k: number,
  s: number,
  rho: number,
  side: number,
  body: number,
  outline: number,
): [number, number, number, number] {
  const rows = 40;
  const columns = 16;
  const centres = Array.from({ length: t.p }, (_, j) => polar(s, ((2 * j + k) * Math.PI) / t.p));
  const edgeCentre = complex(t.c);
  const shade = HYPERBOLIC_SHADE;
  let ground0 = 0;
  let ground1 = 0;
  let ink = 0;
  let strand = 0;
  let total = 0;
  for (let i = 0; i < rows; i++) {
    const r = (t.corner * (i + 0.5)) / rows;
    // Hyperbolic area 4r / (1 − r²)² dr dθ; the constant factors cancel.
    const area = r / ((1 - r * r) * (1 - r * r));
    const scale = (1 - r * r) / 2;
    const rel = r / t.corner;
    const cushion = shade.cushion - shade.cushionFall * rel * rel;
    for (let j = 0; j < columns; j++) {
      const x = polar(r, ((Math.PI / t.p) * (j + 0.5)) / columns);
      if (norm(minus(x, edgeCentre)) < t.r * t.r) continue;
      let gap: number;
      let tone: number;
      if (k === 0) {
        gap = Math.abs(size(minus(x, edgeCentre)) - t.r);
        tone = t.q % 2 === 0 ? 0.5 : clamp(1 - shade.lantern * rel * rel, 0, 1);
      } else {
        gap = Number.POSITIVE_INFINITY;
        tone = 0;
        for (const centre of centres) {
          const g = (size(minus(x, centre)) - rho) * side;
          if (g < 0) tone = 1 - tone;
          gap = Math.min(gap, Math.abs(g));
        }
      }
      total += area;
      if (gap < body * scale) {
        strand += area;
      } else if (gap < outline * scale) {
        ink += area;
      } else {
        ground0 += area * cushion * (1 - tone);
        ground1 += area * cushion * tone;
      }
    }
  }
  return [ground0 / total, ground1 / total, ink / total, strand / total];
}

// ---- Views of the plane ---------------------------------------------------------------------------

export const HYPERBOLIC_MODELS = ["disk", "band", "half-plane"] as const;
type Model = (typeof HYPERBOLIC_MODELS)[number];

/** How the models sit on screen, in screen heights. */
export const HYPERBOLIC_VIEW = {
  /** The disk's radius (times min(1, aspect), so a portrait screen holds it too). */
  disk: 0.47,
  /** The band's half-height. */
  band: 0.42,
  /** The half-plane's horizon, this far below the screen's centre. */
  horizon: 0.4,
  /** Half-plane units per screen height: the disk's centre sits just above the screen's. */
  plane: 2.2,
} as const;

/** The disk point shown at q (screen heights from the screen's centre, y up). */
function diskPoint(model: Model, q: Complex, aspect: number): Complex {
  switch (model) {
    case "disk":
      return scaled(q, 1 / (HYPERBOLIC_VIEW.disk * Math.min(1, aspect)));
    case "band":
      return tanhOf(scaled(q, Math.PI / 4 / HYPERBOLIC_VIEW.band));
    case "half-plane": {
      const w = scaled(plus(q, complex(0, HYPERBOLIC_VIEW.horizon)), HYPERBOLIC_VIEW.plane);
      return quotient(minus(w, I), plus(w, I));
    }
    default: {
      const unreachable: never = model;
      throw new Error(`hyperbolic: unknown model ${String(unreachable)}`);
    }
  }
}

/**
 * Where the disk point z shows on screen (q, screen heights from the centre), how many hyperbolic
 * units one screen height spans there (`reach`; infinite on and past the rim), and how much the
 * map turns things there (`lean`, radians).
 */
function screenPoint(
  model: Model,
  z: Complex,
  aspect: number,
): { q: Complex; reach: number; lean: number } {
  if (norm(z) >= 1) return { q: ZERO, reach: Number.POSITIVE_INFINITY, lean: 0 };
  switch (model) {
    case "disk": {
      const radius = HYPERBOLIC_VIEW.disk * Math.min(1, aspect);
      return { q: scaled(z, radius), reach: 2 / (radius * (1 - norm(z))), lean: 0 };
    }
    case "band": {
      const k = Math.PI / 4 / HYPERBOLIC_VIEW.band;
      const zeta = atanhOf(z);
      return {
        q: scaled(zeta, 1 / k),
        reach: (2 * k) / Math.max(Math.cos(2 * zeta.im), 1e-9),
        lean: -angle(minus(ONE, times(z, z))),
      };
    }
    case "half-plane": {
      const w = times(I, quotient(plus(ONE, z), minus(ONE, z)));
      const q = minus(scaled(w, 1 / HYPERBOLIC_VIEW.plane), complex(0, HYPERBOLIC_VIEW.horizon));
      return {
        q,
        reach: HYPERBOLIC_VIEW.plane / Math.max(w.im, 1e-9),
        lean: Math.PI / 2 - 2 * angle(minus(ONE, z)),
      };
    }
    default: {
      const unreachable: never = model;
      throw new Error(`hyperbolic: unknown model ${String(unreachable)}`);
    }
  }
}

// ---- Palettes -------------------------------------------------------------------------------------

export interface HyperbolicPalette {
  readonly label: string;
  /** Light page: the copy goes dark over it. */
  readonly paper: boolean;
  /** The two grounds between the strands, and the second one's breathing shade. */
  readonly ground: string;
  readonly groundAlt: string;
  readonly groundBreath: string;
  /** The strands, and their breathing shade. */
  readonly strand: string;
  readonly strandBreath: string;
  /** Outlines. */
  readonly ink: string;
  /** Beyond the plane's rim, the glow (or shadow) round it, and the rim itself. */
  readonly back: string;
  readonly glow: string;
  readonly rim: string;
  /** The light where tiles come from, and of the pulse. */
  readonly source: string;
  /** The M. */
  readonly mark: string;
  /** Light at the screen's edges, against 1 in its middle. */
  readonly lamp: number;
}

export const HYPERBOLIC_PALETTES: readonly HyperbolicPalette[] = [
  {
    label: "indigo",
    paper: false,
    ground: "#0c1020",
    groundAlt: "#17233d",
    groundBreath: "#12293a",
    strand: "#e0d1ad",
    strandBreath: "#ecc79c",
    ink: "#04050a",
    back: "#030409",
    glow: "#4c6a9e",
    rim: "#93acdc",
    source: "#f2b46e",
    mark: "#ffb347",
    lamp: 0.72,
  },
  {
    label: "jade",
    paper: false,
    ground: "#071311",
    groundAlt: "#0e2622",
    groundBreath: "#0c2229",
    strand: "#b4dcbe",
    strandBreath: "#cfe2ad",
    ink: "#020807",
    back: "#020605",
    glow: "#3f7f72",
    rim: "#8fd0bd",
    source: "#e6e59a",
    mark: "#ff8a6b",
    lamp: 0.72,
  },
  {
    label: "ember",
    paper: false,
    ground: "#160809",
    groundAlt: "#2c110d",
    groundBreath: "#2b0c18",
    strand: "#f3bd6b",
    strandBreath: "#f7a35e",
    ink: "#070203",
    back: "#050102",
    glow: "#8a3a24",
    rim: "#e38f5c",
    source: "#ffd08a",
    mark: "#8fd8ff",
    lamp: 0.72,
  },
  {
    label: "paper",
    paper: true,
    ground: "#e3d8c2",
    groundAlt: "#bcae95",
    groundBreath: "#b7ad9b",
    strand: "#faf6ec",
    strandBreath: "#f6eedb",
    ink: "#1d1b22",
    back: "#eee8db",
    glow: "#a39a8a",
    rim: "#2a2730",
    source: "#c8743e",
    mark: "#c4301f",
    lamp: 0.93,
  },
];

// ---- The state texture ----------------------------------------------------------------------------

/**
 * Texels of the state texture (rgba16f, one row), read by the shader with texelFetch. Motions are
 * (a.re, a.im, b.re, b.im) split over two texels: a coarse part, exact in half floats, then the
 * fine remainder, so the shader gets them to about 1e-6.
 */
export const HYPERBOLIC_TEXELS = {
  /** Screen disk → plane (two texels). */
  motion: 0,
  /** Screen disk → the M's tile, centred on 0 (two texels). */
  mark: 2,
  /** Strand 0's circle: centre along its bisector (coarse, fine), radius (coarse, fine). */
  arc: 4,
  /** Edges a strand spans (0: lattice), its cap side ±1, half-width, half-width with outline. */
  strand: 5,
  /** The tile's average: weights of ground, alternate ground, outline, strand. */
  average: 6,
  /** Where tiles come from on the rim (unit, screen disk), how bright it glows, the M shown 0..1. */
  source: 7,
  /** The light pulse: centre (screen disk), radius (hyperbolic), strength. */
  pulse: 8,
  /** Two breaths (−1..1), the tiles' colour flip (0/1), the M's half-height in its tile. */
  breath: 9,
  /** Spacing between strands (hyperbolic), the M's glow. */
  scale: 10,
  /** The glide's velocity on screen (turn, push.re, push.im): fast-moving detail blurs away. */
  flow: 11,
} as const;
const TEXELS = 12;

interface State {
  readonly motion: Motion;
  /** Screen disk → the M's tile, if one is placed. */
  readonly mark: Motion | undefined;
  readonly strands: Strands;
  readonly source: Complex;
  readonly focus: number;
  readonly shown: number;
  readonly glow: number;
  readonly pulse: Complex;
  readonly pulseRadius: number;
  readonly pulseStrength: number;
  readonly breath: readonly [number, number];
  readonly flip: number;
  /** The glide's velocity on screen, per second of the scene clock. */
  readonly flow: Velocity;
}

const coarse = (x: number): number => Math.round(x * 64) / 64;

/** A number as a coarse texel part and the fine remainder after it, component i of texel and texel + 1. */
function writeSplit(out: Float32Array, texel: number, i: number, value: number): void {
  const big = coarse(value);
  out[texel * 4 + i] = big;
  out[(texel + 1) * 4 + i] = value - big;
}

function writeMotion(out: Float32Array, texel: number, m: Motion): void {
  writeSplit(out, texel, 0, m.a.re);
  writeSplit(out, texel, 1, m.a.im);
  writeSplit(out, texel, 2, m.b.re);
  writeSplit(out, texel, 3, m.b.im);
}

function put(out: Float32Array, texel: number, x: number, y: number, z: number, w: number): void {
  const at = texel * 4;
  out[at] = x;
  out[at + 1] = y;
  out[at + 2] = z;
  out[at + 3] = w;
}

function writeState(out: Float32Array, state: State): void {
  const t = HYPERBOLIC_TEXELS;
  const st = state.strands;
  writeMotion(out, t.motion, state.motion);
  // A far-off M (hidden anyway) could outgrow the half floats' coarse part: leave it at rest.
  const mark = state.mark;
  const markFits = mark !== undefined && Math.max(size(mark.a), size(mark.b)) < 30;
  writeMotion(out, t.mark, markFits ? mark : STILL);
  put(out, t.arc, coarse(st.s), st.s - coarse(st.s), coarse(st.rho), st.rho - coarse(st.rho));
  put(out, t.strand, st.k, st.side, st.body, st.outline);
  put(out, t.average, st.average[0], st.average[1], st.average[2], st.average[3]);
  put(out, t.source, state.source.re, state.source.im, state.focus, markFits ? state.shown : 0);
  put(out, t.pulse, state.pulse.re, state.pulse.im, state.pulseRadius, state.pulseStrength);
  put(out, t.breath, state.breath[0], state.breath[1], state.flip, st.markHalf);
  put(out, t.scale, st.spacing, state.glow, 0, 0);
  put(out, t.flow, state.flow.turn, state.flow.push.re, state.flow.push.im, 0);
}

/** The state before the first frame: the default tiling at rest. The shader falls back on it. */
export function hyperbolicFallback(): readonly number[] {
  const out = new Float32Array(TEXELS * 4);
  const tiling = tilingOf(FIRST_TILING);
  writeState(out, {
    motion: STILL,
    mark: undefined,
    strands: strandsOf(tiling, "weave", HYPERBOLIC_DEFAULTS.spread, HYPERBOLIC_DEFAULTS.weight),
    source: polar(1, GLIDE_HEADING + Math.PI),
    focus: 1,
    shown: 0,
    glow: 0,
    pulse: ZERO,
    pulseRadius: 0,
    pulseStrength: 0,
    breath: [0, 0],
    flip: 0,
    flow: REST,
  });
  return Array.from(out);
}

// ---- The glide ------------------------------------------------------------------------------------

export const HYPERBOLIC_FLOWS = ["glide", "drift", "turn"] as const;
type Flow = (typeof HYPERBOLIC_FLOWS)[number];

/** Speed knob 1: hyperbolic units a second at the screen's centre (a tile is about one across). */
const TOP_SPEED = 0.1;
/** The disk's glide first heads up and to the right, and wheels round once in this many seconds. */
const GLIDE_HEADING = 0.55;
const WANDER_PERIOD = 420;
/** After a drag: seconds for the coasting to fade to 1/e, and for the glide to take over again. */
const COAST = 2.2;
const RESUME = 3;
/** Smoothing of the drag's velocity (seconds), its fastest coast (units a second), its longest step a frame. */
const DRAG_SMOOTH = 0.06;
const MAX_COAST = 2.5;
const MAX_DRAG_STEP = 1.2;
/** How far out a drag can grab (|z| in the disk): further out one cell spans whole tiles. */
const DRAG_REACH = 0.95;
/** The light pulse: speed (units a second), where it ends, the first one (seconds of glide), gaps. */
const PULSE_SPEED = 0.35;
const PULSE_END = 5;
const PULSE_FIRST = 9;
const PULSE_GAP_LONGEST = 90;
const PULSE_GAP_SHORTEST = 12;
/** The M: seconds to fade in or out; seconds lost from view before it returns; its hiding size. */
const MARK_FADE = 1.5;
const MARK_GRACE = 4;
/** Must match the shader's fade of the M (HYPERBOLIC_DETAIL.markTo): hyperbolic units per cell. */
const MARK_HIDE = 0.035;
/** Seconds round for the two breaths of the palette. */
const BREATHS = [43, 71] as const;

/**
 * Seconds the scene's entrance and exit take (SceneDef.passage). Entrance: the plane slides in along
 * the flow's own line from `PASSAGE_IN_REACH` hyperbolic units behind (under a tile), slowing to
 * the glide (a tiling looks the same from every tile, so it is simply a faster glide that settles).
 * Exit: it picks up speed and slides on `PASSAGE_OUT_REACH` units in the glide's direction. The
 * reaches are short and the passage speed is not given to the shader's motion blur, so the tiling
 * stays sharp and readable throughout (at most about 1.5 units a second).
 */
export const HYPERBOLIC_PASSAGE: { enter: number; exit: number } = { enter: 2.6, exit: 1.4 };
const PASSAGE_IN_REACH = 0.8;
const PASSAGE_OUT_REACH = 0.7;

/**
 * Detail fades, shared with the shader. Toward the rim tiles shrink without end, and (however slow
 * the glide is at the centre) sweep past ever faster; detail dissolves before it shimmers.
 */
export const HYPERBOLIC_DETAIL = {
  /** A strand (with its outline) dissolves as it narrows from 1/0.25 to 1/0.6 cells. */
  strandFrom: 0.25,
  strandTo: 0.6,
  /** The regions between strands dissolve as they narrow from 1/0.13 to 1/0.35 cells. */
  groundFrom: 0.13,
  groundTo: 0.35,
  /** A strand's outline, its thinnest part, thins away first: from 4 cells wide to 2. */
  outlineFrom: 4,
  outlineTo: 2,
  /**
   * Motion blur: detail dissolves where the glide carries it past at 0.6 to 1.4 strand spacings a
   * second (on the flanks of the disk, far from the line the plane glides along).
   */
  motionFrom: 0.6,
  motionTo: 1.4,
  /** The M fades as one cell grows from 0.02 to MARK_HIDE hyperbolic units. */
  markFrom: 0.02,
  markTo: MARK_HIDE,
} as const;

type KnobKey =
  "tiling" | "motif" | "spread" | "weight" | "flow" | "speed" | "pulse" | "model" | "mark";

interface Knobs {
  tiling: TilingDef;
  motif: Motif;
  spread: number;
  weight: number;
  flow: Flow;
  speed: number;
  pulse: number;
  model: Model;
  mark: number;
}

class HyperbolicSim implements SceneSim {
  readonly #texture: DataTexture;
  readonly #data = new Float32Array(TEXELS * 4);
  readonly #reader: KnobReader<KnobKey>;
  readonly #markTrigger: number;
  readonly #pulseTrigger: number;
  /** What `#read` last read: one record, rewritten each frame. */
  readonly #knobs: Knobs = {
    tiling: FIRST_TILING,
    motif: "weave",
    spread: HYPERBOLIC_DEFAULTS.spread,
    weight: HYPERBOLIC_DEFAULTS.weight,
    flow: "glide",
    speed: 0,
    pulse: 0,
    model: "disk",
    mark: 0,
  };
  readonly #random = mulberry32(7);
  #tilingDef: TilingDef | undefined;
  #tiling: Tiling;
  #strands: Strands;
  /** The motif and the spread and weight (in thousandths) the current strands were derived for. */
  #strandMotif: Motif | undefined;
  #strandSpread = 0;
  #strandWeight = 0;
  /** Screen disk → plane. */
  #motion: Motion = STILL;
  /** Tiles' colour flip from the motions traded in `settle` (lattice, even corners). */
  #flip = 0;
  /** Seconds of glide (the scene clock times motion). */
  #clock = 0;
  #steer = 1;
  #coast: Velocity = REST;
  #dragPace: Velocity = REST;
  /** The pointer's last screen-disk point while dragging, and the map and aspect it was read in. */
  #grab: Complex | undefined;
  #grabModel: Model = "disk";
  #grabAspect = 0;
  /** The central tile → the M's tile, in the plane. */
  #markTile: Motion | undefined;
  #markShown = 0;
  /** Seconds out of sight since it was last in view. */
  #markLost = 0;
  /** Whether it has come into view since it was seated, and the glide clock it should have by. */
  #markArrived = false;
  #markDue = 0;
  #markWasOn = false;
  #markOnce = false;
  /** The pulse's centre in the plane. */
  #pulseAt = ZERO;
  #pulseRadius = 0;
  #pulsing = false;
  #pulseNow = false;
  #nextPulse = PULSE_FIRST;

  constructor(gl: WebGL2RenderingContext, params: readonly ParamDef[]) {
    this.#reader = new KnobReader<KnobKey>("hyperbolic", params, [
      "tiling",
      "motif",
      "spread",
      "weight",
      "flow",
      "speed",
      "pulse",
      "model",
      "mark",
    ]);
    this.#markTrigger = this.#reader.trigger("mark");
    this.#pulseTrigger = this.#reader.trigger("pulse");
    this.#tiling = tilingOf(FIRST_TILING);
    this.#strands = strandsOf(
      this.#tiling,
      "weave",
      HYPERBOLIC_DEFAULTS.spread,
      HYPERBOLIC_DEFAULTS.weight,
    );
    this.#texture = new DataTexture(gl, {
      width: TEXELS,
      height: 1,
      format: "rgba16f",
      filter: "nearest",
    });
  }

  frame(frame: SimFrame): readonly (WebGLTexture | undefined)[] {
    const aspect = frame.aspect > 0 ? frame.aspect : 16 / 9;
    const knobs = this.#read(frame);
    this.#fit(knobs, aspect);
    const dt = Math.max(0, frame.dt);
    const glide = dt * clamp(frame.motion, 0, 1);

    this.#drag(frame.pointer, dt, aspect, knobs.model);
    const ambient = this.#ambient(knobs);
    if (this.#grab === undefined) {
      const velocity = sum(faster(ambient, this.#steer), this.#coast);
      this.#motion = compose(this.#motion, after(velocity, -glide));
      this.#coast = faster(this.#coast, Math.exp(-glide / COAST));
      this.#steer = approach(this.#steer, 1, glide, RESUME);
    }
    this.#clock += glide;
    this.#settle();
    this.#tendMark(
      knobs,
      frame.fired[this.#markTrigger] === true,
      dt,
      aspect,
      frame.height,
      ambient,
    );
    this.#tendPulse(knobs, frame.fired[this.#pulseTrigger] === true, dt, frame.motion);

    // The passage's extra travel on top of the glide (none at rest: the motion goes out as it is).
    const travel = this.#travel(frame.passage);
    const seen =
      travel.speed > 0
        ? compose(
            this.#motion,
            shift(scaled(this.#heading(knobs.model), Math.tanh(travel.lead / 2))),
          )
        : this.#motion;
    const flow = faster(ambient, this.#steer * clamp(frame.motion, 0, 1));
    const glow = knobs.mark > 0 ? knobs.mark : 0.5;
    const rimward = this.#source(knobs);
    const pulseStrength = this.#pulsing
      ? smoothstep(0, 0.4, this.#pulseRadius) * (1 - smoothstep(2, PULSE_END, this.#pulseRadius))
      : 0;
    writeState(this.#data, {
      motion: seen,
      mark: this.#markTile === undefined ? undefined : compose(inverse(this.#markTile), seen),
      strands: this.#strands,
      source: rimward.at,
      focus: rimward.glow,
      shown: this.#markShown,
      glow,
      pulse: carry(inverse(seen), this.#pulseAt),
      pulseRadius: this.#pulseRadius,
      pulseStrength,
      breath: [
        Math.sin((2 * Math.PI * this.#clock) / BREATHS[0]),
        Math.sin((2 * Math.PI * this.#clock) / BREATHS[1] + 1.7),
      ],
      flip: this.#flip,
      flow,
    });
    this.#texture.upload(this.#data);
    return [this.#texture.texture];
  }

  /**
   * The passage's travel along the glide's line. `lead` is how far ahead (hyperbolic units, signed)
   * the screen looks beyond the glide's own view: positive on the way in, so the picture sits
   * toward the rim the tiles come from; negative on the way out, so it has gone off the far side.
   * `speed` is how fast the picture moves along the glide's direction, units a second; 0 at rest.
   */
  #travel(passage: Readonly<ScenePassageProgress>): { lead: number; speed: number } {
    const arriving = 1 - clamp(passage.enter, 0, 1);
    const leaving = clamp(passage.exit, 0, 1);
    // Cubic ease-out in, cubic ease-in out: the distance is reach · (1 − s)³ in, reach · u³ out.
    const lead = PASSAGE_IN_REACH * arriving ** 3 - PASSAGE_OUT_REACH * leaving ** 3;
    const speed =
      (3 * PASSAGE_IN_REACH * arriving ** 2) / HYPERBOLIC_PASSAGE.enter +
      (3 * PASSAGE_OUT_REACH * leaving ** 2) / HYPERBOLIC_PASSAGE.exit;
    return { lead, speed };
  }

  dispose(): void {
    this.#texture.dispose();
  }

  /** The knobs as the shader sees them, written into the sim's one `Knobs` record. */
  #read(frame: SimFrame): Knobs {
    const knobs = this.#knobs;
    const reader = this.#reader;
    knobs.tiling = reader.pick(frame, "tiling", HYPERBOLIC_TILINGS, FIRST_TILING);
    knobs.motif = reader.pick(frame, "motif", HYPERBOLIC_MOTIFS, "weave");
    knobs.spread = clamp(reader.value(frame, "spread"), 0.15, 0.85);
    knobs.weight = clamp(reader.value(frame, "weight"), 0.05, 1);
    knobs.flow = reader.pick(frame, "flow", HYPERBOLIC_FLOWS, "glide");
    knobs.speed = Math.max(0, reader.value(frame, "speed"));
    knobs.pulse = Math.max(0, reader.value(frame, "pulse"));
    knobs.model = reader.pick(frame, "model", HYPERBOLIC_MODELS, "disk");
    knobs.mark = Math.max(0, reader.value(frame, "mark"));
    return knobs;
  }

  /** A new tiling or new strands: re-derive the geometry. A new tiling also re-seats the M. */
  #fit(knobs: Knobs, aspect: number): void {
    if (knobs.tiling !== this.#tilingDef) {
      const fresh = this.#tilingDef !== undefined;
      this.#tilingDef = knobs.tiling;
      this.#tiling = tilingOf(knobs.tiling);
      this.#flip = 0;
      this.#strandMotif = undefined;
      if (fresh && this.#markTile !== undefined) {
        this.#seatMark(ZERO, knobs.model, aspect);
        this.#markShown = 0;
      }
    }
    const spread = Math.round(knobs.spread * 1000);
    const weight = Math.round(knobs.weight * 1000);
    if (
      knobs.motif !== this.#strandMotif ||
      spread !== this.#strandSpread ||
      weight !== this.#strandWeight
    ) {
      this.#strandMotif = knobs.motif;
      this.#strandSpread = spread;
      this.#strandWeight = weight;
      this.#strands = strandsOf(this.#tiling, knobs.motif, knobs.spread, knobs.weight);
    }
  }

  /** The flow the plane glides on, as a velocity of the screen. */
  #ambient(knobs: Knobs): Velocity {
    const v = knobs.speed * TOP_SPEED;
    const heading = this.#heading(knobs.model);
    switch (knobs.flow) {
      case "glide":
        // Along the line through the centre toward `heading`: tiles rise out of the rim behind it.
        return { turn: 0, push: scaled(heading, v / 2) };
      case "drift":
        // A parabolic flow fixing the rim point `heading`: tiles loop out of it and back in.
        return { turn: v / 2, push: times(complex(0, -v / 2), heading) };
      case "turn":
        // About the centre, at speed v a unit and a bit out from it.
        return { turn: v / 3, push: ZERO };
      default: {
        const unreachable: never = knobs.flow;
        throw new Error(`hyperbolic: unknown flow ${String(unreachable)}`);
      }
    }
  }

  /** The disk glides along a slowly wheeling line; the band and the half-plane along their axis. */
  #heading(model: Model): Complex {
    return model === "disk"
      ? polar(1, GLIDE_HEADING + (2 * Math.PI * this.#clock) / WANDER_PERIOD)
      : ONE;
  }

  /** The rim point tiles come from, and how brightly it glows. */
  #source(knobs: Knobs): { at: Complex; glow: number } {
    const heading = this.#heading(knobs.model);
    const glow = clamp(knobs.speed / 0.15, 0, 1);
    switch (knobs.flow) {
      case "glide":
        return { at: scaled(heading, -1), glow };
      case "drift":
        return { at: heading, glow };
      case "turn":
        return { at: heading, glow: 0 };
      default: {
        const unreachable: never = knobs.flow;
        throw new Error(`hyperbolic: unknown flow ${String(unreachable)}`);
      }
    }
  }

  /** The pointer's screen-disk point, kept off the rim. */
  #pointerPoint(pointer: PrincipalState, aspect: number, model: Model): Complex {
    const z = diskPoint(model, complex((pointer.x - 0.5) * aspect, pointer.y - 0.5), aspect);
    const r = size(z);
    return r > DRAG_REACH ? scaled(z, DRAG_REACH / r) : z;
  }

  /**
   * Hold and drag: the plane follows the pointer, the point grabbed staying under it (each frame a
   * translation along the line from the pointer's last point to its new one). Let go: it coasts on
   * at the drag's speed, slowing, and the glide takes over again. A new map or a new screen shape
   * mid-drag moves every point on screen, not the hand: the grip is taken again where the pointer
   * now is, and the plane neither jumps nor flings off at the speed of that jump.
   */
  #drag(pointer: PrincipalState, dt: number, aspect: number, model: Model): void {
    if (this.#grab === undefined) {
      if (pointer.down && pointer.inside) {
        this.#grab = this.#pointerPoint(pointer, aspect, model);
        this.#grabModel = model;
        this.#grabAspect = aspect;
        this.#dragPace = REST;
      }
      return;
    }
    if (!pointer.down || !pointer.inside) {
      const fast = pace(this.#dragPace);
      this.#coast = fast > MAX_COAST ? faster(this.#dragPace, MAX_COAST / fast) : this.#dragPace;
      this.#steer = 0;
      this.#grab = undefined;
      return;
    }
    const now = this.#pointerPoint(pointer, aspect, model);
    if (model !== this.#grabModel || aspect !== this.#grabAspect) {
      this.#grab = now;
      this.#grabModel = model;
      this.#grabAspect = aspect;
      return;
    }
    const last = this.#grab;
    // The last point seen from the new one; the step is the translation taking now to last there.
    let m = carry(shift(scaled(now, -1)), last);
    const reach = Math.tanh(MAX_DRAG_STEP / 2);
    const n = size(m);
    if (n > reach) m = scaled(m, reach / n);
    const toNow = shift(now);
    const step = compose(toNow, compose(shift(m), inverse(toNow)));
    this.#motion = compose(this.#motion, step);
    if (dt > 0) {
      const length = size(m);
      const log: Velocity =
        length > 1e-12 ? { turn: 0, push: scaled(m, Math.atanh(length) / length) } : REST;
      // The picture moved last → now: the inverse step, per second.
      const velocity = faster(seenFrom(toNow, log), -1 / dt);
      const k = easeFactor(dt, DRAG_SMOOTH);
      this.#dragPace = sum(this.#dragPace, faster(sum(velocity, faster(this.#dragPace, -1)), k));
    }
    this.#grab = now;
  }

  /** Trade the motion for the equivalent one that keeps the screen's centre in the central tile. */
  #settle(): void {
    const map = foldOf(carry(this.#motion, ZERO), this.#tiling);
    const g = asMotion(map);
    this.#motion = tidy(compose(g, this.#motion));
    if (this.#markTile !== undefined) this.#markTile = tidy(compose(g, this.#markTile));
    this.#pulseAt = carry(g, this.#pulseAt);
    this.#flip = (this.#flip + map.edges) % 2;
  }

  /** Put the M on the tile under the screen-disk point z, turned to stand upright on screen. */
  #seatMark(z: Complex, model: Model, aspect: number): void {
    const t = this.#tiling;
    const tile = inverse(asMotion(foldOf(carry(this.#motion, z), t)));
    const onScreen = compose(inverse(this.#motion), tile);
    const lean = 2 * angle(onScreen.a) + screenPoint(model, carry(onScreen, ZERO), aspect).lean;
    // Turned by whole sectors, a symmetry of the tile, so the M stands within ±π/p of upright.
    const turn = Math.round(-lean / t.sector) * t.sector;
    this.#markTile = compose(tile, { a: polar(1, turn / 2), b: ZERO });
  }

  #markHidden(z: Complex, model: Model, aspect: number, height: number): boolean {
    const at = screenPoint(model, z, aspect);
    const x = at.q.re / aspect + 0.5;
    const y = at.q.im + 0.5;
    return (
      !(at.reach / Math.max(1, height) < MARK_HIDE) ||
      x < -0.05 ||
      x > 1.05 ||
      y < -0.05 ||
      y > 1.05
    );
  }

  /**
   * One tile carries the M. "Now" (or switching it on) sets it on the tile in the middle of the
   * screen; it rides the glide out to the rim, and while the knob is on, comes back on a tile far
   * upstream, out of sight, that the glide will bring through the middle again.
   */
  #tendMark(
    knobs: Knobs,
    now: boolean,
    dt: number,
    aspect: number,
    height: number,
    ambient: Velocity,
  ): void {
    const on = knobs.mark > 0;
    if (now || (on && !this.#markWasOn)) {
      this.#seatMark(ZERO, knobs.model, aspect);
      this.#markShown = 0;
      this.#markLost = 0;
      this.#markArrived = false;
      this.#markDue = this.#clock + MARK_GRACE;
      this.#markOnce = !on;
    }
    this.#markWasOn = on;
    if (this.#markTile !== undefined) {
      // Lost: out of sight a while after it has been in view, or never come into view by when the
      // glide should have brought it (the flow changed on the way).
      const centre = carry(compose(inverse(this.#motion), this.#markTile), ZERO);
      if (!this.#markHidden(centre, knobs.model, aspect, height)) {
        this.#markArrived = true;
        this.#markLost = 0;
      } else if (this.#markArrived) {
        this.#markLost += dt;
      }
      if (this.#markLost > MARK_GRACE || (!this.#markArrived && this.#clock > this.#markDue)) {
        this.#markLost = 0;
        if (on) {
          const upstream = this.#upstream(ambient, knobs.model, aspect, height);
          this.#seatMark(upstream.at, knobs.model, aspect);
          this.#markShown = 0;
          this.#markArrived = false;
          this.#markDue = this.#clock + 1.5 * upstream.after + MARK_GRACE;
        } else {
          this.#markTile = undefined;
          this.#markOnce = false;
        }
      }
    }
    const target = this.#markTile !== undefined && (on || this.#markOnce) ? 1 : 0;
    this.#markShown = approach(this.#markShown, target, dt, MARK_FADE);
    if (target === 0 && this.#markShown < 0.002) {
      this.#markTile = undefined;
      this.#markShown = 0;
    }
  }

  /**
   * The first point upstream of the screen's centre that is out of sight, and the seconds of glide
   * it takes to reach the centre (the centre itself if the flow never hides it).
   */
  #upstream(
    ambient: Velocity,
    model: Model,
    aspect: number,
    height: number,
  ): { at: Complex; after: number } {
    const fast = pace(ambient);
    if (fast < 1e-6) return { at: ZERO, after: 0 };
    const stride = 0.3 / fast;
    for (let i = 1; i <= 48; i++) {
      const z = carry(after(ambient, -i * stride), ZERO);
      if (this.#markHidden(z, model, aspect, height)) return { at: z, after: i * stride };
    }
    return { at: ZERO, after: 0 };
  }

  /**
   * Now and then a ring of light leaves the screen's centre and spreads through the plane at a
   * steady pace, carried along by the glide. "Now" sends one at once, even with motion off.
   */
  #tendPulse(knobs: Knobs, now: boolean, dt: number, motion: number): void {
    const start = now || (!this.#pulsing && knobs.pulse > 0 && this.#clock >= this.#nextPulse);
    if (start) {
      this.#pulseAt = carry(this.#motion, ZERO);
      this.#pulseRadius = 0;
      this.#pulsing = true;
      this.#pulseNow = now;
    }
    if (knobs.pulse <= 0 && !this.#pulsing) this.#nextPulse = this.#clock + PULSE_FIRST;
    if (!this.#pulsing) return;
    this.#pulseRadius += dt * Math.max(clamp(motion, 0, 1), this.#pulseNow ? 1 : 0) * PULSE_SPEED;
    if (this.#pulseRadius > PULSE_END) {
      this.#pulsing = false;
      const gap =
        PULSE_GAP_LONGEST + (PULSE_GAP_SHORTEST - PULSE_GAP_LONGEST) * clamp(knobs.pulse, 0, 1);
      this.#nextPulse = this.#clock + gap * (0.75 + 0.5 * this.#random());
    }
  }
}

export const hyperbolicSim =
  (params: readonly ParamDef[]): SimFactory =>
  (gl) =>
    new HyperbolicSim(gl, params);
