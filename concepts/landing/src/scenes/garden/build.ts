// The dry garden's build (sims/build.ts), on the build worker: a layout (sim.ts's header) laid
// straight from the rake's plan: the islands for the arrangement's seed, the plan for the pattern
// and the M, and every texel of the gravel at the groove phase the plan leaves there (gardenLayout).
// The page's sim (sim.ts) smooths it once and sets the rake down to re-cut it for real.
import { markVertex } from "../../mark.ts";
import type { BuildKind } from "../../sims/build.ts";
import type { RakeOptions } from "../../sims/heightfield.ts";
import { clamp } from "../../sims/math.ts";
import { mulberry32 } from "../../sims/random.ts";
import type { GardenPattern } from "./constants.ts";

/**
 * The garden and its two cameras, shared with the shader. Garden space: X right (0..aspect), Y away
 * from the veranda (0..1), Z up, in garden depths.
 *   veranda: a shifted-lens pinhole at (aspect / 2, eyeY, eyeHeight) looking along +Y, horizon at
 *            screen height `horizon`, focal length `focal` in screen heights (as viewRay's 0.5 /
 *            tan(fov / 2)); the earthen wall stands at Y = wallY.
 *   above:   a pinhole `overheadHeight` above (aspect / 2, overheadY) looking straight down; the
 *            ground spans `span` garden depths per screen height, from the drip line to the wall's cap.
 */
export const GARDEN = {
  aspect: 2.4,
  cols: 672,
  rows: 280,
  /** The pebble drip line along the veranda: garden Y below this is not raked. */
  drip: 0.03,
  wallY: 1.03,
  wallHeight: 0.125,
  capHeight: 0.032,
  focal: 1.25,
  horizon: 1.0,
  eyeHeight: 0.253,
  eyeY: -0.316,
  span: 1.06,
  overheadHeight: 1.5,
  overheadY: 0.52,
} as const;

/**
 * The Manifold M: where it lies when it is on (that patch of gravel is kept clear of islands), its
 * height in garden depths at the size knob's ends (small + grow × size), its slate's half stroke
 * width in M heights, and how far the slate stands above the gravel: a few centimetres, nearly
 * flush.
 */
export const GARDEN_MARK = {
  x: 1.5,
  y: 0.36,
  reserve: 0.32,
  small: 0.12,
  grow: 0.16,
  stroke: 0.055,
  slate: 0.004,
} as const;

export const GA = GARDEN.aspect;
/** Positions are packed relative to the garden's centre, where half floats are finest. */
export const OX = GA / 2;
export const OY = 0.5;
export const TAU = Math.PI * 2;

// ---- the rake ------------------------------------------------------------------------------------

/** The garden rake: five tines; a groove 3 mm deep would be invisible, so these are stage-sized. */
export const RAKE: RakeOptions = {
  width: 0.012,
  depth: 0.003,
  ridge: 0.012,
  tines: 5,
  spacing: 0.024,
};
/** The grooves' spacing: below it on screen the shader lets their light and water melt away. */
export const GARDEN_GROOVE = RAKE.spacing;
/** One pass of the rake covers this width: passes and ring laps are laid this far apart. */
const SWATH = RAKE.tines * RAKE.spacing;
/** Centre of the nearest pass; passes then every SWATH out to the wall. */
const PASS_FIRST = 0.1;
const PASSES = 8;
/** Groove centres of the line patterns start here (the nearest pass's nearest tine). */
const LINE_FIRST = PASS_FIRST - 0.5 * (RAKE.tines - 1) * RAKE.spacing;
/** Waves: amplitude and wavelength of the passes' meander. */
const WAVE_AMPLITUDE = 0.028;
const WAVE_LENGTH = 0.62;
/** Laps of rings around each island (and the M) in the line patterns: five rings. */
const RING_LAPS = 1;
/** The first ring's innermost groove sits this far outside an island's clear radius... */
const RING_GAP = 0.012;
/** ...so the rake's centre runs this far out on the first lap, and a SWATH further on each next. */
const RING_FIRST = RING_GAP + 0.5 * (RAKE.tines - 1) * RAKE.spacing;
/**
 * Plan polylines are sampled this finely: the tool lays each piece's banks square to that piece, so
 * a coarse bend would leave beads where the pieces meet at an angle.
 */
