// The `interior` composer (ADR 0062 Phase 3, README "The interior composer"): a room seen by a level
// eye over a ledge, its baseline (ADR 0062 "The interior baseline": the empty room every room is a
// variant of) and its layers in canonical order, the order they are placed in and paint in
// (room.ts). The manifests alone: their code is in interior-code.ts, which a composed scene's code
// module loads.
//   backdrops  cityWindow (sill), papered (lava), veranda (bonsai), shaftWall (incense), frostView
//              (frost), storefront (bar), nightLine (train), quietRoom (mobile)
//   grounds    sill (sill), sideboard (lava), stand (bonsai), lowTable (incense), booth (bar),
//              compartment (train)
//   dressings  props (sill), incense (incense; before the lamp, whose `hand` it keeps unqualified),
//              backBar, pendants, ceilingFan (bar), teaGlass, velvetCurtain (train; before the lamp,
//              whose `mark` and the like they keep unqualified), solarMobile (mobile; its Sun's
//              shadows the room's through roomRayCaster), lavaLamp (lava; drawn from the rig,
//              offered to every room), cat (sill), curtain (sill), bonsaiTree (bonsai), frostGlass
//              (frost; on a window's glass, offered to every room whose window has glass: its far
//              veil)
import {
  backBarLayer,
  boothLayer,
  ceilingFanLayer,
  pendantsLayer,
  storefrontLayer,
} from "../scenes/bar/layers.ts";
import { bonsaiTreeLayer, standLayer, verandaLayer } from "../scenes/bonsai/layers.ts";
import { frostGlassLayer, frostViewLayer } from "../scenes/frost/layers.ts";
import { incenseLayer, lowTableLayer, shaftWallLayer } from "../scenes/incense/layers.ts";
import { lavaLampLayer, paperedLayer, sideboardLayer } from "../scenes/lava/layers.ts";
import { quietRoomLayer, solarMobileLayer } from "../scenes/mobile/layers.ts";
import { SILL_RIG, SILL_ROOM } from "../scenes/sill/constants.ts";
import {
  catLayer,
  cityWindowLayer,
  curtainLayer,
  propsLayer,
  sillLayer,
} from "../scenes/sill/layers.ts";
import {
  compartmentLayer,
  nightLineLayer,
  teaGlassLayer,
  velvetCurtainLayer,
} from "../scenes/train/layers.ts";
import type { Composer } from "./compose.ts";
import type { Baseline } from "./types.ts";

export const interior: Composer & { readonly baseline: Baseline } = {
  id: "interior",
  // An empty room at dusk at the sill's rest pose: the window onto the city over the bare sill, the
  // plum wall, the reading lamp out of frame, the plainest ink the rooms share (the incense's and
  // the frost's) and no vignette; no light elements yet (ADR 0062 step 2). Until the shell is one in
  // metres (step 2), a variant on its own shell layers brings its camera and its room with them.
  // Its own scene is `room`, lab-only (D13).
  baseline: {
    composer: "interior",
    rig: SILL_RIG,
    room: SILL_ROOM,
    grade: { ink: { gain: 1.25, gamma: 1 } },
    // Dusk over the city, its stars thinner in the city's glow, a cloud deck lit from below at
    // night, no Milky Way over the city. A room lists no birds (compose.ts), nor reads the meteors'
    // field, the flyway or the floor (its window's view keeps its own): these name them only to
    // satisfy a preset's options.
    world: {
      time: 0.8,
      stars: 0.5,
      clouds: 0.35,
      milkyWay: { on: false },
      birds: { kind: "pigeons", help: "" },
    },
    meteors: [-0.5, 0.3, 1, 0.12],
    flyway: { depth: [16, 120], above: 0.04, top: 0.9, seed: 3.1, skim: 10, spread: 1, ext: 0.004 },
    floor: "earth",
    layers: ["cityWindow", "sill"],
    values: {},
    elements: [],
  },
  layers: [
    cityWindowLayer,
    paperedLayer,
    verandaLayer,
    shaftWallLayer,
    frostViewLayer,
    storefrontLayer,
    nightLineLayer,
    quietRoomLayer,
    sillLayer,
    sideboardLayer,
    standLayer,
    lowTableLayer,
    boothLayer,
    compartmentLayer,
    propsLayer,
    incenseLayer,
    backBarLayer,
    pendantsLayer,
    ceilingFanLayer,
    teaGlassLayer,
    velvetCurtainLayer,
    solarMobileLayer,
    lavaLampLayer,
    catLayer,
    curtainLayer,
    bonsaiTreeLayer,
    frostGlassLayer,
  ],
};
