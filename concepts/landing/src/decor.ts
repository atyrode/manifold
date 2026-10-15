// The pond's foliage rasters, painted with the botany models (botany.ts has the encoding): the plant
// atlas, one cell per variant of every leaf, frond, tuft and flower the border plants draw from
// (sims/plantsheet.ts cuts them out as sprites, scenes/pond/plants.ts grows the plants), and the
// overhead canopy, whose dappled shade is all that is ever seen of it. Each sprite is painted alone on
// a black scratch cell so its cuts and holes cannot erase anything, then made crisp (one material per
// texel) and copied into its cell.

import { bananaLeaf, fernFrond, frangipaniFlower, grassTuft, hibiscusFlower, Material, monsteraLeaf, pothosLeaf, type Brush, type Context, type MaterialId, type Rand } from "./botany.ts";
import { PLANT_ATLAS_SHADE, type PlantSheetFamily } from "./sims/plantsheet.ts";

export interface CanopyConfig {
  /** 0..1: how much of the sky above the camera is leaves. */
  coverage: number;
  /** 0..1 lushness of each edge (top, right, bottom, left): the canopy thins toward bare ones. */
  sides: readonly [number, number, number, number];
  seed: number;
}

/** The canopy sheet covers uv -0.25..1.25 so shadows cast at an angle still find leaves. */
export const CANOPY_MARGIN = 0.25;

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

// ---------------------------------------------------------------------------------------------
// The plant atlas

/** The atlas is PLANT_ATLAS_SIZE square: rows of 256-pixel cells, then rows of 128-pixel cells. */
export const PLANT_ATLAS_SIZE = 2048;
const BIG = 256;
const SMALL = 128;
/** Where the 128-pixel cells start (pixels from the top). */
const SMALL_TOP = 5 * BIG;

/** Monstera variants below this one are mature leaves (more incised in turn); the rest are young. */
export const MONSTERA_MATURE = 12;

interface AtlasFamily {
  material: MaterialId;
  count: number;
  cell: typeof BIG | typeof SMALL;
  /** The sprite frame a cell holds: x0, y0, x1, y1 (stalk at 0, tip toward +x, y down). */
  box: readonly [number, number, number, number];
  draw(ctx: Context, brush: Brush, rand: Rand, variant: number): void;
}

/** Every family, in atlas order; the first three in 256-pixel cells, the rest in 128-pixel ones. */
const FAMILIES: readonly AtlasFamily[] = [
  { material: Material.monstera, count: 16, cell: BIG, box: [-0.3, -0.66, 1.1, 0.66], draw: (ctx, brush, rand, k) => monsteraLeaf(ctx, brush, rand, k < MONSTERA_MATURE ? 0.45 + (0.55 * k) / (MONSTERA_MATURE - 1) : 0.1) },
  { material: Material.fern, count: 12, cell: BIG, box: [-0.1, -0.6, 1.25, 0.6], draw: (ctx, brush, rand) => fernFrond(ctx, brush, rand) },
  { material: Material.banana, count: 8, cell: BIG, box: [-0.1, -0.32, 1.15, 0.32], draw: (ctx, brush, rand, k) => bananaLeaf(ctx, brush, rand, k / 7) },
  { material: Material.pothos, count: 12, cell: SMALL, box: [-0.3, -0.52, 1.1, 0.52], draw: (ctx, brush, rand) => pothosLeaf(ctx, brush, rand) },
  { material: Material.hibiscus, count: 8, cell: SMALL, box: [-1.3, -1.3, 1.3, 1.3], draw: (ctx, brush, rand) => hibiscusFlower(ctx, brush, rand) },
  { material: Material.frangipani, count: 8, cell: SMALL, box: [-1.3, -1.3, 1.3, 1.3], draw: (ctx, brush, rand) => frangipaniFlower(ctx, brush, rand) },
  { material: Material.grass, count: 8, cell: SMALL, box: [-0.5, -1.05, 1.15, 1.05], draw: (ctx, brush, rand) => grassTuft(ctx, brush, rand, 16 + Math.floor(rand() * 16)) },
];

/** Each family's cells in atlas order: [family, variant, left, top] (atlas pixels). */
function atlasCells(): [AtlasFamily, number, number, number][] {
  const cells: [AtlasFamily, number, number, number][] = [];
  let big = 0;
  let small = 0;
  for (const family of FAMILIES) {
    const across = PLANT_ATLAS_SIZE / family.cell;
    for (let k = 0; k < family.count; k++) {
      const index = family.cell === BIG ? big++ : small++;
      cells.push([family, k, (index % across) * family.cell, (family.cell === BIG ? 0 : SMALL_TOP) + Math.floor(index / across) * family.cell]);
    }
  }
  return cells;
}

/**
 * The atlas's families for PlantSheet, indexed by material: their cells as texture uv rectangles
 * (the atlas is uploaded flipped, its top row at v = 1).
 */
export function plantAtlasFamilies(): (PlantSheetFamily | undefined)[] {
  const cells = FAMILIES.map((): (readonly [number, number, number, number])[] => []);
  for (const [family, , left, top] of atlasCells()) {
    cells[FAMILIES.indexOf(family)]?.push([left / PLANT_ATLAS_SIZE, 1 - top / PLANT_ATLAS_SIZE, (left + family.cell) / PLANT_ATLAS_SIZE, 1 - (top + family.cell) / PLANT_ATLAS_SIZE]);
  }
  const families: (PlantSheetFamily | undefined)[] = [];
  FAMILIES.forEach((family, f) => {
    families[family.material] = { material: family.material, cells: cells[f] ?? [], box: family.box };
  });
  return families;
}

/** Paint the plant atlas: every family's variants, each crisp in its own cell. Yields between steps. */
export function* paintAtlas(ctx: Context, width: number, height: number): Generator<void, void> {
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, width, height);
  const scratch = new OffscreenCanvas(BIG, BIG);
  const local = scratch.getContext("2d", { willReadFrequently: true });
  if (!local) throw new Error("landing: 2d canvas unavailable");
  const brush: Brush = { layer: 0, shade: PLANT_ATLAS_SHADE };
  for (const [family, k, left, top] of atlasCells()) {
    const [x0, y0, x1, y1] = family.box;
    const size = family.cell;
    local.setTransform(1, 0, 0, 1, 0, 0);
    local.globalCompositeOperation = "source-over";
    local.fillStyle = "#000";
    local.fillRect(0, 0, size, size);
    local.setTransform(size / (x1 - x0), 0, 0, size / (y1 - y0), (-x0 * size) / (x1 - x0), (-y0 * size) / (y1 - y0));
    family.draw(local, brush, random(1009 * (family.material + 1) + 31 * k + 7), k);
    local.setTransform(1, 0, 0, 1, 0, 0);
    yield* crisp(local, size, size);
    ctx.putImageData(local.getImageData(0, 0, size, size), left, top);
    yield;
  }
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
