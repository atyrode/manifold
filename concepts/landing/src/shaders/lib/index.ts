// Shared GLSL libraries, compiled into every scene's program after the common preamble: the sky
// (clock, sun and moon, camera ray, sky dome, stars, cloud deck, facing, mirror, haze), weather (rain,
// snow, rain on glass, ripples, fog, overcast, rain shafts), surfaces (ground and water planes,
// Fresnel, ripple trains), lightning, aurora and the giant planet (sphere, surface, rings, moons,
// aurora, city lights). Signatures and conventions: src/scenes/README.md.

import { auroraGlsl } from "./aurora.ts";
import { lightningGlsl } from "./lightning.ts";
import { planetGlsl } from "./planet.ts";
import { skyGlsl } from "./sky.ts";
import { surfaceGlsl } from "./surface.ts";
import { weatherGlsl } from "./weather.ts";

export const libs = skyGlsl + weatherGlsl + surfaceGlsl + lightningGlsl + auroraGlsl + planetGlsl;
