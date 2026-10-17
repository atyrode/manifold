import { expect, spyOn, test } from "bun:test";
import { HeadlessGl } from "./headless.ts";
import { DataTexture, DirtyRegion } from "./texture.ts";

/**
 * An r8 texture on the stand-in and its image, spies on its two uploads, what the texture holds,
 * and the rectangles (x, y, width, height) sent by uploadRegion so far.
 */
function sheet(width: number, height: number) {
  const headless = new HeadlessGl();
  const texture = new DataTexture(headless.gl, { width, height, format: "r8" });
  const data = new Uint8Array(width * height);
  const whole = spyOn(texture, "upload");
  const region = spyOn(texture, "uploadRegion");
  const held = (): Uint8Array | Float32Array => headless.upload(texture.texture).data;
  const rects = (): unknown[][] => region.mock.calls.map((call) => call.slice(1));
  return { texture, data, whole, region, held, rects };
}

test("everything goes up whole at first, after all() and after a resize; then nothing until a change", () => {
  const { texture, data, whole, region, held } = sheet(16, 8);
  const dirty = new DirtyRegion(16, 8);
  data[5] = 9;
  dirty.mark(3, 3);
  dirty.flush(texture, data);
  expect([whole.mock.calls.length, region.mock.calls.length]).toEqual([1, 0]);
  expect(held()).toEqual(data);
  dirty.flush(texture, data);
  expect([whole.mock.calls.length, region.mock.calls.length]).toEqual([1, 0]);
  dirty.all();
  dirty.flush(texture, data);
  expect(whole.mock.calls.length).toBe(2);
  dirty.resize(16, 8);
  dirty.flush(texture, data);
  expect([whole.mock.calls.length, region.mock.calls.length]).toEqual([3, 0]);
});

test("one tile sends the rectangle round every change since the last flush", () => {
  const { texture, data, held, rects } = sheet(32, 16);
  const dirty = new DirtyRegion(32, 16);
  dirty.flush(texture, data);
  data[2 * 32 + 3] = 1;
  dirty.mark(3, 2);
  data[10 * 32 + 20] = 2;
  data[11 * 32 + 21] = 3;
  dirty.touch(20, 10, 22, 12);
  dirty.touch(5, 5, 5, 9); // empty: nothing
  dirty.flush(texture, data);
  expect(rects()).toEqual([[3, 2, 19, 10]]);
  expect(held()).toEqual(data);
});

test("bands of rows send a rectangle each, round only their own changes", () => {
  const { texture, data, held, rects } = sheet(32, 16);
  const dirty = new DirtyRegion(32, 16, Infinity, 4);
  dirty.flush(texture, data);
  for (const [x, y] of [
    [3, 1],
    [9, 2],
    [30, 13],
  ] as const) {
    data[y * 32 + x] = 7;
    dirty.mark(x, y);
  }
  dirty.flush(texture, data);
  expect(rects()).toEqual([
    [3, 1, 7, 2],
    [30, 13, 1, 1],
  ]);
  expect(held()).toEqual(data);
});

test("square tiles send a run of changed tiles along a row as one rectangle, a gap as two", () => {
  const { texture, data, held, rects } = sheet(40, 16);
  const dirty = new DirtyRegion(40, 16, 8, 8);
  dirty.flush(texture, data);
  // Across four tiles (x 6..9, y 6..9), and alone in a tile three tiles over.
  dirty.touch(6, 6, 10, 10);
  dirty.mark(33, 1);
  data.fill(4, 6 * 40 + 6, 6 * 40 + 10);
  data[1 * 40 + 33] = 5;
  dirty.flush(texture, data);
  expect(rects()).toEqual([
    [6, 6, 4, 2],
    [33, 1, 1, 1],
    [6, 8, 4, 2],
  ]);
  expect(held()).toEqual(data);
});
