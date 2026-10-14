import { describe, expect, test } from "bun:test";
import { FishGroup, KOI, packFish, type FishSpecies } from "./fish.ts";

const H = 1 / 60;

/** Smallest centre distance between any two of the first `count` fish, over their mean length. */
function closestPair(group: FishGroup, count: number): number {
  let closest = Infinity;
  for (let i = 0; i < count; i++) {
    for (let j = i + 1; j < count; j++) {
      const d = Math.hypot((group.x[i] ?? 0) - (group.x[j] ?? 0), (group.y[i] ?? 0) - (group.y[j] ?? 0));
      closest = Math.min(closest, d / (0.5 * ((group.length[i] ?? 0) + (group.length[j] ?? 0))));
    }
  }
  return closest;
}

/** Eight koi set off around a point from all sides, all gathering on it for `seconds`. */
function crowd(species: FishSpecies, seconds: number): FishGroup {
  const group = new FishGroup(species, 8);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    group.place(i, 0.6 * Math.cos(a), 0.4 * Math.sin(a), a + Math.PI * 0.9, species.cruise, 0.12 + 0.005 * i, i / 8);
  }
  for (let t = 0; t < seconds; t += H) {
    group.clear(8);
    for (let i = 0; i < 8; i++) group.gather(i, 0, 0, 0.3);
    group.space(8);
    group.swim(8, H);
  }
  return group;
}

