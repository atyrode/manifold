import { describe, expect, test } from "bun:test";
import { folderVariants, interiorVariants } from "../composer/interior-variants.ts";
import { outdoorVariants } from "../composer/outdoor-variants.ts";
import { overheadVariants } from "../composer/overhead-variants.ts";
import { presets, type Preset } from "../presets.ts";
import { sceneDefs, sceneIds } from "../scenes/index.ts";
import { families, sceneFamily } from "./families.ts";
import { presetScene, presetTree, sceneComposer, variantBaseline } from "./tree-model.ts";

const saved = (name: string, query: string): Preset => ({
  name,
  commit: "working-tree",
  query,
  savedAt: "2026-10-19",
});

describe("the presets' tree", () => {
  const tree = presetTree(presets, []);
  const shelf = (id: string) => tree.composers.find((composer) => composer.composer === id);

  test("shelves the interior under its baseline, then its variants in their registry's order", () => {
    const rooms = shelf("interior");
    expect(rooms?.baseline.scene).toBe("room");
    expect(rooms?.variants.map((node): string => node.scene)).toEqual(
      Object.keys(interiorVariants).filter((id) => id !== "room"),
    );
    expect(rooms?.variants.map((node) => node.scene)).toContain("sill");
    expect(Object.keys(folderVariants)).toContain("room");
  });

  test("shelves the outdoor under its baseline, then every outdoor scene as its variant", () => {
    const land = shelf("outdoor");
    expect(land?.baseline.scene).toBe("land");
    const variants = Object.keys(outdoorVariants).filter((id) => id !== "land");
    expect(land?.variants.map((node): string => node.scene)).toEqual(variants);
    expect([...variants].sort()).toEqual(
      sceneIds.filter((id) => id !== "land" && sceneComposer(id) === "outdoor").sort(),
    );
    expect(variantBaseline("meadow")).toBe("land");
    expect(variantBaseline("sill")).toBe("room");
    expect(variantBaseline("land")).toBeUndefined();
  });

  test("shelves the overhead under its baseline, then every scene seen from above as its variant", () => {
    expect(tree.composers.map((composer) => composer.composer)).toEqual([
      "interior",
      "outdoor",
      "overhead",
    ]);
    const patch = shelf("overhead");
    expect(patch?.baseline.scene).toBe("patch");
    const variants = Object.keys(overheadVariants).filter((id) => id !== "patch");
    expect(patch?.variants.map((node): string => node.scene)).toEqual(variants);
    expect([...variants].sort()).toEqual(
      sceneIds.filter((id) => id !== "patch" && sceneComposer(id) === "overhead").sort(),
    );
    for (const { scene } of patch?.variants ?? [])
      expect({ scene, over: variantBaseline(scene) }).toEqual({ scene, over: "patch" });
    expect(variantBaseline("patch")).toBeUndefined();
  });

  test("stands the scenes of no composer on a shelf apart, in their families' order", () => {
    expect(tree.standalone.map((node) => node.scene)).toEqual(
      families.flatMap((family) =>
        sceneIds.filter(
          (id) => sceneFamily[id] === family.id && sceneDefs[id].layers === undefined,
        ),
      ),
    );
    expect(tree.standalone.map((node) => node.scene)).toContain("fractal");
  });

  test("holds every scene once, and every committed preset once, under its scene", () => {
    const nodes = [
      ...tree.composers.flatMap((composer) => [composer.baseline, ...composer.variants]),
      ...tree.standalone,
    ];
    expect(nodes.map((node) => node.scene).sort()).toEqual([...sceneIds].sort());
    const placed = nodes.flatMap((node) =>
      node.presets.map((entry) => ({ scene: node.scene, entry })),
    );
    expect(placed.map(({ entry }) => entry.preset)).toHaveLength(presets.length);
    for (const { scene, entry } of placed) {
      expect(entry.local).toBeUndefined();
      expect(presetScene(entry.preset)).toBe(scene);
    }
  });

  test("lists a scene's committed presets, then the ones saved here, with their local index", () => {
    const mine = saved("Sill · my rain", "scene=sill&rain=1");
    const local = [saved("Pond · mine", "scene=pond&koi=0"), mine, saved("Gone", "scene=nowhere")];
    const sill = presetTree(presets, local).composers[0]?.variants.find(
      (node) => node.scene === "sill",
    );
    const committed = presets.filter((preset) => presetScene(preset) === "sill");
    expect(sill?.presets).toEqual([
      ...committed.map((preset) => ({ preset, local: undefined })),
      { preset: mine, local: 1 },
    ]);
    // A preset of a scene this build lacks is in no scene's branch.
    const branches = presetTree([], local);
    const all = [
      ...branches.composers.flatMap((composer) => [
        ...composer.baseline.presets,
        ...composer.variants.flatMap((node) => node.presets),
      ]),
      ...branches.standalone.flatMap((node) => node.presets),
    ];
    expect(all.map((entry) => entry.local).sort()).toEqual([0, 1]);
  });

  test("reads a preset's scene from its query, the default scene without one", () => {
    expect(presetScene(saved("x", "scene=sill&rain=1"))).toBe("sill");
    expect(presetScene(saved("x", "rain=1"))).toBe("pond");
    expect(presetScene(saved("x", "scene=nowhere"))).toBeUndefined();
  });
});