const PLAN_STEP = 0.006;
/** Pieces of a pass shorter than this between ring zones are not worth setting the rake down for. */
const MIN_STROKE = 0.04;
/** Weathered groove amplitude a layout starts with (a fresh cut is RAKE.depth deep). */
const LAID_AMPLITUDE = 0.0022;

// ---- small helpers -------------------------------------------------------------------------------

/** The meander of the "waves" passes at X. */
const waveAt = (x: number): number => WAVE_AMPLITUDE * Math.sin((TAU * x) / WAVE_LENGTH);

/** Distance from (px, py) to the M of height `size` centred on GARDEN_MARK, and the unit gradient. */
export function markField(px: number, py: number, size: number, out: Float64Array): number {
  let best = Infinity;
  let bx = 0;
  let by = 0;
  for (let k = 0; k < 4; k++) {
    const a = markVertex(k);
    const b = markVertex(k + 1);
    const ax = GARDEN_MARK.x + a[0] * size;
    const ay = GARDEN_MARK.y + a[1] * size;
    const ex = GARDEN_MARK.x + b[0] * size - ax;
    const ey = GARDEN_MARK.y + b[1] * size - ay;
    const l2 = ex * ex + ey * ey;
    const t = l2 > 0 ? clamp(((px - ax) * ex + (py - ay) * ey) / l2, 0, 1) : 0;
    const qx = ax + t * ex;
    const qy = ay + t * ey;
    const d = Math.hypot(px - qx, py - qy);
    if (d < best) {
      best = d;
      bx = qx;
      by = qy;
    }
  }
  const inv = 1 / Math.max(best, 1e-9);
  out[0] = (px - bx) * inv;
  out[1] = (py - by) * inv;
  return best;
}

// ---- islands -------------------------------------------------------------------------------------

export interface GardenStone {
  x: number;
  y: number;
  /** Half-axes of the stone's footprint. */
  rx: number;
  ry: number;
  height: number;
  /** Turn of the footprint's long axis. */
  angle: number;
  /** 0..1: the shape of its weathering. */
  seed: number;
}

interface GardenIsland {
  x: number;
  y: number;
  /** The gravel is left smooth within this radius; the rings start just outside it. */
  clear: number;
  stones: GardenStone[];
}

/** The composition the default arrangement shows: four islands after the Ryōan-ji groups. */
function defaultIslands(): GardenIsland[] {
  return [
    {
      x: 0.8,
      y: 0.66,
      clear: 0.135,
      stones: [
        { x: 0.805, y: 0.675, rx: 0.043, ry: 0.034, height: 0.105, angle: 0.35, seed: 0.13 },
        { x: 0.735, y: 0.632, rx: 0.03, ry: 0.024, height: 0.05, angle: -0.4, seed: 0.61 },
        { x: 0.872, y: 0.622, rx: 0.024, ry: 0.018, height: 0.026, angle: 0.9, seed: 0.37 },
      ],
    },
    {
      x: 1.3,
      y: 0.86,
      clear: 0.1,
      stones: [
        { x: 1.285, y: 0.858, rx: 0.06, ry: 0.028, height: 0.033, angle: -0.15, seed: 0.82 },
        { x: 1.355, y: 0.872, rx: 0.027, ry: 0.024, height: 0.076, angle: 0.6, seed: 0.45 },
      ],
    },
    {
      x: 0.95,
      y: 0.3,
      clear: 0.075,
      stones: [{ x: 0.95, y: 0.3, rx: 0.036, ry: 0.028, height: 0.04, angle: 1.1, seed: 0.29 }],
    },
    {
      x: 1.74,
      y: 0.72,
      clear: 0.1,
      stones: [
        { x: 1.735, y: 0.73, rx: 0.036, ry: 0.03, height: 0.088, angle: -0.5, seed: 0.71 },
        { x: 1.8, y: 0.69, rx: 0.022, ry: 0.02, height: 0.034, angle: 0.2, seed: 0.05 },
      ],
    },
  ];
}

