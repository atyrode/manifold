import { describe, expect, test } from "bun:test";
import { LevelCamera } from "../sims/camera.ts";
import {
  FALL_CODE,
  FALL_STEP,
  FallingPool,
  fallingGlsl,
  type FallFrame,
  type FallView,
} from "./falling.ts";
import { NO_PASSAGE_GUST, type GustField } from "./gust.ts";
import type { FallSurface, FallingWater } from "./types.ts";

const RIG = new LevelCamera({ horizon: 0.4, eye: 1.5, focal: 1.2 });
const VIEW: FallView = {
  rig: RIG,
  lift: 0,
  shift: 0,
  width: 960,
  height: 540,
  parallaxX: 0,
  parallaxY: 0,
};
const STILL: GustField = {
  wind: 0,
  gusts: 0,
  rate: 0.5,
  nowAge: -1,
  slot: 0,
  pass: NO_PASSAGE_GUST,
  shape: undefined,
};
/** A ledge 2 m off, 0.5 m up, under the drip points (x -0.5..0.5). */
const LEDGE: FallSurface = { kind: "ledge", y: 0.5, from: [-0.5, 2], to: [0.5, 2], depth: 0.4 };

interface Plotted {
  code: number;
  cx: number;
  cy: number;
  depth: number;
}

/** A plot that keeps what was plotted this frame. */
function recorder(): {
  plot: (cx: number, cy: number, code: number, depth: number) => void;
  cells: Plotted[];
} {
  const cells: Plotted[] = [];
  return { cells, plot: (cx, cy, code, depth) => cells.push({ code, cx, cy, depth }) };
}

function frame(over: Partial<FallFrame> = {}): FallFrame {
  return {
    dt: FALL_STEP,
    motion: 1,
    motionTime: 0,
    seed: 0.3,
    rain: 0.7,
    wet: 1,
    gusts: STILL,
    ...over,
  };
}

/** A pool with `lanes` drip points over the ledge, run `seconds` at `rate` frames a second. */
function run(
  seconds: number,
  rate: number,
  over: Partial<FallFrame> = {},
  surfaces: readonly FallSurface[] = [LEDGE],
  host: (layer: string) => object | undefined = () => undefined,
): { pool: FallingPool; cells: Plotted[] } {
  const pool = new FallingPool(host);
  const frames = Math.round(seconds * rate);
  let painted = recorder();
  for (let f = 0; f < frames; f++) {
    pool.begin();
    for (let lane = 0; lane < 8; lane++) pool.drip(lane, -0.4 + 0.1 * lane, 1.2, 2, 0, 0);
    for (const surface of surfaces) pool.surface(surface);
    pool.step(frame({ ...over, dt: 1 / rate, motionTime: (f + 1) / rate }));
    painted = recorder();
    pool.paint(painted, VIEW);
  }
  return { pool, cells: painted.cells };
}

describe("the falling things", () => {
  test("drip from the points in rain, fall, splash on the ledge and wet it", () => {
    const seen = new Set<number>();
    const pool = new FallingPool(() => undefined);
    for (let f = 0; f < 60 * 8; f++) {
      pool.begin();
      for (let lane = 0; lane < 8; lane++) pool.drip(lane, -0.4 + 0.1 * lane, 1.2, 2, 0, 0);
      pool.surface(LEDGE);
      pool.step(frame({ motionTime: f / 60 }));
      const r = recorder();
      pool.paint(r, VIEW);
      for (const cell of r.cells) seen.add(cell.code);
    }
    for (const code of Object.values(FALL_CODE)) expect(seen.has(code), `code ${code}`).toBe(true);
    // Drawn at the ledge's depth, 2 m off (SPECK_DEPTH_STEP 4 a metre): the marks a step nearer.
    const { cells } = run(4, 60);
    const marks = cells.filter((cell) => cell.code >= FALL_CODE.wet);
    expect(marks.length).toBeGreaterThan(0);
    for (const mark of marks) expect(mark.depth).toBe(7);
    // On the ledge's line on the screen: 0.5 m up, 2 m off.
    const ledgeRow = Math.floor(RIG.screenY(0.5, 2) * VIEW.height);
    for (const mark of marks) expect(mark.cy).toBe(ledgeRow);
  });

  test("drip nothing while the world is dry, and stop as it dries", () => {
    expect(run(4, 60, { rain: 0, wet: 0 }).pool.live).toBe(0);
    expect(run(4, 60, { rain: 0, wet: 0 }).cells).toEqual([]);
    expect(run(4, 60, { rain: 0, wet: 0.5 }).pool.live).toBeGreaterThan(0);
  });

  test("never run a drop backward as the rain eases and the world dries", () => {
    // One lane: a drop falls 0.7 m in well under a beat, so at most one is in the air at once.
    const pool = new FallingPool(() => undefined);
    let last = Number.NaN;
    let falls = 0;
    for (let f = 0; f < 60 * 60; f++) {
      const s = f / 60;
      pool.begin();
      pool.drip(0, 0, 1.2, 2, 0, 0);
      pool.surface(LEDGE);
      pool.step(frame({ motionTime: s, rain: Math.max(0, 1 - s / 20), wet: Math.exp(-s / 25) }));
      const r = recorder();
      pool.paint(r, VIEW);
      const head = r.cells.find((cell) => cell.code === FALL_CODE.drop);
      if (head === undefined) {
        last = Number.NaN;
        continue;
      }
      if (Number.isNaN(last)) falls++;
      else expect(head.cy).toBeLessThanOrEqual(last);
      last = head.cy;
    }
    expect(falls).toBeGreaterThan(5);
  });

  test("play a seed the same at 60 and 144 frames a second", () => {
    const windy = { gusts: { ...STILL, wind: 0.6 } };
    const slow = run(3, 60, windy).cells;
    const fast = run(3, 144, windy).cells;
    expect(slow.length).toBeGreaterThan(0);
    expect(fast).toEqual(slow);
  });

  test("carry the drops downwind", () => {
    const meanX = (cells: readonly Plotted[]): number => {
      const drops = cells.filter((cell) => cell.code === FALL_CODE.splash);
      return drops.reduce((sum, cell) => sum + cell.cx, 0) / Math.max(1, drops.length);
    };
    const still = run(6, 60, {}, [{ kind: "plane", y: -0.5 }]).cells;
    const windy = run(6, 60, { gusts: { ...STILL, wind: 1, gusts: 1 } }, [
      { kind: "plane", y: -0.5 },
    ]).cells;
    expect(meanX(windy)).toBeGreaterThan(meanX(still));
  });

  test("strike the water layer's sim where they land on water", () => {
    const strikes: number[][] = [];
    const water: FallingWater = {
      strike: (x, z, mass, speed) => strikes.push([x, z, mass, speed]),
    };
    const surface: FallSurface = { kind: "water", y: 0, x: [-1, 1], z: [1, 3], strikes: "pond" };
    run(4, 60, {}, [surface], (layer) => (layer === "pond" ? water : undefined));
    expect(strikes.length).toBeGreaterThan(0);
    for (const [x = 0, z = 0, mass = 0, speed = 0] of strikes) {
      expect(Math.abs(x)).toBeLessThan(1);
      expect(z).toBeCloseTo(2, 1);
      expect(mass).toBeGreaterThan(0);
      expect(speed).toBeGreaterThan(3);
    }
  });

  test("colour only the kinds on", () => {
    expect(fallingGlsl(["drop"])).toContain("x.air.drop");
    expect(fallingGlsl([])).not.toContain("x.air.drop");
  });
});
