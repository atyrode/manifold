import { expect, test } from "bun:test";
import { gustGlsl } from "../composer/gust.ts";
import { feature, range } from "../params.ts";
import { skyKnobs, weatherKnobs } from "../scenes/atmosphere.ts";
import type { LoadedScene } from "../scenes/types.ts";
import { worldFeatures } from "../scenes/world.ts";
import { fragmentSourceFor } from "../shaders/index.ts";
import { worldGlsl } from "../shaders/lib/world.ts";
import {
  ENGINE_FOG,
  ENGINE_WIND,
  engineAirGlsl,
  engineFogDepth,
  engineWind,
  type EngineWindKnobs,
} from "./air.ts";
import type { Vec3 } from "./types.ts";

const speed = (v: readonly number[]) => Math.hypot(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0);
const still: EngineWindKnobs = { wind: 0.6, gusts: 0, gustRate: 0.5, nowAge: -1 };
const gusty: EngineWindKnobs = { wind: 0.6, gusts: 0.8, gustRate: 0.7, nowAge: -1 };

test("the wind is still at the ground, its reference speed at 10 m and stronger aloft", () => {
  const at = (y: number) => speed(engineWind([3, y, -4], 12, still));
  expect(at(0)).toBe(0);
  expect(at(0.05)).toBeLessThan(0.15 * at(10));
  expect(at(10)).toBeCloseTo(ENGINE_WIND.speed * 0.6, 6);
  const heights = [0.2, 1, 3, 10, 30, 100];
  const speeds = heights.map(at);
  for (let i = 1; i < speeds.length; i++)
    expect(speeds[i] ?? 0).toBeGreaterThan(speeds[i - 1] ?? 0);
});

test("the wind blows the way K_wind points, level, and not at all with no wind or gusts", () => {
  const right = engineWind([0, 5, 0], 3, still);
  const left = engineWind([0, 5, 0], 3, { ...still, wind: -0.6 });
  expect(right[0]).toBeGreaterThan(0);
  expect(left[0]).toBeCloseTo(-right[0], 9);
  // The gust field's downwind direction leans a little away from the eye, whichever side it blows.
  expect(right[2]).toBeGreaterThan(0);
  expect(left[2]).toBeCloseTo(right[2], 9);
  expect(right[1]).toBe(0);
  expect(speed(engineWind([0, 5, 0], 3, { ...still, wind: 0 }))).toBe(0);
});

test("gusts make the wind at a point rise and fall over time; without them it holds", () => {
  const p: Vec3 = [4, 8, 20];
  const times = Array.from({ length: 240 }, (_, i) => i * 0.5);
  const gusting = times.map((tm) => speed(engineWind(p, tm, gusty)));
  const steady = times.map((tm) => speed(engineWind(p, tm, still)));
  expect(Math.max(...gusting) - Math.min(...gusting)).toBeGreaterThan(2);
  expect(Math.max(...steady) - Math.min(...steady)).toBeLessThan(1e-9);
});

/** The fog's optical depth by Simpson's rule over the ray, step count n (even). */
function numericDepth(fog: number, o: Vec3, d: Vec3, t: number, n: number): number {
  const density = (s: number) =>
    ENGINE_FOG.density * fog * Math.exp(-(o[1] + d[1] * s) / ENGINE_FOG.height);
  const h = t / n;
  let sum = density(0) + density(t);
  for (let i = 1; i < n; i++) sum += (i % 2 === 1 ? 4 : 2) * density(i * h);
  return (sum * h) / 3;
}

const unit = (x: number, y: number, z: number): Vec3 => {
  const l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l];
};

const down = unit(0.3, -0.3, 1);

test("the fog's closed-form optical depth matches the integral along the ray within 1%", () => {
  const rays: readonly { o: Vec3; d: Vec3; t: number; to?: number }[] = [
    // level at eye height, across a field
    { o: [0, 1.6, 0], d: [0, 0, 1], t: 200 },
    // all but level: the series branch
    { o: [0, 1.6, 0], d: unit(0, 2e-5, 1), t: 3000 },
    // down from a hill to the ground
    { o: [5, 50, -2], d: down, t: -50 / down[1] },
    // up into the sky: the closed form at t = 1e5, the integral to where no fog is left
    { o: [0, 1.6, 0], d: unit(0, 0.2, 1), t: 1e5, to: 2000 },
    // steeply up from a tower
    { o: [0, 30, 0], d: unit(0.1, 1, 0.2), t: 1e5, to: 400 },
  ];
  for (const { o, d, t, to } of rays) {
    const closed = engineFogDepth(0.7, o, d, t);
    const numeric = numericDepth(0.7, o, d, to ?? t, 200_000);
    expect(closed).toBeGreaterThan(0);
    expect(Math.abs(closed - numeric) / numeric).toBeLessThan(0.01);
  }
  expect(engineFogDepth(0, [0, 1.6, 0], [0, 0, 1], 1e5)).toBe(0);
});

/** A program with the air and an entry calling each of its parts, as the engine assembles it. */
const scene: LoadedScene = {
  id: "airtest",
  title: "air",
  blurb: "",
  accent: "#ffffff",
  params: [
    ...skyKnobs({ time: 0.45 }),
    ...weatherKnobs({ clouds: 0.25, rain: true, snow: true, fog: true, wind: true }),
    feature("wind", "gusts", "gusts", true, "strength", 0.7, "", { trigger: 2 }),
    range("wind", "gustRate", "gust frequency", 0.45, ""),
  ],
  groups: {},
  code: () => Promise.reject(new Error("unused")),
  entry: "airTest",
  glsl: `${worldGlsl}
struct EngineRay { vec3 o; vec3 d; };
${gustGlsl(2, undefined)}
${engineAirGlsl}
Shade airTest(vec2 uv, vec2 cell, float t) {
  World w = worldAt(0, 1);
  EngineRay r = EngineRay(vec3(0.0, 1.6, 0.0), normalize(vec3(uv - 0.5, 1.0)));
  vec3 p = r.o + r.d * 9.0;
  vec3 col = engineSurfaceWeather(w, p, vec3(0.0, 1.0, 0.0), vec3(0.4)) * (1.0 + engineWetGloss(w, p, vec3(0.0, 1.0, 0.0)));
  col = engineFog(w, r, 9.0, col, w.sky.sun, w.sky.sunColor) + engineWind(p, w.tm) * 0.01;
  vec4 fall = enginePrecip(w, r, 9.0, w.tm, w.sky.ambient);
  col = col * (1.0 - fall.a) + fall.rgb;
  return shadeOf(col, inkOf(col, 1.0, 1.0), 0.0);
}
`,
};

const program = (world: Record<string, number>) => fragmentSourceFor(scene, worldFeatures(world));

test("the air's code is in a program only while its World's knob is on", () => {
  const dry = program({});
  for (const part of [
    "ENGINE_PRECIP",
    "engineFallCover",
    "engineFogDepth",
    "rainPuddles",
    "snowCover",
  ])
    expect(dry).not.toContain(part);
  expect(dry).toContain("engineWind");

  const rain = program({ rain: 1 });
  expect(rain).toContain("engineFallCover");
  expect(rain).toContain("rainPuddles");
  expect(rain).not.toContain("engineFogDepth");
  expect(rain).not.toContain("snowCover");

  const snow = program({ snow: 1 });
  expect(snow).toContain("engineFallCover");
  expect(snow).toContain("snowCover");
  expect(snow).not.toContain("rainPuddles");

  const fog = program({ fog: 1 });
  expect(fog).toContain("engineFogDepth");
  expect(fog).not.toContain("ENGINE_PRECIP");
});
