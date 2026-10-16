// The sky's planets: an open list of planets a night sky hangs among its stars, each a look of its
// own (skyGiant in src/shaders/lib/sky.ts draws them; "The sky's planets" in src/scenes/README.md). A
// scene takes them with SceneDef.planets: the lab group they stand in and the stretch of its sky
// their placement pad covers. A planet is a set of values keyed as knobs are (planetDefs: its kind,
// size and palette, where it stands or the path it orbits on, its light and spin, its ring, moons,
// aurora and city lights), so the lab lays out its controls from those defs as it does a scene's
// knobs, and readPlanet reads it as state.ts readParams reads knobs. The whole list rides in one URL
// key, PLANETS_KEY, packed (encodePlanets); the shader takes it as uniforms (planetUniforms).
import { choice, counts, feature, range, readKnobs, toggle, type ParamDef } from "../params.ts";
import { PLANET_BODY_KINDS, PLANET_RINGS } from "../shaders/lib/planet.ts";
import {
  COS_LAT,
  SIN_LAT,
  SKY_PLANET_CAP,
  SKY_PLANET_FLAGS,
  SKY_PLANET_ROWS,
} from "../shaders/lib/sky.ts";

/** A placement's least value, where it starts, and its most. */
export type PlanetSpan = readonly [min: number, at: number, max: number];

/** A scene's planets (SceneDef.planets). */
export interface SkyPlanets {
  /** The lab group whose Night sky section holds them. */
  group: string;
  /**
   * Where a planet stands, in degrees in the scene's sky (the directions its stars are fixed to):
   * across from straight ahead, positive to the right, and up from the horizon. Each is the pad's
   * [least, start, most]: the stretch of sky the scene shows, and where a first planet stands.
   */
  across: PlanetSpan;
  up: PlanetSpan;
}

/** The URL key holding a scene's planets. */
export const PLANETS_KEY = "planets";

/** The most planets a sky holds: the shader draws this many, the lab adds none past it. */
export const PLANET_CAP = SKY_PLANET_CAP;

/** A planet: its values keyed as planetDefs keys them (a feature's amount under `<key>-amount`). */
export type SkyPlanet = Readonly<Record<string, number>>;

/** The lab's words for each kind (PLANET_BODY_KINDS' ids): its name, and what it is. */
const KIND_WORDS: Readonly<Record<string, { label: string; help: string }>> = {
  banded: { label: "banded", help: "a banded gas giant swirled by a great storm" },
  belted: { label: "ringed", help: "a ringed giant with cloud decks and storms, after Orbit's" },
  rocky: { label: "rocky", help: "a cratered rock" },
  ocean: { label: "ocean", help: "an ocean world with ice caps, cloud swirls and the sun's glint" },
  home: {
    label: "home",
    help: "a world like ours, its seas, lands and clouds, its ice and snow coming and going with its own seasons as our climate has them",
  },
  lava: { label: "lava", help: "a dark crust split by glowing molten cracks" },
  crystal: { label: "crystal", help: "a faceted crystal, glinting" },
  eye: { label: "eye", help: "a great eye looking about, now and then blinking" },
  bubble: { label: "bubble", help: "a thin bubble the stars show through" },
};

/** Each kind's lab words, in PLANET_BODY_KINDS' order. */
export const PLANET_KINDS = PLANET_BODY_KINDS.map((kind, value) => {
  const words = KIND_WORDS[kind.id];
  if (words === undefined) throw new Error(`planets: kind "${kind.id}" has no words`);
  return { ...words, value, ring: kind.ring, palettes: kind.palettes };
});

const GROUP = "planet";

/**
 * A planet's knobs, in the lab's order, for a scene's planets and the planet's kind (its palettes'
 * names). Steps are a grid every value sits on (readPlanet), so the URL packs whole numbers. A `when`
 * of "!<key>" shows a knob only while that switch is off.
 */
