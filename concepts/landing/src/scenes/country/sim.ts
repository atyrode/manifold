// The countryside's land: the terrain toolbox (sims/terrain.ts) built from the land's knobs a few
// units a frame (runBudgeted), each parcel given its use by the land model (sims/landuse.ts), packed
// into the four textures the shader reads through terrainGlsl:
//   uSim0  rgba16f linear   ground, water level, the ground's slope (d/dx, d/dz)
//   uSim1  rgba16f linear   road and stream signed distance, the woods' canopy (negative under
//                           pines), yard (-1 a standing lone tree)
//   uSim2  rgba8 nearest    the nearest two parcels per texel
//   uSim3  rgba16f linear   records: parcel sites with their use and attribute, buildings,
//                           settlements, the bridge, the eye, the roads' way points, the chalk M's
//                           site (chalk.ts), the valley floor under the fog (fog.ts) (texelFetch);
//                           beside and above them the murmuration's field and the verges' plants
//                           while they are on (the records atlas, atlas.ts)
// Three tiers of change, cheapest last:
//   the terrain (land shape, landscape, relief, erosion, the river's size, the settlements and
//     roads): a new build over a few frames, reusing what the change leaves alone (terrain.ts); the
//     last map stays on screen until it is done;
//   the land's uses (the shares, the pine mix, the cattle share, the chalk M keeping its parcels
//     open, its site looked for once per terrain): the allocation (LandModel.allocate) and packLand
//     within the frame, uploading only uSim1 and uSim3;
//   the river switched on or off: packWater within the frame, uploading uSim0 and uSim1.
// Nothing is drawn before the first build: the shader shows the sky meanwhile, which the entrance
// looks into.
import { KnobReader, type ParamDef } from "../../params.ts";
import { runBudgeted } from "../../sims/clock.ts";
import { LAND_SHARED, LandModel, type LandOptions, packLand } from "../../sims/landuse.ts";
import {
  packTerrain,
  packWater,
  TERRAIN_BASES,
  type Terrain,
  TerrainBuilder,
  type TerrainPacked,
} from "../../sims/terrain.ts";
import { DataTexture } from "../../sims/texture.ts";
import type { SceneSim, SimFactory, SimFrame } from "../types.ts";
import { CountryAtlas } from "./atlas.ts";
import { type ChalkSite, chalkSite, keepChalkOpen, packChalk } from "./chalk.ts";
import { packCountryFog } from "./fog.ts";

/** The map: texels a side and metres a side. */
export const COUNTRY_MAP = { size: 512, extent: 3200 } as const;

/**
 * Milliseconds the first build takes a frame at least (more when the frame's budget allows more):
 * nothing of the land is on screen until it is done, and the entrance's dissolve covers the slower
 * frames. Later builds take the frame's budget (SimFrame.budget: a share of the time between frames).
 */
const FIRST_BUDGET_MS = 24;

const KNOBS = [
  "shape",
  "landscape",
  "relief",
  "erosion",
  "river",
  "village",
  "hamlets",
  "farms",
  "castle",
  "roads",
  "tracks",
  "pines",
  "cows",
  "chalk",
  ...LAND_SHARED,
] as const;
type Knob = (typeof KNOBS)[number];

/** A finished terrain on screen: its land model and its packed textures, rewritten in place. */
interface Land {
  terrain: Terrain;
  model: LandModel;
  packed: TerrainPacked;
  /** The land options and river state last packed ("" none yet). */
  uses: string;
  water: boolean | undefined;
  /** The chalk M's site (chalk.ts), looked for the first time the knob is on (null: none). */
  chalk: ChalkSite | null | undefined;
}

class CountrySim implements SceneSim {
  readonly #knobs: KnobReader<Knob>;
  readonly #ground: DataTexture;
  readonly #cover: DataTexture;
  readonly #parcels: DataTexture;
  readonly #atlas: CountryAtlas;
  #builder: TerrainBuilder | undefined;
  #key = "";
  #next = 0;
  #land: Land | undefined;

