import { describe, expect, test } from "bun:test";
import { parsePresets, presets } from "./presets.ts";
import { sceneDefs } from "./scenes/index.ts";
import { encodePlanets, planetDefaults, readPlanet } from "./scenes/planets.ts";
import {
  checkMigrations,
  defaults,
  migrate,
  MIGRATIONS,
  paramDefaults,
  readPlanets,
  readSetup,
  readState,
  renameKey,
  resolveScene,
  serialise,
  URL_VERSION,
  UrlSchemaError,
  withVersion,
  type Migration,
} from "./state.ts";

/** A setup query as the page reads it back and writes it again: its scene's knobs and planets, minimal. */
function reread(query: string): string {
  const { state, params, planets } = readSetup(new URLSearchParams(query));
  return serialise(state, params, planets).toString();
}

const q = (query: string) => new URLSearchParams(query);

/** A query with the choice `mode` (0 low, 1 high) renamed to the range `level`. */
function renamed(query: string): string {
  const out = q(query);
  renameKey(out, "mode", "level", { 0: 0.2, 1: 0.9 });
  return out.toString();
}

/**
 * A made-up history over the lake: "fjord" renames a key, then is merged into "tarn" (its curtains
 * becoming tarn's aurora, its cabin, which it never had, switched off), which is renamed "lake"; at
 * last the mirror's 0..100 becomes 0..1.
 */
const history: readonly Migration[] = [
  {
    kind: "keys",
    since: 2,
    migrate: (query, scene) => {
      if (scene === "fjord") renameKey(query, "lights", "curtains", { 0: 0, 1: 1 });
    },
  },
  {
    kind: "alias",
    since: 3,
    from: "fjord",
    to: "tarn",
    keys: (query) => {
      renameKey(query, "curtains", "aurora", { 0: 0, 1: 1 });
      if (!query.has("cabin")) query.set("cabin", "0");
    },
  },
  { kind: "alias", since: 4, from: "tarn", to: "lake" },
  {
    kind: "keys",
    since: 5,
    migrate: (query, scene) => {
      const mirror = query.get("mirror");
      if (scene === "lake" && mirror !== null) query.set("mirror", String(Number(mirror) / 100));
    },
  },
];

describe("an outgrown key", () => {
  test("sets the key that replaced it from its value map and is dropped", () => {
    expect(renamed("a=1&mode=1")).toBe("a=1&level=0.9");
    // However the old link wrote the number.
    expect(renamed("mode=0.0")).toBe("level=0.2");
  });

  test("leaves the new key alone where the setup already sets it, or at its default for a value it never had", () => {
    expect(renamed("level=0.4&mode=1")).toBe("level=0.4");
    expect(renamed("mode=7")).toBe("");
    expect(renamed("mode=")).toBe("");
  });
});

describe("the countryside's old season", () => {
  test("an old link opens at the season's date and is rewritten with it", () => {
    expect(readSetup(q("scene=country&season=0")).params.date).toBe(0.375);
    expect(readSetup(q("scene=country&season=2")).params.date).toBe(0.6);
    expect(reread("scene=country&season=0&crops=0")).toBe("scene=country&crops=0&date=0.375");
    expect(reread("scene=country&season=2&time=0.64")).toBe("scene=country&time=0.64&date=0.6");
    // The harvest was the default and is again.
    expect(reread("scene=country&season=1")).toBe("scene=country");
    expect(readSetup(q("scene=country&season=1")).params).toEqual(paramDefaults("country"));
    // A link that names the date keeps it.
    expect(reread("scene=country&season=0&date=0.2")).toBe("scene=country&date=0.2");
  });

  test("is the countryside's own: another scene's key of that name passes through", () => {
    expect(migrate(q("season=2")).toString()).toBe("season=2");
    expect(migrate(q("scene=garden&season=2")).toString()).toBe("scene=garden&season=2");
  });

  test("a preset saved before the date knob loads at its season, as its rewritten form does", () => {
    const [old] = parsePresets(
      JSON.stringify({
        name: "Countryside · wildwood",
        commit: "defa703a",
        query: "scene=country&time=0.64&season=2&crops=0&woodland-amount=100&pines=0.45",
        savedAt: "2026-10-16",
      }),
    );
    const committed = presets.find((preset) => preset.name === "Countryside · wildwood");
    if (!old || !committed) throw new Error("no wildwood preset");
    expect(readSetup(q(old.query)).params).toEqual(readSetup(q(committed.query)).params);
    expect(readSetup(q(committed.query)).params.date).toBe(0.6);
  });
});