describe("FishGroup", () => {
  test("a fish only ever moves the way it faces", () => {
    const group = new FishGroup(KOI, 3);
    group.place(0, 0, 0, 0.3, 0.1, 0.12, 0);
    group.place(1, 0.05, 0.02, 2.5, 0.2, 0.12, 0.4);
    group.place(2, -0.2, 0.1, -1, 0.05, 0.12, 0.8);
    for (let k = 0; k < 300; k++) {
      const before = [0, 1, 2].map((i) => [group.x[i] ?? 0, group.y[i] ?? 0] as const);
      group.clear(3);
      group.gather(0, 0.4, -0.3, 0.2);
      group.flee(1, 0, 0, 0.5);
      group.follow(2, Math.cos(k * 0.05), Math.sin(k * 0.05), 0, 0);
      group.space(3);
      group.swim(3, H);
      for (let i = 0; i < 3; i++) {
        const dx = (group.x[i] ?? 0) - (before[i]?.[0] ?? 0);
        const dy = (group.y[i] ?? 0) - (before[i]?.[1] ?? 0);
        const h = group.heading[i] ?? 0;
        // Sideways part of the step is zero; the forward part is never backwards.
        expect(Math.abs(-Math.sin(h) * dx + Math.cos(h) * dy)).toBeLessThan(1e-12);
        expect(Math.cos(h) * dx + Math.sin(h) * dy).toBeGreaterThan(0);
      }
    }
  });

  test("turning is capped at turnRate · pace per second", () => {
    const group = new FishGroup(KOI, 1);
    group.pace = 1.5;
    group.place(0, 0, 0, 0, KOI.cruise, 0.12, 0);
    let previous = 0;
    for (let k = 0; k < 120; k++) {
      group.clear(1);
      // The point it wants lies straight behind it.
      group.gather(0, (group.x[0] ?? 0) - Math.cos(group.heading[0] ?? 0), (group.y[0] ?? 0) - Math.sin(group.heading[0] ?? 0), 0.1);
      group.swim(1, H);
      let turned = (group.heading[0] ?? 0) - previous;
      turned -= 2 * Math.PI * Math.round(turned / (2 * Math.PI));
      expect(Math.abs(turned)).toBeLessThanOrEqual(KOI.turnRate * 1.5 * H + 1e-12);
      previous = group.heading[0] ?? 0;
    }
  });

  test("personal space keeps a gathering crowd from piling onto one spot", () => {
    const spaced = crowd(KOI, 20);
    const piled = crowd({ ...KOI, spacingPull: 0 }, 20);
    // Without spacing, eight koi homing on one point end up on top of each other; with it they
    // stay apart by more than half a body length, still gathered round the point.
    expect(closestPair(piled, 8)).toBeLessThan(0.2);
    expect(closestPair(spaced, 8)).toBeGreaterThan(0.5);
    for (let i = 0; i < 8; i++) expect(Math.hypot(spaced.x[i] ?? 0, spaced.y[i] ?? 0)).toBeLessThan(0.35);
  });

  test("follow keeps up with a point moving round a loop", () => {
    const group = new FishGroup(KOI, 1);
    group.place(0, 0.3, 0, Math.PI / 2, KOI.cruise, 0.12, 0);
    const w = 0.6;
    let worst = 0;
    for (let k = 0; k < 900; k++) {
      const t = k * H;
      group.clear(1);
      group.follow(0, 0.3 * Math.cos(w * t), 0.3 * Math.sin(w * t), -0.3 * w * Math.sin(w * t), 0.3 * w * Math.cos(w * t));
      group.swim(1, H);
      if (t > 5) worst = Math.max(worst, Math.hypot((group.x[0] ?? 0) - 0.3 * Math.cos(w * (t + H)), (group.y[0] ?? 0) - 0.3 * Math.sin(w * (t + H))));
    }
    expect(worst).toBeLessThan(0.01);
  });

  test("a school lines up; a solitary species does not", () => {
    const run = (species: FishSpecies): number => {
      const group = new FishGroup(species, 6);
      for (let i = 0; i < 6; i++) group.place(i, 0.03 * i, 0.02 * (i % 2), i * 1.1, species.cruise, 0.03, i / 6);
      for (let k = 0; k < 480; k++) {
        group.clear(6);
        group.school(6);
        group.space(6);
        group.swim(6, H);
      }
      let cx = 0;
      let cy = 0;
      for (let i = 0; i < 6; i++) {
        cx += Math.cos(group.heading[i] ?? 0);
        cy += Math.sin(group.heading[i] ?? 0);
      }
      return Math.hypot(cx, cy) / 6;
    };
    const school = { align: 4, cohere: 8, alignPull: 1, coherePull: 0.5 };
    expect(run({ ...KOI, school })).toBeGreaterThan(0.9);
    expect(run(KOI)).toBeLessThan(0.5);
  });

  test("a paused step (h = 0) changes nothing", () => {
    const group = new FishGroup(KOI, 2);
    group.place(0, 0.1, 0.2, 1, 0.1, 0.12, 0);
    group.place(1, 0.11, 0.2, 2, 0.1, 0.12, 0.5);
    const before = [...group.x, ...group.y, ...group.heading, ...group.speed];
    group.clear(2);
    group.gather(0, 1, 1, 0.2);
    group.space(2);
    group.swim(2, 0);
    expect([...group.x, ...group.y, ...group.heading, ...group.speed]).toEqual(before);
  });
});

describe("packFish", () => {
  test("positions survive as hi + lo halves; fish past the count are hidden", () => {
    const group = new FishGroup(KOI, 3);
    group.place(0, 0.123456, -0.4321, 0.5, 0.2, 0.15, 0);
    group.place(1, -0.876543, 0.31415, -2, 0.1, 0.12, 0);
    group.place(2, 0.5, 0.5, 0, 0.1, 0.1, 0);
    group.tag[4] = 0.75;
    const out = new Float32Array(3 * 3 * 4);
    packFish(group, 2, 0, out);
    expect((out[0] ?? 0) + (out[1] ?? 0)).toBeCloseTo(0.123456, 6);
    expect((out[2] ?? 0) + (out[3] ?? 0)).toBeCloseTo(-0.4321, 6);
    expect((out[4] ?? 0) + (out[5] ?? 0)).toBeCloseTo(-0.876543, 6);
    // Row 1: heading, speed, length; the third fish is past the count.
    expect(out[12]).toBeCloseTo(Math.cos(0.5), 6);
    expect(out[13]).toBeCloseTo(Math.sin(0.5), 6);
    expect(out[15]).toBeCloseTo(0.15, 6);
    expect(out[23]).toBe(0);
    // Row 2: the scene's own values.
    expect(out[28]).toBe(0.75);
  });
});
