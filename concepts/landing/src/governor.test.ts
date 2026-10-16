import { expect, test } from "bun:test";
import { FrameGovernor, SETTLE_SECONDS } from "./governor.ts";

/** Frames a governor draws out of a display's at `hertz`, per whole second over `seconds`. */
function drawnPerSecond(hertz: number, seconds: number, jitter = 0): number[] {
  const governor = new FrameGovernor();
  const perSecond = Array.from({ length: seconds }, () => 0);
  for (let frame = 0; frame < hertz * seconds; frame++) {
    // A fixed pattern of early and late frames, up to `jitter` ms either way.
    const now = 1000 + (frame * 1000) / hertz + jitter * Math.sin(frame * 2.3);
    const second = Math.floor((frame * 1000) / hertz / 1000);
    if (governor.due(now, false)) perSecond[second] = (perSecond[second] ?? 0) + 1;
  }
  return perSecond;
}

test("a 120 Hz display draws at most 60 frames a second", () => {
  for (const drawn of drawnPerSecond(120, 3)) {
    expect(drawn).toBeLessThanOrEqual(60);
    expect(drawn).toBeGreaterThanOrEqual(59);
  }
});

test("a 60 Hz display draws every frame, early and late ones too", () => {
  expect(drawnPerSecond(60, 3, 2)).toEqual([60, 60, 60]);
});

test("75 and 144 Hz displays draw close to 60 frames a second", () => {
  for (const hertz of [75, 90, 144, 240])
    for (const drawn of drawnPerSecond(hertz, 3)) {
      expect(drawn).toBeLessThanOrEqual(60);
      expect(drawn).toBeGreaterThanOrEqual(55);
    }
});

test("a still picture stops drawing once a wake has played out, and input wakes it", () => {
  const governor = new FrameGovernor();
  const frame = 1000 / 60;
  governor.wake(SETTLE_SECONDS);
  let drawn = 0;
  let lastDrawn = Number.NaN;
  const end = (SETTLE_SECONDS + 2) * 60;
  for (let at = 0; at < end; at++)
    if (governor.due(1000 + at * frame, true)) {
      drawn++;
      lastDrawn = at * frame;
    }
  expect(drawn).toBeGreaterThan(SETTLE_SECONDS * 60 - 2);
  expect(lastDrawn).toBeLessThan(SETTLE_SECONDS * 1000);
  // Nothing more while still, until something wakes it.
  expect(governor.due(1000 + end * frame, true)).toBe(false);
  governor.wake(SETTLE_SECONDS);
  expect(governor.due(1000 + (end + 1) * frame, true)).toBe(true);
  // A picture that moves draws whatever the wake.
  expect(new FrameGovernor().due(1000, false)).toBe(true);
});