describe("the URL schema", () => {
  test("a link without a version is schema 1, and one of this schema skips what it already has", () => {
    expect(URL_VERSION).toBeGreaterThanOrEqual(2);
    const old = "scene=country&season=2";
    expect(migrate(q(`v=1&${old}`)).toString()).toBe(migrate(q(old)).toString());
    // A version that is no whole number from 1 is no version.
    for (const v of ["abc", "0", "-3", "1.5", ""])
      expect(migrate(q(`v=${v}&${old}`)).toString()).toBe("scene=country&date=0.6");
    // At this schema the countryside has no season: the key is a stray, dropped on writing.
    expect(migrate(q(`v=${URL_VERSION}&${old}`)).toString()).toBe(old);
    expect(reread(`v=${URL_VERSION}&${old}`)).toBe("scene=country");
    // A newer build's link is read as it stands.
    expect(reread(`v=${URL_VERSION + 5}&scene=forest&rain=1`)).toBe("scene=forest&rain=1");
  });

  test("migrations compose in order: a link runs every step past its version, each on the last's output", () => {
    expect(() => checkMigrations(history)).not.toThrow();
    // Schema 1: renamed, merged, renamed again, rescaled.
    expect(migrate(q("scene=fjord&lights=1&mirror=40"), history).toString()).toBe(
      "scene=lake&mirror=0.4&aurora=1&cabin=0",
    );
    expect(migrate(q("v=2&scene=fjord&curtains=1&mirror=40"), history).toString()).toBe(
      "scene=lake&mirror=0.4&aurora=1&cabin=0",
    );
    // Later links skip the steps they already have.
    expect(migrate(q("v=4&scene=lake&mirror=40"), history).toString()).toBe(
      "scene=lake&mirror=0.4",
    );
    expect(migrate(q("v=5&scene=lake&mirror=0.4"), history).toString()).toBe(
      "scene=lake&mirror=0.4",
    );
    // A lake link from before versions is rescaled too, and nothing else touches it.
    expect(migrate(q("scene=lake&mirror=40&cabin=1"), history).toString()).toBe(
      "scene=lake&mirror=0.4&cabin=1",
    );
  });

  test("a retired scene's link opens its successor with its keys moved there", () => {
    // The lake's aurora is on by default: the fjord's curtains were off.
    const read = readSetup(q("scene=fjord&lights=0&curtains-amount=0.9&mirror=40"), history);
    expect(read.state.scene).toBe("lake");
    expect(read.unknownScene).toBeUndefined();
    expect(read.params).toMatchObject({ aurora: 0, mirror: 0.4, cabin: 0 });
    // Keys the alias leaves alone carry over: curtains-amount is not lake's, so it goes.
    expect(serialise(read.state, read.params, read.planets).toString()).toBe(
      "scene=lake&aurora=0&mirror=0.4&cabin=0",
    );
    // Through every alias, at any schema, as a tour reads it.
    expect(resolveScene("fjord", history)).toBe("lake");
    expect(resolveScene("tarn", history)).toBe("lake");
    expect(resolveScene("lake", history)).toBe("lake");
    expect(resolveScene("nowhere", history)).toBeUndefined();
    // This build retires none of them.
    expect(resolveScene("fjord")).toBeUndefined();
  });

  test("an unknown scene opens the default scene with the link's lab settings, and is reported", () => {
    const read = readSetup(q("scene=nowhere&motion=0.2"));
    expect(read.unknownScene).toBe("nowhere");
    expect(read.state.scene).toBe(defaults.scene);
    expect(read.state.motion).toBe(0.2);
    expect(read.params).toEqual(paramDefaults(defaults.scene));
    // Retired at a schema the link already has: no alias runs, so the scene is unknown.
    expect(readSetup(q("v=3&scene=fjord"), history).unknownScene).toBe("fjord");
    for (const known of ["scene=lake", "", "scene=", `scene=${defaults.scene}`])
      expect(readSetup(q(known)).unknownScene).toBeUndefined();
  });

  test("a link carries its version only where a reader taking it for schema 1 would misread it", () => {
    for (const setup of ["", "scene=lake&cabin=0", "scene=lake&mirror=0.4", "scene=fjord"]) {
      const written = withVersion(q(setup), history);
      // Whatever it carries, it reads back as written.
      expect(migrate(written, history).toString()).toBe(setup);
    }
    expect(withVersion(q("scene=lake&cabin=0"), history).toString()).toBe("scene=lake&cabin=0");
    // A mirror of this schema would be rescaled again as schema 1's.
    expect(withVersion(q("scene=lake&mirror=0.4"), history).toString()).toBe(
      "v=5&scene=lake&mirror=0.4",
    );
    // This build's chain only renames keys no build writes now: no setup needs a version yet.
    expect(reread("scene=country&time=0.64&date=0.6")).toBe("scene=country&time=0.64&date=0.6");
  });

  test("the chain is checked: in version order, each alias retiring an id once for a scene", () => {
    expect(() => checkMigrations(MIGRATIONS)).not.toThrow();
    const alias = (from: string, to: string, since = 2): Migration => ({
      kind: "alias",
      since,
      from,
      to,
    });
    for (const broken of [
      [alias("fjord", "lake", 3), alias("tarn", "lake", 2)],
      [alias("fjord", "lake", 1)],
      [alias("pond", "lake")],
      [alias("fjord", "nowhere")],
      [alias("fjord", "lake"), alias("fjord", "pond", 3)],
    ])
      expect(() => checkMigrations(broken)).toThrow(UrlSchemaError);
  });

  test("tones are whole, while a dot size keeps its fraction for the display to round", () => {
    expect(readSetup(q("levels=3.5")).state.levels).toBe(4);
    expect(reread("levels=3.4")).toBe("levels=3");
    expect(reread("pixel=1.5")).toBe("pixel=1.5");
  });
});

