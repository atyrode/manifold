import { describe, expect, test } from "bun:test";
import { sceneDefs } from "./scenes/index.ts";
import {
  DAY_SECONDS,
  MOON_STAGED_FROM,
  SIDEREAL_TURNS,
  SKY_POLE,
  SUNRISE,
  SUNSET,
  YEAR_DAYS,
  dateShift,
  moonElongation,
  skyAnchor,
  skyNow,
  skyState,
  starFrame,
  starTurn,
  sunDeclination,
  timeOfDay,
} from "./world-clock.ts";

type Vec3 = readonly [number, number, number];

const TAU = 2 * Math.PI;
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const angle = (a: Vec3, b: Vec3): number => Math.acos(Math.min(1, Math.max(-1, dot(a, b))));
/** A direction's angle round the pole: 0 on the meridian ahead, positive to the right. */
const roundPole = (v: Vec3): number => Math.atan2(v[0], dot(v, [0, -SKY_POLE[2], SKY_POLE[1]]));
const wrapped = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));
const hours = Array.from({ length: 48 }, (_, i) => i / 48);

describe("the moon", () => {
  test("stands as far from the sun as its lit share needs, every hour and date, short of full", () => {
    for (const phase of [0.05, 0.1, 0.25, 0.5, 0.75, MOON_STAGED_FROM])
      for (const shift of [0, dateShift(0.25, 0.47), dateShift(0.75, 0.47)])
        for (const tod of hours) {
          const sky = skyState(tod, { phase, shift });
          // The share of its disc the sun lights at that elongation, (1 - cos E) / 2, to the
          // precision of the sky's six-figure constants.
          expect((1 - Math.cos(angle(sky.sun, sky.moon))) / 2).toBeCloseTo(phase, 5);
          expect(angle(sky.sun, sky.moon)).toBeCloseTo(moonElongation(phase), 5);
          expect(sky.moonPhase).toBe(phase);
        }
  });

  test("a waxing crescent trails the sun: up over the sunset, down before the sunrise", () => {
    const crescent = (tod: number) => skyState(tod, { phase: 0.1 }).moon;
    expect(crescent(SUNSET + 0.02)[1]).toBeGreaterThan(0.1);
    expect(crescent(SUNRISE - 0.02)[1]).toBeLessThan(0);
    // It rises after the sun does and sets after it.
    expect(crescent(SUNRISE)[1]).toBeLessThan(0);
    expect(crescent(SUNSET)[1]).toBeGreaterThan(0);
  });

  test("full is the staged moon every picture is tuned to: 30 degrees up straight ahead at midnight", () => {
    const midnight = skyState(0).moon;
    expect(midnight[0]).toBeCloseTo(0, 6);
    expect(Math.asin(midnight[1])).toBeCloseTo(Math.PI / 6, 4);
    for (const tod of hours) expect(skyState(tod, { phase: 1 })).toEqual(skyState(tod));
  });

  test("runs on with its phase from the thinnest crescent into the staged full moon", () => {
    // Adjacent thousandths of the phase move it under 2.5 degrees, where it used to jump 73 to 79
    // degrees from 0.999 to full. Phase 0 is no moon, put away (below).
    const steps = 1000;
    let worst = 0;
    for (const shift of [0, dateShift(0.25, 0.47), dateShift(0.75, 0.47)])
      for (const tod of hours) {
        let last = skyState(tod, { shift, phase: 1 / steps }).moon;
        for (let k = 2; k <= steps; k++) {
          const { moon } = skyState(tod, { shift, phase: k / steps });
          worst = Math.max(worst, angle(last, moon));
          last = moon;
        }
        expect(last).toEqual(skyState(tod, { shift }).moon);
      }
    expect((worst * 180) / Math.PI).toBeLessThan(2.5);
  });

  test("a lesser moon lights the land less, and no moon none, put away below the horizon", () => {
    const tod = 0.85;
    const lum = (phase: number) => {
      const [r, g, b] = skyState(tod, { phase }).moonColor;
      return r + g + b;
    };
    expect(lum(0.5)).toBeLessThan(lum(1));
    expect(lum(0.25)).toBeLessThan(lum(0.5));
    expect(lum(0)).toBe(0);
    expect(skyState(tod, { phase: 0 }).moon[1]).toBeLessThan(-0.5);
    expect(skyState(tod, { phase: 0 }).ambient[2]).toBeLessThan(skyState(tod).ambient[2]);
  });
});

