// Tiny creatures drawn cell by cell: a map of what each dither cell shows (a code) and how far away it
// is (a depth byte), for a scene whose specks are a cell or a few across (bees, butterflies, distant
// birds, fireflies) and whose shader hides each one behind the nearer things it draws.
//
// SpeckMap holds the bytes of an rg8 texture, one texel per dither cell, rows bottom to top (the
// shader's `cell`): R the scene's code for what is drawn there (0 nothing), G its depth in whatever
// steps the scene picks (bees: a quarter metre). Where two specks fall in the same cell the nearer
// one wins whatever order they are plotted in: the map keeps one speck per cell, and the shader
// compares that one depth with the scenery's, so a farther speck written over a nearer one would hide
// the nearer one too whenever scenery stands between them. At equal depth the later plot wins, so a
// creature's own detail (a wing over its body) goes over what it plotted first.
//   new SpeckMap()
//   resize(width, height)          a new frame size in cells: everything is cleared
//   clear()                        empty the cells plotted since the last clear (cheap: only those)
//   plot(cx, cy, code, depth)      draw code (1..255) at depth (0..255) in a cell; off-map cells are ignored
//   block(cx, cy, w, h, code, depth) the same over a w × h block from (cx, cy) up and to the right
//   upload(texture)                bring the map's rg8 DataTexture up to date: the whole map after a
//                                  resize, else only the cells whose bytes differ from those it last
//                                  sent, by SPECK_TILE-square tiles (a DirtyRegion: a run of them
//                                  along a row as one rectangle round their changed cells); a speck
//                                  cleared and plotted again where it was sends nothing (a frame of
//                                  some 80 specks sends a few KB, not the map)
//   data                           the rg8 bytes, width * height * 2
//
// followCell(drawn, v): the cell a speck at float cell coordinate v is drawn in, given the cell it was
// drawn in last (NaN at first). It stays put until v has clearly left that cell (0.85 cells from its
// middle), so a hovering speck never flickers between two.
//
// Usage (a sim with a DataTexture `rg8`, `nearest`, of the frame's size):
//   readonly #specks = new SpeckMap();
//   frame(frame) {
//     if (sizeChanged) { this.#specks.resize(w, h); this.#texture.resize(w, h); }
//     this.#specks.clear();
//     for (const b of this.#bees) {
//       b.cx = followCell(b.cx, (b.x / b.z) * h + 0.5 * w);
//       b.cy = followCell(b.cy, ...);
//       this.#specks.plot(b.cx, b.cy, CODE_BEE, Math.min(255, Math.round(b.z * DEPTH_STEP)));
//     }
//     this.#specks.upload(this.#texture);
//   }
// and in GLSL: `vec2 s = texelFetch(uSim0, ivec2(cell), 0).rg; int code = int(s.r * 255.0 + 0.5);`,
// drawn where `code > 0 && s.g * 255.0 / DEPTH_STEP < sceneryDepth`.
import { DirtyRegion, type DataTexture } from "./texture.ts";

/** Cells along a side of the square tiles SpeckMap.upload sends: few calls, few bytes for scattered specks. */
const SPECK_TILE = 8;

export class SpeckMap {
  #width = 0;
  #height = 0;
  #data = new Uint8Array(0);
  /** The bytes as last uploaded, the texture's: a cell is sent only where `data` differs from them. */
  #sent = new Uint8Array(0);
  /** Byte offsets of the cells plotted since the last clear (a cell plotted twice is listed twice). */
  readonly #written: number[] = [];
  /** Byte offsets of the cells cleared since the last upload (as #written). */
  readonly #cleared: number[] = [];
  /** The cells changed since the last upload, by tiles; the whole map at first and after a resize. */
  readonly #changed = new DirtyRegion(0, 0, SPECK_TILE, SPECK_TILE);

  get width(): number {
    return this.#width;
  }

  get height(): number {
    return this.#height;
  }

  /** The rg8 bytes, rows bottom to top: code, depth per cell. */
  get data(): Uint8Array {
    return this.#data;
  }

  resize(width: number, height: number): void {
    this.#width = Math.max(0, Math.floor(width));
    this.#height = Math.max(0, Math.floor(height));
    this.#data = new Uint8Array(this.#width * this.#height * 2);
    this.#sent = new Uint8Array(this.#data.length);
    this.#written.length = 0;
    this.#cleared.length = 0;
    this.#changed.resize(this.#width, this.#height);
  }

  clear(): void {
    const data = this.#data;
    for (const at of this.#written) {
      data[at] = 0;
      data[at + 1] = 0;
      this.#cleared.push(at);
    }
    this.#written.length = 0;
  }

  plot(cx: number, cy: number, code: number, depth: number): void {
    if (!(cx >= 0 && cx < this.#width && cy >= 0 && cy < this.#height)) return;
    const at = (cy * this.#width + cx) * 2;
    const data = this.#data;
    if (data[at] !== 0 && depth > (data[at + 1] ?? 0)) return;
    data[at] = code;
    data[at + 1] = depth;
    this.#written.push(at);
  }

  block(cx: number, cy: number, w: number, h: number, code: number, depth: number): void {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.plot(cx + i, cy + j, code, depth);
  }

  /** Bring `texture` (rg8, the map's size) up to date with the cells changed since the last upload. */
  upload(texture: DataTexture): void {
    this.#compare(this.#cleared);
    this.#compare(this.#written);
    this.#cleared.length = 0;
    this.#changed.flush(texture, this.#data);
  }

  /** Mark the cells at byte `offsets` whose bytes differ from those last sent; they are sent now. */
  #compare(offsets: readonly number[]): void {
    const data = this.#data;
    const sent = this.#sent;
    const width = this.#width;
    for (const at of offsets) {
      const code = data[at] ?? 0;
      const depth = data[at + 1] ?? 0;
      if (code === sent[at] && depth === sent[at + 1]) continue;
      sent[at] = code;
      sent[at + 1] = depth;
      const cell = at / 2;
      const cy = Math.floor(cell / width);
      this.#changed.mark(cell - cy * width, cy);
    }
  }
}

/** The cell a speck at float cell coordinate v is drawn in: it stays in `drawn` until it has clearly left. */
export function followCell(drawn: number, v: number): number {
  return Math.abs(v - (drawn + 0.5)) <= 0.85 ? drawn : Math.floor(v);
}