export function planetDefs(spec: SkyPlanets, kind = 0): ParamDef[] {
  const palettes = PLANET_KINDS[kind]?.palettes ?? PLANET_KINDS[0]?.palettes ?? [];
  return [
    choice(
      GROUP,
      "kind",
      "kind",
      PLANET_KINDS.map(({ label, value }) => ({ label, value })),
      0,
      `What it is: ${PLANET_KINDS.map((each) => `${each.label}, ${each.help}`).join("; ")}. Each kind comes in its own palettes, with its own ring.`,
      { icon: "planet" },
    ),
    range(
      GROUP,
      "size",
      "size",
      0.55,
      "How big it looks: as small as our moon to the left, a giant filling a good part of the sky to the right. A bigger planet is a nearer one and stands in front of a smaller.",
      { min: 0.05, max: 1, step: 0.01 },
    ),
    choice(
      GROUP,
      "palette",
      "palette",
      palettes.map((palette, value) => ({ label: palette.name, value })),
      0,
      "Its colours, each kind its own.",
      { icon: "palette" },
    ),
    range(
      GROUP,
      "across",
      "planet across",
      spec.across[1],
      "Where it stands across the sky, in degrees round from the sky's straight ahead: lower to the left, higher to the right. Orbiting, where its path is highest.",
      {
        min: spec.across[0],
        max: spec.across[2],
        step: 1,
        widget: { kind: "position", y: "up" },
      },
    ),
    range(
      GROUP,
      "up",
      "planet height",
      spec.up[1],
      "How high it stands, in degrees above the horizon. Orbiting, the height its path tops out at.",
      { min: spec.up[0], max: spec.up[2], step: 1 },
    ),
    feature(
      GROUP,
      "orbit",
      "orbits",
      false,
      "period",
      3,
      "It orbits our world instead of standing among the stars: it rises on the right, climbs to where the pad puts it and sets on the left, drifting against the stars and the day, hidden while it is below the horizon. Period: the minutes one circuit takes, quick to the left.",
      { min: 0.5, max: 20, step: 0.5, icon: "renew" },
    ),
    range(
      GROUP,
      "incline",
      "path tilt",
      0,
      "Leans its path about its highest point, in degrees: 0 rises on the right and sets on the left as the sun does; 90 climbs straight up.",
      { min: -90, max: 90, step: 1, when: "orbit" },
    ),
    range(
      GROUP,
      "phase",
      "phase",
      0,
      "Where along its circuit it starts, as a share of the way round from its highest point.",
      { min: 0, max: 1, step: 0.01, when: "orbit" },
    ),
    toggle(
      GROUP,
      "phases",
      "real phases",
      false,
      "Lit by the scene's own sun, so it waxes and wanes as the sun goes round: full with the sun behind you, a crescent with the sun beyond it. Off: lit from the upper left, as a painted planet is.",
      { icon: "moon" },
    ),
    feature(
      GROUP,
      "daycycle",
      "day cycle",
      false,
      "speed",
      0.3,
      "The light circles slowly: sunrise, day and night sweep across it.",
      { min: 0.05, max: 1, step: 0.05, when: "!phases" },
    ),
    range(
      GROUP,
      "spin",
      "spin",
      1,
      "How fast it turns, its clouds and moons going round with it: 0 holds it still.",
      { min: 0, max: 4, step: 0.05 },
    ),
    choice(
      GROUP,
      "ring",
      "ring",
      PLANET_RINGS.map((label, value) => ({ label, value })),
      1,
      "None; a thin ring of ice; or a wide system of bands that casts its shadow on the planet and lies in the planet's.",
      { icon: "ring" },
    ),
    range(GROUP, "ringTilt", "ring tilt", 0.2, "0: edge-on, a thin line. 1: seen from above.", {
      min: 0.05,
      max: 1,
      step: 0.01,
      when: "ring",
    }),
    range(
      GROUP,
      "ringRoll",
      "ring roll",
      0.32,
      "Turns the ring, and the planet's axis, on screen.",
      {
        min: -1,
        max: 1,
        step: 0.01,
        when: "ring",
      },
    ),
    feature(
      GROUP,
      "moons",
      "moons",
      false,
      "count",
      2,
      "Moons on inclined orbits round it, passing in front of it and its ring or behind them.",
      { options: counts(1, 2, 3) },
    ),
    range(GROUP, "moonSize", "moon size", 2.5, "How big its moons are.", {
      min: 1,
      max: 5,
      step: 0.1,
      when: "moons",
    }),
    toggle(GROUP, "eclipses", "shadows on planet", true, "Its moons cast their shadows on it.", {
      when: "moons",
    }),
    feature(
      GROUP,
      "aurora",
      "aurora",
      false,
      "glow",
      0.6,
      "An auroral oval drifting over its polar night side, rising into curtains off its limb.",
      { min: 0.05, max: 1, step: 0.05 },
    ),
    range(GROUP, "auroraSize", "aurora oval", 0.4, "How far from the pole the oval sits.", {
      when: "aurora",
    }),
    toggle(GROUP, "lights", "city lights", false, "Scattered lights on its night side."),
    range(
      GROUP,
      "twinkle",
      "twinkle",
      0,
      "0 keeps the city lights steady; higher makes them flicker.",
      {
        when: "lights",
      },
    ),
  ];
}

