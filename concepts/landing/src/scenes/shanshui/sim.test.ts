import { expect, test } from "bun:test";
import { HeadlessSim } from "../../sims/headless.ts";
import { toHalf } from "../../sims/half.ts";
import { SHANSHUI_SECTION, SHANSHUI_SECTIONS } from "./shader.ts";
import { shanshuiScene } from "./index.ts";

// Texel 0: the scroll within its section as k * 32 + (hi + lo) / 64; texel 1's alpha: the section.
const scrollAsUploaded = (state: ArrayLike<number>): number => (state[0] ?? 0) * 32 + ((state[1] ?? 0) + (state[2] ?? 0)) / 64;
const scrollAsSampled = (state: ArrayLike<number>): number => toHalf(state[0] ?? 0) * 32 + (toHalf(state[1] ?? 0) + toHalf(state[2] ?? 0)) / 64;

const fastest = { speed: 1 };
/** Screen heights a frame of `dt` seconds unrolls at the fastest speed, measured on the sim itself. */
function pace(): number {
  const sim = new HeadlessSim(shanshuiScene);
  sim.step({ knobs: fastest });
  const a = scrollAsUploaded(sim.step({ knobs: fastest, dt: 1 }).upload(0).data);
  const b = scrollAsUploaded(sim.step({ knobs: fastest, dt: 1 }).upload(0).data);
  return b - a;
}

test("weeks of unrolling hand the shader a scroll position it can still resolve", () => {
  const sim = new HeadlessSim(shanshuiScene);
  // Three weeks at the fastest speed, an hour a frame.
  for (let hour = 0; hour < 21 * 24; hour++) {
    const state = sim.step({ knobs: fastest, dt: 3600 }).upload(0).data;
    const k = state[0] ?? 0;
    // Half floats hold whole numbers exactly only up to 2048.
    expect(toHalf(k)).toBe(k);
    const scroll = scrollAsSampled(state);
    expect(scroll).toBeGreaterThanOrEqual(0);
    // float32 resolves a quarter of a 1080-row cell (2.3e-4 heights) only below ~2000 heights.
    expect(scroll).toBeLessThan(SHANSHUI_SECTION + 1);
  }
});

test("a new section takes over without moving the painting on screen", () => {
  const perSecond = pace();
  const sim = new HeadlessSim(shanshuiScene);
  sim.step({ knobs: fastest });
  // Just short of the first section's end, then a frame across it.
  const before = sim.step({ knobs: fastest, dt: (SHANSHUI_SECTION - 1e-3) / perSecond }).upload(0).data;
  expect(before[7]).toBe(0);
  const scrollBefore = scrollAsUploaded(before);
  const after = sim.step({ knobs: fastest, dt: 2e-3 / perSecond }).upload(0).data;
  // Joined on to section 0, now in section 1.
  expect(after[7]).toBe(SHANSHUI_SECTIONS + 1);
  // Beyond the join the shader paints the section before at scroll + SHANSHUI_SECTION: it must
  // have moved on by just the frame's own unrolling.
  expect(scrollAsUploaded(after) + SHANSHUI_SECTION - scrollBefore).toBeCloseTo(2e-3, 5);
});
