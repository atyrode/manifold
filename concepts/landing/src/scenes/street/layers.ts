// The City crossing preset's layers (ADR 0062 Phase 2c): their manifests, which load without their
// code (shader.ts, sim.ts). Each is drawn through the street's own rig alone (STREET_RIG: the high
// window pitched down onto the crossing): the street is traced through that eye and its sim bins its
// people and vehicles for that view, so another rig is not offered them, and the eye-level layers of
// the other presets are not offered here (their camera ranges hold a level rig).
//   city        backdrop: the far blocks along the avenue and the side street's walls, cut into
//               buildings, their shops, fascias, windows switching on and off over the minutes, flat
//               and blade signs, awnings dripping in the rain; the shops' light spilling onto the
//               sidewalks (a declared light); over the roofs, as the passage raises the window, the
//               World's sky and the city beyond; the street's air (the glow of every light in it, the
//               colours of the World's fog and rain, the axes the World's drops are seen through from
//               a window pitched down) and its haze far up the streets.
//   crossing    ground: the road and the sidewalks, their paint and the zebras (the M with its M on),
//               the wet street mirroring the city and streaking every light, the splashes, the snow
//               lying but in the wheel tracks and the trodden crosswalks.
//   kerbside    dressing: the lamp posts (their light a declared light, with the vending machines'
//               glow), the signal poles and their heads, the walk signals, the vending machines.
//   streetLife  life: the walkers, the school outing, the cyclists, the cars, taxis, kei cars and
//               vans, the late delivery: the crossing's social-force and intelligent-driver sim, which
//               also runs the lights (its rows of the records atlas and a field slot); the vehicles'
//               lamps, the clear umbrellas and the spray.
// The street is lit as a whole by the street's shared begin (shader.ts), each layer's parts compiled in
// while it stands; what each draws is at the top of shader.ts, how the street lives at the top of
// sim.ts.
import type { CameraRange, LayerDef } from "../../composer/types.ts";
import { feature, range, toggle } from "../../params.ts";
import { STREET_DATA, STREET_RIG } from "./constants.ts";

/** The street's own rig, and no other. */
const FROM_THE_WINDOW: CameraRange = {
  eye: [STREET_RIG.eye, STREET_RIG.eye],
  horizon: [STREET_RIG.horizon, STREET_RIG.horizon],
  focal: [STREET_RIG.focal, STREET_RIG.focal],
  pitch: [STREET_RIG.pitch, STREET_RIG.pitch],
};

export const cityLayer: LayerDef = {
  id: "city",
  title: "City",
  composers: ["outdoor"],
  role: "backdrop",
  bands: ["far", "middle"],
  space: { anchors: [], claims: [] },
  camera: FROM_THE_WINDOW,
  switch: toggle(
    "layers",
    "city",
    "city",
    false,
    "The blocks round the crossing: shops, izakaya, a konbini on the corner, bars and a karaoke hall up the side street, their windows, fascias, blade signs and awnings, the light they spill onto the sidewalks; the skyline beyond, as the view rises to it.",
    { icon: "city" },
  ),
  params: [
    range(
      "city",
      "signs",
      "sign glow",
      0.7,
      "How brightly the blade signs, the fascias, the konbini and the shop windows glow, and how much light they spill onto the sidewalks.",
    ),
    range(
      "city",
      "windows",
      "lit windows",
      0.5,
      "Windows lit in the rooms over the shops, switching on and off now and then; in the rain the wet street mirrors them too.",
    ),
  ],
  groups: {
    city: { title: "City", blurb: "The shops, signs and windows round the crossing." },
  },
  lights: [{ name: "shops", glsl: "citySpillLight" }],
  // The far rain fuses into the cloud base the city lights from below; seen from the window the drops'
  // paths converge below the street (citySeen); none falls at arm's length from the glass.
  precip: { thin: [1, 0], air: "cityRainAir", seen: "citySeen" },
  passes: { begin: "cityBegin", sky: "citySky", far: "cityFar", air: "cityAir" },
};

