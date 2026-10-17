import { describe, expect, test } from "bun:test";
import { SKY_PLANET_CAP, SKY_PLANET_FLAGS, SKY_PLANET_ROWS } from "../shaders/lib/sky.ts";
import { sceneDefs } from "./index.ts";
import {
  decodePlanets,
  encodePlanets,
  GIANT_KEYS,
  PLANET_CAP,
  PLANET_FIELDS,
  PLANET_KINDS,
  planetDefaults,
  planetDefs,
  planetRadius,
  planetUniforms,
  readPlanet,
  type SkyPlanet,
  type SkyPlanets,
} from "./planets.ts";

const spec: SkyPlanets = { group: "sky", across: [-40, -10, 30], up: [2, 20, 44] };

/** base64url of raw bytes, for hand-made lists. */
const packed = (...bytes: number[]) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

/** A deterministic source of uniform numbers in [0, 1). */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

/** A planet with every knob at a random value of its own (not always on its grid). */
function anyPlanet(next: () => number): SkyPlanet {
  const values: Record<string, number> = {};
  for (const def of planetDefs(spec)) {
    switch (def.kind) {
      case "range":
        values[def.key] = def.min + next() * (def.max - def.min);
        break;
      case "choice":
        values[def.key] = def.options[Math.floor(next() * def.options.length)]?.value ?? 0;
        break;
      case "feature":
        values[def.key] = next() < 0.5 ? 1 : 0;
        values[`${def.key}-amount`] = def.options
          ? (def.options[Math.floor(next() * def.options.length)]?.value ?? 0)
          : def.min + next() * (def.max - def.min);
        break;
      case "toggle":
        values[def.key] = next() < 0.5 ? 1 : 0;
        break;
      case "seed":
        throw new Error("a planet has no seed");
      default: {
        const unreachable: never = def;
        throw new Error(`unknown knob ${String(unreachable)}`);
      }
    }
  }
  return readPlanet(spec, values);
}

describe("a planet's knobs", () => {
  test("sit on whole steps of their grid, so the URL packs whole numbers", () => {
    for (const kind of PLANET_KINDS) {
      for (const def of planetDefs(spec, kind.value)) {
        if (def.kind !== "range" && (def.kind !== "feature" || def.options)) continue;
        for (const value of [def.min, def.max, def.value]) {
          const steps = value / def.step;
          expect({ key: def.key, whole: Math.abs(steps - Math.round(steps)) < 1e-9 }).toEqual({
            key: def.key,
            whole: true,
          });
        }
      }
    }
  });

  test("start as the night sky's one giant did: the banded teal giant with its thin ring where the pad starts", () => {
    const planet = planetDefaults(spec);
    expect(planet).toMatchObject({ kind: 0, size: 0.55, palette: 0, ring: 1, across: -10, up: 20 });
    expect(planet).toMatchObject({ orbit: 0, phases: 0, spin: 1, moons: 0, eclipses: 1 });
    // Every old key of the giant names one of the planet's.
    for (const key of Object.values(GIANT_KEYS)) expect(Object.keys(planet)).toContain(key);
  });

  test("palettes are the kind's own, four each, the banded giant's the night sky giant's", () => {
    expect(PLANET_KINDS).toHaveLength(9);
    expect(PLANET_KINDS.map((kind) => kind.palettes.length)).toEqual(Array(9).fill(4));
    const palette = planetDefs(spec, 0).find((def) => def.key === "palette");
    if (palette?.kind !== "choice") throw new Error("no palette");
    expect(palette.options.map((option) => option.label)).toEqual(["teal", "amber", "rose", "ice"]);
  });

  test("read back clamped and on their grid, a choice they lack at its default", () => {
    const planet = readPlanet(spec, {
      size: 7,
      across: -999,
      up: 21.37,
      kind: 4.5,
      palette: 9,
      orbit: 1,
    });
    expect(planet).toMatchObject({ size: 1, across: -40, up: 21, kind: 0, palette: 0, orbit: 1 });
    expect(readPlanet(spec, { spin: Number.NaN })["spin"]).toBe(1);
  });
});

