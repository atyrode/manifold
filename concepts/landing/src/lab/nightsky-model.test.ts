import { describe, expect, test } from "bun:test";
import { feature, range, toggle, type ParamDef } from "../params.ts";
import { giantKnobs } from "../scenes/planet.ts";
import type { FeatureDef, RangeDef } from "./knobs.ts";
import {
  amountKey,
  clickPatch,
  giantDress,
  giantLook,
  isNight,
  MOON_PHASES,
  moonPatch,
  moonPath,
  NIGHT_STARS,
  NIGHT_TIME,
  nightCompanions,
  nightParts,
  nightPatch,
  nightSummary,
  partShows,
  partValue,
  phaseIndex,
  phaseOf,
  starsOut,
  streaksOf,
  type NightPart,
  type PartState,
} from "./nightsky-model.ts";

const stars = range("sky", "stars", "stars", 0.6, "help", {
  widget: { kind: "night", part: "stars" },
});
const moon = feature("sky", "moon", "moon", true, "phase", 1, "help", {
  min: 0.05,
  max: 1,
  widget: { kind: "night", part: "moon" },
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
// As the contract builds them (skyComponentKnobs), before any scene has them.
const constellations = feature(
  "sky",
  "constellations",
  "constellations",
  false,
  "lines",
  0.4,
  "help",
  {
    min: 0.05,
    max: 1,
    widget: { kind: "night", part: "constellations" },
  },
);
// The sky giant as giantKnobs builds it, its switch first.
const giantDefs = giantKnobs({ group: "sky", sky: { across: [-40, -10, 30], up: [2, 20, 44] } });
const [giant] = giantDefs;
if (!giant) throw new Error("giantKnobs gave no switch");
const time = range("sky", "time", "time of day", 0.5, "help", {
  widget: { kind: "sky", part: "time" },
});
const cycle = feature("sky", "cycle", "day cycle", false, "speed", 0.3, "help", {
  widget: { kind: "sky", part: "cycle" },
});

function part(def: ParamDef): NightPart {
  const found = nightParts([def])[0];
  if (!found) throw new Error(`${def.key} is no night part`);
  return found;
}

function featureDef(def: ParamDef): FeatureDef {
  if (def.kind !== "feature") throw new Error(`${def.key} is no feature`);
  return def;
}

function rangeDef(def: ParamDef): RangeDef {
  if (def.kind !== "range") throw new Error(`${def.key} is no range`);
  return def;
}

const all = [giant, meteors, aurora, constellations, moon, milkyWay, stars];

describe("the parts a group holds", () => {
  test("come in the section's order, whatever the group's", () => {
    expect(nightParts(all).map((each) => each.name)).toEqual([
      "moon",
      "stars",
      "milkyWay",
      "constellations",
      "giant",
      "aurora",
      "meteors",
    ]);
  });

  test("are any subset, and only knobs tagged as night parts of the right kind", () => {
    expect(nightParts([meteors, giant]).map((each) => each.name)).toEqual(["giant", "meteors"]);
    const untagged = range("river", "stars", "stars", 0.9, "help");
    const shooting = feature("sky", "shooting", "shooting stars", true, "how often", 0.4, "help");
    // The almanac's old tag: the moon is a night part only as one.
    const almanacMoon = feature("sky", "moon", "moon", true, "phase", 1, "help", {
      widget: { kind: "sky", part: "moon" },
    });
    expect(nightParts([untagged, shooting, almanacMoon])).toEqual([]);
    const switchedStars = feature("sky", "stars", "stars", true, "density", 0.5, "help", {
      widget: { kind: "night", part: "stars" },
    });
    const rangedMoon = range("sky", "moon", "moon", 0.5, "help", {
      widget: { kind: "night", part: "moon" },
    });
    expect(nightParts([switchedStars, rangedMoon])).toEqual([]);
  });

  test("keep their amount under the stars' own key or a feature's amount key", () => {
    expect(amountKey(part(stars))).toBe("stars");
    expect(amountKey(part(giant))).toBe("planet-amount");
  });
});

describe("a part's companions", () => {
  test("are the group's knobs that hang off its switch, at any remove, in the group's order", () => {
    const group: ParamDef[] = [...giantDefs, ...all.slice(1)];
    expect(nightCompanions(part(giant), group).map((def) => def.key)).toEqual(
      giantDefs.slice(1).map((def) => def.key),
    );
    // A knob hanging off one that comes after it in the group still belongs.
    const late = toggle("sky", "late", "late", false, "help", { when: "planetEclipses" });
    expect(nightCompanions(part(giant), [late, ...group]).map((def) => def.key)).toContain("late");
  });

  test("are none for a part nothing hangs off, nor for the stars", () => {
    const free = range("sky", "free", "free", 0.5, "help", { when: "cycle" });
    expect(nightCompanions(part(meteors), [meteors, free, ...giantDefs])).toEqual([]);
    const dimmer = range("sky", "dimmer", "dimmer", 0.5, "help", { when: "stars" });
    expect(nightCompanions(part(stars), [stars, dimmer])).toEqual([]);
  });
});

describe("a click on a drawn part", () => {
  test("switches a feature on or off and leaves its amount", () => {
    expect(clickPatch(part(constellations), { on: false, amount: 0.4 })).toEqual({
      constellations: 1,
    });
    expect(clickPatch(part(moon), { on: true, amount: 0.5 })).toEqual({ moon: 0 });
  });

  test("does nothing to the stars", () => {
    expect(clickPatch(part(stars), { on: true, amount: 0.6 })).toBeUndefined();
  });
});

describe("the moon's phases", () => {
  test("go from a crescent to full, each setting more of the moon lit", () => {
    expect(MOON_PHASES.map((phase) => phase.name)).toEqual([
      "crescent",
      "quarter",
      "gibbous",
      "full",
    ]);
    for (const [index, phase] of MOON_PHASES.entries())
      expect(phase.lit).toBeGreaterThan(MOON_PHASES[index - 1]?.lit ?? 0);
  });

  test("each read as their own phase once set", () => {
    for (const [index] of MOON_PHASES.entries()) {
      const patch = moonPatch(featureDef(moon), index);
      expect(patch["moon"]).toBe(1);
      expect(phaseIndex(patch["moon-amount"] ?? -1)).toBe(index);
    }
  });

  test("take any lit share to the phase it looks like", () => {
    expect(phaseIndex(0.05)).toBe(0);
    expect(phaseIndex(0.39)).toBe(0);
    expect(phaseIndex(0.4)).toBe(1);
    expect(phaseIndex(0.6)).toBe(2);
    expect(phaseIndex(0.91)).toBe(2);
    expect(phaseIndex(0.92)).toBe(3);
    expect(phaseIndex(1)).toBe(3);
  });

  test("name the phase as the tiles do, and a sliver as a thin crescent", () => {
    expect(phaseOf(0.1)).toBe("thin crescent");
    expect(phaseOf(0.25)).toBe("crescent");
    expect(phaseOf(0.5)).toBe("quarter moon");
    expect(phaseOf(0.8)).toBe("gibbous");
    expect(phaseOf(1)).toBe("full moon");
  });

  test("set the lit share within the knob's own range and step", () => {
    const late = featureDef(
      feature("sky", "moon", "moon", true, "phase", 1, "help", {
        min: 0.3,
        max: 0.9,
        step: 0.2,
        widget: { kind: "night", part: "moon" },
      }),
    );
    expect(moonPatch(late, 0)).toEqual({ moon: 1, "moon-amount": 0.3 });
    expect(moonPatch(late, 3)).toEqual({ moon: 1, "moon-amount": 0.9 });
  });

  test("off puts the moon out and keeps its phase", () => {
    expect(moonPatch(featureDef(moon), undefined)).toEqual({ moon: 0 });
  });

  test("draw a crescent and a gibbous moon bulging opposite ways, a full moon whole", () => {
    const terminator = (d: string) => d.split("A")[2];
    expect(terminator(moonPath(8, 0.25))).not.toBe(terminator(moonPath(8, 0.75)));
    expect(moonPath(8, 1)).toBe(moonPath(8, 0.999));
    expect(moonPath(8, 1)).not.toBe(moonPath(8, 0.9));
  });
});

describe("the drawn sky", () => {
  test("stands its stars within the sky", () => {
    for (const star of NIGHT_STARS)
      for (const value of [star.x, star.y, star.size]) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThan(1);
      }
  });

  test("spreads the first few stars over the whole sky", () => {
    const quarters = new Set(
      NIGHT_STARS.slice(0, 6).map(
        (star) => `${star.x < 0.5 ? "l" : "r"}${star.y < 0.5 ? "t" : "b"}`,
      ),
    );
    expect(quarters.size).toBe(4);
  });

  test("brings the stars out with the density: none at the least, all at the most", () => {
    expect(starsOut(0)).toBe(0);
    expect(starsOut(-0.2)).toBe(0);
    expect(starsOut(1)).toBe(NIGHT_STARS.length);
    expect(starsOut(1.5)).toBe(NIGHT_STARS.length);
    expect(starsOut(0.5, 10)).toBe(5);
  });

  test("draws more streaks the more often stars shoot, none while off", () => {
    expect(streaksOf(false, 1)).toBe(0);
    expect(streaksOf(true, 0)).toBe(1);
    expect(streaksOf(true, 0.33)).toBe(1);
    expect(streaksOf(true, 1 / 3)).toBe(2);
    expect(streaksOf(true, 2 / 3)).toBe(3);
    expect(streaksOf(true, 1)).toBe(3);
  });

  test("stands the giant where its pad puts it, as big as its size, dressed as its knobs say", () => {
    const def = featureDef(giant);
    const dress = giantDress(def, nightCompanions(part(giant), giantDefs));
    expect([dress.across?.key, dress.up?.key]).toEqual(["planetX", "planetY"]);
    expect([dress.ring?.key, dress.moons?.key, dress.palette?.key]).toEqual([
      "planetRing",
      "planetMoons",
      "planetPalette",
    ]);
    const values: Record<string, number> = {
      planetX: -40,
      planetY: 44,
      "planet-amount": 0.6,
      planetRing: 0,
      planetMoons: 1,
      "planetMoons-amount": 3,
      planetPalette: 2,
    };
    const look = giantLook(def, dress, (key) => values[key] ?? 0);
    expect(look).toMatchObject({ x: 0, y: 1, ring: false, moons: 3, palette: "rose" });
    expect(look.size).toBeCloseTo(0.5);
    // Its starting place, ringed, its moons off, in teal; past the pad's ends it stays at its edge.
    const start = (key: string) =>
      ({ planetX: -10, planetY: 20, "planet-amount": 0.55, planetRing: 1, planetMoons: 0 })[key] ??
      0;
    expect(giantLook(def, dress, start)).toMatchObject({ ring: true, moons: 0, palette: "teal" });
    expect(giantLook(def, dress, start).x).toBeCloseTo(30 / 70);
    expect(giantLook(def, dress, start).y).toBeCloseTo(18 / 42);
    expect(giantLook(def, dress, (key) => (key === "planetX" ? 99 : 0)).x).toBe(1);
  });

  test("stands a giant without its dress in the middle of the sky, ringed", () => {
    const bare = featureDef(giant);
    expect(giantLook(bare, giantDress(bare, []), () => 1)).toMatchObject({
      x: 0.5,
      y: 0.5,
      ring: true,
      moons: 0,
      palette: "",
    });
  });
});

describe("in words", () => {
  test("a part reads as its phase, its count or its amount, and off while off", () => {
    expect(partValue(part(moon), { on: true, amount: 0.5 })).toBe("quarter moon");
    expect(partValue(part(moon), { on: false, amount: 0.5 })).toBe("off");
    expect(partValue(part(giant), { on: true, amount: 0.6 })).toBe("60%");
    expect(partValue(part(giant), { on: false, amount: 0.6 })).toBe("off");
    expect(partValue(part(constellations), { on: true, amount: 0.4 })).toBe("40%");
    expect(partValue(part(stars), { on: true, amount: 0.6 })).toBe("60%");
    expect(partValue(part(milkyWay), { on: true, amount: 1.25 })).toBe("1.25");
  });

  test("the stars show while any are out, a feature while on", () => {
    expect(partShows(part(stars), { on: true, amount: 0 })).toBe(false);
    expect(partShows(part(stars), { on: true, amount: 0.05 })).toBe(true);
    expect(partShows(part(aurora), { on: false, amount: 0.6 })).toBe(false);
  });

  test("the section counts the parts that show", () => {
    const state = (each: NightPart): PartState =>
      each.name === "stars"
        ? { on: true, amount: 0.6 }
        : { on: each.name === "moon" || each.name === "milkyWay", amount: 1 };
    expect(nightSummary(nightParts(all), state)).toBe("3 of 7 out");
    expect(nightSummary(nightParts([stars, aurora]), () => ({ on: true, amount: 0 }))).toBe(
      "1 of 2 out",
    );
  });

  test("a section of one part reads as that part", () => {
    expect(nightSummary(nightParts([meteors]), () => ({ on: false, amount: 0.3 }))).toBe("off");
    expect(nightSummary(nightParts([moon]), () => ({ on: true, amount: 1 }))).toBe("full moon");
  });
});

describe("See it at night", () => {
  const clock = { time: rangeDef(time), cycle: featureDef(cycle) };

  test("is night past dusk and before dawn, round the clock", () => {
    for (const night of [0, 0.1, 0.19, 0.81, NIGHT_TIME, 1.95, -0.05])
      expect(isNight(night)).toBe(true);
    for (const day of [0.2, 0.25, 0.5, 0.75, 0.8, 1.5]) expect(isNight(day)).toBe(false);
  });

  test("sets a night hour by day, and leaves the day cycle alone while it stands", () => {
    expect(nightPatch(clock, 0.5, false)).toEqual({ time: NIGHT_TIME });
    expect(nightPatch(clock, 0.74, false)).toEqual({ time: NIGHT_TIME });
  });

  test("is not needed while the clock stands at night", () => {
    expect(nightPatch(clock, 0.9, false)).toBeUndefined();
    expect(nightPatch(clock, 0.1, false)).toBeUndefined();
  });

  test("stops a passing day at night, whatever hour it passes from", () => {
    expect(nightPatch(clock, 0.5, true)).toEqual({ time: NIGHT_TIME, cycle: 0 });
    expect(nightPatch(clock, 0.9, true)).toEqual({ time: NIGHT_TIME, cycle: 0 });
    expect(nightPatch({ time: rangeDef(time), cycle: undefined }, 0.5, true)).toEqual({
      time: NIGHT_TIME,
    });
  });

  test("lands on a night hour whatever the time knob's step", () => {
    const coarse = rangeDef(
      range("sky", "time", "time of day", 0.5, "help", {
        step: 0.1,
        widget: { kind: "sky", part: "time" },
      }),
    );
    const patch = nightPatch({ time: coarse, cycle: undefined }, 0.5, false);
    expect(isNight(patch?.["time"] ?? 0.5)).toBe(true);
  });
});