/** The quantum a URL value of `def` comes in: its step, or 1 for a switch or a choice. */
function quantum(def: ParamDef, amount: boolean): number {
  if (def.kind === "range") return def.step;
  if (def.kind === "feature" && amount && def.options === undefined) return def.step;
  return 1;
}

/** `value` on the grid of `quantum`, without float dust. */
function onGrid(value: number, step: number): number {
  const places = Math.max(0, -Math.floor(Math.log10(step)) + 1);
  return Number((Math.round(value / step) * step).toFixed(places));
}

/**
 * A planet from values keyed as planetDefs keys them (anything else is left out): each read as
 * readParams reads a knob (clamped, a switch rounded, a choice only to one of its options, missing
 * or not a number: its default), then put on its step's grid. Every planet the lab holds is one.
 */
export function readPlanet(spec: SkyPlanets, values: Readonly<Record<string, number>>): SkyPlanet {
  const raw = (key: string) => {
    const value = values[key];
    return value === undefined || !Number.isFinite(value) ? null : String(value);
  };
  const kinded = readKnobs(planetDefs(spec), raw);
  const defs = planetDefs(spec, kinded["kind"]);
  const read = readKnobs(defs, raw);
  const out: Record<string, number> = {};
  for (const def of defs) {
    for (const amount of def.kind === "feature" ? [false, true] : [false]) {
      const key = amount ? `${def.key}-amount` : def.key;
      const value = read[key] ?? 0;
      out[key] = onGrid(value, quantum(def, amount));
    }
  }
  return out;
}

/** A planet at the defaults: the banded giant with its thin ring where the scene's pad starts. */
export function planetDefaults(spec: SkyPlanets): SkyPlanet {
  return readPlanet(spec, {});
}

// ---- the URL ------------------------------------------------------------------------------------

/** The packed form's version: the first number of every list. */
const VERSION = 1;

/**
 * Every URL value of a planet, by its id in the packed form (its index): append only, never
 * reorder or reuse, so an old link keeps its meaning.
 */
const FIELDS: readonly string[] = [
  "kind",
  "size",
  "palette",
  "across",
  "up",
  "orbit",
  "orbit-amount",
  "incline",
  "phase",
  "phases",
  "daycycle",
  "daycycle-amount",
  "spin",
  "ring",
  "ringTilt",
  "ringRoll",
  "moons",
  "moons-amount",
  "moonSize",
  "eclipses",
  "aurora",
  "aurora-amount",
  "auroraSize",
  "lights",
  "twinkle",
];

/** Each field's quantum (`quantum`), from the defs, by field id. */
function quanta(defs: readonly ParamDef[]): number[] {
  return FIELDS.map((key) => {
    const amount = key.endsWith("-amount");
    const name = amount ? key.slice(0, -"-amount".length) : key;
    const def = defs.find((each) => each.key === name);
    if (def === undefined) throw new Error(`planets: field "${key}" has no knob`);
    return quantum(def, amount);
  });
}

const zigzag = (n: number) => (n >= 0 ? 2 * n : -2 * n - 1);
const unzigzag = (n: number) => (n % 2 === 0 ? n / 2 : -(n + 1) / 2);

function pushVarint(bytes: number[], n: number): void {
  let rest = n;
  while (rest >= 0x80) {
    bytes.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 0x80);
  }
  bytes.push(rest);
}

/**
 * The list as its URL value: base64url of a byte stream of unsigned varints, the version, the count,
 * then per planet how many of its values differ from their defaults and each of those as its field's
 * id and its value in its field's quantum (zigzag for a sign). Empty for no planets.
 */
