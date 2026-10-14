// Things lying on the ground in a lattice: fallen leaves, petals, needles, scraps. Square cells over
// the ground plane in two layers, the second shifted half a cell so that a full cover has no gaps;
// the shifted layer lies beneath, the lattice on top (draw layer 1 first, then layer 0 over it).
// Each cell of each layer holds at most one item: its offset in the cell, its heading, its hue, which
// face is up, whether it belongs to a figure laid out on the ground (a mark), and a fade level from 0
// (none) to `levels` (whole) that steps toward a goal, so items fade in and out rather than pop.
//
// A slot is layer * cells + cell, cell = row * cols + col. World x runs along the columns from x0,
// z (depth) along the rows from z0, `cell` metres a side.
//
//   new Litter(lattice, levels)
//   clear()                  empty every slot and lift every protection (the sweep position stays)
//   place(slot, ox, oz, turn, hue, mark, level, goal, rand)
//                            an item: offset (ox - 0.5, oz - 0.5) * 0.7 of a cell, heading turn * 2pi,
//                            hue (a mark's is drawn 0.3..1 instead), face up 82% of the time, fading
//                            from `level` toward `goal`. Draws one number from rand (two for a mark).
//   release(slot)            let the item fade away
//   deposit(x, z, angle, hue, face, rand)
//                            an item that came to rest at (x, z) (m), heading `angle` (rad in the ground
//                            plane): into the lattice cell under it, else the shifted cell under it,
//                            else over the lattice cell's item. Draws one number from rand.
//   take(x, z)               lift the whole item lying on top at (x, z) (the lattice cell's) off the
//                            ground, never a pinned cell's: where it lay, its heading, hue and face, or
//                            undefined. What lies beneath stays.
//   tend(visits, add, remove, wants, rand)
//                            visit the next `visits` cells in turn (unprotected ones only): where
//                            wants(cell, layer) and nothing is there, a new item fades in with chance
//                            `add`; where it does not want one and one lies, it fades out with chance
//                            `remove`. This is how a cover settles toward a density.
//   fade()                   step every fading item one level toward its goal
//   protect[cell]            0 free; PINNED: holds part of a figure (tend skips it, take leaves it,
//                            deposits vanish there); CLEARED: kept bare (tend skips it)
//   layers[0], layers[1]     rgba texels per cell for the two layers: (ox, oz, heading, w), w =
//                            face * (level + 16 * mark + 0.98 * hue), 0 for none; `dirty` is set when
//                            they change (clear it after uploading)
//
// Every random draw comes from the caller's generator, in a fixed order, so a seed keeps its cover.
//
// Usage (the autumn park's carpet):
//   readonly #carpet = new Litter(AUTUMN_CARPET, 8);
//   this.#carpet.deposit(x, z, heading, hue, face, this.#rand);
//   const leaf = this.#carpet.take(swirlX, swirlZ);
//   this.#carpet.tend(visits, 0.06, 0.012, this.#wants, this.#rand);
//   if (this.#carpet.dirty) { upload(this.#carpet.layers[0]); upload(this.#carpet.layers[1]); this.#carpet.dirty = false; }
import { clamp } from "./math.ts";

/** The lattice: cells `cell` metres square from (x0, z0), cols across by rows deep. */
export interface LitterLattice {
  readonly cell: number;
  readonly x0: number;
  readonly z0: number;
  readonly cols: number;
  readonly rows: number;
}

/** An item lifted off the ground: where it lay (m), its heading (rad), hue and face (+1 up, -1 down). */
export interface LitterItem {
  x: number;
  z: number;
  angle: number;
  hue: number;
  face: number;
}

/** protect[cell]: the cell holds part of a figure; the sweep and pickups leave it alone and nothing else lands there. */
export const PINNED = 1;
/** protect[cell]: the cell is kept bare; the sweep leaves it alone (no new items fade in). */
export const CLEARED = 2;

const TAU = Math.PI * 2;

export class Litter {
  readonly lattice: LitterLattice;
  readonly cells: number;
  readonly levels: number;
  readonly ox: Float32Array;
  readonly oz: Float32Array;
  readonly angle: Float32Array;
  readonly hue: Float32Array;
  readonly face: Int8Array;
  readonly mark: Uint8Array;
  readonly level: Uint8Array;
  readonly goal: Uint8Array;
  readonly fading = new Set<number>();
  readonly protect: Uint8Array;
  readonly layers: readonly [Float32Array, Float32Array];
  dirty = true;
  #scan = 0;

  constructor(lattice: LitterLattice, levels: number) {
    this.lattice = lattice;
    this.cells = lattice.cols * lattice.rows;
    this.levels = levels;
    const slots = 2 * this.cells;
    this.ox = new Float32Array(slots);
    this.oz = new Float32Array(slots);
    this.angle = new Float32Array(slots);
    this.hue = new Float32Array(slots);
    this.face = new Int8Array(slots);
    this.mark = new Uint8Array(slots);
    this.level = new Uint8Array(slots);
    this.goal = new Uint8Array(slots);
    this.protect = new Uint8Array(this.cells);
    this.layers = [new Float32Array(this.cells * 4), new Float32Array(this.cells * 4)];
  }

