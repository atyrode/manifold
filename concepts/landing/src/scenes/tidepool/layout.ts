// The tide pool's rock, laid out on the CPU for a seed: the open sea along the top of the frame,
// its floor shelving up past a ragged shoreline onto a rock platform that rises toward the bottom;
// in the platform a basin walled by a rim, with a notch on its seaward side opening onto a surge
// channel that runs down to the sea; boulders standing in the basin; and a few small potholes higher
// up. Heights are in grid cells of the shallow-water sim (sims/shallow.ts), exaggerated against the
// frame by TIDEPOOL_RELIEF (a cell of height is that many cells of the frame), so a pool a few cells
// deep is a hand deep and the light bends and focuses as through real water.
//
// The still water a layout opens with comes from stillWater with the wave maker's band (the top
// TIDEPOOL_SEA_BAND of the frame) as the outlet held at the sea level: the basin and the potholes
// fill to their lowest spill points and the platform is dry.
import { fbm, valueNoise } from "../../sims/noise.ts";
import { clamp, lerp, smoothstep } from "../../sims/math.ts";
import { mulberry32 } from "../../sims/random.ts";
import { stillWater } from "../../sims/shallow.ts";

/** A cell of height spans this many cells of the frame (vertical exaggeration). */
export const TIDEPOOL_RELIEF = 4;
/** The wave maker's band along the top edge, in frame heights; the sea outside the frame. */
export const TIDEPOOL_SEA_BAND = 0.1;
/** Heights (cells): the sea floor at the top edge, the platform round the pool, the rim's crest and the notch's sill. */
export const TIDEPOOL_HEIGHTS = {
  seaFloor: -8,
  platform: 1.5,
  rim: 2.4,
  notch: 0.9,
  floor: -2.6,
} as const;
/** Steps round the basin's outline its wander is worked out at. */
const OUTLINE = 256;
/** Still water thinner than this (cells) is dry rock. */
const WET = 0.02;
/** Hollows open dry unless they cover this much of the frame (frame heights²) and are this deep (cells). */
const PUDDLE_AREA = 0.0016;
const PUDDLE_DEPTH = 0.9;

export interface TidepoolPool {
  /** Centre, in frame heights (x across 0..aspect, y up 0..1). */
  x: number;
  y: number;
  /** Half-axes in frame heights. */
  rx: number;
  ry: number;
  /** The notch's bearing from the centre (radians, counter-clockwise from +x). */
  notch: number;
}

export interface TidepoolLayout {
  columns: number;
  rows: number;
  /** Bed heights (cells), row 0 at the bottom. */
  bed: Float32Array;
  /** Still-water depth (cells) at the sea level it was laid out for. */
  rest: Float32Array;
  /** For the shader, rgba per cell: bed, still depth, inside the basin 0..1, in the surge channel 0..1. */
  texture: Float32Array;
  pool: TidepoolPool;
}

/**
 * The rock for a grid of columns × rows square cells (rows spanning the frame's height), a seed and a
 * pool size 0..1, with still water for the sea standing at `sea` (cells).
 */
