// A planet in space: rings, moons, aurora, meteors, and real constellations behind it (their
// figures reach the shader as the uCon* uniforms, see constellations.ts).
import { choice, counts, feature, range, toggle } from "../../params.ts";
import type { SceneDef } from "../types.ts";
import { orbitGlsl } from "./shader.ts";

export const orbitScene: SceneDef = {
  id: "orbit",
  title: "Orbit",
  blurb: "A planet in space: rings, moons, aurora, meteors.",
  accent: "#5c7cfa",
  // The shader reads each knob through its K_<key> define.
  params: [
    range("stars", "stars", "density", 0.35, "How many background stars."),
    feature("stars", "twinkle", "twinkle", true, "speed", 0.3, "Stars dim briefly now and then."),
    range("stars", "scatter", "randomness", 0.8, "0: stars pulse together. 1: each keeps its own rhythm and dims only briefly.", { when: "twinkle" }),
    toggle("stars", "constellations", "constellations", false, "Real constellations: Orion, the Big Dipper, Cassiopeia, Cygnus, Leo and the Southern Cross."),
    toggle("stars", "lines", "figure lines", true, "Join each constellation's stars with dotted lines.", { when: "constellations" }),
    toggle("stars", "mark", "manifold in the stars", false, "An extra asterism tracing the Manifold M among the stars."),
    feature("stars", "meteors", "shooting stars", false, "frequency", 0.4, "Streaks crossing the upper sky.", { trigger: 0 }),
    feature("stars", "captures", "captured meteors", false, "frequency", 0.5, "Now and then a meteor is caught by the planet, spirals round it and burns up in the atmosphere.", { trigger: 1 }),
    feature("stars", "nebula", "nebula", true, "density", 1, "Faint dust behind the stars."),
    feature("stars", "drift", "sky drift", true, "speed", 0.5, "The starfield slides slowly sideways."),
    range("camera", "planetX", "across", 0.36, "Where the planet sits horizontally: -1 left edge, 1 right edge.", { min: -1, max: 1, steady: true }),
    range("camera", "planetY", "height", -1.32, "Height of the planet's centre: low values sink it below the frame, around 0 centres it.", { min: -1.8, max: 0.6, steady: true }),
    range("camera", "planet", "size", 1, "Planet radius.", { min: 0.15, max: 1.6, steady: true }),
    feature("planet", "clouds", "clouds", false, "cover", 0.6, "Cloud decks drifting over the day side."),
    feature("planet", "storms", "storms", false, "frequency", 0.5, "Lightning flashing in the night-side clouds.", { trigger: 2 }),
    feature("planet", "aurora", "aurora", false, "glow", 0.6, "An auroral oval drifting over the polar night side, rising into curtains where it meets the horizon."),
    feature("planet", "daycycle", "day cycle", false, "speed", 0.3, "The sun circles slowly: sunrise, day and night sweep across the planet."),
    feature("moons", "moons", "moons", false, "count", 2, "Moons on inclined orbits that rise from behind the planet.", { options: counts(1, 2, 3) }),
    toggle("moons", "eclipses", "shadows on planet", true, "Moons cast their shadow onto the planet.", { when: "moons" }),
    toggle("ring", "ring", "ring system", false, "Rings around the planet: they pass behind it, catch its shadow and shade its surface."),
    choice("ring", "ringCount", "bands", counts(1, 2, 3, 5, 8), 3, "How many separate ring bands.", { when: "ring" }),
    range("ring", "ringSpacing", "spacing", 0.25, "Gap between neighbouring bands, as a share of each band.", { max: 0.8, when: "ring" }),
    range("ring", "ringInner", "inner edge", 0.25, "Gap between the planet and the first band.", { when: "ring" }),
    range("ring", "ringWidth", "span", 0.55, "How far out the outermost band reaches.", { when: "ring" }),
    range("ring", "ringTilt", "tilt", 0.6, "0: edge-on, a thin line. 1: seen from above.", { when: "ring" }),
    range("ring", "ringRoll", "roll", -0.2, "Rotates the ring plane on screen.", { min: -1, max: 1, when: "ring" }),
    range("ring", "ringDensity", "density", 0.75, "How solid the rings look.", { when: "ring" }),
    choice("ring", "ringTone", "colour", [{ label: "accent", value: 0 }, { label: "ink", value: 1 }, { label: "both", value: 2 }], 0, "accent or ink rings; both alternates band by band.", { when: "ring" }),
    choice("ring", "ringTexture", "made of", [{ label: "dust", value: 0 }, { label: "ice", value: 1 }, { label: "rock", value: 2 }], 1, "dust: soft and smooth. ice: fine grooves. rock: separate boulders you can see orbiting.", { when: "ring" }),
    feature("ring", "ringSpin", "spin", true, "speed", 0.4, "The rings orbit the planet; inner bands go faster, as real rings do.", { when: "ring" }),
    toggle("manifold", "mlights", "M city lights", false, "Night-side city lights that trace the Manifold M."),
    range("planet", "auroraSize", "aurora oval", 0.4, "How far from the pole the auroral oval sits.", { when: "aurora" }),
    toggle("planet", "lights", "city lights", false, "Scattered lights on the night side of the planet."),
    range("planet", "lightsTwinkle", "twinkle", 0, "0 keeps the city lights steady; higher makes them flicker.", { when: "lights" }),
  ],
  groups: {
    stars: { title: "Sky & events", blurb: "Background stars, constellations and what streaks across them." },
    camera: { title: "Camera", blurb: "Frame the planet: where it sits and how big it is." },
    planet: { title: "Planet", blurb: "Surface, weather, aurora and the sun's path." },
    moons: { title: "Moons", blurb: "Satellites on inclined orbits, and their eclipses." },
    ring: { title: "Rings", blurb: "A ring system: its shape, what it's made of, and how it moves." },
    manifold: { title: "Manifold mark", blurb: "Ways the M can live in this sky." },
  },
  glsl: orbitGlsl,
  entry: "sceneOrbit",
};
