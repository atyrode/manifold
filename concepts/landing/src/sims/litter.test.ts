import { expect, test } from "bun:test";
import { CLEARED, Litter, PINNED } from "./litter.ts";
import { mulberry32 } from "./random.ts";

const LATTICE = { cell: 0.5, x0: -2, z0: 1, cols: 8, rows: 6 } as const;
const LEVELS = 4;

/** The packed texel w of a slot: 0 for no item, else face * (level + 16 * mark + 0.98 * hue). */
function shown(litter: Litter, slot: number): number {
  const layer = slot >= litter.cells ? 1 : 0;
  return litter.layers[layer][(slot - layer * litter.cells) * 4 + 3] ?? 0;
}

test("landed items fill the top cell, then the shifted cell beneath, then lie over the top one", () => {
  const litter = new Litter(LATTICE, LEVELS);
  const rand = mulberry32(7);
  // (x, z) = (0.3, 2.3): lattice cell (4, 2); the shifted lattice's cell under it is (4, 2) too.
  const top = 2 * 8 + 4;
  litter.deposit(0.3, 2.3, 1, 0.4, 1, rand);
  expect(Math.abs(shown(litter, top))).toBeCloseTo(LEVELS + 0.98 * 0.4, 5);
  litter.deposit(0.3, 2.3, 2, 0.6, -1, rand);
  expect(shown(litter, litter.cells + top)).toBeCloseTo(-(LEVELS + 0.98 * 0.6), 5);
  litter.deposit(0.31, 2.31, 3, 0.2, 1, rand);
  expect(shown(litter, top)).toBeCloseTo(LEVELS + 0.98 * 0.2, 5);

  // Nothing lands on a pinned cell.
  litter.protect[0] = PINNED;
  litter.deposit(-1.9, 1.1, 0, 0.5, 1, rand);
  expect(shown(litter, 0)).toBe(0);
});

test("a pickup lifts only the whole item on top, where it lay, and leaves what is beneath", () => {
  const litter = new Litter(LATTICE, LEVELS);
  const rand = mulberry32(3);
  litter.deposit(0.3, 2.3, 1.25, 0.4, -1, rand);
  litter.deposit(0.3, 2.3, 2, 0.6, 1, rand);
  const top = 2 * 8 + 4;
  const item = litter.take(0.4, 2.4);
  expect(item?.angle).toBeCloseTo(1.25, 6);
  expect(item?.face).toBe(-1);
  expect(item?.x).toBeCloseTo(0.3, 5);
  expect(item?.z).toBeCloseTo(2.3, 5);
  expect(shown(litter, top)).toBe(0);
  expect(shown(litter, litter.cells + top)).not.toBe(0);
  // The top cell is bare now: nothing more to lift there.
  expect(litter.take(0.4, 2.4)).toBeUndefined();

  // An item still fading in, or one pinned in a figure, stays on the ground.
  litter.place(0, 0.5, 0.5, 0, 0.5, false, 0, LEVELS, rand);
  expect(litter.take(-1.9, 1.1)).toBeUndefined();
  for (let n = 0; n < LEVELS; n++) litter.fade();
  litter.protect[0] = PINNED;
  expect(litter.take(-1.9, 1.1)).toBeUndefined();
  litter.protect[0] = 0;
  expect(litter.take(-1.9, 1.1)).toBeDefined();
});

test("tending fades items in and out toward the wanted cover, one level at a time, never on protected cells", () => {
  const litter = new Litter(LATTICE, LEVELS);
  const rand = mulberry32(11);
  const wants = (cell: number, layer: number): boolean => layer === 0 && cell % 3 === 0;
  litter.place(1, 0.5, 0.5, 0, 0.5, false, LEVELS, LEVELS, rand);
  litter.protect[3] = CLEARED;
  litter.tend(litter.cells, 1, 1, wants, rand);
  for (let cell = 0; cell < litter.cells; cell++) {
    expect((litter.goal[cell] ?? 0) > 0).toBe(cell !== 3 && cell % 3 === 0);
    expect(litter.goal[litter.cells + cell]).toBe(0);
  }
  // New items start invisible and step up a level per fade; the unwanted one steps down.
  expect(shown(litter, 0)).toBe(0);
  litter.fade();
  expect(Math.abs(shown(litter, 0))).toBeGreaterThanOrEqual(1);
  expect(Math.abs(shown(litter, 0))).toBeLessThan(2);
  expect(litter.level[1]).toBe(LEVELS - 1);
  for (let n = 1; n < LEVELS; n++) litter.fade();
  expect(litter.level[0]).toBe(LEVELS);
  expect(shown(litter, 1)).toBe(0);
  expect(litter.fading.size).toBe(0);
});
