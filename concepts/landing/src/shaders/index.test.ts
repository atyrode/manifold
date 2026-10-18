import { describe, expect, test } from "bun:test";
import { turned } from "../knob-turns.ts";
import { effective, type ParamDef } from "../params.ts";
import { loadScenes } from "../scenes/index.ts";
import { openingPlanets, planetUniforms, readPlanet } from "../scenes/planets.ts";
import {
  assembleFragment,
  featureKey,
  fragmentSourceFor,
  LIBRARY_GATES,
  packParams,
  PLANETS_GATE,
  sceneFeatures,
  sceneFeaturesAll,
  SEVERAL_PLANETS_GATE,
  settingKeyed,
  shaderValues,
} from "./index.ts";
import { PLANET_BODY_KINDS, PLANET_DRESS_GATES, PLANET_KIND_GATES } from "./lib/planet.ts";

const scenes = await loadScenes();

/** Every planet gate: the sky's two, then each kind's, then each piece of dress's. */
const PLANET_GATES = [
  PLANETS_GATE,
  SEVERAL_PLANETS_GATE,
  ...PLANET_KIND_GATES,
  ...Object.values(PLANET_DRESS_GATES),
];

/** Each scene's library gates: the knob that opens each, by gate. */
function gatesOf(params: readonly ParamDef[]): Record<string, string> {
  return Object.fromEntries(
    params.flatMap((def) => {
      const gate = def.widget?.kind === "night" ? LIBRARY_GATES[def.widget.part] : undefined;
      return gate === undefined ? [] : [[gate, def.key]];
    }),
  );
}