export const crossingLayer: LayerDef = {
  id: "crossing",
  title: "Crossing",
  composers: ["outdoor"],
  role: "ground",
  bands: ["middle"],
  space: { anchors: [], claims: [] },
  camera: FROM_THE_WINDOW,
  switch: toggle(
    "layers",
    "crossing",
    "crossing",
    false,
    "The scramble crossing itself: the avenue's asphalt and the side street's, kerbs and paved sidewalks with their yellow tactile strips, lane lines, arrows, stop lines and five zebras; wet, a mirror of signs, windows and lamps streaked toward you, puddles ringing; under snow, wheel tracks and trodden crosswalks.",
    { icon: "road" },
  ),
  params: [
    toggle(
      "manifold",
      "crossingMark",
      "zebra M",
      false,
      "The diagonal crosswalks repainted as a V between the two straight ones, so that from up here the zebras spell the Manifold M across the crossing, in the accent colour; the crowd still crosses over it every way.",
    ),
  ],
  groups: {
    manifold: { title: "Manifold mark", blurb: "A landmark of its own: the crossing's paint." },
  },
  mark: "crossingMark",
  passes: { ground: "crossingGround" },
};

export const kerbsideLayer: LayerDef = {
  id: "kerbside",
  title: "Kerbside",
  composers: ["outdoor"],
  role: "dressing",
  bands: ["middle"],
  space: { anchors: [], claims: [] },
  camera: FROM_THE_WINDOW,
  switch: toggle(
    "layers",
    "kerbside",
    "kerbside",
    false,
    "What stands at the kerbs: lamp posts reaching over the road, each coming on at its own moment at dusk, signal poles with the avenue's and the side street's lights and the walk signals, two vending machines glowing white.",
    { icon: "bulb" },
  ),
  params: [],
  groups: {},
  lights: [{ name: "lamps", glsl: "kerbsideLight" }],
  passes: { middle: "kerbsideMiddle" },
};

export const streetLifeLayer: LayerDef = {
  id: "streetLife",
  title: "Street life",
  composers: ["outdoor"],
  role: "life",
  bands: ["middle"],
  space: { anchors: [], claims: [] },
  camera: FROM_THE_WINDOW,
  switch: toggle(
    "layers",
    "streetLife",
    "street life",
    false,
    "The people and the traffic, and the lights they keep to: walkers gathering at the kerbs and crossing every way at once when the lights turn, cyclists, cars, taxis and vans queueing at the red and flowing on the green.",
    { icon: "person" },
  ),
  params: [
    range(
      "people",
      "crowd",
      "crowd",
      0.5,
      "How many people are out: a few late walkers, an evening's comings and goings, or a Friday-night crowd that floods every crosswalk at once when the lights turn.",
    ),
    range(
      "people",
      "signal",
      "signal cycle",
      80,
      "Seconds for the lights to come round: the avenue's traffic, then the side street's, then every crosswalk at once (diagonals too) until the green men flash. Now (or a click on the street): the lights change.",
      { min: 50, max: 120, step: 5 },
    ),
    feature(
      "people",
      "outing",
      "school outing",
      true,
      "how often",
      0.3,
      "Now and then a teacher leads a line of small children in yellow hats across, two by two, an assistant at the back; they wait at the kerb with everyone else. Now: one sets out.",
    ),
    range(
      "traffic",
      "traffic",
      "traffic",
      0.5,
      "Cars, taxis, kei cars, vans and bicycles: they queue at the red with their brake lights on and flow on the green; eastbound cars turn into the side street, and the side street's turn out onto the avenue.",
    ),
    feature(
      "traffic",
      "delivery",
      "late delivery",
      false,
      "how often",
      0.4,
      "Now and then a white van comes along the avenue, crosses the junction and pulls in at the far kerb past the konbini, clear of the crossing. Its hazards blink while the driver wheels stacks of crates across the sidewalk to the shop's service door and back, a few trips; walkers step round the trolley, cyclists swing out round the van once no car is coming, and it pulls out when the lane behind is clear. How often: from about every ten minutes to every two. Now: one sets out.",
    ),
  ],
  groups: {
    people: {
      title: "People",
      blurb:
        "The crowd and the lights it keeps to. Hover the street and the people under the pointer look up at your window; click to change the lights.",
    },
    traffic: { title: "Traffic", blurb: "What drives through between the crossings." },
  },
  triggers: ["signal", "outing", "delivery"],
  data: STREET_DATA.streetLife,
  passes: { middle: "streetLifeMiddle", middleVeil: "streetLifeMiddleVeil" },
};
