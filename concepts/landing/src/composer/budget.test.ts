import { describe, expect, test } from "bun:test";
import { readKnobs } from "../params.ts";
import { presets } from "../presets.ts";
import { loadScene, sceneIds } from "../scenes/index.ts";
import {
  fragmentSourceFor,
  sceneFeatures,
  sceneFeaturesAll,
  shaderValues,
} from "../shaders/index.ts";
import { COMPOSER_CAPS } from "./caps.ts";

// The composer's program budgets (README "Programs and cost"): every composed scene's shaken program
// at its preset's defaults, the all-features program of each layer set a turn of one layer or a
// committed preset reaches, and the pilot mix's. Uniform vectors are scripts/glsl-check.ts's.

/** The pilot mix (ADR 0062 Phase 1): the bees' garden with the meadow's grass and wildflowers. */
const PILOT_MIX = "Bees · overgrown meadow";

const composed = (
  await Promise.all(sceneIds.map(async (id) => ({ id, scene: await loadScene(id) })))
).filter(({ scene }) => scene.layers !== undefined);

describe("composed programs", () => {
  test("are the ported presets", () => {
    expect(composed.map(({ id }) => id).sort()).toEqual([
      "autumn",
      "bamboo",
      "bees",
      "bonsai",
      "campfire",
      "country",
      "dew",
      "dunes",
      "falls",
      "fireflies",
      "flock",
      "forest",
      "garden",
      "island",
      "lake",
      "lanterns",
      "lava",
      "meadow",
      "pond",
      "ripple",
      "shore",
      "sill",
      "skyward",
      "street",
      "swell",
      "tidepool",
    ]);
  });

  test("stay within the shaken budgets: a preset's defaults, each layer set's all-features", () => {
    for (const { id, scene } of composed) {
      const layers = scene.layers;
      if (layers === undefined) continue;
      const shaken = fragmentSourceFor(scene, sceneFeatures(scene)).length;
      expect({ id, shaken, within: shaken <= COMPOSER_CAPS.shakenDefault }).toEqual({
        id,
        shaken,
        within: true,
      });
      // Each layer turned on (off, for a home layer) beside the preset's own.
      const sets = [
        shaderValues(scene),
        ...layers.offered.map((layer) =>
          shaderValues(scene, { [layer.id]: layers.home.includes(layer.id) ? 0 : 1 }),
        ),
      ];
      for (const values of sets) {
        const all = sceneFeaturesAll(scene, values);
        if (all === undefined) continue;
        const size = fragmentSourceFor(scene, all).length;
        expect({ id, size, within: size <= COMPOSER_CAPS.shakenAll }).toEqual({
          id,
          size,
          within: true,
        });
      }
    }
  });

  test("hold every committed preset of a composed scene, the pilot mix within its own", () => {
    const mix = presets.find((preset) => preset.name === PILOT_MIX);
    expect(mix).toBeDefined();
    for (const preset of presets) {
      const query = new URLSearchParams(preset.query);
      const found = composed.find(({ id }) => id === query.get("scene"));
      if (found === undefined) continue;
      const { scene } = found;
      const values = shaderValues(
        scene,
        readKnobs(scene.params, (key) => query.get(key)),
      );
      const all = sceneFeaturesAll(scene, values);
      const size = all === undefined ? 0 : fragmentSourceFor(scene, all).length;
      const cap = preset === mix ? COMPOSER_CAPS.shakenPilotMix : COMPOSER_CAPS.shakenAll;
      expect({ preset: preset.name, size, within: size <= cap }).toEqual({
        preset: preset.name,
        size,
        within: true,
      });
    }
  });

  test("keep their knobs and trigger slots within the renderer's", () => {
    for (const { id, scene } of composed) {
      const triggers = new Set(
        scene.params.flatMap((def) => (def.trigger === undefined ? [] : [def.trigger])),
      );
      expect({ id, params: scene.params.length <= COMPOSER_CAPS.params }).toEqual({
        id,
        params: true,
      });
      expect({ id, triggers: Math.max(...triggers) < COMPOSER_CAPS.triggers }).toEqual({
        id,
        triggers: true,
      });
    }
  });
});
