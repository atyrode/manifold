// The `interior` composer (ADR 0062 Phase 3, README "The interior composer"): a room seen by a level
// eye over a ledge, and its layers in canonical order, the order they are placed in and paint in
// (room.ts). The manifests alone: their code is in interior-code.ts, which a composed scene's code
// module loads.
//   backdrops  cityWindow (sill), papered (lava), veranda (bonsai), shaftWall (incense), frostView
//              (frost)
//   grounds    sill (sill), sideboard (lava), stand (bonsai), lowTable (incense)
//   dressings  props (sill), incense (incense; before the lamp, whose `hand` it keeps unqualified),
//              lavaLamp (lava; drawn from the rig, offered to every room an eye 0.2 m or more over
//              its ledge), cat (sill), curtain (sill), bonsaiTree (bonsai), frostGlass (frost; on
//              a window's glass, offered to every room whose window has glass: its far veil)
import { bonsaiTreeLayer, standLayer, verandaLayer } from "../scenes/bonsai/layers.ts";
import { frostGlassLayer, frostViewLayer } from "../scenes/frost/layers.ts";
import { incenseLayer, lowTableLayer, shaftWallLayer } from "../scenes/incense/layers.ts";
import { lavaLampLayer, paperedLayer, sideboardLayer } from "../scenes/lava/layers.ts";
import {
  catLayer,
  cityWindowLayer,
  curtainLayer,
  propsLayer,
  sillLayer,
} from "../scenes/sill/layers.ts";
import type { Composer } from "./compose.ts";

export const interior: Composer = {
  id: "interior",
  layers: [
    cityWindowLayer,
    paperedLayer,
    verandaLayer,
    shaftWallLayer,
    frostViewLayer,
    sillLayer,
    sideboardLayer,
    standLayer,
    lowTableLayer,
    propsLayer,
    incenseLayer,
    lavaLampLayer,
    catLayer,
    curtainLayer,
    bonsaiTreeLayer,
    frostGlassLayer,
  ],
};
