import { expect, test } from "bun:test";
import { ATLAS_WIDTH } from "../../composer/caps.ts";
import { BIN_PAGE } from "../../sims/bins.ts";
import { HeadlessSim, type HeadlessUpload } from "../../sims/headless.ts";
import { loadScene } from "../index.ts";
import { DEW_CODE, DEW_KIND_SPOKE } from "./build.ts";
import { DEW_HEAD_AT, DEW_SEG_ROW, DEW_SEG_TEXELS } from "./sim.ts";

const dewScene = await loadScene("dew");

// Where the composed sim puts the web's data (src/composer/sim.ts): its row of the records atlas
// (slot 1, the row after the composer's own) and its two fields (slots 2 and 3).
const ATLAS = 1;
const SEGMENTS = 2;
const LISTS = 3;
const ROW = 1;

/** The web's row of the records atlas: the drops from texel 0, the header from DEW_HEAD_AT. */
function row(sim: HeadlessSim): Float32Array | Uint8Array {
  const at = ROW * ATLAS_WIDTH * 4;
  return sim.upload(ATLAS).data.subarray(at, at + ATLAS_WIDTH * 4);
}

/** The web's header, as the shader reads it (12 floats). */
function header(sim: HeadlessSim): Float32Array | Uint8Array {
  return row(sim).subarray(DEW_HEAD_AT * 4, DEW_HEAD_AT * 4 + 12);
}

/** The dew sim's data after it has run a second at this frame size and web seed. */
function run(
  width: number,
  height: number,
  seed: number,
): { segments: HeadlessUpload; lists: HeadlessUpload; header: Float32Array | Uint8Array } {
  const sim = new HeadlessSim(dewScene);
  for (let f = 0; f < 30; f++)
    sim.step({
      dt: 1 / 30,
      aspect: width / height,
      height,
      knobs: { seed },
      pointer: { inside: false },
    });
  return { segments: sim.upload(SEGMENTS), lists: sim.upload(LISTS), header: header(sim) };
}

/** The drops riding the web (a drop's radius > 0), each as (x, y) from the hub and its radius. */
function drops(sim: HeadlessSim): { x: number; y: number; r: number }[] {
  const head = header(sim);
  const hx = (head[0] ?? 0) + (head[2] ?? 0);
  const hy = (head[1] ?? 0) + (head[3] ?? 0);
  const data = row(sim).subarray(0, DEW_HEAD_AT * 4);
  const out: { x: number; y: number; r: number }[] = [];
  for (let o = 0; o < data.length; o += 8) {
    const r = data[o + 4] ?? 0;
    if (r <= 0) continue;
    const x = (data[o] ?? 0) + (data[o + 2] ?? 0) - hx;
    const y = (data[o + 1] ?? 0) + (data[o + 3] ?? 0) - hy;
    out.push({ x, y, r });
  }
  return out;
}

/** Where the hub is drawn (the header), frame heights from the frame's left edge. */
function hubX(sim: HeadlessSim): number {
  const head = header(sim);
  return (head[0] ?? 0) + (head[2] ?? 0);
}

/** Hub moves past this between two frames are a respin (the breeze sways it far less). */
const RESPUN = 0.01;

test("a window resized by 2 % keeps the web's drops where they hang on it, as large as they were", () => {
  const sim = new HeadlessSim(dewScene);
  const still = { pointer: { inside: false } };
  for (let f = 0; f < 600; f++) sim.step({ ...still, aspect: 16 / 9 });
  // The web is respun once the new shape has rested: compare the frame before with the frame after.
  let before = drops(sim);
  let frames = 0;
  for (let hub = hubX(sim); Math.abs(hubX(sim) - hub) < RESPUN && frames < 60; frames++) {
    hub = hubX(sim);
    before = drops(sim);
    sim.step({ ...still, aspect: (16 / 9) * 1.02 });
  }
  // Left as it was while the shape rested (220 ms: 14 frames at 60 Hz), then respun.
  expect(frames).toBeGreaterThanOrEqual(14);
  expect(frames).toBeLessThan(60);
  const after = drops(sim);
  expect(before.length).toBeGreaterThan(3);
  // Each drop still on its thread, at its place along it: within a cell or two of where it hung
  // from the hub, and its size unchanged.
  const kept = before.filter((drop) =>
    after.some(
      (other) =>
        Math.hypot(other.x - drop.x, other.y - drop.y) < 0.004 &&
        Math.abs(other.r / drop.r - 1) < 0.02,
    ),
  );
  expect(kept.length).toBeGreaterThanOrEqual(0.8 * before.length);
});

test("a window edge being dragged leaves the web as it is until the drag rests, then respins it once", () => {
  const sim = new HeadlessSim(dewScene);
  const still = { pointer: { inside: false } };
  for (let f = 0; f < 30; f++) sim.step({ ...still, aspect: 16 / 9 });
  const jumps = (aspect: (f: number) => number, count: number): number => {
    let respun = 0;
    for (let f = 0; f < count; f++) {
      const hub = hubX(sim);
      sim.step({ ...still, aspect: aspect(f) });
      if (Math.abs(hubX(sim) - hub) >= RESPUN) respun++;
    }
    return respun;
  };
  // A drag: a new shape every frame (a sixtieth of a second apart), never resting.
  expect(jumps((f) => 16 / 9 + 0.01 * (f + 1), 30)).toBe(0);
  // At rest: respun once, within the rest (220 ms, 14 frames) and a frame, then left alone.
  const rested = 16 / 9 + 0.3;
  expect(jumps(() => rested, 30)).toBe(1);
  expect(hubX(sim)).toBeCloseTo(rested * 0.58, 1);
});

