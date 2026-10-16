import { expect, test } from "bun:test";
import { picture } from "./draw.ts";
import { Grid } from "./grid.ts";
import { FlowNetwork, type NetworkFood } from "./network.ts";

const ASPECT = 16 / 9;
/** Five flakes in a cluster on the left of the dish, the heart (id 1) among them. */
const CLUSTER: readonly NetworkFood[] = [
  { id: 1, x: 0.3, y: 0.5, strength: 1 },
  { id: 2, x: 0.38, y: 0.68, strength: 1 },
  { id: 3, x: 0.22, y: 0.7, strength: 1 },
  { id: 4, x: 0.2, y: 0.32, strength: 1 },
  { id: 5, x: 0.38, y: 0.3, strength: 1 },
];
/** A flake far out on the right: the only food past x = 0.5. */
const LEAF: NetworkFood = { id: 9, x: 0.8, y: 0.5, strength: 1 };
const HEART = 1;

/** The network over `units` of tube time as the sim runs it, handed the dish's food as it goes. */
function run(net: FlowNetwork, food: readonly NetworkFood[], units: number): void {
  for (let k = 0; k < units * 10; k++) {
    net.setFood(food, HEART);
    net.advance(0.1);
  }
}

/** Whether a vein is drawn out of the flake: one of its spokes drawn as a vein in the film. */
function veined(net: FlowNetwork, grid: Grid, id: number): boolean {
  const pic = picture(net, grid);
  const node = net.foodNode(id);
  for (let e = net.meshTubes; e < net.tubes; e++)
    if (net.ea[e] === node && pic.vein[e] === 1 && (pic.film[e] ?? 0) > 0) return true;
  return false;
}

/** The film's strongest vein lying wholly right of the cluster (screen x past 0.5). */
function filmPastCluster(net: FlowNetwork, grid: Grid): number {
  const pic = picture(net, grid);
  let strongest = 0;
  for (let e = 0; e < net.tubes; e++) {
    const a = net.ea[e] ?? 0;
    const b = net.eb[e] ?? 0;
    if (Math.min(net.xs[a] ?? 0, net.xs[b] ?? 0) > 0.5)
      strongest = Math.max(strongest, pic.film[e] ?? 0);
  }
  return strongest;
}

test("the veins to an eaten flake wither out of the film within five units of tube time (about a minute at the default evaporation), while the veins to the flakes left stay", () => {
  const grid = new Grid(ASPECT);
  for (const seed of [1, 2, 3]) {
    const net = new FlowNetwork(ASPECT, () => false, seed);
    net.setFood([...CLUSTER, LEAF], HEART);
    net.grow();
    expect(filmPastCluster(net, grid)).toBeGreaterThan(0.3);
    for (const flake of [...CLUSTER, LEAF]) expect(veined(net, grid, flake.id)).toBe(true);
    // The leaf is eaten: it is no longer on the dish.
    run(net, CLUSTER, 5);
    expect(filmPastCluster(net, grid)).toBe(0);
    // Its spokes withered too, and its slot was given up.
    expect(net.foodNode(LEAF.id)).toBe(-1);
    for (const flake of CLUSTER) expect(veined(net, grid, flake.id)).toBe(true);
  }
});

test("a flake laid far from the network has a vein joining it to the heart within two units", () => {
  const grid = new Grid(ASPECT);
  for (const seed of [1, 2, 3]) {
    const net = new FlowNetwork(ASPECT, () => false, seed);
    net.setFood(CLUSTER, HEART);
    net.grow();
    expect(filmPastCluster(net, grid)).toBe(0);
    run(net, [...CLUSTER, LEAF], 2);
    expect(veined(net, grid, LEAF.id)).toBe(true);
    const along = net.veinDistances(0.05);
    // Along the veins from the heart, the way is longer than the straight line, but not by much.
    const straight = Math.hypot((LEAF.x - 0.3) * ASPECT, 0);
    const way = along[net.foodNode(LEAF.id)] ?? Infinity;
    expect(way).toBeGreaterThan(straight);
    expect(way).toBeLessThan(1.5 * straight);
  }
});

test("a dish grows the same network every time, however the time is cut", () => {
  const grown = (cuts: number): Float64Array => {
    const net = new FlowNetwork(ASPECT, () => false, 4);
    net.setFood([...CLUSTER, LEAF], HEART);
    net.grow();
    for (let k = 0; k < cuts; k++) net.advance(3 / cuts);
    return net.conductivity;
  };
  const once = grown(1);
  expect(grown(1)).toEqual(once);
  expect(grown(30)).toEqual(once);
});