/**
 * Another arrangement: three or four islands of one to three stones, inside what the veranda sees,
 * clear of each other and of the M's patch. Seed 0 is the default composition.
 */
function layIslands(seed: number): GardenIsland[] {
  if (seed === 0) return defaultIslands();
  const rand = mulberry32(Math.imul(seed + 7, 0x9e3779b1));
  const count = rand() < 0.6 ? 4 : 3;
  const islands: GardenIsland[] = [];
  for (let attempt = 0; attempt < 400 && islands.length < count; attempt++) {
    const first = islands.length === 0;
    const clear = first ? 0.11 + 0.03 * rand() : 0.07 + 0.05 * rand();
    const y = 0.26 + 0.6 * rand();
    const half = Math.min(0.62 * (y - GARDEN.eyeY), 0.82) - clear - 0.04;
    if (half <= 0) continue;
    const x = OX + (2 * rand() - 1) * half;
    if (Math.hypot(x - GARDEN_MARK.x, y - GARDEN_MARK.y) < GARDEN_MARK.reserve + clear) continue;
    if (islands.some((o) => Math.hypot(x - o.x, y - o.y) < clear + o.clear + 0.12)) continue;
    const stones: GardenStone[] = [];
    const n = 1 + Math.floor(rand() * (clear > 0.1 ? 3 : 2));
    const mainR = clear * (0.28 + 0.08 * rand());
    const tall = first || rand() < 0.5;
    stones.push({
      x: x + (rand() - 0.5) * 0.02,
      y: y + (rand() - 0.5) * 0.02,
      rx: mainR,
      ry: mainR * (0.7 + 0.25 * rand()),
      height: tall ? 0.07 + 0.04 * rand() : 0.03 + 0.02 * rand(),
      angle: rand() * Math.PI,
      seed: rand(),
    });
    for (let k = 1; k < n; k++) {
      const r = mainR * (0.45 + 0.25 * rand());
      const a = rand() * TAU;
      const reach = Math.min(mainR + r * 0.9, clear - r - 0.01);
      stones.push({
        x: x + Math.cos(a) * reach,
        y: y + Math.sin(a) * reach,
        rx: r,
        ry: r * (0.7 + 0.25 * rand()),
        height: 0.02 + 0.035 * rand(),
        angle: rand() * Math.PI,
        seed: rand(),
      });
    }
    islands.push({ x, y, clear, stones });
  }
  return islands;
}

// ---- the plan ------------------------------------------------------------------------------------

/** A stretch the rake is drawn along without lifting: a polyline with cumulative distances. */
export interface Stroke {
  readonly xy: Float64Array;
  readonly at: Float64Array;
  readonly length: number;
}

function strokeOf(points: readonly number[]): Stroke {
  const n = points.length >> 1;
  const xy = Float64Array.from(points);
  const at = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    at[i] =
      (at[i - 1] ?? 0) +
      Math.hypot(
        (xy[2 * i] ?? 0) - (xy[2 * i - 2] ?? 0),
        (xy[2 * i + 1] ?? 0) - (xy[2 * i - 1] ?? 0),
      );
  }
  return { xy, at, length: at[n - 1] ?? 0 };
}

export interface Layout {
  pattern: GardenPattern;
  islands: GardenIsland[];
  /** The M's height, 0 when it is off. */
  mark: number;
}