describe("the planets' URL value", () => {
  test("is empty for none, and holds only what differs from the defaults", () => {
    expect(encodePlanets(spec, [])).toBe("");
    expect(decodePlanets(spec, "")).toEqual([]);
    // Version 1, one planet, no values of its own.
    expect(encodePlanets(spec, [planetDefaults(spec)])).toBe(packed(1, 1, 0));
    // One value: field 1 (size) at 80 hundredths, zigzagged to 160, a varint of two bytes.
    expect(encodePlanets(spec, [readPlanet(spec, { size: 0.8 })])).toBe(packed(1, 1, 1, 1, 160, 1));
    // Where it stands is its scene's: the same planet, written for another stretch of sky.
    const other: SkyPlanets = { ...spec, across: [-40, 12, 30] };
    expect(encodePlanets(other, [readPlanet(other, { across: 12 })])).toBe(packed(1, 1, 0));
  });

  test("round-trips every list exactly, and its own text", () => {
    const next = random(7);
    for (let n = 0; n < 200; n++) {
      const planets = Array.from({ length: 1 + Math.floor(next() * PLANET_CAP) }, () =>
        anyPlanet(next),
      );
      const text = encodePlanets(spec, planets);
      expect(/^[A-Za-z0-9_-]+$/.test(text)).toBe(true);
      expect(decodePlanets(spec, text)).toEqual(planets);
      expect(encodePlanets(spec, decodePlanets(spec, text))).toBe(text);
    }
  });

  test("turns bad input into no planets, or clamps what it can read, and never throws", () => {
    for (const text of [
      "%%",
      "A",
      "AQ",
      "Ag",
      packed(2, 1, 0),
      packed(1, 2, 0),
      packed(1, 1, 0, 9),
      packed(1, 1, 1, 1),
    ])
      expect({ text, planets: decodePlanets(spec, text) }).toEqual({ text, planets: [] });
    // A count far past what the bytes hold runs out.
    expect(decodePlanets(spec, packed(1, 0xff, 0xff, 0xff, 0xff, 0x0f, 0))).toEqual([]);
    // A field this version does not know is left out; a value out of range is clamped.
    expect(decodePlanets(spec, packed(1, 1, 2, 120, 4, 1, 200, 3))).toEqual([
      readPlanet(spec, { size: 1 }),
    ]);
    // A palette the kind lacks (5) is its first.
    expect(decodePlanets(spec, packed(1, 1, 1, 2, 10))).toEqual([planetDefaults(spec)]);
    // Past the cap, the first PLANET_CAP.
    const many = packed(1, PLANET_CAP + 3, ...Array<number>(PLANET_CAP + 3).fill(0));
    expect(decodePlanets(spec, many)).toHaveLength(PLANET_CAP);
  });

  test("keeps every published field: its id, its key and the quantum its whole number counts", () => {
    // As published, append only: a field moved, renamed or requantised rescales every link holding it.
    const published: readonly (readonly [string, number])[] = [
      ["kind", 1],
      ["size", 0.01],
      ["palette", 1],
      ["across", 1],
      ["up", 1],
      ["orbit", 1],
      ["orbit-amount", 0.5],
      ["incline", 1],
      ["phase", 0.01],
      ["phases", 1],
      ["daycycle", 1],
      ["daycycle-amount", 0.05],
      ["spin", 0.05],
      ["ring", 1],
      ["ringTilt", 0.01],
      ["ringRoll", 0.01],
      ["moons", 1],
      ["moons-amount", 1],
      ["moonSize", 0.1],
      ["eclipses", 1],
      ["aurora", 1],
      ["aurora-amount", 0.05],
      ["auroraSize", 0.05],
      ["lights", 1],
      ["twinkle", 0.05],
    ];
    expect(PLANET_FIELDS.slice(0, published.length)).toEqual([...published]);
    // Each names a knob of every kind, whose grid is whole quanta: a link carries its value exactly.
    for (const kind of PLANET_KINDS) {
      const defs = planetDefs(spec, kind.value);
      for (const [key, unit] of PLANET_FIELDS) {
        const amount = key.endsWith("-amount");
        const name = amount ? key.slice(0, -"-amount".length) : key;
        const def = defs.find((each) => each.key === name);
        const grid =
          def?.kind === "range" || (amount && def?.kind === "feature" && !def.options)
            ? def.step
            : 1;
        const quanta = grid / unit;
        const whole = Math.abs(quanta - Math.round(quanta)) < 1e-9;
        expect({ key, knob: def !== undefined, whole }).toEqual({ key, knob: true, whole: true });
      }
    }
  });

  test("reads the links already shared as it always has", () => {
    const shared: readonly (readonly [string, readonly Record<string, number>[]])[] = [
      ["AQEBAaAB", [{ size: 0.8 }]],
      [
        "AQENAAYBNgIEAzIEUAxeDQQOWg9jEAIRBhJKEwA",
        [
          {
            kind: 3,
            size: 0.27,
            palette: 2,
            across: 25,
            up: 40,
            spin: 2.35,
            ring: 2,
            ringTilt: 0.45,
            ringRoll: -0.5,
            moons: 1,
            "moons-amount": 3,
            moonSize: 3.7,
            eclipses: 0,
          },
        ],
      ],
      [
        "AQIHA0sEBgUCBgoHOwgyCQIJAAgBCgoCCwYUAhUOFhoXAhgQ",
        [
          {
            across: -38,
            up: 3,
            orbit: 1,
            "orbit-amount": 2.5,
            incline: -30,
            phase: 0.25,
            phases: 1,
          },
          {
            kind: 4,
            size: 0.05,
            daycycle: 1,
            "daycycle-amount": 0.15,
            aurora: 1,
            "aurora-amount": 0.35,
            auroraSize: 0.65,
            lights: 1,
            twinkle: 0.4,
          },
        ],
      ],
    ];
    for (const [text, values] of shared) {
      const planets = decodePlanets(spec, text);
      expect(planets).toHaveLength(values.length);
      values.forEach((set, n) => expect(planets[n]).toMatchObject(set));
      expect(encodePlanets(spec, planets)).toBe(text);
    }
  });
});

