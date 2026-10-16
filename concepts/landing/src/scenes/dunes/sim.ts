// Sand for the dunes scene: Werner's slab model of wind-blown sand (B. T. Werner, "Eolian dunes:
// computer simulations and attractor interpretation", Geology 23(12), 1995) on a toroidal grid.
//
// Sand lies in slabs on a flat bed that does not erode. Each update picks a random cell; if it has
// sand and is not sheltered, one slab is lifted and carried HOP cells downwind, where it lands with
// probability P_SAND on sand or P_BARE on bare bed, and always in a shadow zone (the lee of any top
// upwind, below a 15° line); otherwise it hops on. Avalanches hold every slope at the angle of
// repose. How much sand there is picks the regime Werner mapped: sparse sand gathers into crescent
// barchans, more into barchanoid ridges, plenty into transverse dunes. A fresh field is laid out as
// those dunes already (DuneLayout), so they stand from the first frame on any machine; a short
// warm-up then lets the model sharpen them into its own.
//
// Grid space, shared with the shader: x runs downwind (for a positive wind knob), z across it, y up,
// all in cells. Uploads, both repeating so the shader can tile the sand sea: uSim0 r16f heights
// (cells above the bed, smoothed); uSim1 rgba16f slope dh/dx, dh/dz, curvature (negative on crests)
// and how far a cell sits below its surroundings (for ambient occlusion).
import { markDistance } from "../../mark.ts";
import { KnobReader, type ParamDef } from "../../params.ts";
import { runBudgeted } from "../../sims/clock.ts";
import { marchHeight, sampleRepeat, type HeightMarch, type RayHit } from "../../sims/heightray.ts";
import { smoothstep } from "../../sims/math.ts";
import { DataTexture } from "../../sims/texture.ts";
import type { SceneSim, SimFactory, SimFrame } from "../types.ts";

/** Grid side in cells: a power of two, so wrapping around the torus is a bit mask. */
export const DUNES_GRID = 256;
const SHIFT = 8;
const MASK = DUNES_GRID - 1;
const CELLS = DUNES_GRID * DUNES_GRID;
/** A random cell index from a 32-bit draw: its top 2 * SHIFT bits. */
const CELL_BITS = 32 - 2 * SHIFT;

/**
 * Slab thickness in cell widths. At a third of a cell the 34° angle of repose is a step of two
 * slabs between neighbours and the 15° shadow line falls 0.8 slab per cell, so both rules work on
 * whole slabs.
 */
export const DUNES_SLAB = 1 / 3;
/** Shadow lines are kept in thousandths of a slab, so they fall by a whole number per cell. */
const MILLI = 1000;
const SHADOW_FALL = Math.round((Math.tan((15 * Math.PI) / 180) / DUNES_SLAB) * MILLI);
/** Cells a lifted slab travels per hop (Werner's L): sets the dune spacing, some 50-70 cells. */
const HOP = 3;
/** Landing chances per hop, scaled to 16 bits: on sand, and on the bare bed. */
const P_SAND = Math.round(0.6 * 65536);
const P_BARE = Math.round(0.4 * 65536);
/** At 40% a slab lands within 32 hops all but once in ten million lifts; then it lands anyway. */
const MAX_HOPS = 32;

// The eight neighbours and the largest stable step to each, in slabs: 2 across a side (33.7°),
// 3 across a corner (35.3°), so heaps come out round rather than diamond-shaped.
const NX = Int8Array.of(1, -1, 0, 0, 1, 1, -1, -1);
const NY = Int8Array.of(0, 0, 1, -1, 1, -1, 1, -1);
const REPOSE = Int8Array.of(2, 2, 2, 2, 3, 3, 3, 3);

/**
 * Mean sand per cell in slabs at the two ends of the supply knob; in between it grows with the
 * square of the knob, so the barchan end gets most of the travel.
 */
export const DUNES_SAND = { sparse: 1.2, plenty: 13 } as const;

/**
 * Updates of warm-up after laying out a field, run as WARM_STEPS steps of WARM_CHUNK updates (1.5
 * million in all): the laid-out dunes are already in place, so this only lets the model sharpen
 * their brinks and trim them into its own shapes (the upload morphs from the layout to the model's
 * field meanwhile). A step count, never a duration: the field after the warm-up is the same on every
 * machine, a slow one only takes more frames to get there.
 */
const WARM_CHUNK = 20_000;
const WARM_STEPS = 75;
/**
 * Milliseconds of warm-up per frame at least: done in a handful of frames (some ten on a fast
 * machine). Where frames come slowly (a software renderer) the frame's budget, a share of the time
 * between them, raises it: it costs such a frame little and still ends within a few.
 */
const WARM_SLICE_MS = 18;
/** Updates per second at full wind with motion on (flux grows faster than the wind does). */
const PICKS_PER_SECOND = 500_000;
/** Most updates spent in one frame however long it was, so a stalled tab does not lock up. */
const MAX_FRAME_PICKS = 60_000;
/** Seconds between uploads while the sand moves (it creeps; no need to re-upload every frame). */
const UPLOAD_EVERY = 1 / 24;
/** Slabs dropped at a press, and per second while held. */
const HEAP_SLABS = 450;
const POUR_PER_SECOND = 900;
/** Wall-clock milliseconds the supply and arrangement knobs must rest before the field is laid out anew. */
const RELAYOUT_MS = 250;