/** The ring zone around island i (line patterns): its rings reach this far from the centre. */
const ringReach = (island: GardenIsland): number => island.clear + RING_LAPS * SWATH;
/** The M's slate half width, and the reach of its rings, from its strokes. */
export const markSlate = (mark: number): number => GARDEN_MARK.stroke * mark;
const markReach = (mark: number): number => markSlate(mark) + RING_GAP + RING_LAPS * SWATH;

/** Inside some ring zone (where the line patterns lift the rake). */
function inRingZone(layout: Layout, x: number, y: number, grad: Float64Array): boolean {
  for (const island of layout.islands) {
    if (Math.hypot(x - island.x, y - island.y) < ringReach(island)) return true;
  }
  return layout.mark > 0 && markField(x, y, layout.mark, grad) < markReach(layout.mark);
}

/** Within the raked part of the field (a margin beyond the sides, so the edges are raked through). */
const inField = (x: number, y: number): boolean =>
  x > -0.06 && x < GA + 0.06 && y > PASS_FIRST - 0.06 && y < 1.0;

/**
 * Trace the closed contour at distance r around the M (marching along the level set, pulled back
 * onto it after every step), as plan points.
 */
function markContour(mark: number, r: number, grad: Float64Array): number[] {
  let x = GARDEN_MARK.x - 0.47 * mark - r;
  let y = GARDEN_MARK.y;
  const points = [x, y];
  let travelled = 0;
  const limit = 8 * (mark + TAU * r) + 1;
  while (travelled < limit) {
    markField(x, y, mark, grad);
    const mx = x + 0.5 * PLAN_STEP * (grad[1] ?? 0);
    const my = y - 0.5 * PLAN_STEP * (grad[0] ?? 0);
    markField(mx, my, mark, grad);
    x += PLAN_STEP * (grad[1] ?? 0);
    y -= PLAN_STEP * (grad[0] ?? 0);
    const d = markField(x, y, mark, grad);
    x -= (d - r) * (grad[0] ?? 0);
    y -= (d - r) * (grad[1] ?? 0);
    travelled += PLAN_STEP;
    points.push(x, y);
    if (
      travelled > 2 * mark &&
      Math.hypot(x - (points[0] ?? 0), y - (points[1] ?? 0)) < 1.5 * PLAN_STEP
    )
      break;
  }
  // Close it, and run on past the start so the lap's ends overlap.
  for (let k = 0; k < 16 && k < points.length; k++) points.push(points[k] ?? 0);
  return points;
}

/** A circle around (cx, cy), kept only where `keep` says, split into strokes. */
function ringStrokes(
  cx: number,
  cy: number,
  r: number,
  keep: (x: number, y: number) => boolean,
  strokes: Stroke[],
): boolean {
  const n = Math.max(12, Math.ceil((TAU * r) / PLAN_STEP));
  const kept: boolean[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    kept.push(keep(cx + r * Math.cos(a), cy + r * Math.sin(a)));
  }
  if (!kept.includes(true)) return false;
  // Start just after a gap (or anywhere on a full circle), so a run never straddles the seam.
  const gap = kept.indexOf(false);
  const start = gap < 0 ? 0 : gap;
  let run: number[] = [];
  const flush = (): void => {
    if (run.length >= 4) {
      const stroke = strokeOf(run);
      if (stroke.length >= MIN_STROKE) strokes.push(stroke);
    }
    run = [];
  };
  // A full circle laps on past its start, so the lap's ends overlap.
  const total = gap < 0 ? n + 8 : n + 1;
  for (let k = 0; k <= total; k++) {
    const i = (start + k) % n;
    if (kept[i] === true) {
      const a = (i / n) * TAU;
      run.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
    } else {
      flush();
    }
  }
  flush();
  return true;
}

