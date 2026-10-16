import { describe, expect, test } from "bun:test";
import {
  LAND_OPEN_NEAR,
  LAND_PINE_FLAG,
  LAND_SHARED,
  LAND_USES,
  LandModel,
  type LandOptions,
  packLand,
  type SharedUse,
} from "./landuse.ts";
import {
  generateTerrain,
  packTerrain,
  type Terrain,
  TerrainBuilder,
  type TerrainOptions,
} from "./terrain.ts";

// Parcels are laid out in metres, so a small map holds as many as the scene's: the suite stays quick.
const lands = new Map<number, { terrain: Terrain; model: LandModel }>();
function land(seed: number): { terrain: Terrain; model: LandModel } {
  let built = lands.get(seed);
  if (!built) {
    const terrain = generateTerrain({ seed, size: 256 });
    built = { terrain, model: new LandModel(terrain, seed) };
    lands.set(seed, built);
  }
  return built;
}

const WOODLAND = LAND_USES.indexOf("woodland");
const PASTURE = LAND_USES.indexOf("pasture");
const options = (shares: LandOptions["shares"]): LandOptions => ({ shares, pines: 0.3, cows: 0.5 });

/** The largest gap between a use's area share and its normalised share. */
function worstShare(model: LandModel, shares: LandOptions["shares"]): number {
  const allocation = model.allocate(options(shares));
  const whole = Object.values(shares).reduce((sum, share) => sum + (share ?? 0), 0);
  let worst = 0;
  LAND_SHARED.forEach((use, u) => {
    const share = shares[use] ?? 0;
    if (share <= 0) return;
    const got = (allocation.area[u + 1] ?? 0) / allocation.total;
    worst = Math.max(worst, Math.abs(got - share / whole));
  });
  return worst;
}

/** Seeded share settings: each use on half the time, at 1..100. */
function settings(count: number, seed: number): LandOptions["shares"][] {
  let state = seed;
  const next = () => (state = (state * 16807) % 2147483647) / 2147483647;
  const out: LandOptions["shares"][] = [];
  while (out.length < count) {
    const shares: Partial<Record<SharedUse, number>> = {};
    for (const use of LAND_SHARED) if (next() < 0.5) shares[use] = 1 + Math.floor(next() * 100);
    if (Object.keys(shares).length > 0) out.push(shares);
  }
  return out;
}

