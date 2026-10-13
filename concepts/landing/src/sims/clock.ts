// Time for sims: a fixed-step accumulator for the frame loop, and a step budget for warm-ups.
//
// FixedStep: a sim steps a fixed h seconds at a time whatever the frame rate, so a seed plays out
// the same at 30 Hz and at 144 Hz. advance() adds a frame's sim time, caps what is owed at maxSteps
// steps (a stalled tab does not replay a minute at once) and returns how many whole steps are due.
//   new FixedStep(step, maxSteps)
//   advance(seconds)   add sim time (negative counts as 0); returns the steps due now, 0..maxSteps
//   lag(i)             seconds still owed after step i of the last advance(): step i happened lag(i)
//                      before now (for steps that sample a clock, e.g. tm - lag(i))
//   alpha              share of a step left over (pending / step), to interpolate the drawn state
//   pending            seconds left over
//   reset()            forget what is owed
// The arithmetic is the loop the scenes carried (`pending = min(pending + dt, max * h)`, subtract h
// while pending ≥ h), so a sim switching to it steps at exactly the same moments.
//
// runBudgeted(step, budgetMs, maxSteps, from = 0, chunk = 1) runs step(from), step(from + 1), ...
// until maxSteps, until step returns true (settled), or until budgetMs of wall time has passed
// (checked after every `chunk` steps, and only after the first chunk, so every call makes progress).
// It returns where to resume: maxSteps once finished, else the next i.
//
// Warm-up policy: a warm-up is a step count, never a duration. Machine speed must not decide the
// opening picture (sims are deterministic for a seed, scenes/README.md "Simulations"), so:
//   - Size the warm-up in steps. It may end early on a settled test inside `step`, which reads
//     only the sim's state, never the clock.
//   - The time budget is only a safety cap on how long one frame may block. When it runs out, keep
//     the returned index and call runBudgeted from it again on the next frame. Until it returns
//     maxSteps, hold the sim's own clock and live stepping (run only the warm-up, upload nothing
//     new or the opening state). The same steps then run in the same order on every machine; a slow
//     machine only takes more frames to get there.
//   - Size the budget so a typical machine finishes in the first call: there the warm-up is the
//     one-shot warm-up the scenes had.
//   - A warm-up that samples a clock (meadow's tm - (steps - 1 - k) · h) fixes that clock when it
//     starts, not on each call.
//   - Never sync the GPU per step (no gl.finish() inside `step`): the budget would measure stalls.
//
// Usage:
//   readonly #clock = new FixedStep(1 / 60, 8);
//   #warmed = 0;
//   frame(frame) {
//     if (this.#warmed < WARM_STEPS) {
//       this.#warmed = runBudgeted((i) => this.#settle(i), WARM_BUDGET_MS, WARM_STEPS, this.#warmed, 16);
//       if (this.#warmed < WARM_STEPS) return this.#textures;
//     }
//     const n = this.#clock.advance(Math.max(0, frame.dt) * frame.motion);
//     for (let i = 0; i < n; i++) this.#step(this.#clock.step);
//     this.#upload(this.#clock.alpha);
//   }

/** A fixed step or chunk that is not a positive (whole) number. */
export class ClockError extends Error {}

/** Fixed-step time keeping for a sim's frame loop (see the header). */
export class FixedStep {
  /** Seconds per step. */
  readonly step: number;
  /** Most steps one advance() returns; time owed beyond them is dropped. */
  readonly maxSteps: number;
  readonly #cap: number;
  /** pending after each step of the last advance(). */
  readonly #lags: Float64Array;
  #pending = 0;
  #count = 0;

  constructor(step: number, maxSteps: number) {
    if (!(step > 0 && Number.isFinite(step))) throw new ClockError(`a fixed step must be a positive number of seconds, got ${step}`);
    if (!(Number.isInteger(maxSteps) && maxSteps >= 1)) throw new ClockError(`maxSteps must be a whole number ≥ 1, got ${maxSteps}`);
    this.step = step;
    this.maxSteps = maxSteps;
    this.#cap = maxSteps * step;
    this.#lags = new Float64Array(maxSteps);
  }

  /** Seconds left over after the last advance(), less than one step. */
  get pending(): number {
    return this.#pending;
  }

  /** Share of a step left over, 0..1: pending / step. */
  get alpha(): number {
    return this.#pending / this.step;
  }

  /** Add `seconds` of sim time; returns how many steps are due now. */
  advance(seconds: number): number {
    const step = this.step;
    this.#pending = Math.min(this.#pending + Math.max(0, seconds), this.#cap);
    let count = 0;
    while (count < this.maxSteps && this.#pending >= step) {
      this.#pending -= step;
      this.#lags[count] = this.#pending;
      count++;
    }
    this.#count = count;
    return count;
  }

  /** Seconds still owed after step i (0 ≤ i < the last advance()'s count). */
  lag(i: number): number {
    const lag = Number.isInteger(i) && i < this.#count ? this.#lags[i] : undefined;
    if (lag === undefined) throw new ClockError(`lag(${i}) is outside the last advance's ${this.#count} steps`);
    return lag;
  }

  /** Forget what is owed: the next advance() starts from 0. */
  reset(): void {
    this.#pending = 0;
    this.#count = 0;
  }
}

/**
 * Run step(from), step(from + 1), ... up to maxSteps - 1, stopping early when `step` returns true
 * (settled) or, checked after every `chunk` steps, once `budgetMs` of wall time has passed. Returns
 * where to resume: maxSteps when finished (all steps run, or settled), else the next index. Runs at
 * least one chunk while any steps are left. See the header for the warm-up policy this serves.
 */
export function runBudgeted(step: (i: number) => boolean | void, budgetMs: number, maxSteps: number, from = 0, chunk = 1): number {
  if (!(Number.isInteger(chunk) && chunk >= 1)) throw new ClockError(`chunk must be a whole number ≥ 1, got ${chunk}`);
  const started = performance.now();
  let i = from;
  while (i < maxSteps) {
    const end = Math.min(maxSteps, i + chunk);
    for (; i < end; i++) {
      if (step(i) === true) return maxSteps;
    }
    if (performance.now() - started >= budgetMs) break;
  }
  return Math.min(i, maxSteps);
}
