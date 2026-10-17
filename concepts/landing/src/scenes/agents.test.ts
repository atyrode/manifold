// Every principal's hand acts in a scene, not only the visitor's: each sim that answers the cast's
// agents (src/principals.ts) is run headless with the visitor off the page and one scripted agent,
// and must hand over other textures than it does with nobody there. The GPU sims (delta, petri,
// physarum, the tide pool's water) cannot run on a HeadlessGl; the tide pool's life, on the CPU, is
// run here on its own.
import { describe, expect, test } from "bun:test";
import { principal, visitorAlone } from "../principals.ts";
import { HeadlessGl, HeadlessSim } from "../sims/headless.ts";
import { PLANT_SUMMER } from "../sims/plants.ts";
import { loadScene, type SceneId } from "./index.ts";
import { layTidepool } from "./tidepool/layout.ts";
import { TidepoolLife } from "./tidepool/life.ts";
import type { PrincipalState } from "./types.ts";

/** A place in the frame, uv. */
interface At {
  readonly x: number;
  readonly y: number;
}

/**
 * What the agent does: comes after IDLE frames, taps (presses, holds a moment, lets go) at each of
 * `taps` in turn, then drags from `drag[0]` to `drag[1]` over DRAG frames, and rests where it ended
 * for REST frames. The points are where the scene answers a hand: its points of interest, its water,
 * its plate, its gravel.
 */
interface Script {
  readonly taps: readonly At[];
  readonly drag?: readonly [At, At];
}

const IDLE = 10;
const TAP = 8;
const DRAG = 40;
const REST = 60;

const SCRIPTS: readonly (readonly [SceneId, Script])[] = [
  // A press in the grove sends a gust, one on the basin rings it; the stems are brushed aside.
  [
    "bamboo",
    {
      taps: [
        { x: 0.24, y: 0.56 },
        { x: 0.909, y: 0.075 },
      ],
      drag: [
        { x: 0.2, y: 0.5 },
        { x: 0.6, y: 0.5 },
      ],
    },
  ],
  // A press prunes; a hand passing through stirs the pads.
  [
    "bonsai",
    {
      taps: [
        { x: 0.454, y: 0.531 },
        { x: 0.66, y: 0.625 },
      ],
      drag: [
        { x: 0.3, y: 0.6 },
        { x: 0.7, y: 0.62 },
      ],
    },
  ],
  // A press on the bar calls the bartender over; a hand past the candle bends its flame.
  [
    "bar",
    {
      taps: [
        { x: 0.5, y: 0.53 },
        { x: 0.642, y: 0.53 },
      ],
      drag: [
        { x: 0.6, y: 0.3 },
        { x: 0.8, y: 0.32 },
      ],
    },
  ],
  // A press pours a pinch of sand, a drag a trail.
  ["chladni", { taps: [{ x: 0.377, y: 0.693 }] }],
  // A press plucks the web, a drag strums it.
  [
    "dew",
    {
      taps: [
        { x: 0.689, y: 0.723 },
        { x: 0.471, y: 0.397 },
      ],
    },
  ],
  // A drag on the gravel rakes it.
  [
    "garden",
    {
      taps: [],
      drag: [
        { x: 0.3, y: 0.2 },
        { x: 0.7, y: 0.25 },
      ],
    },
  ],
  // A tap knocks cracks into the ice.
  ["lake", { taps: [{ x: 0.24, y: 0.2 }] }],
  // A press sets a lantern down on the water.
  ["lanterns", { taps: [{ x: 0.3, y: 0.22 }] }],
  // A tap drops ink: someone is at the tray, and the marbling waits for them.
  [
    "marble",
    {
      taps: [
        { x: 0.5, y: 0.4 },
        { x: 0.32, y: 0.62 },
      ],
    },
  ],
  // A press blows on the planet under it (where the balls hang in these frames).
  [
    "mobile",
    {
      taps: [
        { x: 0.742, y: 0.389 },
        { x: 0.466, y: 0.675 },
        { x: 0.575, y: 0.739 },
        { x: 0.71, y: 0.598 },
      ],
    },
  ],
  // A hand pointing at the crossing turns walkers' heads up to the window.
  [
    "street",
    {
      taps: [],
      drag: [
        { x: 0.45, y: 0.3 },
        { x: 0.55, y: 0.32 },
      ],
    },
  ],
];