describe("the planets as the shader takes them", () => {
  const row = (data: Float32Array, slot: number, at: number) =>
    Array.from(
      data.slice((slot * SKY_PLANET_ROWS + at) * 4, (slot * SKY_PLANET_ROWS + at + 1) * 4),
    );
  const field = (flags: number, name: keyof typeof SKY_PLANET_FLAGS) => {
    const [shift, bits] = SKY_PLANET_FLAGS[name];
    return (flags >> shift) & ((1 << bits) - 1);
  };

  test("come smaller first, each with its place in the list as its seed, the rest of the rows empty", () => {
    const planets = [
      readPlanet(spec, { size: 0.9, kind: 3, palette: 2 }),
      readPlanet(spec, { size: 0.3, kind: 7, moons: 1, "moons-amount": 3, lights: 1 }),
    ];
    const { count, data } = planetUniforms(planets);
    expect(count).toBe(2);
    expect(data).toHaveLength(SKY_PLANET_CAP * SKY_PLANET_ROWS * 4);
    const first = row(data, 0, 2)[3] ?? 0;
    const second = row(data, 1, 2)[3] ?? 0;
    expect([
      field(first, "kind"),
      field(first, "seed"),
      field(first, "moons"),
      field(first, "lights"),
    ]).toEqual([7, 1, 3, 1]);
    expect([field(second, "kind"), field(second, "palette"), field(second, "seed")]).toEqual([
      3, 2, 0,
    ]);
    expect(row(data, 0, 1)[3]).toBeCloseTo(planetRadius(0.3));
    expect(row(data, 1, 1)[3]).toBeCloseTo(planetRadius(0.9));
    expect(data.slice(2 * SKY_PLANET_ROWS * 4).every((value) => value === 0)).toBe(true);
    expect(planetUniforms([]).count).toBe(0);
  });

  test("a fixed planet stands where its pad puts it, among the stars", () => {
    const { data } = planetUniforms([readPlanet(spec, { across: 20, up: 30 })]);
    const [x, y, z, w] = row(data, 0, 0);
    const rad = Math.PI / 180;
    expect([x, y, z]).toEqual([
      expect.closeTo(Math.cos(30 * rad) * Math.sin(20 * rad), 6),
      expect.closeTo(Math.sin(30 * rad), 6),
      expect.closeTo(Math.cos(30 * rad) * Math.cos(20 * rad), 6),
    ]);
    expect(w).toBe(0);
  });

  /** An orbiting planet's centre at motion time t, as skyGiant works it out. */
  const centre = (planet: SkyPlanet, t: number) => {
    const { data } = planetUniforms([planet]);
    const [ax = 0, ay = 0, az = 0, w = 0] = row(data, 0, 0);
    const [bx = 0, by = 0, bz = 0] = row(data, 0, 1);
    const [dx = 0, dy = 0, dz = 0] = row(data, 0, 2);
    const h = w * t;
    return [
      dx + ax * Math.cos(h) + bx * Math.sin(h),
      dy + ay * Math.cos(h) + by * Math.sin(h),
      dz + az * Math.cos(h) + bz * Math.sin(h),
    ] as const;
  };

  test("an orbiting one tops out where the pad puts it, then sets on the left and comes round again", () => {
    const planet = readPlanet(spec, { orbit: 1, "orbit-amount": 2, across: 0, up: 40 });
    const [x, y, z] = centre(planet, 0);
    expect(x).toBeCloseTo(0, 5);
    expect(y).toBeCloseTo(Math.sin((40 * Math.PI) / 180), 5);
    expect(z).toBeCloseTo(Math.cos((40 * Math.PI) / 180), 5);
    // On its way, moving to the left, lower; under the horizon for part of its period.
    expect(centre(planet, 10)[0]).toBeLessThan(0);
    expect(centre(planet, 10)[1]).toBeLessThan(y);
    const heights = Array.from({ length: 120 }, (_, i) => centre(planet, i)[1]);
    expect(Math.min(...heights)).toBeLessThan(0);
    // Two minutes a circuit: back where it started.
    centre(planet, 120).forEach((value, i) => expect(value).toBeCloseTo([x, y, z][i] ?? 0, 4));
    for (const t of [0, 17, 61]) expect(Math.hypot(...centre(planet, t))).toBeCloseTo(1, 5);
    // A phase starts it round its circuit; a lean tips its path about its highest point.
    expect(centre(readPlanet(spec, { ...planet, phase: 0.5 }), 0)[1]).toBeLessThan(0);
    const leaned = readPlanet(spec, { ...planet, incline: 60 });
    centre(leaned, 0).forEach((value, i) => expect(value).toBeCloseTo([x, y, z][i] ?? 0, 5));
    expect(centre(leaned, 10)[1]).not.toBeCloseTo(centre(planet, 10)[1], 2);
  });
});

test("every scene that takes planets hangs them in a group it has, starting in view", () => {
  for (const scene of Object.values(sceneDefs)) {
    const planets = scene.planets;
    if (planets === undefined) continue;
    expect({
      id: scene.id,
      group: scene.params.some((def) => def.group === planets.group),
    }).toEqual({ id: scene.id, group: true });
    for (const [low, at, high] of [planets.across, planets.up])
      expect({ id: scene.id, inside: low <= at && at <= high }).toEqual({
        id: scene.id,
        inside: true,
      });
    expect(scene.glsl).toContain("skyGiant(");
  }
});
