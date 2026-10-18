import { describe, expect, test } from "bun:test";
import { toggle } from "../params.ts";
import { beesComposed } from "../scenes/bees/index.ts";
import { meadowComposed } from "../scenes/meadow/index.ts";
import { COMPOSER_CAPS } from "./caps.ts";
import { admits, place, type Placement } from "./place.ts";
import type { Anchor, Claim, LayerDef, Rig, Role } from "./types.ts";

const RIG: Rig = { horizon: 0.45, focal: 1, eye: 1.6, turn: 0, pitch: 0, minAspect: 1.6 };

/** A layer of `role` for these tests: its claims at each of its anchors in turn. */
function layer(
  id: string,
  role: Role,
  more: Partial<Omit<LayerDef, "id" | "role" | "space">> & {
    anchors?: readonly Anchor[];
    claims?: readonly Claim[];
  } = {},
): LayerDef {
  const { anchors = [], claims = [], ...rest } = more;
  return {
    id,
    title: id.charAt(0).toUpperCase() + id.slice(1),
    composers: ["outdoor"],
    role,
    bands: ["middle"],
    space: { anchors, claims },
    camera: {},
    switch: toggle("layers", id, id, false, id),
    params: [],
    groups: {},
    passes: {},
    ...rest,
  };
}

const at = (name: string, x: number, z: number): Anchor => ({ name, at: [x, z] });
const pad = (name: string, r = 1): Claim => ({
  name,
  kind: "exclusive",
  shape: { kind: "disc", at: [0, 0], r },
});
/** The layer ids kept, in order, and each refused one with its reason. */
const outcome = (placement: Placement) => ({
  kept: placement.layers.map((placed) => `${placed.layer.id}@${placed.anchor.name}`),
  refused: placement.refused.map((refusal) => `${refusal.layer}: ${refusal.reason}`),
});

const hills = layer("hills", "backdrop");
const dunes = layer("dunes", "backdrop");
const lawn = layer("lawn", "ground");
const gravel = layer("gravel", "ground");
const fire = layer("fire", "dressing", {
  subject: true,
  bands: ["front"],
  anchors: [at("centre", 0, 6), at("left", -3, 9)],
  claims: [pad("the fire's ring")],
});
const bench = layer("bench", "dressing", {
  subject: true,
  bands: ["front"],
  anchors: [at("centre", 0, 6), at("right", 3, 9)],
  claims: [pad("the bench")],
});
const offered = [hills, dunes, lawn, gravel, fire, bench];
const preset = { rig: RIG, layers: ["hills", "lawn", "fire"] };

