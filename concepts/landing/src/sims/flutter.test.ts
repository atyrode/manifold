import { expect, test } from "bun:test";
import { FlutterPlates } from "./flutter.ts";

const DT = 1 / 60;
const NO_FLOOR = (): number => -1e9;

/** One plate let go at height `up`, pitched `th`, falling in the plane at azimuth `psi`. */
function plate(mass: number, th = 0.3, psi = 0): FlutterPlates {
  const p = new FlutterPlates(1, 0.3);
  p.mass[0] = mass;
  p.chord[0] = 0.4;
  p.pace[0] = 0.21;
  p.psi[0] = psi;
  p.start(0);
  p.th[0] = th;
  return p;
}

test("a light plate flutters from side to side within a swing; a heavy one tumbles end over end", () => {
  const light = plate(0.3);
  const at = new Float64Array([0, 0, 100]);
  let reversals = 0;
  let heading = 0;
  let widest = 0;
  for (let f = 0; f < 20 * 60; f++) {
    const before = at[0] ?? 0;
    light.fly(0, DT, at, 0, 0, 0, NO_FLOOR);
    const way = Math.sign((at[0] ?? 0) - before);
    if (heading !== 0 && way !== 0 && way !== heading) reversals++;
    if (way !== 0) heading = way;
    widest = Math.max(widest, Math.abs(light.th[0] ?? 0));
  }
  expect(widest).toBeLessThan(Math.PI / 2);
  expect(reversals).toBeGreaterThan(12);
  // It comes down, slowly (well under a stone's fall), and stays in its plane.
  expect(100 - (at[2] ?? 0)).toBeGreaterThan(3);
  expect(100 - (at[2] ?? 0)).toBeLessThan(20);
  expect(at[1]).toBe(0);

  const heavy = plate(0.9);
  for (let f = 0; f < 20 * 60; f++) heavy.fly(0, DT, at, 0, 0, 0, NO_FLOOR);
  expect(Math.abs(heavy.th[0] ?? 0)).toBeGreaterThan(4 * Math.PI);
});

test("the fall plane's azimuth turns the swing from a toward b", () => {
  const p = plate(0.3, 0.3, Math.PI / 2);
  const at = new Float64Array([0, 0, 100]);
  for (let f = 0; f < 5 * 60; f++) p.fly(0, DT, at, 0, 0, 0, NO_FLOOR);
  expect(Math.abs(at[0] ?? 0)).toBeLessThan(1e-9);
  expect(Math.abs(at[1] ?? 0)).toBeGreaterThan(0.05);
});

test("the air carries a plate along each axis without changing its swing", () => {
  const still = plate(0.35);
  const blown = plate(0.35);
  const a = new Float64Array([0, 0, 100]);
  const b = new Float64Array([0, 0, 100]);
  const air = [0.5, -0.25, 0.1] as const;
  const seconds = 3;
  for (let f = 0; f < seconds * 60; f++) {
    still.fly(0, DT, a, 0, 0, 0, NO_FLOOR);
    blown.fly(0, DT, b, air[0], air[1], air[2], NO_FLOOR);
  }
  expect(blown.th[0]).toBe(still.th[0] ?? Number.NaN);
  // Carried for the model steps taken: the elapsed seconds, less what is still owed (under a step).
  const carried = ((b[0] ?? 0) - (a[0] ?? 0)) / air[0];
  expect(carried).toBeGreaterThan(seconds - 0.03 * 0.21 - 1e-9);
  expect(carried).toBeLessThanOrEqual(seconds + 1e-9);
  expect(((b[1] ?? 0) - (a[1] ?? 0)) / air[1]).toBeCloseTo(carried, 9);
  expect(((b[2] ?? 0) - (a[2] ?? 0)) / air[2]).toBeCloseTo(carried, 9);
});

