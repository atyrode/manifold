import { describe, expect, test } from "bun:test";
import { frostVariant } from "../scenes/frost/index.ts";
import { sceneDefs, sceneIds } from "../scenes/index.ts";
import { landVariant } from "../scenes/land/index.ts";
import { meadowVariant } from "../scenes/meadow/index.ts";
import { patchVariant } from "../scenes/patch/index.ts";
import { pondVariant } from "../scenes/pond/index.ts";
import { rippleVariant } from "../scenes/ripple/index.ts";
import { roomVariant } from "../scenes/room/index.ts";
import { SILL_ROOM } from "../scenes/sill/constants.ts";
import { sillVariant } from "../scenes/sill/index.ts";
import {
  ComposeError,
  composeScene,
  overheadVariantPreset,
  variantPreset,
  type Composer,
} from "./compose.ts";
import { interior } from "./interior.ts";
import {
  folderVariants,
  interiorVariants,
  promotedInteriorVariants,
  promotedVariants,
  sourceRoom,
} from "./interior-variants.ts";
import { outdoor } from "./outdoor.ts";
import { outdoorVariants } from "./outdoor-variants.ts";
import { overhead } from "./overhead.ts";
import { overheadVariants } from "./overhead-variants.ts";
import type {
  Baseline,
  Flyway,
  Grade,
  LayerChanges,
  OverheadVariant,
  ScenePreset,
  Variant,
} from "./types.ts";

// The composers' variants over their baselines (ADR 0062 "Baselines and variants"): every room is
// one, the rooms in their folders and the promoted ones (D15), every outdoor scene (step 5) and
// every scene seen from above (step 6); none keeps a difference that changes nothing, which would
// hide a better baseline (D14).

/** A composer with its baseline. */
type Based = Composer & { readonly baseline: Baseline };

/** The knobs `variant` lists over `composer`'s baseline. */
const knobs = (composer: Based, variant: Variant) =>
  composeScene(composer, variantPreset(composer.baseline, variant)).def.params;

/** The scene `variant` composes to over the overhead's baseline. */
const overheadScene = (variant: OverheadVariant) =>
  composeScene(overhead, overheadVariantPreset(overhead.baseline, variant));

/** Each layer `changes` adds that is on already over the `home` layers, or removes that is off. */
function layerRedundancies(home: readonly string[], changes: LayerChanges = {}): string[] {
  const found: string[] = [];
  const { add = [], remove = [] } = changes;
  for (const [at, id] of add.entries())
    if (home.includes(id) || add.indexOf(id) !== at) found.push(`adds ${id}, on already`);
  for (const [at, id] of remove.entries())
    if (!home.includes(id) || remove.indexOf(id) !== at) found.push(`removes ${id}, off already`);
  return found;
}

/**
 * Each of `values` that changes nothing: its knob's default without it is the same (the baseline's
 * value, or the knob's own default the baseline leaves it at), `listed` the knobs a variant holding
 * these values lists.
 */
function valueRedundancies(
  values: Readonly<Record<string, number>>,
  listed: (values: Readonly<Record<string, number>>) => unknown,
): string[] {
  const found: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    const without = Object.fromEntries(Object.entries(values).filter(([other]) => other !== key));
    if (Bun.deepEquals(listed(values), listed(without)))
      found.push(`value ${key}: ${value}, the baseline's`);
  }
  return found;
}

/** Each of `variant`'s differences that changes nothing over `composer`'s baseline. */
function redundancies(composer: Based, variant: Variant): string[] {
  const { baseline } = composer;
  const found = layerRedundancies(baseline.layers, variant.layers);
  if (variant.camera !== undefined && Bun.deepEquals(variant.camera, baseline.rig))
    found.push("camera: the baseline's");
  if (variant.room !== undefined && Bun.deepEquals(variant.room, baseline.room))
    found.push("room: the baseline's");
  for (const [key, value] of Object.entries(variant.grade ?? {}))
    if (Bun.deepEquals(value, baseline.grade[key as keyof Grade]))
      found.push(`grade ${key}: the baseline's`);
  // A World option is redundant where the scene lists the same knobs without it: the baseline's
  // option, or the World's own default the baseline leaves it at.
  const world = variant.world ?? {};
  for (const key of Object.keys(world)) {
    const without = Object.fromEntries(
      Object.entries(world).filter(([other]) => other !== key),
    ) as Partial<ScenePreset["world"]>;
    if (Bun.deepEquals(knobs(composer, variant), knobs(composer, { ...variant, world: without })))
      found.push(`world ${key}: the baseline's`);
  }
  if (variant.meteors !== undefined && Bun.deepEquals(variant.meteors, baseline.meteors))
    found.push("meteors: the baseline's");
  for (const [key, value] of Object.entries(variant.flyway ?? {}))
    if (Bun.deepEquals(value, baseline.flyway[key as keyof Flyway]))
      found.push(`flyway ${key}: the baseline's`);
  if (variant.floor !== undefined && variant.floor === baseline.floor)
    found.push("floor: the baseline's");
  if (variant.elements !== undefined && Bun.deepEquals(variant.elements, baseline.elements))
    found.push("elements: the baseline's");
  found.push(
    ...valueRedundancies(variant.values ?? {}, (values) => knobs(composer, { ...variant, values })),
  );
  return found;
}

