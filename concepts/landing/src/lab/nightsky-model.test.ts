import { describe, expect, test } from "bun:test";
import { feature, range, type ParamDef } from "../params.ts";
import {
  clickPatch,
  DRAG_SPAN,
  dragPatch,
  isDrag,
  keyPatch,
  NIGHT_STARS,
  nightParts,
  nightSummary,
  starsOut,
  streaksOf,
  type NightPart,
} from "./nightsky-model.ts";

const stars = range("sky", "stars", "stars", 0.6, "help", {
  widget: { kind: "night", part: "stars" },
});
const milkyWay = feature("sky", "milkyWay", "Milky Way", true, "brightness", 1, "help", {
  min: 0.1,
  max: 2,
  widget: { kind: "night", part: "milkyWay" },
});
const meteors = feature("sky", "meteors", "shooting stars", false, "frequency", 0.3, "help", {
  trigger: 1,
  widget: { kind: "night", part: "meteors" },
});
const aurora = feature("sky", "aurora", "aurora", false, "strength", 0.6, "help", {
  widget: { kind: "night", part: "aurora" },
});

function part(def: ParamDef): NightPart {
  const found = nightParts([def])[0];
  if (!found) throw new Error(`${def.key} is no night part`);
  return found;
}

describe("the parts a group holds", () => {
  test("come in the strip's order, whatever the group's", () => {
    const moon = feature("sky", "moon", "moon", true, "phase", 1, "help", {
      widget: { kind: "sky", part: "moon" },
    });
    const parts = nightParts([meteors, moon, milkyWay, aurora, stars]);
    expect(parts.map((each) => each.name)).toEqual(["stars", "aurora", "milkyWay", "meteors"]);
  });

  test("are any subset, and only knobs tagged as night parts of the right kind", () => {
    expect(nightParts([meteors]).map((each) => each.name)).toEqual(["meteors"]);
    const untagged = range("river", "stars", "stars", 0.9, "help");
    const shooting = feature("sky", "shooting", "shooting stars", true, "how often", 0.4, "help");
    expect(nightParts([untagged, shooting])).toEqual([]);
    const switchedStars = feature("sky", "stars", "stars", true, "density", 0.5, "help", {
      widget: { kind: "night", part: "stars" },
    });
    const rangedAurora = range("sky", "aurora", "aurora", 0.5, "help", {
      widget: { kind: "night", part: "aurora" },
    });
    expect(nightParts([switchedStars, rangedAurora])).toEqual([]);
  });
});

describe("a click", () => {
  test("switches a feature on or off and leaves its amount", () => {
    expect(clickPatch(part(meteors), { on: false, amount: 0.3 })).toEqual({ meteors: 1 });
    expect(clickPatch(part(milkyWay), { on: true, amount: 1.4 })).toEqual({ milkyWay: 0 });
  });

  test("does nothing to the stars", () => {
    expect(clickPatch(part(stars), { on: true, amount: 0.6 })).toBeUndefined();
  });

  test("is a press that moves less than a few pixels", () => {
    expect(isDrag(2, -2)).toBe(false);
    expect(isDrag(0, 6)).toBe(true);
  });
});

describe("a drag", () => {
  test("raises the amount right or up and lowers it left or down, by the span per DRAG_SPAN px", () => {
    const sky = part(stars);
    expect(dragPatch(sky, 0.5, DRAG_SPAN / 4, 0)).toEqual({ stars: 0.75 });
    expect(dragPatch(sky, 0.5, 0, -DRAG_SPAN / 4)).toEqual({ stars: 0.75 });
    expect(dragPatch(sky, 0.5, -DRAG_SPAN / 4, 0)).toEqual({ stars: 0.25 });
    expect(dragPatch(sky, 0.5, 0, DRAG_SPAN / 4)).toEqual({ stars: 0.25 });
  });

  test("stops at the ends and snaps to the step", () => {
    expect(dragPatch(part(stars), 0.9, DRAG_SPAN, 0)).toEqual({ stars: 1 });
    expect(dragPatch(part(stars), 0.1, 0, DRAG_SPAN)).toEqual({ stars: 0 });
    expect(dragPatch(part(stars), 0.5, 3, 0)).toEqual({ stars: 0.5 });
    expect(dragPatch(part(milkyWay), 0.1, -DRAG_SPAN, 0)).toEqual({
      milkyWay: 1,
      "milkyWay-amount": 0.1,
    });
  });

  test("switches a feature on with its amount", () => {
    expect(dragPatch(part(aurora), 0.6, DRAG_SPAN / 10, 0)).toEqual({
      aurora: 1,
      "aurora-amount": 0.7,
    });
  });
});

