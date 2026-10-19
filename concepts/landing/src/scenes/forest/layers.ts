// The Mystic forest preset's layers (ADR 0062 Phase 2b): their manifests, which load without their
// code (shader.ts, sim.ts, build.ts). Each is drawn through the forest's own rig alone (FOREST_RIG):
// its parts are laid out for that pinhole and its dolly (layout.ts), so another rig is not offered
// them; every one stands under the woods' canopy and in its mist (`requires`).
//   woods        backdrop: the mist (its light, the shafts of sun or moon falling through the gaps),
//                the canopy overhead with the World's sky in its gaps, three rows of far cedars and
//                beeches fading into the mist; the mist's drifting banks, the drips off the canopy and
//                (while the kodama are on) the spores on the air; the forest's air for the World's fog
//                and rain, which the canopy shelters (its claim keeps 55 % of the drops off).
//   forestFloor  ground: moss, cedar litter and roots, pools in the rain, the stream winding out of the
//                mist (its bed, its ribbon of light, the torii mirrored in it, foam, rings) and its
//                stepping stones; the stream's water claims the floor, so no cover grows on it.
//   shrine       dressing, the subject: the torii over the stream, the fallen log, the old beech with
//                its branch and beards of lichen, the boulders, the great cedar with its rope and paper
//                streamers, the roots gripping the near boulder (or the M they grew into), the glowing
//                mushrooms (their light falls on every forest layer) and their glow in the air.
//   undergrowth  cover: the ferns in the near corners, swaying in the composer's one wind.
//   kodama       life: the spirits on their perches, the stag crossing far off, the spores (sim.ts,
//                build.ts: the forest's life, warmed up on the build worker); the life's air also
//                carries the mist's banks, which the woods draw.
// What each draws is at the top of shader.ts, how the life lives at the top of build.ts. Keys kept
// from the scene: spirits, shy, stag, spores (the kodama's), mushrooms (the shrine's), stream (the
// floor's), shafts (the woods'); `mist` became `woodsMist` (lanterns' river holds `mist`), the M
// `shrineMark` (the apiary's and the beach's `mark`), `forestSeed` the composer's `seed`.
import type { Claim, LayerDef } from "../../composer/types.ts";
import { feature, range, toggle } from "../../params.ts";
import { FOREST_RIG, KODAMA_DATA } from "./constants.ts";
import { FOREST_LOG, FOREST_TORII, forestStreamHalf, forestStreamX } from "./layout.ts";

/** The forest's own rig, and no other. */
const FOREST_CAMERA = {
  eye: [FOREST_RIG.eye, FOREST_RIG.eye],
  horizon: [FOREST_RIG.horizon, FOREST_RIG.horizon],
  focal: [FOREST_RIG.focal, FOREST_RIG.focal],
  pitch: [FOREST_RIG.pitch, FOREST_RIG.pitch],
} as const;

/**
 * The canopy overhead, everywhere the rig sees (as far as WORLD_FAR, the open mist's depth, at any
 * frame up to about 3.5 wide): 55 % of the World's drops and lying snow kept off beneath it, as
 * under its leaves the forest let 45 % through. Covers grow under it by their overgrowth.
 */
const CANOPY_CLAIM: Claim = {
  name: "the canopy",
  kind: "shared",
  shape: { kind: "disc", at: [0, 0], r: 20000 },
  shelter: 0.55,
};

/** The stream's water from the eye's feet into the mist: no cover grows on it. */
const STREAM_CLAIM: Claim = {
  name: "the stream",
  kind: "exclusive",
  shape: {
    kind: "strip",
    points: [3, 5, 7, 9, 12, 16, 22, 30, 40].map((z) => [forestStreamX(z), z] as const),
    half: forestStreamHalf(12),
  },
};

/** Where the torii stands over the stream: its centre (m across). */
const TORII_X = forestStreamX(FOREST_TORII.z);

