import {
  JOB_PROGRESS_INTERVAL_MS,
  type JobProgressEvent,
  type WorkerProgress,
} from "@manifold/protocol";

/** The owner's own words for one reported line: the workload's frame plus when it arrived. */
export type ObservedProgress = Pick<JobProgressEvent, "stage" | "message" | "fraction" | "at">;

/** Injected so a test drives the cadence instead of waiting five seconds for it. */
export interface ProgressClock {
  now(): number;
  /** Runs `fn` after `ms`; the returned function cancels it. */
  after(ms: number, fn: () => void): () => void;
}

const systemClock: ProgressClock = {
  now: () => Date.now(),
  after: (ms, fn) => {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return () => clearTimeout(timer);
  },
};

/**
 * One job's progress, folded to at most one event per interval.
 *
 * Reporting never emits synchronously, and that is the whole rule: a workload that writes
 * twenty lines in a loop has all twenty in hand before the owner speaks, so the owner speaks
 * once and says the newest — the point of a stage is where the run IS, and a queue of stale
 * phases is worse than silence. The time carried is when the line was observed, not when the
 * fold was released, so "at the model since T" survives coalescing.
 *
 * `flush` exists because the last line is the one an operator reads after the fact: a run that
 * died at `at the model` must not lose that word to a window that had not elapsed yet.
 */
export class JobProgressCoalescer {
  private readonly clock: ProgressClock;
  private readonly intervalMs: number;
  private pending: ObservedProgress | null = null;
  private cancelTimer: (() => void) | null = null;
  private lastEmit: number | null = null;
  private closed = false;
  constructor(
    private readonly publish: (progress: ObservedProgress) => void,
    options: { clock?: ProgressClock; intervalMs?: number } = {},
  ) {
    this.clock = options.clock ?? systemClock;
    this.intervalMs = options.intervalMs ?? JOB_PROGRESS_INTERVAL_MS;
  }
  /** Records the newest line and arms the next slot; the caller is never blocked. */
  report(frame: WorkerProgress): void {
    if (this.closed) return;
    const now = this.clock.now();
    this.pending = {
      stage: frame.stage,
      ...(frame.message === undefined ? {} : { message: frame.message }),
      ...(frame.fraction === undefined ? {} : { fraction: frame.fraction }),
      at: now,
    };
    if (this.cancelTimer) return;
    const wait = this.lastEmit === null ? 0 : Math.max(0, this.lastEmit + this.intervalMs - now);
    this.cancelTimer = this.clock.after(wait, () => {
      this.cancelTimer = null;
      this.release();
    });
  }
  /** Releases whatever is still held, ignoring the window. Emits nothing when nothing is held. */
  flush(): void {
    this.disarm();
    this.release();
  }
  /** Drops what is held and stops; a job past its terminal event reports nothing more. */
  close(): void {
    this.closed = true;
    this.pending = null;
    this.disarm();
  }
  private disarm(): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
  }
  private release(): void {
    const progress = this.pending;
    if (this.closed || !progress) return;
    this.pending = null;
    this.lastEmit = this.clock.now();
    this.publish(progress);
  }
}
