// A planet in space: rings, moons, aurora, meteors, and real constellations behind it (their
// figures reach the shader as the uCon* uniforms, see constellations.ts). The planet is the shared one
// (shaders/lib/planet.ts, knobs from ../planet.ts) with every feature, as the subject.
import { feature, range, toggle } from "../../params.ts";
import { planetGroups, planetKnobs } from "../planet.ts";
import type { SceneDef } from "../types.ts";
import { ORBIT_PASSAGE, orbitGlsl } from "./shader.ts";

/**
 * What the knobs compile in (SceneDef.featuresFor): each part whose knob starts off only while it
 * is on, so the default orbit's program carries none of them: the figures in the stars (the
 * constellations or the M among them), the aurora, the city lights, the M's lights, the moons and
 * the ring system. Storms, shooting stars and captured meteors stay in, as a "now" shows them with
 * their knob off; so do the cloud decks, which the storms flash in.
 */
export function orbitFeatures(values: Readonly<Record<string, number>>): Record<string, number> {
  const on = (key: string): number => ((values[key] ?? 0) > 0 ? 1 : 0);
  return {
    ORBIT_FIGURES: Math.max(on("constellations"), on("mark")),
    ORBIT_AURORA: on("aurora"),
    ORBIT_LIGHTS: on("lights"),
    ORBIT_MARK_LIGHTS: on("mlights"),
    ORBIT_MOONS: on("moons"),
    ORBIT_RING: on("ring"),
  };
}

/** Every part compiled in (SceneDef.featuresAll): the shader's runtime tests of the knobs decide. */
export const ORBIT_ALL = orbitFeatures({
  constellations: 1,
  aurora: 1,
  lights: 1,
  mlights: 1,
  moons: 1,
  ring: 1,
});

export const orbitScene: SceneDef = {
  id: "orbit",
  title: "Orbit",
  blurb: "A planet in space: rings, moons, aurora, meteors.",
  accent: "#5c7cfa",
  // The shader reads each knob through its K_<key> define.
  params: [
    range("stars", "stars", "density", 0.35, "How many background stars."),
    feature("stars", "twinkle", "twinkle", true, "speed", 0.3, "Stars dim briefly now and then."),
    range(
      "stars",
      "scatter",
      "randomness",
      0.8,
      "0: stars pulse together. 1: each keeps its own rhythm and dims only briefly.",
      { when: "twinkle" },
    ),
    toggle(
      "stars",
      "constellations",
      "constellations",
      false,
      "Real constellations: Orion, the Big Dipper, Cassiopeia, Cygnus, Leo and the Southern Cross.",
    ),
    toggle(
      "stars",
      "lines",
      "figure lines",
      true,
      "Join each constellation's stars with dotted lines.",
      { when: "constellations" },
    ),
    toggle(
      "stars",
      "mark",
      "manifold in the stars",
      false,
      "An extra asterism tracing the Manifold M among the stars.",
    ),
    feature(
      "stars",
      "meteors",
      "shooting stars",
      false,
      "frequency",
      0.4,
      "Streaks crossing the upper sky.",
      { trigger: 0 },
    ),
    feature(
      "stars",
      "captures",
      "captured meteors",
      false,
      "frequency",
      0.5,
      "Now and then a meteor is caught by the planet, spirals round it and burns up in the atmosphere.",
      { trigger: 1 },
    ),
    feature("stars", "nebula", "nebula", true, "density", 1, "Faint dust behind the stars."),
    feature(
      "stars",
      "drift",
      "sky drift",
      true,
      "speed",
      0.5,
      "The starfield slides slowly sideways.",
    ),
    range(
      "camera",
      "planetX",
      "across",
      0.36,
      "Where the planet sits horizontally: -1 left edge, 1 right edge.",
      {
        min: -1,
        max: 1,
        steady: true,
        widget: { kind: "position", y: "planetY", screen: [-1, 1] },
      },
    ),
    range(
      "camera",
      "planetY",
      "height",
      -1.32,
      "Height of the planet's centre: low values sink it below the frame, around 0 centres it.",
      { min: -1.8, max: 0.6, steady: true },
    ),
    range("camera", "planet", "size", 1, "Planet radius.", { min: 0.15, max: 1.6, steady: true }),
    ...planetKnobs({
      clouds: true,
      storms: { trigger: 2 },
      aurora: true,
      lights: true,
      daycycle: true,
      moons: true,
      ring: true,
    }),
    toggle(
      "manifold",
      "mlights",
      "M city lights",
      false,
      "Night-side city lights that trace the Manifold M.",
    ),
  ],
  groups: {
    stars: {
      title: "Sky & events",
      blurb: "Background stars, constellations and what streaks across them.",
    },
    camera: { title: "Camera", blurb: "Frame the planet: where it sits and how big it is." },
    ...planetGroups,
    manifold: { title: "Manifold mark", blurb: "Ways the M can live in this sky." },
  },
  glsl: orbitGlsl,
  entry: "sceneOrbit",
  // The camera swings round and the planet slides in from the right and settles while the moons
  // catch up along their orbits; leaving, the camera pulls back and the planet slides off left.
  passage: ORBIT_PASSAGE,
  featuresFor: orbitFeatures,
  featuresAll: ORBIT_ALL,
};
