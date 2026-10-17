// The slime mould's build (sims/build.ts), on the build worker: a fresh dish laid for its layout,
// seed and frame (the food, the flow network settled under it, the sketch and the veins' distances,
// and for the live mould the specks and the film), so a knob change never stalls the page. The
// page's sim (sim.ts) lays the same food again and takes the rest.
import type { BuildKind } from "../../sims/build.ts";
import { mulberry32 } from "../../sims/random.ts";
import { Film, picture, seedAgents, stampDistance, stampSketch } from "./draw.ts";
import { cityMap, FoodBook, type Layout, type SeaSampler, seaAt, seaCover } from "./food.ts";
import { Grid } from "./grid.ts";
import { FlowNetwork, type FlowNetworkState } from "./network.ts";

/** Sea cover above which the light shuts the network's tubes out. */
export const SEA_SHUT = 0.15;

/** The specks' state texture for `count` of them: about square, a power of two wide. */
export function agentShape(count: number): { width: number; height: number } {
  const width = 2 ** Math.ceil(Math.log2(count) / 2);
  return { width, height: Math.ceil(count / width) };
}

/**
 * The random numbers for a dish with this seed: one number fixing the flow network (its mesh, lace
 * and flow), a stream for the specks.
 */
function dishSeeds(seed: number): { network: number; rand: () => number } {
  const network = (Math.imul(seed + 7, 0x85ebca6b) ^ 0x6a09e667) >>> 0;
  return { network, rand: mulberry32(network ^ 0x5bd1e995) };
}

/**
 * The flow network for a fresh dish, settled under its food: the lit sea shut to it unless an M
 * has put the lights out.
 */
function settledNetwork(
  food: FoodBook,
  aspect: number,
  sea: SeaSampler,
  lit: boolean,
  seed: number,
): FlowNetwork {
  const network = new FlowNetwork(aspect, (u, v) => sea(u, v) > SEA_SHUT, seed);
  network.setLight(lit);
  network.setFood(food.nodes, food.heartId);
  network.grow();
  return network;
}

/** A dish to lay: its layout and seed, the frame aspect, the M laid at once, the specks' count. */
export interface PhysarumDishRequest {
  readonly layout: Layout;
  readonly seed: number;
  readonly aspect: number;
  readonly mark: number | undefined;
  /** The specks to seed over the network (the live mould); undefined for the still sketch. */
  readonly agents: number | undefined;
}

/** A fresh dish's CPU work, for the dish's own grid (new Grid(aspect)). */
export interface PhysarumDish {
  /** The lit sea at half resolution (seaCover). */
  readonly cover: Float32Array;
  /** The flow network settled under the dish's food. */
  readonly network: FlowNetworkState;
  /** The network and the flakes drawn as the sketch (stampSketch), and the veins' distances. */
  readonly sketch: Float32Array;
  readonly dist: Float32Array;
  /** The specks seeded along it and the trail level they keep up (the live mould only). */
  readonly specks: { readonly data: Float32Array; readonly level: number } | undefined;
  /** The film and the lace under it (Film.adopt), the live mould only. */
  readonly film: { readonly data: Float32Array; readonly lace: Float32Array } | undefined;
}

/**
 * Laying a fresh dish as a build (sims/build.ts): the food, the settled network, the sketch, the
 * distances, and for the live mould the specks and the film. The page lays the same food again
 * (FoodBook.reset is cheap and the same for the same dish) and takes the rest.
 */
export const physarumDish: BuildKind<PhysarumDishRequest, PhysarumDish> = {
  name: "physarum",
  builder: () => ({
    *build({ layout, seed, aspect, mark, agents }) {
      const grid = new Grid(aspect);
      const map = layout === "cities" ? cityMap(aspect) : undefined;
      const cover = seaCover(map, grid);
      const sea: SeaSampler = (u, v) => seaAt(cover, grid, u, v);
      const food = new FoodBook();
      food.reset(layout, seed, aspect, map, sea, mark);
      const seeds = dishSeeds(seed);
      yield undefined;
      const network = settledNetwork(food, aspect, sea, mark === undefined, seeds.network);
      yield undefined;
      const flakes = food.sketchNodes(grid);
      const pic = picture(network, grid);
      const sketch = stampSketch(pic, flakes, grid);
      const dist = stampDistance(pic, flakes, grid);
      if (agents === undefined)
        return { cover, network: network.state, sketch, dist, specks: undefined, film: undefined };
      yield undefined;
      const specks = seedAgents(agentShape(agents), pic, flakes, grid, seeds.rand);
      yield undefined;
      const field = new Film();
      const data = field.draw(pic, grid);
      return {
        cover,
        network: network.state,
        sketch,
        dist,
        specks,
        film: { data, lace: field.lace },
      };
    },
  }),
};
