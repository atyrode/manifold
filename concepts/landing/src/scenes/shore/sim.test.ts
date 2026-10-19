import { expect, test } from "bun:test";
import { ATLAS_WIDTH } from "../../composer/caps.ts";
import { principal } from "../../principals.ts";
import { HeadlessSim } from "../../sims/headless.ts";
import { glslFloat } from "../../shaders/glsl.ts";
import { SHORE_BEACH, SHORE_FOCAL } from "./beach.ts";
import { CAIRN_ROW, CAIRN_SITES, ShoreCairns, type CairnFrame } from "./cairns.ts";
import { SHORE_FLYWAY, SHORE_RIG } from "./constants.ts";
import { shoreComposed } from "./index.ts";
import { loadScene } from "../index.ts";
import { shoreSharedGlsl } from "./shader.ts";
import type { PrincipalState } from "../types.ts";

const shoreScene = await loadScene("shore");

const ASPECT = 16 / 9;

test("the beach the cairns' surf is mirrored from is the shader's", () => {
  expect(SHORE_RIG.horizon).toBe(SHORE_BEACH.horizon);
  expect(SHORE_RIG.eye).toBe(SHORE_BEACH.eye);
  expect(SHORE_RIG.focal).toBe(SHORE_FOCAL);
  for (const [name, value] of [
    ["EYE", SHORE_BEACH.eye],
    ["LINE", SHORE_BEACH.line],
    ["FAR", SHORE_BEACH.far],
    ["TRAVEL", SHORE_BEACH.travel],
  ] as const)
    expect(shoreSharedGlsl).toContain(`const float SHORE_${name} = ${glslFloat(value)};`);
  expect(shoreSharedGlsl).toContain(`const int SHORE_WAVES = ${SHORE_BEACH.waves};`);
});

test("the sea's mirror flies the gulls the composer flies", () => {
  expect(shoreComposed.preset.flyway).toEqual(SHORE_FLYWAY);
});

test("an agent stacks a cairn, a big sea topples it, the same every run", () => {
  const run = () => {
    const cairns = new ShoreCairns();
    const at: CairnFrame = {
      aspect: ASPECT,
      camX: 0,
      tm: 0,
      dt: 1 / 60,
      period: 8,
      size: 0,
      stones: 5,
    };
    const step = (hand: Partial<PrincipalState>) => {
      at.tm += at.dt;
      const agent = principal({ inside: true, kind: "agent", ...hand });
      cairns.frame([principal({ inside: true }), agent], at);
    };
    step({ x: 0.9, y: 0.9 });
    const first = cairns.interest(ASPECT, 0)[0];
    if (first === undefined) throw new Error("no site to work at");
    const site = { x: first.x, y: first.y };
    // Ten visits, as an agent of the cast acts: a press held 0.45 s, then still for two seconds;
    // they alternate picking a pebble up and setting it on the cairn. Small waves never reach it.
    for (let visit = 0; visit < 10; visit++)
      for (let n = 0; n < 150; n++) step({ ...site, down: n < 27, pressed: n === 0 });
    const built = cairns.standing(0);
    for (let n = 0; n < 60 * 60; n++) step({ x: 0.9, y: 0.9 });
    const calm = cairns.standing(0);
    // The biggest sea runs past it.
    at.size = 1;
    for (let n = 0; n < 60 * 60; n++) step({ x: 0.9, y: 0.9 });
    const data = new Float32Array(CAIRN_ROW * (CAIRN_SITES + 1) * 4);
    cairns.pack(data, CAIRN_ROW);
    return { built, calm, toppled: cairns.standing(0), stones: data[2], data: Array.from(data) };
  };
  const first = run();
  expect(first.built).toBe(5);
  expect(first.calm).toBe(5);
  expect(first.toppled).toBeLessThan(3);
  // Its stones lie round it for the agents to stack again.
  expect(first.stones).toBeGreaterThan(0);
  expect(run()).toEqual(first);
});

test("without agents the cairns' rows stay empty, and the cast is shown where to start one", () => {
  const sim = new HeadlessSim(shoreScene);
  for (let n = 0; n < 120; n++) sim.step();
  const placement = shoreComposed.place(new Set(shoreComposed.preset.layers));
  expect(placement.layers.map((placed) => placed.layer.id)).toEqual(["sea", "beach", "cairns"]);
  // The atlas: the composer's row 0, then the cairns' rows (the only layer on with rows): a row per
  // site, no stone in any, and no pebble carried.
  const atlas = sim.upload(1);
  expect(atlas.width).toBe(ATLAS_WIDTH);
  const texel = (x: number, row: number) => (row * ATLAS_WIDTH + x) * 4;
  for (let s = 0; s < CAIRN_SITES; s++) expect(atlas.data[texel(0, 1 + s) + 2]).toBe(0);
  const carried = atlas.data.slice(texel(0, 1 + CAIRN_SITES), texel(0, 2 + CAIRN_SITES));
  expect(carried.every((value) => value === 0)).toBe(true);
  // A fresh site on the wet sand, below the horizon, for the first agent to go to.
  const [site] = sim.interest(ASPECT);
  expect(site?.y).toBeLessThan(SHORE_BEACH.horizon);
  sim.dispose();
});
