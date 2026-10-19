import { describe, expect, test } from "bun:test";
import {
  LAND_FELLED,
  LAND_PINE_FLAG,
  LAND_SHARED,
  LAND_USES,
  landCanopy,
  LandModel,
  type LandOptions,
  landTexels,
  landWoodLine,
  openLand,
  packLand,
  repackLand,
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

/** The largest gap between a use's area share and its normalised share, and the woods' gap. */
function shareGaps(
  model: LandModel,
  shares: LandOptions["shares"],
): { worst: number; woods: number } {
  const allocation = model.allocate(options(shares));
  const whole = Object.values(shares).reduce((sum, share) => sum + (share ?? 0), 0);
  let worst = 0;
  let woods = 0;
  LAND_SHARED.forEach((use, u) => {
    const share = shares[use] ?? 0;
    if (share <= 0) return;
    const gap = Math.abs((allocation.area[u + 1] ?? 0) / allocation.total - share / whole);
    worst = Math.max(worst, gap);
    if (use === "woodland") woods = gap;
  });
  return { worst, woods };
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
  test("each use's area meets its normalised share within a few points, the woods' within one", () => {
    const presets: LandOptions["shares"][] = [
      { crops: 60, woodland: 30 },
      { crops: 60, woodland: 30, pasture: 25 },
      { crops: 30, woodland: 30, pasture: 10, wildflowers: 10, lavender: 10, sunflowers: 10 },
      { crops: 50, sunflowers: 50 },
      { woodland: 40, pasture: 60 },
    ];
    // Measured (seeds 0, 3, 7, 12): the woods within 0.009 of their share in every setting;
    // settings like these within 0.04-0.06, random ones a median of 0.027-0.029 and at most
    // 0.09-0.12 (see landuse.ts on why the shares are not met exactly). The woods take the ground
    // cleared last, the steep, high and far ground lavender and the wildflowers like too, and leave
    // the flat, low ground crops like best: the bias the woods shared while woodland bid in the
    // race beside the fields (at most 0.08-0.095 then) falls on the fields alone.
    for (const seed of [0, 3]) {
      const { model } = land(seed);
      for (const shares of presets) expect(shareGaps(model, shares).worst).toBeLessThan(0.07);
      const random = settings(150, 11 + seed).map((shares) => shareGaps(model, shares));
      for (const { woods } of random) expect(woods).toBeLessThan(0.012);
      const gaps = random.map(({ worst }) => worst).sort((a, b) => a - b);
      expect(gaps[Math.floor(gaps.length / 2)] ?? 1).toBeLessThan(0.04);
      expect(gaps[gaps.length - 1] ?? 1).toBeLessThan(0.13);
    }
  });

  test("raising one share turns parcels only to that use, or out of the woods it shrinks; lowering it, only from it, or into them", () => {
    const { model } = land(0);
    for (const base of settings(40, 5)) {
      const before = model.allocate(options(base));
      for (const use of LAND_SHARED) {
        const index = LAND_USES.indexOf(use);
        // Up from where it is (from nothing too: switching a use on), and down to nothing. Another
        // share's rise lowers woodland's share of the whole: its woods only recede.
        for (const share of [(base[use] ?? 0) + 30, (base[use] ?? 0) * 3 + 1]) {
          const after = model.allocate(options({ ...base, [use]: share }));
          for (let s = 0; s < model.count; s++) {
            if (after.use[s] === before.use[s]) continue;
            if (use === "woodland") expect(after.use[s]).toBe(WOODLAND);
            else if (after.use[s] !== index) expect(before.use[s]).toBe(WOODLAND);
          }
          if (use === "woodland") expect(after.line).toBeLessThanOrEqual(before.line);
          else expect(after.line).toBeGreaterThanOrEqual(before.line);
        }
        const off = model.allocate(options({ ...base, [use]: 0 }));
        for (let s = 0; s < model.count; s++) {
          if (off.use[s] === before.use[s]) continue;
          if (before.use[s] !== index) expect(off.use[s]).toBe(WOODLAND);
        }
      }
    }
  });

  test("the woods grow outward as their share rises, never by whole parcels, and cover their share", () => {
    const { terrain, model } = land(0);
    const m = terrain.size;
    let previous = model.allocate(options({ crops: 90, woodland: 10 }));
    for (const share of [20, 40, 80, 160]) {
      const next = model.allocate(options({ crops: 90, woodland: share }));
      // A lower line: every texel the woods stood on they still stand on.
      expect(next.line).toBeLessThan(previous.line);
      for (let s = 0; s < model.count; s++)
        if (previous.use[s] === WOODLAND) expect(next.use[s]).toBe(WOODLAND);
      previous = next;
    }
    // Woodland's share of the clear ground, texel by texel, meets woodland / Σ shares closely.
    for (const shares of [
      { crops: 60, woodland: 30 },
      { crops: 30, woodland: 60, pasture: 30 },
    ]) {
      const { line } = model.allocate(options(shares));
      let clear = 0;
      let woods = 0;
      for (let q = 0; q < m * m; q++) {
        if ((terrain.level[q] ?? 0) > (terrain.ground[q] ?? 0) - 0.3) continue;
        if ((terrain.road[q] ?? 64) < 0 || (terrain.yard[q] ?? 0) > 0.3) continue;
        clear++;
        woods += landCanopy(terrain.clearance[q] ?? 0, line);
      }
      const whole = Object.values(shares).reduce((sum, share) => sum + share, 0);
      expect(Math.abs(woods / clear - shares.woodland / whole)).toBeLessThan(0.03);
    }
    // Woods reach into fields: some field parcels hold a wooded corner.
    const mixed = model.allocate(options({ crops: 60, woodland: 30 }));
    let assarts = 0;
    for (let s = 0; s < model.count; s++)
      if (mixed.use[s] !== WOODLAND && (mixed.canopy[s] ?? 0) > 0.1) assarts++;
    expect(assarts).toBeGreaterThan(10);
  });

  test("no share leaves open grassland; woodland alone takes all the land, the vantage's slopes too", () => {
    const { model } = land(0);
    const none = model.allocate(options({}));
    expect(none.use.every((use) => use === 0)).toBe(true);
    expect(none.total).toBe(0);
    expect(none.wooded).toBe(false);
    const wooded = model.allocate(options({ woodland: 100 }));
    for (let s = 0; s < model.count; s++)
      if ((model.area[s] ?? 0) > 0) expect(wooded.use[s]).toBe(WOODLAND);
  });

  test("the same terrain, seed and settings give the same land; another seed another", () => {
    const shares = { crops: 60, woodland: 30, pasture: 25, lavender: 10 };
    const a = new LandModel(generateTerrain({ seed: 4, size: 256 }), 4).allocate(options(shares));
    const b = new LandModel(generateTerrain({ seed: 4, size: 256 }), 4).allocate(options(shares));
    expect(b.use).toEqual(a.use);
    expect(b.attr).toEqual(a.attr);
    expect(b.line).toBe(a.line);
    expect(land(0).model.allocate(options(shares)).use).not.toEqual(a.use);
  });

  test("the cattle share turns only sheep to cattle as it rises, and nothing else", () => {
    const { model } = land(3);
    const shares = { crops: 60, woodland: 30, pasture: 50 };
    let previous = model.allocate({ shares, pines: 0.3, cows: 0 });
    expect(previous.use.filter((use) => use === PASTURE).length).toBeGreaterThan(20);
    for (let step = 1; step <= 20; step++) {
      const next = model.allocate({ shares, pines: 0.3, cows: step / 20 });
      for (let s = 0; s < model.count; s++) {
        expect(next.use[s]).toBe(previous.use[s] ?? 0);
        if (next.use[s] === PASTURE && next.attr[s] !== previous.attr[s])
          expect(next.attr[s]).toBe(1);
      }
      previous = next;
    }
    expect(previous.attr.every((attr, s) => previous.use[s] !== PASTURE || attr === 1)).toBe(true);
  });

  test("a share step keeps every pasture that stays a pasture grazed by the same kind", () => {
    // The cattle share is a share of the grazing land, by a fixed rank: a pasture's herd does not
    // hang on how many pastures there are (round(cows · pastures) flipped 1-7 far ones a step).
    for (const seed of [0, 3]) {
      const { model } = land(seed);
      const base = { crops: 60, woodland: 30, pasture: 25 };
      const before = model.allocate({ shares: base, pines: 0.25, cows: 0.3 });
      for (const step of [{ pasture: 30 }, { woodland: 40 }, { crops: 50 }]) {
        const after = model.allocate({ shares: { ...base, ...step }, pines: 0.25, cows: 0.3 });
        for (let s = 0; s < model.count; s++)
          if (before.use[s] === PASTURE && after.use[s] === PASTURE)
            expect(after.attr[s]).toBe(before.attr[s] ?? 0);
      }
    }
  });

  test("a wood keeps its species as the woods grow", () => {
    const { model } = land(0);
    const before = model.allocate({ shares: { crops: 60, woodland: 20 }, pines: 0.4, cows: 0.5 });
    const after = model.allocate({ shares: { crops: 60, woodland: 60 }, pines: 0.4, cows: 0.5 });
    expect(after.pine).toEqual(before.pine);
    let pines = 0;
    for (let s = 0; s < model.count; s++) {
      if (before.use[s] !== WOODLAND) continue;
      expect(after.attr[s]).toBe(before.attr[s] ?? 0);
      pines += before.attr[s] ?? 0;
    }
    expect(pines).toBeGreaterThan(0);
  });

  test("packing writes the clearance, felled on opened parcels, each parcel's species and the hedge trees", () => {
    const { terrain, model } = land(0);
    const packed = packTerrain(terrain);
    const m = terrain.size;
    const ids = terrain.parcels.ids;
    const check = (shares: LandOptions["shares"], opened: readonly number[] = []) => {
      const allocation = model.allocate({ shares, pines: 0.5, cows: 0.5 });
      openLand(allocation, model, opened);
      packLand(packed, terrain, allocation);
      expect(landWoodLine(packed)).toBe(allocation.line);
      let trees = 0;
      let pines = 0;
      // Texels whose id, clearance or species is not their parcel's.
      let wrong = 0;
      for (let q = 0; q < m * m; q++) {
        const id = ids[2 * q] ?? 0;
        const high = packed.parcels[4 * q + 1] ?? 0;
        const pine = (high & LAND_PINE_FLAG) !== 0;
        if (pine) pines++;
        if ((packed.parcels[4 * q] ?? 0) + 256 * (high & ~LAND_PINE_FLAG) !== id) wrong++;
        const felled = id > 0 && opened.includes(id - 1);
        const clearance = felled ? LAND_FELLED : (terrain.clearance[q] ?? 0);
        if (packed.cover[4 * q + 2] !== clearance) wrong++;
        if (id > 0 && pine !== (allocation.pine[id - 1] === 1)) wrong++;
        if ((packed.cover[4 * q + 3] ?? 0) === -1) trees++;
      }
      expect(wrong).toBe(0);
      return { trees, pines };
    };
    const wooded = check({ crops: 60, woodland: 30 }, [0, 1, 2]);
    expect(wooded.trees).toBeGreaterThan(0);
    expect(wooded.pines).toBeGreaterThan(0);
    // Woodland off: no species and every lone tree felled.
    expect(check({ crops: 60 })).toEqual({ trees: 0, pines: 0 });
    // Open grassland and woods only: no hedge stands, so only the banks keep lone trees.
    expect(check({ woodland: 30 }).trees).toBeLessThan(wooded.trees);
  });

  test("repacking only the changed parcels writes exactly what packing the whole land does", () => {
    const { terrain, model } = land(1);
    const texels = landTexels(terrain);
    const m = terrain.size;
    const steps: LandOptions[] = [
      { shares: { crops: 60, woodland: 30 }, pines: 0.25, cows: 0.5 },
      { shares: { crops: 61, woodland: 30 }, pines: 0.25, cows: 0.5 },
      { shares: { crops: 61, woodland: 45, pasture: 25 }, pines: 0.25, cows: 0.5 },
      // The herds alone: no clearance, lone tree or species moves.
      { shares: { crops: 61, woodland: 45, pasture: 25 }, pines: 0.25, cows: 0.1 },
      { shares: { crops: 61, woodland: 45, pasture: 25 }, pines: 0.6, cows: 0.1 },
      // Woodland off and on again: every lone tree falls and stands again.
      { shares: { crops: 61, pasture: 25 }, pines: 0.6, cows: 0.1 },
      { shares: { woodland: 30, lavender: 20, sunflowers: 20 }, pines: 0.6, cows: 0.1 },
      { shares: { woodland: 30, lavender: 20, sunflowers: 20 }, pines: 0.6, cows: 0.1 },
    ];
    const [first, ...rest] = steps;
    if (!first) throw new Error("no settings");
    const repacked = packTerrain(terrain);
    let before = model.allocate(first);
    packLand(repacked, terrain, before);
    const covered: (readonly [number, number] | undefined)[] = [];
    const flagged: (readonly [number, number] | undefined)[] = [];
    for (const step of rest) {
      const allocation = model.allocate(step);
      const was = { cover: repacked.cover.slice(), parcels: repacked.parcels.slice() };
      const rows = repackLand(repacked, terrain, allocation, before, texels);
      before = allocation;
      covered.push(rows.cover);
      flagged.push(rows.parcels);
      const packed = packTerrain(terrain);
      packLand(packed, terrain, allocation);
      expect(Buffer.from(repacked.cover.buffer).equals(Buffer.from(packed.cover.buffer))).toBe(
        true,
      );
      expect(Buffer.from(repacked.records.buffer).equals(Buffer.from(packed.records.buffer))).toBe(
        true,
      );
      expect(Buffer.from(repacked.parcels.buffer).equals(Buffer.from(packed.parcels.buffer))).toBe(
        true,
      );
      // The rows reported, per texture, are exactly those whose bytes changed.
      const changed = (
        a: ArrayLike<number>,
        b: ArrayLike<number>,
      ): readonly [number, number] | undefined => {
        let low = m;
        let high = -1;
        for (let k = 0; k < a.length; k++) {
          if (a[k] === b[k]) continue;
          low = Math.min(low, Math.floor(k / (4 * m)));
          high = Math.max(high, Math.floor(k / (4 * m)));
        }
        return high < 0 ? undefined : [low, high];
      };
      expect(rows.cover).toEqual(changed(was.cover, repacked.cover));
      expect(rows.parcels).toEqual(changed(was.parcels, repacked.parcels));
    }
    // The same settings again, and the herds alone, change no texel; the pine mix and woodland off
    // and on again flip species.
    expect(covered.at(-1)).toBeUndefined();
    expect(covered[2]).toBeUndefined();
    expect(flagged[2]).toBeUndefined();
    expect(flagged[3]).toBeDefined();
    expect(flagged[4]).toBeDefined();
    expect(flagged[5]).toBeDefined();
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

/** Each texel's use under the land model at STABLE: woodland where the woods stand, else its parcel's. */
function texelUses(t: Terrain, seed: number): Uint8Array {
  const { use, line } = new LandModel(t, seed).allocate(STABLE);
  const m = t.size;
  const out = new Uint8Array(m * m);
  for (let q = 0; q < m * m; q++) {
    const id = t.parcels.ids[2 * q] ?? 0;
    if (landCanopy(t.clearance[q] ?? 0, line) > 0.5) out[q] = WOODLAND;
    else out[q] = id > 0 ? (use[id - 1] ?? 0) : 0;
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

/**
 * Whether texel q's parcel, in build a or b, is one a way only one of them lays (`moved`:
 * wayPoints(a, b, true)) passes within 64 m of: the reach the roads re-weigh, so it may turn whole.
 */
function reachedBy(a: Terrain, b: Terrain, moved: readonly number[]): (q: number) => boolean {
  const m = a.size;
  const beside = new Map<string, boolean>();
  const reached = (built: Terrain, id: number): boolean => {
    const key = `${built === a ? "a" : "b"}${id}`;
    let near = beside.get(key);
    if (near === undefined) {
      near = false;
      for (let q = 0; q < m * m && !near; q++)
        if ((built.parcels.ids[2 * q] ?? 0) === id)
          near =
            nearest(moved, ((q % m) + 0.5) * built.cell, (Math.floor(q / m) + 0.5) * built.cell) <=
            64;
      beside.set(key, near);
    }
    return near;
  };
  return (q) => reached(a, a.parcels.ids[2 * q] ?? 0) || reached(b, b.parcels.ids[2 * q] ?? 0);
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
        const reached = reachedBy(base, t, moved);
        let changed = 0;
        let stray = 0;
        for (let q = 0; q < m * m; q++) {
          if (uses[q] === after[q]) continue;
          changed++;
          const x = ((q % m) + 0.5) * base.cell;
          const z = (Math.floor(q / m) + 0.5) * base.cell;
          if (Math.hypot(x - at.x, z - at.z) <= 500) continue;
          if (nearest(moved, x, z) <= 150) continue;
          if (reached(q)) continue;
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

  test("switching the roads or the tracks changes no land beyond 150 m of every way but in the parcels the ways it moves reach", () => {
    for (const seed of SEEDS) {
      const base = variant(seed);
      const uses = texelUses(base, seed);
      const m = base.size;
      for (const change of [{ roads: false }, { tracks: false }]) {
        const t = variant(seed, change);
        const after = texelUses(t, seed);
        const ways = wayPoints(base, t, false);
        // A parcel a moved way passes within 64 m of may turn whole (the roads' lean on crops and
        // wildflowers), out past 150 m of every way where it is large.
        const reached = reachedBy(base, t, wayPoints(base, t, true));
        let stray = 0;
        for (let q = 0; q < m * m; q++) {
          if (uses[q] === after[q]) continue;
          const x = ((q % m) + 0.5) * base.cell;
          const z = (Math.floor(q / m) + 0.5) * base.cell;
          if (nearest(ways, x, z) > 150 && !reached(q)) stray++;
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
      // Measured: 0.02-0.45% of the dry land beyond 400 m of the river changes (seeds 0-1), a few
      // parcels whose bids were all but tied and wood edges the woods' line moves, nudged by the
      // ranks and quantiles the riverside land shares with them (14-19%
      // while the settlements were weighed against the carved river and every parcel's draws were
      // keyed by its index).
      expect({ seed, far: far < 0.005 * dry }).toEqual({ seed, far: true });
    }
  }, 120_000);
});
