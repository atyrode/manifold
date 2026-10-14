// Shared GLSL libraries, compiled into every scene's program after the common preamble and the scene's
// compile-time features: the sky (clock, sun and moon, the moon's phase and coverage, camera ray, sky
// dome, stars, cloud deck, facing, mirror, haze), weather (rain, snow, rain on glass, ripples, fog,
// overcast, rain shafts), surfaces (ground and water planes, Fresnel, ripple trains), lightning, aurora,
// meteors and the weather under a closed canopy. Signatures and conventions: src/scenes/README.md.

import { auroraGlsl } from "./aurora.ts";
import { canopyGlsl } from "./canopy.ts";
import { lightningGlsl } from "./lightning.ts";
import { meteorsGlsl } from "./meteors.ts";
import { skyGlsl } from "./sky.ts";
import { surfaceGlsl } from "./surface.ts";
import { weatherGlsl } from "./weather.ts";

export const libs = skyGlsl + weatherGlsl + surfaceGlsl + lightningGlsl + auroraGlsl + meteorsGlsl + canopyGlsl;
