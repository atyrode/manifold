import { describe, expect, test } from "bun:test";
import { effective } from "../../params.ts";
import type { SimFrame } from "../types.ts";
import { kelpScene } from "./index.ts";
import {
  KELP_LAYERS,
  KELP_ORIGIN,
  KELP_POINT_ROW,
  KELP_POINTS,
  KELP_ROW,
  KELP_SEGMENTS,
  KELP_STATE_WIDTH,
  KELP_STIPES,
  KELP_VIEW,
} from "./sim.ts";

/** What the kelp sim last uploaded: its point texture (positions) and its state rows. */
interface Uploads {
  points?: Float32Array;
  state?: Float32Array;
}

/** A WebGL2 stand-in that keeps the float arrays the sim uploads and ignores everything else. */
function recordingGl(uploads: Uploads): WebGL2RenderingContext {
  const keep = (...args: unknown[]): void => {
    const data = args.find((arg): arg is Float32Array => arg instanceof Float32Array);
    if (data?.length === KELP_POINT_ROW * 4) uploads.points = data;
    else if (data?.length === KELP_STATE_WIDTH * 6 * 4) uploads.state = data;
  };
  const stub = new Proxy(
    {},
    {
      get: (_target, key) =>
        key === "texImage2D" || key === "texSubImage2D"
          ? keep
          : typeof key === "string" && /^[A-Z0-9_]+$/.test(key)
            ? 0
            : () => ({}),
    },
  );
  // The sim only creates, binds and fills textures; the stand-in answers every call, so it is a
  // WebGL2 context as far as the sim can tell.
  return stub as unknown as WebGL2RenderingContext;
}

/** The kelp forest with `knobs` over the defaults, run `seconds` at motion 1 with the pointer away. */
function grow(knobs: Record<string, number>, seconds: number): Uploads {
  const uploads: Uploads = {};
  const sim = kelpScene.sim?.(recordingGl(uploads));
  if (!sim) throw new Error("kelp has no sim");
  const params = { ...knobs };
  const values = kelpScene.params.map((def) => effective(def, params));
  for (let k = 0; k < seconds * 60; k++) {
    const frame: SimFrame = {
      dt: 1 / 60,
      time: k / 60,
      motionTime: k / 60,
      motion: 1,
      now: (k * 1000) / 60,
      budget: Infinity,
      width: 960,
      height: 540,
      aspect: 16 / 9,
      values,
      params,
      triggers: new Array<number>(8).fill(-1e4),
      fired: new Array<boolean>(8).fill(false),
      pointer: { x: 0.5, y: 0.5, inside: false, down: false, pressed: false, released: false },
      passage: { enter: 1, exit: 0 },
    };
    sim.frame(frame);
  }
  sim.dispose();
  return uploads;
}

const stateAt = (u: Uploads, row: number, stipe: number, c: number): number =>
  u.state?.[(row * KELP_STATE_WIDTH + stipe) * 4 + c] ?? Number.NaN;
const node = (u: Uploads, stipe: number, j: number): [number, number] => {
  const p = stipe * KELP_POINTS + j;
  return [
    (u.points?.[8 * p] ?? Number.NaN) + KELP_ORIGIN[0],
    (u.points?.[8 * p + 1] ?? Number.NaN) + KELP_ORIGIN[1],
  ];
};

/** For each shown plant of the nearest layer: how far its stipe bows off the chord, over the chord, and its top's height over the water's depth. */
function nearPlants(u: Uploads): { bow: number; top: number }[] {
  const layer = KELP_LAYERS[0];
  if (!layer) throw new Error("no layers");
  const plants: { bow: number; top: number }[] = [];
  for (let stipe = layer.first; stipe < layer.first + layer.slots; stipe++) {
    if (stateAt(u, KELP_ROW.stipes, stipe, 3) < 0.5) continue;
    const s = stateAt(u, KELP_ROW.scale, stipe, 0);
    const [rx, ry] = node(u, stipe, 0);
    const [tx, ty] = node(u, stipe, KELP_SEGMENTS);
    const chord = Math.hypot(tx - rx, ty - ry);
    let bow = 0;
    for (let j = 1; j < KELP_SEGMENTS; j++) {
      const [x, y] = node(u, stipe, j);
      bow = Math.max(bow, Math.abs((x - rx) * (ty - ry) - (y - ry) * (tx - rx)) / chord);
    }
    plants.push({
      bow: bow / chord,
      top:
        (ty - (KELP_VIEW.horizon - KELP_VIEW.floor * s)) /
        ((KELP_VIEW.floor + KELP_VIEW.surface) * s),
    });
  }
  return plants;
}

describe("kelp species", () => {
  test("bull kelp hangs taut under its bulb, short of the surface; giant kelp bows", () => {
    const bull = nearPlants(grow({ species: 1 }, 20));
    const giant = nearPlants(grow({ species: 0 }, 20));
    expect(bull.length).toBeGreaterThan(0);
    for (const plant of bull) {
      expect(plant.bow).toBeLessThan(0.025);
      expect(plant.top).toBeLessThan(0.9);
    }
    expect(Math.max(...giant.map((plant) => plant.bow))).toBeGreaterThan(0.035);
  });

  test("a mixed forest is some of each, and its giant plants grow exactly as in a giant forest", () => {
    const giant = grow({ species: 0, kelpSeed: 5 }, 8);
    const mixed = grow({ species: 2, kelpSeed: 5 }, 8);
    let bulls = 0;
    for (let stipe = 0; stipe < KELP_STIPES; stipe++) {
      expect(stateAt(giant, KELP_ROW.scale, stipe, 1)).toBe(0);
      if (stateAt(mixed, KELP_ROW.scale, stipe, 1) > 0.5) {
        bulls++;
        continue;
      }
      for (let j = 0; j <= KELP_SEGMENTS; j++)
        expect(node(mixed, stipe, j)).toEqual(node(giant, stipe, j));
    }
    expect(bulls / KELP_STIPES).toBeGreaterThan(0.25);
    expect(bulls / KELP_STIPES).toBeLessThan(0.65);
  });
});