/** The rake's choreography for a layout: every stroke of one full tending of the garden. */
function buildPlan(layout: Layout): Stroke[] {
  const strokes: Stroke[] = [];
  const grad = new Float64Array(2);
  const islands = layout.islands;
  if (layout.pattern === "circles") {
    // Rings spread out from every stone (and the M) at once, lap by lap, each kept to the gravel
    // nearer its own centre than any other (a power diagram on the clear radii).
    const own =
      (k: number) =>
      (x: number, y: number): boolean => {
        if (!inField(x, y)) return false;
        const mine =
          k < islands.length
            ? Math.hypot(x - (islands[k]?.x ?? 0), y - (islands[k]?.y ?? 0)) -
              (islands[k]?.clear ?? 0)
            : markField(x, y, layout.mark, grad) - markSlate(layout.mark);
        for (let j = 0; j < islands.length; j++) {
          const o = islands[j];
          if (j === k || o === undefined) continue;
          if (Math.hypot(x - o.x, y - o.y) - o.clear < mine) return false;
        }
        if (
          k < islands.length &&
          layout.mark > 0 &&
          markField(x, y, layout.mark, grad) - markSlate(layout.mark) < mine
        )
          return false;
        return true;
      };
    const centres = islands.length + (layout.mark > 0 ? 1 : 0);
    const live = new Array<boolean>(centres).fill(true);
    for (let lap = 0; lap < 40 && live.includes(true); lap++) {
      for (let k = 0; k < centres; k++) {
        if (live[k] !== true) continue;
        const island = islands[k];
        if (island !== undefined) {
          live[k] = ringStrokes(
            island.x,
            island.y,
            island.clear + RING_FIRST + lap * SWATH,
            own(k),
            strokes,
          );
        } else {
          const r = markSlate(layout.mark) + RING_FIRST + lap * SWATH;
          const run: number[] = [];
          const contour = markContour(layout.mark, r, grad);
          const keep = own(k);
          let any = false;
          for (let i = 0; i < contour.length; i += 2) {
            const x = contour[i] ?? 0;
            const y = contour[i + 1] ?? 0;
            if (keep(x, y)) {
              run.push(x, y);
              any = true;
            } else if (run.length > 0) {
              const stroke = strokeOf(run);
              if (stroke.length >= MIN_STROKE) strokes.push(stroke);
              run.length = 0;
            }
          }
          if (run.length >= 4) {
            const stroke = strokeOf(run);
            if (stroke.length >= MIN_STROKE) strokes.push(stroke);
          }
          live[k] = any;
        }
      }
    }
    return strokes;
  }

  // Line patterns: passes across the whole width, far to near, back and forth, the rake lifted over
  // the ring zones; then the rings around each island, inner lap first; then the M's.
  const waves = layout.pattern === "waves";
  for (let k = PASSES - 1; k >= 0; k--) {
    const y0 = PASS_FIRST + k * SWATH;
    const forward = (PASSES - 1 - k) % 2 === 0;
    const run: number[] = [];
    const flush = (): void => {
      if (run.length >= 4) {
        const stroke = strokeOf(run);
        if (stroke.length >= MIN_STROKE) strokes.push(stroke);
      }
      run.length = 0;
    };
    const n = Math.ceil((GA + 0.12) / PLAN_STEP);
    for (let i = 0; i <= n; i++) {
      const x = forward ? -0.06 + i * PLAN_STEP : GA + 0.06 - i * PLAN_STEP;
      const y = y0 + (waves ? waveAt(x) : 0);
      if (inRingZone(layout, x, y, grad)) flush();
      else run.push(x, y);
    }
    flush();
  }
  for (const island of islands) {
    for (let lap = 0; lap < RING_LAPS; lap++) {
      ringStrokes(island.x, island.y, island.clear + RING_FIRST + lap * SWATH, inField, strokes);
    }
  }
  if (layout.mark > 0) {
    for (let lap = 0; lap < RING_LAPS; lap++) {
      const contour = markContour(
        layout.mark,
        markSlate(layout.mark) + RING_FIRST + lap * SWATH,
        grad,
      );
      strokes.push(strokeOf(contour));
    }
  }
  return strokes;
}

/**
 * The groove phase the plan leaves at (x, y): grooves at whole numbers, NaN where the gravel is
 * left smooth (inside an island's clear radius, under the M, outside the raked field).
 */
