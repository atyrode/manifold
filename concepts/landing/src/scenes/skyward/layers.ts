// The Skyward preset's layers (ADR 0062 Phase 2c): their manifests, which load without their code
// (shader.ts). Each is drawn through the crossing's own rig alone (SKYWARD_RIG): the camera lies on
// its back in the middle of the crossroads looking up, and nothing of a standing eye's can be seen
// through it, nor the street's parts through another, so no other rig is offered them.
//   crossroads  backdrop: the facades round the crossing (glass towers or stone, brick and concrete,
//               their lit windows, balconies and window boxes, the traffic's light and shade
//               sliding over the lower floors), the World's sky over the strip between them under the
//               city's glow, the airliners and their trails beyond the deck, the road under you while
//               the passage tips the view toward it; the street's birds on the World's birds knobs;
//               the banner over the crossing with its M; the street's air, the World's fog laid along
//               its own rays, and the axes the World's rain and snow are seen through.
//   streetTree  dressing: the street tree's canopy in the corner of the sky, as leafy as the
//               crossroads' greenery, tossed by the composer's gusts.
//   tramway     dressing: the tram wires and their spans, the trams below (as often as the
//               crossroads' traffic has them), the two street lamps and the signal gantry.
// Both dressings stand over the crossing, so they need the crossroads. Keys: `towers`, `planes` and
// `snowOverhead` kept; `windows` and `traffic` qualified `crossroadsWindows` and
// `crossroadsTraffic` (the street's crossing holds them), `greenery` `crossroadsGreenery` (the
// waterfall's greenery holds it), the M `crossroadsMark`; `citySeed` became the composer's `seed`.
// The sky's and the weather's knobs are the World's; its birds knobs fly the street's birds.
import type { CameraRange, LayerDef } from "../../composer/types.ts";
import { feature, range, toggle } from "../../params.ts";
import { SKYWARD_RIG } from "./constants.ts";

/** The crossing's own rig, and no other. */
const LYING: CameraRange = {
  eye: [SKYWARD_RIG.eye, SKYWARD_RIG.eye],
  horizon: [SKYWARD_RIG.horizon, SKYWARD_RIG.horizon],
  focal: [SKYWARD_RIG.focal, SKYWARD_RIG.focal],
  pitch: [SKYWARD_RIG.pitch, SKYWARD_RIG.pitch],
};

export const crossroadsLayer: LayerDef = {
  id: "crossroads",
  title: "Crossroads",
  composers: ["outdoor"],
  role: "backdrop",
  bands: ["far", "middle"],
  space: { anchors: [], claims: [] },
  camera: LYING,
  switch: toggle(
    "layers",
    "crossroads",
    "crossroads",
    false,
    "The buildings round a busy crossroads seen lying on your back in the middle of it: the facades rise and lean together toward a strip of sky, planes cross it far overhead, pigeons wheel and swifts scream by, and the traffic you cannot see slides its light and shadow over the lower floors.",
    { icon: "city" },
  ),
  params: [
    range(
      "city",
      "towers",
      "glass towers",
      0.4,
      "The mix of the street: from old stone and brick houses with balconies and window boxes to glass towers that mirror the clouds, the opposite roofline and, now and then, the sun.",
    ),
    range(
      "city",
      "crossroadsWindows",
      "lit windows",
      0.4,
      "How many windows have a light on: a few by day, more as the evening comes in, the whole street by night.",
    ),
    range(
      "city",
      "crossroadsGreenery",
      "greenery",
      0.6,
      "Window boxes and trailing plants on the balconies, and the leafy edge of the street tree in the corner of the sky.",
    ),
    range(
      "city",
      "crossroadsTraffic",
      "traffic",
      0.5,
      "The road you cannot see: buses and cars sweeping their shadows, headlights and glints along the lower floors, and a tram now and then, its pantograph sparking on the wire.",
    ),
    feature(
      "air",
      "planes",
      "airliners",
      true,
      "frequency",
      0.4,
      "Planes crossing the strip of sky far overhead, a contrail growing behind each, spreading and fading over a minute or two.",
    ),
    toggle(
      "air",
      "snowOverhead",
      "snow from overhead",
      false,
      "How the snow comes at you. On, as it does lying on your back: the flakes stream out of the patch of sky they fall from (off the zenith, downwind), small and slow there, larger and faster toward the edges. Off, they come down the frame as for a camera looking ahead.",
      { when: "snow" },
    ),
    toggle(
      "manifold",
      "crossroadsMark",
      "banner M",
      false,
      "A cloth banner strung across the crossroads on four cables, the Manifold M painted on it in the accent colour, lit from within at night.",
    ),
  ],
  groups: {
    city: {
      title: "City",
      blurb:
        "The buildings round the crossroads, their windows and balconies, and the traffic that passes below.",
    },
    air: {
      title: "In the air",
      blurb:
        "Who is up there with you, and how the snow comes down at you. The birds are the World's knobs: pigeons wheeling over the street and swifts looping above.",
    },
    manifold: {
      title: "Manifold mark",
      blurb: "A landmark of its own: the banner over the crossroads.",
    },
  },
  mark: "crossroadsMark",
  // The far rain fuses into the deck's grey, warmed by the city after dark; the rain and the snow
  // are seen through the camera's own axes (the snow through a level camera's unless from overhead).
  precip: { air: "crossroadsRainAir", seen: "crossroadsSeen" },
  featuresFor: (values) => ({
    CROSSROADS_BIRDS: (values["birds"] ?? 0) > 0 ? 1 : 0,
    CROSSROADS_PLANES: (values["planes"] ?? 0) > 0 ? 1 : 0,
    CROSSROADS_MARK: (values["crossroadsMark"] ?? 0) > 0 ? 1 : 0,
  }),
  featuresAll: { CROSSROADS_BIRDS: 1, CROSSROADS_PLANES: 1, CROSSROADS_MARK: 1 },
  passes: {
    begin: "crossroadsBegin",
    sky: "crossroadsSky",
    middle: "crossroadsMiddle",
    air: "crossroadsAir",
    shade: "crossroadsShade",
  },
};

export const streetTreeLayer: LayerDef = {
  id: "streetTree",
  title: "Street tree",
  composers: ["outdoor"],
  role: "dressing",
  bands: ["middle"],
  space: { anchors: [], claims: [] },
  camera: LYING,
  switch: toggle(
    "layers",
    "streetTree",
    "street tree",
    false,
    "The leafy edge of the street tree in the corner of the sky, seen from underneath, backlit by the sky, swaying a little; as leafy as the crossroads' greenery.",
    { icon: "tree" },
  ),
  params: [],
  groups: {},
  requires: ["crossroads"],
  passes: { middle: "streetTreeMiddle" },
};

export const tramwayLayer: LayerDef = {
  id: "tramway",
  title: "Tram wires",
  composers: ["outdoor"],
  role: "dressing",
  bands: ["middle"],
  space: { anchors: [], claims: [] },
  camera: LYING,
  switch: toggle(
    "layers",
    "tramway",
    "tram wires",
    false,
    "What crosses the sky nearest: the tram wires and the spans that hold them, a street lamp on each side, the signal gantry over the cross street, and now and then a tram gliding past below, its pantograph sparking on the wire.",
    { icon: "road" },
  ),
  params: [],
  groups: {},
  requires: ["crossroads"],
  passes: { middle: "tramwayMiddle" },
};
