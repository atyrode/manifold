import { expect, test } from "bun:test";
import { HeadlessSim, type HeadlessFrame } from "../../sims/headless.ts";
import { loadScene } from "../index.ts";
import type { PrincipalState } from "../types.ts";
import { HARMONOGRAPH, harmonographScale } from "./sim.ts";

const harmonographScene = await loadScene("harmonograph");

/** HeadlessSim's frame aspect, and the ink texture's texels per p unit (sim.ts's TEXELS). */
const ASPECT = 16 / 9;
const TEXELS = HARMONOGRAPH.grid / (2 * HARMONOGRAPH.half);

/** Screen uv of sheet point (x, y), p units, the sheet lying in place (its slight tilt left out). */
function uvOf(x: number, y: number): { x: number; y: number } {
  const k = harmonographScale(ASPECT);
  return { x: (x * k) / ASPECT + 0.5, y: y * k + 0.5 };
}

/** The figure's ink summed over the texels within `half` p units either way of sheet point (x, y). */
function inkNear(data: ArrayLike<number>, x: number, y: number, half: number): number {
  const size = HARMONOGRAPH.grid;
  const cx = Math.round(x * TEXELS + size / 2);
  const cy = Math.round(y * TEXELS + size / 2);
  const r = Math.round(half * TEXELS);
  let sum = 0;
  for (let j = cy - r; j <= cy + r; j++)
    for (let i = cx - r; i <= cx + r; i++) sum += data[(j * size + i) * 2] ?? 0;
  return sum;
}

/** An agent standing still at `at`, its button as given. */
function agent(
  at: { x: number; y: number },
  down: boolean,
  pressed = false,
  released = false,
): Partial<PrincipalState> {
  return { ...at, vx: 0, vy: 0, down, pressed, released };
}

function differing(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let n = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) n++;
  return n;
}

test("an agent's tap lets a small plotter go there: it draws, its swing dies, and the table rests", () => {
  const sim = new HeadlessSim(harmonographScene);
  // A short drawing that ends and stays on the desk: no next sheet, no rotary pendulum, quick swing.
  const base: HeadlessFrame = {
    dt: 0.1,
    knobs: { renew: 0, rotary: 0, lasting: 0, swing: 1.5 },
    pointer: { inside: false },
  };
  /** Frames until the ink has gone two seconds unchanged (Infinity if not within `most`). */
  const settle = (most: number, extra: HeadlessFrame = {}): number => {
    let still = 0;
    let was = sim.step({ ...base, ...extra }).upload(0).data;
    for (let f = 1; f <= most; f++) {
      const data = sim.step({ ...base, ...extra }).upload(0).data;
      still = data === was ? still + 1 : 0;
      was = data;
      if (still >= 20) return f;
    }
    return Number.POSITIVE_INFINITY;
  };
  // The sheet's own figure dies away and the pen rests (measured: some 410 frames).
  expect(settle(3000)).toBeLessThan(3000);

  const open = uvOf(-0.28, 0.28);
  const before = Uint8Array.from(sim.upload(0).data);
  sim.step({ ...base, agents: [agent(open, false)] });
  sim.step({ ...base, agents: [agent(open, true, true)] });
  sim.step({ ...base, agents: [agent(open, true)] });
  sim.step({ ...base, agents: [agent(open, false, false, true)] });
  for (let f = 0; f < 30; f++) sim.step({ ...base, agents: [agent(open, false)] });
  const drawn = Uint8Array.from(sim.upload(0).data);
  // Three seconds on, a small figure where it tapped (measured: over five times the ink there)...
  expect(inkNear(drawn, -0.28, 0.28, 0.09)).toBeGreaterThan(2 * inkNear(before, -0.28, 0.28, 0.09));
  // ...and nothing new across the sheet, whose ink only fades while it is shared.
  expect(inkNear(drawn, 0.28, -0.28, 0.09)).toBeLessThan(inkNear(before, 0.28, -0.28, 0.09));

  // The plotter's swing dies, the sheet goes unworked for SHARE_LINGER, and the ink holds still
  // again with the agent still there (measured: some 520 frames).
  expect(settle(1500, { agents: [agent(open, false)] })).toBeLessThan(1500);
  sim.dispose();
});

test("the shared table is the same every time, every hand draws on it, and a hover leaves no mark", () => {
  const plotter = uvOf(0.31, 0);
  /** 400 frames of the sheet: an agent taps at the right margin, the visitor drags across it. */
  const run = (hands: "both" | "hover" | "none"): Uint8Array => {
    const sim = new HeadlessSim(harmonographScene);
    for (let f = 0; f < 400; f++) {
      const dragging = hands === "both" && f >= 60 && f <= 180;
      const pointer: Partial<PrincipalState> =
        hands === "none"
          ? { inside: false }
          : {
              x: 0.35 + 0.002 * (f - 60),
              y: 0.62 + 0.0008 * (f - 60),
              down: dragging && f < 180,
              pressed: dragging && f === 60,
              released: dragging && f === 180,
            };
      const agents =
        hands === "both" ? [agent(plotter, f >= 30 && f < 40, f === 30, f === 40)] : [];
      sim.step({ pointer, agents });
    }
    const ink = Uint8Array.from(sim.upload(0).data);
    sim.dispose();
    return ink;
  };
  const shared = run("both");
  expect(differing(run("both"), shared)).toBe(0);
  const alone = run("none");
  expect(differing(shared, alone)).toBeGreaterThan(0);
  expect(differing(run("hover"), alone)).toBe(0);
});
