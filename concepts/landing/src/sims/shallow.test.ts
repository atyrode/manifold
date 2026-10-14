import { describe, expect, test } from "bun:test";
import { stillWater } from "./shallow.ts";

/**
 * A 14 × 12 shore, row 0 at the bottom: the sea along the top row (bed -3, the outlet), a platform
 * at 2 below it, and on the platform a 4 × 4 basin floored at -1 inside a rim at 3, with a notch in
 * its top side at 1 opening onto a channel at 1 that runs up to the sea.
 */
function shore(): { bed: Float32Array; sea: Uint8Array; width: number; height: number; at: (x: number, y: number) => number } {
  const width = 14;
  const height = 12;
  const bed = new Float32Array(width * height).fill(2);
  const sea = new Uint8Array(width * height);
  const at = (x: number, y: number): number => y * width + x;
  for (let x = 0; x < width; x++) {
    bed[at(x, height - 1)] = -3;
    sea[at(x, height - 1)] = 1;
  }
  for (let y = 2; y <= 7; y++) for (let x = 4; x <= 9; x++) bed[at(x, y)] = 3;
  for (let y = 3; y <= 6; y++) for (let x = 5; x <= 8; x++) bed[at(x, y)] = -1;
  for (let y = 7; y < height - 1; y++) bed[at(6, y)] = 1;
  return { bed, sea, width, height, at };
}

describe("stillWater", () => {
  test("a basin fills to its notch and the platform drains", () => {
    const { bed, sea, width, height, at } = shore();
    const level = stillWater(bed, width, height, sea, 0);
    for (let y = 3; y <= 6; y++) for (let x = 5; x <= 8; x++) expect(level[at(x, y)]).toBe(1);
    // The sea stands at its level, dry ground at its bed.
    expect(level[at(3, height - 1)]).toBe(0);
    expect(level[at(1, 1)]).toBe(2);
    expect(level[at(4, 4)]).toBe(3);
    expect(level[at(6, 9)]).toBe(1);
  });

  test("a sea above the notch joins the basin; above the rim it drowns the platform", () => {
    const { bed, sea, width, height, at } = shore();
    const joined = stillWater(bed, width, height, sea, 1.5);
    expect(joined[at(6, 4)]).toBe(1.5);
    expect(joined[at(6, 9)]).toBe(1.5);
    expect(joined[at(1, 1)]).toBe(2);
    const drowned = stillWater(bed, width, height, sea, 3.5);
    for (let i = 0; i < bed.length; i++) expect(drowned[i]).toBe(3.5);
  });

  test("a basin with no way out fills to the lowest point of its rim", () => {
    const { bed, sea, width, height, at } = shore();
    for (let y = 7; y < height - 1; y++) bed[at(6, y)] = 2;
    bed[at(6, 7)] = 3;
    bed[at(9, 5)] = 2.5;
    const level = stillWater(bed, width, height, sea, 0);
    for (let y = 3; y <= 6; y++) for (let x = 5; x <= 8; x++) expect(level[at(x, y)]).toBe(2.5);
  });

  test("without an outlet nothing holds water", () => {
    const { bed, width, height } = shore();
    expect(Array.from(stillWater(bed, width, height, new Uint8Array(width * height), 10))).toEqual(Array.from(bed));
  });
});
