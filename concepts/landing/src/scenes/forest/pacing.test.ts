import { expect, test } from "bun:test";
import { HeadlessSim, type HeadlessUpload } from "../../sims/headless.ts";
import { loadScene } from "../index.ts";

const forestScene = await loadScene("forest");

const KNOBS = { spores: 1, wind: 0.8 };

/** Every mote drawn (bin units: x across from the left edge, y up; glow), from uSim1's two slots per bin. */
function motes(upload: HeadlessUpload): { x: number; y: number; glow: number }[] {
  const out: { x: number; y: number; glow: number }[] = [];
  const data = upload.data;
  const cols = upload.width / 2;
  for (let t = 0; t < upload.width * upload.height; t++) {
    const glow = data[4 * t + 3] ?? 0;
    if (glow <= 0) continue;
    const bx = Math.floor((t % upload.width) / 2);
    const by = Math.floor(t / upload.width);
    if (bx >= cols) continue;
    out.push({ x: bx + (data[4 * t] ?? 0), y: by + (data[4 * t + 1] ?? 0), glow });
  }
  return out;
}

/** One second of the forest in frames of 1/rate s. */
function second(rate: number): { x: number; y: number; glow: number }[] {
  const sim = new HeadlessSim(forestScene);
  for (let f = 0; f < rate; f++)
    sim.step({ dt: 1 / rate, knobs: KNOBS, pointer: { inside: false } });
  const drawn = motes(sim.upload(1));
  sim.dispose();
  return drawn;
}

test("the motes drift and spawn the same at 60 and 144 frames a second", () => {
  const slow = second(60);
  const fast = second(144);
  // The same motes (one spawned a step, whatever the frame rate), each where the other rate draws it.
  expect(slow.length).toBeGreaterThan(40);
  expect(fast.length).toBe(slow.length);
  let worst = 0;
  let glow = 0;
  for (const mote of slow) {
    let best = Infinity;
    let at = mote;
    for (const other of fast) {
      const d = Math.hypot(other.x - mote.x, other.y - mote.y);
      if (d < best) {
        best = d;
        at = other;
      }
    }
    worst = Math.max(worst, best);
    glow = Math.max(glow, Math.abs(at.glow - mote.glow));
  }
  // In bins (a thirtieth of the frame's height): well under a cell apart.
  expect(worst).toBeLessThan(0.01);
  expect(glow).toBeLessThan(0.01);
});