  clear(): void {
    this.level.fill(0);
    this.mark.fill(0);
    this.layers[0].fill(0);
    this.layers[1].fill(0);
    this.goal.fill(0);
    this.fading.clear();
    this.protect.fill(0);
    this.dirty = true;
  }

  place(slot: number, ox: number, oz: number, turn: number, hue: number, mark: boolean, level: number, goal: number, rand: () => number): void {
    this.ox[slot] = (ox - 0.5) * 0.7;
    this.oz[slot] = (oz - 0.5) * 0.7;
    this.angle[slot] = turn * TAU;
    this.hue[slot] = mark ? 0.3 + 0.7 * rand() : hue;
    this.face[slot] = rand() < 0.82 ? 1 : -1;
    this.mark[slot] = mark ? 1 : 0;
    this.level[slot] = level;
    this.goal[slot] = goal;
    if (level !== goal) this.fading.add(slot);
    else this.fading.delete(slot);
    this.#sync(slot);
  }

  release(slot: number): void {
    this.goal[slot] = 0;
    this.fading.add(slot);
  }

  deposit(x: number, z: number, angle: number, hue: number, face: number, rand: () => number): void {
    const { cell: size, x0, z0, cols, rows } = this.lattice;
    const gx = (x - x0) / size;
    const gz = (z - z0) / size;
    const i = Math.floor(gx);
    const j = Math.floor(gz);
    if (i < 0 || j < 0 || i >= cols || j >= rows) return;
    const cell = j * cols + i;
    if (this.protect[cell] === PINNED) return;
    let layer = 0;
    let ci = i;
    let cj = j;
    if ((this.goal[cell] ?? 0) > 0) {
      // Taken: the shifted cell under it, or else over what lies there.
      const bi = Math.floor(gx - 0.5);
      const bj = Math.floor(gz - 0.5);
      if (bi >= 0 && bj >= 0 && bi < cols && bj < rows && (this.goal[this.cells + bj * cols + bi] ?? 0) === 0) {
        layer = 1;
        ci = bi;
        cj = bj;
      }
    }
    const slot = layer * this.cells + cj * cols + ci;
    const centreX = ci + 0.5 + 0.5 * layer;
    const centreZ = cj + 0.5 + 0.5 * layer;
    this.place(slot, 0, 0, 0, hue, false, this.levels, this.levels, rand);
    this.ox[slot] = clamp(gx - centreX, -0.5, 0.5);
    this.oz[slot] = clamp(gz - centreZ, -0.5, 0.5);
    this.angle[slot] = angle;
    this.hue[slot] = hue;
    this.face[slot] = face;
    this.#sync(slot);
  }

  take(x: number, z: number): LitterItem | undefined {
    const { cell: size, x0, z0, cols, rows } = this.lattice;
    const i = Math.floor((x - x0) / size);
    const j = Math.floor((z - z0) / size);
    if (i < 0 || j < 0 || i >= cols || j >= rows) return undefined;
    const cell = j * cols + i;
    if (this.protect[cell] === PINNED || (this.level[cell] ?? 0) < this.levels || (this.goal[cell] ?? 0) === 0) return undefined;
    const item = {
      x: x0 + (i + 0.5 + (this.ox[cell] ?? 0)) * size,
      z: z0 + (j + 0.5 + (this.oz[cell] ?? 0)) * size,
      angle: this.angle[cell] ?? 0,
      hue: this.hue[cell] ?? 0,
      face: this.face[cell] ?? 0,
    };
    this.goal[cell] = 0;
    this.level[cell] = 0;
    this.fading.delete(cell);
    this.#sync(cell);
    return item;
  }

  tend(visits: number, add: number, remove: number, wants: (cell: number, layer: number) => boolean, rand: () => number): void {
    for (let n = 0; n < visits; n++) {
      const cell = this.#scan;
      this.#scan = (this.#scan + 1) % this.cells;
      if (this.protect[cell] !== 0) continue;
      for (let layer = 0; layer < 2; layer++) {
        const slot = layer * this.cells + cell;
        const has = (this.goal[slot] ?? 0) > 0;
        const want = wants(cell, layer);
        if (want && !has) {
          if (rand() < add) this.place(slot, rand(), rand(), rand(), rand(), false, 0, this.levels, rand);
        } else if (!want && has && rand() < remove) {
          this.release(slot);
        }
      }
    }
  }

  fade(): void {
    for (const slot of this.fading) {
      const level = this.level[slot] ?? 0;
      const goal = this.goal[slot] ?? 0;
      const next = level < goal ? level + 1 : level - 1;
      this.level[slot] = next;
      if (next === goal) this.fading.delete(slot);
      this.#sync(slot);
    }
  }

  #sync(slot: number): void {
    const layer = slot >= this.cells ? 1 : 0;
    const data = this.layers[layer];
    const level = this.level[slot] ?? 0;
    const o = (slot - layer * this.cells) * 4;
    data[o] = this.ox[slot] ?? 0;
    data[o + 1] = this.oz[slot] ?? 0;
    data[o + 2] = this.angle[slot] ?? 0;
    data[o + 3] = level === 0 ? 0 : (this.face[slot] ?? 0) * (level + 16 * (this.mark[slot] ?? 0) + 0.98 * (this.hue[slot] ?? 0));
    this.dirty = true;
  }
}