/**
 * The aerial camera in grid space: where it stands, its eye `height` plus `rise` times the mean
 * sand depth above the bed (more sand, taller dunes), viewRay's horizon and fov, and `turn`, how
 * far grid xz is turned from view xz (grid.xz = rotate(view.xz, turn)), so the wind blows left to
 * right and toward the viewer and the ridges run slantwise across the view, one behind the other
 * to the horizon. `look` turns the sky the same way (sky.xz = rotate(view.xz, look)): the camera
 * faces 29° left of the sky library's "ahead", so the setting sun stands in the picture and its
 * light rakes across the dunes rather than straight into the lens. `parallax` is how far (radians)
 * the view turns toward the pointer's side at full parallax (view.xz turned by -uPointer.x times it).
 */
export const DUNES_CAMERA = {
  x: 186,
  z: 88,
  height: 14,
  rise: 1.6,
  horizon: 0.66,
  fov: 0.8,
  turn: 0.7,
  look: 0.5,
  parallax: 0.035,
} as const;
/**
 * How the shader ray-marches the sand, and the pointer's ray with it (sims/heightray.ts): no sand
 * stands above `top` cells, rays give up `far` cells out (the dust has the horizon by then), no
 * sand is steeper than about `slope`, and the shortest step is 1% of the distance, so the far field
 * is reached within `steps`; then `refine` bisections.
 */
export const DUNES_MARCH: HeightMarch = {
  top: 16,
  far: 900,
  slope: 0.75,
  minStep: 0.02,
  relStep: 0.01,
  steps: 48,
  refine: 5,
};
/** The overhead view: cells per screen height, centred on the M, wind left to right. */
export const DUNES_MAP = { span: 150 } as const;

// The M stands this far ahead of the aerial camera and to the right, in cells.
const MARK_AHEAD = 70;
const MARK_RIGHT = 8;
/**
 * The Manifold M in grid space: where its foot stands, its yaw (its face turned a little off the
 * camera so its thickness shows, and slanting across the wind), its height in cells at the ends
 * of the size knob, and in mark units (markDistance) the stroke half width, the slab half depth
 * and how much of the stroke blown sand has scoured away at the foot of the legs.
 */
export const DUNES_MARK = {
  x:
    DUNES_CAMERA.x +
    MARK_RIGHT * Math.cos(DUNES_CAMERA.turn) -
    MARK_AHEAD * Math.sin(DUNES_CAMERA.turn),
  z:
    DUNES_CAMERA.z +
    MARK_RIGHT * Math.sin(DUNES_CAMERA.turn) +
    MARK_AHEAD * Math.cos(DUNES_CAMERA.turn),
  yaw: DUNES_CAMERA.turn - 0.3,
  small: 8,
  large: 15,
  stroke: 0.12,
  depth: 0.1,
  scour: 0.3,
} as const;

/** Mean sand in slabs for a supply knob 0..1 (the shader works the same out from DUNES_SAND). */
function dunesMeanSlabs(sand: number): number {
  const s = Math.min(1, Math.max(0, sand));
  return DUNES_SAND.sparse + (DUNES_SAND.plenty - DUNES_SAND.sparse) * s * s;
}

/**
 * Stand the M in the grid: for each cell under one of its legs, the height of the stone above it in
 * slabs. Sand cannot enter those cells, piles against their upwind faces and gathers in their lee;
 * it blows freely under the arch between the legs.
 */
function stampMark(top: Int16Array, size: number): void {
  const height =
    DUNES_MARK.small + (DUNES_MARK.large - DUNES_MARK.small) * Math.min(1, Math.max(0, size));
  const c = Math.cos(DUNES_MARK.yaw);
  const s = Math.sin(DUNES_MARK.yaw);
  const cx = Math.round(DUNES_MARK.x);
  const cz = Math.round(DUNES_MARK.z);
  const reach = Math.ceil(height * 0.6);
  for (let gz = cz - reach; gz <= cz + reach; gz++) {
    for (let gx = cx - reach; gx <= cx + reach; gx++) {
      const dx = gx + 0.5 - DUNES_MARK.x;
      const dz = gz + 0.5 - DUNES_MARK.z;
      // Into the M's own frame, as the shader does it: rotate(p.xz - at, -yaw).
      const u = (c * dx + s * dz) / height;
      const w = (-s * dx + c * dz) / height;
      // At the foot the legs are scoured thin; up top the stroke is whole.
      const foot = DUNES_MARK.stroke * (1 - DUNES_MARK.scour);
      if (Math.abs(w) > DUNES_MARK.depth || markDistance(u, -0.45) > foot) continue;
      let y = 0.5 + DUNES_MARK.stroke;
      while (y > -0.5 && markDistance(u, y) > DUNES_MARK.stroke) y -= 0.01;
      top[((gz & MASK) << SHIFT) | (gx & MASK)] = Math.max(
        1,
        Math.round(((y + 0.5) * height) / DUNES_SLAB),
      );
    }
  }
}

