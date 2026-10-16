import { expect, test } from "bun:test";
import { constellationUniforms } from "../../constellations.ts";
import { skyFigurePoint, skyFigures, skyGlsl, skyPlanets } from "./sky.ts";

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

test("the planets: brightest first on the zodiac's band, Venus the evening star with Mercury below", () => {
  expect(skyPlanets.length).toBe(5);
  // On a daily circle between the sun's (-28 degrees) and the moon's (-45 degrees): the declination
  // is the angle from the celestial equator, whose pole is at (0, sin 15, -cos 15).
  const lat = (15 * Math.PI) / 180;
  for (const dir of skyPlanets) {
    const declination = degrees(Math.asin(dir[1] * Math.sin(lat) - dir[2] * Math.cos(lat)));
    expect(declination).toBeLessThanOrEqual(-28);
    expect(declination).toBeGreaterThanOrEqual(-45);
    expect(dir[1]).toBeGreaterThan(0.06); // over the planets' horizon fade
  }
  const [venus, jupiter, saturn, mars, mercury] = skyPlanets;
  if (!venus || !jupiter || !saturn || !mars || !mercury) throw new Error("a planet missing");
  // Venus low on the sunset side (left), Mercury lower still beside it.
  expect(bearing(venus)).toBeLessThan(0);
  expect(degrees(elevation(venus))).toBeLessThan(20);
  expect(elevation(mercury)).toBeLessThan(elevation(venus));
  expect(bearing(mercury)).toBeLessThan(0);
  expect(degrees(angle(mercury, venus))).toBeLessThan(12);
  // None among the figures' stars or on another planet.
  for (const planet of skyPlanets) {
    for (const { dir } of stars) expect(degrees(angle(planet, dir))).toBeGreaterThan(6);
    for (const other of skyPlanets)
      if (other !== planet) expect(degrees(angle(planet, other))).toBeGreaterThan(6);
  }
});

test("the GLSL tables are the placed figures and planets, behind their knobs", () => {
  const spans = [...skyGlsl.matchAll(/ivec4\((\d+), (\d+), (\d+), (\d+)\)/g)].map((m) =>
    m.slice(1, 5).map(Number),
  );
  expect(spans).toEqual(skyFigures.map((figure) => [...figure.stars, ...figure.lines]));
  expect(skyGlsl).toContain(`const int SKY_FIGURES = ${skyFigures.length};`);
  expect(skyGlsl).toContain(`const int SKY_PLANETS = ${skyPlanets.length};`);
  // Both parts compile only into a program with their knob.
  const figures = skyGlsl.indexOf("#ifdef K_constellations");
  const planets = skyGlsl.indexOf("#ifdef K_planets");
  expect(figures).toBeGreaterThan(0);
  expect(skyGlsl.indexOf("float skyFigures(")).toBeGreaterThan(figures);
  expect(skyGlsl.indexOf("float skyPlanets(")).toBeGreaterThan(planets);
});
