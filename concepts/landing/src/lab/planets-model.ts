// The Night sky section's planets (nightsky.ts), apart from its DOM: the planet the add button brings
// (where the sky has room for it), the dress a kind arrives in, the list the dice roll, how a planet
// is named and drawn, and its knobs' `when` (a planet's own "!<key>": while that switch is off).
import {
  PLANET_CAP,
  PLANET_KINDS,
  planetDefs,
  planetRadius,
  readPlanet,
  type SkyPlanet,
  type SkyPlanets,
} from "../scenes/planets.ts";
import { rollPatch, type Random } from "./roll-model.ts";

/**
 * The planet the add button brings to `planets`: the next kind in turn in its first palette, with
 * its own ring, at the scene's starting place when no other planet stands within a sixth of the pad
 * across from it, else at the place across the pad farthest from every other. None at PLANET_CAP.
 */
export function addedPlanet(
  spec: SkyPlanets,
  planets: readonly SkyPlanet[],
): SkyPlanet | undefined {
  if (planets.length >= PLANET_CAP) return undefined;
  const kind = planets.length % PLANET_KINDS.length;
  const [low, start, high] = spec.across;
  const room = (across: number) =>
    Math.min(...planets.map((planet) => Math.abs((planet["across"] ?? start) - across)));
  let across = start;
  if (room(start) < (high - low) / 6) {
    for (let step = 0; step <= 16; step++) {
      const at = Math.round(low + ((high - low) * step) / 16);
      if (room(at) > room(across)) across = at;
    }
  }
  return readPlanet(spec, { ...kindPatch(kind), across });
}

/** What picking `kind` sets: the kind, its first palette, and the ring it comes with. */
export function kindPatch(kind: number): Record<string, number> {
  return { kind, palette: 0, ring: PLANET_KINDS[kind]?.ring ?? 0 };
}

/**
 * The planets the dice roll: none half the time, else one to three, each of a random look and
 * place (rollPatch over its knobs).
 */
export function rollPlanets(spec: SkyPlanets, random: Random = Math.random): SkyPlanet[] {
  if (random() < 0.5) return [];
  const count = 1 + Math.floor(random() * 3);
  return Array.from({ length: count }, () => readPlanet(spec, rollPatch(planetDefs(spec), random)));
}

/** Whether a planet's knob that shows `when` shows: always without, "!<key>" while that switch is off. */
export function planetShows(planet: SkyPlanet, when: string | undefined): boolean {
  if (when === undefined) return true;
  return when.startsWith("!") ? (planet[when.slice(1)] ?? 0) <= 0.5 : (planet[when] ?? 0) > 0.5;
}

/** A planet in words: its kind and palette ("banded teal", "lava magma"). */
export function planetName(planet: SkyPlanet): string {
  const kind = PLANET_KINDS[planet["kind"] ?? 0];
  const palette = kind?.palettes[planet["palette"] ?? 0];
  return `${kind?.label ?? "planet"} ${palette?.name ?? ""}`.trim();
}

/** A planet as the drawing shows it. */
export interface PlanetArt {
  /** Across the drawn sky from the left and up it from the horizon, 0..1 each. */
  x: number;
  y: number;
  /** Its radius as a share of the biggest planet's. */
  r: number;
  /** Its palette's mid tone, as a CSS colour. */
  tint: string;
  /** Its ring: 0 none, 1 thin, 2 wide. */
  ring: number;
  /** How many moons circle it, 0 while they are off. */
  moons: number;
  /** While it orbits, its path's lean in degrees (0: as the sun's, rising right, setting left). */
  orbit: number | undefined;
}

const share = ([low, , high]: readonly number[], value: number) =>
  Math.min(1, Math.max(0, (value - (low ?? 0)) / ((high ?? 1) - (low ?? 0))));

/** How the drawing shows `planet` in a sky of `spec`: where it stands, how big, how it is dressed. */
export function planetArt(spec: SkyPlanets, planet: SkyPlanet): PlanetArt {
  const kind = PLANET_KINDS[planet["kind"] ?? 0];
  const mid = kind?.palettes[planet["palette"] ?? 0]?.mid ?? [0.5, 0.5, 0.5];
  const tint = `#${mid
    .map((channel) =>
      Math.round(Math.min(1, channel) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
  return {
    x: share(spec.across, planet["across"] ?? spec.across[1]),
    y: share(spec.up, planet["up"] ?? spec.up[1]),
    r: planetRadius(planet["size"] ?? 0.55) / planetRadius(1),
    tint,
    ring: planet["ring"] ?? 0,
    moons: (planet["moons"] ?? 0) > 0.5 ? Math.round(planet["moons-amount"] ?? 0) : 0,
    orbit: (planet["orbit"] ?? 0) > 0.5 ? (planet["incline"] ?? 0) : undefined,
  };
}
