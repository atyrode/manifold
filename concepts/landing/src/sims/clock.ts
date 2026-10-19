// Time for sims: a fixed-step accumulator for the frame loop, a step budget for warm-ups and the
// relayout debounce (Settle, below the budget).
//
// FixedStep: a sim steps a fixed h seconds at a time whatever the frame rate, so a seed plays out
// the same at 30 Hz and at 144 Hz. advance() adds a frame's sim time, caps what is owed at maxSteps
// steps (a stalled tab does not replay a minute at once) and returns how many whole steps are due.
//   new FixedStep(step, maxSteps)
//   advance(seconds)   add sim time (negative counts as 0); returns the steps due now, 0..maxSteps
//   lag(i)             seconds still owed after step i of the last advance(): step i happened lag(i)
//                      before now (for steps that sample a clock, e.g. tm - lag(i)); 0 for a step
//                      that fell due early
//   alpha              share of a step left over (pending / step), 0..1, to interpolate the drawing
//   pending            seconds left over, 0 ≤ pending < step
//   reset()            forget what is owed
// The arithmetic is the loop the scenes carried (`pending = min(pending + dt, max * h)`, subtract h
// while one is due), except that a step falls due a hair early: once pending reaches
// (1 − STEP_EARLY) h, not h. A display whose frame is h (60 Hz on a 1/60 step) then runs exactly
// one step a frame: its timestamps' rounding and jitter would otherwise leave pending on the step
// boundary and split a third of its frames into none and two steps (twice the work in one frame).
// The time a step ran early is owed back: the next step falls due that much later, so the sim
// keeps real time. Fed frames of whole steps (HeadlessSim's 1/60 to a step of 1/60, 1/120, 1/240
// or 1/480), pending is back to 0 after every frame: those runs step as with a due point of h.
//
// runBudgeted(step, budgetMs, maxSteps, from = 0, chunk = 1) runs step(from), step(from + 1), ...
// until maxSteps, until step returns true (settled), or until budgetMs of wall time has passed
// (checked after every `chunk` steps, and only after the first chunk, so every call makes progress).
// It returns where to resume: maxSteps once finished, else the next i. Pass the frame's budget
// (SimFrame.budget, or a floor raised by it): an Infinity budget, as HeadlessSim gives, never reads
// the clock and always finishes, so a test's warm-up ends in one frame.
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

/**
 * The share of a step by which one may fall due early: wider than a 60 Hz frame's timing jitter
 * on a 1/60 step (±0.5 ms of 16.7 ms is 3 %; 1 % still splits frames), and narrower than the gap a
 * 144 Hz frame leaves below a 1/60 step (pending tops out at 11/12 of one between whole steps).
 */
export const STEP_EARLY = 0.05;

/** Fixed-step time keeping for a sim's frame loop (see the header). */
export class FixedStep {
  /** Seconds per step. */
  readonly step: number;
  /** Most steps one advance() returns; time owed beyond them is dropped. */
  readonly maxSteps: number;
  readonly #cap: number;
  /** pending at which a step falls due: (1 − STEP_EARLY) steps. */
  readonly #due: number;
  /** pending after each step of the last advance(), at least 0. */
  readonly #lags: Float64Array;
  /** Seconds owed; down to −STEP_EARLY steps after a step that fell due early. */
  #pending = 0;
  #count = 0;

  constructor(step: number, maxSteps: number) {
    if (!(step > 0 && Number.isFinite(step)))
      throw new ClockError(`a fixed step must be a positive number of seconds, got ${step}`);
    if (!(Number.isInteger(maxSteps) && maxSteps >= 1))
      throw new ClockError(`maxSteps must be a whole number ≥ 1, got ${maxSteps}`);
    this.step = step;
    this.maxSteps = maxSteps;
    this.#cap = maxSteps * step;
    this.#due = step * (1 - STEP_EARLY);
    this.#lags = new Float64Array(maxSteps);
  }