function phaseAt(layout: Layout, x: number, y: number, grad: Float64Array): number {
  if (y < LINE_FIRST - 0.5 * RAKE.spacing || y > 1.0) return Number.NaN;
  const islands = layout.islands;
  const markOn = layout.mark > 0;
  const slate = markSlate(layout.mark);
  if (layout.pattern === "circles") {
    let best = Infinity;
    let phase = Number.NaN;
    for (const island of islands) {
      const d = Math.hypot(x - island.x, y - island.y) - island.clear;
      if (d < best) {
        best = d;
        phase = d < 0 ? Number.NaN : (d - RING_GAP) / RAKE.spacing;
      }
    }
    if (markOn) {
      const d = markField(x, y, layout.mark, grad) - slate;
      if (d < best) phase = d < 0 ? Number.NaN : (d - RING_GAP) / RAKE.spacing;
    }
    return phase;
  }
  // Later strokes win where ring zones overlap: the M, then the islands from last to first.
  if (markOn) {
    const d = markField(x, y, layout.mark, grad);
    if (d < markReach(layout.mark))
      return d < slate ? Number.NaN : (d - slate - RING_GAP) / RAKE.spacing;
  }
  for (let i = islands.length - 1; i >= 0; i--) {
    const island = islands[i];
    if (island === undefined) continue;
    const d = Math.hypot(x - island.x, y - island.y);
    if (d < ringReach(island))
      return d < island.clear ? Number.NaN : (d - island.clear - RING_GAP) / RAKE.spacing;
  }
  return (y - (layout.pattern === "waves" ? waveAt(x) : 0) - LINE_FIRST) / RAKE.spacing;
}

/**
 * A weathered groove across one period, phase 0 at the groove's centre: a rounded cut over half
 * the period, the spoil heaped in a hump between (equal volumes).
 */
function grooveProfile(phase: number): number {
  const u = Math.abs(phase - Math.round(phase));
  if (u < 0.25) {
    const s = u / 0.25;
    return -(1 - s * s);
  }
  return (Math.PI / 3) * Math.sin((Math.PI * (u - 0.25)) / 0.5);
}

/** A garden to lay out: its pattern, the arrangement of its stones (seed) and the M's height (0: off). */
export interface GardenLayoutRequest {
  readonly pattern: GardenPattern;
  readonly seed: number;
  readonly mark: number;
}

/** A garden laid out: its islands, the rake's plan, and the gravel laid from it (not yet smoothed). */
export interface GardenLaid {
  readonly layout: Layout;
  readonly plan: Stroke[];
  readonly heights: Float32Array;
}

/** Rows of gravel a layout lays between looks at the build worker's messages. */
const LAY_ROWS = 40;

/**
 * Laying a garden out as a build (sims/build.ts): its islands, the rake's plan, and every texel of
 * the gravel at the groove phase the plan leaves there, with a weathered profile. The page smooths
 * it once and sets the rake down (GardenSim #relay).
 */
export const gardenLayout: BuildKind<GardenLayoutRequest, GardenLaid> = {
  name: "garden",
  builder: () => ({
    *build({ pattern, seed, mark }) {
      const layout: Layout = { pattern, islands: layIslands(seed), mark };
      const plan = buildPlan(layout);
      const w = GARDEN.cols;
      const h = GARDEN.rows;
      const heights = new Float32Array(w * h);
      const grad = new Float64Array(2);
      for (let j = 0; j < h; j++) {
        if (j % LAY_ROWS === 0) yield undefined;
        const y = (j + 0.5) / h;
        for (let i = 0; i < w; i++) {
          const phase = phaseAt(layout, ((i + 0.5) / w) * GA, y, grad);
          heights[j * w + i] = Number.isNaN(phase) ? 0 : LAID_AMPLITUDE * grooveProfile(phase);
        }
      }
      return { layout, plan, heights };
    },
  }),
};