/** Smooth value noise that wraps around the grid: `cellsX` by `cellsY` lattice cells across it. */
function periodicNoise(x: number, y: number, cellsX: number, cellsY: number, seed: number): number {
  const fx = (x / DUNES_GRID) * cellsX;
  const fy = (y / DUNES_GRID) * cellsY;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const tx = fx - ix;
  const ty = fy - iy;
  const ux = tx * tx * (3 - 2 * tx);
  const uy = ty * ty * (3 - 2 * ty);
  const x0 = ix % cellsX;
  const x1 = (ix + 1) % cellsX;
  const y0 = iy % cellsY;
  const y1 = (iy + 1) % cellsY;
  const a = latticeValue(x0, y0, seed);
  const b = latticeValue(x1, y0, seed);
  const d = latticeValue(x0, y1, seed);
  const e = latticeValue(x1, y1, seed);
  return a + (b - a) * ux + (d - a) * uy + (a - b - d + e) * ux * uy;
}

function latticeValue(i: number, j: number, seed: number): number {
  let h = Math.imul(i, 374761393) ^ Math.imul(j, 668265263) ^ Math.imul(seed + 1, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * Downwind slopes of the dunes a field is laid out with, in cells per cell: slip faces just under
 * the angle of repose, stoss slopes at the 19° the model's windward slopes settle at.
 */
const LAY_LEE = 0.62;
const LAY_STOSS = 0.34;
/** The tallest crest a layout may need, in cells; the shader's DUNES_TOP leaves room above it. */
const LAY_TALLEST = 12;

/**
 * The dunes a field is laid out as, so the very first frame shows them and the model only has to
 * refine them: rows of crests square to the wind, about as far apart as the model sets them, each a
 * stoss slope rising to a brink and a slip face falling from it. A crest's height wanders along it,
 * and where it sinks the crest swings downwind, so a lone hump is a crescent with its horns trailing
 * downwind. Sparse sand cuts the crests into lone barchans, more links them into wavy barchanoid
 * ridges, and plenty keeps them whole as long transverse dunes; the rows meander together.
 */
class DuneLayout {
  readonly #ridges: number;
  /** Per ridge and grid row (ridge * DUNES_GRID + row): where its brink stands downwind, in cells. */
  readonly #at: Float32Array;
  /** Per ridge and grid row: its crest height, 0..1 of the tallest. */
  readonly #rise: Float32Array;

  constructor(sand: number, arrangement: number) {
    // 1 once the crests run on unbroken as transverse ridges.
    const whole = smoothstep(0.5, 1, sand);
    const ridges = Math.round(5 + 4 * smoothstep(0, 0.45, sand) - 2 * whole);
    const spacing = DUNES_GRID / ridges;
    // Lattice cells of height noise along a crest: about one crescent to each.
    const humps = Math.round(8 - 3 * smoothstep(0, 0.6, sand));
    // Noise below `cut` leaves bare bed between crescents; `floor` keeps transverse crests whole.
    const cut = 0.6 * (1 - smoothstep(0, 0.8, sand));
    const floor = 0.35 * whole;
    // How far the horns trail downwind of the crescent's nose, in cells.
    const swing = 22 - 14 * sand;
    this.#ridges = ridges;
    this.#at = new Float32Array(ridges * DUNES_GRID);
    this.#rise = new Float32Array(ridges * DUNES_GRID);
    for (let k = 0; k < ridges; k++) {
      const lane = k * spacing;
      const base = lane + (0.5 + 0.4 * (latticeValue(k, 1, arrangement + 17) - 0.5)) * spacing;
      for (let z = 0; z < DUNES_GRID; z++) {
        const e = periodicNoise(lane, z, ridges, humps, arrangement + 5);
        const f = Math.max(0, (e - cut) / (1 - cut));
        // Broad meanders shared with the neighbouring rows, and a finer wander of each crest's own.
        const meander =
          0.7 * (periodicNoise(base, z, 2, 3, arrangement + 3) - 0.5) +
          0.6 * (periodicNoise(lane, z, ridges, 7, arrangement + 9) - 0.5);
        this.#at[k * DUNES_GRID + z] = base + meander * spacing + swing * (1 - f);
        this.#rise[k * DUNES_GRID + z] = floor + (1 - floor) * f ** 0.6;
      }
    }
  }

  /**
   * Heights in cells into `out` for crests `tall` cells high, slip faces toward `dir` (+1 downwind
   * is +x); returns the total. Each cell takes the highest of the crest profiles over it.
   */
  fill(out: Float32Array, tall: number, dir: number): number {
    const at = this.#at;
    const rise = this.#rise;
    let total = 0;
    for (let z = 0; z < DUNES_GRID; z++) {
      const row = z << SHIFT;
      for (let u = 0; u < DUNES_GRID; u++) {
        let h = 0;
        for (let k = 0; k < this.#ridges; k++) {
          const j = k * DUNES_GRID + z;
          let d = u - (at[j] ?? 0);
          d -= DUNES_GRID * Math.round(d / DUNES_GRID);
          const top = tall * (rise[j] ?? 0);
          h = Math.max(h, d >= 0 ? top - d * LAY_LEE : top + d * LAY_STOSS);
        }
        out[row | (dir > 0 ? u : MASK - u)] = h;
        total += h;
      }
    }
    return total;
  }
}

/** The slab model itself, free of GL. */
class DuneField {
  /** Sand per cell in slabs, rows bottom to top (row = grid z). */
  readonly height = new Int16Array(CELLS);
  /** Stone standing in a cell (the M's legs), its top in slabs; 0 where there is none. */
  readonly stone = new Int16Array(CELLS);
  /**
   * Per cell, the highest 15° line falling downwind from any top upwind, in thousandths of a slab:
   * a cell lower than it lies in a shadow zone. Kept up to date along the row as heights change
   * (line(x + 1) = max(line(x), top(x)) - fall), which is much cheaper than scanning upwind on
   * every lift and landing.
   */
  readonly #shadow = new Int32Array(CELLS);
  /** xorshift32 state. */
  #rng = 1;
  /** +1 when the wind blows toward +x, -1 toward -x. */
  #dir = 1;
  /** Bumped whenever the sand changes, so uploads can be skipped while it rests. */
  version = 0;

  /** Blow toward +x (positive) or -x (negative). */
  setWind(wind: number): void {
    const dir = wind < 0 ? -1 : 1;
    if (dir === this.#dir) return;
    this.#dir = dir;
    this.#castShadows();
  }

  /** Stand the M in the field at a size knob 0..1, or clear it (undefined). */
  setStone(size: number | undefined): void {
    this.stone.fill(0);
    if (size !== undefined) stampMark(this.stone, size);
    this.#castShadows();
    this.version++;
  }

  /**
   * Lay out a fresh field for a supply knob 0..1 and an arrangement number: the dunes the model
   * would make of that much sand (DuneLayout), slip faces downwind, holding exactly the knob's sand;
   * then let it slump to repose.
   */
  reset(sand: number, seed: number): void {
    const s = Math.min(1, Math.max(0, sand));
    const arrangement = Math.round(seed) >>> 0;
    this.#rng = (Math.imul(arrangement + 1, 2654435761) ^ 0x9e3779b9) >>> 0 || 1;
    const layout = new DuneLayout(s, arrangement);
    const raw = new Float32Array(CELLS);
    // The crest height that holds the knob's sand. From a guess near where it lands (the crests
    // are lowest for barchanoid ridges), two corrections come within a percent or so (the volume
    // grows about as its square while dunes stand apart, more nearly in step once they overlap) and
    // a last scale makes it exact.
    const want = dunesMeanSlabs(s) * CELLS * DUNES_SLAB;
    let tall = 7.8 - 4 * s + 7 * s * s;
    for (let k = 0; k < 2; k++) {
      const held = layout.fill(raw, tall, this.#dir);
      if (held <= 0) break;
      tall = Math.min(LAY_TALLEST, tall * (want / held) ** 0.6);
    }
    const total = layout.fill(raw, tall, this.#dir);
    const scale = total > 0 ? want / total / DUNES_SLAB : 0;
    // Round with the error carried along, so the field holds the intended sand to the slab.
    let carry = 0;
    for (let i = 0; i < CELLS; i++) {
      const v = (raw[i] ?? 0) * scale + carry;
      const slabs = Math.max(0, Math.round(v));
      carry = v - slabs;
      this.height[i] = (this.stone[i] ?? 0) > 0 ? 0 : slabs;
    }
    this.#castShadows();
    for (let sweep = 0; sweep < 24; sweep++) {
      let moved = false;
      for (let i = 0; i < CELLS; i++) {
        if ((this.stone[i] ?? 0) > 0) continue;
        while (this.#slide(i & MASK, i >>> SHIFT)) moved = true;
      }
      if (!moved) break;
    }
    this.version++;
  }

  /** Run `picks` updates of the model. */
  step(picks: number): void {
    const h = this.height;
    const stone = this.stone;
    const shadow = this.#shadow;
    const dir = this.#dir;
    for (let k = 0; k < picks; k++) {
      const i = this.#next() >>> CELL_BITS;
      const hi = h[i] ?? 0;
      if (hi <= 0 || (stone[i] ?? 0) > 0 || (shadow[i] ?? 0) > hi * MILLI) continue;
      const x = i & MASK;
      const y = i >>> SHIFT;
      this.#set(x, y, hi - 1);
      this.#fill(x, y);
      const row = y << SHIFT;
      let at = x;
      for (let hop = 0; hop < MAX_HOPS; hop++) {
        // Saltating grains stop at stone: the slab lands against its upwind face.
        let blocked = false;
        for (let cell = 0; cell < HOP; cell++) {
          const next = (at + dir) & MASK;
          if ((stone[row | next] ?? 0) > 0) {
            blocked = true;
            break;
          }
          at = next;
        }
        if (blocked) break;
        const ha = h[row | at] ?? 0;
        if ((shadow[row | at] ?? 0) > ha * MILLI) break;
        if ((this.#next() & 0xffff) < (ha > 0 ? P_SAND : P_BARE)) break;
      }
      this.#set(at, y, (h[row | at] ?? 0) + 1);
      while (this.#slide(at, y));
    }
    if (picks > 0) this.version++;
  }

  /**
   * Pour `slabs` onto one cell: each slides down the growing cone until it rests, which builds a
   * heap at the angle of repose. The same amount is taken back from the field at large, so the
   * sand supply stays as the knob set it.
   */
  pour(x: number, y: number, slabs: number): void {
    const cx = Math.floor(x) & MASK;
    const cy = Math.floor(y) & MASK;
    const i = (cy << SHIFT) | cx;
    if ((this.stone[i] ?? 0) > 0) return;
    const h = this.height;
    for (let k = 0; k < slabs; k++) {
      this.#set(cx, cy, (h[i] ?? 0) + 1);
      while (this.#slide(cx, cy));
    }
    // Deflation elsewhere: lift slabs from random sandy cells well away from the heap.
    let taken = 0;
    for (let tries = 0; tries < slabs * 64 && taken < slabs; tries++) {
      const j = this.#next() >>> CELL_BITS;
      const jx = j & MASK;
      const jy = j >>> SHIFT;
      const ddx = Math.min((jx - cx) & MASK, (cx - jx) & MASK);
      const ddy = Math.min((jy - cy) & MASK, (cy - jy) & MASK);
      if (ddx * ddx + ddy * ddy < 32 * 32 || (h[j] ?? 0) <= 0 || (this.stone[j] ?? 0) > 0) continue;
      this.#set(jx, jy, (h[j] ?? 0) - 1);
      this.#fill(jx, jy);
      taken++;
    }
    this.version++;
  }

  /** Set a cell's sand and carry the change along its shadow line downwind. */
  #set(x: number, y: number, slabs: number): void {
    const row = y << SHIFT;
    const h = this.height;
    const shadow = this.#shadow;
    const dir = this.#dir;
    h[row | x] = slabs;
    let at = x;
    for (let k = 0; k < DUNES_GRID; k++) {
      const top = Math.max(h[row | at] ?? 0, this.stone[row | at] ?? 0) * MILLI;
      const line = Math.max(shadow[row | at] ?? 0, top) - SHADOW_FALL;
      at = (at + dir) & MASK;
      if (shadow[row | at] === line) return;
      shadow[row | at] = line;
    }
  }

  /** Every shadow line from scratch: twice round each row, so each line has wrapped the torus. */
  #castShadows(): void {
    const h = this.height;
    const stone = this.stone;
    const shadow = this.#shadow;
    const dir = this.#dir;
    for (let y = 0; y < DUNES_GRID; y++) {
      const row = y << SHIFT;
      let line = -SHADOW_FALL;
      let x = 0;
      for (let k = 0; k < 2 * DUNES_GRID; k++) {
        shadow[row | x] = line;
        line = Math.max(line, Math.max(h[row | x] ?? 0, stone[row | x] ?? 0) * MILLI) - SHADOW_FALL;
        x = (x + dir) & MASK;
      }
    }
  }

  /**
   * Avalanche from (x, y): if it stands too steep above a neighbour, one slab slides to the
   * steepest such neighbour and on down from there until it rests. Ties go to a random neighbour
   * so slopes do not lean along the grid. Returns whether anything moved.
   */
  #slide(x: number, y: number): boolean {
    const h = this.height;
    const stone = this.stone;
    let moved = false;
    for (let guard = 0; guard < DUNES_GRID; guard++) {
      const hi = h[(y << SHIFT) | x] ?? 0;
      const start = this.#next() & 7;
      let best = -1;
      let bestExcess = 0;
      for (let k = 0; k < 8; k++) {
        const n = (start + k) & 7;
        const j = (((y + (NY[n] ?? 0)) & MASK) << SHIFT) | ((x + (NX[n] ?? 0)) & MASK);
        if ((stone[j] ?? 0) > 0) continue;
        const excess = hi - (h[j] ?? 0) - (REPOSE[n] ?? 0);
        if (excess > bestExcess) {
          bestExcess = excess;
          best = n;
        }
      }
      if (best < 0) return moved;
      this.#set(x, y, hi - 1);
      x = (x + (NX[best] ?? 0)) & MASK;
      y = (y + (NY[best] ?? 0)) & MASK;
      this.#set(x, y, (h[(y << SHIFT) | x] ?? 0) + 1);
      moved = true;
    }
    return moved;
  }

  /**
   * The hole a lifted slab leaves: while a neighbour stands too steep above it, a slab slides in
   * from the steepest one, and the hole moves up there.
   */
  #fill(x: number, y: number): void {
    const h = this.height;
    const stone = this.stone;
    for (let guard = 0; guard < DUNES_GRID; guard++) {
      const hi = h[(y << SHIFT) | x] ?? 0;
      const start = this.#next() & 7;
      let best = -1;
      let bestExcess = 0;
      for (let k = 0; k < 8; k++) {
        const n = (start + k) & 7;
        const j = (((y + (NY[n] ?? 0)) & MASK) << SHIFT) | ((x + (NX[n] ?? 0)) & MASK);
        if ((stone[j] ?? 0) > 0) continue;
        const excess = (h[j] ?? 0) - hi - (REPOSE[n] ?? 0);
        if (excess > bestExcess) {
          bestExcess = excess;
          best = n;
        }
      }
      if (best < 0) return;
      this.#set(x, y, hi + 1);
      x = (x + (NX[best] ?? 0)) & MASK;
      y = (y + (NY[best] ?? 0)) & MASK;
      this.#set(x, y, (h[(y << SHIFT) | x] ?? 0) - 1);
    }
  }

  /** xorshift32 (Marsaglia 2003): fast, and the same field for the same arrangement number. */
  #next(): number {
    let r = this.#rng;
    r ^= r << 13;
    r ^= r >>> 17;
    r ^= r << 5;
    this.#rng = r >>> 0;
    return this.#rng;
  }
}

/**
 * The surface the shader draws, from the slabs: blurred so the slab terraces melt into sand,
 * with slopes and curvature taken here once rather than per pixel. Interpolated slopes give smooth
 * normals where differences of interpolated heights would show the grid.
 */
class DuneSurface {
  /** Heights in cells above the bed, rows bottom to top. */
  readonly heights = new Float32Array(CELLS);
  /** rgba per cell: dh/dx, dh/dz, curvature (negative on crests), hollowness (positive in troughs). */
  readonly shape = new Float32Array(CELLS * 4);
  readonly #a = new Float32Array(CELLS);
  readonly #b = new Float32Array(CELLS);

  update(field: DuneField): void {
    const raw = this.#a;
    const tmp = this.#b;
    const out = this.heights;
    const h = field.height;
    const stone = field.stone;
    for (let i = 0; i < CELLS; i++) raw[i] = (h[i] ?? 0) * DUNES_SLAB;
    // Under the M's legs, carry the sand surface across from its sides.
    for (let i = 0; i < CELLS; i++) {
      if ((stone[i] ?? 0) <= 0) continue;
      const x = i & MASK;
      const y = i >>> SHIFT;
      let sum = 0;
      let count = 0;
      for (let n = 0; n < 8; n++) {
        const j = (((y + (NY[n] ?? 0)) & MASK) << SHIFT) | ((x + (NX[n] ?? 0)) & MASK);
        if ((stone[j] ?? 0) > 0) continue;
        sum += (h[j] ?? 0) * DUNES_SLAB;
        count++;
      }
      if (count > 0) raw[i] = sum / count;
    }
    // Binomial 1-4-6-4-1 blur each way (about a one-cell gaussian): melts terraces, keeps brinks.
    blur5Transposed(raw, tmp);
    blur5Transposed(tmp, out);
    // A wide box (radius 8) of the surface, for how deep each cell sits in its surroundings.
    boxTransposed(out, tmp, 8);
    boxTransposed(tmp, raw, 8);
    const shape = this.shape;
    for (let y = 0; y < DUNES_GRID; y++) {
      const row = y << SHIFT;
      const up = ((y + 1) & MASK) << SHIFT;
      const down = ((y - 1) & MASK) << SHIFT;
      const up2 = ((y + 2) & MASK) << SHIFT;
      const down2 = ((y - 2) & MASK) << SHIFT;
      for (let x = 0; x < DUNES_GRID; x++) {
        const c = out[row | x] ?? 0;
        const o = (row | x) * 4;
        shape[o] = ((out[row | ((x + 1) & MASK)] ?? 0) - (out[row | ((x - 1) & MASK)] ?? 0)) * 0.5;
        shape[o + 1] = ((out[up | x] ?? 0) - (out[down | x] ?? 0)) * 0.5;
        // Laplacian over two cells: the brinks and troughs at dune scale, not slab noise.
        shape[o + 2] =
          ((out[row | ((x + 2) & MASK)] ?? 0) +
            (out[row | ((x - 2) & MASK)] ?? 0) +
            (out[up2 | x] ?? 0) +
            (out[down2 | x] ?? 0) -
            4 * c) *
          0.25;
        shape[o + 3] = (raw[row | x] ?? 0) - c;
      }
    }
  }

  /** Morph from an earlier surface: weight 0 shows `from`, 1 leaves this one as it is. */
  easeFrom(from: DuneSurface, weight: number): void {
    const heights = this.heights;
    const shape = this.shape;
    for (let i = 0; i < CELLS; i++) {
      const a = from.heights[i] ?? 0;
      heights[i] = a + ((heights[i] ?? 0) - a) * weight;
    }
    for (let i = 0; i < CELLS * 4; i++) {
      const a = from.shape[i] ?? 0;
      shape[i] = a + ((shape[i] ?? 0) - a) * weight;
    }
  }
}

// The blurs run along rows and write columns, so two passes cover both directions and land the
// result the right way round, without a second, strided loop.

/** One 1-4-6-4-1 pass along x, wrapping, written transposed. */
function blur5Transposed(src: Float32Array, dst: Float32Array): void {
  for (let y = 0; y < DUNES_GRID; y++) {
    const row = y << SHIFT;
    for (let x = 0; x < DUNES_GRID; x++) {
      const sum =
        (src[row | ((x - 2) & MASK)] ?? 0) +
        4 * (src[row | ((x - 1) & MASK)] ?? 0) +
        6 * (src[row | x] ?? 0) +
        4 * (src[row | ((x + 1) & MASK)] ?? 0) +
        (src[row | ((x + 2) & MASK)] ?? 0);
      dst[(x << SHIFT) | y] = sum / 16;
    }
  }
}

/** One box pass of radius r along x as a running sum around the torus, written transposed. */
function boxTransposed(src: Float32Array, dst: Float32Array, r: number): void {
  const width = 2 * r + 1;
  for (let y = 0; y < DUNES_GRID; y++) {
    const row = y << SHIFT;
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += src[row | (k & MASK)] ?? 0;
    for (let x = 0; x < DUNES_GRID; x++) {
      dst[(x << SHIFT) | y] = sum / width;
      sum += (src[row | ((x + r + 1) & MASK)] ?? 0) - (src[row | ((x - r) & MASK)] ?? 0);
    }
  }
}

/** The M's signed distance at (x, y, z) in grid space, for an M `height` cells tall: the shader's dunesMarkSdf. */
function markSdf(x: number, y: number, z: number, height: number): number {
  const qx = x - DUNES_MARK.x;
  const qz = z - DUNES_MARK.z;
  const c = Math.cos(DUNES_MARK.yaw);
  const s = Math.sin(DUNES_MARK.yaw);
  const my = y / height - 0.5;
  const stroke = DUNES_MARK.stroke * (1 - DUNES_MARK.scour * (1 - smoothstep(-0.5, -0.2, my)));
  const wx = (markDistance((c * qx + s * qz) / height, my) - stroke) * height;
  const wy = Math.abs(-s * qx + c * qz) - DUNES_MARK.depth * height;
  return Math.min(Math.max(wx, wy), 0) + Math.hypot(Math.max(wx, 0), Math.max(wy, 0));
}

/** Where the unit ray meets the M before `far`, or -1: the shader's dunesMarkHit, step for step. */
function markHit(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  height: number,
  far: number,
): number {
  const cx = ox - DUNES_MARK.x;
  const cy = oy - 0.5 * height;
  const cz = oz - DUNES_MARK.z;
  const b = cx * dx + cy * dy + cz * dz;
  const disc = b * b - (cx * cx + cy * cy + cz * cz) + 0.81 * height * height;
  if (disc < 0) return -1;
  const root = Math.sqrt(disc);
  let t = Math.max(-b - root, 0);
  const end = Math.min(-b + root, far);
  for (let i = 0; i < 40; i++) {
    if (t > end) return -1;
    const d = markSdf(ox + dx * t, oy + dy * t, oz + dz * t, height);
    if (d < 0.002 * t + 0.01) return t;
    t += d;
  }
  return -1;
}

/** Scratch for dunesPointerCell's march: the pointer's ray meeting the sand. */
const sandHit: RayHit = { t: 0, x: 0, y: 0, z: 0 };

/**
 * The grid point under the pointer, written to `out`; false where there is no sand to pour on.
 * Overhead: a straight map centred on the M. Aerial: the pointer's ray as the shader casts it
 * (viewRay's lens-shifted pinhole, turned by the pointer's parallax and on into grid space), marched
 * with DUNES_MARCH against `ground`, the surface as last uploaded, so the point is the one the
 * picture shows under the pointer: the face of the dune in front, not the mean level behind it.
 * Where the M stands in front of the sand, the point on its face (sand poured there runs down to its
 * foot). Sky, and the far field the march gives up on, give false. `sand` is the supply knob (it
 * sets the eye's height) and `mark` the M's size knob, 0 while off. The shader's heat shimmer, a
 * few rows' waver along the horizon under a high sun, is left out.
 */
export function dunesPointerCell(
  frame: SimFrame,
  view: number,
  sand: number,
  mark: number,
  ground: (x: number, z: number) => number,
  out: { x: number; y: number },
): boolean {
  const { x, y } = frame.pointer;
  if (view >= 0.5) {
    out.x = DUNES_MARK.x + (x - 0.5) * frame.aspect * DUNES_MAP.span;
    out.y = DUNES_MARK.z + (y - 0.5) * DUNES_MAP.span;
    return true;
  }
  const vx = (x - 0.5) * frame.aspect;
  const vy = y - DUNES_CAMERA.horizon;
  const vz = 0.5 / Math.tan(DUNES_CAMERA.fov * 0.5);
  const length = Math.hypot(vx, vy, vz);
  // viewRay, turned by -uPointer.x * parallax and then by turn into grid space: one turn by their sum.
  const yaw = DUNES_CAMERA.turn - (frame.parallax?.x ?? 0) * DUNES_CAMERA.parallax;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const dx = (c * vx - s * vz) / length;
  const dy = vy / length;
  const dz = (s * vx + c * vz) / length;
  const ox = DUNES_CAMERA.x;
  const oy = DUNES_CAMERA.height + DUNES_CAMERA.rise * dunesMeanSlabs(sand) * DUNES_SLAB;
  const oz = DUNES_CAMERA.z;
  const onSand = marchHeight(ground, ox, oy, oz, dx, dy, dz, DUNES_MARCH, sandHit);
  const height = mark > 0 ? DUNES_MARK.small + (DUNES_MARK.large - DUNES_MARK.small) * mark : 0;
  const t =
    height > 0 ? markHit(ox, oy, oz, dx, dy, dz, height, onSand ? sandHit.t : DUNES_MARCH.far) : -1;
  if (t >= 0) {
    out.x = ox + dx * t;
    out.y = oz + dz * t;
    return true;
  }
  if (!onSand) return false;
  out.x = sandHit.x;
  out.y = sandHit.z;
  return true;
}

export function dunesSim(params: readonly ParamDef[]): SimFactory {
  const knobs = new KnobReader("dunes", params, ["sand", "seed", "wind", "mark", "camera"]);
  return (gl: WebGL2RenderingContext): SceneSim => {
    const field = new DuneField();
    const surface = new DuneSurface();
    // The surface as first laid out, which the uploads morph away from while the field warms up.
    const start = new DuneSurface();
    const heights = new DataTexture(gl, {
      width: DUNES_GRID,
      height: DUNES_GRID,
      format: "r16f",
      wrap: "repeat",
    });
    const shape = new DataTexture(gl, {
      width: DUNES_GRID,
      height: DUNES_GRID,
      format: "rgba16f",
      wrap: "repeat",
    });
    const textures: readonly WebGLTexture[] = [heights.texture, shape.texture];
    const cell = { x: 0, y: 0 };
    // The sand as the shader last saw it, for the pointer's ray.
    const ground = (x: number, z: number): number =>
      sampleRepeat(surface.heights, DUNES_GRID, DUNES_GRID, x, z);
    // The knobs the laid-out field was made from, and the pair seen last frame (with when it first showed).
    let laid = false;
    let laidSand = 0;
    let laidArrangement = 0;
    let seenSand = Number.NaN;
    let seenArrangement = Number.NaN;
    let seenSince = 0;
    // The M's size as last stood in the field (0: none; -1: not yet set).
    let stoneSize = -1;
    let warmed = WARM_STEPS;
    let owed = 0;
    let uploaded = -1;
    let lastUpload = -Infinity;

    return {
      frame(frame: SimFrame): readonly (WebGLTexture | undefined)[] {
        const now = frame.now;
        const sand = knobs.value(frame, "sand");
        const arrangement = knobs.value(frame, "seed");
        const wind = knobs.value(frame, "wind");
        field.setWind(wind);

        // The sandstone M's size, 0 while the knob is off.
        const markSize = knobs.value(frame, "mark");
        if (markSize !== stoneSize) {
          field.setStone(markSize > 0 ? markSize : undefined);
          stoneSize = markSize;
        }

        // A new supply or arrangement lays the field out afresh once the knob rests, then warms up.
        const rested = sand === seenSand && arrangement === seenArrangement;
        const changed = sand !== laidSand || arrangement !== laidArrangement;
        const relayout = !laid || (rested && changed && now - seenSince >= RELAYOUT_MS);
        if (!rested) {
          seenSand = sand;
          seenArrangement = arrangement;
          seenSince = now;
        }
        if (relayout) {
          field.reset(sand, arrangement);
          start.update(field);
          laid = true;
          laidSand = sand;
          laidArrangement = arrangement;
          warmed = 0;
        }

        const warming = warmed < WARM_STEPS;
        if (warming) {
          // Time-sliced so frames keep coming; the laid-out dunes sharpen meanwhile. Where frames come
          // slowly (a software renderer) it takes a share of the time between them instead, so it
          // still ends within a few.
          warmed = runBudgeted(
            () => field.step(WARM_CHUNK),
            Math.max(WARM_SLICE_MS, frame.budget),
            WARM_STEPS,
            warmed,
          );
        } else if (frame.dt > 0) {
          // Sand flux rises steeply with wind speed; wind 0 leaves the dunes standing.
          const strength = Math.min(1, Math.abs(wind));
          owed += PICKS_PER_SECOND * strength * Math.sqrt(strength) * frame.dt * frame.motion;
          const picks = Math.min(MAX_FRAME_PICKS, Math.floor(owed));
          owed = Math.min(owed - picks, MAX_FRAME_PICKS);
          if (picks > 0) field.step(picks);
        }

        const pointer = frame.pointer;
        // While the camera glides in or the view settles the pointer's ray is not the rest camera's, so no pouring.
        const resting = frame.passage.enter >= 1 && frame.passage.exit <= 0;
        if (resting && pointer.inside && (pointer.pressed || pointer.down)) {
          const slabs = pointer.pressed ? HEAP_SLABS : Math.round(POUR_PER_SECOND * frame.dt);
          if (
            slabs > 0 &&
            dunesPointerCell(frame, knobs.value(frame, "camera"), sand, markSize, ground, cell)
          )
            field.pour(cell.x, cell.y, slabs);
        }

        // While the sand creeps an upload every UPLOAD_EVERY is plenty; the finished warm-up shows at once.
        const due =
          uploaded < 0 ||
          (warming && warmed === WARM_STEPS) ||
          now - lastUpload >= UPLOAD_EVERY * 1000;
        if (field.version !== uploaded && due) {
          surface.update(field);
          if (warmed < WARM_STEPS) {
            surface.easeFrom(start, smoothstep(0, 1, warmed / WARM_STEPS));
          }
          heights.upload(surface.heights);
          shape.upload(surface.shape);
          uploaded = field.version;
          lastUpload = now;
        }
        return textures;
      },
      dispose(): void {
        heights.dispose();
        shape.dispose();
      },
    };
  };
}
