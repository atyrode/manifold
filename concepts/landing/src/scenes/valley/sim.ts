// The valley's landscape: the terrain toolbox (sims/terrain.ts) built from the landscape knobs a few
// units a frame (runBudgeted), packed into the four textures the shader reads through terrainGlsl:
//   uSim0  rgba16f linear   ground, water level, the ground's slope (d/dx, d/dz)
//   uSim1  rgba16f linear   road and stream signed distance, woodland suitability, yard
//   uSim2  rgba8 nearest    the nearest two field parcels per texel
//   uSim3  rgba16f nearest  records: parcel sites, buildings, settlements, the bridge, the eye
// A knob that changes the layout starts a new build; the last map stays on screen until it is done,
// and a build that keeps the relief (river, settlements) reuses its eroded ground. Nothing is drawn
// before the first build: the shader shows the sky meanwhile, which the entrance looks into.
import { KnobReader, type ParamDef } from "../../params.ts";
import { runBudgeted } from "../../sims/clock.ts";
import { packTerrain, TERRAIN_RECORDS, TerrainBuilder } from "../../sims/terrain.ts";
import { DataTexture } from "../../sims/texture.ts";
import type { SceneSim, SimFactory, SimFrame } from "../types.ts";

/** The map: texels a side and metres a side. */
export const VALLEY_MAP = { size: 512, extent: 3200 } as const;

/**
 * Milliseconds of building a frame may take: a share of the time between frames, so a slow renderer
 * (a software one draws a frame in a second) builds as fast in frames as a fast one does in time,
 * between a floor that keeps a fast page smooth and a cap that keeps a slow one responsive. The
 * first build gets more: nothing of the valley is on screen until it is done, and the entrance's
 * dissolve covers the slower frames.
 */
const BUDGET = { share: 0.25, least: 8, first: 24, most: 120 } as const;

type Knob = "landscape" | "relief" | "erosion" | "river" | "settlements";

class ValleySim implements SceneSim {
  readonly #knobs: KnobReader<Knob>;
  readonly #ground: DataTexture;
  readonly #cover: DataTexture;
  readonly #parcels: DataTexture;
  readonly #records: DataTexture;
  #builder: TerrainBuilder | undefined;
  #key = "";
  #next = 0;
  #shown = false;
  /** performance.now() at the last frame, for the time between frames. */
  #last = Number.NaN;

  constructor(gl: WebGL2RenderingContext, params: readonly ParamDef[]) {
    this.#knobs = new KnobReader("valley", params, [
      "landscape",
      "relief",
      "erosion",
      "river",
      "settlements",
    ]);
    const { size } = VALLEY_MAP;
    this.#ground = new DataTexture(gl, { width: size, height: size, format: "rgba16f" });
    this.#cover = new DataTexture(gl, { width: size, height: size, format: "rgba16f" });
    this.#parcels = new DataTexture(gl, {
      width: size,
      height: size,
      format: "rgba8",
      filter: "nearest",
    });
    this.#records = new DataTexture(gl, {
      width: TERRAIN_RECORDS.width,
      height: TERRAIN_RECORDS.height,
      format: "rgba16f",
      filter: "nearest",
    });
  }

  frame(frame: SimFrame): readonly (WebGLTexture | undefined)[] {
    const options = {
      seed: Math.round(this.#knobs.value(frame, "landscape")),
      size: VALLEY_MAP.size,
      extent: VALLEY_MAP.extent,
      relief: this.#knobs.value(frame, "relief"),
      erosion: this.#knobs.value(frame, "erosion"),
      river: this.#knobs.value(frame, "river"),
      settlements: Math.round(this.#knobs.value(frame, "settlements")),
    };
    const key = JSON.stringify(options);
    if (key !== this.#key) {
      const previous = this.#builder?.done ? this.#builder : undefined;
      this.#builder = new TerrainBuilder(options, previous);
      this.#key = key;
      this.#next = 0;
    }
    const builder = this.#builder;
    const now = performance.now();
    const between = Number.isFinite(this.#last) ? now - this.#last : 0;
    this.#last = now;
    if (builder && this.#next < builder.units) {
      const least = this.#shown ? BUDGET.least : BUDGET.first;
      const budget = Math.min(BUDGET.most, Math.max(least, BUDGET.share * between));
      this.#next = runBudgeted((i) => builder.unit(i), budget, builder.units, this.#next);
      if (builder.done) {
        const packed = packTerrain(builder.terrain);
        this.#ground.upload(packed.ground);
        this.#cover.upload(packed.cover);
        this.#parcels.upload(packed.parcels);
        this.#records.upload(packed.records);
        this.#shown = true;
      }
    }
    if (!this.#shown) return [];
    return [this.#ground.texture, this.#cover.texture, this.#parcels.texture, this.#records.texture];
  }

  dispose(): void {
    this.#ground.dispose();
    this.#cover.dispose();
    this.#parcels.dispose();
    this.#records.dispose();
  }
}

/** The valley's sim for its knobs. */
export function valleySim(params: readonly ParamDef[]): SimFactory {
  return (gl) => new ValleySim(gl, params);
}
