import { describe, expect, test } from "bun:test";
import { runBudgeted } from "./clock.ts";
import {
  generateTerrain,
  packTerrain,
  sampleGrid,
  type Terrain,
  TERRAIN_ROAD_MAX_SLOPE,
  TERRAIN_BASES,
  TerrainBuilder,
  terrainWays,
} from "./terrain.ts";

// Small maps keep the suite quick; the budget test builds the scene's own size.
const builds = new Map<number, Terrain>();
function built(seed: number): Terrain {
  let t = builds.get(seed);
  if (!t) {
    t = generateTerrain({ seed, size: 256 });
    builds.set(seed, t);
  }
  return t;
}

describe("terrain", () => {
  test("the river lies level across its channel and never rises downstream", () => {
    for (const seed of [0, 1, 2, 3]) {
      const t = built(seed);
      const { x, z, level, width } = t.river;
      expect(x.length).toBeGreaterThan(50);
      for (let k = 1; k < level.length; k++) {
        expect(level[k] ?? 0).toBeLessThanOrEqual(level[k - 1] ?? 0);
      }
      let checked = 0;
      for (let k = 6; k + 6 < x.length; k += 9) {
        const px = x[k] ?? 0;
        const pz = z[k] ?? 0;
        if (px < 40 || pz < 40 || px > t.extent - 40 || pz > t.extent - 40) continue;
        const tx = (x[k + 3] ?? 0) - (x[k - 3] ?? 0);
        const tz = (z[k + 3] ?? 0) - (z[k - 3] ?? 0);
        const tl = Math.hypot(tx, tz);
        const half = 0.5 * (width[k] ?? 0);
        // Level across to a quarter metre (texels a channel's width apart meet different feet on a
        // bend), plus what the river drops over the stretch sampled; torrents steeper than 1 in 40
        // (where it comes down off the hills at the map's edge) drop more than that across a texel.
        const drop = Math.abs((level[k - 6] ?? 0) - (level[k + 6] ?? 0));
        if (drop > (12 * t.cell) / 40) continue;
        const slack = 0.25 + drop;
        for (const f of [-0.6, -0.3, 0, 0.3, 0.6]) {
          const qx = px - (tz / tl) * f * half;
          const qz = pz + (tx / tl) * f * half;
          const surface = sampleGrid(t.level, t.size, t.extent, qx, qz);
          expect(Math.abs(surface - (level[k] ?? 0))).toBeLessThanOrEqual(slack);
          expect(surface).toBeGreaterThan(sampleGrid(t.ground, t.size, t.extent, qx, qz));
        }
        checked++;
      }
      expect(checked).toBeGreaterThan(5);
    }
  });

  test("the roads join every settlement into one network, over the bridge where they cross", () => {
    for (const seed of [0, 1, 2, 3]) {
      const t = built(seed);
      expect(t.settlements.some((s) => s.kind === "village")).toBe(true);
      const parent = t.settlements.map((_, i) => i);
      const find = (i: number): number => {
        let r = i;
        while (parent[r] !== r) r = parent[r] ?? r;
        return r;
      };
      for (const road of t.roads) {
        if (road.from < 0 || road.to < 0) continue;
        parent[find(road.from)] = find(road.to);
        // Each end is at its settlement.
        for (const [end, k] of [
          [road.from, 0],
          [road.to, road.x.length - 1],
        ] as const) {
          const s = t.settlements[end];
          expect(
            Math.hypot((road.x[k] ?? 0) - (s?.x ?? 0), (road.z[k] ?? 0) - (s?.z ?? 0)),
          ).toBeLessThan(1);
        }
      }
      const roots = new Set(t.settlements.map((_, i) => find(i)));
      expect(roots.size).toBe(1);
      const crossing = t.settlements.some((s) => s.bank !== t.settlements[0]?.bank);
      if (crossing) {
        expect(t.bridge).toBeDefined();
        expect(t.roads.some((road) => road.bridgeStart >= 0)).toBe(true);
      }
    }
  });

  test("no stretch of road is steeper than the limit, and the ground is cut to it", () => {
    for (const seed of [0, 1, 2]) {
      const t = built(seed);
      for (const road of t.roads) {
        for (let k = 1; k < road.y.length; k++) {
          const run = Math.hypot(
            (road.x[k] ?? 0) - (road.x[k - 1] ?? 0),
            (road.z[k] ?? 0) - (road.z[k - 1] ?? 0),
          );
          const rise = Math.abs((road.y[k] ?? 0) - (road.y[k - 1] ?? 0));
          expect(rise).toBeLessThanOrEqual(TERRAIN_ROAD_MAX_SLOPE * Math.max(run, 4) + 1e-3);
        }
        // Off the bridge and away from buildings' terraces the bed follows the profile.
        let near = 0;
        let count = 0;
        for (let k = 0; k < road.x.length; k += 5) {
          if (road.bridgeStart >= 0 && k >= road.bridgeStart && k <= road.bridgeEnd) continue;
          const g = sampleGrid(t.ground, t.size, t.extent, road.x[k] ?? 0, road.z[k] ?? 0);
          if (Math.abs(g - (road.y[k] ?? 0)) < 1.5) near++;
          count++;
        }
        expect(near / Math.max(count, 1)).toBeGreaterThan(0.85);
      }
    }
  });

  test("every base relief builds a level river, every settlement on a road, a bridge over water", () => {
    for (const base of TERRAIN_BASES) {
      const t = generateTerrain({ seed: 2, size: 256, base });
      const { level } = t.river;
      for (let k = 1; k < level.length; k++)
        expect(level[k] ?? 0).toBeLessThanOrEqual(level[k - 1] ?? 0);
      // Every settlement is the end of some road or track.
      t.settlements.forEach((_, index) => {
        expect(t.roads.some((road) => road.from === index || road.to === index)).toBe(true);
      });
      const b = t.bridge;
      if (b) {
        const at = (f: number, of: Float32Array) =>
          sampleGrid(of, t.size, t.extent, b.x0 + (b.x1 - b.x0) * f, b.z0 + (b.z1 - b.z0) * f);
        // Water under its middle, dry land at both ends, the deck over the water.
        expect(at(0.5, t.level)).toBeGreaterThan(at(0.5, t.ground));
        expect(at(0, t.level)).toBeLessThan(at(0, t.ground));
        expect(at(1, t.level)).toBeLessThan(at(1, t.ground));
        expect(Math.min(b.deck0, b.deck1)).toBeGreaterThan(b.water + 1);
      }
      if (base === "coast") {
        // The sea: water at sea level along the map's edge somewhere.
        let sea = 0;
        for (let q = 0; q < t.size; q++) {
          if ((t.level[q] ?? -1) === 0 && (t.ground[q] ?? 0) < 0) sea++;
          const r = q * t.size;
          if ((t.level[r] ?? -1) === 0 && (t.ground[r] ?? 0) < 0) sea++;
        }
        expect(sea).toBeGreaterThan(0);
      }
    }
  });

  test("the roads' way points lie on their roads, evenly spaced, ends kept", () => {
    // At the scene's size: a coarser map's roads kink sharply enough for an 8 m chord to cut them.
    for (const seed of [0, 3]) {
      const t = generateTerrain({ seed, size: 512 });
      const { ways, points } = terrainWays(t);
      expect(ways.length).toBe(t.roads.length);
      ways.forEach((way, index) => {
        const road = t.roads[index];
        if (!road) throw new Error("no road");
        for (let k = 0; k < way.count; k++) {
          const px = points[3 * (way.first + k)] ?? 0;
          const pz = points[3 * (way.first + k) + 2] ?? 0;
          // The point and the middle of the chord to the next lie on the road (within its half width).
          for (const f of k + 1 < way.count ? [0, 0.5] : [0]) {
            const qx = px + f * ((points[3 * (way.first + k + 1)] ?? 0) - px);
            const qz = pz + f * ((points[3 * (way.first + k + 1) + 2] ?? 0) - pz);
            let near = Infinity;
            for (let s = 0; s + 1 < road.x.length; s++) {
              const ax = road.x[s] ?? 0;
              const az = road.z[s] ?? 0;
              const dx = (road.x[s + 1] ?? 0) - ax;
              const dz = (road.z[s + 1] ?? 0) - az;
              const u = Math.max(
                0,
                Math.min(1, ((qx - ax) * dx + (qz - az) * dz) / (dx * dx + dz * dz || 1)),
              );
              near = Math.min(near, Math.hypot(qx - ax - u * dx, qz - az - u * dz));
            }
            expect(near).toBeLessThan(road.halfWidth);
          }
          if (k > 0) {
            const run = Math.hypot(
              px - (points[3 * (way.first + k - 1)] ?? 0),
              pz - (points[3 * (way.first + k - 1) + 2] ?? 0),
            );
            expect(run).toBeLessThanOrEqual(way.spacing + 1e-3);
          }
        }
        expect(points[3 * way.first] ?? 0).toBeCloseTo(road.x[0] ?? 0, 3);
        expect(points[3 * (way.first + way.count - 1)] ?? 0).toBeCloseTo(
          road.x[road.x.length - 1] ?? 0,
          3,
        );
      });
    }
  });

  test("each parcel's clear core lies inside it, by the exact stretched metric, off roads and water", () => {
    const t = built(0);
    const p = t.parcels;
    const owner = (x: number, z: number): number => {
      let best = Infinity;
      let id = -1;
      for (let s = 0; s < p.count; s++) {
        const dx = x - (p.x[s] ?? 0);
        const dz = z - (p.z[s] ?? 0);
        const a = p.angle[s] ?? 0;
        const u = (dx * Math.cos(a) + dz * Math.sin(a)) / (p.elongation[s] ?? 1);
        const w = -dx * Math.sin(a) + dz * Math.cos(a);
        const d = Math.hypot(u, w);
        if (d < best) {
          best = d;
          id = s;
        }
      }
      return id;
    };
    let cores = 0;
    for (let s = 0; s < p.count; s++) {
      const r = p.coreRadius[s] ?? 0;
      if (r <= 0) continue;
      cores++;
      const cx = p.coreX[s] ?? 0;
      const cz = p.coreZ[s] ?? 0;
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * 2 * Math.PI;
        for (const f of [0, 0.5, 1]) {
          const x = cx + f * r * Math.cos(a);
          const z = cz + f * r * Math.sin(a);
          expect(owner(x, z)).toBe(s);
          expect(sampleGrid(t.road, t.size, t.extent, x, z)).toBeGreaterThan(0);
          expect(sampleGrid(t.level, t.size, t.extent, x, z)).toBeLessThan(
            sampleGrid(t.ground, t.size, t.extent, x, z),
          );
        }
      }
    }
    expect(cores).toBeGreaterThan(0.5 * p.count);
  });
  test("a seed always builds the same valley, and another seed another", () => {
    const a = generateTerrain({ seed: 7, size: 128 });
    const b = generateTerrain({ seed: 7, size: 128 });
    const c = generateTerrain({ seed: 8, size: 128 });
    const pa = packTerrain(a);
    const pb = packTerrain(b);
    expect(pb.ground).toEqual(pa.ground);
    expect(pb.cover).toEqual(pa.cover);
    expect(pb.parcels).toEqual(pa.parcels);
    expect(pb.records).toEqual(pa.records);
    expect(packTerrain(c).ground).not.toEqual(pa.ground);
    // Reusing an eroded relief (a river change) builds what a fresh build does; so does reusing the
    // carved river too (a settlements and roads change), skipping its stages.
    const first = new TerrainBuilder({ seed: 7, size: 128 });
    for (let i = 0; i < first.units; i++) first.unit(i);
    const reused = new TerrainBuilder({ seed: 7, size: 128, river: 0.9 }, first);
    for (let i = 0; i < reused.units; i++) reused.unit(i);
    const fresh = generateTerrain({ seed: 7, size: 128, river: 0.9 });
    expect(packTerrain(reused.terrain).ground).toEqual(packTerrain(fresh).ground);
    const settled = new TerrainBuilder({ seed: 7, size: 128, river: 0.9, village: 20 }, reused);
    for (let i = 0; i < settled.units; i++) settled.unit(i);
    const again = packTerrain(generateTerrain({ seed: 7, size: 128, river: 0.9, village: 20 }));
    const kept = packTerrain(settled.terrain);
    expect(kept.ground).toEqual(again.ground);
    expect(kept.records).toEqual(again.records);
    expect(settled.terrain.timings.river ?? 0).toBeLessThan(reused.terrain.timings.river ?? 0);
  });

  test("the village grows outward from its church: a larger one keeps every cottage of a smaller", () => {
    const cottages = (village: number): string[] => {
      const t = generateTerrain({ seed: 1, size: 256, village });
      const at = t.settlements.findIndex((s) => s.kind === "village");
      const place = t.settlements[at];
      if (!place) throw new Error("no village");
      return t.buildings
        .slice(place.first, place.first + place.count)
        .filter((b) => b.kind === "cottage")
        .map((b) => `${b.x.toFixed(3)},${b.z.toFixed(3)},${b.facing.toFixed(4)}`);
    };
    let smaller = cottages(4);
    expect(smaller.length).toBe(4);
    for (const village of [11, 20, 30]) {
      const larger = cottages(village);
      expect(larger.length).toBe(village);
      for (const cottage of smaller) expect(larger).toContain(cottage);
      smaller = larger;
    }
  });

  test("a settlement switched on, off or added moves none of the others", () => {
    const sites = (options: Parameters<typeof generateTerrain>[0]): string[] =>
      generateTerrain(options).settlements.map(
        (s) => `${s.kind} ${s.x.toFixed(2)},${s.z.toFixed(2)}`,
      );
    const all = sites({ seed: 2, size: 256, hamlets: 3, farms: 8 });
    for (const options of [
      { castle: false },
      { village: 0 },
      { hamlets: 1 },
      { farms: 2 },
      { roads: false, tracks: false },
    ]) {
      for (const site of sites({ seed: 2, size: 256, hamlets: 3, farms: 8, ...options }))
        expect(all).toContain(site);
    }
    const none = generateTerrain({ seed: 2, size: 256, roads: false, tracks: false });
    expect(none.roads.length).toBe(0);
    expect(none.bridge).toBeUndefined();
    const tracks = generateTerrain({ seed: 2, size: 256, roads: false });
    expect(tracks.roads.length).toBeGreaterThan(0);
    expect(tracks.roads.every((road) => road.kind === "track")).toBe(true);
  });

  test("a build at the scene's size stays within its budget, unit by unit", () => {
    const builder = new TerrainBuilder({ seed: 4, size: 512 });
    const started = performance.now();
    let longest = 0;
    let next = 0;
    let frames = 0;
    while (next < builder.units) {
      const frame = performance.now();
      next = runBudgeted((i) => builder.unit(i), 8, builder.units, next);
      longest = Math.max(longest, performance.now() - frame);
      frames++;
    }
    const total = performance.now() - started;
    // About a second on a laptop; generous for a loaded CI machine.
    expect(total).toBeLessThan(6000);
    // No frame blocks for long: a frame runs at most one unit past its 8 ms.
    expect(longest).toBeLessThan(400);
    expect(frames).toBeGreaterThan(10);
    expect(builder.terrain.timings.erosion).toBeGreaterThan(0);
  });
});
