// A small campfire at night, seen from a low seat just across the flames: a ring of stones on a flat
// rocky outcrop, crossed logs over breathing coals, a slow living fire of layered tongues, sparks
// climbing in lazy arcs, a thin smoke column that leans with the breeze, a marshmallow toasting on a
// stick, a log bench, an enamel mug, a backpack and a lantern-lit tent at the edge of the light. Beyond
// them dark pines, a giant ringed planet low on the horizon, the Milky Way and a vast starry sky with
// the odd shooting star. The picture is procedural in shader.ts: the flames, sparks and smoke are noise
// and analytic arcs advected slowly, cut per cell so nothing shimmers under the dither. With `fuel` on,
// sim.ts burns the logs down (sims/fuel.ts) and the shader follows it.
import { feature, range, toggle, type ParamDef } from "../../params.ts";
import { atmosphereGroups, skyKnobs, skyTheme, weatherKnobs } from "../atmosphere.ts";
import type { SceneDef } from "../types.ts";
import { campfireGlsl } from "./shader.ts";
import { campfireSim } from "./sim.ts";

const params: readonly ParamDef[] = [
  range("fire", "flame", "fire size", 0.5, "How big the fire burns: a small, low blaze on the left, a tall, roaring one to the right. The firelight on the stones, logs and ground grows with it."),
  range("fire", "lively", "liveliness", 0.4, "How much the tongues of flame lick and lean: left, a steady candle-like fire; right, tongues that rise and fall and sway more widely. Always slow."),
  feature("fire", "sparks", "sparks", true, "amount", 0.5, "Sparks lifting off the flames and drifting up in lazy arcs, glowing yellow then red, and winking out one by one. More: a livelier, crackling fire."),
  feature("fire", "smoke", "smoke", true, "amount", 0.5, "A thin column of smoke rising from the flames, curling and thinning as it climbs; the breeze bends it. Lit warm from below, grey-blue above."),
  toggle("fire", "marshmallow", "marshmallow", true, "A marshmallow on a stick resting over the fire from the bench, slowly toasting from pale to golden to brown and back as it is lifted away and lowered again, over a couple of minutes."),
  feature("fire", "fuel", "burning down", false, "minutes a log lasts", 6, "The logs burn down: they catch and flare, their bark chars black and crazes with glowing cracks, they thin where the flames are hottest and slump into the coals with a shower of sparks, then crumble into a growing bed of embers that slowly greys to ash. Off: the fire stays just as it is.", { min: 2, max: 20, step: 1 }),
  toggle("fire", "tend", "tend the fire", true, "Someone lays a fresh log on whenever one has burnt away: it smokes until it catches, then flares. Off: the fire burns down to embers and goes out. Now: lay a log on at once.", { when: "fuel", trigger: 1 }),
  range("camp", "reach", "firelight reach", 0.5, "How far the firelight carries: a tight pool on the stones, or a warm glow reaching the tent, the bench and the pack."),
  toggle("camp", "camp", "tent & pack", true, "A little tent at the edge of the light with a lantern glowing inside, and a backpack leaning by the stones."),
  ...skyKnobs({ time: 0.8, stars: 0.8 }),
  feature("sky", "planet", "giant planet", true, "size", 0.55, "A giant banded planet with a storm swirl and a thin ring, low over the far pines, half hidden by the trees; it fades into the sky by day.", { min: 0.2, max: 1 }),
  feature("sky", "shooting", "shooting stars", true, "frequency", 0.4, "A shooting star now and then, drawn across the dark sky in a second or so. Higher: every few seconds. Now: one at once.", { trigger: 0 }),
  ...weatherKnobs({ wind: true, fog: true }),
  feature("manifold", "mark", "carved M", false, "glow", 0.7, "The Manifold M carved into the log bench, its grooves glowing like embers in the firelight and breathing slowly with the coals."),
];

export const campfireScene: SceneDef = {
  id: "campfire",
  title: "Campfire",
  blurb: "A small fire under a vast sky: sparks drifting up, a marshmallow toasting, a giant planet low over the pines.",
  accent: "#ff8a2a",
  look: { color: "full", levels: 4 },
  params,
  groups: {
    fire: { title: "Fire", blurb: "The flames, the sparks and the smoke, a marshmallow toasting over them, and the logs burning down if you let them." },
    camp: { title: "Camp", blurb: "How far the firelight reaches, and the tent and pack at the edge of it." },
    sky: { title: atmosphereGroups.sky.title, blurb: "From dusk to deep night, the stars and the Milky Way, a giant planet low on the horizon and shooting stars. Run the day cycle and dawn comes to the clearing." },
    weather: { title: atmosphereGroups.weather.title, blurb: "The breeze leans the flames, bends the smoke, drifts the sparks and sways the pines; mist settles between the trees." },
    manifold: { title: "Manifold mark", blurb: "An M carved in the log bench, glowing in the firelight." },
  },
  glsl: campfireGlsl,
  entry: "sceneCampfire",
  sim: campfireSim(params),
  theme: skyTheme(params),
  // Entrance: embers in a dark night, a flame catches and grows, the firelight spreads, sparks start.
  // Exit: the fire dies down to embers and a last curl of smoke, the firelight withdraws.
  passage: { enter: 4.5, exit: 2.2 },
};
