import { describe, expect, test } from "bun:test";
import { loadScene, sceneIds } from "../scenes/index.ts";
import type { LoadedScene } from "../scenes/types.ts";
import {
  assembleFragment,
  sceneFeatures,
  sceneFeaturesAll,
  shaderValues,
} from "../shaders/index.ts";
import { COMPOSER_CAPS } from "./caps.ts";
import { checkKnobCaps, ComposeError, layerGate } from "./compose.ts";
import { interior } from "./interior.ts";
import { outdoor } from "./outdoor.ts";
import { overhead } from "./overhead.ts";

// The per-program knob layout (ADR 0062 "Budgets and caps"): a preset lists up to 512 knobs, and
// each of its programs defines `K_<key>` for the composer's knobs, its on layers' and any other its
// code names, at most 128 of them.

const composed = (
  await Promise.all(sceneIds.map(async (id) => ({ id, scene: await loadScene(id) })))
).filter(({ scene }) => scene.layers !== undefined);

/** `count` layers of `knobs` knobs each (a switch and its own), keyed `l0`, `l1`, …. */
const layersOf = (count: number, knobs: number): Record<string, number> =>
  Object.fromEntries(Array.from({ length: count }, (_, i) => [`l${i}`, knobs]));

describe("the knob caps", () => {
  test("a preset lists at most 512 knobs", () => {
    expect(COMPOSER_CAPS.params).toBe(512);
    expect(() => checkKnobCaps("p", 512, 0, {})).not.toThrow();
    expect(() => checkKnobCaps("p", 513, 0, {})).toThrow(ComposeError);
    expect(() => checkKnobCaps("p", 513, 0, {})).toThrow("preset p: 513 knobs, at most 512");
  });

  test("a program reads at most 128: the composer's and its largest layers', as many as stack", () => {
    expect(COMPOSER_CAPS.programParams).toBe(128);
    expect(COMPOSER_CAPS.layers).toBe(8);
    // 16 of the composer's and eight layers of 14: 128, however many more of them are offered.
    expect(() => checkKnobCaps("p", 300, 16, layersOf(20, 14))).not.toThrow();
    // A ninth layer stacks with none of them at once: it adds nothing to the largest program.
    expect(() => checkKnobCaps("p", 300, 16, { ...layersOf(8, 14), small: 1 })).not.toThrow();
    // One layer a knob larger, or one more of the composer's: 129.
    expect(() => checkKnobCaps("p", 300, 16, { ...layersOf(8, 14), l0: 15 })).toThrow(
      "preset p: a program holding its layers l0, l1, l2, l3, l4, l5, l6, l7 reads 129 knobs (the composer's 16 and theirs), at most 128",
    );
    expect(() => checkKnobCaps("p", 300, 17, layersOf(8, 14))).toThrow(ComposeError);
  });
});

/**
 * Each knob's layer by key, undefined for the composer's own: a composed scene lists the World's and
 * the composer's knobs, then every offered layer's switch, then each offered layer's own knobs in
 * canonical order, as many as its LayerDef declares in its composer (compose.ts).
 */
function holders(scene: LoadedScene): Map<string, string | undefined> {
  const offered = scene.layers?.offered.map((layer) => layer.id) ?? [];
  const composer = [outdoor, interior, overhead].find((candidate) =>
    offered.every((id) => candidate.layers.some((layer) => layer.id === id)),
  );
  const first = scene.params.findIndex((def) => offered.includes(def.key));
  const owners: (string | undefined)[] = [
    ...scene.params.slice(0, first).map(() => undefined),
    ...offered,
    ...offered.flatMap((id) =>
      (composer?.layers.find((layer) => layer.id === id)?.params ?? []).map(() => id),
    ),
  ];
  expect({ id: scene.id, listed: owners.length }).toEqual({
    id: scene.id,
    listed: scene.params.length,
  });
  return new Map(scene.params.map((def, index) => [def.key, owners[index]]));
}

describe("a composed program's knobs", () => {
  test("define K_<key> for the composer's knobs, its on layers' and the others its code names", () => {
    for (const { id, scene } of composed) {
      const layers = scene.layers;
      if (layers === undefined) continue;
      const offered = new Set(layers.offered.map((layer) => layer.id));
      const owners = holders(scene);
      // The preset's defaults, and each layer turned on (off, for a home layer) beside its own.
      const sets = [
        sceneFeatures(scene),
        ...layers.offered.flatMap((layer) => {
          const values = shaderValues(scene, {
            [layer.id]: layers.home.includes(layer.id) ? 0 : 1,
          });
          const all = sceneFeaturesAll(scene, values);
          return [sceneFeatures(scene, values), ...(all === undefined ? [] : [all])];
        }),
      ];
      for (const features of sets) {
        const on = [...offered].filter((layer) => features[layerGate(layer)] === 1);
        const source = assembleFragment(scene, features);
        const defined = [...source.matchAll(/^#define K_(\w+) /gm)].map(([, key]) => key);
        // The knobs the program's code names, its defines aside: an off layer's in a chunk shared
        // with an on one, a season or year cycle in SKY_YEAR, an opt-in knob a library tests.
        const named = new Set(
          [...source.replace(/^#define K_\w+ .*$/gm, "").matchAll(/\bK_(\w+)/g)].map(
            ([, key]) => key,
          ),
        );
        const expected = scene.params
          .map((def) => def.key)
          .filter((key) => {
            const layer = owners.get(key);
            return layer === undefined || on.includes(layer) || named.has(key);
          });
        expect({ id, on, defined }).toEqual({ id, on, defined: expected });
      }
    }
  });
});
