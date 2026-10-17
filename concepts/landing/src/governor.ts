// The frame governor behind DitherRenderer.start. It draws every n-th refresh of the display, n
// whole and fixed, so every frame stays up as long as the one before (a cap stepped by a fixed
// interval alternates one refresh and two at 90 Hz, two and three at 144): at the full rate, the
// even divisor of the refresh rate nearest 60 frames a second, and at rest, while nothing is touched
// and no passage or entrance plays, half that, or the divisor nearest 30 where that is faster. While
// the picture stands still it draws none at all once a change or input has played out. The refresh
// period is the interquartile mean of the intervals between the last few requestAnimationFrame
// calls: the middle half, which a dropped frame or a stall does not reach, averaged, which evens
// out rAF jitter; it follows the window to a display of another rate within a few tenths of a
// second.

/**
 * What the picture draws at while nothing is touched: the `full` rate, or `half` of it (the lab's
 * `rest` setting, read and written as the URL key `rest`).
 */
export const restIds = ["full", "half"] as const;
export type RestId = (typeof restIds)[number];

/** Frames a second the full rate comes nearest, in log terms (75 Hz draws 75, 144 Hz 72). */
const FULL_FPS = 60;
/** Frames a second the rest rate comes nearest where half the full rate is less (90 Hz: 30). */
const REST_FPS = 30;
/** requestAnimationFrame intervals the refresh period is measured over: 0.35 s at 60 Hz. */
const PERIOD_SAMPLES = 21;
/** The refresh period taken before the first interval is measured: 60 Hz. */
const FIRST_PERIOD_MS = 1000 / 60;
/**
 * Seconds still frames go on drawing after a change or input, and frames at the full rate after
 * input: what a change sets off over a few frames at rest plays out (a sim's budgeted rebuild, a
 * sheet painted on a worker, the program switched to).
 */
export const SETTLE_SECONDS = 5;
/**
 * Seconds still frames go on drawing after the pointer merely moves or leaves: enough for a frame
 * to show it where it now is (the parallax eases on toward it while it moves; a drag holds as long
 * as a change, SETTLE_SECONDS). Hovering sets nothing off over time on a still picture.
 */
export const POINTER_SECONDS = 0.25;
/**
 * Seconds frames go on at the full rate after a press or a "now" trigger, and still frames go on
 * drawing while the interaction clock runs (under reduced motion, or at motion 0): its bounded
 * response plays out in real time.
 */
export const RESPONSE_SECONDS = 20;

/**
 * What the picture does: `still`, nothing moves on its own and nothing is on its way, so it draws
 * only while a wake lasts; `moving`, it moves on its own, at the full rate (and, where `rest` is
 * `half`, only while an input lasts, at half otherwise); `passing`, a passage or an entrance plays,
 * at the full rate.
 */
export type Picture = "still" | "moving" | "passing";

/** The divisor for which a display refreshing every `refreshMs` comes nearest `fps`, in log terms. */
function nearest(refreshMs: number, fps: number): number {
  const ratio = 1000 / (refreshMs * fps);
  if (!(ratio > 0 && Number.isFinite(ratio))) return 1;
  // Every n-th and every (n + 1)-th refresh are as near at a refresh rate of fps √(n (n + 1)).
  return Math.max(1, Math.ceil((Math.sqrt(1 + 4 * ratio * ratio) - 1) / 2));
}

/**
 * Every how many refreshes of a display refreshing every `refreshMs` a frame draws. At the full
 * rate, the divisor nearest FULL_FPS: 1 up to 85 Hz (75 Hz draws 75), 2 up to 147 Hz (90, 120 and
 * 144 Hz draw 45, 60 and 72), 3 up to 208 Hz (165 Hz draws 55), 4 at 240 Hz. At `rest`, twice that,
 * or the divisor nearest REST_FPS where that is less: 90 Hz rests at 30, not 22.5, and a display
 * throttled to 30 Hz keeps 30.
 */
export function frameDivisor(refreshMs: number, rest = false): number {
  const full = nearest(refreshMs, FULL_FPS);
  return rest ? Math.min(2 * full, nearest(refreshMs, REST_FPS)) : full;
}

export class FrameGovernor {
  /** The rAF time of the last frame drawn. */
  #last = Number.NEGATIVE_INFINITY;
  /** The rAF time of the last call, drawn or not. */
  #previous = Number.NaN;
  /** The last PERIOD_SAMPLES intervals between calls (a ring, `#filled` of them so far). */
  readonly #intervals = new Float64Array(PERIOD_SAMPLES);
  readonly #sorted = new Float64Array(PERIOD_SAMPLES);
  #filled = 0;
  #next = 0;
  /** The display's refresh period in ms: the interquartile mean of `#intervals`. */
  #period = FIRST_PERIOD_MS;
  /** rAF time until which still frames draw. */
  #awake = Number.NEGATIVE_INFINITY;
  /** Seconds asked for by `wake` since the last call. */
  #wake = 0;
  /** rAF time until which frames draw at the full rate. */
  #lively = Number.NEGATIVE_INFINITY;
  /** Seconds asked for by `input` since the last call. */
  #input = 0;

  /** The rate frames draw at while nothing is touched: `full`, or `half` of it. */
  rest: RestId = "full";

  /** Keep still frames drawing for `seconds` from the next frame. */
  wake(seconds: number): void {
    this.#wake = Math.max(this.#wake, seconds);
  }

  /** Input, or a trigger: draw at the full rate for `seconds` from the next frame. */
  input(seconds: number): void {
    this.#input = Math.max(this.#input, seconds);
  }

  /**
   * Whether to draw the frame of rAF time `now` (ms), called for every frame the display gives: not
   * while the picture is `still` once the last wake has run out, and otherwise on every
   * `frameDivisor`-th refresh, at the full rate, or, where `rest` is `half`, at half of it unless
   * the picture is `passing` or an input lasts. A refresh up to half a period early still counts.
   */
  due(now: number, picture: Picture): boolean {
    this.#measure(now);
    if (this.#wake > 0) {
      this.#awake = Math.max(this.#awake, now + this.#wake * 1000);
      this.#wake = 0;
    }
    if (this.#input > 0) {
      this.#lively = Math.max(this.#lively, now + this.#input * 1000);
      this.#input = 0;
    }
    if (picture === "still" && now >= this.#awake) return false;
    const rest = this.rest === "half" && picture !== "passing" && now >= this.#lively;
    if (now - this.#last < (frameDivisor(this.#period, rest) - 0.5) * this.#period) return false;
    this.#last = now;
    return true;
  }

  /** Take the interval since the last call into the refresh period. */
  #measure(now: number): void {
    const interval = now - this.#previous;
    this.#previous = now;
    // The first call has no interval, and a time repeated none to measure.
    if (!(interval > 0)) return;
    this.#intervals[this.#next] = interval;
    this.#next = (this.#next + 1) % PERIOD_SAMPLES;
    this.#filled = Math.min(this.#filled + 1, PERIOD_SAMPLES);
    // Until the ring is full its first `#filled` slots hold every interval; the rest sort last.
    const sorted = this.#sorted;
    sorted.set(this.#intervals);
    sorted.fill(Number.POSITIVE_INFINITY, this.#filled);
    sorted.sort();
    const quarter = this.#filled >> 2;
    let sum = 0;
    for (let i = quarter; i < this.#filled - quarter; i++) sum += sorted[i] ?? 0;
    this.#period = sum / (this.#filled - 2 * quarter);
  }
}