export function layTidepool(
  columns: number,
  rows: number,
  seed: number,
  size: number,
  sea: number,
): TidepoolLayout {
  const n = columns * rows;
  const aspect = columns / rows;
  const rand = mulberry32(Math.imul(Math.round(seed) + 1, 0x9e3779b1) ^ 0x7d1e9a3);
  const noiseSeed = Math.round(seed) * 101 + 7;
  const h = TIDEPOOL_HEIGHTS;

  // The basin: an ellipse with a wavering outline, placed a little off-centre, below the shoreline.
  const width = Math.min(0.17 + 0.13 * size, 0.4 * aspect);
  const pool: TidepoolPool = {
    x: aspect * (0.5 + (rand() - 0.5) * 0.22),
    y: 0.4 + (rand() - 0.5) * 0.08,
    rx: width,
    ry: 0.1 + 0.06 * size,
    // Seaward, up the frame, turned up to 0.45 rad either way.
    notch: Math.PI / 2 + (rand() - 0.5) * 0.9,
  };
  const notchX = pool.x + pool.rx * Math.cos(pool.notch);
  const notchY = pool.y + pool.ry * Math.sin(pool.notch);
  // The surge channel: from the notch up to below the shoreline, bending toward straight up.
  const reachY = 1 - TIDEPOOL_SEA_BAND - 0.12;
  const channelEndX = notchX + Math.cos(pool.notch) * (reachY - notchY) * 0.6;
  // Boulders in the basin (x, y, radius in frame heights, crest in cells) and potholes higher up
  // (x, y, radius), four and three numbers apiece.
  const boulders: number[] = [];
  const boulderCount = 2 + Math.floor(rand() * 3);
  for (let i = 0; i < boulderCount; i++) {
    const angle = rand() * Math.PI * 2;
    const reach = 0.25 + 0.5 * rand();
    boulders.push(
      pool.x + Math.cos(angle) * pool.rx * reach,
      pool.y + Math.sin(angle) * pool.ry * reach,
      0.025 + 0.025 * rand(),
      -0.6 + 1.9 * rand(),
    );
  }
  const potholes: number[] = [];
  const potholeCount = Math.floor(rand() * 4);
  for (let i = 0; i < potholeCount; i++) {
    const x = aspect * (0.08 + 0.84 * rand());
    const y = 0.06 + 0.2 * rand();
    const radius = 0.025 + 0.03 * rand();
    if (Math.abs(x - pool.x) < pool.rx + 0.08 && Math.abs(y - pool.y) < pool.ry + 0.08) continue;
    potholes.push(x, y, radius);
  }

  // Noise along one line each, worked out once: the shoreline's wander by column, the channel's by
  // row, and the basin's outline by bearing (OUTLINE steps round, read linearly).
  const shore = new Float32Array(columns);
  for (let i = 0; i < columns; i++)
    shore[i] = (valueNoise(((i + 0.5) / rows) * 3.5, 0.5, noiseSeed) - 0.5) * 0.12;
  const wander = new Float32Array(rows);
  for (let j = 0; j < rows; j++)
    wander[j] = (valueNoise(((j + 0.5) / rows) * 9, 2.5, noiseSeed + 13) - 0.5) * 0.04;
  const outlines = new Float32Array(OUTLINE + 1);
  for (let a = 0; a <= OUTLINE; a++) {
    const angle = (a / OUTLINE) * Math.PI * 2;
    outlines[a] =
      1 +
      0.32 * (fbm(Math.cos(angle) * 1.4 + 5, Math.sin(angle) * 1.4 + 5, noiseSeed + 11, 3) - 0.5);
  }

  const bed = new Float32Array(n);
  const inside = new Float32Array(n);
  const channel = new Float32Array(n);
  for (let j = 0; j < rows; j++) {
    const y = (j + 0.5) / rows;
    for (let i = 0; i < columns; i++) {
      const x = (i + 0.5) / rows;
      const k = j * columns + i;
      // The shelf: sea floor at the top edge, a shoreline wandering along x, the platform rising
      // toward the bottom. s is how far from the top edge, moved by the shoreline's wander.
      const s = 1 - y + (shore[i] ?? 0);
      let z =
        lerp(h.seaFloor, h.platform, smoothstep(0.06, 0.4, s)) + 1.2 * smoothstep(0.4, 1.05, s);
      // Rock relief: long reefs and gullies running down to the sea, lumps, and cracks.
      const reefs = fbm(x * 7, y * 2.2, noiseSeed + 3, 3) - 0.5;
      const lumps = fbm(x * 18, y * 18, noiseSeed + 5, 3) - 0.5;
      const crack = 1 - Math.abs(2 * valueNoise(x * 11 + 3, y * 11, noiseSeed + 9) - 1);
      const relief = 2.2 * reefs + 0.7 * lumps - 0.5 * smoothstep(0.92, 0.99, crack);
      z += relief * smoothstep(0.02, 0.3, s);

      // The basin, its rim and the notch.
      const dx = (x - pool.x) / pool.rx;
      const dy = (y - pool.y) / pool.ry;
      const angle = Math.atan2(dy, dx);
      const step = ((angle < 0 ? angle + Math.PI * 2 : angle) / (Math.PI * 2)) * OUTLINE;
      const a0 = Math.min(Math.floor(step), OUTLINE - 1);
      const outline = lerp(outlines[a0] ?? 1, outlines[a0 + 1] ?? 1, step - a0);
      const d = Math.sqrt(dx * dx + dy * dy) / outline;
      // The notch: a dip in the crest about its bearing (the turn from it wrapped to -π..π).
      const off =
        angle - pool.notch - Math.PI * 2 * Math.round((angle - pool.notch) / (Math.PI * 2));
      const notch = Math.exp(-(off * off) / 0.04);
      const crest = lerp(h.rim + 0.5 * lumps, h.notch, notch);
      if (d < 1.45) {
        const floor = h.floor - 0.9 * (1 - Math.min(d * d, 1)) + 0.5 * lumps + 0.4 * reefs;
        const rimmed =
          d < 1
            ? lerp(floor, crest, smoothstep(0.78, 1, d))
            : lerp(crest, Math.min(z, crest + 0.3), smoothstep(1, 1.45, d));
        z = d < 1 ? rimmed : Math.max(z, rimmed);
        if (d >= 1 && notch > 0.2) z = Math.min(z, lerp(z, crest, notch));
      }
      inside[k] = 1 - smoothstep(0.85, 1, d);
      for (let b = 0; b < boulders.length; b += 4) {
        const bx = (x - (boulders[b] ?? 0)) / (boulders[b + 2] ?? 1);
        const by = (y - (boulders[b + 1] ?? 0)) / (boulders[b + 2] ?? 1);
        const r2 = bx * bx + by * by;
        if (r2 < 1)
          z = Math.max(z, lerp(z, (boulders[b + 3] ?? 0) + 0.6 * lumps, Math.pow(1 - r2, 0.6)));
      }

      // The surge channel, its bed falling from the notch's sill to below the sea.
      const along = clamp((y - notchY) / (reachY - notchY), 0, 1);
      const cx = lerp(notchX, channelEndX, along) + (wander[j] ?? 0);
      const halfWidth = 0.022 + 0.018 * along;
      const across = Math.abs(x - cx);
      if (y > notchY - 0.03 && y < reachY + 0.06 && across < halfWidth * 1.8) {
        const sill = lerp(h.notch - 0.15, -1.5, along * along) + 0.3 * lumps;
        const cut = 1 - smoothstep(halfWidth, halfWidth * 1.8, across);
        z = Math.min(z, lerp(z, sill, cut));
        channel[k] = cut * smoothstep(notchY - 0.03, notchY + 0.01, y);
      }

      for (let p = 0; p < potholes.length; p += 3) {
        const px = x - (potholes[p] ?? 0);
        const py = y - (potholes[p + 1] ?? 0);
        const r = Math.sqrt(px * px + py * py) / (potholes[p + 2] ?? 1);
        if (r < 1.5)
          z += -1.6 * Math.max(0, 1 - r * r) + 0.35 * Math.exp(-((r - 1.1) * (r - 1.1)) / 0.04);
      }
      bed[k] = z;
    }
  }

  // Still water: the band along the top is the sea, held at its level.
  const outlet = new Uint8Array(n);
  const bandRows = Math.max(1, Math.round(TIDEPOOL_SEA_BAND * rows));
  outlet.fill(1, (rows - bandRows) * columns);
  const level = stillWater(bed, columns, rows, outlet, sea);
  const rest = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const depth = (level[k] ?? 0) - (bed[k] ?? 0);
    rest[k] = depth > WET ? depth : 0;
  }
  // The relief leaves dozens of hollows a few cells across that would all hold water; only the sea,
  // the basin and real potholes open full. The rest start dry (rain and spray may fill them later).
  const seen = new Uint8Array(n);
  const queue = new Int32Array(n);
  for (let start = 0; start < n; start++) {
    if (seen[start] === 1 || (rest[start] ?? 0) <= WET) continue;
    let head = 0;
    let tail = 0;
    let deepest = 0;
    let open = false;
    seen[start] = 1;
    queue[tail++] = start;
    while (head < tail) {
      const k = queue[head++] ?? 0;
      deepest = Math.max(deepest, rest[k] ?? 0);
      open ||= outlet[k] === 1;
      const x = k % columns;
      for (let side = 0; side < 4; side++) {
        const j =
          side === 0
            ? x > 0
              ? k - 1
              : -1
            : side === 1
              ? x < columns - 1
                ? k + 1
                : -1
              : side === 2
                ? k - columns
                : k + columns;
        if (j < 0 || j >= n || seen[j] === 1 || (rest[j] ?? 0) <= WET) continue;
        seen[j] = 1;
        queue[tail++] = j;
      }
    }
    if (open || (tail >= PUDDLE_AREA * rows * rows && deepest >= PUDDLE_DEPTH)) continue;
    for (let i = 0; i < tail; i++) rest[queue[i] ?? 0] = 0;
  }
  const texture = new Float32Array(n * 4);
  for (let k = 0; k < n; k++) {
    texture[k * 4] = bed[k] ?? 0;
    texture[k * 4 + 1] = rest[k] ?? 0;
    texture[k * 4 + 2] = inside[k] ?? 0;
    texture[k * 4 + 3] = channel[k] ?? 0;
  }
  return { columns, rows, bed, rest, texture, pool };
}
