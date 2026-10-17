import { describe, expect, test } from "bun:test";
import { sceneDefs } from "./scenes/index.ts";
import { encodePlanets, readPlanet } from "./scenes/planets.ts";
import { defaults, paramDefaults, readPlanets, readSetup, readState, serialise } from "./state.ts";

/** A setup query as the page reads it back and writes it again: its scene's knobs and planets, minimal. */
function reread(query: string): string {
  const { state, params, planets } = readSetup(new URLSearchParams(query));
  return serialise(state, params, planets).toString();
}

const q = (query: string) => new URLSearchParams(query);

describe("a link", () => {
  test("is read in this build's keys: any other key is ignored and never written back", () => {
    expect(reread("v=3&scene=forest&rain=1&nonsense=2")).toBe("scene=forest&rain=1");
    // The countryside has no season: its date stays at the default.
    expect(reread("scene=country&season=2")).toBe("scene=country");
    expect(readSetup(q("scene=country&season=2")).params).toEqual(paramDefaults("country"));
  });

  test("naming an unknown scene opens the default scene with its lab settings, and is reported", () => {
    const read = readSetup(q("scene=nowhere&motion=0.2"));
    expect(read.unknownScene).toBe("nowhere");
    expect(read.state.scene).toBe(defaults.scene);
    expect(read.state.motion).toBe(0.2);
    expect(read.params).toEqual(paramDefaults(defaults.scene));
    for (const known of ["scene=lake", "", "scene=", `scene=${defaults.scene}`])
      expect(readSetup(q(known)).unknownScene).toBeUndefined();
  });

  test("holds whole tones, while a dot size keeps its fraction for the display to round", () => {
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

  test("belong to the scenes that take them: elsewhere the key is ignored, or a knob of that name", () => {
    expect(readSetup(q("scene=campfire&planets=AQEA")).planets).toEqual([]);
    expect(reread("scene=pond&planets=AQEA")).toBe("");
    expect(reread("scene=mobile&planets=2")).toBe("scene=mobile&planets=2");
  });
});
