import { describe, expect, test } from "bun:test";
import { barVariant } from "../scenes/bar/index.ts";
import { bonsaiVariant } from "../scenes/bonsai/index.ts";
import { frostVariant } from "../scenes/frost/index.ts";
import { incenseVariant } from "../scenes/incense/index.ts";
import { sceneDefs, sceneIds } from "../scenes/index.ts";
import { lavaVariant } from "../scenes/lava/index.ts";
import { mobileVariant } from "../scenes/mobile/index.ts";
import { roomVariant } from "../scenes/room/index.ts";
import { SILL_ROOM } from "../scenes/sill/constants.ts";
import { sillVariant } from "../scenes/sill/index.ts";
import { trainVariant } from "../scenes/train/index.ts";
import { composeScene, variantPreset } from "./compose.ts";
import { interior } from "./interior.ts";
import type { Grade, Variant } from "./types.ts";

// The interior's variants over its baseline (ADR 0062 "Baselines and variants"): every room is one,
// and none keeps a difference that changes nothing, which would hide a better baseline (D14).

const VARIANTS: readonly Variant[] = [
  roomVariant,
  sillVariant,
  lavaVariant,
  bonsaiVariant,
  incenseVariant,
  frostVariant,
  barVariant,
  trainVariant,
  mobileVariant,
];

const baseline = interior.baseline;

/** Each of `variant`'s differences that changes nothing over the baseline. */
function redundancies(variant: Variant): string[] {
  const found: string[] = [];
  const home = baseline.layers;
  const { add = [], remove = [] } = variant.layers ?? {};
  for (const [at, id] of add.entries())
    if (home.includes(id) || add.indexOf(id) !== at) found.push(`adds ${id}, on already`);
  for (const [at, id] of remove.entries())
    if (!home.includes(id) || remove.indexOf(id) !== at) found.push(`removes ${id}, off already`);
  if (variant.camera !== undefined && Bun.deepEquals(variant.camera, baseline.rig))
    found.push("camera: the baseline's");
  if (variant.room !== undefined && Bun.deepEquals(variant.room, baseline.room))
    found.push("room: the baseline's");
  for (const [key, value] of Object.entries(variant.grade ?? {}))
    if (Bun.deepEquals(value, baseline.grade[key as keyof Grade]))
      found.push(`grade ${key}: the baseline's`);
  if (variant.elements !== undefined && Bun.deepEquals(variant.elements, baseline.elements))
    found.push("elements: the baseline's");
  // A value is redundant where its knob's default without it is the same: the baseline's value, or
  // the knob's own default the baseline leaves it at.
  const values = variant.values ?? {};
  for (const [key, value] of Object.entries(values)) {
    const without = Object.fromEntries(Object.entries(values).filter(([other]) => other !== key));
    const [kept, dropped] = [values, without].map(
      (set) =>
        composeScene(interior, variantPreset(baseline, { ...variant, values: set })).def.params,
    );
    if (Bun.deepEquals(kept, dropped)) found.push(`value ${key}: ${value}, the baseline's`);
  }
  return found;
}

describe("the interior's variants", () => {
  test("are every room in the registry, the baseline's own scene among them", () => {
    const own = new Set(interior.layers.map((layer) => layer.id));
    const rooms = sceneIds.filter((id) =>
      sceneDefs[id].layers?.offered.every((layer) => own.has(layer.id)),
    );
    expect(VARIANTS.map((variant) => variant.id).sort()).toEqual([...rooms].sort());
    for (const variant of VARIANTS) expect(variant.base).toBe("interior");
  });

  test("hold no difference that changes nothing", () => {
    for (const variant of VARIANTS)
      expect({ id: variant.id, found: redundancies(variant) }).toEqual({
        id: variant.id,
        found: [],
      });
  });

  test("the baseline's own scene is the baseline: its identity, no difference", () => {
    const identity = ["id", "base", "title", "blurb", "accent", "look", "planets"];
    expect(Object.keys(roomVariant).filter((key) => !identity.includes(key))).toEqual([]);
  });
});

describe("the redundancy test", () => {
  test("refuses a layer added that is on, or removed that is off", () => {
    expect(
      redundancies({
        ...sillVariant,
        layers: { add: ["sill", "props", "props"], remove: ["papered"] },
      }),
    ).toEqual(["adds sill, on already", "adds props, on already", "removes papered, off already"]);
  });

  test("refuses the baseline's camera, room, grade and elements", () => {
    expect(
      redundancies({
        ...roomVariant,
        camera: { ...baseline.rig },
        room: { ...SILL_ROOM },
        grade: { ink: { gain: 1.25, gamma: 1 }, vignette: 0.28 },
        elements: [],
      }),
    ).toEqual([
      "camera: the baseline's",
      "room: the baseline's",
      "grade ink: the baseline's",
      "elements: the baseline's",
    ]);
  });

  test("refuses a value the baseline holds already, its own or its knob's default", () => {
    // The baseline's dusk is 0.8; the World's moon is full by default.
    expect(redundancies({ ...roomVariant, values: { time: 0.8, moon: 1, clouds: 0.5 } })).toEqual([
      "value time: 0.8, the baseline's",
      "value moon: 1, the baseline's",
    ]);
    expect(
      redundancies({ ...frostVariant, values: { ...frostVariant.values, stars: 0.5 } }),
    ).toEqual(["value stars: 0.5, the baseline's"]);
  });
});
