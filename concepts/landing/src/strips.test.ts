import { expect, test } from "bun:test";
import { STRIPS, StripScheduler } from "./strips.ts";

/** The rows of the next `frames` frames. */
const frames = (strips: StripScheduler, height: number, count: number) =>
  Array.from({ length: count }, () => strips.rows(height));

test("an untimed picture draws whole, every frame", () => {
  const strips = new StripScheduler();
  expect(frames(strips, 540, 3)).toEqual([
    [0, 540],
    [0, 540],
    [0, 540],
  ]);
});

test("a fast draw stays whole", () => {
  const strips = new StripScheduler();
  strips.measured(STRIPS.budget * 0.9, 540, 540);
  expect(strips.strips).toBe(1);
  expect(strips.rows(540)).toEqual([0, 540]);
});

test("a slow draw splits the picture into the fewest strips within the budget, bottom up", () => {
  const strips = new StripScheduler();
  strips.rows(540);
  strips.measured(STRIPS.budget * 3.5, 540, 540);
  expect(strips.strips).toBe(4);
  expect(frames(strips, 540, 5)).toEqual([
    [0, 135],
    [135, 270],
    [270, 405],
    [405, 540],
    [0, 135],
  ]);
});

test("the last strip takes the rows left over", () => {
  const strips = new StripScheduler();
  strips.reset(3);
  expect(frames(strips, 100, 3)).toEqual([
    [0, 34],
    [34, 68],
    [68, 100],
  ]);
});

test("a strip that runs over splits further at once, the pass starting again", () => {
  const strips = new StripScheduler();
  strips.reset(2);
  expect(strips.rows(400)).toEqual([0, 200]);
  // 1.5 ms a row: six strips of 67 rows would take 100.5 ms, seven of 58 take 87.
  strips.measured(STRIPS.budget * 3, 200, 400);
  expect(strips.strips).toBe(7);
  expect(strips.rows(400)).toEqual([0, 58]);
});

test("the strips come down only once a whole pass shows fewer would draw well within the budget", () => {
  const strips = new StripScheduler();
  strips.reset(4);
  // A pass of four, each strip at a fifth of the budget: one strip would take 0.8 budgets, over the
  // settle share, two 0.4: the next pass draws two.
  for (const [from, to] of frames(strips, 400, 4))
    strips.measured(STRIPS.budget * 0.2, to - from, 400);
  expect(strips.strips).toBe(4);
  expect(strips.rows(400)).toEqual([0, 200]);
  expect(strips.strips).toBe(2);
});

test("an untimed pass keeps its strips", () => {
  const strips = new StripScheduler();
  strips.reset(STRIPS.start);
  frames(strips, 400, STRIPS.start + 1);
  expect(strips.strips).toBe(STRIPS.start);
});

test("no more strips than the most, however slow", () => {
  const strips = new StripScheduler();
  strips.measured(STRIPS.budget * 1000, 540, 540);
  expect(strips.strips).toBe(STRIPS.most);
  strips.reset(1000);
  expect(strips.strips).toBe(STRIPS.most);
});

test("a measurement of nothing is ignored", () => {
  const strips = new StripScheduler();
  strips.measured(Number.NaN, 540, 540);
  strips.measured(500, 0, 540);
  expect(strips.strips).toBe(1);
});
