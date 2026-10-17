// Lists of what reaches into each square bin of a grid laid over the frame, so a shader walks the
// short list in its own cell's bin instead of every item (dew's threads, stems and drops). Each
// list holds as many entries as its bin needs: the texture has as many pages of BIN_PAGE slots as
// the fullest bin fills, up to the constructor's `maxPages`, so a dense patch (a web's hub, where
// every radius meets the inner spiral) never loses an entry to a full list. A sparse frame keeps
// one page, BIN_PAGE slots a bin.
//
//   const lists = new BinLists(4);                 // at most 4 pages: 4 × BIN_PAGE entries a bin
//   lists.fit(rows, cols);                          // bins 1/rows of the frame height square, cols across
//   lists.clear();                                  // every frame, before adding
//   lists.add(id, ax, ay, bx, by, margin);          // id in every bin segment a–b comes within margin of
//   lists.add(id, x, y, x, y, radius);              // a point (a disc)
//   texture.resize(lists.width, lists.height);      // r16f, nearest
//   texture.upload(lists.data);
//   // tell the shader lists.pages (dew: a header texel), then in GLSL, with binListsGlsl included:
//   //   ivec3 bin = binListsAt(uSim1, pages, p);
//   //   for (int k = 0; k < BIN_PAGE * pages; k++) {
//   //     float id = binListsEntry(uSim1, bin, k);
//   //     if (id == 0.0) break;
//   //     ...
//   //   }
//
// Layout: bin (i, j), i across from the left and j up from the bottom, lists its entries in the
// order they were added at texels (j × BIN_PAGE + k % BIN_PAGE, i + floor(k / BIN_PAGE) × cols);
// 0 ends a list. The texture is rows × BIN_PAGE wide (2048 at 64 rows, WebGL2's smallest maximum)
// and cols × pages tall. Positions are the caller's units with one bin 1/rows across (dew: frame
// heights from the bottom-left corner). Ids are nonzero whole numbers a half float holds exactly
// (|id| ≤ 2048); the caller encodes kinds by range or sign. A bin is listed when its centre lies
// within half its diagonal plus `margin` of the segment, so margin is how far what the shader draws
// for the entry reaches beyond the segment itself. Entries a bin cannot take even at maxPages are
// counted in `dropped` (that frame's), never written.
import { segmentDistance } from "../mark.ts";

/** Entries a page holds per bin. */
export const BIN_PAGE = 32;

export class BinListsError extends Error {}

export class BinLists {
  readonly maxPages: number;
  #rows = 0;
  #cols = 0;
  #size = 1;
  #reach = Math.SQRT1_2;
  /** maxPages pages, page after page, each rows × BIN_PAGE × cols. */
  #store = new Float32Array(0);
  /** The first 1, 2, ... maxPages pages of #store: what a frame of that many pages uploads. */
  #views: Float32Array[] = [];
  #count = new Uint16Array(0);
  #fullest = 0;
  /** Pages written since the last clear (and so to be zeroed by the next). */
  #written = 0;
  #dropped = 0;

  constructor(maxPages: number) {
    if (!Number.isInteger(maxPages) || maxPages < 1)
      throw new BinListsError(`bins: maxPages must be a whole number ≥ 1, got ${maxPages}`);
    this.maxPages = maxPages;
  }

  /** Bins down the frame; one bin is 1/rows across. */
  get rows(): number {
    return this.#rows;
  }

  get cols(): number {
    return this.#cols;
  }

