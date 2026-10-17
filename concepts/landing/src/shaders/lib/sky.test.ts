import { expect, test } from "bun:test";
import { constellationUniforms } from "../../constellations.ts";
import { glslActive, glslDefinitions, glslIdentifiers } from "../glsl.ts";
import { modulesFor } from "./index.ts";
import { planetBodyModule, planetModule } from "./planet.ts";
import { skyFigurePoint, skyFigures, skyModule } from "./sky.ts";

type Vec3 = readonly [number, number, number];

const angle = (a: Vec3, b: Vec3): number =>
  Math.acos(Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
const elevation = (v: Vec3): number => Math.asin(v[1]);
const bearing = (v: Vec3): number => Math.atan2(v[0], v[2]);
const degrees = (radians: number): number => (radians * 180) / Math.PI;

/** Every figure star's direction, with its figure's index. */
const stars = skyFigures.flatMap((figure, index) =>
  Array.from({ length: figure.stars[1] - figure.stars[0] }, (_, k) => {
    const star = figure.stars[0] + k;
    const offset: [number, number] = [
      constellationUniforms.stars[star * 4 + 2] ?? 0,
      constellationUniforms.stars[star * 4 + 3] ?? 0,
    ];
    return { index, dir: skyFigurePoint(figure, offset) };
  }),
);

/** The full moon at midnight, where skyAt puts it: 30 degrees up, straight ahead. */
const midnightMoon: Vec3 = [0, Math.sin(Math.PI / 6), Math.cos(Math.PI / 6)];

test("the figures are every constellation but the Manifold mark, each line inside its figure", () => {
  const { markStar, markLine, lines } = constellationUniforms;
  expect(skyFigures.length).toBeGreaterThan(1);
  // Contiguous runs from the first star and line up to the mark's.
  expect(skyFigures[0]?.stars[0]).toBe(0);
  expect(skyFigures[0]?.lines[0]).toBe(0);
  expect(skyFigures.at(-1)?.stars[1]).toBe(markStar);
  expect(skyFigures.at(-1)?.lines[1]).toBe(markLine);
  skyFigures.forEach((figure, i) => {
    const next = skyFigures[i + 1];
    if (next) expect([next.stars[0], next.lines[0]]).toEqual([figure.stars[1], figure.lines[1]]);
    for (let line = figure.lines[0]; line < figure.lines[1]; line++)
      for (const end of [lines[line * 2] ?? -1, lines[line * 2 + 1] ?? -1]) {
        expect(end).toBeGreaterThanOrEqual(figure.stars[0]);
        expect(end).toBeLessThan(figure.stars[1]);
      }
  });
});

test("a figure's plane touches the dome at its centre, and its cone holds every star", () => {
  for (const figure of skyFigures) {
    const { centre, right, up } = figure;
    const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    for (const [a, b] of [
      [centre, right],
      [centre, up],
      [right, up],
    ] as const)
      expect(Math.abs(dot(a, b))).toBeLessThan(1e-9);
    for (const v of [centre, right, up]) expect(dot(v, v)).toBeCloseTo(1, 9);
    expect(right[1]).toBe(0); // level: the figures stand upright in a side-on view
    expect(up[1]).toBeGreaterThan(0);
    skyFigurePoint(figure, [0, 0]).forEach((c, i) => expect(c).toBeCloseTo(centre[i] ?? 0, 12));
  }
  for (const { index, dir } of stars) {
    const figure = skyFigures[index];
    if (!figure) throw new Error("no figure");
    // skyFigures' cone test compares the chord with the reach: every star must pass it.
    const chord = Math.hypot(...dir.map((c, i) => c - (figure.centre[i] ?? 0)));
    expect(chord).toBeLessThanOrEqual(figure.reach + 1e-9);
  }
});

test("the figures stand in the forward sky side-on views frame, clear of the midnight moon", () => {
  for (const { dir } of stars) {
    // Above the stars' horizon fade (full from 0.22 rad), at most ~45 degrees up.
    expect(elevation(dir)).toBeGreaterThan(0.22);
    expect(degrees(elevation(dir))).toBeLessThan(45);
    expect(Math.abs(degrees(bearing(dir)))).toBeLessThan(55);
    // Outside the full moon's glare (skyStarFade: full beyond 0.1 rad of the moon).
    expect(angle(dir, midnightMoon)).toBeGreaterThan(0.12);
  }
  // The figures stand upright: Orion's shoulder above his foot.
  const orion = stars.filter((star) => star.index === 0);
  const [shoulder, , , , , , foot] = orion;
  if (!shoulder || !foot) throw new Error("Orion missing");
  expect(elevation(shoulder.dir)).toBeGreaterThan(elevation(foot.dir));
});

test("the GLSL tables are the placed figures, compiled in only behind their gate", () => {
  const spans = [...skyModule.source.matchAll(/ivec4\((\d+), (\d+), (\d+), (\d+)\)/g)].map((m) =>
    m.slice(1, 5).map(Number),
  );
  expect(spans).toEqual(skyFigures.map((figure) => [...figure.stars, ...figure.lines]));
  const shown = (features: Record<string, number>): Set<string> =>
    glslDefinitions(glslActive(skyModule.source, features, true));
  // A scene without the constellations' knob leaves SKY_FIGURES undefined: none of it compiles.
  for (const off of [{}, { SKY_FIGURES: 0 }]) {
    expect(shown(off).has("SKY_FIGURE_COUNT")).toBe(false);
    expect(shown(off).has("skyStars")).toBe(true);
  }
  expect(shown({ SKY_FIGURES: 1 }).has("SKY_FIGURE_COUNT")).toBe(true);
});

test("the planets compile in only behind their gate, the shared planet and its body tier with them", () => {
  const caller = "vec3 sceneSky(Sky s, vec3 c, vec3 d) { return skyGiant(s, c, d, 0.001, 1.0); }";
  const without = modulesFor(caller, {});
  expect(without).toContain(skyModule);
  expect(without).not.toContain(planetModule);
  expect(without).not.toContain(planetBodyModule);
  // The stand-in skyGiant leaves the sky as it is, reading no planet uniform.
  const off = glslActive(skyModule.source, { SKY_PLANETS: 0 }, true);
  expect(glslDefinitions(off).has("skyGiant")).toBe(true);
  expect(glslIdentifiers(off).has("uPlanets")).toBe(false);
  const held = modulesFor(caller, { SKY_PLANETS: 1 });
  expect(held.indexOf(planetModule)).toBeGreaterThan(-1);
  expect(held.indexOf(planetBodyModule)).toBeGreaterThan(held.indexOf(planetModule));
  expect(held.indexOf(skyModule)).toBeGreaterThan(held.indexOf(planetBodyModule));
  expect(glslIdentifiers(glslActive(skyModule.source, { SKY_PLANETS: 1 }, true)).has("uPlanets")).toBe(
    true,
  );
});
