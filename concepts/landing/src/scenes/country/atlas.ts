// The countryside's records atlas (uSim3): the terrain's records with the murmuration's density
// field (murmuration.ts) and the verges' plants (verges.ts) packed beside and above them, so neither
// needs a sampler slot of its own (the terrain's four textures take every one). One rgba16f texture:
// the flock's field is read through its linear filter, every other texel with texelFetch, which no
// filter touches, so the terrain reads its records as it would from a texture of their own.
//
//   columns 0..63, rows 0..234       the terrain's records (TERRAIN_RECORDS), as packTerrain and
//                                    packLand write them
//   texel (64, 0)                    the murmuration's header (murmuration.ts)
//   texels (65, 0), (66, 0)          the verges' layout (verges.ts)
//   columns 64.., rows 1..           the flock's density field, while it flies
//   rows from max(235, 1 + field)    the verges' block, while they are on, the atlas's width a row
//
// With both off the atlas is the records alone, 64 × 235 as packTerrain lays them out, uploaded only
// when the land's uses change. Otherwise it is uploaded whole on each frame either part changes:
// the flock repaints its field, the verges sway.
import type { ParamDef } from "../../params.ts";
import { TERRAIN_RECORDS, type Terrain, type TerrainPacked } from "../../sims/terrain.ts";
import { DataTexture } from "../../sims/texture.ts";
import { Flock } from "../flock/sim.ts";
import type { SimFrame } from "../types.ts";
import { COUNTRY_FLOCK_HEAD, countryMurmuration, writeCountryFlock } from "./murmuration.ts";
import { COUNTRY_VERGE_HEAD, CountryVerges } from "./verges.ts";

const L = TERRAIN_RECORDS;
/** Texels the side takes at least beside the records while either part is on: the headers. */
const HEADS = Math.max(COUNTRY_FLOCK_HEAD + 1, COUNTRY_VERGE_HEAD + 2) - L.width;

export class CountryAtlas {
  readonly #texture: DataTexture;
  readonly #flock: Flock;
  readonly #verges: CountryVerges;
  #data = new Float32Array(L.width * L.height * 4);

  constructor(gl: WebGL2RenderingContext, params: readonly ParamDef[]) {
    this.#texture = new DataTexture(gl, { width: L.width, height: L.height, format: "rgba16f" });
    this.#flock = new Flock(params, countryMurmuration);
    this.#verges = new CountryVerges(params);
  }

  /** The verges' simulation, for tests. */
  get verges(): CountryVerges {
    return this.#verges;
  }

  /**
   * One frame: the flock and the verges stepped over the land on screen (`packed`: its textures'
   * data; `uses`: its records were rewritten this frame), packed and uploaded as they changed.
   */
  frame(frame: SimFrame, terrain: Terrain, packed: TerrainPacked, uses: boolean): WebGLTexture {
    const flock = this.#flock;
    const verges = this.#verges;
    const flown = flock.frame(frame);
    const verged = verges.frame(frame, terrain, packed, uses);
    const side = flown ? Math.max(HEADS, flock.fieldWidth) : verged ? HEADS : 0;
    const width = L.width + side;
    const base = Math.max(L.height, flown ? 1 + flock.fieldHeight : 0);
    const height = base + (verged ? verges.rows(width) : 0);
    const texture = this.#texture;
    const resized = width !== texture.width || height !== texture.height;
    if (resized) {
      texture.resize(width, height);
      this.#data = new Float32Array(width * height * 4);
    }
    const data = this.#data;
    if (resized || uses) {
      if (width === L.width) data.set(packed.records);
      else
        for (let row = 0; row < L.height; row++)
          data.set(
            packed.records.subarray(row * L.width * 4, (row + 1) * L.width * 4),
            row * width * 4,
          );
    }
    if (flown && (resized || flock.painted)) writeCountryFlock(flock, data, width);
    if (verged && (resized || verges.moved)) verges.write(data, width, base);
    if (resized || uses || (flown && flock.painted) || (verged && verges.moved))
      texture.upload(data);
    return texture.texture;
  }

  dispose(): void {
    this.#texture.dispose();
  }
}
