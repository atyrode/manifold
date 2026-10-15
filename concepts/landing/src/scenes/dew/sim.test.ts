import { expect, test } from "bun:test";
import { BIN_PAGE } from "../../sims/bins.ts";
import { HeadlessSim, type HeadlessUpload } from "../../sims/headless.ts";
import { dewScene } from "./index.ts";
import { DEW_CODE, DEW_KIND_SPOKE, DEW_SEG_ROW, DEW_SEG_TEXELS } from "./sim.ts";

/** The dew sim's textures after it has run a second at this frame size and web seed. */
function run(
  width: number,
  height: number,
  webSeed: number,
): { segments: HeadlessUpload; lists: HeadlessUpload; header: HeadlessUpload } {
  const sim = new HeadlessSim(dewScene);
  for (let f = 0; f < 30; f++)
    sim.step({
      dt: 1 / 30,
      aspect: width / height,
      height,
      knobs: { webSeed },
      pointer: { inside: false },
    });
  return { segments: sim.upload(0), lists: sim.upload(1), header: sim.upload(3) };
}

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
  webSeed: number,
): { missing: number; pages: number; hubSpokes: number; hubListed: number } {
  const { segments, lists, header } = run(width, height, webSeed);
  // As the shader reads it: at least one page.
  const pages = Math.max(1, Math.round(header.data[10] ?? 0));
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
  const hubX = (header.data[0] ?? 0) + (header.data[2] ?? 0);
  const hubY = (header.data[1] ?? 0) + (header.data[3] ?? 0);
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
    for (const webSeed of [0, 5]) {
      const result = omissions(width, height, webSeed);
      expect({ size: `${width}x${height}`, webSeed, missing: result.missing }).toEqual({
        size: `${width}x${height}`,
        webSeed,
        missing: 0,
      });
      expect(result.hubSpokes).toBeGreaterThan(0);
      expect(result.hubListed).toBe(result.hubSpokes);
      expect(result.pages).toBeGreaterThan(1);
    }
  }
});

test("a landscape frame at the usual size keeps one page per bin and misses nothing", () => {
  for (const webSeed of [0, 5]) {
    const result = omissions(960, 540, webSeed);
    expect(result.missing).toBe(0);
    expect(result.pages).toBe(1);
  }
});
