import { describe, expect, test } from "bun:test";
import {
  DAY_MINUTES,
  minutesText,
  speedStops,
  speedText,
  stopOf,
  stopPatch,
  turnMinutes,
  type Cycle,
} from "./speed-model.ts";

// skyKnobs' day cycle (a pace) and the year's cycle (minutes per season), as their knobs hold them.
const day = { min: 0.05, max: 1, step: 0.05 };
const year = { min: 0.5, max: 10, step: 0.5 };
const paces: readonly [Cycle, typeof day][] = [
  ["day", day],
  ["year", year],
];

describe("the slider's stops", () => {
  test("are still, then one for each of the amount's steps", () => {
    expect(speedStops(day)).toBe(20);
    expect(speedStops(year)).toBe(20);
  });

  test("put a cycle that is off at still, whatever amount it keeps", () => {
    expect(stopOf("day", day, false, 0.7)).toBe(0);
    expect(stopOf("year", year, false, 3)).toBe(0);
  });

  test("run from the slowest just past still to the fastest at the right end", () => {
    expect(stopOf("day", day, true, day.min)).toBe(1);
    expect(stopOf("day", day, true, day.max)).toBe(20);
    expect(stopOf("day", day, true, 0.3)).toBe(6);
    // The year's amount is minutes per season: the most minutes are the slowest.
    expect(stopOf("year", year, true, year.max)).toBe(1);
    expect(stopOf("year", year, true, year.min)).toBe(20);
    expect(stopOf("year", year, true, 2)).toBe(17);
  });

  test("go faster at every stop to the right", () => {
    for (const [cycle, pace] of paces)
      for (let stop = 2; stop <= speedStops(pace); stop++) {
        const slower = stopPatch(cycle, pace, "k", stop - 1, 1)["k-amount"] ?? 0;
        const faster = stopPatch(cycle, pace, "k", stop, 1)["k-amount"] ?? 0;
        expect(turnMinutes(cycle, faster)).toBeLessThan(turnMinutes(cycle, slower));
      }
  });

  test("each read back as the stop that set them", () => {
    for (const [cycle, pace] of paces)
      for (let stop = 0; stop <= speedStops(pace); stop++) {
        const patch = stopPatch(cycle, pace, "k", stop, 0.3);
        expect(stopOf(cycle, pace, patch["k"] === 1, patch["k-amount"] ?? 0)).toBe(stop);
      }
  });
});

describe("a stop's patch", () => {
  test("still switches the cycle off and puts its amount back to rest", () => {
    expect(stopPatch("day", day, "cycle", 0, 0.3)).toEqual({ cycle: 0, "cycle-amount": 0.3 });
    expect(stopPatch("year", year, "year", 0, 2)).toEqual({ year: 0, "year-amount": 2 });
  });

  test("any other stop switches the cycle on at that stop's amount, in the URL's keys", () => {
    expect(stopPatch("day", day, "cycle", 1, 0.3)).toEqual({ cycle: 1, "cycle-amount": 0.05 });
    expect(stopPatch("day", day, "cycle", 20, 0.3)).toEqual({ cycle: 1, "cycle-amount": 1 });
    expect(stopPatch("year", year, "year", 1, 2)).toEqual({ year: 1, "year-amount": 10 });
    expect(stopPatch("year", year, "year", 20, 2)).toEqual({ year: 1, "year-amount": 0.5 });
  });

  test("keeps a stop past either end at that end", () => {
    expect(stopPatch("day", day, "cycle", 99, 0.3)).toEqual({ cycle: 1, "cycle-amount": 1 });
    expect(stopPatch("day", day, "cycle", -2, 0.3)).toEqual({ cycle: 0, "cycle-amount": 0.3 });
  });
});

describe("in words", () => {
  test("a still cycle is still", () => {
    expect(speedText("day", false, 0.3)).toBe("still");
    expect(speedText("year", false, 2)).toBe("still");
  });

  test("a day takes DAY_MINUTES at pace 1, longer as the pace falls", () => {
    expect(speedText("day", true, 1)).toBe(`a day in ${minutesText(DAY_MINUTES)}`);
    expect(speedText("day", true, 0.5)).toBe(`a day in ${minutesText(2 * DAY_MINUTES)}`);
    expect(speedText("day", true, 0.05)).toBe(`a day in ${minutesText(20 * DAY_MINUTES)}`);
  });

  test("a season takes its minutes", () => {
    expect(speedText("year", true, 2)).toBe("a season in 2 min");
    expect(speedText("year", true, 0.5)).toBe("a season in 30 s");
  });

  test("a span of minutes reads in seconds, minutes or hours", () => {
    expect(minutesText(0.25)).toBe("15 s");
    expect(minutesText(4.44)).toBe("4.4 min");
    expect(minutesText(7)).toBe("7 min");
    expect(minutesText(26.7)).toBe("27 min");
    expect(minutesText(60)).toBe("1 h");
    expect(minutesText(125)).toBe("2 h 5 min");
  });
});
