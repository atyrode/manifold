// Ripple tank: the physics-lab classic seen from above, its waves thrown as light and shadow on a
// screen. A preset of the `overhead` composer (src/composer, README "The overhead composer"): the
// tank (tank: the screen, the tray, the lamp) and its water (tankWater: the damped wave equation
// stepped on the GPU, sim.ts, set up one experiment after another, layout.ts), with the pond's koi
// to switch on (layers.ts). shader.ts lights the screen or the surface.
import { composeScene } from "../../composer/compose.ts";
import { overhead } from "../../composer/overhead.ts";
import type { OverheadPreset } from "../../composer/types.ts";
import type { SceneDef } from "../types.ts";
import { RIPPLE_ENTER, RIPPLE_EXIT } from "./constants.ts";
import { TANK_SPAN } from "./layers.ts";

const preset: OverheadPreset = {
  id: "ripple",
  composer: "overhead",
  title: "Ripple tank",
  blurb:
    "A physics-lab ripple tank throwing its waves as light on a screen: interference, slits, a lens, Doppler, standing waves.",
  accent: "#ff7e5f",
  look: { color: "full", levels: 4 },
  // Entrance: still water, then the dippers start and the first wavefronts spread across the tank.
  // Exit: the dippers stop and the last waves run out.
  passage: { enter: RIPPLE_ENTER, exit: RIPPLE_EXIT },
  rig: { span: TANK_SPAN, minAspect: 1 },
  // The koi are offered, not home: "Koi in the ripple tank" (presets.ts) switches them on.
  layers: ["tank", "tankWater"],
  // Still air over the tank, as it always stood (the World's wind is 0.2 by default).
  values: { wind: 0 },
};

/** The ripple tank composed (composer/compose.ts): its definition, and what its code is built from. */
export const rippleComposed = composeScene(overhead, preset);

export const rippleScene: SceneDef = { ...rippleComposed.def, code: () => import("./code.ts") };
