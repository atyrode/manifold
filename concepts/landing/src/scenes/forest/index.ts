// An ancient misty forest of cedar and beech: huge mossy trunks in depth, a great cedar with its rope
// and paper streamers gripping a boulder with its roots, a stream winding out of the mist under a torii
// half swallowed by moss, a fallen log, stepping stones, ferns, shafts of light in the mist; and the
// mystical layer, strongest at dusk and night: small pale forest spirits (kodama) appearing on the
// roots, stones and branches, rattling their heads round and fading, glowing mushrooms, drifting
// spores, and now and then a great stag crossing far off between the trunks. The spirits, the stag,
// the spores and the mist's banks live in sim.ts; shader.ts paints the forest around them.
// Passage: the camera glides in between the trunks, braking, and settles, then the spirits pop up
// one by one on their perches; on the way out they turn their heads and vanish one by one while the
// camera drifts back into the mist, gathering speed (FOREST_PASSAGE in sim.ts).
import { feature, range, seed, type ParamDef } from "../../params.ts";
import { atmosphereGroups, skyKnobs, weatherKnobs } from "../atmosphere.ts";
import type { SceneDef } from "../types.ts";
import { forestGlsl } from "./shader.ts";
import { FOREST_PASSAGE, forestSim } from "./sim.ts";

const params: readonly ParamDef[] = [
  feature(
    "spirits",
    "spirits",
    "forest spirits",
    true,
    "frequency",
    0.5,
    "Kodama: small pale spirits appearing on the mossy boulders, the fallen log, the beech's branch, the torii and the stepping stones, rising out of the moss as they take shape. Each sits a while, now and then turning its head in a few quick rattling clicks, glows softly at dusk and night, and dissolves. Far more come after sunset than by day. Bring the pointer near and they turn to look at it; click near a perch to call one. Now: a gathering, and then they all turn their heads together.",
    { trigger: 0 },
  ),
  range(
    "spirits",
    "shy",
    "shy spirits",
    0,
    "How many of the spirits are shy. None: every spirit is curious and turns to look at the pointer when it comes near. Higher: that share of them duck into the moss instead when the pointer comes close, faces turned away and their glow drawn in, only their eyes peeking over the moss, and creep back up a little while after it has gone. All: every spirit hides from the pointer.",
    { when: "spirits" },
  ),
  feature(
    "spirits",
    "stag",
    "the stag",
    true,
    "frequency",
    0.3,
    "Now and then a great stag walks across the far forest between the trunks, stops once (often framed by the torii) to raise its head and look toward you, then walks on; small lights bloom where it has stepped. A dark shape in the mist by day, a glowing presence at night. Higher: it passes more often, from every few minutes to about once a minute. Now: it sets out at once.",
    { trigger: 1 },
  ),
  feature(
    "forest",
    "mushrooms",
    "glowing mushrooms",
    true,
    "glow",
    0.6,
    "Clusters of small mushrooms on the boulders, the fallen log and the moss mound at the torii's foot: pale by day; at dusk their caps and gills glow green, lighting the moss round them and the mist.",
  ),
  feature(
    "forest",
    "spores",
    "spores",
    true,
    "amount",
    0.5,
    "Spores and motes drifting on a gentle swirling air: dust that lights up in the shafts by day; at night pale green sparks rising round the mushrooms, fading as they drift away. Move the pointer through them to stir them, and the mist with them. Now: the mushrooms breathe out a puff of glowing spores.",
    { trigger: 3 },
  ),
  feature(
    "forest",
    "stream",
    "stream",
    true,
    "flow",
    0.5,
    "A clear stream winding out of the mist under the torii and past the stepping stones, a ribbon of light mirroring the bright mist and the sky; its pebbled bed shows through close by, the torii is mirrored farther off. Flow: how fast it runs and how much it foams round the stones. Off: its dry stony bed.",
  ),
  range(
    "forest",
    "mist",
    "mist",
    0.55,
    "How thick the mist hangs between the trunks: the farther ones fade into it first. Its banks drift slowly and swirl where the pointer passes, and it is what makes the light shafts show.",
  ),
  seed(
    "forest",
    "forestSeed",
    "forest",
    "Where the far trunks stand, where the light shafts fall, how the air swirls; re-seed for another stretch of the forest.",
  ),
  feature(
    "light",
    "shafts",
    "light shafts",
    true,
    "strength",
    0.65,
    "Shafts of sun falling through gaps in the canopy, or of the moon at night: narrow at the gap and widening as they fall, slanting with the light, combed by the shadows of branches, breathing in and out. They gild what they cross and light the dust drifting in them.",
  ),
  ...skyKnobs({ time: 0.82, stars: 0.5, moon: 1 }),
  ...weatherKnobs({ rain: true, wind: true }),
  feature(
    "manifold",
    "mark",
    "root M",
    false,
    "glow",
    0.7,
    "The great cedar's roots have grown into a Manifold M across the face of the boulder they grip, and pale fungus glows along it at dusk. Now: the roots draw the M (even while it is off) and it glows for a while, even by day, breathing out spores.",
    { trigger: 2 },
  ),
];

export const forestScene: SceneDef = {
  id: "forest",
  title: "Mystic forest",
  blurb: "An ancient misty cedar forest, where small spirits appear on the mossy roots.",
  accent: "#bff5cf",
  look: { color: "full", levels: 4 },
  params,
  groups: {
    spirits: {
      title: "Spirits",
      blurb:
        "The kodama on their perches and the stag far off between the trunks. Bring the pointer near a spirit and it looks, or ducks into the moss if it is shy; click near a perch to call one.",
    },
    forest: {
      title: "Forest",
      blurb:
        "The glowing mushrooms, the spores in the air, the stream and the mist. Move the pointer to stir the mist and the spores.",
    },
    light: { title: "Light", blurb: "Shafts of sun or moon through the canopy." },
    sky: atmosphereGroups.sky,
    weather: {
      title: atmosphereGroups.weather.title,
      blurb:
        "Rain closes the sky and greys the mist; the canopy shelters the forest but pours through its gaps. The beards of lichen, the torii and the canopy gather water and drip long after; roots and stones go dark and glossy, pools gather on the floor, rings spread on the stream and drops burst on the stones. The wind slants the rain and sets the mist and the spores drifting.",
    },
    manifold: {
      title: "Manifold mark",
      blurb: "An M of roots on the near boulder, glowing with the spirits' light.",
    },
  },
  glsl: forestGlsl,
  passage: FOREST_PASSAGE,
  entry: "sceneForest",
  sim: forestSim(params),
  // The moon takes a phase (K_moon) in the shared sky: in the gaps, and in its shafts at night.
  features: { SKY_MOON_PHASE: 1 },
};
