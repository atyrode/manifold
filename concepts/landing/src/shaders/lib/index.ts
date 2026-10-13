// Shared GLSL libraries, compiled into every scene's program after the common preamble: the sky
// (clock, sun and moon, camera ray, sky dome, stars, cloud deck), weather (rain, snow, rain on glass,
// ripples, fog), lightning and aurora. Signatures and conventions: src/scenes/README.md.

import { auroraGlsl } from "./aurora.ts";
import { lightningGlsl } from "./lightning.ts";
import { skyGlsl } from "./sky.ts";
import { weatherGlsl } from "./weather.ts";

export const libs = skyGlsl + weatherGlsl + lightningGlsl + auroraGlsl;
