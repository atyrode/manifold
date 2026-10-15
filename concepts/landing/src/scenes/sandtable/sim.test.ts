import { afterEach, expect, test } from "bun:test";
import { HeadlessSim } from "../../sims/headless.ts";
import { sandtableScene } from "./index.ts";
import { SANDTABLE } from "./sim.ts";

// The sim sends its machines' state every frame and the heights at most every 1000/30 ms. These
// checks drive it at 60 Hz with a little jitter on a fake clock, on the headless stand-in, which
// keeps what each texture last received: what the shader would draw from. Knobs are as in the URL.

const realNow = performance.now.bind(performance);
let clock = 0;
afterEach(() => {
  performance.now = realNow;
});

interface Table {
  frame(dt: number, next: boolean): void;
  /** The heights and machine state as last uploaded (the heights the same array until re-sent). */
  heights(): Float32Array | Uint8Array;
  state(): Float32Array | Uint8Array;
}

function table(knobs: Record<string, number>): Table {
  const sim = new HeadlessSim(sandtableScene);
  return {
    frame: (dt, next) => {
      sim.step({ dt, knobs, now: next ? ["renew"] : [], pointer: { inside: false } });
    },
    heights: () => sim.upload(0).data,
    state: () => sim.upload(1).data,
  };
}

/** Run `seconds` of 60 Hz frames with ±0.3 ms jitter, calling `each` after every frame. */
function play(
  tables: readonly { table: Table; offset: number }[],
  seconds: number,
  next: (frame: number) => boolean,
  each: () => void,
): void {
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
  let shown: Float32Array | Uint8Array | undefined;
  let worst = 0;
  let moving = 0;
  let last: [number, number] | undefined;
  play(
    [{ table: ball, offset: 0 }],
    75,
    () => false,
    () => {
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
    },
  );
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
  let shown: Float32Array | Uint8Array | undefined;
  play(
    [
      { table: shownTable, offset: 0 },
      { table: liveTable, offset: 1000 },
    ],
    15,
    (frame) => frame === 1,
    () => {
      const s = shownTable.state();
      const heights = shownTable.heights();
      const live = liveTable.heights();
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
          if (Math.abs(x * nx + y * ny - middle) <= SANDTABLE.edge)
            edgeWorst = Math.max(edgeWorst, Math.abs((heights[k] ?? 0) - (live[k] ?? 0)));
        }
      }
      // The stream, while it pours: how far the funnel has got from where the shown line ends.
      if ((s[3] ?? 0) > 0 && shownAt) {
        streamFrames++;
        streamWorst = Math.max(
          streamWorst,
          Math.hypot((s[0] ?? 0) - shownAt[0], (s[1] ?? 0) - shownAt[1]),
        );
      }
    },
  );
  expect(edgeFrames).toBeGreaterThan(60);
  expect(edgeWorst).toBeLessThan(0.25 * depth);
  expect(streamFrames).toBeGreaterThan(60);
  expect(streamWorst).toBeLessThan(0.5 * SANDTABLE.ball);
});
