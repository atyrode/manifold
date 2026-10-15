import { expect, test } from "bun:test";
import { grayScottAlong, grayScottRegimes } from "./grayscott.ts";

const at = (position: number): [number, number] => {
  const out = new Float32Array(2);
  grayScottAlong(position, out, 0);
  return [out[0] ?? Number.NaN, out[1] ?? Number.NaN];
};

test("the drift loop passes through every regime at its stop and wraps both ways", () => {
  const count = grayScottRegimes.length;
  grayScottRegimes.forEach((regime, stop) => {
    for (const lap of [-2, 0, 1]) {
      const [feed, kill] = at(stop + lap * count);
      expect(feed).toBeCloseTo(regime.feed, 6);
      expect(kill).toBeCloseTo(regime.kill, 6);
    }
  });
});

test("between two stops the loop eases from one regime to the next, never past either", () => {
  const count = grayScottRegimes.length;
  for (let stop = 0; stop < count; stop++) {
    const from = grayScottRegimes[stop];
    const to = grayScottRegimes[(stop + 1) % count];
    if (!from || !to) throw new Error("missing regime");
    let last = 0;
    for (let k = 1; k < 10; k++) {
      const [feed, kill] = at(stop + k / 10);
      // Share of the way along, measured on whichever rate changes more between the two.
      const share =
        Math.abs(to.feed - from.feed) > Math.abs(to.kill - from.kill)
          ? (feed - from.feed) / (to.feed - from.feed)
          : (kill - from.kill) / (to.kill - from.kill);
      expect(share).toBeGreaterThan(last);
      expect(share).toBeLessThan(1);
      last = share;
    }
    // Eased: slow off one stop (linear would already be a fifth of the way to the midpoint).
    const [early] = at(stop + 0.1);
    const [mid] = at(stop + 0.5);
    expect(Math.abs(early - from.feed)).toBeLessThan(Math.abs(mid - from.feed) * 0.1);
  }
});
