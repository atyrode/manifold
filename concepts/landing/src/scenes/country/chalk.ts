// The chalk M (the `chalk` knob): a giant Manifold M cut through the turf of a hillside facing the
// vantage, in the manner of the Uffington White Horse.
//
// Its lie: the M is laid out to read from the vantage, as the hill figures cut to be seen from one
// place are. A point of the ground near the site is in the M where the vantage's eye sees it inside
// the M's outline, CHALK.size of the view across, centred where it sees the site: the figure's x
// runs left to right and its y up as the vantage sees them, whatever way the slope lies, drawn out
// up the slope by as much as the slope foreshortens it, at most CHALK.stretch times its own
// proportions (past that it reads squatter). It is the records' eye that sees it, not the camera,
// so the M stays cut in the ground while the camera moves on its passage.
//
// Its site (chalkSite, once per terrain the first time the knob is on): candidates on a grid inside
// the default framing (within CHALK.bearing of the heading, CHALK.near..CHALK.far ahead) are weighed
// on the plane through their footprint: steep enough (CHALK.gentlest..CHALK.steepest) and turned to
// the eye (CHALK.facing), so the M stands as tall as it should; central and not too far. Every point
// of the footprint with a margin round it must be dry ground off the roads, streams and yards, turned
// to the eye. The best are then marched from the eye, nine points of each (the ground away from the
// figure and the vantage's open slopes raised by a wood's height, so no wood the land model may grow
// hides it; where none of the best is in sight so, over the bare land), and kept off the river's
// banks (where its lone trees stand): the first in sight is the site. None passes, no figure.
//
// The parcels it lies on, and those just below its foot whose woods would hide it, are kept open
// grassland while it shows (keepChalkOpen, after the land model's allocation), so no wood, field,
// hedge or herd covers it. packChalk writes the site into two texels of the records' misc row past
// the terrain's own (TERRAIN_RECORDS: it uses 0..5), which countryChalk reads in the ground branch,
// cut per cell.
import type { LandAllocation, LandModel } from "../../sims/landuse.ts";
import { hypot2, hypot3, smoothstep } from "../../sims/math.ts";
import {
  sampleGrid,
  TERRAIN_RECORDS,
  type Terrain,
  type TerrainPacked,
} from "../../sims/terrain.ts";

/** The chalk figure's numbers (metres and radians but where noted). */
export const CHALK = {
  /** Between candidate centres. */
  step: 40,
  /** Its distance ahead of the vantage along the heading. */
  near: 450,
  far: 2300,
  /** Most bearing off the heading: inside a 4:3 frame's default framing. */
  bearing: 0.33,
  /** The view the M's height (a mark unit) spans, before any squat. */
  size: 0.07,
  /** The slope's rise over run, its plane over the figure's breadth. */
  gentlest: 0.1,
  steepest: 0.9,
  /** Least the slope turns to the eye: its normal against the way to the eye. */
  facing: 0.15,
  /** Most it is drawn out up the slope, over its own proportions. */
  stretch: 2.4,
  /** Mark units of clear ground round the M, and of open ground below its foot. */
  margin: 0.12,
  below: 0.5,
  /** Clearance from roads and streams (their signed distance). */
  road: 6,
  stream: 5,
  /** A wood's height: the eye must see over any wood but on the ground the figure keeps open. */
  wood: 13,
  /** Candidates marched for sight, best first. */
  marched: 60,
  /** Texel column of its two texels in the records' misc row. */
  column: 8,
} as const;

/** Where the M is cut, how it is laid out, the parcels it lies on. */
export interface ChalkSite {
  /** Where the vantage sees its centre: right and up over the depth ahead (the view's tangents). */
  screen: readonly [number, number];
  /** The view a mark unit spans across and up (up squatter where the slope cannot hold it whole). */
  size: readonly [number, number];
  /** Its centre's depth ahead of the vantage, and how far its ground reaches either side of it. */
  depth: number;
  reach: number;
  /** TerrainParcels indices it lies on, with its margin and the ground below its foot. */
  parcels: number[];
}

interface Candidate {
  x: number;
  z: number;
  screen: readonly [number, number];
  size: readonly [number, number];
  depth: number;
  /** Map metres (x, z) a mark unit runs along the M's x and along its y, on the slope's plane. */
  alongX: readonly [number, number];
  alongY: readonly [number, number];
  score: number;
}