/**
 * Each of `variant`'s differences that changes nothing over the overhead's baseline: besides its
 * layers, rig and values, its painted hour where it is the baseline's (`false` for none) or where no
 * layer the sky lights is offered (LayerDef.sunlit), which alone reads it (overhead-glsl.ts).
 */
function overheadRedundancies(variant: OverheadVariant): string[] {
  const { baseline } = overhead;
  const found = layerRedundancies(baseline.layers, variant.layers);
  if (variant.camera !== undefined && Bun.deepEquals(variant.camera, baseline.rig))
    found.push("camera: the baseline's");
  if (variant.painted !== undefined) {
    const { offered } = overheadScene(variant);
    if (variant.painted === (baseline.painted ?? false)) found.push("painted: the baseline's");
    else if (
      !offered.some((layer) => layer.open === true) ||
      !offered.some((layer) => layer.sunlit === true)
    )
      found.push("painted: no layer the sky lights");
  }
  found.push(
    ...valueRedundancies(
      variant.values ?? {},
      (values) => overheadScene({ ...variant, values }).def.params,
    ),
  );
  return found;
}

describe("the interior's variants", () => {
  const variants: readonly Variant[] = Object.values(interiorVariants);

  test("are every room in the registry, the baseline's own scene among them", () => {
    const own = new Set(interior.layers.map((layer) => layer.id));
    const rooms = sceneIds.filter((id) =>
      sceneDefs[id].layers?.offered.every((layer) => own.has(layer.id)),
    );
    expect(variants.map((variant) => variant.id).sort()).toEqual([...rooms].sort());
    for (const variant of variants) expect(variant.base).toBe("interior");
  });

  test("hold no difference that changes nothing", () => {
    for (const variant of variants)
      expect({ id: variant.id, found: redundancies(interior, variant) }).toEqual({
        id: variant.id,
        found: [],
      });
  });

  test("the baseline's own scene is the baseline: its identity, no difference", () => {
    const identity = ["id", "base", "title", "blurb", "accent", "look", "planets"];
    expect(Object.keys(roomVariant).filter((key) => !identity.includes(key))).toEqual([]);
  });

  test("the promoted ones are keyed by their ids, stem from a room and say where they came from", () => {
    for (const [key, variant] of Object.entries<Variant>(promotedInteriorVariants))
      expect({ key, id: variant.id }).toEqual({ key, id: key });
    for (const variant of promotedVariants) {
      expect({ id: variant.id, folder: variant.id in folderVariants }).toEqual({
        id: variant.id,
        folder: false,
      });
      expect(variant.from?.commit).toMatch(/^[0-9a-f]{7,40}$|^working-tree$/);
      expect(sourceRoom(variant) in folderVariants).toBe(true);
    }
  });

  test("a room in its folder stems from itself; a promoted one from the room its query names", () => {
    expect(sourceRoom(sillVariant)).toBe("sill");
    const promoted = (id: string, query: string): Variant => ({
      ...sillVariant,
      id,
      from: { commit: "36bc94dd", query },
    });
    expect(sourceRoom(promoted("sillcat", "scene=sill&cat=0"))).toBe("sill");
    expect(() => sourceRoom(promoted("lost", "scene=pond"))).toThrow(/stems from no room/);
    expect(() => sourceRoom(promoted("self", "scene=self"))).toThrow(/stems from no room/);
  });
});

describe("the outdoor's variants", () => {
  const variants: readonly Variant[] = Object.values(outdoorVariants);

  test("are scenes keyed by their ids, the baseline's own scene first, each composed from its variant", () => {
    expect(Object.keys(outdoorVariants)[0]).toBe("land");
    const own = new Set(outdoor.layers.map((layer) => layer.id));
    for (const [key, variant] of Object.entries<Variant>(outdoorVariants)) {
      expect({ key, id: variant.id, base: variant.base }).toEqual({
        key,
        id: key,
        base: "outdoor",
      });
      const id = sceneIds.find((scene) => scene === key);
      if (id === undefined) throw new Error(`variant ${key} is no scene`);
      expect(sceneDefs[id].layers?.offered.every((layer) => own.has(layer.id))).toBe(true);
      expect(sceneDefs[id].params).toEqual(knobs(outdoor, variant));
    }
  });

  test("hold no difference that changes nothing", () => {
    for (const variant of variants)
      expect({ id: variant.id, found: redundancies(outdoor, variant) }).toEqual({
        id: variant.id,
        found: [],
      });
  });

  test("the baseline's own scene is the baseline: its identity, no difference", () => {
    const identity = ["id", "base", "title", "blurb", "accent", "look", "planets"];
    expect(Object.keys(landVariant).filter((key) => !identity.includes(key))).toEqual([]);
  });
});

