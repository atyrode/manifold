// The stage in device pixels and the dither cells laid over it: the renderer draws one texel per
// cell and the canvas stretches them over its box. Each cell covers a whole number of device pixels
// each way. A cell of `pixel` CSS px spans `pixel × devicePixelRatio` device pixels, a fraction at
// 125 % scaling or browser zoom (2.5 at pixel 2), and nearest-neighbour scaling then shows its
// columns and rows alternately a pixel wider and narrower, which bends the ordered dither's tone
// curve (by up to 8 points of 64 at 2.5) and bands smooth gradients.

/**
 * The cells a frame is budgeted: the scene budget (src/scenes/README.md, "Art direction"), one
 * full-screen pass at ~960 × 540 cells holding 60 fps on an integrated GPU. A larger stage (a 4K
 * screen at 100 %, a 1440p one at pixel 2) gets coarser cells instead of more of them, once it
 * would draw more than BUDGET_SLACK times as many.
 */
export const CELL_BUDGET = 960 * 540;
/**
 * How far past its budget a stage may draw before its cells coarsen: a whole step coarser draws
 * about half as many cells or fewer, so a hard cap would halve them for one CSS row past 1080p, and
 * a windowed 1920 × 1200 browser (1.01 × the budget at 2 px cells) would draw as few as a
 * 1366 × 768 laptop.
 */
export const BUDGET_SLACK = 1.25;

export interface Cells {
  /** Device pixels a cell covers each way. */
  readonly cell: number;
  /**
   * Cells across and down: the canvas's size. The last column and row run past the stage's edge by
   * less than a cell.
   */
  readonly width: number;
  readonly height: number;
}

/**
 * The cells over a stage of `deviceWidth` × `deviceHeight` device pixels at `dpr` device pixels
 * per CSS pixel, each about `pixel` CSS px: `pixel × dpr` rounded to whole device pixels (at least
 * one), then coarser while there would be more than `budget` × BUDGET_SLACK cells.
 */
export function stageCells(
  deviceWidth: number,
  deviceHeight: number,
  dpr: number,
  pixel: number,
  budget: number = CELL_BUDGET,
): Cells {
  const width = Math.max(1, Math.round(deviceWidth));
  const height = Math.max(1, Math.round(deviceHeight));
  const most = budget * BUDGET_SLACK;
  let cell = Math.max(1, Math.round(pixel * dpr), Math.floor(Math.sqrt((width * height) / most)));
  while (Math.ceil(width / cell) * Math.ceil(height / cell) > most) cell++;
  return { cell, width: Math.ceil(width / cell), height: Math.ceil(height / cell) };
}

/**
 * The CSS `scale` (from the box's top left corner, `transform-origin: 0 0`) that lays `cells` over
 * a box of `deviceWidth` × `deviceHeight` device pixels each on whole device pixels: the canvas
 * fills its box, so it is stretched by as much as its cells run past the box. "" when they fit.
 */
export function cellScale(cells: Cells, deviceWidth: number, deviceHeight: number): string {
  const x = (cells.width * cells.cell) / Math.max(1, Math.round(deviceWidth));
  const y = (cells.height * cells.cell) / Math.max(1, Math.round(deviceHeight));
  return x === 1 && y === 1 ? "" : `${x} ${y}`;
}

/**
 * A canvas's box in device pixels, kept by a ResizeObserver (its device-pixel content box; where
 * the browser lacks that, Safari, its CSS box times devicePixelRatio), and where it sits on the
 * page; the canvas sized to the cells over it (`present`) and the page's pointer mapped onto them.
 * No frame reads layout: the box's place is read again only once the observer reports a new size
 * or the page's own arrangement changes (the lab's docks on the root's style, its opening and the
 * bare mode on the body's class).
 */
export class StageBox {
  readonly #canvas: HTMLCanvasElement;
  readonly #resized: () => void;
  /** The cells a frame is budgeted (see `stageCells`). */
  readonly #budget: number;
  /** The content box in device pixels, and in CSS pixels from the viewport's top left. */
  #deviceWidth = 1;
  #deviceHeight = 1;
  #left = 0;
  #top = 0;
  #width = 1;
  #height = 1;
  #dpr = 1;
  /** The observer reports device pixels: a resolution change then reaches it too. */
  #exact = false;
  /** `#left` and `#top` hold (see `#place`). */
  #placed = false;
  /** The cells for each pixel size asked for since the box last changed. */
  readonly #cells = new Map<number, Cells>();
  /** The `scale` last written on the canvas. */
  #scale = "";