describe("the night sky's planets", () => {
  const frost = sceneDefs.frost.planets;
  if (frost === undefined) throw new Error("frost takes no planets");

  test("ride in one key after the knobs, read back as they were written", () => {
    const planets = [
      readPlanet(frost, { kind: 3, size: 0.8, across: 12 }),
      readPlanet(frost, { orbit: 1, "orbit-amount": 6 }),
    ];
    const query = serialise(readState(q("scene=frost")), paramDefaults("frost"), planets);
    expect(query.toString()).toBe(`scene=frost&planets=${encodePlanets(frost, planets)}`);
    expect(readPlanets("frost", query)).toEqual(planets);
    expect(reread(query.toString())).toBe(query.toString());
    // None: no key at all.
    expect(reread("scene=frost&planets=")).toBe("scene=frost");
  });

  test("a link from before the list opens with its giant as the first planet, rewritten", () => {
    const old =
      "scene=frost&time=0&planet=1&planet-amount=0.7&planetX=10&planetY=30&planetPalette=2&planetRing=0&planetMoons=1&planetMoons-amount=3&planetEclipses=0&planetAurora=1&planetAurora-amount=0.5&planetAuroraSize=0.6&planetLights=1&planetLightsTwinkle=0.4&planetDaycycle=1&planetDaycycle-amount=0.45";
    const giant = readPlanet(frost, {
      size: 0.7,
      across: 10,
      up: 30,
      palette: 2,
      ring: 0,
      moons: 1,
      "moons-amount": 3,
      eclipses: 0,
      aurora: 1,
      "aurora-amount": 0.5,
      auroraSize: 0.6,
      lights: 1,
      twinkle: 0.4,
      daycycle: 1,
      "daycycle-amount": 0.45,
    });
    expect(readSetup(q(old)).planets).toEqual([giant]);
    expect(reread(old)).toBe(`scene=frost&time=0&planets=${encodePlanets(frost, [giant])}`);
    // The giant as it started: the first planet at its defaults, where the giant stood.
    expect(readSetup(q("scene=frost&planet=1")).planets).toEqual([planetDefaults(frost)]);
    // Out of range, clamped as the knobs were.
    expect(readSetup(q("scene=frost&planet=1&planetX=999")).planets[0]?.["across"]).toBe(
      frost.across[2],
    );
  });

  test("a giant that was off brings none, and the list wins over the old keys", () => {
    expect(reread("scene=frost&planet=0&planetX=10&planetMoons=1")).toBe("scene=frost");
    expect(reread("scene=frost&planetX=10")).toBe("scene=frost");
    expect(readSetup(q("scene=frost&planet=1&planets=")).planets).toEqual([]);
  });

  test("belong to the scenes that take them: campfire keeps its own giant's keys, mobile its knob", () => {
    expect(reread("scene=campfire&planet=0&planetMoons=1")).toBe(
      "scene=campfire&planet=0&planetMoons=1",
    );
    expect(readSetup(q("scene=campfire&planet=1&planets=AQEA")).planets).toEqual([]);
    expect(reread("scene=pond&planets=AQEA")).toBe("");
    expect(reread("scene=mobile&planets=2")).toBe("scene=mobile&planets=2");
  });
});
