import { describe, expect, test } from "bun:test";
import { seasonKnob } from "./climate.ts";
import { sceneDefs } from "./scenes/index.ts";
import {
  DAY_CYCLE_RATE,
  DAY_SECONDS,
  MOON_STAGED_FROM,
  SIDEREAL_TURNS,
  SKY_POLE,
  SUNRISE,
  SUNSET,
  YEAR_DAYS,
  dateShift,
  moonElongation,
  moonPhaseLight,
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

  test("a waning moon is the waxing one mirrored past full, west of the sun: in the morning sky", () => {
    for (const lit of [0.1, 0.5, 0.75])
      for (const tod of hours) {
        const waxing = skyState(tod, { phase: lit });
        const waning = skyState(tod, { phase: 2 - lit });
        expect(waning.moonPhase).toBeCloseTo(lit, 12);
        expect(angle(waning.sun, waning.moon)).toBeCloseTo(moonElongation(lit), 5);
        // The waxing moon mirrored through the sun's hour circle: as far round the pole from the sun
        // the other way, as far from the pole.
        expect(wrapped(roundPole(waning.moon) - roundPole(waning.sun))).toBeCloseTo(
          -wrapped(roundPole(waxing.moon) - roundPole(waxing.sun)),
          5,
        );
        expect(dot(waning.moon, SKY_POLE)).toBeCloseTo(dot(waxing.moon, SKY_POLE), 5);
      }
    // A waning crescent leads the sun up: over the sunrise, down after the sunset.
    const crescent = (tod: number) => skyState(tod, { phase: 1.9 }).moon;
    expect(crescent(SUNRISE - 0.02)[1]).toBeGreaterThan(0.1);
    expect(crescent(SUNSET + 0.02)[1]).toBeLessThan(0);
    // The last quarter rises round midnight and stands high at dawn.
    expect(skyState(SUNRISE, { phase: 1.5 }).moon[1]).toBeGreaterThan(0.7);
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
        // On through full into the waning moon, the way it came, without a jump either side.
        for (let k = steps + 1; k < 2 * steps; k++) {
          const { moon } = skyState(tod, { shift, phase: k / steps });
          worst = Math.max(worst, angle(last, moon));
          last = moon;
        }
      }
    expect((worst * 180) / Math.PI).toBeLessThan(2.5);
  });

  test("lights the land by the measured lunar phase curve, the full moon as staged", () => {
    expect(moonPhaseLight(1)).toBe(1);
    // Allen's curve: a half moon an eleventh of the full moon's light, not the Lambert sphere's third.
    expect(moonPhaseLight(0.5)).toBeCloseTo(0.091, 3);
    expect(moonPhaseLight(0.25)).toBeCloseTo(0.026, 3);
    for (let k = 1; k < 100; k++)
      expect(moonPhaseLight(k / 100)).toBeLessThan(moonPhaseLight((k + 1) / 100));
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

  test("dates every sky that keeps a season, staged as it stands at its default date", () => {
    const seasons = Object.values(sceneDefs).filter((def) => seasonKnob(def.params) !== undefined);
    const anchors = seasons.flatMap((def) => skyAnchor(def.params) ?? []);
    // All but a season knob whose default is no time of year (shanshui's "none").
    expect(anchors.length).toBeGreaterThanOrEqual(seasons.length - 1);
    for (const anchor of anchors) {
      expect(dateShift(anchor, anchor)).toBe(0);
      for (const tod of hours)
        expect(skyNow({ time: tod, days: 0, year: anchor, anchor })).toEqual(skyState(tod));
    }
    // Undated, the date moves nothing.
    expect(dateShift(0.25, -1)).toBe(0);
    expect(dateShift(-1, 0.47)).toBe(0);
  });

  test("raises the full moon over the horizon on every date of every dated scene", () => {
    for (const def of Object.values(sceneDefs)) {
      const anchor = skyAnchor(def.params);
      if (anchor === undefined) continue;
      for (let k = 0; k < 48; k++) {
        const shift = dateShift(k / 48, anchor);
        const top = Math.max(...hours.map((tod) => skyState(tod, { shift }).moon[1]));
        expect(Math.asin(top)).toBeGreaterThan((5 * Math.PI) / 180);
      }
    }
    // The countryside's dates stand as they did: its lowest full moon is above the floor's knee.
    for (let k = 0; k < 48; k++) {
      const shift = dateShift(k / 48, 0.47);
      const midnight = skyState(0, { shift }).moon;
      expect(Math.asin(midnight[1])).toBeGreaterThan((10 * Math.PI) / 180);
    }
  });
});

describe("the stars", () => {
  test("turn about the pole at the sidereal rate, the way the sun goes", () => {
    const pole = starFrame(SKY_POLE, 1.234);
    for (const i of [0, 1, 2] as const) expect(pole[i]).toBeCloseTo(SKY_POLE[i], 6);
    // One solar day of the clock turns them a sidereal day's turn: a 365th of a turn past a whole.
    expect(starTurn(1)).toBeCloseTo(TAU / YEAR_DAYS, 9);
    // One sidereal day brings them back where they stood.
    const back = starTurn(1 / SIDEREAL_TURNS);
    expect(Math.min(back, TAU - back)).toBeCloseTo(0, 9);
    // A star where the sun culminates, a few of the sky's hours on: seen turned round the pole by the
    // sidereal rate, westward as the sun goes, keeping its distance from the pole.
    const star: Vec3 = skyState(0.5).sun;
    for (const motionTime of [10, 30, 60]) {
      const turn = starTurn(motionTime / DAY_SECONDS);
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
    expect(starTurn(0)).toBe(0);
    expect(starTurn(0, 0.47, 0.47)).toBe(0);
    expect(starFrame([0.3, 0.4, 0.866], 0)).toEqual([0.3, 0.4, 0.866]);
    expect(starTurn(0, 0.72, 0.47)).toBeCloseTo(TAU * 0.25, 9);
    expect(skyNow({ time: 0.9, days: 0 }).starTurn).toBe(0);
  });
});

describe("the clock", () => {
  test("carries the time of day round by the days the day cycle has run", () => {
    expect(timeOfDay(0.3, 0)).toBeCloseTo(0.3, 12);
    expect(timeOfDay(0.3, 0.5)).toBeCloseTo(0.8, 12);
    const now = skyNow({ time: 0.3, days: 0.1 });
    const dayLater = skyNow({ time: 0.3, days: 1.1 });
    for (const key of ["day", "twilight", "night"] as const)
      expect(dayLater[key]).toBeCloseTo(now[key], 9);
  });

  test("wraps the day cycle's days where neither the hour nor the stars move", () => {
    const period = DAY_CYCLE_RATE.period ?? Number.NaN;
    for (const days of [0.37, 12.5, 200.01]) {
      expect(timeOfDay(0.3, days + period)).toBeCloseTo(timeOfDay(0.3, days), 9);
      expect(wrapped(starTurn(days + period) - starTurn(days))).toBeCloseTo(0, 9);
    }
  });
});
