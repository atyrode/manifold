// Shared lab knobs for the giant planet (src/shaders/lib/planet.ts): the planet's own features, its
// moons and its ring system, with the same labels, help and defaults in every scene that composes it.
// Each feature is opt-in and starts off, so adopting one never changes a scene's picture; placement,
// size and framing stay the scene's own knobs. The GLSL side takes the values as arguments, read
// through the generated K_<key> defines (see "The giant planet" in src/scenes/README.md).
//
// Keys: unprefixed where the planet is the subject (orbit: K_clouds, K_moons, K_ring...); a sky that
// shows one passes a prefix so the keys never meet its own (campfire's "planet": K_planetMoons,
// K_planetAurora...). Each knob's key is the prefix plus the name below, capitalised after a prefix.
import { choice, counts, feature, range, toggle, type Blurb, type ParamDef } from "../params.ts";

export interface PlanetKnobOptions {
  /** Prepended to every key (camelCase): none for orbit's `moons`, "planet" for campfire's `planetMoons`. */
  prefix?: string;
  /** Lab groups: the planet's own features (default "planet"), its moons ("moons"), its ring system ("ring"). */
  groups?: { planet?: string; moons?: string; ring?: string };
  /** Only shown while this scene toggle or feature is on (a sky's switch for the planet itself). */
  when?: string;
  /** Cloud decks: `clouds`, the cover. */
  clouds?: boolean;
  /** Lightning in the night-side clouds: `storms`, the rate; "now" on this trigger slot. */
  storms?: { trigger: number };
  /** A polar aurora: `aurora`, its glow, and `auroraSize`, how far from the pole the oval sits. */
  aurora?: boolean;
  /** Night-side city lights: `lights`, and `lightsTwinkle`, their flicker. */
  lights?: boolean;
  /** The sun circling the planet: `daycycle`, its speed. */
  daycycle?: boolean;
  /** Up to three moons: `moons`, the count, and `eclipses`, their shadows on the planet. */
  moons?: boolean;
  /** The banded ring system: `ring` and its shape, material, colour and spin (`ringCount` .. `ringSpin`). */
  ring?: boolean;
}

/**
 * The planet's knobs a scene composes, in lab order: clouds, storms, aurora (+ oval size), city lights
 * (+ twinkle), day cycle, then the moons (+ eclipses) and the ring system. All start off.
 */
export function planetKnobs(options: PlanetKnobOptions): ParamDef[] {
  const prefix = options.prefix ?? "";
  const key = (name: string) => (prefix === "" ? name : prefix + name.charAt(0).toUpperCase() + name.slice(1));
  const planet = options.groups?.planet ?? "planet";
  const moons = options.groups?.moons ?? "moons";
  const ring = options.groups?.ring ?? "ring";
  const top: { when?: string } = options.when === undefined ? {} : { when: options.when };
  const knobs: ParamDef[] = [];
  if (options.clouds) knobs.push(feature(planet, key("clouds"), "clouds", false, "cover", 0.6, "Cloud decks drifting over the day side.", top));
  if (options.storms) {
    knobs.push(feature(planet, key("storms"), "storms", false, "frequency", 0.5, "Lightning flashing in the night-side clouds.", { ...top, trigger: options.storms.trigger }));
  }
  if (options.aurora) {
    knobs.push(
      feature(planet, key("aurora"), "aurora", false, "glow", 0.6, "An auroral oval drifting over the polar night side, rising into curtains where it meets the horizon.", top),
      range(planet, key("auroraSize"), "aurora oval", 0.4, "How far from the pole the auroral oval sits.", { when: key("aurora") }),
    );
  }
  if (options.lights) {
    knobs.push(
      toggle(planet, key("lights"), "city lights", false, "Scattered lights on the night side of the planet.", top),
      range(planet, key("lightsTwinkle"), "twinkle", 0, "0 keeps the city lights steady; higher makes them flicker.", { when: key("lights") }),
    );
  }
  if (options.daycycle) {
    knobs.push(feature(planet, key("daycycle"), "day cycle", false, "speed", 0.3, "The sun circles slowly: sunrise, day and night sweep across the planet.", top));
  }
  if (options.moons) {
    knobs.push(
      feature(moons, key("moons"), "moons", false, "count", 2, "Moons on inclined orbits round the planet, passing in front of it and its rings or behind them as their orbits take them.", { ...top, options: counts(1, 2, 3) }),
      toggle(moons, key("eclipses"), "shadows on planet", true, "Moons cast their shadow onto the planet.", { when: key("moons") }),
    );
  }
  if (options.ring) {
    const when = key("ring");
    knobs.push(
      toggle(ring, key("ring"), "ring system", false, "Rings around the planet: they pass behind it, catch its shadow and shade its surface.", top),
      choice(ring, key("ringCount"), "bands", counts(1, 2, 3, 5, 8), 3, "How many separate ring bands.", { when }),
      range(ring, key("ringSpacing"), "spacing", 0.25, "Gap between neighbouring bands, as a share of each band.", { max: 0.8, when }),
      range(ring, key("ringInner"), "inner edge", 0.25, "Gap between the planet and the first band.", { when }),
      range(ring, key("ringWidth"), "span", 0.55, "How far out the outermost band reaches.", { when }),
      range(ring, key("ringTilt"), "tilt", 0.6, "0: edge-on, a thin line. 1: seen from above.", { when }),
      range(ring, key("ringRoll"), "roll", -0.2, "Rotates the ring plane on screen.", { min: -1, max: 1, when }),
      range(ring, key("ringDensity"), "density", 0.75, "How solid the rings look.", { when }),
      choice(ring, key("ringTone"), "colour", [{ label: "accent", value: 0 }, { label: "ink", value: 1 }, { label: "both", value: 2 }], 0, "accent or ink rings; both alternates band by band.", { when }),
      choice(ring, key("ringTexture"), "made of", [{ label: "dust", value: 0 }, { label: "ice", value: 1 }, { label: "rock", value: 2 }], 1, "dust: soft and smooth. ice: fine grooves. rock: separate boulders you can see orbiting.", { when }),
      feature(ring, key("ringSpin"), "spin", true, "speed", 0.4, "The rings orbit the planet; inner bands go faster, as real rings do.", { when }),
    );
  }
  return knobs;
}

/** Lab headings for the planet's groups. */
export const planetGroups: Readonly<Record<"planet" | "moons" | "ring", Blurb>> = {
  planet: { title: "Planet", blurb: "Surface, weather, aurora and the sun's path." },
  moons: { title: "Moons", blurb: "Satellites on inclined orbits, and their eclipses." },
  ring: { title: "Rings", blurb: "A ring system: its shape, what it's made of, and how it moves." },
};
