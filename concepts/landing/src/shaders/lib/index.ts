// Shared GLSL libraries, compiled into every scene's program after the common preamble and the scene's
// compile-time features: the sky (clock, sun and moon, the moon's phase and coverage, camera ray, sky
// dome, stars, cloud deck, facing, mirror, haze), weather (rain, snow, rain on glass, ripples, fog,
// overcast, rain shafts), surfaces (ground and water planes, Fresnel, ripple trains and spectra), water
// in tiers (wind ripples, mirror, currents, caustics: only up to the scene's WATER_TIER), lightning,
// aurora and meteors. Signatures and conventions: src/scenes/README.md.

import { auroraGlsl } from "./aurora.ts";
import { lightningGlsl } from "./lightning.ts";
import { meteorsGlsl } from "./meteors.ts";
import { skyGlsl } from "./sky.ts";
import { surfaceGlsl } from "./surface.ts";
import { waterGlsl } from "./water.ts";
import { weatherGlsl } from "./weather.ts";

export const libs = skyGlsl + weatherGlsl + surfaceGlsl + waterGlsl + lightningGlsl + auroraGlsl + meteorsGlsl;
