import { expect, test } from "bun:test";
import { halfBits, halfValue } from "./half.ts";

test("halfBits gives the binary16 pattern a FLOAT upload into a 16f texture holds", () => {
  expect(halfBits(0)).toBe(0);
  expect(halfBits(-0)).toBe(0x8000);
  expect(halfBits(1)).toBe(0x3c00);
  expect(halfBits(-2)).toBe(0xc000);
  expect(halfBits(0.1)).toBe(0x2e66);
  expect(halfBits(65504)).toBe(0x7bff);
  expect(halfBits(65519.99)).toBe(0x7bff);
  // Halfway to the next power of two rounds up into Infinity.
  expect(halfBits(65520)).toBe(0x7c00);
  expect(halfBits(-Infinity)).toBe(0xfc00);
  expect(halfBits(Number.NaN)).toBe(0x7e00);
  // The smallest normal and subnormal; half the smallest subnormal ties to 0, three halves to 2.
  expect(halfBits(2 ** -14)).toBe(0x0400);
  expect(halfBits(2 ** -24)).toBe(0x0001);
  expect(halfBits(2 ** -25)).toBe(0);
  expect(halfBits(3 * 2 ** -25)).toBe(0x0002);
  // x is taken as a float32 first, as the Float32Array it stands in for holds it.
  expect(halfBits(1 + 2 ** -11 + 2 ** -30)).toBe(0x3c00);
});

test("every half comes back as itself; between two, the nearer wins and a tie goes to the even", () => {
  const wrong: string[] = [];
  for (let bits = 0; bits < 0x10000; bits++) {
    const value = halfValue(bits);
    if (Number.isNaN(value)) {
      if ((bits & 0x7c00) !== 0x7c00 || (bits & 0x3ff) === 0) wrong.push(`${bits} decodes to NaN`);
      continue;
    }
    if (halfBits(value) !== bits) wrong.push(`${bits} comes back as ${halfBits(value)}`);
    // Its neighbour away from zero, while that is finite.
    if ((bits & 0x7fff) >= 0x7bff) continue;
    const next = halfValue(bits + 1);
    const mid = (value + next) / 2;
    const nudge = (next - value) / 4096;
    const even = bits % 2 === 0 ? bits : bits + 1;
    if (halfBits(mid) !== even) wrong.push(`the tie above ${bits} goes to ${halfBits(mid)}`);
    if (halfBits(mid - nudge) !== bits) wrong.push(`just under the tie above ${bits}`);
    if (halfBits(mid + nudge) !== bits + 1) wrong.push(`just over the tie above ${bits}`);
  }
  expect(wrong).toEqual([]);
});