describe("the date", () => {
  test("moves the sun's noon height with its declination across the year", () => {
    const anchor = 0.47;
    const noon = (year: number) => skyState(0.5, { shift: dateShift(year, anchor) }).sun;
    const staged = Math.asin(noon(anchor)[1]);
    // Dates the sky reads as they are: it reads the date in ten-thousandths of a year.
    for (let k = 0; k < 25; k++) {
      const year = k / 25;
      const sun = noon(year);
      // Noon is the culmination, straight ahead, as much higher than on the staged date as the
      // sun's declination has moved toward the pole since.
      expect(sun[0]).toBeCloseTo(0, 9);
      const moved = sunDeclination(year) - sunDeclination(anchor);
      expect(Math.asin(sun[1]) - staged).toBeCloseTo(moved, 5);
    }
    // Midsummer's noon stands twice Earth's tilt over midwinter's.
    const swing = Math.asin(noon(0.25)[1]) - Math.asin(noon(0.75)[1]);
    expect(swing).toBeCloseTo((2 * 23.44 * Math.PI) / 180, 5);
  });

  test("keeps sunrise at .25 and sunset at .75 on every date", () => {
    for (let year = 0; year < 1; year += 1 / 12) {
      const shift = dateShift(year, 0.625);
      expect(skyState(SUNRISE, { shift }).sun[1]).toBeCloseTo(0, 6);
      expect(skyState(SUNSET, { shift }).sun[1]).toBeCloseTo(0, 6);
      expect(skyState(0.5, { shift }).day).toBe(1);
      expect(skyState(0, { shift }).night).toBe(1);
    }
  });

  test("dates the skies whose season sets their climate, staged as they stand at their default date", () => {
    const anchors = Object.values(sceneDefs).flatMap((def) => skyAnchor(def.params) ?? []);
    expect(anchors.length).toBeGreaterThan(0);
    for (const anchor of anchors) {
      expect(dateShift(anchor, anchor)).toBe(0);
      for (const tod of hours)
        expect(skyNow({ time: tod, cycle: 0, motionTime: 0, year: anchor, anchor })).toEqual(
          skyState(tod),
        );
    }
    // Undated, the date moves nothing.
    expect(dateShift(0.25, -1)).toBe(0);
    expect(dateShift(-1, 0.47)).toBe(0);
  });
});

describe("the stars", () => {
  test("turn about the pole at the sidereal rate, the way the sun goes", () => {
    const pole = starFrame(SKY_POLE, 1.234);
    for (const i of [0, 1, 2] as const) expect(pole[i]).toBeCloseTo(SKY_POLE[i], 6);
    // One solar day of the clock turns them a sidereal day's turn: a 365th of a turn past a whole.
    expect(starTurn(1, DAY_SECONDS)).toBeCloseTo(TAU / YEAR_DAYS, 9);
    expect(starTurn(0.3, DAY_SECONDS / 0.3)).toBeCloseTo(TAU / YEAR_DAYS, 9);
    // One sidereal day brings them back where they stood.
    const back = starTurn(1, DAY_SECONDS / SIDEREAL_TURNS);
    expect(Math.min(back, TAU - back)).toBeCloseTo(0, 9);
    // A star where the sun culminates, a few of the sky's hours on: seen turned round the pole by the
    // sidereal rate, westward as the sun goes, keeping its distance from the pole.
    const star: Vec3 = skyState(0.5).sun;
    for (const motionTime of [10, 30, 60]) {
      const turn = starTurn(1, motionTime);
      // Where the star is seen now: the direction whose stars' frame holds it.
      const seen = starFrame(star, -turn);
      expect(dot(seen, SKY_POLE)).toBeCloseTo(dot(star, SKY_POLE), 6);
      expect(wrapped(roundPole(star) - roundPole(seen))).toBeCloseTo(
        (TAU * SIDEREAL_TURNS * motionTime) / DAY_SECONDS,
        9,
      );
      expect(seen[0]).toBeLessThan(0);
    }
  });

  test("stand as staged while the day cycle is off and the date as staged, and turn once a year", () => {
    expect(starTurn(0, 1234)).toBe(0);
    expect(starTurn(0, 1234, 0.47, 0.47)).toBe(0);
    expect(starFrame([0.3, 0.4, 0.866], 0)).toEqual([0.3, 0.4, 0.866]);
    expect(starTurn(0, 0, 0.72, 0.47)).toBeCloseTo(TAU * 0.25, 9);
    expect(skyNow({ time: 0.9, cycle: 0, motionTime: 500 }).starTurn).toBe(0);
  });
});

describe("the clock", () => {
  test("carries the time of day round on the motion clock, a day in DAY_SECONDS at cycle 1", () => {
    expect(timeOfDay(0.3, 0, 999)).toBeCloseTo(0.3, 12);
    expect(timeOfDay(0.3, 1, DAY_SECONDS / 2)).toBeCloseTo(0.8, 12);
    const now = skyNow({ time: 0.3, cycle: 0.5, motionTime: 37 });
    const dayLater = skyNow({ time: 0.3, cycle: 0.5, motionTime: 37 + DAY_SECONDS / 0.5 });
    for (const key of ["day", "twilight", "night"] as const)
      expect(dayLater[key]).toBeCloseTo(now[key], 9);
  });
});
