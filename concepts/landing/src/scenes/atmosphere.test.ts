import { expect, test } from "bun:test";
import { effective } from "../params.ts";
import { skyComponentKnobs, skyKnobs } from "./atmosphere.ts";
import { sceneDefs } from "./index.ts";

const GIANT_KEYS = [
  "planet",
  "planetX",
  "planetY",
  "planetPalette",
  "planetRing",
  "planetAurora",
  "planetAuroraSize",
  "planetLights",
  "planetLightsTwinkle",
  "planetDaycycle",
  "planetMoons",
  "planetEclipses",
];

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

test("the giant planet: off by default, placed in the scene's sky, dressed by knobs that hang off it", () => {
  const knobs = skyComponentKnobs({
    stars: 0.5,
    constellations: true,
    giant: { across: [-40, -10, 30], up: [2, 20, 44] },
    group: "night",
  });
  expect(knobs.map((knob) => knob.key)).toEqual(["stars", "constellations", ...GIANT_KEYS]);
  expect(knobs.every((knob) => knob.group === "night")).toBe(true);
  const byKey = Object.fromEntries(knobs.map((knob) => [knob.key, knob]));
  const { planet, planetX, planetY, planetPalette, planetRing } = byKey;
  if (planet?.kind !== "feature") throw new Error("the giant is no feature");
  // Campfire's key, label and size: 0 while off, 0.55 once on, 0.2..1.
  expect(planet.label).toBe("giant planet");
  expect(effective(planet, {})).toBe(0);
  expect(effective(planet, { planet: 1 })).toBe(0.55);
  expect([planet.min, planet.max]).toEqual([0.2, 1]);
  expect(planet.widget).toEqual({ kind: "night", part: "giant" });
  // The placement pad: degrees across and up, each its scene's stretch and start, a whole degree a step.
  if (planetX?.kind !== "range" || planetY?.kind !== "range") throw new Error("no placement");
  expect([planetX.min, planetX.value, planetX.max, planetX.step]).toEqual([-40, -10, 30, 1]);
  expect([planetY.min, planetY.value, planetY.max, planetY.step]).toEqual([2, 20, 44, 1]);
  expect(planetX.widget).toEqual({ kind: "position", y: "planetY" });
  // Teal (campfire's) first, and the ring on: the giant as campfire draws it.
  if (planetPalette?.kind !== "choice") throw new Error("no palette");
  expect(planetPalette.options.map((option) => option.label)).toEqual([
    "teal",
    "amber",
    "rose",
    "ice",
  ]);
  expect(planetPalette.value).toBe(0);
  expect(planetRing?.kind === "toggle" && planetRing.value).toBe(1);
  // Every other knob of the giant's shows only while it, or one that hangs off it, is on.
  const giant = new Set(GIANT_KEYS);
  for (const key of GIANT_KEYS.slice(1)) {
    const when = byKey[key]?.when;
    expect({ key, hangs: when !== undefined && giant.has(when) }).toEqual({ key, hangs: true });
  }
});

test("campfire's giant keeps its own keys, defaults and help, and no part of the night sky", () => {
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
  expect(planet.help).toBe(
    "A giant banded planet with a storm swirl and a thin ring, low over the far pines, half hidden by the trees; it fades into the sky by day.",
  );
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
  for (const [id, scene] of Object.entries(sceneDefs)) {
    const stars = drawers.some((call) => scene.glsl.includes(call));
    const figures = scene.params.some(
      (def) => def.widget?.kind === "night" && def.widget.part === "constellations",
    );
    expect({ id, figures }).toEqual({ id, figures: stars });
  }
});

test("every scene that hangs the giant in its sky has its knobs, starting in view, and composes no planet of its own", () => {
  for (const [id, scene] of Object.entries(sceneDefs)) {
    // skyGiant: the scene's own call, or the world's sky's (worldGlsl is in the scene's GLSL).
    const draws = scene.glsl.includes("skyGiant(");
    const part = scene.params.some(
      (def) => def.widget?.kind === "night" && def.widget.part === "giant",
    );
    expect({ id, part }).toEqual({ id, part: draws });
    if (!part) continue;
    expect(
      scene.params.filter((def) => def.key.startsWith("planet")).map((def) => def.key),
    ).toEqual(GIANT_KEYS);
    // It starts within its pad's stretch, which runs from below to above it on both axes.
    for (const key of ["planetX", "planetY"]) {
      const def = scene.params.find((knob) => knob.key === key);
      if (def?.kind !== "range") throw new Error(`${id}: no ${key} range`);
      expect({ id, key, inside: def.min < def.value && def.value < def.max }).toEqual({
        id,
        key,
        inside: true,
      });
    }
    // skyGiant compiles the shared planet in itself: a scene's own copy would be a second one.
    expect({ id, own: scene.glsl.includes("struct PlanetLook") }).toEqual({ id, own: false });
    // Its stars come from skyStars, so the giant stands among the scene's own stars.
    expect({ id, figures: scene.params.some((def) => def.key === "constellations") }).toEqual({
      id,
      figures: true,
    });
  }
});
