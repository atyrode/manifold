// The Swell preset's layers (ADR 0062 Phase 2c): their manifests, which load without their code
// (shader.ts, sim.ts). Each is drawn through the open sea's own rig alone (SWELL_RIG): the sea is
// worked in heights of that eye over the water and laid out for that long lens, and the boats and the
// headland stand where it frames them, so another rig is not offered them.
//   openSea     backdrop: the World's sky over the open sea (the M in the moon's seas, the rain's
//               grey over the deck and its shafts out at sea, the moonlit air low over the horizon);
//               the camera (the pointer's lens shift); the air (the haze, the moonlit fog, the rain's
//               grey the far rain fuses into, the drops' light); the picture's ink over a black point,
//               the crests' blue its accent (its shade pass).
//   swell       ground: the sea, its long swell and the wind's sea and chop on it, the whitecaps; the
//               sky, the headland and the boats mirrored in it, the moon's and the sun's glitter, the
//               lamps' paths; with relief, waves of real height. It lies under the open sea's air, so it
//               needs it.
//   lighthouse  dressing: the headland off to the right and its lighthouse, the beams sweeping the night
//               air over the fog and the lamp's flash (its glow pass); the cast's agents go to its lamp.
//   boats       dressing: the boats at anchor riding the swell's trains (so they need the swell), their
//               lanterns once it is dark (`boatsLanterns`); the cast's agents go to them.
// The gulls are the World's birds (the preset's kind), drawn among them by depth.
import type { CameraRange, LayerDef } from "../../composer/types.ts";
import { feature, range, toggle } from "../../params.ts";
import { SWELL_BOATS, SWELL_RIG } from "./constants.ts";

/** The open sea's own rig, and no other. */
const AT_SEA: CameraRange = {
  eye: [SWELL_RIG.eye, SWELL_RIG.eye],
  horizon: [SWELL_RIG.horizon, SWELL_RIG.horizon],
  focal: [SWELL_RIG.focal, SWELL_RIG.focal],
  pitch: [SWELL_RIG.pitch, SWELL_RIG.pitch],
};

export const openSeaLayer: LayerDef = {
  id: "openSea",
  title: "Open sea",
  composers: ["outdoor"],
  role: "backdrop",
  bands: ["far"],
  space: { anchors: [], claims: [] },
  camera: AT_SEA,
  switch: toggle(
    "layers",
    "openSea",
    "open sea",
    false,
    "The open sea under the sky, out to a level horizon: the moonlit air glowing low over it, rain hanging in shafts far out.",
    { icon: "sky" },
  ),
  params: [
    toggle("manifold", "mmoon", "M on the moon", false, "The moon's dark seas form the Manifold M."),
  ],
  groups: {
    manifold: { title: "Manifold mark", blurb: "Ways the M can live in this night." },
  },
  mark: "mmoon",
  // The far rain fuses into the rain's grey over the sea, lit up by the lightning.
  precip: { air: "openSeaRainAir" },
  passes: { begin: "openSeaBegin", sky: "openSeaSky", shade: "openSeaShade" },
};

export const swellLayer: LayerDef = {
  id: "swell",
  title: "Swell",
  composers: ["outdoor"],
  role: "ground",
  bands: ["middle", "front"],
  space: { anchors: [], claims: [] },
  camera: AT_SEA,
  switch: toggle(
    "layers",
    "swell",
    "swell",
    false,
    "The sea rolling toward you: long swells from far off, the wind's sea and chop on them, whitecaps once it blows hard; the sky mirrored in it and the moon's path of glitter blazing toward the horizon.",
    { icon: "waves" },
  ),
  params: [
    range(
      "sea",
      "height",
      "swell",
      0.5,
      "Height of the long swells rolling in from far off: the taller, the sharper their crests, until they break white.",
    ),
    range(
      "sea",
      "relief",
      "relief",
      0,
      "0: the waves are painted on a flat sea. Higher gives the nearer waves real height: crests hide the troughs behind them and the arriving swell stands up. Far waves stay flat.",
    ),
  ],
  groups: {
    sea: {
      title: "Sea",
      blurb:
        "The long swell, and the waves the wind raises on it: wind sea and chop, whitecaps once it blows hard.",
    },
  },
  requires: ["openSea"],
  // The relief's march only while the waves have height.
  featuresFor: (values) => ({ SWELL_RELIEF: (values["relief"] ?? 0) > 0 ? 1 : 0 }),
  featuresAll: { SWELL_RELIEF: 1 },
  passes: { begin: "swellBegin", ground: "swellGround" },
};

export const lighthouseLayer: LayerDef = {
  id: "lighthouse",
  title: "Lighthouse",
  composers: ["outdoor"],
  role: "dressing",
  bands: ["far"],
  space: { anchors: [], claims: [] },
  camera: AT_SEA,
  switch: toggle(
    "layers",
    "lighthouse",
    "lighthouse",
    false,
    "A lighthouse on a headland off to the right. By night its two beams sweep round, flashing as they pass you; in fog, rain or snow they light the air as long cones.",
    { icon: "rays" },
  ),
  params: [],
  groups: {},
  requires: ["openSea"],
  passes: { begin: "lighthouseBegin", far: "lighthouseFar", glow: "lighthouseGlow" },
};

export const boatsLayer: LayerDef = {
  id: "boats",
  title: "Boats",
  composers: ["outdoor"],
  role: "dressing",
  bands: ["middle"],
  space: { anchors: [], claims: [] },
  camera: AT_SEA,
  switch: feature(
    "layers",
    "boats",
    "boats",
    false,
    "how many",
    2,
    "Small boats riding the swell at anchor, heaving and rocking on the waves under them, bows to the wind. The first rides in the moon's path, black against its glitter.",
    { min: 1, max: SWELL_BOATS.length, step: 1, icon: "boat" },
  ),
  params: [
    toggle(
      "boats",
      "boatsLanterns",
      "lanterns",
      false,
      "A lantern lit on each boat once it is dark, its warm light trembling down the water toward you.",
    ),
  ],
  groups: { boats: { title: "Boats", blurb: "The boats' lanterns by night." } },
  requires: ["swell"],
  // The lanterns only while they are lit.
  featuresFor: (values) => ({ BOATS_LANTERNS: (values["boatsLanterns"] ?? 0) > 0 ? 1 : 0 }),
  featuresAll: { BOATS_LANTERNS: 1 },
  passes: { begin: "boatsBegin", middle: "boatsMiddle", glow: "boatsGlow" },
};
