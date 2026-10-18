// The valley's sim (ADR 0062: its LayerSim, layers.ts valleyLayer): the countryside's land, the
// terrain toolbox (sims/terrain.ts) built from the land's knobs on the build worker (build.ts,
// sims/build.ts), each parcel given its use by the land model (sims/landuse.ts), packed into the
// four textures the shader reads through terrainGlsl, the valley's four field slots (valleyField0..3):
//   field 0  rgba16f linear   ground, water level, the ground's slope (d/dx, d/dz)
//   field 1  rgba16f linear   road and stream signed distance, the woods' clearance (the woods stand
//                             above the records' woods' line), yard (-1 a standing lone tree)
//   field 2  rgba8 nearest    the nearest two parcels per texel, the first flagged in pine woods
//   field 3  rgba16f linear   records: parcel sites with their use and attribute, buildings,
//                             settlements, the bridge, the eye, the roads' way points, the chalk
//                             M's site (chalk.ts), the valley floor under the fog (fog.ts)
//                             (texelFetch); beside and above them the murmuration's field and the
//                             verges' plants while they are on (the records atlas, atlas.ts)
// The land is built from the knobs of every country layer (layers.ts): the valley's (its shape,
// relief and erosion; the composer's seed), the waterway's (the river), the farmland's (the shares,
// the pine mix, the cattle share, the chalk M), the settlements' (the village, hamlets, farms,
// castle, roads and tracks); a layer switched off lays none of its part (the waterway's river runs
// dry, keeping its size), and one the preset does not offer (a guest valley: the bees garden's) lays
// it as the countryside opens it (its defaults, its home layers on).
// Three tiers of change, cheapest last, each a stage keyed by what it reads:
//   the terrain (land shape, seed, relief, erosion, the river's size, the settlements and roads): a
//     new build on the worker (build.ts), reusing what the change leaves alone (terrain.ts), packed
//     and weighed there with the land as it stood when asked for; the last map stays on screen until
//     it lands, a newer terrain supersedes a build in progress, and the terrain on screen asked for
//     again drops it (BuildSlot) and builds nothing;
//   the land's uses (the shares, the pine mix, the cattle share, the chalk M keeping its parcels
//     open, its site looked for once per terrain): the allocation (LandModel.allocate) within the
//     frame, repacking only the parcels whose use changed (repackLand) and uploading only the rows of
//     fields 1 and 2 whose bytes changed, and field 3 (where the woodland share moves the woods' line);
//   the river switched on or off: packWater within the frame, uploading fields 0 and 1.
// Nothing is drawn before the first build: the valley shows the World's sky meanwhile, which the
// entrance looks into. Where there is no worker the build runs here a few units a frame, as before.
import type { LayerFrame, LayerSim } from "../../composer/types.ts";
import { KnobReader, type ParamDef } from "../../params.ts";
import { BuildSlot } from "../../sims/build.ts";
import {
  LAND_SHARED,
  LandModel,
  type LandOptions,
  type LandRows,
  repackLand,
  type SharedUse,
} from "../../sims/landuse.ts";
import { TERRAIN_BASES } from "../../sims/terrain-limits.ts";
import { packWater } from "../../sims/terrain.ts";
import { DataTexture, DirtyRegion } from "../../sims/texture.ts";
import { type SkyState, skyState } from "../../world-clock.ts";
import { CountryAtlas } from "./atlas.ts";
import { withCountryDefaults } from "./layers.ts";
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
  "seed",
  "valleyRelief",
  "erosion",
  "waterway",
  "settlements",
  "village",
  "hamlets",
  "farms",
  "castle",
  "roads",
  "tracks",
  "farmland",
  "crops",
  "farmlandWildflowers",
  "lavender",
  "sunflowers",
  "pasture",
  "woodland",
  "farmlandPines",
  "cows",
  "chalk",
  "time",
] as const;
type Knob = (typeof KNOBS)[number];

/** The land model's shared uses by the farmland's knobs (its wildflowers qualified). */
const SHARE_KNOBS: Readonly<Record<SharedUse, Knob>> = {
  crops: "crops",
  wildflowers: "farmlandWildflowers",
  lavender: "lavender",
  sunflowers: "sunflowers",
  pasture: "pasture",
  woodland: "woodland",
};

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

class ValleySim implements LayerSim {
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

  constructor(gl: WebGL2RenderingContext, sceneParams: readonly ParamDef[]) {
    // Every country knob the scene lacks (a guest valley's) reads as the countryside opens it.
    const params = withCountryDefaults(sceneParams);
    this.#knobs = new KnobReader("valley", params, KNOBS);
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

  frame(frame: LayerFrame): void {
    const knobs = this.#knobs;
    // A part's knob while its layer is on, nothing of it while it is off (layers.ts).
    const settled = knobs.on(frame, "settlements");
    const farmed = knobs.on(frame, "farmland");
    const settlement = (key: Knob) => (settled ? knobs.value(frame, key) : 0);
    const farm = (key: Knob) => (farmed ? knobs.value(frame, key) : 0);
    const options = {
      seed: Math.round(knobs.value(frame, "seed")),
      size: COUNTRY_MAP.size,
      extent: COUNTRY_MAP.extent,
      relief: knobs.value(frame, "valleyRelief"),
      erosion: knobs.value(frame, "erosion"),
      // The river keeps its size while it runs dry: only its water goes (packWater).
      river: knobs.amount(frame, "waterway"),
      village: Math.round(settlement("village")),
      hamlets: Math.round(settlement("hamlets")),
      farms: Math.round(settlement("farms")),
      castle: settlement("castle") > 0.5,
      roads: settlement("roads") > 0.5,
      tracks: settlement("tracks") > 0.5,
      base: knobs.pick(frame, "shape", TERRAIN_BASES, "valley"),
    };

    const shares: LandOptions["shares"] = Object.fromEntries(
      LAND_SHARED.map((use) => [use, farm(SHARE_KNOBS[use])]),
    );
    const uses: LandOptions = {
      shares,
      pines: farm("farmlandPines"),
      cows: farm("cows"),
    };
    const chalk = farmed && knobs.on(frame, "chalk");
    const water = knobs.on(frame, "waterway");
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
    if (!land) return;
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
    const textures = [this.#ground.texture, this.#cover.texture, this.#parcels.texture, records];
    textures.forEach((texture, k) => {
      const field = frame.fields[k];
      if (field !== undefined) field.texture = texture;
    });
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
   * (repackLand). Returns the rows of fields 1 and 2 rewritten.
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

/** The valley's sim (LayerCode.sim): the countryside's land for the scene's knobs. */
export function valleySim(gl: WebGL2RenderingContext, params: readonly ParamDef[]): LayerSim {
  return new ValleySim(gl, params);
}
