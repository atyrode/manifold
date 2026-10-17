// The shared GLSL modules (shaders/glsl.ts) and how a program takes them. A scene's program holds
// the modules its GLSL names, each with the modules it requires (those under a feature only in a
// program with that feature), each once, ahead of the scene's GLSL and in the order listed here,
// where every module follows what it requires. A scene that names none (the abstract ones: marble,
// ferro, pearl...) holds none. What each provides and requires: each module's file, and
// src/scenes/README.md ("Composing components").
//
//   worldClock   the world clock's Sky: the clock, sun, moon, date and stars' turn (src/world-clock.ts)
//   climate      the year's cold and what falls in it (src/climate.ts)
//   planet       the shared giant planet (planet.ts)
//   planetBody   the sky's planets' body tier (planet.ts)
//   sky          camera ray, dome, sun and moon, stars, facing, mirror, haze (sky.ts)
//   clouds       the cloud deck in tiers, up to the scene's CLOUD_TIER (clouds.ts)
//   weather      rain, snow, rain on glass, ripples, fog, overcast, rain shafts (weather.ts)
//   surface      ground and water planes, Fresnel, ripple trains and spectra (surface.ts)
//   water        a water surface in tiers, up to the scene's WATER_TIER (water.ts)
//   lightning    strikes, bolts and the flash (lightning.ts)
//   aurora       curtains over the night sky (aurora.ts)
//   meteors      shooting stars (meteors.ts)
//   canopy       the weather under a closed canopy (canopy.ts)
//   canopyGrove  the shafts, crowns and drips under it (canopy.ts)
//   birds        birds in flight (birds.ts)
//   milkyWay     the band of the galaxy (milkyway.ts)
//   world        one atmosphere for every outdoor scene (world.ts)
//   plants       the plant component's organs (plants.ts)
//   fields       farmland rows and flower fields (fields.ts)
//   figures      walkers and vehicles (figures.ts)
//   livestock    cattle and sheep (livestock.ts)
//   terrain      reading packTerrain's textures (terrain.ts)
//   trees        pine and broadleaf crowns (trees.ts)
//   buildings    cottages, churches, smoke and lit windows (../buildings.ts)

import { climateModule } from "../../climate.ts";
import { worldClockModule } from "../../world-clock.ts";
import { buildingsModule } from "../buildings.ts";
import {
  glslActive,
  glslDefinitions,
  glslIdentifiers,
  type GlslFeatures,
  type GlslModule,
} from "../glsl.ts";
import { auroraModule } from "./aurora.ts";
import { birdsModule } from "./birds.ts";
import { canopyGroveModule, canopyModule } from "./canopy.ts";
import { cloudsModule } from "./clouds.ts";
import { fieldsModule } from "./fields.ts";
import { figuresModule } from "./figures.ts";
import { lightningModule } from "./lightning.ts";
import { livestockModule } from "./livestock.ts";
import { meteorsModule } from "./meteors.ts";
import { milkyWayModule } from "./milkyway.ts";
import { planetBodyModule, planetModule } from "./planet.ts";
import { plantsModule } from "./plants.ts";
import { skyModule } from "./sky.ts";
import { surfaceModule } from "./surface.ts";
import { terrainModule } from "./terrain.ts";
import { treesModule } from "./trees.ts";
import { waterModule } from "./water.ts";
import { weatherModule } from "./weather.ts";
import { worldModule } from "./world.ts";

/** Every shared module, each after the modules it requires: the order a program holds them in. */
export const libraryModules: readonly GlslModule[] = [
  worldClockModule,
  climateModule,
  planetModule,
  planetBodyModule,
  skyModule,
  cloudsModule,
  weatherModule,
  surfaceModule,
  waterModule,
  lightningModule,
  auroraModule,
  meteorsModule,
  canopyModule,
  canopyGroveModule,
  birdsModule,
  milkyWayModule,
  worldModule,
  plantsModule,
  fieldsModule,
  figuresModule,
  livestockModule,
  terrainModule,
  treesModule,
  buildingsModule,
];

let providers: ReadonlyMap<string, GlslModule> | undefined;

/** The module that defines each name any module provides (no two modules define one name). */
function provider(name: string): GlslModule | undefined {
  providers ??= new Map(
    libraryModules.flatMap((module) => [...module.provides].map((n) => [n, module] as const)),
  );
  return providers.get(name);
}

/**
 * The modules a program of `glsl` (a scene's GLSL) with these compile-time features holds, in
 * libraryModules order: each module that defines a name the GLSL uses (outside what its conditionals
 * on these features leave out, glslActive) and does not define itself, and everything they require
 * under these features.
 */
export function modulesFor(glsl: string, features: GlslFeatures): GlslModule[] {
  const held = new Set<GlslModule>();
  const hold = (module: GlslModule): void => {
    if (held.has(module)) return;
    held.add(module);
    for (const { module: needed, when } of module.requires) {
      if (when === undefined || when(features)) hold(needed);
    }
  };
  const own = glslDefinitions(glsl);
  for (const name of glslIdentifiers(glslActive(glsl, features))) {
    const module = own.has(name) ? undefined : provider(name);
    if (module !== undefined) hold(module);
  }
  return libraryModules.filter((module) => held.has(module));
}
