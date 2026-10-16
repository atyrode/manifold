import { expect, test } from "bun:test";
import { hypot2, hypot3 } from "./math.ts";

// Each row: the arguments, then what V8's own Math.hypot gave for them (node 24.19, V8 13.6: the
// engine Chrome runs the page in). The ports must give those bits in whatever engine runs the test;
// bun's is JavaScriptCore, whose own Math.hypot rounds 11 of these rows otherwise.

const HYPOT2: readonly (readonly [number, number, number])[] = [
  // Signs and zeros: +0 for zeros.
  [0, 0, 0],
  [-0, -0, 0],
  [-0, 2.5, 2.5],
  [3, -4, 5],
  // An infinity wins over NaN.
  [Number.NaN, -Infinity, Infinity],
  [Infinity, Number.NaN, Infinity],
  [Number.NaN, 0, Number.NaN],
  [1, Number.NaN, Number.NaN],
  // Subnormals: scaled by the larger first, the squares never underflow.
  [5e-324, 5e-324, 5e-324],
  [1e-323, 5e-324, 1e-323],
  [1.5e-323, -1.5e-323, 2e-323],
  [2.2250738585072014e-308, -2.2250738585072014e-308, 3.1467296279827175e-308],
  [1e-310, 3e-310, 3.1622776601684e-310],
  // Near the largest double: the squares never overflow, only a result past it.
  [1e308, -1e308, 1.4142135623730951e308],
  [1.7976931348623157e308, 1.7976931348623157e308, Infinity],
  [1.7976931348623157e308, 1e292, 1.7976931348623157e308],
  // Ties: equal magnitudes; the squares' sum exactly halfway between two doubles; the last
  // product exactly halfway.
  [0.1, -0.1, 0.14142135623730953],
  [6400, 6400, 9050.966799187809],
  [2412.591667473316, -1582.618921995163, 2885.3563395564865],
  [2367.4731016159058, -2239.1201972961426, 3258.6175204853903],
  [3, -2, 3.6055512754639896],
  [5, -4, 6.4031242374328485],
  // Distances across the map that JavaScriptCore's Math.hypot rounds otherwise.
  [-2542.262750864029, 92.70721226930618, 2543.9525391872953],
  [840.2025297284126, 3060.5462938547134, 3173.7806962343575],
  [800.0122919678688, 322.0775306224823, 862.4115044638254],
  [-466.8733075261116, -2944.4417625665665, 2981.225918716406],
  // Not hypot3(x, y, 0) (its last row).
  [-3.060031920671463, 182755.86499023438, 182755.86501585267],
];

const HYPOT3: readonly (readonly [number, number, number, number])[] = [
  // Signs and zeros.
  [0, -0, 0, 0],
  [-0, -0, -0, 0],
  [1, -2, 2, 3],
  [-2, 3, -6, 7],
  // An infinity wins over NaN.
  [Number.NaN, 1, -Infinity, Infinity],
  [0, Number.NaN, 0, Number.NaN],
  // Subnormals.
  [5e-324, -5e-324, 5e-324, 1e-323],
  [5e-324, 0, 1e-323, 1e-323],
  // Near the largest double.
  [1e308, 1e308, -1e308, 1.7320508075688772e308],
  [1.2e308, 1.2e308, 1.2e308, Infinity],
  [1.7976931348623157e308, 1, -1, 1.7976931348623157e308],
  // Ties: equal magnitudes; the compensated sum exactly halfway between two doubles.
  [7, 7, -7, 12.12435565298214],
  [1402.4134010076523, 1091.508860886097, -126.26877212896943, 1781.6000515081023],
  [399.87606406211853, 362.3122990131378, -81.02962912525982, 545.6527003710089],
  // The third square takes back what rounding lost from the first two (uncompensated, all but the
  // second round otherwise), in argument order (the second is the first's three, reordered).
  [-263.0240395665169, 1780.0812631845474, 100.72067978326231, 1802.2251813429382],
  [100.72067978326231, -263.0240395665169, 1780.0812631845474, 1802.2251813429377],
  [2410.3913336992264, -31.185264885425568, -75.71085880044848, 2411.781714098233],
  [2325.2754002809525, 1255.23701608181, 96.60609732382, 2644.212244078347],
  // A zero third is still three: not hypot2(x, y) (its last row).
  [-3.060031920671463, 182755.86499023438, 0, 182755.8650158527],
];

test("hypot2 gives V8's Math.hypot bits in any engine: zeros, NaN, subnormals, overflow, ties", () => {
  expect(HYPOT2.filter(([x, y, v8]) => !Object.is(hypot2(x, y), v8))).toEqual([]);
});

test("hypot3 gives V8's Math.hypot bits in any engine, compensated in argument order", () => {
  expect(HYPOT3.filter(([x, y, z, v8]) => !Object.is(hypot3(x, y, z), v8))).toEqual([]);
});