  constructor(gl: WebGL2RenderingContext, params: readonly ParamDef[]) {
    this.#knobs = new KnobReader("country", params, KNOBS);
    const { size } = COUNTRY_MAP;
    this.#ground = new DataTexture(gl, { width: size, height: size, format: "rgba16f" });
    this.#cover = new DataTexture(gl, { width: size, height: size, format: "rgba16f" });
    this.#parcels = new DataTexture(gl, {
      width: size,
      height: size,
      format: "rgba8",
      filter: "nearest",
    });
    this.#atlas = new CountryAtlas(gl, params);
  }

  frame(frame: SimFrame): readonly (WebGLTexture | undefined)[] {
    const knobs = this.#knobs;
    const seed = Math.round(knobs.value(frame, "landscape"));
    const options = {
      seed,
      size: COUNTRY_MAP.size,
      extent: COUNTRY_MAP.extent,
      relief: knobs.value(frame, "relief"),
      erosion: knobs.value(frame, "erosion"),
      // The river keeps its size while it runs dry: only its water goes (packWater).
      river: knobs.amount(frame, "river"),
      village: Math.round(knobs.value(frame, "village")),
      hamlets: Math.round(knobs.value(frame, "hamlets")),
      farms: Math.round(knobs.value(frame, "farms")),
      castle: knobs.value(frame, "castle") > 0.5,
      roads: knobs.value(frame, "roads") > 0.5,
      tracks: knobs.value(frame, "tracks") > 0.5,
      base: knobs.pick(frame, "shape", TERRAIN_BASES, "valley"),
    };
    const key = JSON.stringify(options);
    if (key !== this.#key) {
      const previous = this.#builder?.done ? this.#builder : undefined;
      this.#builder = new TerrainBuilder(options, previous);
      this.#key = key;
      this.#next = 0;
    }
    const builder = this.#builder;
    if (builder && this.#next < builder.units) {
      const budget = this.#land ? frame.budget : Math.max(FIRST_BUDGET_MS, frame.budget);
      this.#next = runBudgeted((i) => builder.unit(i), budget, builder.units, this.#next);
      if (builder.done) {
        const terrain = builder.terrain;
        const packed = packTerrain(terrain);
        packCountryFog(packed, terrain);
        this.#land = {
          terrain,
          model: new LandModel(terrain, seed),
          packed,
          uses: "",
          water: undefined,
          chalk: undefined,
        };
        this.#parcels.upload(packed.parcels);
      }
    }
    const land = this.#land;
    if (!land) return [];
    const shares: LandOptions["shares"] = Object.fromEntries(
      LAND_SHARED.map((use) => [use, knobs.value(frame, use)]),
    );
    const uses: LandOptions = {
      shares,
      pines: knobs.value(frame, "pines"),
      cows: knobs.value(frame, "cows"),
    };
    const chalk = knobs.on(frame, "chalk");
    const usesKey = JSON.stringify({ ...uses, chalk });
    const water = knobs.on(frame, "river");
    const allocate = usesKey !== land.uses;
    const flow = water !== land.water;
    if (allocate) {
      const allocation = land.model.allocate(uses);
      if (chalk) {
        if (land.chalk === undefined) {
          land.chalk = chalkSite(land.terrain);
          packChalk(land.packed, land.chalk);
        }
        keepChalkOpen(allocation, land.model, land.chalk);
      }
      packLand(land.packed, land.terrain, allocation);
      land.uses = usesKey;
    }
    if (flow) {
      packWater(land.packed, land.terrain, water);
      land.water = water;
      this.#ground.upload(land.packed.ground);
    }
    if (allocate || flow) this.#cover.upload(land.packed.cover);
    const records = this.#atlas.frame(frame, land.terrain, land.packed, allocate);
    return [this.#ground.texture, this.#cover.texture, this.#parcels.texture, records];
  }

  /** Ready once the first land is built (a later rebuild keeps showing the previous land). */
  ready(): boolean {
    return this.#land !== undefined;
  }

  dispose(): void {
    this.#ground.dispose();
    this.#cover.dispose();
    this.#parcels.dispose();
    this.#atlas.dispose();
  }
}

/** The countryside's sim for its knobs. */
export function countrySim(params: readonly ParamDef[]): SimFactory {
  return (gl) => new CountrySim(gl, params);
}
