// The countryside's build (sims/build.ts), on the build worker: the terrain (sims/terrain.ts), its
// packed textures with the valley floor under the fog (fog.ts), the land model (sims/landuse.ts)
// with each parcel's texels for repacking only the parcels a new allocation changes, the chalk M's
// site (chalk.ts, weighed in the sky the request carries), and the land packed for the uses and the
// river as they stood when it was asked for. Its stages run in units a slice each (the terrain's own
// units, then one a stage), so on the page, where there is no worker, a build spreads over frames as
// it always did.
//
// A builder keeps its last finished TerrainBuilder, whose eroded relief, and carved river and
// streams with what is made of them alone, the next build reuses where its change leaves them be
// (terrain.ts); and the land model's ground (landGround) of the land and river it weighed last, so
// a change of the settlements or roads re-weighs only what they lay. The terrain a build hands back
// owns its arrays: what the kept builder shares with it (the bare land, the river's centreline) is
// copied, so the rest moves to the page by transfer and the builder keeps all it reuses.
import type { BuildKind } from "../../sims/build.ts";
import {
  type LandAllocation,
  type LandGround,
  landGround,
  LandModel,
  type LandModelData,
  type LandOptions,
  landTexels,
  type LandTexels,
  openLand,
  packLand,
} from "../../sims/landuse.ts";
import {
  packTerrain,
  packWater,
  type Terrain,
  TerrainBuilder,
  type TerrainOptions,
  type TerrainPacked,
} from "../../sims/terrain.ts";
import type { SkyState } from "../../world-clock.ts";
import { type ChalkSite, chalkSite, packChalk } from "./chalk.ts";
import { packCountryFog } from "./fog.ts";

/** What a build is for: the terrain's options, and the land's uses and river as they stand. */
export interface CountryRequest {
  readonly options: TerrainOptions;
  readonly uses: LandOptions;
  /** Whether the chalk M keeps its parcels open (its site is packed then). */
  readonly chalk: boolean;
  /** Whether the river runs (packWater). */
  readonly water: boolean;
  /** The sky at the scene's default hour, which the chalk M's site is weighed in (chalkSite). */
  readonly sky: SkyState;
}

/** A finished build, everything the page draws the land from. */
export interface CountryBuilt {
  readonly terrain: Terrain;
  /** Packed for the request's uses, chalk and river. */
  readonly packed: TerrainPacked;
  readonly model: LandModelData;
  readonly texels: LandTexels;
  /** The chalk M's site (null: none in sight), whether or not it is on. */
  readonly chalk: ChalkSite | null;
  /** The allocation `packed` holds. */
  readonly allocation: LandAllocation;
}

/** The allocation for `uses`, the chalk M's parcels opened and their woods felled while it is on. */
export function countryAllocation(
  model: LandModel,
  uses: LandOptions,
  chalk: boolean,
  site: ChalkSite | null,
): LandAllocation {
  const allocation = model.allocate(uses);
  if (chalk) openLand(allocation, model, site?.parcels ?? []);
  return allocation;
}

/** The terrain with copies of the arrays the builder keeps for reuse (see the header). */
function owned(t: Terrain): Terrain {
  const river = t.river;
  return {
    ...t,
    river: {
      x: river.x.slice(),
      z: river.z.slice(),
      level: river.level.slice(),
      width: river.width.slice(),
      along: river.along.slice(),
    },
    bare: { ground: t.bare.ground.slice(), level: t.bare.level.slice(), ids: t.bare.ids },
  };
}

export const countryBuild: BuildKind<CountryRequest, CountryBuilt> = {
  name: "country",
  builder() {
    let previous: TerrainBuilder | undefined;
    /** The land model's ground of the last terrain weighed, by its TerrainBuilder.riverKey. */
    let weighed: { key: string; ground: LandGround } | undefined;
    return {
      *build({ options, uses, chalk, water, sky }) {
        const builder = new TerrainBuilder(options, previous);
        for (let i = 0; i < builder.units; i++) {
          builder.unit(i);
          yield undefined;
        }
        previous = builder;
        const terrain = owned(builder.terrain);
        const packed = packTerrain(terrain);
        packCountryFog(packed, terrain);
        yield undefined;
        const key = builder.riverKey;
        const ground = weighed?.key === key ? weighed.ground : landGround(terrain, options.seed);
        weighed = { key, ground };
        const model = new LandModel(terrain, ground);
        yield undefined;
        const texels = landTexels(terrain);
        const site = chalkSite(terrain, sky);
        yield undefined;
        const allocation = countryAllocation(model, uses, chalk, site);
        if (chalk) packChalk(packed, site);
        packLand(packed, terrain, allocation);
        packWater(packed, terrain, water);
        return { terrain, packed, model: model.data, texels, chalk: site, allocation };
      },
    };
  },
};
