// The pond's foliage sheets. Plants are laid out around the frame by their growth habit and drawn
// with the botany models into data textures the shader reads (see botany.ts for the encoding).
// Each leaf or flower is drawn alone on a scratch sheet so its cuts and holes cannot erase what
// lies underneath, then stamped onto the sheet, back layer first.

import { bananaLeaf, fernFrond, frangipaniFlower, grassTuft, hibiscusFlower, Material, monsteraLeaf, pothosLeaf, stroke, type Brush, type Context, type Rand } from "./botany.ts";

/** Plants that grow in clumps along the edges. */
export const clumpSpecies = ["monstera", "fern", "banana"] as const;
export type ClumpSpecies = (typeof clumpSpecies)[number];

export interface DecorConfig {
  /** 0..1: how far the plants reach into the pond. */
  reach: number;
  /** 0..1 lushness of each edge: top, right, bottom, left. */
  sides: readonly [number, number, number, number];
  kinds: readonly ClumpSpecies[];
  /** 0..1: pothos vines trailing in from the edges. */
  vines: number;
  /** 0..1: how many flowers bloom among the leaves. */
  flowers: number;
  /** 0..1: tufts of grass along the waterline. */
  grass: number;
  /** Arrangement variant. */
  seed: number;
}

export interface CanopyConfig {
  /** 0..1: how much of the sky above the camera is leaves. */
  coverage: number;
  seed: number;
}

/** The canopy sheet covers uv -0.25..1.25 so shadows cast at an angle still find leaves. */
export const CANOPY_MARGIN = 0.25;

export function decorKey(config: DecorConfig): string {
  return [config.reach, ...config.sides, config.vines, config.flowers, config.grass]
    .map((value) => value.toFixed(3))
    .concat(config.kinds.join(","), String(config.seed))
    .join("|");
}

export function canopyKey(config: CanopyConfig): string {
  return `${config.coverage.toFixed(3)}|${config.seed}`;
}

/** Small deterministic PRNG so an arrangement is stable across rebuilds. */
function random(seed: number): Rand {
  let state = (seed * 2654435761) >>> 0 || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Point = [number, number];

/** Something drawn onto the sheet, in a depth layer (0 back … 2 front). */
interface Piece {
  layer: number;
  draw: (ctx: Context, stamp: Stamp) => void;
}

/** Draw in a local frame (origin, heading, scale, optional mirror) on the scratch sheet, then lay it down. */
type Stamp = (x: number, y: number, angle: number, scale: number, flip: boolean, draw: (local: Context) => void) => void;

function stamper(ctx: Context, size: number): Stamp {
  const scratch = new OffscreenCanvas(size, size);
  const local = scratch.getContext("2d");
  if (!local) throw new Error("landing: 2d canvas unavailable");
  return (x, y, angle, scale, flip, draw) => {
    local.setTransform(1, 0, 0, 1, 0, 0);
    local.clearRect(0, 0, size, size);
    local.globalCompositeOperation = "source-over";
    local.translate(size / 2, size / 2);
    local.rotate(angle);
    local.scale(scale, scale * (flip ? -1 : 1));
    draw(local);
    ctx.drawImage(scratch, x - size / 2, y - size / 2);
  };
}

/** Points along a quadratic curve, with the heading at each. */
function curve(p0: Point, p1: Point, p2: Point, steps: number): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    const x = u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0];
    const y = u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1];
    const dx = 2 * u * (p1[0] - p0[0]) + 2 * t * (p2[0] - p1[0]);
    const dy = 2 * u * (p1[1] - p0[1]) + 2 * t * (p2[1] - p1[1]);
    out.push([x, y, Math.atan2(dy, dx)]);
  }
  return out;
}

/** A thin, wandering aerial root hanging from a node. */
function aerialRoot(x: number, y: number, heading: number, length: number, rand: Rand): Point[] {
  const points: Point[] = [[x, y]];
  let angle = heading;
  for (let i = 1; i <= 10; i++) {
    angle += (rand() - 0.5) * 0.5;
    const [px, py] = points[i - 1] ?? [x, y];
    points.push([px + Math.cos(angle) * (length / 10), py + Math.sin(angle) * (length / 10)]);
  }
  return points;
}