  /**
   * `resized`: called whenever the box changes, after it is measured. `budget`: the cells a frame
   * is budgeted (see `stageCells`).
   */
  constructor(canvas: HTMLCanvasElement, resized: () => void, budget: number = CELL_BUDGET) {
    this.#canvas = canvas;
    this.#resized = resized;
    this.#budget = budget;
    canvas.style.transformOrigin = "0 0";
    this.#measure();
    const observer = new ResizeObserver((entries) => this.#observed(entries));
    try {
      observer.observe(canvas, { box: "device-pixel-content-box" });
    } catch {
      observer.observe(canvas);
    }
    const moved = new MutationObserver(() => {
      this.#placed = false;
    });
    moved.observe(document.documentElement, { attributeFilter: ["style"] });
    moved.observe(document.body, { attributeFilter: ["class"] });
    this.#watchResolution();
  }

  /** The cells over the box at `pixel` CSS px each (see `stageCells`). */
  cells(pixel: number): Cells {
    let cells = this.#cells.get(pixel);
    if (cells === undefined) {
      cells = stageCells(this.#deviceWidth, this.#deviceHeight, this.#dpr, pixel, this.#budget);
      this.#cells.set(pixel, cells);
    }
    return cells;
  }

  /** Size the canvas to `cells`, stretched so each lands on whole device pixels (`cellScale`). */
  present(cells: Cells): void {
    const canvas = this.#canvas;
    if (canvas.width !== cells.width || canvas.height !== cells.height) {
      canvas.width = cells.width;
      canvas.height = cells.height;
    }
    const scale = cellScale(cells, this.#deviceWidth, this.#deviceHeight);
    if (scale !== this.#scale) {
      this.#scale = scale;
      canvas.style.scale = scale;
    }
  }

  /** How far across the `cells` shown `clientX` falls: 0 at their left edge, 1 at their right. */
  across(clientX: number, cells: Cells): number {
    this.#place();
    const shown = (cells.width * cells.cell * this.#width) / Math.max(1, this.#deviceWidth);
    return (clientX - this.#left) / Math.max(shown, 1);
  }

  /** How far down the `cells` shown `clientY` falls, 0 at their top edge and 1 at their bottom. */
  down(clientY: number, cells: Cells): number {
    this.#place();
    const shown = (cells.height * cells.cell * this.#height) / Math.max(1, this.#deviceHeight);
    return (clientY - this.#top) / Math.max(shown, 1);
  }

  #observed(entries: readonly ResizeObserverEntry[]): void {
    const entry = entries.at(-1);
    if (entry === undefined) return;
    const css = entry.contentBoxSize[0];
    // Absent where the browser lacks device-pixel boxes (Safari), whatever the types say.
    const devices: readonly ResizeObserverSize[] | undefined = entry.devicePixelContentBoxSize;
    const device = devices?.[0];
    const dpr = window.devicePixelRatio;
    const width = css?.inlineSize ?? entry.contentRect.width;
    const height = css?.blockSize ?? entry.contentRect.height;
    // A device box is the CSS box times the ratio snapped to whole pixels; one off by more than a
    // pixel (Chromium's emulated device scale reports the CSS box) is not taken.
    this.#exact =
      device !== undefined &&
      Math.abs(device.inlineSize - width * dpr) <= 1 &&
      Math.abs(device.blockSize - height * dpr) <= 1;
    this.#dpr = dpr;
    this.#width = width;
    this.#height = height;
    this.#deviceWidth = this.#exact && device ? device.inlineSize : Math.round(width * dpr);
    this.#deviceHeight = this.#exact && device ? device.blockSize : Math.round(height * dpr);
    // Layout is clean while observers run: reading the box's place here costs nothing.
    this.#placed = false;
    this.#place();
    this.#changed();
  }

  /** The box read from layout: at start, and on a resolution change the observer misses. */
  #measure(): void {
    const canvas = this.#canvas;
    this.#dpr = window.devicePixelRatio;
    this.#width = canvas.clientWidth;
    this.#height = canvas.clientHeight;
    this.#deviceWidth = Math.round(this.#width * this.#dpr);
    this.#deviceHeight = Math.round(this.#height * this.#dpr);
    this.#placed = false;
    this.#place();
    this.#cells.clear();
  }

  /** Read where the box sits, if that may have changed since it was last read. */
  #place(): void {
    if (this.#placed) return;
    const rect = this.#canvas.getBoundingClientRect();
    this.#left = rect.left;
    this.#top = rect.top;
    this.#placed = true;
  }

  #changed(): void {
    this.#cells.clear();
    this.#resized();
  }

  /**
   * A change of devicePixelRatio with the box's CSS size unchanged (the window moved to another
   * screen) is reported by the observer only in device pixels; without those, measure again.
   */
  #watchResolution(): void {
    matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener(
      "change",
      () => {
        if (!this.#exact) {
          this.#measure();
          this.#changed();
        }
        this.#watchResolution();
      },
      { once: true },
    );
  }
}
