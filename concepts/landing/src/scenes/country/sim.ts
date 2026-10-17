// The countryside's land: the terrain toolbox (sims/terrain.ts) built from the land's knobs on the
// build worker (build.ts, sims/build.ts), each parcel given its use by the land model
// (sims/landuse.ts), packed into the four textures the shader reads through terrainGlsl:
//   uSim0  rgba16f linear   ground, water level, the ground's slope (d/dx, d/dz)
//   uSim1  rgba16f linear   road and stream signed distance, the woods' canopy, yard (-1 a
//                           standing lone tree)
//   uSim2  rgba8 nearest    the nearest two parcels per texel, the first flagged in pine woods
//   uSim3  rgba16f linear   records: parcel sites with their use and attribute, buildings,
//                           settlements, the bridge, the eye, the roads' way points, the chalk M's
//                           site (chalk.ts), the valley floor under the fog (fog.ts) (texelFetch);
//                           beside and above them the murmuration's field and the verges' plants
//                           while they are on (the records atlas, atlas.ts)
// Three tiers of change, cheapest last, each a stage keyed by what it reads:
//   the terrain (land shape, landscape, relief, erosion, the river's size, the settlements and
//     roads): a new build on the worker (build.ts), reusing what the change leaves alone
//     (terrain.ts), packed and weighed there with the land as it stood when asked for; the last map
//     stays on screen until it lands, a newer terrain supersedes a build in progress, and the
//     terrain on screen asked for again drops it (BuildSlot) and builds nothing;
//   the land's uses (the shares, the pine mix, the cattle share, the chalk M keeping its parcels
//     open, its site looked for once per terrain): the allocation (LandModel.allocate) within the
//     frame, repacking only the parcels whose use changed (repackLand) and uploading only the rows of
//     uSim1 they span, of uSim2 only those where a wood's species flag changed, and uSim3;
//   the river switched on or off: packWater within the frame, uploading uSim0 and uSim1.
// Nothing is drawn before the first build: the shader shows the sky meanwhile, which the entrance
// looks into. Where there is no worker the build runs here a few units a frame, as before.
import { KnobReader, type ParamDef } from "../../params.ts";
import { BuildSlot } from "../../sims/build.ts";
import {
  LAND_SHARED,
  LandModel,
  type LandOptions,
  type LandRows,
  repackLand,
} from "../../sims/landuse.ts";
import { packWater, TERRAIN_BASES } from "../../sims/terrain.ts";
import { DataTexture, DirtyRegion } from "../../sims/texture.ts";
import { type SkyState, skyState } from "../../world-clock.ts";
import type { SceneSim, SimFactory, SimFrame } from "../types.ts";
import { CountryAtlas } from "./atlas.ts";
import {
  countryAllocation,
  countryBuild,
  type CountryBuilt,
  type CountryRequest,
} from "./build.ts";
import { packChalk } from "./chalk.ts";

/** The map: texels a side and metres a side. */
export const COUNTRY_MAP = { size: 512, extent: 3200 } as const;

/**
 * Milliseconds the first build takes a frame at least where it runs on the page (more when the
 * frame's budget allows more): nothing of the land is on screen until it is done, and the
 * entrance's dissolve covers the slower frames. Later builds take the frame's budget
 * (SimFrame.budget: a share of the time between frames).
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
  "time",
  ...LAND_SHARED,
] as const;
type Knob = (typeof KNOBS)[number];

/** A finished terrain on screen: its land model and its packed textures, rewritten in place. */
interface Land extends Omit<CountryBuilt, "model"> {
  model: LandModel;
  /** The allocation `packed` holds, and the land options it was made for. */
  allocation: CountryBuilt["allocation"];
  uses: string;
  water: boolean;
  /** Whether the chalk M's site is packed (the first time the knob is on). */
  chalked: boolean;
}

/** The land options and the chalk M as one key. */
function usesKey(uses: LandOptions, chalk: boolean): string {
  return JSON.stringify({ ...uses, chalk });
}