export function encodePlanets(spec: SkyPlanets, planets: readonly SkyPlanet[]): string {
  if (planets.length === 0) return "";
  const defaults = planetDefaults(spec);
  const steps = quanta(planetDefs(spec));
  const bytes: number[] = [];
  pushVarint(bytes, VERSION);
  pushVarint(bytes, planets.length);
  for (const planet of planets) {
    const set = FIELDS.flatMap((key, id) => {
      const value = planet[key];
      return value === undefined || value === defaults[key] ? [] : [[id, value] as const];
    });
    pushVarint(bytes, set.length);
    for (const [id, value] of set) {
      pushVarint(bytes, id);
      pushVarint(bytes, zigzag(Math.round(value / (steps[id] ?? 1))));
    }
  }
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/** A stream of varints; undefined once it runs out or holds a malformed one. */
class Reader {
  #at = 0;
  readonly #bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }

  get done(): boolean {
    return this.#at >= this.#bytes.length;
  }

  next(): number | undefined {
    let value = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      const byte = this.#bytes[this.#at++];
      if (byte === undefined) return undefined;
      value += (byte & 0x7f) * 2 ** shift;
      if (byte < 0x80) return value;
    }
    return undefined;
  }
}

/**
 * The list a URL value holds (encodePlanets'), each planet read by readPlanet: values out of range
 * clamped, a choice it lacks at its default, a field this version does not know left out, past
 * PLANET_CAP planets dropped. A value that is not such a list at all (another version, bad
 * base64url, cut short, trailing bytes) gives no planets. Never throws.
 */