describe("land use", () => {
  test("each use's area meets its normalised share within a few points", () => {
    const presets: LandOptions["shares"][] = [
      { crops: 60, woodland: 30 },
      { crops: 60, woodland: 30, pasture: 25 },
      { crops: 30, woodland: 30, pasture: 10, wildflowers: 10, lavender: 10, sunflowers: 10 },
      { crops: 50, sunflowers: 50 },
      { woodland: 40, pasture: 60 },
    ];
    // Measured (seeds 0, 3, 7, 12): settings like these within 0.04-0.085, random ones a median of
    // 0.025-0.035 and at most 0.08-0.095 (see landuse.ts on why the shares are not met exactly).
    for (const seed of [0, 3]) {
      const { model } = land(seed);
      for (const shares of presets) expect(worstShare(model, shares)).toBeLessThan(0.08);
      const gaps = settings(150, 11 + seed).map((shares) => worstShare(model, shares));
      gaps.sort((a, b) => a - b);
      expect(gaps[Math.floor(gaps.length / 2)] ?? 1).toBeLessThan(0.04);
      expect(gaps[gaps.length - 1] ?? 1).toBeLessThan(0.1);
    }
  });

  test("raising one share turns parcels only to that use; lowering it, only from it", () => {
    const { model } = land(0);
    for (const base of settings(40, 5)) {
      const before = model.allocate(options(base));
      for (const use of LAND_SHARED) {
        const index = LAND_USES.indexOf(use);
        // Up from where it is (from nothing too: switching a use on), and down to nothing.
        for (const share of [(base[use] ?? 0) + 30, (base[use] ?? 0) * 3 + 1]) {
          const after = model.allocate(options({ ...base, [use]: share }));
          for (let s = 0; s < model.count; s++) {
            if (after.use[s] !== before.use[s]) expect(after.use[s]).toBe(index);
          }
        }
        const off = model.allocate(options({ ...base, [use]: 0 }));
        for (let s = 0; s < model.count; s++) {
          if (off.use[s] !== before.use[s]) expect(before.use[s]).toBe(index);
        }
      }
    }
  });

  test("woods take the most suitable ground first and grow outward from it", () => {
    const { terrain, model } = land(0);
    const small = model.allocate(options({ crops: 90, woodland: 10 }));
    let woods = 0;
    let woodsN = 0;
    let rest = 0;
    let restN = 0;
    for (let s = 0; s < model.count; s++) {
      if ((model.area[s] ?? 0) <= 0) continue;
      const suit = terrain.parcels.wood[s] ?? 0;
      if (small.use[s] === WOODLAND) {
        woods += suit;
        woodsN++;
      } else {
        rest += suit;
        restN++;
      }
    }
    expect(woodsN).toBeGreaterThan(0);
    expect(woods / woodsN).toBeGreaterThan(rest / restN + 0.15);
    // Every wood of a smaller share stands in a larger one.
    let previous = small;
    for (const share of [20, 40, 80, 160]) {
      const next = model.allocate(options({ crops: 90, woodland: share }));
      for (let s = 0; s < model.count; s++)
        if (previous.use[s] === WOODLAND) expect(next.use[s]).toBe(WOODLAND);
      previous = next;
    }
  });

  test("no share leaves open grassland; woodland alone takes every parcel it may", () => {
    const { terrain, model } = land(0);
    const none = model.allocate(options({}));
    expect(none.use.every((use) => use === 0)).toBe(true);
    expect(none.total).toBe(0);
    expect(none.wooded).toBe(false);
    const wooded = model.allocate(options({ woodland: 100 }));
    const v = terrain.vantage;
    let open = 0;
    for (let s = 0; s < model.count; s++) {
      if ((model.area[s] ?? 0) <= 0) continue;
      const near =
        Math.hypot((terrain.parcels.x[s] ?? 0) - v.x, (terrain.parcels.z[s] ?? 0) - v.z) <
        LAND_OPEN_NEAR;
      expect(wooded.use[s]).toBe(near ? 0 : WOODLAND);
      if (near) open++;
    }
    expect(open).toBeGreaterThan(0);
  });

  test("the same terrain, seed and settings give the same land; another seed another", () => {
    const shares = { crops: 60, woodland: 30, pasture: 25, lavender: 10 };
    const a = new LandModel(generateTerrain({ seed: 4, size: 256 }), 4).allocate(options(shares));
    const b = new LandModel(generateTerrain({ seed: 4, size: 256 }), 4).allocate(options(shares));
    expect(b.use).toEqual(a.use);
    expect(b.attr).toEqual(a.attr);
    expect(land(0).model.allocate(options(shares)).use).not.toEqual(a.use);
  });

  test("the cattle share swaps only as many herds as it must, and nothing else", () => {
    const { model } = land(3);
    const shares = { crops: 60, woodland: 30, pasture: 50 };
    let previous = model.allocate({ shares, pines: 0.3, cows: 0 });
    const pastures = previous.use.filter((use) => use === PASTURE).length;
    expect(pastures).toBeGreaterThan(20);
    for (let step = 1; step <= 20; step++) {
      const cows = step / 20;
      const next = model.allocate({ shares, pines: 0.3, cows });
      let flips = 0;
      let cattle = 0;
      for (let s = 0; s < model.count; s++) {
        expect(next.use[s]).toBe(previous.use[s] ?? 0);
        if (next.use[s] !== PASTURE) continue;
        if (next.attr[s] !== previous.attr[s]) flips++;
        cattle += next.attr[s] ?? 0;
      }
      expect(cattle).toBe(Math.round(cows * pastures));
      expect(flips).toBe(Math.round(cows * pastures) - Math.round(((step - 1) / 20) * pastures));
      previous = next;
    }
  });

  test("a wood keeps its species as the woods grow", () => {
    const { model } = land(0);
    const before = model.allocate({ shares: { crops: 60, woodland: 20 }, pines: 0.4, cows: 0.5 });
    const after = model.allocate({ shares: { crops: 60, woodland: 60 }, pines: 0.4, cows: 0.5 });
    let pines = 0;
    for (let s = 0; s < model.count; s++) {
      if (before.use[s] !== WOODLAND) continue;
      expect(after.attr[s]).toBe(before.attr[s] ?? 0);
      pines += before.attr[s] ?? 0;
    }
    expect(pines).toBeGreaterThan(0);
  });

  test("the woods' canopy stands on woodland parcels only, whole where a pine wood meets a broadleaf one; hedge trees on hedges", () => {
    const { terrain, model } = land(0);
    const packed = packTerrain(terrain);
    const m = terrain.size;
    const ids = terrain.parcels.ids;
    const check = (shares: LandOptions["shares"]) => {
      const allocation = model.allocate({ shares, pines: 0.5, cows: 0.5 });
      packLand(packed, terrain, allocation);
      let canopy = 0;
      let trees = 0;
      let pines = 0;
      // Texels whose id, canopy or species is not their parcel's; pine wood beside broadleaf, and
      // of those where the canopy filtered between the two texels is not whole.
      let wrong = 0;
      let borders = 0;
      let gaps = 0;
      for (let q = 0; q < m * m; q++) {
        const id = ids[2 * q] ?? 0;
        const value = packed.cover[4 * q + 2] ?? 0;
        const high = packed.parcels[4 * q + 1] ?? 0;
        const pine = (high & LAND_PINE_FLAG) !== 0;
        if (pine) pines++;
        if ((packed.parcels[4 * q] ?? 0) + 256 * (high & ~LAND_PINE_FLAG) !== id) wrong++;
        if (value !== 0) {
          canopy++;
          const wood = allocation.use[id - 1] === WOODLAND && value > 0;
          if (!wood || pine !== (allocation.attr[id - 1] === 1)) wrong++;
        }
        const east = q + 1;
        const next = packed.cover[4 * east + 2] ?? 0;
        const nextPine = ((packed.parcels[4 * east + 1] ?? 0) & LAND_PINE_FLAG) !== 0;
        if ((q % m) + 1 < m && value >= 0.85 && next >= 0.85 && pine !== nextPine) {
          borders++;
          if (0.5 * (value + next) < 0.85) gaps++;
        }
        if ((packed.cover[4 * q + 3] ?? 0) === -1) trees++;
      }
      expect({ wrong, gaps }).toEqual({ wrong: 0, gaps: 0 });
      return { canopy, trees, borders, pines };
    };
    const wooded = check({ crops: 60, woodland: 30 });
    expect(wooded.canopy).toBeGreaterThan(0);
    expect(wooded.trees).toBeGreaterThan(0);
    expect(wooded.borders).toBeGreaterThan(0);
    // Woodland off: no woods, no pines and every lone tree felled.
    expect(check({ crops: 60 })).toEqual({ canopy: 0, trees: 0, borders: 0, pines: 0 });
    // Open grassland and woods only: no hedge stands, so only the banks keep lone trees.
    const unhedged = check({ woodland: 30 });
    expect(unhedged.trees).toBeLessThan(wooded.trees);
  });
});

