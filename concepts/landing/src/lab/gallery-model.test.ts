import { describe, expect, test } from "bun:test";
import { interiorVariants } from "../composer/interior-variants.ts";
import { outdoorVariants } from "../composer/outdoor-variants.ts";
import { overheadVariants } from "../composer/overhead-variants.ts";
import type { Preset } from "../presets.ts";
import { sceneDefs, sceneIds } from "../scenes/index.ts";
import {
  cardMatches,
  docMatches,
  galleryShelves,
  labOnly,
  sceneCycle,
  sceneOrder,
  scenePresets,
  sceneStep,
  type GalleryCard,
} from "./gallery-model.ts";

const committed = (name: string, query: string): Preset => ({
  name,
  commit: "abc12345",
  query,
  savedAt: "2026-10-19",
});

const scenesOf = (cards: readonly GalleryCard[]) => cards.map((card) => card.scene);

describe("the Scenes view's shelves", () => {
  const shelves = galleryShelves;

  test("are the room's, the land's and the patch's, then the standalone scenes", () => {
    expect(shelves.map((shelf) => shelf.baseline)).toEqual(["room", "land", "patch", undefined]);
    expect(shelves.map((shelf) => shelf.composer)).toEqual([
      "interior",
      "outdoor",
      "overhead",
      undefined,
    ]);
  });

  test("put the baseline first, tagged, then its variants in their registry's order", () => {
    const registries = [interiorVariants, outdoorVariants, overheadVariants];
    for (const [at, registry] of registries.entries()) {
      const shelf = shelves[at];
      if (shelf?.baseline === undefined) throw new Error("a baseline's shelf without its baseline");
      expect(shelf.cards[0]).toEqual({ scene: shelf.baseline, baseline: true });
      expect<string[]>(scenesOf(shelf.cards)).toEqual(Object.keys(registry));
      expect(shelf.cards.slice(1).every((card) => !card.baseline)).toBe(true);
    }
  });

  test("hold every scene in exactly one shelf, the standalone ones a program of their own", () => {
    const placed = shelves.flatMap((shelf) => scenesOf(shelf.cards));
    expect([...placed].sort()).toEqual([...sceneIds].sort());
    expect(new Set(placed).size).toBe(placed.length);
    const standalone = scenesOf(shelves.at(-1)?.cards ?? []);
    expect(standalone).toContain("fractal");
    expect(standalone.every((scene) => sceneDefs[scene].layers === undefined)).toBe(true);
  });

  test("match a search by a scene's title or one of its committed presets' names", () => {
    const sill = shelves[0]?.cards.find((card) => card.scene === "sill");
    if (sill === undefined) throw new Error("no sill");
    expect(cardMatches(sill, "")).toBe(true);
    expect(cardMatches(sill, ` ${sceneDefs.sill.title.toUpperCase()} `)).toBe(true);
    const [preset] = scenePresets("sill");
    if (preset === undefined) throw new Error("the sill has no committed preset");
    expect(cardMatches(sill, preset.name.slice(-8))).toBe(true);
    expect(cardMatches(sill, "nothing like it")).toBe(false);
    // Not by a blurb.
    expect(cardMatches(sill, sceneDefs.sill.blurb)).toBe(false);
  });

  test("give each scene its committed presets, and none of a scene this build lacks", () => {
    const list = [
      committed("Sill · rain", "scene=sill&rain=1"),
      committed("Gone", "scene=nowhere"),
      committed("Sill · cat", "scene=sill&cat=0"),
      committed("Land · dusk", "scene=land&time=0.8"),
    ];
    expect(scenePresets("sill", list).map((preset) => preset.name)).toEqual([
      "Sill · rain",
      "Sill · cat",
    ]);
    expect(scenePresets("pond", list)).toEqual([]);
  });
});

test("the Scenes view's order is its shelves' scenes in order", () => {
  expect(sceneOrder).toEqual(galleryShelves.flatMap((shelf) => scenesOf(shelf.cards)));
});

test("the cycle is the Scenes view's order less the lab-only scenes, the baselines", () => {
  expect(labOnly).toEqual({ room: true, land: true, patch: true, canvas: true });
  expect(sceneCycle).toEqual(sceneOrder.filter((id) => labOnly[id] !== true));
});

test("[ and ] walk the cycle, round from the last scene to the first", () => {
  const first = sceneCycle[0];
  const last = sceneCycle.at(-1);
  if (first === undefined || last === undefined) throw new Error("no scenes");
  expect(sceneStep(last, 1)).toBe(first);
  expect(sceneStep(first, -1)).toBe(last);
  // Along a shelf, and off its end onto the next shelf's first scene but its baseline.
  const shelves = galleryShelves.map((shelf) =>
    scenesOf(shelf.cards).filter((id) => labOnly[id] !== true),
  );
  for (const [at, shelf] of shelves.slice(0, -1).entries()) {
    const [one, two] = shelf;
    if (one !== undefined && two !== undefined) expect(sceneStep(one, 1)).toBe(two);
    const end = shelf.at(-1);
    if (end !== undefined) expect(sceneStep(end, 1)).toBe(shelves[at + 1]?.[0] ?? end);
  }
});

test("[ and ] leave a lab-only scene for the cycle's scenes either side of it", () => {
  for (const id of sceneOrder.filter((scene) => labOnly[scene] === true)) {
    const at = sceneOrder.indexOf(id);
    const before = sceneOrder.slice(0, at).filter((scene) => labOnly[scene] !== true);
    const after = sceneOrder.slice(at + 1).filter((scene) => labOnly[scene] !== true);
    expect(sceneStep(id, 1)).toBe(after[0] ?? sceneCycle[0] ?? id);
    expect(sceneStep(id, -1)).toBe(before.at(-1) ?? sceneCycle.at(-1) ?? id);
  }
  expect(sceneStep("land", 1)).toBe("meadow");
});

test("a saved document's card matches by its name, its title or the kinds it holds", () => {
  const doc = {
    name: "Evening",
    savedAt: 1,
    doc: {
      v: 1 as const,
      title: "Garden at dusk",
      camera: { at: [0, 1.6, -4] as const, yaw: 0, pitch: 0, fov: 1 },
      world: {},
      objects: [
        { id: "lamp-1", kind: "lamp", at: [0, 0, 0] as const, yaw: 0, scale: 1, options: {} },
      ],
    },
  };
  for (const query of ["", "even", "DUSK", "lamp", "canvas"])
    expect(docMatches(doc, query)).toBe(true);
  expect(docMatches(doc, "harbour")).toBe(false);
});