describe("the overhead's variants", () => {
  const variants: readonly OverheadVariant[] = Object.values(overheadVariants);

  test("are every scene seen from above, keyed by their ids, the baseline's own scene first, each composed from its variant", () => {
    expect(Object.keys(overheadVariants)[0]).toBe("patch");
    const own = new Set(overhead.layers.map((layer) => layer.id));
    const patches = sceneIds.filter((id) =>
      sceneDefs[id].layers?.offered.every((layer) => own.has(layer.id)),
    );
    expect(Object.keys(overheadVariants).sort()).toEqual([...patches].sort());
    for (const [key, variant] of Object.entries<OverheadVariant>(overheadVariants)) {
      expect({ key, id: variant.id, base: variant.base }).toEqual({
        key,
        id: key,
        base: "overhead",
      });
      const id = sceneIds.find((scene) => scene === key);
      if (id === undefined) throw new Error(`variant ${key} is no scene`);
      expect(sceneDefs[id].params).toEqual(overheadScene(variant).def.params);
    }
  });

  test("hold no difference that changes nothing", () => {
    for (const variant of variants)
      expect({ id: variant.id, found: overheadRedundancies(variant) }).toEqual({
        id: variant.id,
        found: [],
      });
  });

  test("the baseline's own scene is the baseline: its identity, no difference", () => {
    const identity = ["id", "base", "title", "blurb", "accent", "look"];
    expect(Object.keys(patchVariant).filter((key) => !identity.includes(key))).toEqual([]);
  });

  test("a variant over another composer's baseline is refused", () => {
    expect(() =>
      overheadVariantPreset(overhead.baseline, { ...pondVariant, base: "outdoor" }),
    ).toThrow(ComposeError);
    expect(() => variantPreset(outdoor.baseline, { ...landVariant, base: "overhead" })).toThrow(
      ComposeError,
    );
  });
});

describe("the redundancy test", () => {
  test("refuses a layer added that is on, or removed that is off", () => {
    expect(
      redundancies(interior, {
        ...sillVariant,
        layers: { add: ["cityWindow", "props", "props"], remove: ["papered"] },
      }),
    ).toEqual([
      "adds cityWindow, on already",
      "adds props, on already",
      "removes papered, off already",
    ]);
    expect(
      redundancies(outdoor, { ...meadowVariant, layers: { add: ["downs", "grass"] } }),
    ).toEqual(["adds downs, on already"]);
  });

  test("refuses the baseline's camera, room, grade and elements", () => {
    const baseline = interior.baseline;
    expect(
      redundancies(interior, {
        ...roomVariant,
        camera: { ...baseline.rig },
        room: { ...SILL_ROOM },
        grade: { ink: { gain: 1.25, gamma: 1 }, vignette: 0.28 },
        elements: [...baseline.elements],
      }),
    ).toEqual([
      "camera: the baseline's",
      "room: the baseline's",
      "grade ink: the baseline's",
      "elements: the baseline's",
    ]);
  });

  test("refuses the baseline's World options, its own or the World's default, meteors, flyway keys and floor", () => {
    // The baseline's afternoon is 0.62; the World's fair-weather cloud is 0.25 by default.
    const baseline = outdoor.baseline;
    expect(
      redundancies(outdoor, {
        ...landVariant,
        world: { time: 0.62, clouds: 0.25, stars: 0.5 },
        meteors: [...baseline.meteors],
        flyway: { seed: baseline.flyway.seed, skim: 1 },
        floor: "lawn",
      }),
    ).toEqual([
      "world time: the baseline's",
      "world clouds: the baseline's",
      "meteors: the baseline's",
      "flyway seed: the baseline's",
      "floor: the baseline's",
    ]);
  });

  test("refuses a value the baseline holds already, its own or its knob's default", () => {
    // The baseline's dusk is 0.8; the World's moon is full by default.
    expect(
      redundancies(interior, { ...roomVariant, values: { time: 0.8, moon: 1, clouds: 0.5 } }),
    ).toEqual(["value time: 0.8, the baseline's", "value moon: 1, the baseline's"]);
    expect(
      redundancies(interior, { ...frostVariant, values: { ...frostVariant.values, stars: 0.5 } }),
    ).toEqual(["value stars: 0.5, the baseline's"]);
  });

  test("refuses over the overhead's baseline a layer on or off already, its rig, its painted hour, one no layer reads, and its values", () => {
    // The baseline's hour and painted hour are 0.5825; the World's rain is off by default.
    expect(
      overheadRedundancies({
        ...pondVariant,
        layers: { add: ["pondWater", "border", "koi", "pondBed"], remove: ["tank"] },
        camera: { ...overhead.baseline.rig },
        painted: 0.5825,
        values: { wind: 0.4, time: 0.5825, rain: 0 },
      }),
    ).toEqual([
      "adds pondBed, on already",
      "removes tank, off already",
      "camera: the baseline's",
      "painted: the baseline's",
      "value time: 0.5825, the baseline's",
      "value rain: 0, the baseline's",
    ]);
    // The tank's lamp lights it: no layer the sky lights reads a painted hour.
    expect(overheadRedundancies({ ...rippleVariant, painted: false })).toEqual([
      "painted: no layer the sky lights",
    ]);
  });
});
