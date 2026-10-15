// Plant morphology for the pond's foliage, drawn with Canvas 2D into the plant atlas (decor.ts): the
// sprites its simulated border plants are cut from. Their stems and roots are drawn on the GPU.
//
// Leaf outlines follow the leaf-shape model of Coussement et al. (2018), "A flexible geometric
// model for leaf shape descriptions with high accuracy", Silva Fennica 52(2), doi:10.14214/sf.7740,
// a refinement of Young (2010). Each point j along the midrib (0 at the stalk, 1 at the tip) is
// carried out to the margin by a vector. Its length rises to 1 at the widest point jd and falls to
// 0 at base and tip, with exponents k1 and k2 setting how bluntly. It also tilts: toward the base
// near the base and toward the tip near the tip, with strengths b1, b2 and rates p1, p2. The tilt
// draws cordate lobes reaching back past the stalk, and blunt or drawn-out tips. Each half of the
// blade has its own parameters, so leaves can be lopsided as real ones are.
//
// Everything inside a blade (veins, Monstera's splits and holes, banana tears) is placed in the
// same (j, t) coordinates, t being the fraction of the way from midrib to margin, so it follows the
// leaf's own geometry.
//
// Leaves are drawn in unit space: stalk at (0, 0), tip toward (1, 0). Flowers are centred, radius 1.

export type Context = OffscreenCanvasRenderingContext2D;
export type Rand = () => number;
type Point = [number, number];

/** What a pixel of foliage is made of; the shader colours each one. */
export const Material = {
  monstera: 0,
  fern: 1,
  banana: 2,
  pothos: 3,
  hibiscus: 4,
  frangipani: 5,
  pollen: 6,
  grass: 7,
  stem: 8,
  root: 9,
  stigma: 10,
} as const;
export type MaterialId = (typeof Material)[keyof typeof Material];

/** The layer (0 back … 2 front) and base lightness a plant is drawn with. */
export interface Brush {
  layer: number;
  shade: number;
}

/** Sheet encoding: R coverage, G shade, B material × 16 + layer × 4 + 2. */
export function ink(material: MaterialId, brush: Brush, shade: number): string {
  const g = Math.round(Math.min(1, Math.max(0, shade)) * 255);
  return `rgb(255, ${g}, ${material * 16 + brush.layer * 4 + 2})`;
}

// ---------------------------------------------------------------------------------------------
// The blade model

/** One half of a blade, in Coussement et al.'s parameters; width is relative to length 1. */
interface HalfBlade {
  width: number;
  jd: number;
  k1: number;
  k2: number;
  b1: number;
  p1: number;
  b2: number;
  p2: number;
}

interface BladeShape {
  /** The half on the -y side of the midrib. */
  upper: HalfBlade;
  lower: HalfBlade;
  /** Sideways arc of the midrib. */
  bend: number;
  /** Rounded teeth along the margin. */
  crenate?: { count: number; depth: number };
}

function vector(half: HalfBlade, j: number): { length: number; slope: number } {
  if (j <= half.jd) {
    const u = (half.jd - j) / half.jd;
    return { length: 1 - u ** half.k1, slope: -half.b1 * u ** half.p1 };
  }
  const u = (j - half.jd) / (1 - half.jd);
  return { length: 1 - u ** half.k2, slope: half.b2 * u ** half.p2 };
}

/** The point a fraction t of the way from the midrib at j to the margin on one side. */
function at(shape: BladeShape, j: number, t: number, side: 1 | -1): Point {
  const half = side > 0 ? shape.upper : shape.lower;
  const clamped = Math.min(1, Math.max(0, j));
  const { length, slope } = vector(half, clamped);
  const teeth = shape.crenate ? 1 - shape.crenate.depth * Math.abs(Math.sin(Math.PI * shape.crenate.count * clamped)) ** 0.6 : 1;
  const theta = Math.atan(slope);
  const r = t * Math.max(0, length) * teeth * half.width;
  const x = clamped + r * Math.sin(theta);
  const y = -side * r * Math.cos(theta);
  return [x, y + shape.bend * x * x];
}