  /** Pages the fullest bin needs (1 while every list fits BIN_PAGE), at most maxPages. */
  get pages(): number {
    return Math.min(this.maxPages, Math.max(1, Math.ceil(this.#fullest / BIN_PAGE)));
  }

  /** Entries left out since the last clear: bins fuller than maxPages × BIN_PAGE. */
  get dropped(): number {
    return this.#dropped;
  }

  /** The texture's size for `data`: rows × BIN_PAGE by cols × pages texels. */
  get width(): number {
    return this.#rows * BIN_PAGE;
  }

  get height(): number {
    return this.#cols * this.pages;
  }

  /** The lists, `pages` pages of them, r16f texels (rows bottom to top). Read after the adds. */
  get data(): Float32Array {
    const view = this.#views[this.pages - 1];
    if (!view) throw new BinListsError("bins: fit the grid before reading its lists");
    return view;
  }

  /** Size the grid: rows bins down the frame, cols across. Returns whether it changed (and emptied). */
  fit(rows: number, cols: number): boolean {
    if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 1 || cols < 1)
      throw new BinListsError(`bins: a ${rows} × ${cols} grid`);
    if (rows === this.#rows && cols === this.#cols) return false;
    this.#rows = rows;
    this.#cols = cols;
    this.#size = 1 / rows;
    this.#reach = this.#size * Math.SQRT1_2;
    const page = rows * BIN_PAGE * cols;
    this.#store = new Float32Array(page * this.maxPages);
    this.#views = Array.from({ length: this.maxPages }, (_, p) =>
      this.#store.subarray(0, page * (p + 1)),
    );
    this.#count = new Uint16Array(rows * cols);
    this.#fullest = 0;
    this.#written = 0;
    this.#dropped = 0;
    return true;
  }

  /** Empty every list. */
  clear(): void {
    this.#store.fill(0, 0, this.#written * this.#rows * BIN_PAGE * this.#cols);
    this.#count.fill(0);
    this.#fullest = 0;
    this.#written = 0;
    this.#dropped = 0;
  }

  /** List id in every bin the segment a–b (a point when a = b) comes within margin of. */
  add(id: number, ax: number, ay: number, bx: number, by: number, margin: number): void {
    const rows = this.#rows;
    const cols = this.#cols;
    const size = this.#size;
    const store = this.#store;
    const count = this.#count;
    const capacity = BIN_PAGE * this.maxPages;
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - margin) / size));
    const i1 = Math.min(cols - 1, Math.floor((Math.max(ax, bx) + margin) / size));
    const j0 = Math.max(0, Math.floor((Math.min(ay, by) - margin) / size));
    const j1 = Math.min(rows - 1, Math.floor((Math.max(ay, by) + margin) / size));
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        if (
          segmentDistance((i + 0.5) * size, (j + 0.5) * size, ax, ay, bx, by) >
          this.#reach + margin
        )
          continue;
        const bin = i * rows + j;
        const k = count[bin] ?? 0;
        if (k >= capacity) {
          this.#dropped++;
          continue;
        }
        const page = Math.floor(k / BIN_PAGE);
        store[(i + page * cols) * rows * BIN_PAGE + j * BIN_PAGE + (k % BIN_PAGE)] = id;
        count[bin] = k + 1;
        if (k + 1 > this.#fullest) this.#fullest = k + 1;
        if (page + 1 > this.#written) this.#written = page + 1;
      }
    }
  }
}

/**
 * GLSL reading a BinLists texture: `ivec3 binListsAt(sampler2D lists, int pages, vec2 p)`, the bin
 * under p (the units the sim binned in) as (column, row, columns), and `float binListsEntry(sampler2D
 * lists, ivec3 bin, int k)`, entry k < BIN_PAGE × pages of its list (0: the list has ended). Include
 * it once in the scene's glsl.
 */
export const binListsGlsl = `
// Bin lists (sims/bins.ts): pages of BIN_PAGE entries per bin; 0 ends a list.
const int BIN_PAGE = ${BIN_PAGE};
ivec3 binListsAt(sampler2D lists, int pages, vec2 p) {
  ivec2 size = textureSize(lists, 0);
  int rows = size.x / BIN_PAGE;
  int cols = size.y / pages;
  ivec2 bin = clamp(ivec2(floor(p * float(rows))), ivec2(0), ivec2(cols - 1, rows - 1));
  return ivec3(bin, cols);
}
float binListsEntry(sampler2D lists, ivec3 bin, int k) {
  return texelFetch(lists, ivec2(bin.y * BIN_PAGE + k % BIN_PAGE, bin.x + (k / BIN_PAGE) * bin.z), 0).r;
}
`;
