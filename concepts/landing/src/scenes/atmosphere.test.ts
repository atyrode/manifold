import { expect, test } from "bun:test";
import { effective } from "../params.ts";
import { skyComponentKnobs, skyKnobs } from "./atmosphere.ts";
import { sceneDefs } from "./index.ts";

test("constellations and planets: off by default, in the stars' group, as the night strip's parts", () => {
  const knobs = skyComponentKnobs({
    stars: 0.5,
    constellations: true,
    planets: true,
    group: "night",
  });
  expect(knobs.map((knob) => knob.key)).toEqual(["stars", "constellations", "planets"]);
  const [, constellations, planets] = knobs;
  if (constellations?.kind !== "feature" || planets?.kind !== "feature")
    throw new Error("unexpected knob kinds");
  expect(knobs.every((knob) => knob.group === "night")).toBe(true);
  // The shader reads 0 while off, the amount while on.
  expect(effective(constellations, {})).toBe(0);
  expect(effective(constellations, { constellations: 1 })).toBe(0.4);
  expect([constellations.min, constellations.max]).toEqual([0.05, 1]);
  expect(effective(planets, {})).toBe(0);
  expect(effective(planets, { planets: 1 })).toBe(2);
  // How many planets, brightest first, one to five.
  expect(planets.options?.map((option) => option.value)).toEqual([1, 2, 3, 4, 5]);
  expect([planets.min, planets.max]).toEqual([1, 5]);
  expect(constellations.widget).toEqual({ kind: "night", part: "constellations" });
  expect(planets.widget).toEqual({ kind: "night", part: "planets" });
  // Only when asked, after the other components, and skyKnobs passes them on.
  expect(skyComponentKnobs({ stars: 0.5 }).map((knob) => knob.key)).toEqual(["stars"]);
  expect(skyKnobs({ constellations: true }).map((knob) => knob.key)).toEqual([
    "time",
    "cycle",
    "constellations",
  ]);
});

test("every scene whose stars skyStars draws has both night parts, and no other scene has them", () => {
  // A scene's stars come from skyStars when its own GLSL, or a shared library function it calls,
  // reads it: skyStarLight, the canopy's gap sky and the world's sky do.
  const drawers = ["skyStars(", "skyStarLight(", "canopyGapSky(", "worldSky("];
  for (const [id, scene] of Object.entries(sceneDefs)) {
    const stars = drawers.some((call) => scene.glsl.includes(call));
    const parts = ["constellations", "planets"].map((part) =>
      scene.params.some((def) => def.widget?.kind === "night" && def.widget.part === part),
    );
    expect({ id, parts }).toEqual({ id, parts: [stars, stars] });
  }
});
