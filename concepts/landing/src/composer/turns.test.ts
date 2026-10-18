import { describe, expect, test } from "bun:test";
import { loadScene, sceneIds } from "../scenes/index.ts";
import {
  featureKey,
  fragmentSourceFor,
  sceneFeatures,
  sceneFeaturesAll,
  shaderValues,
} from "../shaders/index.ts";
import { HeadlessGl } from "../sims/headless.ts";
import { TURNS_GATE } from "./compose.ts";

// The composed programs' two kinds (composer/glsl.ts): a steady one plays no layer's own entrance
// or exit, so it carries none of the cut per cell and no plain floor under a ground layer, but
// reads row 0's first texel all the same (`heldTurn`); the one a turn plays in (TURNS_GATE, as
// every all-features program) carries both. A room (composer/room.ts) lays no plain floor in either:
// its back wall stands under every layer. The overhead composer's (overhead-glsl.ts) are the same
// but for the plain bed in place of the floor, under a bed layer, and no `heldTurn`. A view of the
// scene's own (the dunes' and the garden's from above) draws no turns, so its composed sim names no
// program to play one in.

const composed = (
  await Promise.all(sceneIds.map(async (id) => ({ id, scene: await loadScene(id) })))
).filter(({ scene }) => scene.layers !== undefined);

describe("a composed scene's programs", () => {
  test("are steady at its defaults and draw turns in its all-features set", () => {
    for (const { id, scene } of composed) {
      expect({ id, steady: sceneFeatures(scene)[TURNS_GATE] }).toEqual({ id, steady: 0 });
      expect({ id, all: sceneFeaturesAll(scene)?.[TURNS_GATE] }).toEqual({ id, all: 1 });
    }
  });

  test("cut a layer per cell and lay the plain floor under the ground layer only in one that draws turns", () => {
    for (const { id, scene } of composed) {
      const features = sceneFeatures(scene);
      const steady = fragmentSourceFor(scene, features);
      const turning = fragmentSourceFor(scene, { ...features, [TURNS_GATE]: 1 });
      const placed = scene.layers?.place(shaderValues(scene)).layers ?? [];
      const overhead = placed.some(({ layer }) => layer.composers.includes("overhead"));
      const [role, pass, plain] = overhead
        ? (["bed", "bed", "overheadPlainBed"] as const)
        : (["ground", "ground", "composerFloor"] as const);
      const ground = placed.findIndex(
        ({ layer }) => layer.role === role && layer.passes[pass] !== undefined,
      );
      const room = steady.includes("Ctx roomCtx(");
      expect({
        id,
        steady: {
          cut: steady.includes("bool shows["),
          turn: steady.includes("layerTurn("),
          floor: steady.includes(`  ${plain}(x, c);\n`),
          held: steady.includes("float heldTurn = ") && steady.includes("if (heldTurn < -1.5)"),
        },
        turning: {
          cut: turning.includes("bool shows["),
          turn: turning.includes("layerTurn("),
          floor: turning.includes(
            ground < 0 ? `  ${plain}(x, c);\n` : `  if (!shows[${ground}]) ${plain}(x, c);\n`,
          ),
          held: turning.includes("heldTurn"),
        },
      }).toEqual({
        id,
        steady: { cut: false, turn: false, floor: !room && ground < 0, held: !overhead },
        turning: { cut: true, turn: true, floor: !room, held: false },
      });
    }
  });

  test("name no program to play a turn in from a view of the scene's own", async () => {
    for (const [id, knob, gate] of [
      ["dunes", "camera", "DUNES_OVERHEAD"],
      ["garden", "gravelCamera", "GARDEN_OVERHEAD"],
    ] as const) {
      const scene = await loadScene(id);
      const sim = scene.sim?.(new HeadlessGl().gl);
      for (const above of [0, 1]) {
        const features = sceneFeatures(scene, shaderValues(scene, { [knob]: above }));
        const drawn = featureKey(features);
        const through = sim?.leavesThrough?.(drawn);
        // Every layer flipped: on in the setting where it is off, off where it is on.
        const turns = Object.keys(features)
          .filter((name) => name.startsWith("LAYER_"))
          .map((name) => sim?.turning?.(drawn, { ...features, [name]: 1 - (features[name] ?? 0) }));
        expect({ id, above, view: features[gate], through: through?.[TURNS_GATE] }).toEqual({
          id,
          above,
          view: above,
          through: above === 1 ? undefined : 1,
        });
        if (above === 1) expect(turns.every((turn) => turn === undefined)).toBe(true);
      }
      sim?.dispose();
    }
  });
});