  /** Seconds left over after the last advance(), 0 ≤ pending < step (0 after an early step). */
  get pending(): number {
    return Math.max(0, this.#pending);
  }

  /** Share of a step left over, 0..1: pending / step. */
  get alpha(): number {
    return Math.max(0, this.#pending) / this.step;
  }

  /** Add `seconds` of sim time; returns how many steps are due now. */
  advance(seconds: number): number {
    const step = this.step;
    this.#pending = Math.min(this.#pending + Math.max(0, seconds), this.#cap);
    let count = 0;
    while (count < this.maxSteps && this.#pending >= this.#due) {
      this.#pending -= step;
      this.#lags[count] = Math.max(0, this.#pending);
      count++;
    }
    this.#count = count;
    return count;
  }

  /** Seconds still owed after step i (0 ≤ i < the last advance()'s count); 0 for an early step. */
  lag(i: number): number {
    const lag = Number.isInteger(i) && i < this.#count ? this.#lags[i] : undefined;
    if (lag === undefined)
      throw new ClockError(`lag(${i}) is outside the last advance's ${this.#count} steps`);
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
export function runBudgeted(
  step: (i: number) => boolean | void,
  budgetMs: number,
  maxSteps: number,
  from = 0,
  chunk = 1,
): number {
  if (!(Number.isInteger(chunk) && chunk >= 1))
    throw new ClockError(`chunk must be a whole number ≥ 1, got ${chunk}`);
  const timed = budgetMs !== Infinity;
  const started = timed ? performance.now() : 0;
  let i = from;
  while (i < maxSteps) {
    const end = Math.min(maxSteps, i + chunk);
    for (; i < end; i++) {
      if (step(i) === true) return maxSteps;
    }
    if (timed && performance.now() - started >= budgetMs) break;
  }
  return Math.min(i, maxSteps);
}

/** What a Settle compares and keeps of a key. */
export interface SettleKeys<K> {
  /** Whether two keys are the same layout; Object.is when omitted. */
  same?: (a: K, b: K) => boolean;
  /** A key to keep, for a caller that rewrites the key it passes in place; the key itself when omitted. */
  copy?: (key: K) => K;
}

/**
 * The relayout debounce: a sim whose layout depends on knobs lays it out at once the first time, then
 * anew only once the key it wants has stood unchanged for `ms` wall-clock milliseconds (`frame.now`),
 * so a dragged slider does not rebuild the field on every frame. The layout on show stays meanwhile.
 *   new Settle(ms, { same, copy })
 *   due(want, now)   call every frame with the key the frame wants; true when the layout is to be
 *                    (re)built now: none yet, or one that differs from `want` while `want` has rested
 *   lay(key)         the layout for `key` is made: later frames compare against it
 *   stands(want)     whether the layout on show is the one for `want`
 *   laid             the key of the layout on show, undefined before the first
 * Usage:
 *   if (settle.due(want, frame.now)) { build(want); settle.lay(want); }
 */
export class Settle<K> {
  /** Wall-clock milliseconds a changed key must rest before it is laid out. */
  readonly ms: number;
  readonly #same: (a: K, b: K) => boolean;
  readonly #copy: (key: K) => K;
  #laid: K | undefined;
  #pending: K | undefined;
  #since = 0;

  constructor(ms: number, keys: SettleKeys<K> = {}) {
    if (!(ms >= 0)) throw new ClockError(`settle time ${ms} ms is not a number of ms from 0`);
    this.ms = ms;
    this.#same = keys.same ?? Object.is;
    this.#copy = keys.copy ?? ((key) => key);
  }

  get laid(): K | undefined {
    return this.#laid;
  }

  stands(want: K): boolean {
    const laid = this.#laid;
    return laid !== undefined && this.#same(laid, want);
  }

  due(want: K, now: number): boolean {
    const pending = this.#pending;
    if (pending === undefined || !this.#same(pending, want)) {
      this.#pending = this.#copy(want);
      this.#since = now;
    }
    const laid = this.#laid;
    return laid === undefined || (!this.#same(laid, want) && now - this.#since >= this.ms);
  }

  lay(key: K): void {
    const kept = this.#copy(key);
    this.#laid = kept;
    this.#pending = kept;
  }
}
