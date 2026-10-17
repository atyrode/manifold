import { expect, test } from "bun:test";
import { principal } from "../../principals.ts";
import { HeadlessSim } from "../../sims/headless.ts";
import { glslFloat } from "../../shaders/glsl.ts";
import { SHORE_BEACH } from "./beach.ts";
import { ShoreCairns, type CairnFrame } from "./cairns.ts";
import { loadScene } from "../index.ts";
import { shoreGlsl } from "./shader.ts";
import type { PrincipalState } from "../types.ts";

const shoreScene = await loadScene("shore");

const ASPECT = 16 / 9;

test("the beach the cairns' surf is mirrored from is the shader's", () => {
  for (const [name, value] of [
    ["HORIZON", SHORE_BEACH.horizon],
    ["FOV", SHORE_BEACH.fov],
    ["EYE", SHORE_BEACH.eye],
    ["LINE", SHORE_BEACH.line],
    ["TRAVEL", SHORE_BEACH.travel],
  ] as const)
    expect(shoreGlsl).toContain(`const float SHORE_${name} = ${glslFloat(value)};`);
  expect(shoreGlsl).toContain(`const int SHORE_WAVES = ${SHORE_BEACH.waves};`);
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
    const data = new Float32Array(15 * 5 * 4);
    cairns.pack(data);
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

test("without agents the shore sends no cairns", () => {
  const sim = new HeadlessSim(shoreScene);
  for (let n = 0; n < 120; n++) expect(sim.frame().length).toBe(1);
  sim.dispose();
});
