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
  sceneStep,
  type GalleryCard,
} from "./gallery-model.ts";

const saved = (name: string, query: string): Preset => ({
  name,
  commit: "working-tree",
  query,
  savedAt: "2026-10-19",
});

const scenesOf = (cards: readonly GalleryCard[]) =>
  cards.filter((card) => card.kind === "scene").map((card) => card.scene);

describe("the Scenes view's shelves", () => {
  const shelves = galleryShelves([]);

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
      expect(shelf.cards[0]).toEqual({ kind: "scene", scene: shelf.baseline, baseline: true });
      expect<string[]>(scenesOf(shelf.cards)).toEqual(Object.keys(registry));
      expect(shelf.cards.slice(1).every((card) => card.kind === "scene" && !card.baseline)).toBe(
        true,
      );
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

  test("put a setup saved here on its scene's baseline's shelf, after the scenes, as custom", () => {
    const rain = saved("Sill · my rain", "scene=sill&rain=1");
    const local = [
      rain,
      saved("Fractal · deep", "scene=fractal&zoom=3"),
      saved("Gone", "scene=nowhere"),
      saved("Land · dusk", "scene=land&time=0.8"),
      saved("Pond · still", "scene=pond&wind=0"),
    ];
    const [room, land, patch, standalone] = galleryShelves(local);
    const custom = (cards: readonly GalleryCard[] = []) =>
      cards.flatMap((card) => (card.kind === "custom" ? [[card.scene, card.local]] : []));
    expect(custom(room?.cards)).toEqual([["sill", 0]]);
    expect(custom(land?.cards)).toEqual([["land", 3]]);
    expect(custom(patch?.cards)).toEqual([["pond", 4]]);
    expect(custom(standalone?.cards)).toEqual([["fractal", 1]]);
    expect(room?.cards.at(-1)).toEqual({ kind: "custom", scene: "sill", preset: rain, local: 0 });
    // A setup of a scene this build lacks is on no shelf.
    expect(galleryShelves(local).flatMap((shelf) => custom(shelf.cards))).toHaveLength(4);
  });

  test("match a search by a scene's title or a custom setup's name", () => {
    const [room] = galleryShelves([saved("Quiet evening", "scene=sill&rain=1")]);
    const sill = room?.cards.find((card) => card.kind === "scene" && card.scene === "sill");
    const mine = room?.cards.find((card) => card.kind === "custom");
    if (sill === undefined || mine === undefined) throw new Error("no sill or no custom card");
    expect(cardMatches(sill, "")).toBe(true);
    expect(cardMatches(sill, ` ${sceneDefs.sill.title.toUpperCase()} `)).toBe(true);
    expect(cardMatches(sill, "quiet")).toBe(false);
    expect(cardMatches(mine, "quiet")).toBe(true);
    expect(cardMatches(mine, sceneDefs.sill.title)).toBe(true);
    expect(cardMatches(mine, "nothing like it")).toBe(false);
    // Not by a blurb.
    expect(cardMatches(sill, sceneDefs.sill.blurb)).toBe(false);
  });
});

test("the Scenes view's order is its shelves' scenes in order", () => {
  expect(sceneOrder).toEqual(galleryShelves([]).flatMap((shelf) => scenesOf(shelf.cards)));
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
  const shelves = galleryShelves([]).map((shelf) =>
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