/** The slope that shows the M best from the vantage, or null where none in sight will do. */
export function chalkSite(t: Terrain): ChalkSite | null {
  const { size: m, extent: W } = t;
  const v = t.vantage;
  const ground = (x: number, z: number) => sampleGrid(t.ground, m, W, x, z);
  const surface = (x: number, z: number) => Math.max(ground(x, z), sampleGrid(t.level, m, W, x, z));
  // The camera's level frame: forward and right on the map.
  const fx = v.dx;
  const fz = v.dz;
  const rx = v.dz;
  const rz = -v.dx;
  const candidates: Candidate[] = [];
  for (let z = CHALK.step / 2; z < W; z += CHALK.step) {
    for (let x = CHALK.step / 2; x < W; x += CHALK.step) {
      const y = ground(x, z);
      const cx = x - v.x;
      const cy = y - v.y;
      const cz = z - v.z;
      const depth = cx * fx + cz * fz;
      const side = cx * rx + cz * rz;
      const bearing = Math.abs(Math.atan2(side, depth));
      if (depth < CHALK.near || depth > CHALK.far || bearing > CHALK.bearing) continue;
      const distance = hypot3(cx, cy, cz);
      // The plane through its footprint, over about its half breadth.
      const half = 0.5 * CHALK.size * distance;
      const gx = (ground(x + half, z) - ground(x - half, z)) / (2 * half);
      const gz = (ground(x, z + half) - ground(x, z - half)) / (2 * half);
      const grade = hypot2(gx, gz);
      if (grade < CHALK.gentlest || grade > CHALK.steepest) continue;
      const facing = (gx * cx - cy + gz * cz) / hypot3(gx, 1, gz) / distance;
      if (facing < CHALK.facing) continue;
      // The eye's view at the site, to first order (screen right and up per metre over the mark's
      // size across and, squatter where the slope cannot hold it whole, up), and through it the map
      // metres a mark unit runs along the M's x and y on the slope's plane.
      const squat = Math.min(1, CHALK.stretch * facing);
      const sx = 1 / (depth * depth * CHALK.size);
      const sy = sx / squat;
      const a0 = (rx * depth - fx * side) * sx;
      const a1 = (rz * depth - fz * side) * sx;
      const b0 = (-fx * cy + depth * gx) * sy;
      const b1 = (-fz * cy + depth * gz) * sy;
      const det = a0 * b1 - a1 * b0;
      if (Math.abs(det) < 1e-12) continue;
      const candidate: Candidate = {
        x,
        z,
        screen: [side / depth, cy / depth],
        size: [CHALK.size, CHALK.size * squat],
        depth,
        alongX: [b1 / det, -b0 / det],
        alongY: [-a1 / det, a0 / det],
        score: 0,
      };
      const wood = footprint(t, candidate);
      if (wood < 0) continue;
      candidate.score =
        squat ** 2 *
        Math.sqrt(facing) *
        (1 - 0.5 * smoothstep(0.1, CHALK.bearing, bearing)) *
        Math.exp(-(((distance - 1100) / 800) ** 2)) *
        (1 - 0.3 * wood);
      candidates.push(candidate);
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const eye = { x: v.x, y: v.y, z: v.z };
  // In sight over any wood that may grow, else (none of the best is) over the bare land.
  for (const wood of [CHALK.wood, 0]) {
    for (const c of candidates.slice(0, CHALK.marched)) {
      let seen = true;
      // Nine points of the M in sight and off the banks, and the foot of the ground it keeps open
      // below it off the banks too.
      for (let k = 0; k < 12 && seen; k++) {
        const [px, pz] = onPlane(
          c,
          0.42 * ((k % 3) - 1),
          k < 9 ? 0.45 * (Math.floor(k / 3) - 1) : -0.5 - CHALK.below,
        );
        seen =
          (k >= 9 || inSight(eye, px, ground(px, pz) + 1, pz, c, surface, wood)) &&
          offBanks(t, px, pz);
      }
      if (!seen) continue;
      // How far the ground it keeps open reaches nearer and farther than its centre.
      const wide = 0.47 + CHALK.margin;
      const reach = Math.max(
        ...[
          onPlane(c, -wide, 0.5 + CHALK.margin),
          onPlane(c, wide, 0.5 + CHALK.margin),
          onPlane(c, -wide, -0.5 - CHALK.below),
          onPlane(c, wide, -0.5 - CHALK.below),
        ].map(([x, z]) => Math.abs((x - v.x) * fx + (z - v.z) * fz - c.depth)),
      );
      return {
        screen: c.screen,
        size: c.size,
        depth: c.depth,
        reach: reach + 30,
        parcels: underneath(t, c),
      };
    }
  }
  return null;
}

/** The map point (x, z) at mark coordinates (mx, my) on the candidate's plane. */
function onPlane(c: Candidate, mx: number, my: number): [number, number] {
  return [c.x + c.alongX[0] * mx + c.alongY[0] * my, c.z + c.alongX[1] * mx + c.alongY[1] * my];
}

/**
 * Whether the candidate's footprint with its margin is clear and turned to the eye, at 5 × 5 points:
 * its mean woodland suitability (0..1), or -1.
 */
function footprint(t: Terrain, c: Candidate): number {
  const { size: m, extent: W } = t;
  const v = t.vantage;
  let wood = 0;
  for (let k = 0; k < 25; k++) {
    const [x, z] = onPlane(
      c,
      0.5 * ((k % 5) - 2) * (0.47 + CHALK.margin),
      0.5 * (Math.floor(k / 5) - 2) * (0.5 + CHALK.margin),
    );
    if (x < 20 || z < 20 || x > W - 20 || z > W - 20) return -1;
    const g = sampleGrid(t.ground, m, W, x, z);
    if (sampleGrid(t.level, m, W, x, z) > g - 0.3) return -1;
    if (sampleGrid(t.road, m, W, x, z) < CHALK.road) return -1;
    if (sampleGrid(t.stream, m, W, x, z) < CHALK.stream) return -1;
    const q = Math.floor((z / W) * m) * m + Math.floor((x / W) * m);
    if ((t.yard[q] ?? 0) > 0.02) return -1;
    const e = 2 * t.cell;
    const gx =
      (sampleGrid(t.ground, m, W, x + e, z) - sampleGrid(t.ground, m, W, x - e, z)) / (2 * e);
    const gz =
      (sampleGrid(t.ground, m, W, x, z + e) - sampleGrid(t.ground, m, W, x, z - e)) / (2 * e);
    const ex = v.x - x;
    const ey = v.y - g;
    const ez = v.z - z;
    if ((-gx * ex + ey - gz * ez) / hypot3(gx, 1, gz) / hypot3(ex, ey, ez) < 0.06) return -1;
    wood += (t.wood[q] ?? 0) / 25;
  }
  return wood;
}

/**
 * Whether the eye sees (x, y, z) over the land: the water and the ground, raised by `wood` metres
 * (a wood that may grow there) but on the vantage's open slopes and the ground the figure keeps open.
 */
function inSight(
  eye: { x: number; y: number; z: number },
  x: number,
  y: number,
  z: number,
  c: Candidate,
  surface: (x: number, z: number) => number,
  wood: number,
): boolean {
  const length = hypot3(x - eye.x, y - eye.y, z - eye.z);
  for (let d = 30; d < length - 3; d += 6) {
    const f = d / length;
    const px = eye.x + (x - eye.x) * f;
    const pz = eye.z + (z - eye.z) * f;
    const wooded = wood > 0 && !opened(c, px, pz) && hypot2(px - eye.x, pz - eye.z) > 300;
    if (eye.y + (y - eye.y) * f < surface(px, pz) + (wooded ? wood : 0)) return false;
  }
  return true;
}

/** Whether map point (x, z) lies on the ground the figure keeps open: it and its margin, and below. */
function opened(c: Candidate, x: number, z: number): boolean {
  const det = c.alongX[0] * c.alongY[1] - c.alongX[1] * c.alongY[0];
  const dx = x - c.x;
  const dz = z - c.z;
  const mx = (dx * c.alongY[1] - dz * c.alongY[0]) / det;
  const my = (c.alongX[0] * dz - c.alongX[1] * dx) / det;
  return (
    Math.abs(mx) <= 0.47 + CHALK.margin && my <= 0.5 + CHALK.margin && my >= -0.5 - CHALK.below
  );
}

/** Whether (x, z) lies off the river's banks, where its lone trees stand. */
function offBanks(t: Terrain, x: number, z: number): boolean {
  const r = t.river;
  for (let k = 0; k < r.x.length; k += 2) {
    const w = r.width[k] ?? 0;
    if (hypot2((r.x[k] ?? 0) - x, (r.z[k] ?? 0) - z) < 0.75 * w + 25) return false;
  }
  return true;
}

/** The parcels on the ground the figure keeps open (TerrainParcels indices). */
function underneath(t: Terrain, c: Candidate): number[] {
  const m = t.size;
  const wide = 0.47 + CHALK.margin;
  const corners = [
    onPlane(c, -wide, 0.5 + CHALK.margin),
    onPlane(c, wide, 0.5 + CHALK.margin),
    onPlane(c, -wide, -0.5 - CHALK.below),
    onPlane(c, wide, -0.5 - CHALK.below),
  ];
  const xs = corners.map(([x]) => x);
  const zs = corners.map(([, z]) => z);
  const i0 = Math.max(0, Math.floor(Math.min(...xs) / t.cell));
  const i1 = Math.min(m - 1, Math.ceil(Math.max(...xs) / t.cell));
  const j0 = Math.max(0, Math.floor(Math.min(...zs) / t.cell));
  const j1 = Math.min(m - 1, Math.ceil(Math.max(...zs) / t.cell));
  const found = new Set<number>();
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      if (!opened(c, (i + 0.5) * t.cell, (j + 0.5) * t.cell)) continue;
      const id = t.parcels.ids[2 * (j * m + i)] ?? 0;
      if (id > 0) found.add(id - 1);
    }
  }
  return [...found].sort((a, b) => a - b);
}

