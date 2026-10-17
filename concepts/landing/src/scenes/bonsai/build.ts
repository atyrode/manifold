// The bonsai's build (sims/build.ts), on the build worker: a tree grown for its species and seed
// (tree.ts) and drawn into its maps (raster.ts), a new tree's slow part, off the page's thread. The
// page's sim (sim.ts) does the rest.
import type { BuildKind } from "../../sims/build.ts";
import { BONSAI_MAX_TUFTS } from "./geometry.ts";
import { TreeMaps, type TreeMapsState } from "./raster.ts";
import { growTree, type Tree } from "./tree.ts";

/** A tree to grow: its species and seed. */
export interface BonsaiGrowthRequest {
  readonly species: number;
  readonly seed: number;
}

/** A tree grown, and drawn into its maps: what the build worker hands the page. */
export interface BonsaiGrowth {
  readonly species: number;
  readonly seed: number;
  readonly tree: Tree;
  readonly maps: TreeMapsState;
}

/**
 * Growing a tree for its species and seed (tree.ts) and drawing it into the maps (raster.ts), as a
 * build (sims/build.ts): a new tree's slow part, off the page's thread. The page's sim does the rest.
 */
export const bonsaiGrowth: BuildKind<BonsaiGrowthRequest, BonsaiGrowth> = {
  name: "bonsai",
  builder: () => ({
    *build({ species, seed }) {
      const tree = growTree(species, seed, BONSAI_MAX_TUFTS);
      yield undefined;
      const maps = new TreeMaps();
      maps.draw(tree);
      return { species, seed, tree, maps: maps.state };
    },
  }),
};