describe("the placer", () => {
  test("is a pure function of the set switched on: any order in, the same placement out", () => {
    const ids = ["hills", "lawn", "fire", "bench", "dunes"];
    const once = place(offered, preset, new Set(ids));
    expect(place(offered, preset, new Set([...ids].reverse()))).toEqual(once);
    expect(place(offered, preset, new Set(ids))).toEqual(once);
    expect(place([...offered], { ...preset }, new Set(ids))).toEqual(once);
  });

  test("places the home layers first, and a guest never moves one: it steps to its next anchor", () => {
    const placement = place(offered, preset, new Set(["hills", "lawn", "fire", "bench"]));
    expect(outcome(placement)).toEqual({
      kept: ["hills@here", "lawn@here", "fire@centre", "bench@right"],
      refused: [],
    });
    // Its claims stand where it was placed, in canonical order of their layers.
    expect(placement.claims.map((claim) => [claim.layer, claim.shape])).toEqual([
      ["fire", { kind: "disc", at: [0, 6], r: 1 }],
      ["bench", { kind: "disc", at: [3, 9], r: 1 }],
    ]);
    // As a home layer, the bench keeps the centre and the fire steps aside.
    const benchHome = place(
      offered,
      { ...preset, layers: ["hills", "bench"] },
      new Set(["hills", "fire", "bench"]),
    );
    expect(outcome(benchHome).kept).toEqual(["hills@here", "fire@left", "bench@centre"]);
  });

  test("refuses a layer no anchor of which fits, naming what holds its place", () => {
    const stool = layer("stool", "dressing", {
      anchors: [at("centre", 0, 6)],
      claims: [pad("the stool", 0.5)],
    });
    expect(outcome(place([...offered, stool], preset, new Set(["fire", "stool"])))).toEqual({
      kept: ["hills@here", "fire@centre"],
      refused: ["stool: the fire's ring stand where stool would"],
    });
    // Shared claims overlap anything.
    const drift = layer("drift", "cover", {
      claims: [{ name: "a drift", kind: "shared", shape: { kind: "disc", at: [0, 6], r: 3 } }],
    });
    expect(outcome(place([...offered, drift], preset, new Set(["fire", "drift"]))).refused).toEqual(
      [],
    );
  });

  test("refuses an anchor that leaves a must-show claim out of view at the rig's minAspect", () => {
    const sign = layer("sign", "dressing", {
      anchors: [at("far left", -20, 5), at("ahead", 0, 12)],
      claims: [{ ...pad("the sign", 0.3), mustShow: true }],
    });
    expect(outcome(place([hills, sign], preset, new Set(["sign"]))).kept).toEqual([
      "hills@here",
      "sign@ahead",
    ]);
    const lost = layer("lost", "dressing", {
      anchors: [at("far left", -20, 5)],
      claims: [{ ...pad("the post", 0.3), mustShow: true }],
    });
    expect(outcome(place([hills, lost], preset, new Set(["lost"]))).refused).toEqual([
      "lost: no room in view for lost",
    ]);
  });

  test("holds one backdrop and one ground: a second is refused, and with none on the home backdrop stands", () => {
    expect(outcome(place(offered, preset, new Set(["hills", "dunes", "lawn", "gravel"])))).toEqual({
      kept: ["hills@here", "lawn@here"],
      refused: [
        "dunes: Hills is the backdrop already: one at a time",
        "gravel: Lawn is the ground already: one at a time",
      ],
    });
    expect(outcome(place(offered, preset, new Set(["dunes", "gravel"]))).kept).toEqual([
      "dunes@here",
      "gravel@here",
    ]);
    expect(outcome(place(offered, preset, new Set())).kept).toEqual(["hills@here"]);
  });

  test("keeps exclusions and hosts: the earlier keeps its place, a chore waits for its host", () => {
    const smoke = layer("smoke", "life", {
      excludes: [{ layer: "fire", why: "the smoke would hide the flames" }],
    });
    const raking = layer("raking", "chore", { requires: ["lawn"] });
    const all = [...offered, smoke, raking];
    expect(outcome(place(all, preset, new Set(["fire", "smoke", "raking"])))).toEqual({
      kept: ["hills@here", "fire@centre"],
      refused: ["smoke: not with Fire: the smoke would hide the flames", "raking: needs Lawn"],
    });
    expect(outcome(place(all, preset, new Set(["lawn", "raking"]))).kept).toEqual([
      "hills@here",
      "lawn@here",
      "raking@here",
    ]);
  });

  test("caps the layers on, the front's subjects and the claims", () => {
    const covers = Array.from({ length: COMPOSER_CAPS.layers }, (_, i) =>
      layer(`cover${i}`, "cover"),
    );
    const capped = place([hills, ...covers], preset, new Set(covers.map((c) => c.id)));
    expect(capped.layers).toHaveLength(COMPOSER_CAPS.layers);
    expect(outcome(capped).refused).toEqual([
      `cover${COMPOSER_CAPS.layers - 1}: ${COMPOSER_CAPS.layers} layers are on: the most a stack holds`,
    ]);

    const stall = layer("stall", "dressing", {
      subject: true,
      bands: ["front"],
      anchors: [at("far", 0, 20)],
      claims: [pad("the stall")],
    });
    expect(
      outcome(place([...offered, stall], preset, new Set(["fire", "bench", "stall"]))).refused,
    ).toEqual([`stall: the front holds ${COMPOSER_CAPS.subjects} subjects already`]);

    const posts = (id: string, count: number, z: number) =>
      layer(id, "dressing", {
        claims: Array.from({ length: count }, (_, i) => ({
          name: "a post",
          kind: "exclusive" as const,
          shape: { kind: "disc" as const, at: [i * 2 - 10, z] as const, r: 0.2 },
        })),
      });
    const many = posts("fence", COMPOSER_CAPS.claims - 1, 20);
    const more = posts("gate", 2, 30);
    expect(outcome(place([hills, many, more], preset, new Set(["fence", "gate"]))).refused).toEqual(
      [`gate: its claims would take the stack past ${COMPOSER_CAPS.claims}`],
    );
  });

  test("offers a layer only to the rigs its camera range admits", () => {
    const high = layer("high", "life", { camera: { eye: [1, 2] } });
    expect(admits(high, RIG)).toBe(true);
    expect(admits(high, { ...RIG, eye: 2.5 })).toBe(false);
  });
});

describe("the pilot's placements", () => {
  const ids = (placement: Placement) => placement.layers.map((placed) => placed.layer.id);

  test("place every preset's home layers, as they were", () => {
    for (const composed of [meadowComposed, beesComposed]) {
      const home = composed.place(new Set(composed.preset.layers));
      expect({ id: composed.preset.id, kept: ids(home), refused: home.refused }).toEqual({
        id: composed.preset.id,
        kept: composed.offered
          .filter((offer) => composed.preset.layers.includes(offer.id))
          .map((offer) => offer.id),
        refused: [],
      });
    }
  });

  test("grow the meadow's grass and wildflowers into the bees' garden round its claims", () => {
    const mix = beesComposed.place(
      new Set([...beesComposed.preset.layers, "grass", "wildflowers"]),
    );
    expect(ids(mix)).toEqual([
      "hillside",
      "lawn",
      "apiary",
      "grass",
      "wildflowers",
      "insects",
      "gardening",
    ]);
    expect(mix.refused).toEqual([]);
    expect(mix.claims.length).toBeLessThanOrEqual(COMPOSER_CAPS.claims);
    expect(new Set(mix.claims.map((claim) => claim.layer))).toEqual(new Set(["apiary"]));
  });

  test("refuse the bees' insects without their apiary, and the downs beside the hillside", () => {
    const bare = beesComposed.place(new Set(["hillside", "lawn", "insects", "downs"]));
    expect(ids(bare)).toEqual(["hillside", "lawn"]);
    expect(bare.refused).toEqual([
      { layer: "insects", reason: "needs Apiary" },
      { layer: "downs", reason: "Hillside is the backdrop already: one at a time" },
    ]);
  });
});