/** Everything around the frame, as pieces. Unit is the sheet height. */
function layout(width: number, height: number, config: DecorConfig, rand: Rand): Piece[] {
  const kinds: readonly ClumpSpecies[] = config.kinds.length > 0 ? config.kinds : clumpSpecies;
  const pick = (prefer: readonly ClumpSpecies[]): ClumpSpecies => {
    const pool = kinds.filter((kind) => prefer.includes(kind));
    const from = pool.length > 0 && rand() < 0.75 ? pool : kinds;
    return from[Math.floor(rand() * from.length)] ?? "fern";
  };
  const reach = height * (0.55 + 0.9 * config.reach);
  const pieces: Piece[] = [];
  const brush = (layer: number): Brush => ({ layer, shade: 0.5 + 0.3 * rand() });

  const bloom = (x: number, y: number) => {
    const size = height * (0.02 + 0.02 * rand());
    const hibiscus = rand() < 0.55;
    const b: Brush = { layer: 2, shade: hibiscus ? 0.65 + 0.25 * rand() : 0.88 + 0.1 * rand() };
    const seed = rand();
    pieces.push({
      layer: 2,
      draw: (_ctx, stamp) => stamp(x, y, 0, size, false, (local) => (hibiscus ? hibiscusFlower : frangipaniFlower)(local, b, random(seed * 1e6))),
    });
  };

  // Monstera climbs: a stout stem leaning in from the edge; alternate nodes each carry a long
  // petiole with a knee (geniculum) just below the blade, some an aerial root.
  const monsteraPlant = (x: number, y: number, inward: number, lush: number, layer: number) => {
    const length = reach * (0.15 + 0.11 * rand()) * (0.7 + 0.5 * lush);
    const bend = (rand() - 0.5) * 1.1;
    const p0: Point = [x, y];
    const p1: Point = [x + Math.cos(inward + bend * 0.5) * length * 0.5, y + Math.sin(inward + bend * 0.5) * length * 0.5];
    const p2: Point = [x + Math.cos(inward + bend) * length, y + Math.sin(inward + bend) * length];
    const stem = curve(p0, p1, p2, 16);
    const b = brush(layer);
    pieces.push({ layer, draw: (ctx) => stroke(ctx, stem.map(([px, py]) => [px, py]), Material.stem, b, 0.4, height * 0.014, 0.7) });
    const nodes = 2 + Math.floor(rand() * 3);
    let side = rand() < 0.5 ? -1 : 1;
    for (let n = 0; n < nodes; n++) {
      const t = 0.3 + (0.7 * n) / Math.max(1, nodes - 1);
      const [nx, ny, heading] = stem[Math.round(t * 16)] ?? [x, y, inward];
      const out = heading + side * (0.8 + 0.4 * rand());
      const petiole = length * (0.28 + 0.12 * rand());
      const kneeX = nx + Math.cos(out) * petiole;
      const kneeY = ny + Math.sin(out) * petiole;
      // At the knee the blade turns to hang toward the light.
      const bladeAngle = out - side * (0.25 + 0.25 * rand());
      const stalk: Point[] = curve([nx, ny], [nx + Math.cos(out) * petiole * 0.6 + Math.cos(heading) * petiole * 0.15, ny + Math.sin(out) * petiole * 0.6 + Math.sin(heading) * petiole * 0.15], [kneeX, kneeY], 8).map(([px, py]) => [px, py]);
      const leafLength = length * (0.5 + 0.2 * rand()) * (0.8 + 0.4 * t);
      const maturity = 0.45 + 0.55 * rand();
      const seed = rand();
      const leafBrush = brush(layer);
      pieces.push({ layer, draw: (ctx) => stroke(ctx, stalk, Material.stem, leafBrush, 0.55, height * 0.006, 0.8) });
      pieces.push({ layer, draw: (_ctx, stamp) => stamp(kneeX, kneeY, bladeAngle, leafLength, side < 0, (local) => monsteraLeaf(local, leafBrush, random(seed * 1e6), maturity)) });
      if (rand() < 0.5) {
        const root = aerialRoot(nx, ny, heading - side * 1.2, height * (0.06 + 0.1 * rand()), rand);
        pieces.push({ layer: Math.max(0, layer - 1), draw: (ctx) => stroke(ctx, root, Material.root, b, 0.5, height * 0.0035, 0.5) });
      }
      side = -side;
    }
    if (rand() < config.flowers * 0.7) bloom(p2[0], p2[1]);
  };

  // Ferns and banana fan from a crown at the edge: fronds straight from the crown, banana leaves
  // on short stout petioles.
  const crown = (species: "fern" | "banana", x: number, y: number, inward: number, big: boolean, lush: number) => {
    const count = (species === "fern" ? 5 : 3) + Math.floor(rand() * 2) + (lush > 0.7 ? 1 : 0);
    const scale = 0.65 + 0.6 * lush;
    for (let i = 0; i < count; i++) {
      const fan = (count === 1 ? 0 : i / (count - 1) - 0.5) * (big ? 1.9 : 1.5) + (rand() - 0.5) * 0.3;
      const angle = inward + fan;
      const length = reach * (big ? 0.38 : 0.28) * (0.75 + 0.45 * rand()) * scale;
      const layer = big ? 1 + Math.floor(rand() * 2) : Math.floor(rand() * 2);
      const b = brush(layer);
      const seed = rand();
      const flip = rand() < 0.5;
      if (species === "fern") {
        pieces.push({ layer, draw: (_ctx, stamp) => stamp(x, y, angle, length, flip, (local) => fernFrond(local, b, random(seed * 1e6))) });
      } else {
        const petiole = length * 0.14;
        const bx = x + Math.cos(angle) * petiole;
        const by = y + Math.sin(angle) * petiole;
        const wear = rand();
        pieces.push({ layer, draw: (ctx) => stroke(ctx, [[x, y], [bx, by]], Material.banana, b, 0.85, height * 0.012, 0.8) });
        pieces.push({ layer, draw: (_ctx, stamp) => stamp(bx, by, angle, length, flip, (local) => bananaLeaf(local, b, random(seed * 1e6), wear)) });
      }
      if (rand() < config.flowers * 0.4) {
        const along = length * (0.35 + 0.45 * rand());
        bloom(x + Math.cos(angle) * along, y + Math.sin(angle) * along);
      }
    }
  };

  const plant = (x: number, y: number, inward: number, big: boolean, lush: number) => {
    const species = pick(big ? ["monstera", "banana"] : ["fern", "monstera"]);
    if (species === "monstera") monsteraPlant(x, y, inward, lush, big ? 2 : 1);
    else crown(species, x, y, inward, big, lush);
  };

  const tuft = (x: number, y: number, inward: number, lush: number) => {
    const size = height * (0.12 + 0.1 * rand()) * (0.7 + 0.5 * lush);
    const layer = rand() < 0.6 ? 0 : 1;
    const b: Brush = { layer, shade: 0.55 + 0.3 * rand() };
    const seed = rand();
    const blades = 16 + Math.floor(rand() * 16);
    const lean = inward + (rand() - 0.5) * 0.4;
    pieces.push({ layer, draw: (_ctx, stamp) => stamp(x, y, lean, size, false, (local) => grassTuft(local, b, random(seed * 1e6), blades)) });
  };

  // Pothos trails in: a wandering vine with alternate cordate leaves on short petioles, an aerial
  // root now and then, curling at the tip.
  const vine = (x: number, y: number, inward: number, index: number) => {
    const vineLength = height * (0.3 + 0.45 * rand()) * (0.6 + 0.6 * config.reach);
    const sway = (rand() - 0.5) * 0.8;
    const steps = 40;
    const points: Point[] = [[x, y]];
    for (let i = 1; i <= steps; i++) {
      const s = i / steps;
      const heading = inward + sway * s + Math.sin(s * 9 + index) * 0.35;
      const [px, py] = points[i - 1] ?? [x, y];
      points.push([px + (Math.cos(heading) * vineLength) / steps, py + (Math.sin(heading) * vineLength) / steps]);
    }
    const layer = rand() < 0.6 ? 2 : 1;
    const b = brush(layer);
    pieces.push({ layer, draw: (ctx) => stroke(ctx, points, Material.stem, b, 0.5, height * 0.0045, 0.5) });
    let side = 1;
    for (let i = 2; i < steps - 1; i += 2 + Math.floor(rand() * 2)) {
      const [px, py] = points[i] ?? [x, y];
      const [qx, qy] = points[i + 1] ?? [px, py];
      const heading = Math.atan2(qy - py, qx - px);
      const out = heading + side * (0.9 + 0.4 * rand());
      const leafLength = height * (0.03 + 0.028 * rand()) * (1 - (i / steps) * 0.4);
      const petiole = leafLength * 0.45;
      const lx = px + Math.cos(out) * petiole;
      const ly = py + Math.sin(out) * petiole;
      const seed = rand();
      const leafBrush = brush(layer);
      pieces.push({ layer, draw: (ctx) => stroke(ctx, [[px, py], [lx, ly]], Material.stem, leafBrush, 0.6, height * 0.0025, 0.8) });
      pieces.push({ layer, draw: (_ctx, stamp) => stamp(lx, ly, out - side * 0.3, leafLength, side < 0, (local) => pothosLeaf(local, leafBrush, random(seed * 1e6))) });
      if (rand() < 0.12) {
        const root = aerialRoot(px, py, heading - side * 1.4, height * 0.03, rand);
        pieces.push({ layer, draw: (ctx) => stroke(ctx, root, Material.root, b, 0.5, height * 0.0022, 0.5) });
      }
      side = -side;
    }
  };

  const [top, right, bottom, left] = config.sides;
  const margin = height * 0.03;
  // Corners follow their two edges.
  const corners: [number, number, number][] = [
    [-margin, -margin, Math.max(top, left)],
    [width + margin, -margin, Math.max(top, right)],
    [-margin, height + margin, Math.max(bottom, left)],
    [width + margin, height + margin, Math.max(bottom, right)],
  ];
  for (const [x, y, lush] of corners) {
    if (lush < 0.05 || rand() < 0.15 * (1 - lush)) continue;
    plant(x, y, Math.atan2(height / 2 - y, width / 2 - x), true, lush);
  }
  const edges: [number, number, number, number, number, number][] = [
    [0, -margin, width, -margin, Math.PI / 2, top],
    [width + margin, 0, width + margin, height, Math.PI, right],
    [0, height + margin, width, height + margin, -Math.PI / 2, bottom],
    [-margin, 0, -margin, height, 0, left],
  ];
  edges.forEach(([x0, y0, x1, y1, inward, lush], edge) => {
    if (lush < 0.05) return;
    const spacing = height * (0.85 - 0.62 * lush);
    const length = Math.hypot(x1 - x0, y1 - y0);
    const along = (t: number): Point => [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t];
    for (let d = spacing * (0.5 + rand() * 0.5); d < length - spacing * 0.4; d += spacing * (0.7 + rand() * 0.6)) {
      if (rand() < 0.25 * (1 - lush)) continue;
      const [x, y] = along(d / length);
      plant(x, y, inward + (rand() - 0.5) * 0.5, rand() < 0.15 + 0.15 * lush, lush);
    }
    const tufts = Math.round(config.grass * lush * (length / height) * 7);
    for (let n = 0; n < tufts; n++) {
      const [x, y] = along(rand());
      tuft(x, y, inward, lush);
    }
    const strands = Math.round(config.vines * lush * (length / height) * 3);
    for (let n = 0; n < strands; n++) {
      const [x, y] = along(rand());
      vine(x, y, inward, edge * 10 + n);
    }
  });
  // Stable within a layer: plants keep the order they were laid out in.
  return pieces.map((piece, index) => ({ piece, index })).sort((a, b) => a.piece.layer - b.piece.layer || a.index - b.index).map(({ piece }) => piece);
}