class CountrySim implements SceneSim {
  readonly #knobs: KnobReader<Knob>;
  readonly #ground: DataTexture;
  readonly #cover: DataTexture;
  readonly #parcels: DataTexture;
  /** The rows of the cover and of the parcels' map changed since each was last uploaded. */
  readonly #coverChanged = new DirtyRegion(COUNTRY_MAP.size, COUNTRY_MAP.size);
  readonly #parcelsChanged = new DirtyRegion(COUNTRY_MAP.size, COUNTRY_MAP.size);
  readonly #atlas: CountryAtlas;
  readonly #build = new BuildSlot(countryBuild);
  /**
   * The sky the chalk M's site is weighed in (CountryRequest.sky): the default hour's, wherever the
   * clock stands now.
   */
  readonly #sky: SkyState;
  /** The terrain's key and request the build in progress (or the land on screen) was asked for. */
  #asked: { key: string; request: CountryRequest } | undefined;
  #land: Land | undefined;

  constructor(gl: WebGL2RenderingContext, params: readonly ParamDef[]) {
    this.#knobs = new KnobReader("country", params, KNOBS);
    this.#sky = skyState(this.#knobs.initial("time"));
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
    const options = {
      seed: Math.round(knobs.value(frame, "landscape")),
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

    const shares: LandOptions["shares"] = Object.fromEntries(
      LAND_SHARED.map((use) => [use, knobs.value(frame, use)]),
    );
    const uses: LandOptions = {
      shares,
      pines: knobs.value(frame, "pines"),
      cows: knobs.value(frame, "cows"),
    };
    const chalk = knobs.on(frame, "chalk");
    const water = knobs.on(frame, "river");
    const key = JSON.stringify(options);
    let asked = this.#asked;
    if (key !== asked?.key) {
      asked = { key, request: { options, uses, chalk, water, sky: this.#sky } };
      this.#asked = asked;
      this.#build.request(key, asked.request);
    }
    const landed = this.#build.advance(
      this.#land ? frame.budget : Math.max(FIRST_BUDGET_MS, frame.budget),
    );
    const fresh = landed !== undefined;
    if (fresh) this.#land = this.#adopt(landed.result, asked.request);
    const land = this.#land;
    if (!land) return [];
    const nextUses = usesKey(uses, chalk);
    const allocate = nextUses !== land.uses;
    const rows = allocate ? this.#allocate(land, uses, chalk, nextUses) : undefined;
    const flow = water !== land.water;
    if (flow) {
      packWater(land.packed, land.terrain, water);
      land.water = water;
    }
    if (fresh || flow) {
      this.#ground.upload(land.packed.ground);
      this.#coverChanged.all();
    }
    if (fresh) this.#parcelsChanged.all();
    const { size } = COUNTRY_MAP;
    if (rows?.cover) this.#coverChanged.touch(0, rows.cover[0], size, rows.cover[1] + 1);
    if (rows?.parcels) this.#parcelsChanged.touch(0, rows.parcels[0], size, rows.parcels[1] + 1);
    this.#coverChanged.flush(this.#cover, land.packed.cover);
    this.#parcelsChanged.flush(this.#parcels, land.packed.parcels);
    const records = this.#atlas.frame(frame, land.terrain, land.packed, fresh || allocate);
    return [this.#ground.texture, this.#cover.texture, this.#parcels.texture, records];
  }

  /** Ready once the first land is built (a later rebuild keeps showing the previous land). */
  ready(): boolean {
    return this.#land !== undefined;
  }

  dispose(): void {
    this.#build.dispose();
    this.#ground.dispose();
    this.#cover.dispose();
    this.#parcels.dispose();
    this.#atlas.dispose();
  }

  /** A landed build as the land on screen, packed for the uses and river it was asked with. */
  #adopt(built: CountryBuilt, asked: CountryRequest): Land {
    return {
      ...built,
      model: new LandModel(built.model),
      uses: usesKey(asked.uses, asked.chalk),
      water: asked.water,
      chalked: asked.chalk,
    };
  }

  /**
   * The land's uses as they stand now: allocated, and repacked where the allocation differs
   * (repackLand). Returns the rows of uSim1 and uSim2 rewritten.
   */
  #allocate(land: Land, uses: LandOptions, chalk: boolean, key: string): LandRows {
    if (chalk && !land.chalked) {
      packChalk(land.packed, land.chalk);
      land.chalked = true;
    }
    const allocation = countryAllocation(land.model, uses, chalk, land.chalk);
    const rows = repackLand(land.packed, land.terrain, allocation, land.allocation, land.texels);
    land.allocation = allocation;
    land.uses = key;
    return rows;
  }
}

/** The countryside's sim for its knobs. */
export function countrySim(params: readonly ParamDef[]): SimFactory {
  return (gl) => new CountrySim(gl, params);
}