export function decodePlanets(spec: SkyPlanets, text: string): SkyPlanet[] {
  if (text === "" || !/^[A-Za-z0-9_-]+$/.test(text)) return [];
  let binary: string;
  try {
    binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  } catch {
    return [];
  }
  const reader = new Reader(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
  const steps = quanta(planetDefs(spec));
  if (reader.next() !== VERSION) return [];
  // Each planet takes a byte at least, so a count past the bytes left runs out instead of reading on.
  const count = reader.next();
  if (count === undefined) return [];
  const planets: SkyPlanet[] = [];
  for (let n = 0; n < count; n++) {
    const fields = reader.next();
    if (fields === undefined) return [];
    const values: Record<string, number> = {};
    for (let f = 0; f < fields; f++) {
      const id = reader.next();
      const raw = reader.next();
      if (id === undefined || raw === undefined) return [];
      const key = FIELDS[id];
      if (key !== undefined) values[key] = unzigzag(raw) * (steps[id] ?? 1);
    }
    planets.push(readPlanet(spec, values));
  }
  if (!reader.done) return [];
  return planets.slice(0, PLANET_CAP);
}

/**
 * The night sky's one giant (the knobs `giantKnobs` gave the sky scenes before the list), by the
 * planet value each became: a link with its switch, GIANT_SWITCH, on opens with that giant as its
 * one planet (state.ts `readPlanets`).
 */
export const GIANT_SWITCH = "planet";
export const GIANT_KEYS: Readonly<Record<string, string>> = {
  "planet-amount": "size",
  planetX: "across",
  planetY: "up",
  planetPalette: "palette",
  planetRing: "ring",
  planetMoons: "moons",
  "planetMoons-amount": "moons-amount",
  planetEclipses: "eclipses",
  planetAurora: "aurora",
  "planetAurora-amount": "aurora-amount",
  planetAuroraSize: "auroraSize",
  planetLights: "lights",
  planetLightsTwinkle: "twinkle",
  planetDaycycle: "daycycle",
  "planetDaycycle-amount": "daycycle-amount",
};

// ---- the shader ---------------------------------------------------------------------------------

/** The planets as skyGiant takes them: how many, and their rows of uPlanets. */
export interface PlanetUniforms {
  count: number;
  data: Float32Array;
}

type Vec3 = [number, number, number];

const radians = (degrees: number) => (degrees * Math.PI) / 180;

/** Where a planet of `size` is drawn, as the tangent of its angular radius: our moon's at 0.05, 0.096 at 0.2, 0.2 at 1. */
export function planetRadius(size: number): number {
  return size < 0.2 ? 0.48 * size : 0.07 + 0.13 * size;
}

/**
 * A planet's path as skyGiant reads it: its centre at the motion clock t is D + A cos(w t) + B sin(w t).
 * Fixed, A is its direction. Orbiting, it rides a daily circle of the sky's latitude (skyBody's) that
 * culminates `up` degrees high straight ahead, leaned `incline` degrees about that highest point and
 * turned round to `across`, `phase` of a circuit on from it at t = 0, a circuit every `orbit-amount`
 * minutes.
 */
function path(planet: SkyPlanet): { a: Vec3; b: Vec3; d: Vec3; w: number } {
  const across = radians(planet["across"] ?? 0);
  const up = radians(planet["up"] ?? 0);
  if ((planet["orbit"] ?? 0) < 0.5)
    return {
      a: [Math.cos(up) * Math.sin(across), Math.sin(up), Math.cos(up) * Math.cos(across)],
      b: [0, 0, 0],
      d: [0, 0, 0],
      w: 0,
    };
  // skyBody(h) = a0 cos h + b0 sin h + d0, at the declination that culminates `up` high.
  const dec = up - radians(90) + Math.asin(SIN_LAT);
  const cd = Math.cos(dec);
  const sd = Math.sin(dec);
  const a0: Vec3 = [0, cd * COS_LAT, cd * SIN_LAT];
  const b0: Vec3 = [-cd, 0, 0];
  const d0: Vec3 = [0, sd * SIN_LAT, -sd * COS_LAT];
  // Each of them leaned about the highest point c (Rodrigues), then turned about the vertical to
  // `across`; the phase turns a0 and b0 round on their circle first.
  const c: Vec3 = [0, Math.sin(up), Math.cos(up)];
  const lean = radians(planet["incline"] ?? 0);
  const place = (v: Vec3): Vec3 => {
    const k = Math.cos(lean);
    const s = Math.sin(lean);
    const dot = c[1] * v[1] + c[2] * v[2];
    const x = v[0] * k + (c[1] * v[2] - c[2] * v[1]) * s;
    const y = v[1] * k + c[2] * v[0] * s + c[1] * dot * (1 - k);
    const z = v[2] * k - c[1] * v[0] * s + c[2] * dot * (1 - k);
    return [
      x * Math.cos(across) + z * Math.sin(across),
      y,
      -x * Math.sin(across) + z * Math.cos(across),
    ];
  };
  const h0 = 2 * Math.PI * (planet["phase"] ?? 0);
  const [cos0, sin0] = [Math.cos(h0), Math.sin(h0)];
  return {
    a: place([b0[0] * sin0, a0[1] * cos0, a0[2] * cos0]),
    b: place([b0[0] * cos0, -a0[1] * sin0, -a0[2] * sin0]),
    d: place(d0),
    w: (2 * Math.PI) / (60 * (planet["orbit-amount"] ?? 3)),
  };
}

/** A feature's amount while it is on, 0 while off (as `effective` hands a knob to the shader). */
const amountOf = (planet: SkyPlanet, key: string) =>
  (planet[key] ?? 0) > 0.5 ? (planet[`${key}-amount`] ?? 0) : 0;

/**
 * The list as uPlanets rows (sky.ts: SKY_PLANET_ROWS each, SKY_PLANET_FLAGS packed), in drawing
 * order: the smaller first, so a bigger planet stands in front (equal sizes in the list's order).
 * Each planet's seed is its place in the list.
 */
export function planetUniforms(planets: readonly SkyPlanet[]): PlanetUniforms {
  const data = new Float32Array(SKY_PLANET_CAP * SKY_PLANET_ROWS * 4);
  const order = planets
    .slice(0, SKY_PLANET_CAP)
    .map((planet, seed) => ({ planet, seed }))
    .sort((a, b) => (a.planet["size"] ?? 0) - (b.planet["size"] ?? 0));
  order.forEach(({ planet, seed }, slot) => {
    const { a, b, d, w } = path(planet);
    const field = (name: keyof typeof SKY_PLANET_FLAGS, value: number) => {
      const [shift, bits] = SKY_PLANET_FLAGS[name];
      return (Math.round(value) & ((1 << bits) - 1)) << shift;
    };
    const flags =
      field("kind", planet["kind"] ?? 0) |
      field("palette", planet["palette"] ?? 0) |
      field("phases", planet["phases"] ?? 0) |
      field("eclipses", planet["eclipses"] ?? 0) |
      field("lights", planet["lights"] ?? 0) |
      field("ring", planet["ring"] ?? 0) |
      field("moons", amountOf(planet, "moons")) |
      field("seed", seed);
    data.set(
      [
        ...a,
        w,
        ...b,
        planetRadius(planet["size"] ?? 0),
        ...d,
        flags,
        amountOf(planet, "daycycle"),
        planet["spin"] ?? 0,
        planet["twinkle"] ?? 0,
        planet["ringTilt"] ?? 0,
        planet["ringRoll"] ?? 0,
        planet["moonSize"] ?? 0,
        amountOf(planet, "aurora"),
        planet["auroraSize"] ?? 0,
      ],
      slot * SKY_PLANET_ROWS * 4,
    );
  });
  return { count: order.length, data };
}
