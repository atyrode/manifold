// The frame governor behind DitherRenderer.start: at most 60 frames a second whatever the display's
// refresh rate, and none at all while the picture stands still once a change or input has played
// out.

/** Real milliseconds between two frames at the cap: 60 a second. */
export const FRAME_MS = 1000 / 60;
/** How much sooner than FRAME_MS a frame may come and still be drawn: rAF jitter at 60 Hz. */
const EARLY_MS = 4;
/**
 * Seconds still frames go on drawing after a change or input: what a change sets off over a few
 * frames at rest plays out (a sim's budgeted rebuild, a sheet painted on a worker, the program
 * switched to).
 */
export const SETTLE_SECONDS = 5;
/**
 * Seconds still frames go on drawing after the pointer merely moves or leaves: enough for a frame
 * to show it where it now is (the parallax eases on toward it while it moves; a drag holds as long
 * as a change, SETTLE_SECONDS). Hovering sets nothing off over time on a still picture.
 */
export const POINTER_SECONDS = 0.25;
/**
 * Seconds still frames go on drawing after a press or a "now" trigger while the interaction clock
 * runs (under reduced motion, or at motion 0): its bounded response plays out in real time.
 */
export const RESPONSE_SECONDS = 20;

export class FrameGovernor {
  /**
   * The rAF time the last drawn frame stands for. It steps by FRAME_MS, so it may run behind the
   * frame's own time by up to a frame and a frame that comes a little early is not held back.
   */
  #last = Number.NEGATIVE_INFINITY;
  /** rAF time until which still frames draw. */
  #awake = Number.NEGATIVE_INFINITY;
  /** Seconds asked for by `wake` since the last frame. */
  #wake = 0;

  /** Keep still frames drawing for `seconds` from the next frame. */
  wake(seconds: number): void {
    this.#wake = Math.max(this.#wake, seconds);
  }

  /**
   * Whether to draw the frame of rAF time `now` (ms): not while `still` once the last wake has run
   * out, and never sooner than FRAME_MS (less EARLY_MS) after the previous one, so a 120 Hz display
   * draws every other frame and a 75 Hz one four of five.
   */
  due(now: number, still: boolean): boolean {
    if (this.#wake > 0) {
      this.#awake = Math.max(this.#awake, now + this.#wake * 1000);
      this.#wake = 0;
    }
    if (still && now >= this.#awake) return false;
    const since = now - this.#last;
    if (since < FRAME_MS - EARLY_MS) return false;
    this.#last = since >= 2 * FRAME_MS ? now : this.#last + FRAME_MS;
    return true;
  }
}