/** Paint the border sheet: black background, pieces back to front. */
export function paintDecor(ctx: Context, width: number, height: number, config: DecorConfig): void {
  const rand = random(17 + config.seed * 101);
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, width, height);
  const stamp = stamper(ctx, Math.ceil(height * 1.6));
  for (const piece of layout(width, height, config, rand)) piece.draw(ctx, stamp);
}

/**
 * Paint the overhead canopy: big leaves scattered across and beyond the frame. Only its shadow is
 * ever seen, so only coverage matters. `span` is how many frames wide the sheet is.
 */
export function paintCanopy(ctx: Context, width: number, height: number, config: CanopyConfig, span: number): void {
  const rand = random(911 + config.seed * 53);
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, width, height);
  const stamp = stamper(ctx, Math.ceil(height * 0.9));
  const count = Math.round(8 + config.coverage * 70);
  const brush: Brush = { layer: 0, shade: 0.5 };
  for (let i = 0; i < count; i++) {
    const kind = Math.floor(rand() * 3);
    const length = (height / span) * (0.18 + 0.3 * rand());
    const seed = rand();
    stamp(rand() * width, rand() * height, rand() * Math.PI * 2, length, rand() < 0.5, (local) => {
      const leafRand = random(seed * 1e6);
      if (kind === 0) monsteraLeaf(local, brush, leafRand, 0.8);
      else if (kind === 1) bananaLeaf(local, brush, leafRand, 0.6);
      else fernFrond(local, brush, leafRand);
    });
  }
}
