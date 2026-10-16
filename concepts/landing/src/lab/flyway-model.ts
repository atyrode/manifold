// The birds card's model (flyway.ts), apart from its DOM: how each species flies, how a flight flies
// at a `birdFormation` value (the party birdParty gives it), which of the sky strip's birds are aloft
// for an amount, and where the arrow keys move along a row of tiles. Knob values are read the way
// birdsGlsl reads them; the species' table mirrors its birdSpecies (flyway-model.test.ts holds it to
// the GLSL).
import { BIRD_FORMATIONS, BIRD_KIND, type BirdKind } from "../shaders/lib/birds.ts";

/** A formation a flight flies: a `birdFormation` option other than "usual" (the species' own). */
export type Formation = Exclude<(typeof BIRD_FORMATIONS)[number]["label"], "usual">;

/** Fewest and most birds in a party. */
export type Party = readonly [number, number];

/** Each species' own formation and party: birdSpecies' `formation` and `flock`. */
export const SPECIES_FLIGHT: Readonly<Record<BirdKind, { formation: Formation; flock: Party }>> = {
  rooks: { formation: "party", flock: [2, 6] },
  swallows: { formation: "party", flock: [2, 4] },
  gulls: { formation: "party", flock: [1, 4] },
  geese: { formation: "V", flock: [5, 9] },
  buzzard: { formation: "circling", flock: [1, 1] },
  pigeons: { formation: "circling", flock: [5, 9] },
  swifts: { formation: "party", flock: [3, 7] },
};

/** How a flight flies; undefined where it is each flight's own species' to say (mixed). */
export interface Flight {
  formation: Formation | undefined;
  party: Party | undefined;
}

/** The species in GLSL kind order (BIRD_CROW = 0...). */
const SPECIES = (Object.entries(BIRD_KIND) as [BirdKind, number][])
  .sort(([, a], [, b]) => a - b)
  .map(([label]) => label);

/** The formations in GLSL order (BIRD_SOLO = 0...): the `birdFormation` options after "usual". */
const FORMATIONS = BIRD_FORMATIONS.filter(
  (option): option is Extract<(typeof BIRD_FORMATIONS)[number], { label: Formation }> =>
    option.label !== "usual",
)
  .sort((a, b) => a.value - b.value)
  .map((option) => option.label);

/** The species a `birdKind` value flies, as birdSpecies picks it; undefined below 0 (mixed). */
export function speciesOf(kind: number): BirdKind | undefined {
  if (kind < 0) return undefined;
  return SPECIES[Math.min(SPECIES.length - 1, Math.floor(kind + 0.5))];
}

/** The formation a `birdFormation` value names (the GLSL's value - 1); undefined for "usual". */
export function formationOf(formation: number): Formation | undefined {
  const glsl = formation - 1;
  if (glsl < 0) return undefined;
  return FORMATIONS[Math.min(FORMATIONS.length - 1, Math.floor(glsl + 0.5))];
}

/**
 * How a flight of `kind` flies at `formation` (knob values), as birdCrossing has it: at "usual" the
 * species' own formation and flock; otherwise that formation, one bird alone, a loose party of at
 * least two to four, a V of at least five to nine, or the species' own flock on one circle.
 */
export function flightOf(kind: number, formation: number): Flight {
  const species = speciesOf(kind);
  const own = species === undefined ? undefined : SPECIES_FLIGHT[species];
  const chosen = formationOf(formation);
  if (chosen === undefined) return { formation: own?.formation, party: own?.flock };
  const flock = own?.flock;
  switch (chosen) {
    case "solo":
      return { formation: chosen, party: [1, 1] };
    case "party":
      return { formation: chosen, party: flock && [Math.max(flock[0], 2), Math.max(flock[1], 4)] };
    case "V":
      return { formation: chosen, party: flock && [Math.max(flock[0], 5), Math.max(flock[1], 9)] };
    case "circling":
      return { formation: chosen, party: flock };
    default: {
      const unreachable: never = chosen;
      throw new Error(`landing: unknown formation ${String(unreachable)}`);
    }
  }
}

/** A sky strip bird: across (0..1, left to right), down (0..1 from the top) and size (1 nearest). */
export interface StripBird {
  x: number;
  y: number;
  size: number;
}

const hash = (n: number) => {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};

/** The sky strip's birds, left to right, one in each fourteenth of its width. */
export const STRIP_BIRDS: readonly StripBird[] = Array.from({ length: 14 }, (_, index) => ({
  x: (index + 0.2 + 0.6 * hash(index)) / 14,
  y: 0.18 + 0.56 * hash(index + 31),
  size: 0.6 + 0.4 * hash(index + 57),
}));

/**
 * How many of the strip's birds (`birds`, left to right) are aloft for its fill (the amount's place
 * between its least and most, 0..1): none while off, the first even at the least amount, and every
 * one the fill reaches.
 */
export function aloft(
  on: boolean,
  fill: number,
  birds: readonly StripBird[] = STRIP_BIRDS,
): number {
  if (!on) return 0;
  return Math.max(1, birds.filter((bird) => bird.x <= fill).length);
}

/**
 * Where a key moves along a row of `count` tiles from tile `at` (-1: none chosen): the arrows to the
 * next or previous (right and down, left and up), wrapping round; Home and End to the ends;
 * undefined for other keys.
 */
export function tileStep(key: string, at: number, count: number): number | undefined {
  if (count <= 0) return undefined;
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return at + 1 >= count ? 0 : at + 1;
    case "ArrowLeft":
    case "ArrowUp":
      return at <= 0 ? count - 1 : at - 1;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return undefined;
  }
}
