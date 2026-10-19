import { describe, expect, test } from "bun:test";
import { folderVariants, interiorVariants } from "../composer/interior-variants.ts";
import { outdoorVariants } from "../composer/outdoor-variants.ts";
import { overheadVariants } from "../composer/overhead-variants.ts";
import { presets, type Preset } from "../presets.ts";
import { sceneDefs, sceneIds } from "../scenes/index.ts";
import { families, sceneFamily } from "./families.ts";
import { presetScene, sceneComposer, sceneTree, variantBaseline } from "./tree-model.ts";

const saved = (name: string, query: string): Preset => ({
  name,
  commit: "working-tree",
  query,
  savedAt: "2026-10-19",
});

describe("the scenes' tree", () => {
  const tree = sceneTree();
  const shelf = (id: string) => tree.composers.find((composer) => composer.composer === id);

  test("shelves the interior under its baseline, then its variants in their registry's order", () => {
    const rooms = shelf("interior");
    expect(rooms?.baseline).toBe("room");
    expect(rooms?.variants.map((scene): string => scene)).toEqual(
      Object.keys(interiorVariants).filter((id) => id !== "room"),
    );
    expect(rooms?.variants).toContain("sill");
    expect(Object.keys(folderVariants)).toContain("room");
  });

  test("shelves the outdoor under its baseline, then every outdoor scene as its variant", () => {
    const land = shelf("outdoor");
    expect(land?.baseline).toBe("land");
    const variants = Object.keys(outdoorVariants).filter((id) => id !== "land");
    expect(land?.variants.map((scene): string => scene)).toEqual(variants);
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
    expect(patch?.baseline).toBe("patch");
    const variants = Object.keys(overheadVariants).filter((id) => id !== "patch");
    expect(patch?.variants.map((scene): string => scene)).toEqual(variants);
    expect([...variants].sort()).toEqual(
      sceneIds.filter((id) => id !== "patch" && sceneComposer(id) === "overhead").sort(),
    );
    for (const scene of patch?.variants ?? [])
      expect({ scene, over: variantBaseline(scene) }).toEqual({ scene, over: "patch" });
    expect(variantBaseline("patch")).toBeUndefined();
  });

  test("stands the scenes of no composer on a shelf apart, in their families' order", () => {
    expect(tree.standalone).toEqual(
      families.flatMap((family) =>
        sceneIds.filter(
          (id) => sceneFamily[id] === family.id && sceneDefs[id].layers === undefined,
        ),
      ),
    );
    expect(tree.standalone).toContain("fractal");
  });

  test("holds every scene once, and every committed preset names one of them", () => {
    const scenes = [
      ...tree.composers.flatMap((composer) => [composer.baseline, ...composer.variants]),
      ...tree.standalone,
    ];
    expect([...scenes].sort()).toEqual([...sceneIds].sort());
    expect(presets.filter((preset) => presetScene(preset) === undefined)).toEqual([]);
  });

  test("reads a preset's scene from its query, the default scene without one", () => {
    expect(presetScene(saved("x", "scene=sill&rain=1"))).toBe("sill");
    expect(presetScene(saved("x", "rain=1"))).toBe("pond");
    expect(presetScene(saved("x", "scene=nowhere"))).toBeUndefined();
  });
});