describe("a key", () => {
  test("Space and Enter switch a feature, not the stars", () => {
    expect(keyPatch(part(aurora), { on: false, amount: 0.6 }, " ", undefined)).toEqual({
      aurora: 1,
    });
    expect(keyPatch(part(aurora), { on: true, amount: 0.6 }, "Enter", undefined)).toEqual({
      aurora: 0,
    });
    expect(keyPatch(part(stars), { on: true, amount: 0.6 }, " ", undefined)).toBeUndefined();
  });

  test("steps a lit part's amount, within its ends", () => {
    expect(keyPatch(part(meteors), { on: true, amount: 0.3 }, "ArrowUp", 0.05)).toEqual({
      meteors: 1,
      "meteors-amount": 0.35,
    });
    expect(keyPatch(part(meteors), { on: true, amount: 1 }, "ArrowRight", 0.05)).toEqual({
      meteors: 1,
      "meteors-amount": 1,
    });
    expect(keyPatch(part(stars), { on: true, amount: 0 }, "ArrowDown", -0.05)).toEqual({
      stars: 0,
    });
  });

  test("lights a dark part at the amount it had before stepping it", () => {
    expect(keyPatch(part(milkyWay), { on: false, amount: 1.4 }, "ArrowUp", 0.05)).toEqual({
      milkyWay: 1,
      "milkyWay-amount": 1.4,
    });
  });

  test("Home and End take it to its ends, lit", () => {
    expect(keyPatch(part(milkyWay), { on: false, amount: 1 }, "End", undefined)).toEqual({
      milkyWay: 1,
      "milkyWay-amount": 2,
    });
    expect(keyPatch(part(stars), { on: true, amount: 0.6 }, "Home", undefined)).toEqual({
      stars: 0,
    });
  });

  test("Delete puts a part out and the stars to none", () => {
    expect(keyPatch(part(meteors), { on: true, amount: 0.3 }, "Delete", undefined)).toEqual({
      meteors: 0,
    });
    expect(keyPatch(part(stars), { on: true, amount: 0.6 }, "Backspace", undefined)).toEqual({
      stars: 0,
    });
  });

  test("does nothing for other keys", () => {
    expect(keyPatch(part(meteors), { on: true, amount: 0.3 }, "a", undefined)).toBeUndefined();
  });
});

describe("the strip's stars", () => {
  test("stand within the sky", () => {
    for (const star of NIGHT_STARS)
      for (const value of [star.x, star.y, star.size]) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThan(1);
      }
  });

  test("spread over the whole sky from the first few", () => {
    const quarters = new Set(
      NIGHT_STARS.slice(0, 6).map(
        (star) => `${star.x < 0.5 ? "l" : "r"}${star.y < 0.5 ? "t" : "b"}`,
      ),
    );
    expect(quarters.size).toBe(4);
  });

  test("come out with the density: none at the least, all at the most", () => {
    expect(starsOut(0)).toBe(0);
    expect(starsOut(-0.2)).toBe(0);
    expect(starsOut(1)).toBe(NIGHT_STARS.length);
    expect(starsOut(1.5)).toBe(NIGHT_STARS.length);
    expect(starsOut(0.5, 10)).toBe(5);
  });
});

test("shooting stars draw more streaks the more often they fall, none while off", () => {
  expect(streaksOf(false, 1)).toBe(0);
  expect(streaksOf(true, 0)).toBe(1);
  expect(streaksOf(true, 0.33)).toBe(1);
  expect(streaksOf(true, 1 / 3)).toBe(2);
  expect(streaksOf(true, 2 / 3)).toBe(3);
  expect(streaksOf(true, 1)).toBe(3);
});

describe("the summary", () => {
  const state = (each: NightPart) =>
    each.name === "milkyWay" ? { on: true, amount: 1 } : { on: each.name === "stars", amount: 0.6 };

  test("names the stars and counts the switching parts that are on", () => {
    const all = nightParts([stars, milkyWay, meteors, aurora]);
    expect(nightSummary(all, state)).toBe("stars 60% · 1 of 3 on");
  });

  test("names a lone switching part beside the stars", () => {
    expect(nightSummary(nightParts([stars, milkyWay]), state)).toBe("stars 60% · Milky Way 1.00");
    expect(nightSummary(nightParts([stars, aurora]), state)).toBe("stars 60% · aurora off");
  });

  test("gives a strip of one part (its row names it) as its value alone", () => {
    expect(nightSummary(nightParts([meteors]), state)).toBe("off");
    expect(nightSummary(nightParts([milkyWay]), () => ({ on: true, amount: 1.25 }))).toBe("1.25");
    expect(nightSummary(nightParts([stars]), state)).toBe("60%");
  });
});
