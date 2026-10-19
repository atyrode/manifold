// Shared GLSL libraries, compiled into every scene's program after the common preamble and the scene's
// compile-time features: the sky (clock, sun and moon, the moon's phase and coverage, camera ray, sky
// dome, stars, facing, mirror, haze), clouds in tiers (the deck's plane and calm deck, the lit deck,
// its shadows, a sea of tops seen from above: only up to the scene's CLOUD_TIER, the lit deck when it
// selects none), weather (rain, snow, rain on glass, ripples, fog, overcast, rain shafts), surfaces
// (ground and water planes, Fresnel, ripple trains and spectra), water in tiers (wind ripples, mirror,
// currents, caustics: only up to the scene's WATER_TIER), lightning, aurora, meteors and the weather
// under a closed canopy. Signatures and conventions: src/scenes/README.md.

import { auroraGlsl } from "./aurora.ts";
import { canopyGlsl } from "./canopy.ts";
import { cloudDeckGlsl } from "./clouds.ts";
import { lightningGlsl } from "./lightning.ts";
import { meteorsGlsl } from "./meteors.ts";
import { skyGlsl } from "./sky.ts";
import { surfaceGlsl } from "./surface.ts";
import { waterGlsl } from "./water.ts";
import { weatherGlsl } from "./weather.ts";

export const libs =
  skyGlsl +
  cloudDeckGlsl +
  weatherGlsl +
  surfaceGlsl +
  waterGlsl +
  lightningGlsl +
  auroraGlsl +
  meteorsGlsl +
  canopyGlsl;
