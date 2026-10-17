import { expect, test } from "bun:test";
import {
  BUDGET_SLACK,
  CELL_BUDGET,
  cellScale,
  coverCells,
  stageCells,
  type Cells,
} from "./display.ts";

/** The most cells a stage draws before they coarsen. */
const MOST = CELL_BUDGET * BUDGET_SLACK;

/**
 * Device pixels each cell covers on screen, as the browser shows the canvas: its texels stretched
 * nearest-neighbour over the box (`deviceWidth` px) and then by the CSS scale, sampled at each
 * device pixel's centre. Only the cells wholly on screen (the last may run past the box's edge).
 */
function cellWidths(cells: Cells, deviceWidth: number): number[] {
  const scale = cellScale(cells, deviceWidth, deviceWidth);
  const stretch = scale === "" ? 1 : Number(scale.split(" ")[0]);
  const texel = (deviceWidth * stretch) / cells.width;
  const widths = Array.from({ length: cells.width }, () => 0);
  for (let x = 0; x < deviceWidth; x++) {
    const at = Math.floor((x + 0.5) / texel);
    widths[at] = (widths[at] ?? 0) + 1;
  }
  return widths.slice(0, Math.floor(deviceWidth / cells.cell));
}

test("dither cells land on whole device pixels at devicePixelRatio 1.25", () => {
  // A 1366 x 768 CSS px stage at 125 %: 1708 x 960 device pixels, 1.64 M of them: one device pixel
  // cells (pixel 1 rounds to 1) would be more than the budget allows, so that one is coarser, at 2.
  for (const [pixel, cell] of [
    [1, 2],
    [2, 3],
    [3, 4],
    [4, 5],
  ] as const) {
    const cells = stageCells(1708, 960, 1.25, pixel);
    expect(Number.isInteger(cells.cell)).toBe(true);
    expect(cells.cell).toBeGreaterThanOrEqual(Math.round(pixel * 1.25));
    expect(cells.cell).toBe(cell);
    expect(cells.width * cells.height).toBeLessThanOrEqual(MOST);
    // ... and no finer than the budget lets it be.
    if (cells.cell > Math.round(pixel * 1.25))
      expect(
        Math.ceil(1708 / (cells.cell - 1)) * Math.ceil(960 / (cells.cell - 1)),
      ).toBeGreaterThan(MOST);
    expect(new Set(cellWidths(cells, 1708))).toEqual(new Set([cells.cell]));
    expect(new Set(cellWidths({ ...cells, width: cells.height }, 960))).toEqual(
      new Set([cells.cell]),
    );
  }
});

test("at devicePixelRatio 1 a stage gets the cells of whole CSS pixels it always had", () => {
  for (const [width, height] of [
    [1920, 1080],
    [1366, 768],
    [1365, 767],
    [320, 200],
    [64, 40],
  ] as const)
    for (const pixel of [1, 2, 3, 4, 8]) {
      const cells = stageCells(width, height, 1, pixel);
      if (Math.ceil(width / pixel) * Math.ceil(height / pixel) > MOST) continue;
      expect(cells).toEqual({
        cell: pixel,
        width: Math.ceil(width / pixel),
        height: Math.ceil(height / pixel),
      });
    }
  // Cells that fit the stage exactly are not stretched.
  expect(cellScale(stageCells(1920, 1080, 1, 2), 1920, 1080)).toBe("");
});

test("a 4K stage draws no more cells than the budget allows, with cells as fine as it allows", () => {
  for (const dpr of [1, 1.5, 2]) {
    const cells = stageCells(3840, 2160, dpr, 2);
    expect(cells.width * cells.height).toBeLessThanOrEqual(MOST);
    const finer = Math.ceil(3840 / (cells.cell - 1)) * Math.ceil(2160 / (cells.cell - 1));
    if (cells.cell > Math.round(2 * dpr)) expect(finer).toBeGreaterThan(MOST);
  }
  expect(stageCells(3840, 2160, 1, 2)).toEqual({ cell: 4, width: 960, height: 540 });
  // A 1080p stage at pixel 2 is the budget itself.
  expect(stageCells(1920, 1080, 1, 2)).toEqual({ cell: 2, width: 960, height: 540 });
});

test("a stage a little past the budget keeps its cells: no cliff at one CSS row more", () => {
  // One row past 1080p, a windowed and a full-screen 1920 x 1200 screen keep 2 px cells...
  expect(stageCells(1920, 1081, 1, 2).cell).toBe(2);
  expect(stageCells(1920, 1090, 1, 2).cell).toBe(2);
  expect(stageCells(1920, 1200, 1, 2).cell).toBe(2);
  // ... and a windowed 1440p one, at 1.6 times the budget, still gets 3.
  expect(stageCells(2560, 1305, 1, 2)).toEqual({ cell: 3, width: 854, height: 435 });
});

test("an image laid over the stage as CSS covers it lands where the page shows it", () => {
  // A 240 x 150 thumbnail over a 1920 x 1080 box in 2 px cells: 8 px a texel, the width exactly,
  // and 60 px over the top and the bottom.
  expect(coverCells(stageCells(1920, 1080, 1, 2), 1920, 1080, 240, 150)).toEqual({
    x: 0,
    y: -30,
    width: 960,
    height: 600,
  });
  // A tall box: the height exactly, centred across. The cells run past the box (3 px cells over
  // 1000 px), and the image sits on the box, not on them.
  expect(coverCells(stageCells(1000, 2000, 1, 3), 1000, 2000, 240, 150)).toEqual({
    x: (1000 - 3200) / 2 / 3,
    y: 0,
    width: 3200 / 3,
    height: 2000 / 3,
  });
});
