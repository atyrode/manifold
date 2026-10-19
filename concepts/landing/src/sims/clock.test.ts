import { expect, test } from "bun:test";
import { ClockError, FixedStep, Settle, STEP_EARLY } from "./clock.ts";
import { Random } from "./random.ts";

/** Frame times (s) as a browser stamps them: vsync at `hz`, ±`jitter` ms, rounded to `grain` ms. */
function stamps(hz: number, frames: number, jitter: number, grain: number, seed: number): number[] {
  const random = new Random(seed);
  return Array.from({ length: frames + 1 }, (_, n) => {
    const ms = (1000 * n) / hz + random.range(-jitter, jitter);
    return (Math.round(ms / grain) * grain) / 1000;
  });
}

test("a 60 Hz display runs one 1/60 step every frame, whatever its timestamps' jitter and grain", () => {
  // With the step due at exactly h, pending sits on the boundary and rounding splits a third of the
  // frames into none and two steps (twice a frame's sim work in one frame).
  for (const [jitterMs, grainMs] of [
    [0, 0.005],
    [0, 0.1],
    [0.3, 0.1],
    [0.35, 0.001],
  ] as const) {
    const clock = new FixedStep(1 / 60, 8);
    const times = stamps(60, 6000, jitterMs, grainMs, 7);
    const counts = new Map<number, number>();
    for (let n = 1; n < times.length; n++) {
      const steps = clock.advance((times[n] ?? 0) - (times[n - 1] ?? 0));
      counts.set(steps, (counts.get(steps) ?? 0) + 1);
    }
    expect([jitterMs, grainMs, [...counts]]).toEqual([jitterMs, grainMs, [[1, 6000]]]);
  }
});

test("frames of whole steps, as HeadlessSim's exact 1/60, step on the frame as at a due point of h", () => {
  for (const per of [1, 2, 4, 8]) {
    const clock = new FixedStep(1 / (60 * per), 4 * per);
    for (let n = 0; n < 3600; n++) {
      expect(clock.advance(1 / 60)).toBe(per);
      expect(clock.pending).toBeLessThan(1e-12);
    }
  }
});

test("144 Hz runs the 600 steps of 10 s, never two in one frame, and keeps real time", () => {
  for (const times of [stamps(144, 1440, 0, 0.001, 3), stamps(144, 1440, 0.3, 0.1, 3)]) {
    const clock = new FixedStep(1 / 60, 8);
    let steps = 0;
    for (let n = 1; n < times.length; n++) {
      const due = clock.advance((times[n] ?? 0) - (times[n - 1] ?? 0));
      expect(due).toBeLessThanOrEqual(1);
      steps += due;
    }
    expect(steps).toBe(600);
    // What the steps covered and what is left over make up the time given.
    expect(steps / 60 + clock.pending).toBeCloseTo((times.at(-1) ?? 0) - (times[0] ?? 0), 9);
  }
});

test("a stall runs at most maxSteps steps and drops the rest of what it owed", () => {
  const clock = new FixedStep(1 / 60, 4);
  expect(clock.advance(10)).toBe(4);
  expect(clock.pending).toBeCloseTo(0, 12);
  expect(clock.advance(0)).toBe(0);
  // Then frames come at 60 Hz again: one step each.
  for (let n = 0; n < 10; n++) expect(clock.advance(1 / 60)).toBe(1);
  // A cap counts what is owed, so 4.5 steps owed at once is 4 steps and nothing left.
  expect(clock.advance(4.5 / 60)).toBe(4);
  expect(clock.alpha).toBeCloseTo(0, 12);
});

test("a step due a hair early is owed back: the next falls due that much later", () => {
  const h = 1 / 60;
  const clock = new FixedStep(h, 8);
  expect(clock.advance((1 - STEP_EARLY) * h)).toBe(1);
  expect(clock.alpha).toBe(0);
  expect(clock.lag(0)).toBe(0);
  expect(clock.advance(0.92 * h)).toBe(0);
  expect(clock.alpha).toBeCloseTo(0.92 - STEP_EARLY, 12);
  expect(clock.advance(0.1 * h)).toBe(1);
});