describe("library gates", () => {
  test("compile the planets in only while a scene that takes them holds any, and only their kinds, palettes and dress", () => {
    const [banded = "", , rocky = "", , , , , eye = ""] = PLANET_KIND_GATES;
    let takers = 0;
    for (const scene of scenes) {
      const spec = scene.planets;
      if (spec === undefined) {
        const features = sceneFeatures(scene, undefined, planetUniforms([{ kind: 3, ring: 2 }]));
        for (const gate of PLANET_GATES) expect(features[gate]).toBeUndefined();
        continue;
      }
      takers++;
      expect({ id: scene.id, keyed: settingKeyed(scene) }).toEqual({ id: scene.id, keyed: true });
      /** The planet gates a list opens, and their values. */
      const open = (planets: readonly Record<string, number>[]) => {
        const features = sceneFeatures(scene, undefined, planetUniforms(planets));
        return Object.fromEntries(
          PLANET_GATES.flatMap((gate) =>
            (features[gate] ?? 0) > 0 ? [[gate, features[gate]]] : [],
          ),
        );
      };
      const one = (fields: Record<string, number>) => open([readPlanet(spec, fields)]);
      // As it opens, the gates of the planets it opens with; every gate defined whatever the list.
      expect(sceneFeatures(scene)).toEqual(
        sceneFeatures(scene, undefined, planetUniforms(openingPlanets(spec))),
      );
      for (const gate of PLANET_GATES)
        expect(sceneFeatures(scene, undefined, planetUniforms([]))[gate]).toBe(0);
      expect(open([])).toEqual({});
      // A planet opens its kind's gate with its palette's bit (its default ring the thin one, no
      // gate of its own).
      PLANET_KIND_GATES.forEach((gate, kind) =>
        expect(one({ kind })).toEqual({ [PLANETS_GATE]: 1, [gate]: 1 }),
      );
      expect(one({ kind: 7, palette: 2 })).toEqual({ [PLANETS_GATE]: 1, [eye]: 4 });
      // Each piece of dress opens its own; eclipses without moons draw nothing and open none.
      const plain = { [PLANETS_GATE]: 1, [banded]: 1 };
      const { wideRing, moons, aurora, lights } = PLANET_DRESS_GATES;
      expect(one({ ring: 2 })).toEqual({ ...plain, [wideRing]: 1 });
      expect(one({ moons: 1 })).toEqual({ ...plain, [moons]: 1 });
      expect(one({ moons: 0, eclipses: 1 })).toEqual(plain);
      expect(one({ aurora: 1 })).toEqual({ ...plain, [aurora]: 1 });
      expect(one({ lights: 1 })).toEqual({ ...plain, [lights]: 1 });
      // Several planets open the several gate and each of their kinds' palettes.
      expect(
        open([
          readPlanet(spec, { kind: 2, palette: 1 }),
          readPlanet(spec, { kind: 7, palette: 3 }),
          readPlanet(spec, { kind: 2, palette: 3 }),
        ]),
      ).toEqual({ [PLANETS_GATE]: 1, [SEVERAL_PLANETS_GATE]: 1, [rocky]: 10, [eye]: 8 });
      const all = sceneFeaturesAll(scene) ?? {};
      for (const gate of PLANET_GATES)
        expect({ gate, all: all[gate] }).toEqual({
          gate,
          all: PLANET_KIND_GATES.includes(gate) ? 15 : 1,
        });
      // Its knob gates and own features stay as they are whatever the list holds.
      const others = (planets: readonly Record<string, number>[]) =>
        Object.entries(sceneFeatures(scene, undefined, planetUniforms(planets))).filter(
          ([gate]) => !PLANET_GATES.includes(gate),
        );
      const eight = Array.from({ length: 8 }, (_, kind) =>
        readPlanet(spec, { kind, ring: 2, moons: 1, aurora: 1, lights: 1 }),
      );
      expect(others(eight)).toEqual(others([]));
    }
    expect(takers).toBeGreaterThan(0);
  });

  test("leave out of a program every kind, palette and piece of dress its planets lack, and a lone planet's loop", () => {
    const campfire = scenes.find((scene) => scene.id === "campfire");
    const spec = campfire?.planets;
    if (campfire === undefined || spec === undefined) throw new Error("campfire takes no planets");
    /** Each kind's surface, by kind: planet<Id> (planetBanded, planetBelted, ...). */
    const faces = PLANET_BODY_KINDS.map(
      (kind) => `planet${kind.id[0]?.toUpperCase() ?? ""}${kind.id.slice(1)}(`,
    );
    const dress = [
      "planetRingBands(",
      "planetMoonDisc(",
      "planetAuroraCurtain(",
      "planetCityLights(",
    ];
    const program = (planets: readonly Record<string, number>[]) =>
      fragmentSourceFor(campfire, sceneFeatures(campfire, undefined, planetUniforms(planets)));
    /** How many palettes a program's planetBodyColours holds. */
    const palettes = (source: string) => source.split("look.deep = ").length - 1;
    faces.forEach((face, kind) => {
      const source = program([readPlanet(spec, { kind, palette: 1, ring: 1 })]);
      expect({
        kind,
        faces: faces.filter((each) => source.includes(each)),
        dress: dress.filter((call) => source.includes(call)),
        palettes: palettes(source),
        loop: source.includes("uPlanetCount"),
      }).toEqual({ kind, faces: [face], dress: [], palettes: 1, loop: false });
    });
    const all = program([readPlanet(spec, { ring: 2, moons: 1, aurora: 1, lights: 1 })]);
    expect(dress.filter((call) => all.includes(call))).toEqual(dress);
    const two = program([readPlanet(spec, { palette: 0 }), readPlanet(spec, { palette: 3 })]);
    expect({ palettes: palettes(two), loop: two.includes("uPlanetCount") }).toEqual({
      palettes: 2,
      loop: true,
    });
  });

  test("make every scene holding one knob-keyed, off at its defaults, on in its all-features set", () => {
    let gated = 0;
    for (const scene of scenes) {
      const gates = gatesOf(scene.params);
      const keyed = Object.keys(gates).length > 0;
      if (!keyed) {
        // A scene without them keeps its feature sets as they were, and no gate.
        expect({ id: scene.id, keyed: settingKeyed(scene) }).toEqual({
          id: scene.id,
          keyed: scene.featuresFor !== undefined || scene.planets !== undefined,
        });
        for (const gate of Object.values(LIBRARY_GATES))
          expect(sceneFeatures(scene)[gate]).toBeUndefined();
        continue;
      }
      gated++;
      expect({ id: scene.id, keyed: settingKeyed(scene) }).toEqual({ id: scene.id, keyed: true });
      const plain = sceneFeatures(scene);
      const all = sceneFeaturesAll(scene) ?? {};
      for (const [gate, key] of Object.entries(gates)) {
        // Off at the defaults (the knob reads 0 and the default picture compiles none of it), on
        // once its knob is.
        const def = scene.params.find((knob) => knob.key === key);
        expect({
          id: scene.id,
          gate,
          value: def === undefined ? undefined : effective(def, {}),
          plain: plain[gate],
          all: all[gate],
        }).toEqual({ id: scene.id, gate, value: 0, plain: 0, all: 1 });
        const on = sceneFeatures(scene, shaderValues(scene, { [key]: 1 }));
        expect({ id: scene.id, gate, on: on[gate] }).toEqual({ id: scene.id, gate, on: 1 });
      }
      // The defines reach the program ahead of the libraries that test them.
      const source = assembleFragment(scene, all);
      for (const gate of Object.keys(gates))
        expect(source.indexOf(`#define ${gate} 1\n`)).toBeLessThan(
          source.indexOf("// ---- sky ----"),
        );
    }
    expect(gated).toBeGreaterThan(15);
  });

  test("leave each knob-keyed scene's all-features set covering every knob's turn", () => {
    // The same defines, each at least as high (a gate on, a tier at or above): the program the
    // renderer switches to for any change draws it, so the GPU checks need only sample the scenes.
    // A composed scene's layer switch (`structural`) is another layer set, so another program: the
    // turned set's own all-features set covers it. Any other knob keeps the defaults' layer set.
    for (const scene of scenes) {
      const most = sceneFeaturesAll(scene);
      if (most === undefined) continue;
      for (const knob of scene.params) {
        const values = shaderValues(scene, turned(knob));
        const set = sceneFeatures(scene, values);
        const structural = scene.structural?.includes(knob.key) === true;
        const cover = sceneFeaturesAll(scene, values) ?? {};
        if (!structural)
          expect({ id: scene.id, knob: knob.key, same: featureKey(cover) }).toEqual({
            id: scene.id,
            knob: knob.key,
            same: featureKey(most),
          });
        for (const [name, value] of Object.entries(set))
          expect({
            id: scene.id,
            knob: knob.key,
            name,
            covered: (cover[name] ?? -Infinity) >= value,
          }).toEqual({ id: scene.id, knob: knob.key, name, covered: true });
      }
    }
  });
});

describe("knob uniforms", () => {
  test("read each knob from the component of uParams that packParams fills with it", () => {
    for (const scene of scenes) {
      const source = assembleFragment(scene);
      const packed = packParams(scene.params.map((_, index) => index + 1));
      scene.params.forEach((def, index) => {
        const define = new RegExp(`#define K_${def.key} uParams\\[(\\d+)\\]\\.([xyzw])\\n`).exec(
          source,
        );
        const slot = define === null ? -1 : Number(define[1]) * 4 + "xyzw".indexOf(define[2] ?? "");
        expect({ id: scene.id, key: def.key, value: packed[slot] }).toEqual({
          id: scene.id,
          key: def.key,
          value: index + 1,
        });
      });
    }
  });
});
