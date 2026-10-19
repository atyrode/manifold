import { expect, test } from "bun:test";
import { effective } from "../params.ts";
import { worldGlsl } from "../shaders/lib/world.ts";
import { skyComponentKnobs, skyKnobs } from "./atmosphere.ts";
import { openingPlanets } from "./planets.ts";
import { loadScenes, sceneDefs } from "./index.ts";

const scenes = await loadScenes();

test("constellations: off by default, in the stars' group, a night part, star-joining after them", () => {
  const knobs = skyComponentKnobs({ stars: 0.5, constellations: true, group: "night" });
  expect(knobs.map((knob) => knob.key)).toEqual(["stars", "constellations", "join"]);
  const [, constellations, join] = knobs;
  if (constellations?.kind !== "feature" || join?.kind !== "feature")
    throw new Error("unexpected knob kind");
  expect(knobs.every((knob) => knob.group === "night")).toBe(true);
  // The shader reads 0 while off, the amount while on.
  expect(effective(constellations, {})).toBe(0);
  expect(effective(constellations, { constellations: 1 })).toBe(0.4);
  expect([constellations.min, constellations.max]).toEqual([0.05, 1]);
  expect(constellations.widget).toEqual({ kind: "night", part: "constellations" });
  // The agents' chore: on at all six figures, a control of its own hanging on the figures.
  expect(effective(join, {})).toBe(6);
  expect(effective(join, { join: 0 })).toBe(0);
  expect([join.min, join.max, join.when, join.widget]).toEqual([1, 6, "constellations", undefined]);
  // Only when asked, after the other components, and skyKnobs passes it on.
  expect(skyComponentKnobs({ stars: 0.5 }).map((knob) => knob.key)).toEqual(["stars"]);
  expect(skyKnobs({ constellations: true }).map((knob) => knob.key)).toEqual([
    "time",
    "cycle",
    "constellations",
    "join",
  ]);
});

test("campfire opens with its giant as the first of the World's planets, and no giant's knobs", () => {
  const scene = sceneDefs.campfire;
  const spec = scene.planets;
  if (spec === undefined) throw new Error("campfire takes no planets");
  const [giant, ...rest] = openingPlanets(spec);
  expect(rest).toEqual([]);
  // The banded giant with its thin ring, in its first palette, still among the stars, lit from the
  // upper left: the planet the campfire composed itself before it took the World's.
  const look = ["kind", "ring", "palette", "orbit", "phases"].map((key) => giant?.[key]);
  expect(look).toEqual([0, 1, 0, 0, 0]);
  expect([giant?.["across"], giant?.["up"]]).toEqual([spec.across[1], spec.up[1]]);
  const giantKnobs = scene.params.filter((knob) => knob.key.startsWith("planet"));
  expect(giantKnobs.map((knob) => knob.key)).toEqual([]);
});

test("every scene whose stars skyStars draws has the constellations, and no other scene has them", () => {
  // A scene's stars come from skyStars when its own GLSL, or a shared library function it calls,
  // reads it: skyStarLight, the canopy's gap sky and the world's sky do. The World's library is left
  // out, as below: a composed scene carries it whole, a room with no glass in frame without calling
  // its sky.
  const drawers = ["skyStars(", "skyStarLight(", "canopyGapSky(", "worldSky("];
  // Two outdoor scenes list the World's whole sky without drawing it: the dewy web's stars are lost
  // in the blur behind it (its weather heading says so), the garden's horizon is the frame's top
  // edge. Their figures stand for the World's night they share, not for stars they draw.
  const blurred = new Set(["dew", "garden"]);
  for (const { id, ...scene } of scenes) {
    const own = scene.glsl.replace(worldGlsl, "");
    const stars = drawers.some((call) => own.includes(call)) || blurred.has(id);
    const figures = scene.params.some(
      (def) => def.widget?.kind === "night" && def.widget.part === "constellations",
    );
    expect({ id, figures }).toEqual({ id, figures: stars });
  }
});

test("every scene that hangs planets in its sky takes them, keeps no giant's knobs and composes no planet of its own", () => {
  for (const { id, ...scene } of scenes) {
    // skyGiant: the scene's own call, or the World's sky's where the scene draws it (worldSky). The
    // World's library (worldGlsl) is left out: a composed scene carries it whole, its worldSky and
    // worldMirrorSky calling skyGiant whether the scene draws them or not, as the composer's mirror
    // falls back on worldMirrorSky whether a ground calls it or not. The garden draws neither: its
    // horizon is the frame's top edge, its top band the haze below it.
    const own = scene.glsl.replace(worldGlsl, "");
    const draws = own.includes("skyGiant(") || own.includes("worldSky(");
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
