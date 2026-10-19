import { describe, expect, test } from "bun:test";
import { toggle } from "../params.ts";
import { beesComposed, beesScene } from "../scenes/bees/index.ts";
import { meadowComposed, meadowScene } from "../scenes/meadow/index.ts";
import { featureKey, sceneFeatures, shaderValues } from "../shaders/index.ts";
import { COMPOSER_CAPS } from "./caps.ts";
import { layerGate } from "./compose.ts";
import { FALL_CODES } from "./falling.ts";
import { allocate, ATLAS_SLOT, ComposerSimError, layersOfKey, SPECK_SLOT } from "./sim.ts";
import type { LayerData, LayerDef } from "./types.ts";

/** A layer asking for `data` of the composed sim. */
function layer(id: string, data?: LayerData): LayerDef {
  return {
    id,
    title: id,
    composers: ["outdoor"],
    role: "cover",
    bands: ["middle"],
    space: { anchors: [], claims: [] },
    camera: {},
    switch: toggle("layers", id, id, false, id),
    params: [],
    groups: {},
    passes: {},
    ...(data === undefined ? {} : { data }),
  };
}

describe("the composed sim's allocation", () => {
  test("gives rows from row 1, speck codes from 0 and fields from slot 2, in the layers' order", () => {
    const layers = [
      layer("sky"),
      layer("grass", { rows: 1, fields: 1 }),
      layer("flowers", { rows: 5 }),
      layer("bees", { rows: 2, specks: 30, fields: 2 }),
      layer("moths", { specks: 4 }),
    ];
    expect(allocate(layers)).toEqual({
      layers: ["sky", "grass", "flowers", "bees", "moths"],
      rows: {
        grass: { base: 1, count: 1 },
        flowers: { base: 2, count: 5 },
        bees: { base: 7, count: 2 },
      },
      atlasRows: 9,
      specks: { bees: 0, moths: 30 },
      fields: { grass: [2], bees: [3, 4] },
      falling: undefined,
      slots: 5,
    });
    expect([SPECK_SLOT, ATLAS_SLOT]).toEqual([0, 1]);
  });

  test("is a function of the layers on screen alone: one fewer moves the later ones up", () => {
    const grass = layer("grass", { rows: 1, fields: 1 });
    const flowers = layer("flowers", { rows: 5 });
    const clocks = layer("clocks", { rows: 8 });
    expect(allocate([grass, flowers, clocks])).toEqual(allocate([grass, flowers, clocks]));
    const without = allocate([grass, clocks]);
    expect(without.rows).toEqual({ grass: { base: 1, count: 1 }, clocks: { base: 2, count: 8 } });
    expect(without.atlasRows).toBe(10);
    expect(allocate([]).slots).toBe(2);
    expect(allocate([]).atlasRows).toBe(1);
  });

  test("throws past the field slots and past the codes one byte holds", () => {
    const fields = Array.from({ length: COMPOSER_CAPS.fields + 1 }, (_, i) =>
      layer(`field${i}`, { fields: 1 }),
    );
    expect(() => allocate(fields.slice(0, COMPOSER_CAPS.fields))).not.toThrow();
    expect(() => allocate(fields)).toThrow(ComposerSimError);
    expect(() => allocate([layer("a", { specks: 200 }), layer("b", { specks: 56 })])).toThrow(
      ComposerSimError,
    );
    expect(() => allocate([layer("a", { specks: 200 }), layer("b", { specks: 55 })])).not.toThrow();
  });

  test("gives the falling things their codes after every layer's, once, while a layer lets things fall", () => {
    const ferns: LayerDef = { ...layer("ferns", { rows: 1 }), falling: { kinds: ["drop"] } };
    const eaves: LayerDef = { ...layer("eaves"), falling: { kinds: ["drop"] } };
    const bees = layer("bees", { specks: 30 });
    const alloc = allocate([ferns, bees, eaves]);
    expect(alloc.specks).toEqual({ bees: 0 });
    expect(alloc.falling).toEqual({ base: 30, count: FALL_CODES.drop, kinds: ["drop"] });
    expect(alloc.slots).toBe(2);
    expect(allocate([bees]).falling).toBeUndefined();
    expect(() => allocate([layer("a", { specks: 255 - FALL_CODES.drop + 1 }), eaves])).toThrow(
      ComposerSimError,
    );
    expect(() => allocate([layer("a", { specks: 255 - FALL_CODES.drop }), eaves])).not.toThrow();
  });

  test("reads the layer set off a program's feature key", () => {
    const gates = { LAYER_GRASS: "grass", LAYER_WILDFLOWERS: "wildflowers", LAYER_DOWNS: "downs" };
    expect(
      layersOfKey("LAYER_DOWNS=1 LAYER_GRASS=0 LAYER_WILDFLOWERS=1 WORLD_RAIN=1", gates),
    ).toEqual(new Set(["downs", "wildflowers"]));
    expect(layerGate("wildflowers")).toBe("LAYER_WILDFLOWERS");
    expect(layerGate("fairyLights")).toBe("LAYER_FAIRY_LIGHTS");
    // A preset's own program names its home layers.
    for (const [scene, composed] of [
      [meadowScene, meadowComposed],
      [beesScene, beesComposed],
    ] as const) {
      const key = featureKey(sceneFeatures(scene, shaderValues(scene)));
      expect(layersOfKey(key, composed.gates)).toEqual(new Set(composed.preset.layers));
    }
  });

  test("fits every pilot preset and the mix within the sim textures", () => {
    for (const on of [
      meadowComposed.place(new Set([...meadowComposed.preset.layers, "wildflowers"])),
      beesComposed.place(new Set([...beesComposed.preset.layers, "grass", "wildflowers"])),
    ]) {
      const allocation = allocate(on.layers.map((placed) => placed.layer));
      expect(allocation.slots).toBeLessThanOrEqual(COMPOSER_CAPS.simTextures);
    }
  });
});