/** Whether the segment a–b crosses the square [x0, x0 + size] × [y0, y0 + size] (Liang–Barsky). */
function crosses(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  x0: number,
  y0: number,
  size: number,
): boolean {
  let t0 = 0;
  let t1 = 1;
  for (const [delta, low, high, from] of [
    [bx - ax, x0, x0 + size, ax],
    [by - ay, y0, y0 + size, ay],
  ] as const) {
    if (Math.abs(delta) < 1e-12) {
      if (from < low || from > high) return false;
      continue;
    }
    const ta = (low - from) / delta;
    const tb = (high - from) / delta;
    t0 = Math.max(t0, Math.min(ta, tb));
    t1 = Math.min(t1, Math.max(ta, tb));
    if (t0 > t1) return false;
  }
  return true;
}

/**
 * Every thread and stem segment whose centre line passes through a bin, missing from that bin's list
 * (the shader would not draw it there); and how many spokes meet at the hub and how many of them the
 * hub's bin lists.
 */
function omissions(
  width: number,
  height: number,
  seed: number,
): { missing: number; pages: number; hubSpokes: number; hubListed: number } {
  const { segments, lists, header } = run(width, height, seed);
  // As the shader reads it: at least one page.
  const pages = Math.max(1, Math.round(header[10] ?? 0));
  const rows = lists.width / BIN_PAGE;
  const cols = lists.height / pages;
  const size = 1 / rows;
  const listed = (i: number, j: number, id: number): boolean => {
    for (let k = 0; k < BIN_PAGE * pages; k++) {
      const entry =
        lists.data[
          (i + Math.floor(k / BIN_PAGE) * cols) * lists.width + j * BIN_PAGE + (k % BIN_PAGE)
        ] ?? 0;
      if (entry === 0) return false;
      if (entry === id) return true;
    }
    return false;
  };
  const hubX = (header[0] ?? 0) + (header[2] ?? 0);
  const hubY = (header[1] ?? 0) + (header[3] ?? 0);
  const hubI = Math.floor(hubX / size);
  const hubJ = Math.floor(hubY / size);
  let missing = 0;
  let hubSpokes = 0;
  let hubListed = 0;
  const records = (segments.width / DEW_SEG_TEXELS) * segments.height;
  for (let s = 0; s < records; s++) {
    const o =
      ((s % DEW_SEG_ROW) * DEW_SEG_TEXELS + Math.floor(s / DEW_SEG_ROW) * segments.width) * 4;
    const t0 = segments.data.subarray(o, o + 4);
    const t1 = segments.data.subarray(o + 4, o + 8);
    if (t0.every((value) => value === 0)) break;
    const ax = (t0[0] ?? 0) + (t1[0] ?? 0);
    const ay = (t0[1] ?? 0) + (t1[1] ?? 0);
    const bx = (t0[2] ?? 0) + (t1[2] ?? 0);
    const by = (t0[3] ?? 0) + (t1[3] ?? 0);
    for (
      let i = Math.max(0, Math.floor(Math.min(ax, bx) / size));
      i <= Math.min(cols - 1, Math.floor(Math.max(ax, bx) / size));
      i++
    ) {
      for (
        let j = Math.max(0, Math.floor(Math.min(ay, by) / size));
        j <= Math.min(rows - 1, Math.floor(Math.max(ay, by) / size));
        j++
      ) {
        if (crosses(ax, ay, bx, by, i * size, j * size, size) && !listed(i, j, s + 1)) missing++;
      }
    }
    const kind = Math.floor((segments.data[o + 11] ?? 0) / DEW_CODE);
    if (kind === DEW_KIND_SPOKE && Math.hypot(ax - hubX, ay - hubY) < 1e-6) {
      hubSpokes++;
      if (listed(hubI, hubJ, s + 1)) hubListed++;
    }
  }
  return { missing, pages, hubSpokes, hubListed };
}

test("dense small and portrait frames list every thread in every bin it crosses, the hub's radii included", () => {
  for (const [width, height] of [
    [480, 270],
    [320, 180],
    [185, 400],
  ] as const) {
    for (const seed of [0, 5]) {
      const result = omissions(width, height, seed);
      expect({ size: `${width}x${height}`, seed, missing: result.missing }).toEqual({
        size: `${width}x${height}`,
        seed,
        missing: 0,
      });
      expect(result.hubSpokes).toBeGreaterThan(0);
      expect(result.hubListed).toBe(result.hubSpokes);
      expect(result.pages).toBeGreaterThan(1);
    }
  }
});

test("a landscape frame at the usual size keeps one page per bin and misses nothing", () => {
  for (const seed of [0, 5]) {
    const result = omissions(960, 540, seed);
    expect(result.missing).toBe(0);
    expect(result.pages).toBe(1);
  }
});
