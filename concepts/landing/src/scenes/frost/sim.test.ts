import { expect, test } from "bun:test";
import { HeadlessSim, type HeadlessUpload } from "../../sims/headless.ts";
import { loadScene } from "../index.ts";

const frostScene = await loadScene("frost");

// uSim0 (sim.ts) is the crystal field over the glass, `height` texels to the frame height, rows
// bottom to top; a texel's g is its signed distance across the nearest branch, in frame heights.
// These run the sim on the headless stand-in, the pointer off the glass, and read the field there.

/** Half a dither cell at the headless frame's 540 cells high, in frame heights. */
const HALF_CELL = 0.5 / 540;
const WIDE = (16 / 9) * 1.02;

/** The field on show once the first frames have grown the default pane's full field. */
function grownPane(sim: HeadlessSim): HeadlessUpload {
  for (let f = 0; f < 120; f++) sim.step({ pointer: { inside: false } });
  return sim.upload(0);
}

/** Steps at `aspect` until the field on show is a new one, as wide as the frame; at most `frames`. */
function regrown(sim: HeadlessSim, aspect: number, frames: number): HeadlessUpload {
  const from = sim.upload(0);
  for (let f = 0; f < frames; f++) {
    const field = sim.step({ aspect, pointer: { inside: false } }).upload(0);
    if (field.data !== from.data && field.width !== from.width) return field;
  }
  throw new Error(`no field regrown for aspect ${aspect} in ${frames} frames`);
}

/** g at (x, y) frame heights from the glass's bottom left, linearly between texel centres. */
function across({ width, height, data }: HeadlessUpload, x: number, y: number): number {
  const u = Math.min(width - 1, Math.max(0, x * height - 0.5));
  const v = Math.min(height - 1, Math.max(0, y * height - 0.5));
  const i = Math.min(width - 2, Math.floor(u));
  const j = Math.min(height - 2, Math.floor(v));
  const fu = u - i;
  const fv = v - j;
  const g = (a: number, b: number): number => data[(b * width + a) * 4 + 1] ?? 0;
  return (
    (g(i, j) * (1 - fu) + g(i + 1, j) * fu) * (1 - fv) +
    (g(i, j + 1) * (1 - fu) + g(i + 1, j + 1) * fu) * fv
  );
}

/**
 * The share of `a`'s branch points (texels whose centre lies within half a texel of a branch) that
 * `b` still has within half a cell: the same branch, measured at the same place counted in from the
 * pane's left edge or from its right edge, whichever the branch grew from.
 */
function kept(a: HeadlessUpload, b: HeadlessUpload): number {
  const widen = b.width / b.height - a.width / a.height;
  let points = 0;
  let stayed = 0;
  for (let j = 0; j < a.height; j++) {
    for (let i = 0; i < a.width; i++) {
      const g = a.data[(j * a.width + i) * 4 + 1] ?? 1;
      if (Math.abs(g) >= 0.5 / a.height) continue;
      points++;
      const x = (i + 0.5) / a.height;
      const y = (j + 0.5) / a.height;
      if (
        Math.abs(across(b, x, y) - g) < HALF_CELL ||
        Math.abs(across(b, x + widen, y) - g) < HALF_CELL
      )
        stayed++;
    }
  }
  expect(points).toBeGreaterThan(1000);
  return stayed / points;
}

test("a window 2% wider or narrower keeps its frost: the branches stay where they grew", () => {
  for (const aspect of [WIDE, (16 / 9) * 0.98]) {
    const sim = new HeadlessSim(frostScene);
    const before = grownPane(sim);
    const after = regrown(sim, aspect, 200);
    expect(kept(before, after)).toBeGreaterThan(0.8);
    sim.dispose();
  }
});

test("another pattern is another pane: the same test finds next to none of its branches", () => {
  const sim = new HeadlessSim(frostScene);
  const before = grownPane(sim);
  const other = new HeadlessSim(frostScene);
  for (let f = 0; f < 120; f++) other.step({ knobs: { pattern: 1 }, pointer: { inside: false } });
  expect(kept(before, other.upload(0))).toBeLessThan(0.2);
  sim.dispose();
  other.dispose();
});

test("a window edge being dragged leaves the pane as it is until the drag rests, then regrows it once", () => {
  const sim = new HeadlessSim(frostScene);
  const before = grownPane(sim);
  // A drag: the frame a little wider every frame for a second; the field on show stays as it was.
  for (let f = 1; f <= 60; f++) {
    const aspect = (16 / 9) * (1 + f / 3000);
    expect(sim.step({ aspect, pointer: { inside: false } }).upload(0).data).toBe(before.data);
  }
  const after = regrown(sim, WIDE, 200);
  // Held still at its new shape, the pane does not grow again.
  for (let f = 0; f < 120; f++)
    expect(sim.step({ aspect: WIDE, pointer: { inside: false } }).upload(0).data).toBe(after.data);
  sim.dispose();
});