/**
 * Write the site into the records' misc row (TERRAIN_RECORDS), two texels from CHALK.column:
 * (screen right, up, size across, up), (depth, reach, 0, 0); all zero where there is none.
 */
export function packChalk(packed: TerrainPacked, site: ChalkSite | null): void {
  const o = 4 * (TERRAIN_RECORDS.misc * TERRAIN_RECORDS.width + CHALK.column);
  packed.records.fill(0, o, o + 8);
  if (site) packed.records.set([...site.screen, ...site.size, site.depth, site.reach], o);
}

/** Keep the parcels under the figure open grassland in a land allocation (moving their area to it). */
export function keepChalkOpen(
  land: LandAllocation,
  model: LandModel,
  site: ChalkSite | null,
): void {
  for (const s of site?.parcels ?? []) {
    const use = land.use[s] ?? 0;
    const area = model.area[s] ?? 0;
    land.area[use] = (land.area[use] ?? 0) - area;
    land.area[0] = (land.area[0] ?? 0) + area;
    land.use[s] = 0;
    land.attr[s] = 0;
  }
}

export const countryChalkGlsl = /* glsl */ `
#if COUNTRY_HAS_CHALK
// How much of the ground at p (metres) is cut away to the chalk, 0..1 cut per cell: the ground the
// vantage (the records' eye, wherever the camera is) sees inside the M (chalk.ts's record), near its
// site. foot: metres a cell spans there across the view.
float countryChalk(vec3 p, float foot) {
  vec4 view = terrainRecord(uSim3, TERRAIN_MISC_ROW, ${CHALK.column});
  if (view.z <= 0.0) return 0.0;
  vec4 span = terrainRecord(uSim3, TERRAIN_MISC_ROW, ${CHALK.column + 1});
  vec3 e = p - terrainEye(uSim3);
  float depth = dot(e, countryFwd);
  if (abs(depth - span.x) > span.y) return 0.0;
  vec2 m = (vec2(dot(e, countryRight), e.y) / depth - view.xy) / view.zw;
  if (abs(m.x) > 0.6 || abs(m.y) > 0.6) return 0.0;
  return hardFill(markDistance(m) - 0.085, 0.5 * foot / (depth * view.z));
}

// The chalk under the turf: white, faintly mottled.
vec3 countryChalkWhite(vec2 p) {
  return vec3(0.93, 0.92, 0.86) * (0.94 + 0.06 * vnoise(p / 3.0));
}
#endif
`;