test("alpha stays in 0..1, pending under a step and every lag at least 0, for any frame times", () => {
  const random = new Random(5);
  for (const step of [1 / 60, 1 / 144, 1 / 240, 1 / 40]) {
    const clock = new FixedStep(step, 6);
    for (let n = 0; n < 20000; n++) {
      // Mostly frames near a display's, some stalls, zeros and negatives (counted as 0).
      const pick = random.next();
      let dt = random.range(0.005, 0.04);
      if (pick < 0.05) dt = 0;
      else if (pick < 0.08) dt = -0.01;
      else if (pick < 0.1) dt = random.range(0, 1);
      const due = clock.advance(dt);
      expect(clock.alpha).toBeGreaterThanOrEqual(0);
      expect(clock.alpha).toBeLessThan(1);
      expect(clock.pending).toBeGreaterThanOrEqual(0);
      expect(clock.pending).toBeLessThan(step);
      for (let i = 0; i < due; i++) {
        expect(clock.lag(i)).toBeGreaterThanOrEqual(0);
        expect(clock.lag(i)).toBeLessThan(6 * step);
      }
    }
  }
});

test("Settle lays the first key out at once, then waits for a changed key to rest", () => {
  const settle = new Settle<number>(300);
  expect(settle.due(1, 1000)).toBe(true);
  settle.lay(1);
  expect(settle.laid).toBe(1);
  expect(settle.stands(1)).toBe(true);
  expect(settle.due(1, 1100)).toBe(false);
  // A new key: due only once it has stood 300 ms, counted from when it first showed.
  expect(settle.due(2, 1200)).toBe(false);
  expect(settle.due(2, 1499)).toBe(false);
  expect(settle.due(2, 1500)).toBe(true);
  expect(settle.stands(2)).toBe(false);
  settle.lay(2);
  expect(settle.stands(2)).toBe(true);
  expect(settle.due(2, 1600)).toBe(false);
});

test("Settle restarts the wait whenever the wanted key moves again", () => {
  const settle = new Settle<number>(300);
  settle.lay(0);
  expect(settle.due(1, 0)).toBe(false);
  expect(settle.due(2, 200)).toBe(false);
  // 1 stood from 0 to 200; 2 only since 200, so nothing is due until 500.
  expect(settle.due(2, 499)).toBe(false);
  expect(settle.due(2, 500)).toBe(true);
  // Back to the laid key: nothing to lay, and a later change waits afresh.
  expect(settle.due(0, 510)).toBe(false);
  expect(settle.due(3, 520)).toBe(false);
  expect(settle.due(3, 819)).toBe(false);
  expect(settle.due(3, 820)).toBe(true);
});

test("Settle keeps a copy of a key the caller rewrites, and compares by `same`", () => {
  interface Key {
    a: number;
    b: number;
  }
  const settle = new Settle<Key>(100, {
    same: (x, y) => x.a === y.a && x.b === y.b,
    copy: (k) => ({ ...k }),
  });
  const want: Key = { a: 1, b: 1 };
  expect(settle.due(want, 0)).toBe(true);
  settle.lay(want);
  want.b = 2;
  expect(settle.stands(want)).toBe(false);
  expect(settle.laid).toEqual({ a: 1, b: 1 });
  expect(settle.due(want, 10)).toBe(false);
  want.b = 1;
  expect(settle.stands(want)).toBe(true);
  expect(settle.due(want, 500)).toBe(false);
});

test("Settle takes a rest of 0 ms as at once and refuses a negative or NaN rest", () => {
  const settle = new Settle<number>(0);
  settle.lay(1);
  expect(settle.due(2, 5)).toBe(true);
  expect(() => new Settle<number>(-1)).toThrow(ClockError);
  expect(() => new Settle<number>(Number.NaN)).toThrow(ClockError);
});