const MARGIN_STEPS = 96;

function halfPath(shape: BladeShape, side: 1 | -1): Path2D {
  const path = new Path2D();
  path.moveTo(...at(shape, 0, 0, side));
  for (let i = 0; i <= MARGIN_STEPS; i++) path.lineTo(...at(shape, i / MARGIN_STEPS, 1, side));
  for (let i = MARGIN_STEPS; i >= 0; i--) path.lineTo(...at(shape, i / MARGIN_STEPS, 0, side));
  path.closePath();
  return path;
}

/** A polygon given in blade coordinates (j, t) on one side. */
function region(shape: BladeShape, side: 1 | -1, points: readonly Point[]): Path2D {
  const path = new Path2D();
  points.forEach(([j, t], index) => {
    const [x, y] = at(shape, j, t, side);
    if (index === 0) path.moveTo(x, y);
    else path.lineTo(x, y);
  });
  path.closePath();
  return path;
}

/** Stroke a curve given in blade coordinates. */
function trace(ctx: Context, shape: BladeShape, side: 1 | -1, curve: (u: number) => Point, steps = 24): void {
  ctx.beginPath();
  for (let i = 0; i <= steps; i++) {
    const [j, t] = curve(i / steps);
    const [x, y] = at(shape, j, t, side);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

/** Fill both halves, one a little darker: blades fold along the midrib and catch light unevenly. */
function fillBlade(ctx: Context, shape: BladeShape, material: MaterialId, brush: Brush, rand: Rand): void {
  const lit = rand() < 0.5 ? 1 : -1;
  for (const side of [1, -1] as const) {
    const shade = brush.shade * (side === lit ? 1.08 : 0.86);
    const gradient = ctx.createLinearGradient(0, 0, 1, 0);
    gradient.addColorStop(0, ink(material, brush, shade * 0.78));
    gradient.addColorStop(0.6, ink(material, brush, shade));
    gradient.addColorStop(1, ink(material, brush, shade * 1.1));
    ctx.fillStyle = gradient;
    ctx.fill(halfPath(shape, side));
  }
}

/** Natural variation: every parameter nudged by up to ±amount. */
function vary(half: HalfBlade, rand: Rand, amount: number): HalfBlade {
  const n = (value: number) => value * (1 + (rand() * 2 - 1) * amount);
  return { width: n(half.width), jd: n(half.jd), k1: n(half.k1), k2: n(half.k2), b1: n(half.b1), p1: n(half.p1), b2: n(half.b2), p2: n(half.p2) };
}

function midrib(ctx: Context, shape: BladeShape, material: MaterialId, brush: Brush, shade: number, width: number, end = 0.97): void {
  ctx.strokeStyle = ink(material, brush, shade);
  ctx.lineCap = "round";
  // Tapering: three passes, each thinner and shorter.
  for (const [scale, reach] of [[1, end * 0.45], [0.7, end * 0.75], [0.45, end]] as const) {
    ctx.lineWidth = width * scale;
    trace(ctx, shape, 1, (u) => [u * reach, 0], 16);
  }
}

// ---------------------------------------------------------------------------------------------
// Monstera deliciosa

/**
 * Cordate-ovate, about as broad as long (25–90 × 25–75 cm), the base lobes reaching back past the
 * petiole, a short point at the tip.
 */
const MONSTERA: HalfBlade = { width: 0.47, jd: 0.38, k1: 3.5, k2: 1.25, b1: 2, p1: 0.6, b2: 0.3, p2: 2 };

/**
 * A mature Monstera leaf: primary veins arc from the midrib toward the margin, sweeping to the tip.
 * Deep incisions open between them at the margin and run part way to the midrib; holes
 * (fenestrations) sit in a row beside the midrib between the veins, elongated along them. Basal
 * lobes and the tip stay entire. `maturity` 0..1 sets how incised and perforated the leaf is.
 */
export function monsteraLeaf(ctx: Context, brush: Brush, rand: Rand, maturity: number): void {
  const shape: BladeShape = { upper: vary(MONSTERA, rand, 0.06), lower: vary(MONSTERA, rand, 0.06), bend: (rand() - 0.5) * 0.08 };
  fillBlade(ctx, shape, Material.monstera, brush, rand);
  const veins = 8 + Math.floor(rand() * 3);
  // Where primary vein k leaves the midrib, and how it sweeps toward the tip on its way out.
  const origin = (k: number) => 0.03 + (k / veins) * 0.86;
  const course = (j0: number, t: number): number => j0 + (0.05 + 0.14 * j0) * t ** 1.4;
  for (const side of [1, -1] as const) {
    ctx.save();
    ctx.clip(halfPath(shape, side));
    ctx.strokeStyle = ink(Material.monstera, brush, Math.min(1, brush.shade * 1.35));
    ctx.lineWidth = 0.007;
    ctx.lineCap = "round";
    for (let k = 0; k <= veins; k++) trace(ctx, shape, side, (u) => [course(origin(k), u * 0.98), u * 0.98]);
    ctx.restore();
  }
  midrib(ctx, shape, Material.monstera, brush, Math.min(1, brush.shade * 1.5), 0.024);

  ctx.globalCompositeOperation = "destination-out";
  for (const side of [1, -1] as const) {
    for (let k = 1; k < veins - 1; k++) {
      const jm = (origin(k) + origin(k + 1)) / 2;
      const spacing = origin(k + 1) - origin(k);
      // Incision: a slot along the middle of the intercostal strip, opening at the margin.
      if (rand() < 0.35 + 0.6 * maturity) {
        const depth = 0.18 + 0.32 * rand() + 0.25 * (1 - maturity);
        const gap = spacing * (0.16 + 0.14 * rand());
        const edge = (t: number, sign: number): Point => {
          const open = Math.sqrt(Math.max(0, (t - depth) / (1 - depth)));
          return [course(jm, t) + sign * gap * (0.35 + 0.65 * open) * 0.5 * Math.min(1, open * 3), t];
        };
        const points: Point[] = [];
        for (let i = 0; i <= 16; i++) points.push(edge(depth + ((1.25 - depth) * i) / 16, -1));
        for (let i = 16; i >= 0; i--) points.push(edge(depth + ((1.25 - depth) * i) / 16, 1));
        ctx.fill(region(shape, side, points));
      }
      // Fenestration beside the midrib, elongated along the veins.
      if (rand() < 0.25 + 0.7 * maturity) {
        const centre = 0.17 + 0.08 * rand();
        const reach = 0.06 + 0.04 * rand();
        const half = spacing * (0.12 + 0.08 * rand());
        const points: Point[] = [];
        for (let i = 0; i < 20; i++) {
          const a = (i / 20) * Math.PI * 2;
          const t = centre + Math.cos(a) * reach;
          points.push([course(jm, t) + Math.sin(a) * half, t]);
        }
        ctx.fill(region(shape, side, points));
      }
    }
  }
  ctx.globalCompositeOperation = "source-over";
}

// ---------------------------------------------------------------------------------------------
// Musa (banana)

/** Oblong, 2.4–3 times longer than wide, rounded base, blunt truncate apex. */
const BANANA: HalfBlade = { width: 0.185, jd: 0.45, k1: 2.4, k2: 3.4, b1: 0.8, p1: 2.5, b2: 1.1, p2: 3 };

/**
 * A banana leaf: the petiole continues as a stout pale midrib; unbranched lamina veins run
 * parallel in a long S from midrib to margin. Because they never branch, wind tears the blade along
 * them from the margin inward, splitting it into strips. `wear` 0..1 sets how torn it is.
 */
export function bananaLeaf(ctx: Context, brush: Brush, rand: Rand, wear: number): void {
  const shape: BladeShape = { upper: vary(BANANA, rand, 0.05), lower: vary({ ...BANANA, width: BANANA.width * 0.92 }, rand, 0.05), bend: (rand() - 0.5) * 0.06 };
  fillBlade(ctx, shape, Material.banana, brush, rand);
  // The long S: leaving the midrib toward the tip, crossing nearly square, curving tipward again at the margin.
  const course = (j0: number, t: number): number => j0 + 0.018 * Math.min(1, t / 0.12) + 0.05 * t ** 4;
  const veins = 54;
  for (const side of [1, -1] as const) {
    ctx.save();
    ctx.clip(halfPath(shape, side));
    ctx.strokeStyle = ink(Material.banana, brush, Math.min(1, brush.shade * 1.16));
    ctx.lineWidth = 0.0028;
    for (let k = 0; k < veins; k++) {
      const j0 = 0.01 + (k / veins) * 0.97;
      trace(ctx, shape, side, (u) => [course(j0, u * 1.02), u * 1.02], 10);
    }
    ctx.restore();
  }
  midrib(ctx, shape, Material.banana, brush, Math.min(1, brush.shade * 1.6), 0.036, 0.99);

  ctx.globalCompositeOperation = "destination-out";
  const tears = Math.round(3 + wear * 18 * (0.5 + rand()));
  for (let n = 0; n < tears; n++) {
    const side: 1 | -1 = rand() < 0.5 ? 1 : -1;
    const j0 = 0.12 + rand() * 0.8;
    const depth = 0.04 + 0.85 * rand() ** 0.7;
    const gap = 0.006 + 0.014 * rand();
    const points: Point[] = [];
    for (let i = 0; i <= 10; i++) {
      const t = depth + ((1.3 - depth) * i) / 10;
      points.push([course(j0, t) - gap * ((t - depth) / (1.3 - depth)) ** 0.6, t]);
    }
    for (let i = 10; i >= 0; i--) {
      const t = depth + ((1.3 - depth) * i) / 10;
      points.push([course(j0, t) + gap * ((t - depth) / (1.3 - depth)) ** 0.6, t]);
    }
    ctx.fill(region(shape, side, points));
  }
  ctx.globalCompositeOperation = "source-over";
}

// ---------------------------------------------------------------------------------------------
// Nephrolepis (Boston fern)

/**
 * A pinna (leaflet): linear-lanceolate and slightly sickle-shaped, with an auricle (ear) on the
 * side facing the frond tip and a finely scalloped margin.
 */
const PINNA_UPPER: HalfBlade = { width: 0.21, jd: 0.25, k1: 1.6, k2: 1.9, b1: 1.6, p1: 0.6, b2: 0.2, p2: 2 };
const PINNA_LOWER: HalfBlade = { width: 0.17, jd: 0.3, k1: 1.4, k2: 1.9, b1: 0.3, p1: 1, b2: 0.2, p2: 2 };

/**
 * A Boston fern frond: a bare stipe, then an arching rachis carrying alternate pinnae, nearly
 * square to it at the base and angled toward the tip further up. The pinnae are longest about a
 * third of the way along and shorten to both ends.
 */
export function fernFrond(ctx: Context, brush: Brush, rand: Rand): void {
  const curl = (rand() - 0.5) * 0.35;
  const rachis = (s: number): [number, number, number] => {
    const y = curl * (2 * (1 - s) * s + s * s * 0.7) + 0.05 * curl * s ** 4;
    const dy = curl * (2 * (1 - 2 * s) + 1.4 * s) + 0.2 * curl * s ** 3;
    return [s, y, Math.atan2(dy, 1)];
  };
  const stipe = 0.12;
  const pairs = 30 + Math.floor(rand() * 6);
  for (const side of [1, -1] as const) {
    for (let i = 0; i < pairs; i++) {
      // Alternate: one side sits half a step ahead of the other.
      const u = (i + (side > 0 ? 0 : 0.5)) / pairs;
      const s = stipe + (1 - stipe) * u * 0.98;
      const [x, y, heading] = rachis(s);
      const length = 0.15 * Math.sin(Math.PI * Math.min(1, 0.06 + u * 0.94)) ** 0.7 * (1.05 - 0.35 * u) + 0.012;
      const shape: BladeShape = {
        upper: vary(PINNA_UPPER, rand, 0.08),
        lower: vary(PINNA_LOWER, rand, 0.08),
        bend: 0.12,
        crenate: { count: 6, depth: 0.08 },
      };
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(heading + side * (1.35 - 0.5 * u));
      // The auricle faces the frond tip on both sides.
      ctx.scale(length, length * side);
      const pinnaBrush = { layer: brush.layer, shade: brush.shade * (0.85 + 0.3 * u) };
      ctx.fillStyle = ink(Material.fern, brush, pinnaBrush.shade);
      ctx.fill(halfPath(shape, 1));
      ctx.fillStyle = ink(Material.fern, brush, pinnaBrush.shade * 0.88);
      ctx.fill(halfPath(shape, -1));
      ctx.strokeStyle = ink(Material.fern, brush, Math.min(1, pinnaBrush.shade * 1.25));
      ctx.lineWidth = 0.03;
      trace(ctx, shape, 1, (v) => [v * 0.9, 0], 8);
      ctx.restore();
    }
  }
  ctx.lineCap = "round";
  ctx.strokeStyle = ink(Material.stem, brush, 0.35);
  ctx.lineWidth = 0.012;
  ctx.beginPath();
  for (let i = 0; i <= 30; i++) {
    const [x, y] = rachis(i / 30);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

// ---------------------------------------------------------------------------------------------
// Epipremnum (pothos)

/** Cordate-ovate with a drawn-out (acuminate) tip, noticeably lopsided. */
const POTHOS_UPPER: HalfBlade = { width: 0.36, jd: 0.34, k1: 3.2, k2: 0.85, b1: 1.8, p1: 0.6, b2: -0.15, p2: 1.5 };
const POTHOS_LOWER: HalfBlade = { width: 0.31, jd: 0.31, k1: 3.0, k2: 0.85, b1: 1.5, p1: 0.6, b2: -0.15, p2: 1.5 };

/** A pothos leaf: glossy, cordate, a few arcuate veins curving toward the tip. */
export function pothosLeaf(ctx: Context, brush: Brush, rand: Rand): void {
  const shape: BladeShape = { upper: vary(POTHOS_UPPER, rand, 0.08), lower: vary(POTHOS_LOWER, rand, 0.08), bend: (rand() - 0.5) * 0.12 };
  fillBlade(ctx, shape, Material.pothos, brush, rand);
  for (const side of [1, -1] as const) {
    ctx.save();
    ctx.clip(halfPath(shape, side));
    ctx.strokeStyle = ink(Material.pothos, brush, Math.min(1, brush.shade * 1.3));
    ctx.lineWidth = 0.012;
    for (let k = 0; k < 5; k++) {
      const j0 = 0.06 + k * 0.13;
      trace(ctx, shape, side, (u) => [j0 + (0.12 + 0.2 * j0) * u ** 1.5, u * 0.88], 12);
    }
    ctx.restore();
  }
  midrib(ctx, shape, Material.pothos, brush, Math.min(1, brush.shade * 1.4), 0.03, 0.9);
}

// ---------------------------------------------------------------------------------------------
// Grass

/**
 * A tuft of grass, rooted at (0, 0) and leaning toward +x, unit = tallest blade. Each blade is a
 * quadratic Bézier with facing, length, width, bend and droop, tapering to a point - the
 * per-blade parameters of Ghost of Tsushima's procedural grass (Wohllaib, GDC 2021) seen from above.
 */
export function grassTuft(ctx: Context, brush: Brush, rand: Rand, blades: number): void {
  const order = Array.from({ length: blades }, () => rand()).sort((a, b) => a - b);
  for (const depth of order) {
    const facing = (rand() - 0.5) * 2.2 * (0.5 + 0.5 * rand());
    const length = 0.45 + 0.55 * rand();
    const width = 0.03 + 0.025 * rand();
    const bend = (rand() - 0.5) * 0.7;
    const root: Point = [(rand() - 0.5) * 0.06, (rand() - 0.5) * 0.06];
    const dx = Math.cos(facing);
    const dy = Math.sin(facing);
    const control: Point = [root[0] + dx * length * 0.55 - dy * bend * length * 0.3, root[1] + dy * length * 0.55 + dx * bend * length * 0.3];
    const tip: Point = [root[0] + dx * length - dy * bend * length, root[1] + dy * length + dx * bend * length];
    const point = (t: number): Point => {
      const u = 1 - t;
      return [u * u * root[0] + 2 * u * t * control[0] + t * t * tip[0], u * u * root[1] + 2 * u * t * control[1] + t * t * tip[1]];
    };
    const left: Point[] = [];
    const right: Point[] = [];
    const steps = 14;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const [x0, y0] = point(Math.max(0, t - 0.01));
      const [x1, y1] = point(Math.min(1, t + 0.01));
      const norm = Math.hypot(x1 - x0, y1 - y0) || 1;
      const nx = -(y1 - y0) / norm;
      const ny = (x1 - x0) / norm;
      const w = width * (1 - t) ** 0.75;
      const [x, y] = point(t);
      left.push([x + nx * w, y + ny * w]);
      right.push([x - nx * w, y - ny * w]);
    }
    const shade = brush.shade * (0.7 + 0.5 * depth);
    const gradient = ctx.createLinearGradient(root[0], root[1], tip[0], tip[1]);
    gradient.addColorStop(0, ink(Material.grass, brush, shade * 0.55));
    gradient.addColorStop(1, ink(Material.grass, brush, Math.min(1, shade * 1.15)));
    ctx.fillStyle = gradient;
    ctx.beginPath();
    [...left, ...right.reverse()].forEach(([x, y], index) => (index === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.closePath();
    ctx.fill();
  }
}

// ---------------------------------------------------------------------------------------------
// Flowers

/** Hibiscus petal: obovate, narrow at the base, broad rounded apex. */
const HIBISCUS_PETAL: HalfBlade = { width: 0.46, jd: 0.68, k1: 0.9, k2: 2.6, b1: 0, p1: 1, b2: 0.6, p2: 2 };

/**
 * Hibiscus rosa-sinensis: five obovate petals overlapping in a spiral (contorted), each with a
 * dark eye at its base and fine radiating veins, ruffled at the rim. The staminal column rises
 * from the centre past the petals, anthers along its outer part and five red stigma pads at its tip.
 */
export function hibiscusFlower(ctx: Context, brush: Brush, rand: Rand): void {
  const turn = rand() * Math.PI * 2;
  for (let i = 0; i < 5; i++) {
    const shape: BladeShape = {
      upper: vary(HIBISCUS_PETAL, rand, 0.06),
      lower: vary(HIBISCUS_PETAL, rand, 0.06),
      bend: 0,
      crenate: { count: 6, depth: 0.04 },
    };
    ctx.save();
    ctx.rotate(turn + (i / 5) * Math.PI * 2);
    const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    gradient.addColorStop(0, ink(Material.stigma, brush, 0.1));
    gradient.addColorStop(0.2, ink(Material.hibiscus, brush, 0.12));
    gradient.addColorStop(0.45, ink(Material.hibiscus, brush, brush.shade));
    gradient.addColorStop(1, ink(Material.hibiscus, brush, Math.min(1, brush.shade * 1.2)));
    ctx.fillStyle = gradient;
    ctx.fill(halfPath(shape, 1));
    ctx.fill(halfPath(shape, -1));
    ctx.strokeStyle = ink(Material.hibiscus, brush, brush.shade * 0.7);
    ctx.lineWidth = 0.008;
    for (let k = -3; k <= 3; k++) trace(ctx, shape, k < 0 ? -1 : 1, (u) => [0.08 + u * 0.82, (Math.abs(k) / 3.5) * u * 0.9], 8);
    // The overlapping edge of the next petal reads as a soft fold.
    ctx.strokeStyle = ink(Material.hibiscus, brush, brush.shade * 0.6);
    ctx.lineWidth = 0.02;
    trace(ctx, shape, 1, (u) => [0.15 + u * 0.8, 1], 16);
    ctx.restore();
  }
  const column = turn + rand() * Math.PI * 2;
  const cx = Math.cos(column);
  const cy = Math.sin(column);
  ctx.lineCap = "round";
  ctx.strokeStyle = ink(Material.hibiscus, brush, 0.55);
  ctx.lineWidth = 0.05;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(cx * 1.05, cy * 1.05);
  ctx.stroke();
  ctx.fillStyle = ink(Material.pollen, brush, 0.95);
  for (let i = 0; i < 14; i++) {
    const along = 0.6 + rand() * 0.38;
    const off = (rand() - 0.5) * 0.14;
    ctx.beginPath();
    ctx.arc(cx * along - cy * off, cy * along + cx * off, 0.028, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = ink(Material.stigma, brush, 0.8);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(cx * 1.12 + Math.cos(a) * 0.055, cy * 1.12 + Math.sin(a) * 0.055, 0.035, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Frangipani petal: spatulate, lopsided, narrowing to a slender claw. */
const FRANGIPANI_WIDE: HalfBlade = { width: 0.38, jd: 0.7, k1: 0.75, k2: 2.2, b1: 0, p1: 1, b2: 0.5, p2: 2 };
const FRANGIPANI_NARROW: HalfBlade = { width: 0.24, jd: 0.66, k1: 0.75, k2: 2.2, b1: 0, p1: 1, b2: 0.4, p2: 2 };

/**
 * Plumeria (frangipani): five waxy, lopsided petals twisted into a pinwheel (contorted), each
 * overlapping the next, a yellow throat fading out along the petals.
 */
export function frangipaniFlower(ctx: Context, brush: Brush, rand: Rand): void {
  const turn = rand() * Math.PI * 2;
  for (let i = 0; i < 5; i++) {
    const shape: BladeShape = { upper: vary(FRANGIPANI_WIDE, rand, 0.05), lower: vary(FRANGIPANI_NARROW, rand, 0.05), bend: -0.12 };
    ctx.save();
    // The pinwheel twist: each petal's axis is turned off the radius.
    ctx.rotate(turn + (i / 5) * Math.PI * 2);
    ctx.translate(0.05, 0);
    ctx.rotate(0.3);
    ctx.fillStyle = ink(Material.frangipani, brush, brush.shade);
    ctx.fill(halfPath(shape, 1));
    ctx.fillStyle = ink(Material.frangipani, brush, brush.shade * 0.93);
    ctx.fill(halfPath(shape, -1));
    ctx.fillStyle = ink(Material.pollen, brush, 0.95);
    ctx.fill(region(shape, 1, [[0, 0], [0.36, 0], [0.32, 1.05], [0, 1.05]]));
    ctx.fill(region(shape, -1, [[0, 0], [0.3, 0], [0.26, 1.05], [0, 1.05]]));
    ctx.strokeStyle = ink(Material.frangipani, brush, brush.shade * 0.82);
    ctx.lineWidth = 0.014;
    trace(ctx, shape, 1, (u) => [0.2 + u * 0.75, 1], 16);
    ctx.restore();
  }
}
