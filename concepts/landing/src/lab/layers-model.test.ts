import { describe, expect, test } from "bun:test";
import type { SceneLayers } from "../composer/compose.ts";
import { beesScene } from "../scenes/bees/index.ts";
import { meadowScene } from "../scenes/meadow/index.ts";
import { paramDefaults } from "../state.ts";
import { layerRows, layerTurn } from "./layers-model.ts";

const bees = beesScene.layers;
const meadow = meadowScene.layers;
if (bees === undefined || meadow === undefined) throw new Error("the pilot's scenes are composed");

/** A reader of the bees' knobs at their defaults, with `patch` over them. */
const beesAt = (patch: Record<string, number> = {}) => {
  const params: Record<string, number> = { ...paramDefaults("bees"), ...patch };
  return (key: string) => params[key] ?? 0;
};
const states = (layers: SceneLayers, value: (key: string) => number) =>
  layerRows(layers, value).map((row) => ({
    role: row.role,
    layers: row.layers.map(({ id, state }) =>
      state.kind === "refused" ? `${id} refused: ${state.reason}` : `${id} ${state.kind}`,
    ),
  }));

describe("the Layers section", () => {
  test("lays the offered layers out by role, each on, off or refused with its reason", () => {
    expect(states(bees, beesAt())).toEqual([
      { role: "backdrop", layers: ["downs off", "hillside on", "valley off"] },
      { role: "ground", layers: ["lawn on"] },
      { role: "dressing", layers: ["apiary on", "dandelions off"] },
      { role: "cover", layers: ["grass off", "wildflowers off"] },
      { role: "life", layers: ["insects on", "murmuration off"] },
      { role: "chore", layers: ["gardening on"] },
    ]);
    expect(states(bees, beesAt({ apiary: 0 })).slice(-2)).toEqual([
      { role: "life", layers: ["insects refused: needs Apiary", "murmuration off"] },
      { role: "chore", layers: ["gardening refused: needs Apiary"] },
    ]);
    expect(
      states(meadow, (key) => paramDefaults("meadow")[key] ?? 0).map((row) => row.role),
    ).toEqual(["backdrop", "dressing", "cover", "life"]);
  });

  test("swaps a backdrop or a ground for the one of its role, and keeps the backdrop on", () => {
    expect(layerTurn(bees, beesAt(), "downs", true)).toEqual({ downs: 1, hillside: 0 });
    expect(layerTurn(bees, beesAt(), "hillside", false)).toEqual({});
    expect(layerTurn(bees, beesAt({ downs: 1 }), "hillside", false)).toEqual({ hillside: 0 });
    expect(layerTurn(bees, beesAt(), "lawn", false)).toEqual({ lawn: 0 });
    expect(layerTurn(bees, beesAt(), "grass", true)).toEqual({ grass: 1 });
    expect(layerTurn(bees, beesAt(), "apiary", false)).toEqual({ apiary: 0 });
    // The swap draws what it says: the downs behind the garden, nothing refused.
    const swapped = beesAt(layerTurn(bees, beesAt(), "downs", true));
    expect(states(bees, swapped)[0]).toEqual({
      role: "backdrop",
      layers: ["downs on", "hillside off", "valley off"],
    });
  });

  test("switches off what a layer switched on excludes, both ways", () => {
    const layers: SceneLayers = {
      ...bees,
      excludes: {
        grass: [{ layer: "lawn", why: "one ground cover" }],
        lawn: [{ layer: "grass", why: "one ground cover" }],
      },
    };
    expect(layerTurn(layers, beesAt(), "grass", true)).toEqual({ grass: 1, lawn: 0 });
    expect(layerTurn(layers, beesAt({ grass: 1, lawn: 0 }), "lawn", true)).toEqual({
      lawn: 1,
      grass: 0,
    });
  });
});