// Stability under edits (the S1 review's P1), at the scene's own size and its settings there.
const STABLE = options({ crops: 60, woodland: 30, pasture: 25 });
const SEEDS = [0, 1, 2, 3] as const;
// Each seed's default build; a variant reuses its relief and river, as the scene's rebuilds do.
const scenes = new Map<number, TerrainBuilder>();
function variant(seed: number, change: Partial<TerrainOptions> = {}): Terrain {
  let base = scenes.get(seed);
  if (!base) {
    base = new TerrainBuilder({ seed, size: 512 });
    for (let i = 0; i < base.units; i++) base.unit(i);
    scenes.set(seed, base);
  }
  if (Object.keys(change).length === 0) return base.terrain;
  const built = new TerrainBuilder({ seed, size: 512, ...change }, base);
  for (let i = 0; i < built.units; i++) built.unit(i);
  return built.terrain;
}

/** Each texel's use (its parcel's) under the land model at STABLE. */
function texelUses(t: Terrain, seed: number): Uint8Array {
  const use = new LandModel(t, seed).allocate(STABLE).use;
  const m = t.size;
  const out = new Uint8Array(m * m);
  for (let q = 0; q < m * m; q++) {
    const id = t.parcels.ids[2 * q] ?? 0;
    out[q] = id > 0 ? (use[id - 1] ?? 0) : 0;
  }
  return out;
}

/** The way points (x, z, x, z, ..) of a and b, or (`moved`) those only one of them lays. */
function wayPoints(a: Terrain, b: Terrain, moved: boolean): number[] {
  const keys = (t: Terrain) => {
    const out = new Set<string>();
    for (const road of t.roads)
      for (let k = 0; k < road.x.length; k++) out.add(`${road.x[k]},${road.z[k]}`);
    return out;
  };
  const inA = keys(a);
  const inB = keys(b);
  const points: number[] = [];
  for (const t of [a, b])
    for (const road of t.roads)
      for (let k = 0; k < road.x.length; k++) {
        const key = `${road.x[k]},${road.z[k]}`;
        if (!moved || !inA.has(key) || !inB.has(key)) points.push(road.x[k] ?? 0, road.z[k] ?? 0);
      }
  return points;
}

function nearest(points: readonly number[], x: number, z: number): number {
  let d = Infinity;
  for (let k = 0; k < points.length; k += 2)
    d = Math.min(d, Math.hypot((points[k] ?? 0) - x, (points[k + 1] ?? 0) - z));
  return d;
}

