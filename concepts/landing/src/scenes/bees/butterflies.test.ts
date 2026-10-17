import { describe, expect, test } from "bun:test";
import { Butterflies } from "./butterflies.ts";
import { Garden, STEP } from "./garden.ts";
import { beesStage } from "./layout.ts";

describe("butterflies", () => {
  test("fewer asked for, the rest flutter off over the edge of the frame, none vanishing in the air", () => {
    const garden = new Garden();
    garden.stage = beesStage(16 / 9);
    garden.aspect = 16 / 9;
    const butterflies = new Butterflies(garden);
    butterflies.count = 6;
    butterflies.wake();
    butterflies.scatter();
    const steps = (seconds: number): void => {
      for (let s = 0; s < seconds * 60; s++) {
        garden.tm += STEP;
        butterflies.step(STEP);
      }
    };
    steps(20);
    butterflies.count = 2;
    butterflies.wake();
    const leaving = butterflies.list.slice(2);
    expect(leaving.every((g) => g.active)).toBe(true);
    for (let s = 0; s < 60 * 60 && leaving.some((g) => g.active); s++) {
      const was = leaving.map((g) => g.active);
      steps(1 / 60);
      for (const [i, g] of leaving.entries())
        if (was[i] === true && !g.active) expect(garden.outside(g.x, g.z, g.h, 0.05)).toBe(true);
    }
    expect(leaving.some((g) => g.active)).toBe(false);
    expect(butterflies.list.slice(0, 2).every((g) => g.active)).toBe(true);
  });
});
