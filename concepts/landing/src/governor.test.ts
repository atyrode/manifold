import { expect, test } from "bun:test";
import { FrameGovernor, frameDivisor, SETTLE_SECONDS, type Picture } from "./governor.ts";

/**
 * Which of `count` refreshes of a display at `hertz`, numbered on from `from`, a governor draws:
 * each comes up to `jitter` ms early or late in a fixed pattern, and none comes where `dropped`
 * says (a frame the browser dropped, or a stall).
 */
function drawn(
  governor: FrameGovernor,
  hertz: number,
  picture: Picture,
  from: number,
  count: number,
  options: { jitter?: number; dropped?: (refresh: number) => boolean } = {},
): number[] {
  const { jitter = 0, dropped = () => false } = options;
  const refreshes: number[] = [];
  for (let refresh = from; refresh < from + count; refresh++) {
    if (dropped(refresh)) continue;
    const now = 1000 + (refresh * 1000) / hertz + jitter * Math.sin(refresh * 2.3);
    if (governor.due(now, picture)) refreshes.push(refresh);
  }
  return refreshes;
}

/** Refreshes between each drawn frame and the next. */
function gaps(refreshes: readonly number[]): number[] {
  return refreshes.slice(1).map((refresh, i) => refresh - (refreshes[i] ?? 0));
}

test("the full rate is the refresh rate's even divisor nearest 60 frames a second, the half rate half that or the one nearest 30", () => {
  for (const [hertz, full, rest] of [
    [30, 1, 1],
    [50, 1, 2],
    [60, 1, 2],
    [75, 1, 2],
    [90, 2, 3],
    [100, 2, 3],
    [120, 2, 4],
    [144, 2, 4],
    [165, 3, 6],
    [240, 4, 8],
  ] as const) {
    expect([hertz, frameDivisor(1000 / hertz)]).toEqual([hertz, full]);
    expect([hertz, frameDivisor(1000 / hertz, true)]).toEqual([hertz, rest]);
  }
});

test("every frame stays up for the same number of refreshes, through rAF jitter", () => {
  for (const [hertz, divisor, jitter] of [
    [60, 1, 2],
    [75, 1, 0.3],
    [90, 2, 0.3],
    [120, 2, 0.3],
    [144, 2, 0.3],
    [165, 3, 0.3],
    [240, 4, 0.3],
  ] as const) {
    // The first few intervals measure the display roughly; from a tenth of a second on it holds.
    const refreshes = drawn(new FrameGovernor(), hertz, "passing", 0, hertz * 3, {
      jitter,
    }).filter((refresh) => refresh >= hertz / 10);
    expect([hertz, new Set(gaps(refreshes))]).toEqual([hertz, new Set([divisor])]);
  }
});

test("the refresh rate is measured through dropped frames and stalls", () => {
  // A dropped frame every 25 refreshes and a stall of six every 60: an average interval would put
  // a 165 Hz display at about 140 Hz and draw every other refresh.
  const dropped = (refresh: number) => refresh % 25 === 24 || refresh % 60 >= 54;
  // From a tenth of a second on, as above.
  const refreshes = drawn(new FrameGovernor(), 165, "passing", 0, 165 * 4, {
    jitter: 1,
    dropped,
  }).filter((refresh) => refresh >= 16);
  const spans = gaps(refreshes).filter((_, i) => {
    const end = refreshes[i + 1] ?? 0;
    for (let refresh = (refreshes[i] ?? 0) + 1; refresh < end; refresh++)
      if (dropped(refresh)) return false;
    return true;
  });
  expect(spans.length).toBeGreaterThan(100);
  expect(new Set(spans)).toEqual(new Set([3]));
});

test("a moving picture draws at the full rate with no input, by default", () => {
  const governor = new FrameGovernor();
  expect(governor.rest).toBe("full");
  // Nothing touched: every second refresh of a 120 Hz display, 60 a second, as with input.
  const resting = drawn(governor, 120, "moving", 0, SETTLE_SECONDS * 120 * 2);
  expect(new Set(gaps(resting))).toEqual(new Set([2]));
  governor.input(SETTLE_SECONDS);
  const lively = drawn(governor, 120, "moving", SETTLE_SECONDS * 240, 120);
  expect(new Set(gaps(lively))).toEqual(new Set([2]));
});

test("a moving picture at half rate draws at the rest rate until input, which brings the full rate back at once", () => {
  const governor = new FrameGovernor();
  governor.rest = "half";
  // At rest: every fourth refresh of a 120 Hz display, 30 a second.
  const resting = drawn(governor, 120, "moving", 0, 121);
  expect(new Set(gaps(resting))).toEqual(new Set([4]));
  // Input just after a frame: the next one draws a full-rate frame on, not a resting one, and so
  // on while the input lasts.
  governor.input(SETTLE_SECONDS);
  const lively = drawn(governor, 120, "moving", 121, SETTLE_SECONDS * 120);
  expect(lively[0]).toBe((resting.at(-1) ?? 0) + 2);
  expect(new Set(gaps(lively))).toEqual(new Set([2]));
  // Then at rest again; a passage or an entrance plays at the full rate whatever the input.
  const after = drawn(governor, 120, "moving", 121 + SETTLE_SECONDS * 120, 120);
  expect(new Set(gaps(after))).toEqual(new Set([4]));
  const passing = drawn(governor, 120, "passing", 241 + SETTLE_SECONDS * 120, 120);
  expect(new Set(gaps(passing))).toEqual(new Set([2]));
  // Back to the full rate: the setting applies at once.
  governor.rest = "full";
  const full = drawn(governor, 120, "moving", 361 + SETTLE_SECONDS * 120, 120);
  expect(new Set(gaps(full))).toEqual(new Set([2]));
});

test("a still picture stops drawing once a wake has played out, and a wake draws it again", () => {
  const governor = new FrameGovernor();
  governor.rest = "half";
  const end = (SETTLE_SECONDS + 2) * 60;
  governor.wake(SETTLE_SECONDS);
  const woken = drawn(governor, 60, "still", 0, end);
  // At the rest rate while nothing is touched: every other refresh of a 60 Hz display, as long as
  // the wake lasts.
  expect(new Set(gaps(woken))).toEqual(new Set([2]));
  expect(woken.length).toBeGreaterThan(SETTLE_SECONDS * 30 - 2);
  expect(woken.at(-1)).toBeLessThan(SETTLE_SECONDS * 60);
  // Nothing more while still: input sets the rate, not whether a still picture draws.
  governor.input(SETTLE_SECONDS);
  expect(drawn(governor, 60, "still", end, 60)).toEqual([]);
  governor.wake(SETTLE_SECONDS);
  expect(drawn(governor, 60, "still", end + 60, 1)).toEqual([end + 60]);
  // A picture that moves draws whatever the wake.
  expect(new FrameGovernor().due(1000, "moving")).toBe(true);
});

test("a still picture woken at the default rate draws every refresh while the wake lasts", () => {
  const governor = new FrameGovernor();
  governor.wake(SETTLE_SECONDS);
  const woken = drawn(governor, 60, "still", 0, (SETTLE_SECONDS + 2) * 60);
  expect(new Set(gaps(woken))).toEqual(new Set([1]));
  expect(woken.length).toBeGreaterThan(SETTLE_SECONDS * 60 - 2);
  expect(woken.at(-1)).toBeLessThan(SETTLE_SECONDS * 60);
});
