import { afterEach, expect, test } from "bun:test";
import { effective } from "../../params.ts";
import type { SimFrame } from "../types.ts";
import { sandtableScene } from "./index.ts";
import { SANDTABLE } from "./sim.ts";

// The sim sends its machines' state every frame and the heights at most every 1000/30 ms. These
// checks drive it at 60 Hz with a little jitter on a fake clock, through a WebGL stand-in that keeps
// what each texture last received: what the shader would draw from. Knobs are as in the URL.

const realNow = performance.now.bind(performance);
let clock = 0;
afterEach(() => {
  performance.now = realNow;
});

interface Table {
  frame(dt: number, next: boolean): void;
  /** The heights and machine state as last uploaded. */
  heights(): Float32Array | undefined;
  state(): Float32Array;
}

function table(knobs: Record<string, number>): Table {
  const uploads = new Map<object, Float32Array>();
  let bound: object | undefined;
  const gl = new Proxy({} as Record<string, unknown>, {
    get(_target, key: string) {
      if (key === "createTexture") return () => ({});
      if (key === "bindTexture") return (_unit: number, texture: object) => (bound = texture);
      if (key === "texSubImage2D") return (...args: unknown[]) => bound && uploads.set(bound, Float32Array.from(args[8] as Float32Array));
      if (/^[A-Z0-9_]+$/.test(key)) return 1;
      return () => undefined;
    },
  }) as unknown as WebGL2RenderingContext;
  const values = sandtableScene.params.map((p) => effective(p, knobs));
  const sim = sandtableScene.sim?.(gl);
  if (!sim) throw new Error("sandtable has no sim");
  let textures: readonly (WebGLTexture | undefined)[] = [];
  const fired = [false, false];
  const frame = (dt: number, next: boolean): void => {
    fired[0] = next;
    const f: SimFrame = {
      dt,
      time: 0,
      motionTime: 0,
      motion: 1,
      width: 960,
      height: 540,
      aspect: 16 / 9,
      values,
      params: {},
      triggers: [],
      fired,
      pointer: { x: 0.5, y: 0.5, inside: false, down: false, pressed: false, released: false },
      parallax: { x: 0, y: 0 },
      passage: { enter: 1, exit: 0 },
    };
    textures = sim.frame(f);
  };
  return {
    frame,
    heights: () => (textures[0] ? uploads.get(textures[0] as object) : undefined),
    state: () => (textures[1] ? uploads.get(textures[1] as object) : undefined) ?? new Float32Array(12),
  };
}

/** Run `seconds` of 60 Hz frames with ±0.3 ms jitter, calling `each` after every frame. */
function play(tables: readonly { table: Table; offset: number }[], seconds: number, next: (frame: number) => boolean, each: () => void): void {
  let seed = 7;
  clock = 1000;
  for (let n = 0; n < seconds * 60; n++) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    const ms = 1000 / 60 + (seed / 4294967296 - 0.5) * 0.6;
    clock += ms;
    for (const { table, offset } of tables) {
      performance.now = () => clock + offset * n;
      table.frame(ms / 1000, next(n));
    }
    each();
  }
}

test("a fast ball never runs ahead of the groove the shader shows: its head stays under the ball", () => {
  // Erase spirals only (twice the drawings' pace) at the fastest drawing speed: after the opening
  // drawing and its rest the ball ploughs at some 0.88 field units a second.
  const ball = table({ speed: 4, pattern: 1 });
  let shownAt: [number, number] | undefined;
  let shown: Float32Array | undefined;
  let worst = 0;
  let moving = 0;
  let last: [number, number] | undefined;
  play([{ table: ball, offset: 0 }], 75, () => false, () => {
    const s = ball.state();
    const at: [number, number] = [s[0] ?? 0, s[1] ?? 0];
    const heights = ball.heights();
    if (heights !== shown) {
      shown = heights;
      shownAt = at;
    }
    if (last && Math.hypot(at[0] - last[0], at[1] - last[1]) > 0.01) moving++;
    last = at;
    if (shownAt) worst = Math.max(worst, Math.hypot(at[0] - shownAt[0], at[1] - shownAt[1]));
  });
  expect(moving).toBeGreaterThan(60 * 20);
  expect(worst).toBeLessThan(0.5 * SANDTABLE.ball);
});

test("a fast wipe's edge and the funnel's stream never run ahead of the sand the shader shows", () => {
  // "Next drawing" at once: the straight edge wipes the slate at the fastest speed, then the funnel
  // is swung and pours. A twin whose clock leaps a second a frame sends every change: the live sand.
  const shownTable = table({ machine: 1, speed: 4 });
  const liveTable = table({ machine: 1, speed: 4 });
  const depth = SANDTABLE.depthMin + SANDTABLE.depthRange * 0.5;
  const n = SANDTABLE.grid;
  let edgeFrames = 0;
  let edgeWorst = 0;
  let streamFrames = 0;
  let streamWorst = 0;
  let shownAt: [number, number] | undefined;
  let shown: Float32Array | undefined;
  play([{ table: shownTable, offset: 0 }, { table: liveTable, offset: 1000 }], 15, (frame) => frame === 1, () => {
    const s = shownTable.state();
    const heights = shownTable.heights();
    const live = liveTable.heights();
    if (!heights || !live) return;
    if (heights !== shown) {
      shown = heights;
      shownAt = [s[0] ?? 0, s[1] ?? 0];
    }
    // The bar, while it is out: the sand within a bar's width of it either side, shown against live.
    if ((s[7] ?? 0) > 0.5) {
      edgeFrames++;
      const nx = s[4] ?? 1;
      const ny = s[5] ?? 0;
      const middle = (s[6] ?? 0) + 0.5 * SANDTABLE.edge;
      for (let k = 0; k < n * n; k++) {
        const x = ((k % n) + 0.5) / n - 0.5;
        const y = (Math.floor(k / n) + 0.5) / n - 0.5;
        if (Math.abs(x * nx + y * ny - middle) <= SANDTABLE.edge) edgeWorst = Math.max(edgeWorst, Math.abs((heights[k] ?? 0) - (live[k] ?? 0)));
      }
    }
    // The stream, while it pours: how far the funnel has got from where the shown line ends.
    if ((s[3] ?? 0) > 0 && shownAt) {
      streamFrames++;
      streamWorst = Math.max(streamWorst, Math.hypot((s[0] ?? 0) - shownAt[0], (s[1] ?? 0) - shownAt[1]));
    }
  });
  expect(edgeFrames).toBeGreaterThan(60);
  expect(edgeWorst).toBeLessThan(0.25 * depth);
  expect(streamFrames).toBeGreaterThan(60);
  expect(streamWorst).toBeLessThan(0.5 * SANDTABLE.ball);
});
