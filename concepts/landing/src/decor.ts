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
  /** 0..1: a few distinct plants (0) to packed foliage with an understory (1). */
  bushiness: number;
  /** Arrangement variant. */
  seed: number;
}

export interface CanopyConfig {
  /** 0..1: how much of the sky above the camera is leaves. */
  coverage: number;
  /** 0..1 lushness of each edge (top, right, bottom, left): the canopy thins toward bare ones. */
  sides: readonly [number, number, number, number];
  seed: number;
}

/** The canopy sheet covers uv -0.25..1.25 so shadows cast at an angle still find leaves. */
export const CANOPY_MARGIN = 0.25;

export function decorKey(config: DecorConfig): string {
  return [config.reach, ...config.sides, config.vines, config.flowers, config.grass, config.bushiness]
    .map((value) => value.toFixed(3))
    .concat(config.kinds.join(","), String(config.seed))
    .join("|");
}

export function canopyKey(config: CanopyConfig): string {
  return [config.coverage, ...config.sides].map((value) => value.toFixed(3)).concat(String(config.seed)).join("|");
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
    // Everything drawn in unit space stays within radius ~1.35 of its origin: only that square
    // of the scratch sheet is cleared and copied.
    const box = Math.min(size, Math.ceil(scale * 2.8) + 4);
    local.setTransform(1, 0, 0, 1, 0, 0);
    local.clearRect(0, 0, box, box);
    local.globalCompositeOperation = "source-over";
    local.translate(box / 2, box / 2);
    local.rotate(angle);
    local.scale(scale, scale * (flip ? -1 : 1));
    draw(local);
    ctx.drawImage(scratch, 0, 0, box, box, x - box / 2, y - box / 2, box, box);
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
    const nodes = 2 + Math.floor(rand() * 3) + Math.round(config.bushiness * 2);
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
    const count = (species === "fern" ? 5 : 3) + Math.floor(rand() * 2) + (lush > 0.7 ? 1 : 0) + Math.round(config.bushiness * 3);
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
  // A corner is only as lush as the barer of its two edges: 0 on a side leaves it clear.
  const corners: [number, number, number][] = [
    [-margin, -margin, Math.min(top, left)],
    [width + margin, -margin, Math.min(top, right)],
    [-margin, height + margin, Math.min(bottom, left)],
    [width + margin, height + margin, Math.min(bottom, right)],
  ];
  for (const [x, y, lush] of corners) {
    if (lush < 0.05 || rand() < 0.15 * (1 - lush) * (1 - config.bushiness)) continue;
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
    const spacing = height * (0.85 - 0.62 * lush) * (1.35 - 0.8 * config.bushiness);
    const length = Math.hypot(x1 - x0, y1 - y0);
    const along = (t: number): Point => [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t];
    for (let d = spacing * (0.5 + rand() * 0.5); d < length - spacing * 0.4; d += spacing * (0.7 + rand() * 0.6)) {
      if (rand() < 0.25 * (1 - lush) * (1 - config.bushiness)) continue;
      const [x, y] = along(d / length);
      plant(x, y, inward + (rand() - 0.5) * 0.5, rand() < 0.15 + 0.15 * lush, lush);
    }
    // Understory: young, unsplit leaves packed low along the edge, darker in the plants' shade.
    const young = Math.round(config.bushiness * lush * (length / height) * 16);
    for (let n = 0; n < young; n++) {
      const [ex, ey] = along(rand());
      const inset = height * 0.1 * rand() * (0.5 + config.reach);
      const x = ex + Math.cos(inward) * inset;
      const y = ey + Math.sin(inward) * inset;
      const angle = inward + (rand() - 0.5) * 2.4;
      const size = height * (0.06 + 0.07 * rand());
      const b: Brush = { layer: 0, shade: 0.3 + 0.2 * rand() };
      const seed = rand();
      const kind = Math.floor(rand() * 3);
      const flip = rand() < 0.5;
      pieces.push({
        layer: 0,
        draw: (_ctx, stamp) => stamp(x, y, angle, size, flip, (local) => {
          const leafRand = random(seed * 1e6);
          if (kind === 0) monsteraLeaf(local, b, leafRand, 0.1);
          else if (kind === 1) pothosLeaf(local, b, leafRand);
          else fernFrond(local, b, leafRand);
        }),
      });
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

/** Paint the border sheet: black background, pieces back to front, then crisp. Yields between steps. */
export function* paintDecor(ctx: Context, width: number, height: number, config: DecorConfig): Generator<void, void> {
  const rand = random(17 + config.seed * 101);
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, width, height);
  const stamp = stamper(ctx, Math.ceil(height * 1.6));
  for (const piece of layout(width, height, config, rand)) {
    piece.draw(ctx, stamp);
    yield;
  }
  yield* crisp(ctx, width, height);
}

/** Valid material codes: material × 16 + layer × 4 + 2, layers 0..2. */
function snapCode(code: number): number | undefined {
  const step = Math.round((code - 2) / 4);
  if (Math.abs(code - (step * 4 + 2)) > 1.2 || step % 4 === 3 || step < 0 || step > 10 * 4 + 2) return undefined;
  return step * 4 + 2;
}

/**
 * Undo anti-aliasing so every texel is one material. Canvas blends edges with the black
 * background and with neighbouring leaves, and a blended material code decodes as some other
 * material (a stem's edge would read as a red petal), which then flickers as the leaves sway.
 * Coverage is thresholded, shade and code un-premultiplied, codes snapped to valid values, and
 * seam texels (unlike both neighbours along a row or column) take their neighbour's material.
 */
function* crisp(ctx: Context, width: number, height: number): Generator<void, void> {
  const image = ctx.getImageData(0, 0, width, height);
  const d = image.data;
  const codes = new Int16Array(width * height).fill(-1);
  for (let i = 0, px = 0; i < d.length; i += 4, px++) {
    const r = d[i] ?? 0;
    if (r < 128) {
      d[i] = 0;
      d[i + 1] = 0;
      d[i + 2] = 0;
      continue;
    }
    d[i] = 255;
    d[i + 1] = Math.min(255, Math.round(((d[i + 1] ?? 0) * 255) / r));
    codes[px] = snapCode(((d[i + 2] ?? 0) * 255) / r) ?? -2;
  }
  yield;
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= width || y >= height ? -1 : codes[y * width + x] ?? -1);
  for (let y = 0; y < height; y++) {
    if (y % 64 === 0) yield;
    for (let x = 0; x < width; x++) {
      const px = y * width + x;
      let code = codes[px] ?? -1;
      if (code === -1) continue;
      const left = at(x - 1, y);
      const up = at(x, y - 1);
      const seam = code === -2 || (code !== left && code !== at(x + 1, y)) || (code !== up && code !== at(x, y + 1));
      if (seam) code = left >= 0 ? left : up >= 0 ? up : Math.max(at(x + 1, y), at(x, y + 1), 2);
      if (code < 0) code = 2;
      codes[px] = code;
    }
  }
  // Wider seams can blend into a valid but foreign code: a texel unlike three of its four
  // neighbours takes the most common one among them.
  for (let y = 0; y < height; y++) {
    if (y % 64 === 0) yield;
    for (let x = 0; x < width; x++) {
      const px = y * width + x;
      const code = codes[px] ?? -1;
      if (code < 0) continue;
      const around = [at(x - 1, y), at(x + 1, y), at(x, y - 1), at(x, y + 1)].filter((n) => n >= 0);
      if (around.filter((n) => n !== code).length >= 3) {
        const counts = new Map<number, number>();
        for (const n of around) counts.set(n, (counts.get(n) ?? 0) + 1);
        codes[px] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? code;
      }
    }
  }
  // Clumps of blend: a blended code always lies between the two it came from. A boundary texel
  // whose code is rare nearby and bracketed by two codes that are present takes the commoner one.
  const counts = new Map<number, number>();
  for (let y = 0; y < height; y++) {
    if (y % 64 === 0) yield;
    for (let x = 0; x < width; x++) {
      const px = y * width + x;
      const code = codes[px] ?? -1;
      if (code < 0) continue;
      if (at(x - 1, y) === code && at(x + 1, y) === code && at(x, y - 1) === code && at(x, y + 1) === code) continue;
      counts.clear();
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const n = at(x + dx, y + dy);
          if (n >= 0) counts.set(n, (counts.get(n) ?? 0) + 1);
        }
      }
      if ((counts.get(code) ?? 0) > 8) continue;
      let below = -1;
      let above = -1;
      for (const [n, c] of counts) {
        if (n < code && c > (counts.get(below) ?? 0)) below = n;
        if (n > code && c > (counts.get(above) ?? 0)) above = n;
      }
      if (below >= 0 && above >= 0) codes[px] = (counts.get(below) ?? 0) >= (counts.get(above) ?? 0) ? below : above;
    }
  }
  for (let px = 0; px < width * height; px++) {
    const code = codes[px] ?? -1;
    if (code >= 0) d[px * 4 + 2] = code;
  }
  ctx.putImageData(image, 0, 0);
}

