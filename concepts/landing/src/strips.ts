// How the renderer bounds a draw (DitherRenderer, src/renderer.ts): a picture too slow to draw at
// once is drawn in horizontal strips, one a frame, bottom up, into a frame of its own that each
// frame shows whole, so it completes over that many frames and no single draw runs long enough for
// the browser to take the GPU back (a watchdog of a few seconds loses the context: the page goes
// white). A software rasteriser (SwiftShader, where a frame of the engine's costlier documents takes
// most of a second) and a slow GPU are where it engages. Each draw is timed on the GPU
// (EXT_disjoint_timer_query_webgl2); from those times the scheduler keeps the fewest strips whose
// costliest one draws within the budget: more at once when one runs over, fewer only once a whole
// pass shows one fewer would still draw well within it. A fast GPU measures one strip, the whole
// picture, and draws it as before. A strip's rows are drawn at the clock of their frame, so what
// moves shows a seam between strips drawn at different times while a pass lasts.

/** The scheduler's bounds. */
export const STRIPS = {
  /**
   * Milliseconds a draw may take: under the 120 ms a starter document's draw is held to under
   * SwiftShader (src/engine/README.md), far under a GPU watchdog's seconds.
   */
  budget: 100,
  /** The most strips: a picture always completes within this many frames. */
  most: 16,
  /**
   * The strips a program on a software rasteriser starts with, before its first draw is timed: its
   * first draw also builds it on the GPU, so it must not be the whole costly picture.
   */
  start: 4,
  /** Fewer strips once one fewer's costliest would draw within this share of the budget. */
  settle: 0.7,
} as const;

/**
 * The strips of a picture and the one each frame draws (see the header). Rows count from the
 * bottom, as gl_FragCoord's y does.
 */
export class StripScheduler {
  #strips = 1;
  /** The strip the next frame draws. */
  #next = 0;
  /** The costliest ms a row of the strips timed since the current pass began; 0 none timed. */
  #passRate = 0;

  /** How many strips a picture is drawn in now: 1 draws it whole. */
  get strips(): number {
    return this.#strips;
  }

  /** A new program, untimed: drawn in `strips` strips from its first frame on. */
  reset(strips: number): void {
    this.#strips = Math.min(Math.max(1, Math.round(strips)), STRIPS.most);
    this.#next = 0;
    this.#passRate = 0;
  }

  /**
   * The rows `[from, to)` of a picture `height` rows tall this frame draws: the next strip, all of
   * them while there is one. A pass that ends lets the count come down (see the header).
   */
  rows(height: number): readonly [number, number] {
    if (this.#next >= this.#strips) {
      this.#next = 0;
      if (this.#passRate > 0) {
        const fewer = this.#need(this.#passRate / STRIPS.settle, height);
        if (fewer < this.#strips) this.#strips = fewer;
      }
      this.#passRate = 0;
    }
    const each = Math.ceil(height / this.#strips);
    const from = Math.min(height, this.#next * each);
    this.#next += 1;
    return [from, Math.min(height, from + each)];
  }

  /**
   * A draw of `rows` rows of a picture `height` rows tall took `ms` on the GPU. One that ran over
   * the budget splits the picture into more strips at once, the pass starting again.
   */
  measured(ms: number, rows: number, height: number): void {
    if (!(ms >= 0 && rows > 0 && height > 0)) return;
    const rate = ms / rows;
    this.#passRate = Math.max(this.#passRate, rate);
    const need = this.#need(rate, height);
    if (need > this.#strips) {
      this.#strips = need;
      this.#next = 0;
      this.#passRate = rate;
    }
  }

  /** The fewest strips of a picture `height` rows tall whose rows at `rate` ms draw within the budget. */
  #need(rate: number, height: number): number {
    for (let strips = 1; strips < STRIPS.most; strips += 1)
      if (rate * Math.ceil(height / strips) <= STRIPS.budget) return strips;
    return STRIPS.most;
  }
}
