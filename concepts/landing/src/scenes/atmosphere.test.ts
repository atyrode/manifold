import { expect, test } from "bun:test";
import { effective } from "../params.ts";
import { skyComponentKnobs, skyKnobs } from "./atmosphere.ts";
import { loadScenes, sceneDefs } from "./index.ts";

const scenes = await loadScenes();

test("constellations: off by default, in the stars' group, a night part", () => {
  const knobs = skyComponentKnobs({ stars: 0.5, constellations: true, group: "night" });
  expect(knobs.map((knob) => knob.key)).toEqual(["stars", "constellations"]);
  const [, constellations] = knobs;
  if (constellations?.kind !== "feature") throw new Error("unexpected knob kind");
  expect(knobs.every((knob) => knob.group === "night")).toBe(true);
  // The shader reads 0 while off, the amount while on.
  expect(effective(constellations, {})).toBe(0);
  expect(effective(constellations, { constellations: 1 })).toBe(0.4);
  expect([constellations.min, constellations.max]).toEqual([0.05, 1]);
  expect(constellations.widget).toEqual({ kind: "night", part: "constellations" });
  // Only when asked, after the other components, and skyKnobs passes it on.
  expect(skyComponentKnobs({ stars: 0.5 }).map((knob) => knob.key)).toEqual(["stars"]);
  expect(skyKnobs({ constellations: true }).map((knob) => knob.key)).toEqual([
    "time",
    "cycle",
    "constellations",
  ]);
});

test("campfire's giant keeps its own keys and defaults, and no part of the night sky", () => {
  const params = sceneDefs.campfire.params;
  const planet = params.find((knob) => knob.key === "planet");
  if (planet?.kind !== "feature") throw new Error("campfire lacks its planet");
  expect([planet.group, planet.on, planet.value, planet.min, planet.max]).toEqual([
    "planet",
    true,
    0.55,
    0.2,
    1,
  ]);
  expect(planet.widget).toBeUndefined();
  expect(params.filter((knob) => knob.key.startsWith("planet")).map((knob) => knob.key)).toEqual([
    "planet",
    "planetAurora",
    "planetAuroraSize",
    "planetLights",
    "planetLightsTwinkle",
    "planetDaycycle",
    "planetMoons",
    "planetEclipses",
  ]);
});

test("every scene whose stars skyStars draws has the constellations, and no other scene has them", () => {
  // A scene's stars come from skyStars when its own GLSL, or a shared library function it calls,
  // reads it: skyStarLight, the canopy's gap sky and the world's sky do.
  const drawers = ["skyStars(", "skyStarLight(", "canopyGapSky(", "worldSky("];
  for (const { id, ...scene } of scenes) {
    const stars = drawers.some((call) => scene.glsl.includes(call));
    const figures = scene.params.some(
      (def) => def.widget?.kind === "night" && def.widget.part === "constellations",
    );
    expect({ id, figures }).toEqual({ id, figures: stars });
  }
});

test("every scene that hangs planets in its sky takes them, keeps no giant's knobs and composes no planet of its own", () => {
  for (const { id, ...scene } of scenes) {
    // skyGiant: the scene's own call, or the world's sky's (worldGlsl is in the scene's GLSL).
    const draws = scene.glsl.includes("skyGiant(");
    expect({ id, takes: scene.planets !== undefined }).toEqual({ id, takes: draws });
    if (!draws) continue;
    expect(
      scene.params.filter((def) => def.key.startsWith("planet")).map((def) => def.key),
    ).toEqual([]);
    // skyGiant compiles the shared planet in itself: a scene's own copy would be a second one.
    expect({ id, own: scene.glsl.includes("struct PlanetLook") }).toEqual({ id, own: false });
    // Its stars come from skyStars, so the planets stand among the scene's own stars.
    expect({ id, figures: scene.params.some((def) => def.key === "constellations") }).toEqual({
      id,
      figures: true,
    });
  }
});