/** What the shrine stands on that keeps its place in metres at any frame: the log, the torii's feet. */
const SHRINE_CLAIMS: readonly Claim[] = [
  {
    name: "the fallen log",
    kind: "exclusive",
    shape: {
      kind: "box",
      at: [0.5 * (FOREST_LOG.from + FOREST_LOG.to), FOREST_LOG.z],
      half: [0.5 * (FOREST_LOG.to - FOREST_LOG.from), FOREST_LOG.radius],
    },
  },
  {
    name: "the torii's mossy foot",
    kind: "exclusive",
    shape: { kind: "disc", at: [TORII_X - FOREST_TORII.span, FOREST_TORII.z], r: 0.5 },
  },
  {
    name: "the torii's foot",
    kind: "exclusive",
    shape: { kind: "disc", at: [TORII_X + FOREST_TORII.span, FOREST_TORII.z], r: 0.25 },
  },
];

export const woodsLayer: LayerDef = {
  id: "woods",
  title: "Misty woods",
  composers: ["outdoor"],
  role: "backdrop",
  bands: ["far", "middle"],
  space: { anchors: [], claims: [CANOPY_CLAIM] },
  camera: FOREST_CAMERA,
  switch: toggle(
    "layers",
    "woods",
    "misty woods",
    false,
    "An ancient forest of cedar and beech in a luminous mist: huge mossy trunks fading into it row behind row, a closed canopy overhead with the sky in its gaps, shafts of sun or moon falling through them. The canopy shelters what stands under it from the rain and drips long after.",
    { icon: "pine" },
  ),
  params: [
    range(
      "woods",
      "woodsMist",
      "mist",
      0.55,
      "How thick the mist hangs between the trunks: the farther ones fade into it first. Its banks drift slowly and swirl where the pointer passes, and it is what makes the light shafts show.",
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
  ],
  groups: {
    woods: {
      title: "Woods",
      blurb:
        "The mist between the trunks. Move the pointer to stir its banks (while the spirits' air is on).",
    },
    light: { title: "Light", blurb: "Shafts of sun or moon through the canopy." },
  },
  // The drops dimmed toward the eye as the forest drew them, nearest out of focus.
  precip: { thin: [0.9, 0.55] },
  passes: { begin: "woodsBegin", sky: "woodsSky", middle: "woodsMiddle", air: "woodsAir" },
};

export const forestFloorLayer: LayerDef = {
  id: "forestFloor",
  title: "Forest floor",
  composers: ["outdoor"],
  role: "ground",
  bands: ["middle", "front"],
  space: { anchors: [], claims: [STREAM_CLAIM] },
  camera: FOREST_CAMERA,
  switch: toggle(
    "layers",
    "forestFloor",
    "forest floor",
    false,
    "Moss and cedar litter with roots snaking through, pools gathering in the rain, and a clear stream winding out of the mist past three stepping stones.",
    { icon: "ripple" },
  ),
  params: [
    feature(
      "floor",
      "stream",
      "stream",
      true,
      "flow",
      0.5,
      "A clear stream winding out of the mist under the torii and past the stepping stones, a ribbon of light mirroring the bright mist and the sky; its pebbled bed shows through close by, the torii is mirrored farther off. Flow: how fast it runs and how much it foams round the stones. Off: its dry stony bed.",
    ),
  ],
  groups: {
    floor: { title: "Floor", blurb: "The stream winding over the forest floor." },
  },
  requires: ["woods"],
  passes: { ground: "forestFloorGround" },
};

export const shrineLayer: LayerDef = {
  id: "shrine",
  title: "Shrine",
  composers: ["outdoor"],
  role: "dressing",
  subject: true,
  bands: ["middle", "front"],
  space: { anchors: [], claims: SHRINE_CLAIMS },
  camera: FOREST_CAMERA,
  switch: toggle(
    "layers",
    "shrine",
    "shrine",
    false,
    "A torii over the stream half swallowed by moss, a fallen log, an old beech reaching out a branch hung with lichen, mossy boulders, and the great cedar with its rope and paper streamers gripping the near boulder with its roots.",
    { icon: "tree" },
  ),
  params: [
    feature(
      "shrine",
      "mushrooms",
      "glowing mushrooms",
      true,
      "glow",
      0.6,
      "Clusters of small mushrooms on the boulders, the fallen log and the moss mound at the torii's foot: pale by day; at dusk their caps and gills glow green, lighting the moss round them and the mist.",
    ),
    feature(
      "manifold",
      "shrineMark",
      "root M",
      false,
      "glow",
      0.7,
      "The great cedar's roots have grown into a Manifold M across the face of the boulder they grip, and pale fungus glows along it at dusk. Now: the roots draw the M (even while it is off) and it glows for a while, even by day, breathing out spores.",
    ),
  ],
  groups: {
    shrine: {
      title: "Shrine",
      blurb: "The glowing mushrooms on the boulders, the log and the torii's mossy foot.",
    },
    manifold: { title: "Manifold mark", blurb: "The Manifold M: one at a time." },
  },
  triggers: ["shrineMark"],
  mark: "shrineMark",
  requires: ["woods"],
  passes: {
    begin: "shrineBegin",
    middle: "shrineMiddle",
    front: "shrineFront",
    frontVeil: "shrineFrontVeil",
  },
};

export const undergrowthLayer: LayerDef = {
  id: "undergrowth",
  title: "Ferns",
  composers: ["outdoor"],
  role: "cover",
  bands: ["front"],
  space: { anchors: [], claims: [] },
  camera: FOREST_CAMERA,
  switch: toggle(
    "layers",
    "undergrowth",
    "ferns",
    false,
    "Ferns in the near corners, their fronds arching over and swaying slowly, glowing green where the light comes through them.",
    { icon: "sprout" },
  ),
  params: [],
  groups: {},
  requires: ["woods"],
  passes: { front: "undergrowthFront" },
};

export const kodamaLayer: LayerDef = {
  id: "kodama",
  title: "Spirits",
  composers: ["outdoor"],
  role: "life",
  bands: ["middle", "front"],
  space: { anchors: [], claims: [] },
  camera: FOREST_CAMERA,
  switch: toggle(
    "layers",
    "kodama",
    "forest spirits",
    false,
    "The forest's life: small pale spirits (kodama) on the mossy perches, a great stag crossing far off now and then, spores and motes drifting on the air, and the mist's banks that air carries.",
    { icon: "eye" },
  ),
  params: [
    feature(
      "spirits",
      "spirits",
      "spirits",
      true,
      "frequency",
      0.5,
      "Kodama: small pale spirits appearing on the mossy boulders, the fallen log, the beech's branch, the torii and the stepping stones, rising out of the moss as they take shape. Each sits a while, now and then turning its head in a few quick rattling clicks, glows softly at dusk and night, and dissolves. Far more come after sunset than by day. Bring the pointer near and they turn to look at it; click near a perch to call one. Now: a gathering, and then they all turn their heads together.",
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
    ),
    feature(
      "spirits",
      "spores",
      "spores",
      true,
      "amount",
      0.5,
      "Spores and motes drifting on a gentle swirling air: dust that lights up in the shafts by day; at night pale green sparks rising round the mushrooms, fading as they drift away. Move the pointer through them to stir them, and the mist with them. Now: the mushrooms breathe out a puff of glowing spores.",
    ),
  ],
  groups: {
    spirits: {
      title: "Spirits",
      blurb:
        "The kodama on their perches, the stag far off between the trunks and the spores in the air. Bring the pointer near a spirit and it looks, or ducks into the moss if it is shy; click near a perch to call one.",
    },
  },
  triggers: ["spirits", "stag", "spores"],
  requires: ["woods"],
  data: KODAMA_DATA,
  passes: { middle: "kodamaMiddle", front: "kodamaFront", frontVeil: "kodamaFrontVeil" },
};