describe("land use, stable under edits", () => {
  test("a settlement switched, added or grown changes no land far from it but beside the ways it moves", () => {
    for (const seed of SEEDS) {
      const base = variant(seed);
      const uses = texelUses(base, seed);
      const m = base.size;
      const site = (kind: string, k: number) => base.candidates.filter((c) => c.kind === kind)[k];
      for (const [change, at] of [
        [{ castle: false }, site("castle", 0)],
        [{ hamlets: 3 }, site("hamlet", 2)],
        [{ farms: 4 }, site("farm", 3)],
        [{ village: 30 }, site("village", 0)],
      ] as const) {
        if (!at) throw new Error(`seed ${seed}: no site for ${JSON.stringify(change)}`);
        const t = variant(seed, change);
        const after = texelUses(t, seed);
        const moved = wayPoints(base, t, true);
        // A parcel a moved way passes within 64 m of (the reach the roads re-weigh) may turn whole.
        const beside = new Map<string, boolean>();
        const reached = (built: Terrain, id: number): boolean => {
          const key = `${built === base ? "a" : "b"}${id}`;
          let near = beside.get(key);
          if (near === undefined) {
            near = false;
            for (let q = 0; q < m * m && !near; q++)
              if ((built.parcels.ids[2 * q] ?? 0) === id)
                near =
                  nearest(
                    moved,
                    ((q % m) + 0.5) * built.cell,
                    (Math.floor(q / m) + 0.5) * built.cell,
                  ) <= 64;
            beside.set(key, near);
          }
          return near;
        };
        let changed = 0;
        let stray = 0;
        for (let q = 0; q < m * m; q++) {
          if (uses[q] === after[q]) continue;
          changed++;
          const x = ((q % m) + 0.5) * base.cell;
          const z = (Math.floor(q / m) + 0.5) * base.cell;
          if (Math.hypot(x - at.x, z - at.z) <= 500) continue;
          if (nearest(moved, x, z) <= 150) continue;
          if (reached(base, base.parcels.ids[2 * q] ?? 0) || reached(t, t.parcels.ids[2 * q] ?? 0))
            continue;
          stray++;
        }
        // The village grows by cottages and yards alone: nothing beyond 500 m of it changes.
        if ("village" in change) expect(moved.length).toBe(0);
        expect({ seed, change, stray }).toEqual({ seed, change, stray: 0 });
        // Measured: at most 1.6% of the texels change (up to 30% before the land model read the
        // candidate sites and the bare land).
        expect(changed).toBeLessThan(0.03 * m * m);
      }
    }
  }, 120_000);

  test("switching the roads or the tracks changes no land beyond 150 m of every way", () => {
    for (const seed of SEEDS) {
      const base = variant(seed);
      const uses = texelUses(base, seed);
      const m = base.size;
      for (const change of [{ roads: false }, { tracks: false }]) {
        const t = variant(seed, change);
        const after = texelUses(t, seed);
        const ways = wayPoints(base, t, false);
        let stray = 0;
        for (let q = 0; q < m * m; q++) {
          if (uses[q] === after[q]) continue;
          const x = ((q % m) + 0.5) * base.cell;
          const z = (Math.floor(q / m) + 0.5) * base.cell;
          if (nearest(ways, x, z) > 150) stray++;
        }
        expect({ seed, change, stray }).toEqual({ seed, change, stray: 0 });
      }
    }
  }, 120_000);

  test("a change of the river's size moves no settlement, and the land it changes lies by the river", () => {
    for (const seed of SEEDS) {
      const base = variant(seed);
      const t = variant(seed, { river: 0.55 });
      expect(t.candidates.map(({ x, z }) => [x, z])).toEqual(
        base.candidates.map(({ x, z }) => [x, z]),
      );
      const uses = texelUses(base, seed);
      const after = texelUses(t, seed);
      const m = base.size;
      // Either river's centreline (every other point: 12.5 m apart).
      const river: number[] = [];
      for (const built of [base, t])
        for (let k = 0; k < built.river.x.length; k += 2)
          river.push(built.river.x[k] ?? 0, built.river.z[k] ?? 0);
      let dry = 0;
      let far = 0;
      for (let q = 0; q < m * m; q++) {
        if ((base.level[q] ?? 0) > (base.ground[q] ?? 0)) continue;
        dry++;
        if (uses[q] === after[q]) continue;
        const x = ((q % m) + 0.5) * base.cell;
        const z = (Math.floor(q / m) + 0.5) * base.cell;
        if (nearest(river, x, z) > 400) far++;
      }
      // Measured: 0-0.28% of the dry land beyond 400 m of the river changes, a few parcels whose
      // bids were all but tied, nudged by the ranks the riverside parcels share with them (14-19%
      // while the settlements were weighed against the carved river and every parcel's draws were
      // keyed by its index).
      expect({ seed, far: far < 0.005 * dry }).toEqual({ seed, far: true });
    }
  }, 120_000);
});
