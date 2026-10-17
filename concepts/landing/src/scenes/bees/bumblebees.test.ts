import { describe, expect, test } from "bun:test";
import { Bumblebees } from "./bumblebees.ts";
import { Garden, STEP } from "./garden.ts";
import {
  BEES_BLOOMS,
  BEES_BLOOMS_ALL,
  BEES_FOXGLOVES,
  BEES_FOXGLOVES_ALL,
  beesStage,
} from "./layout.ts";

interface Stop {
  bee: number;
  on: string;
  plant: number;
  bell: number;
}

/** Every flower six bumblebees alight on over `seconds`, at `flowers`, in order. */
function stops(flowers: number, seconds: number): Stop[] {
  const garden = new Garden();
  garden.stage = beesStage(16 / 9);
  garden.aspect = 16 / 9;
  garden.setFlowers(flowers);
  const bumblebees = new Bumblebees(garden);
  bumblebees.count = 6;
  bumblebees.wake(true);
  const seen: Stop[] = [];
  const feeding = bumblebees.list.map(() => false);
  for (let s = 0; s < seconds * 60; s++) {
    garden.tm += STEP;
    bumblebees.step(STEP);
    for (const [bee, b] of bumblebees.list.entries()) {
      const feeds = b.mode === "feed";
      if (feeds && !feeding[bee]) seen.push({ bee, on: b.on, plant: b.plant, bell: b.bell });
      feeding[bee] = feeds;
    }
  }
  return seen;
}

describe("bumblebees", () => {
  test("work a foxglove from its lowest bells up the spike, bell by bell", () => {
    const last = new Map<number, Stop>();
    let climbs = 0;
    for (const stop of stops(1, 300)) {
      const before = last.get(stop.bee);
      last.set(stop.bee, stop);
      if (stop.on !== "foxglove") continue;
      if (before?.on === "foxglove" && before.plant === stop.plant && stop.bell > before.bell) {
        climbs++;
        continue;
      }
      // A new spike: from its lowest open bells.
      expect(stop.bell).toBeLessThan(0.5);
    }
    expect(climbs).toBeGreaterThan(20);
  });

  test("only go to the plants the flowers knob leaves standing, the lush garden's too", () => {
    for (const flowers of [0.5, 2.6]) {
      let lush = 0;
      for (const stop of stops(flowers, 300)) {
        if (stop.on === "drift") continue;
        const plants = stop.on === "foxglove" ? BEES_FOXGLOVES_ALL : BEES_BLOOMS_ALL;
        const base = stop.on === "foxglove" ? BEES_FOXGLOVES : BEES_BLOOMS;
        expect(flowers).toBeGreaterThanOrEqual(plants[stop.plant]?.[3] ?? Number.POSITIVE_INFINITY);
        if (stop.plant >= base.length) lush++;
      }
      if (flowers > 2) expect(lush).toBeGreaterThan(10);
    }
  });
});