/** The agent's hand on frame `f` of `script`; undefined before it comes. */
function hand(script: Script, f: number): Partial<PrincipalState> | undefined {
  if (f < IDLE) return undefined;
  const g = f - IDLE;
  if (g < script.taps.length * TAP) {
    const at = script.taps[Math.floor(g / TAP)] ?? { x: 0.5, y: 0.5 };
    const k = g % TAP;
    return { ...at, down: k >= 2 && k < 5, pressed: k === 2, released: k === 5 };
  }
  const d = g - script.taps.length * TAP;
  const [from, to] = script.drag ?? [];
  if (from === undefined || to === undefined) return { x: 0.5, y: 0.5 };
  if (d < DRAG) {
    const s = d / (DRAG - 1);
    const x = from.x + (to.x - from.x) * s;
    const y = from.y + (to.y - from.y) * s;
    return { x, y, down: true, pressed: d === 0 };
  }
  return { ...to, down: false, released: d === DRAG };
}

/** Every texture the sim hands over after the script, with the agent or without it. */
async function run(id: SceneId, script: Script, agent: boolean): Promise<ArrayLike<number>[]> {
  const sim = new HeadlessSim(await loadScene(id));
  const frames = IDLE + script.taps.length * TAP + (script.drag ? DRAG : 0) + REST;
  for (let f = 0; f < frames; f++) {
    const at = agent ? hand(script, f) : undefined;
    sim.step({ pointer: { inside: false }, agents: at ? [at] : [] });
  }
  const textures: ArrayLike<number>[] = [];
  for (let slot = 0; slot < 4; slot++)
    if (sim.uploaded(slot)) textures.push(sim.upload(slot).data.slice());
  sim.dispose();
  return textures;
}

/** Values that differ between two sets of textures (all of them when the sets differ in shape). */
function differing(a: readonly ArrayLike<number>[], b: readonly ArrayLike<number>[]): number {
  let n = 0;
  for (let slot = 0; slot < Math.max(a.length, b.length); slot++) {
    const x = a[slot];
    const y = b[slot];
    if (x === undefined || y === undefined || x.length !== y.length)
      return Number.POSITIVE_INFINITY;
    for (let i = 0; i < x.length; i++) if (!Object.is(x[i], y[i])) n++;
  }
  return n;
}

describe("a scripted agent's hand acts in the scene", () => {
  for (const [id, script] of SCRIPTS)
    test(id, async () => {
      const without = await run(id, script, false);
      // Nobody there twice over: the same, so whatever differs below is the agent's doing.
      expect(differing(await run(id, script, false), without)).toBe(0);
      expect(differing(await run(id, script, true), without)).toBeGreaterThan(0);
    });

  test("tidepool: a press by any principal startles the fish", () => {
    const fish = (press: boolean): ArrayLike<number> => {
      const headless = new HeadlessGl();
      const life = new TidepoolLife(headless.gl);
      const layout = layTidepool(356, 200, 0, 0.5, 0);
      life.relay(layout, 0);
      const { pointer } = visitorAlone();
      const agent = principal({
        kind: "agent",
        inside: true,
        x: layout.pool.x / (356 / 200),
        y: layout.pool.y,
      });
      const knobs = { response: 1, fish: 6, season: PLANT_SUMMER, growth: 1 };
      for (let f = 0; f < 120; f++) {
        agent.pressed = press && f === 30;
        agent.down = press && f >= 30 && f < 35;
        life.step(1 / 60, f / 60, knobs, [pointer, agent]);
      }
      const data = headless.upload(life.texture).data.slice();
      life.dispose();
      return data;
    };
    expect(differing([fish(true)], [fish(false)])).toBeGreaterThan(0);
  });
});