/**
 * Paint the overhead canopy: big leaves scattered across and beyond the frame. Only its shadow is
 * ever seen, so only coverage matters. `span` is how many frames wide the sheet is.
 */
export function* paintCanopy(ctx: Context, width: number, height: number, config: CanopyConfig, span: number): Generator<void, void> {
  const rand = random(911 + config.seed * 53);
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, width, height);
  const stamp = stamper(ctx, Math.ceil(height * 0.9));
  const count = Math.round(8 + config.coverage * 70);
  const brush: Brush = { layer: 0, shade: 0.5 };
  const [top, right, bottom, left] = config.sides;
  // Overhead leaves grow from the same sides as the border: thinning toward bare edges.
  const density = (x: number, y: number): number => {
    const u = Math.min(1, Math.max(0, (x / width) * span - (span - 1) / 2));
    const v = Math.min(1, Math.max(0, (y / height) * span - (span - 1) / 2));
    return Math.min(1, Math.min(left + (right - left) * u, top + (bottom - top) * v) / 0.6);
  };
  for (let i = 0; i < count; i++) {
    const kind = Math.floor(rand() * 3);
    const length = (height / span) * (0.18 + 0.3 * rand());
    const seed = rand();
    const x = rand() * width;
    const y = rand() * height;
    const angle = rand() * Math.PI * 2;
    const flip = rand() < 0.5;
    if (rand() > density(x, y)) continue;
    stamp(x, y, angle, length, flip, (local) => {
      const leafRand = random(seed * 1e6);
      if (kind === 0) monsteraLeaf(local, brush, leafRand, 0.8);
      else if (kind === 1) bananaLeaf(local, brush, leafRand, 0.6);
      else fernFrond(local, brush, leafRand);
    });
    yield;
  }
}