test("a plate lands on the floor under it, checked step by step, and stops at its height", () => {
  const p = plate(0.3);
  const at = new Float64Array([0, 0, 1.5]);
  const floor = (x: number, y: number): number => 0.4 + 0.1 * x - 0.05 * y;
  let frames = 0;
  while (!p.fly(0, DT, at, 0.2, 0.1, 0, floor)) {
    expect(at[2] ?? 0).toBeGreaterThan(floor(at[0] ?? 0, at[1] ?? 0));
    expect(++frames).toBeLessThan(60 * 30);
  }
  expect(at[2]).toBe(floor(at[0] ?? 0, at[1] ?? 0));
  // It stopped on the step it touched: the rest of that frame is only owed (never over two steps).
  expect(p.debt[0] ?? 1).toBeLessThanOrEqual(0.06);
});

test("a long frame takes at most 64 steps, while the spin keeps the frame's whole time", () => {
  const p = plate(0.3);
  p.dsigma[0] = 0.5;
  const at = new Float64Array([0, 0, 100]);
  p.fly(0, 30, at, 1, 0, 0, NO_FLOOR);
  // 64 steps of 0.03 model time at 0.21 s each: the air carried it 0.4032 s, not 30.
  expect(at[0] ?? 0).toBeLessThan(0.41 + 0.4 * 64 * 0.03);
  expect(p.debt[0]).toBe(0.06);
  expect(p.sigma[0]).toBe(15);
});

test("down, it eases flat to the nearer face, from where it touched down", () => {
  const p = plate(0.3);
  p.rest[0] = 0.05;
  const settled = (th: number, k: number): number => {
    p.th[0] = th;
    p.touchDown(0);
    p.settle(0, k);
    return p.th[0] ?? Number.NaN;
  };
  expect(settled(2.9, 1)).toBeCloseTo(Math.PI + 0.05, 12);
  expect(settled(-2.9, 1)).toBeCloseTo(-Math.PI + 0.05, 12);
  expect(settled(0.4, 1)).toBeCloseTo(0.05, 12);
  // A plate that turned over twice on its way down touches down at its pitch within one turn.
  expect(settled(4 * Math.PI + 0.4, 0)).toBeCloseTo(0.4, 9);
  expect(settled(1.2, 0.5)).toBeCloseTo(0.625, 12);
});

test("its frame is orthonormal and right-handed, normal up when flat, rocking by rockAngle", () => {
  const p = plate(0.3);
  const f = new Float64Array(9);
  const dot = (i: number, j: number): number => (f[i] ?? 0) * (f[j] ?? 0) + (f[i + 1] ?? 0) * (f[j + 1] ?? 0) + (f[i + 2] ?? 0) * (f[j + 2] ?? 0);
  for (let k = 0; k < 200; k++) {
    p.psi[0] = 0.37 * k;
    p.th[0] = 0.91 * k;
    p.roll[0] = 1.3 * k;
    p.sigma[0] = 0.53 * k;
    p.orient(0, (k % 5) / 4, f);
    for (const [i, j, want] of [[0, 0, 1], [3, 3, 1], [6, 6, 1], [0, 3, 0], [0, 6, 0], [3, 6, 0]] as const) expect(dot(i, j)).toBeCloseTo(want, 12);
    // n = t x s.
    expect((f[1] ?? 0) * (f[5] ?? 0) - (f[2] ?? 0) * (f[4] ?? 0)).toBeCloseTo(f[6] ?? 0, 12);
    expect((f[2] ?? 0) * (f[3] ?? 0) - (f[0] ?? 0) * (f[5] ?? 0)).toBeCloseTo(f[7] ?? 0, 12);
    expect((f[0] ?? 0) * (f[4] ?? 0) - (f[1] ?? 0) * (f[3] ?? 0)).toBeCloseTo(f[8] ?? 0, 12);
  }
  // Flat, face up and face down; then rocked by its whole swing.
  p.th[0] = 0;
  p.roll[0] = Math.PI / 2;
  p.orient(0, 0, f);
  expect([f[6], f[7], f[8]]).toEqual([0, 0, 1]);
  p.th[0] = Math.PI;
  p.orient(0, 0, f);
  expect(f[8]).toBeCloseTo(-1, 12);
  p.th[0] = 0;
  p.orient(0, 1, f);
  expect(Math.acos(f[8] ?? 0)).toBeCloseTo(0.3, 12);
});
