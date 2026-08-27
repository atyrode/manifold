import { describe, expect, test } from "bun:test";

import { reconnectDelayMs } from "../src/backoff.ts";

describe("reconnectDelayMs", () => {
  test("doubles the ceiling per attempt until the cap", () => {
    // random() = 1 pins the jitter to the full ceiling.
    const full = (attempt: number) => reconnectDelayMs(attempt, 250, 15_000, () => 1);
    expect(full(0)).toBe(250);
    expect(full(1)).toBe(500);
    expect(full(2)).toBe(1_000);
    expect(full(6)).toBe(15_000); // 250·2^6 = 16000 → capped
    expect(full(50)).toBe(15_000); // 2^50 overflow-safe: min() caps it
  });

  test("jitter spans exactly [0.5, 1.0] of the ceiling", () => {
    expect(reconnectDelayMs(3, 250, 15_000, () => 0)).toBe(1_000); // floor: half of 2000
    expect(reconnectDelayMs(3, 250, 15_000, () => 1)).toBe(2_000);
    const mid = reconnectDelayMs(3, 250, 15_000, () => 0.5);
    expect(mid).toBe(1_500);
  });

  test("astronomical attempts never produce Infinity or NaN", () => {
    const delay = reconnectDelayMs(10_000, 250, 15_000, () => 0.5);
    expect(Number.isFinite(delay)).toBe(true);
    expect(delay).toBe(11_250);
  });
});
