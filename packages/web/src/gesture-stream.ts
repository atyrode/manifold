import { GESTURE_MIN_INTERVAL_MS, type Gesture } from "@manifold/protocol";

export interface GestureStreamOptions {
  readonly intervalMs?: number;
  readonly now?: () => number;
  readonly schedule?: (callback: () => void, delayMs: number) => number;
  readonly cancel?: (handle: number) => void;
  readonly send: (gesture: Gesture) => void;
}

export interface GestureStream {
  push(gesture: Gesture): void;
  end(gesture: Gesture): void;
  cancel(): void;
}

/**
 * Dev cadence override (`VITE_GESTURE_SEND_MS`). Null means the wire default; a proof
 * harness slows the rate down so it can sample individual frames deterministically.
 * Read here rather than per renderer so both disciplines stream at one rate.
 */
export function gestureSendIntervalOverride(): number | null {
  const value = Number(import.meta.env["VITE_GESTURE_SEND_MS"]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function createGestureStream({
  intervalMs = GESTURE_MIN_INTERVAL_MS,
  now = () => performance.now(),
  schedule = (callback, delayMs) => window.setTimeout(callback, delayMs),
  cancel = (handle) => window.clearTimeout(handle),
  send,
}: GestureStreamOptions): GestureStream {
  let lastSentAt = Number.NEGATIVE_INFINITY;
  let pending: Gesture | null = null;
  let scheduled: number | null = null;

  const clearScheduled = (): void => {
    if (scheduled === null) return;
    cancel(scheduled);
    scheduled = null;
  };

  const flush = (): void => {
    scheduled = null;
    if (pending === null) return;
    const gesture = pending;
    pending = null;
    lastSentAt = now();
    send(gesture);
  };

  return {
    push(gesture) {
      const elapsed = now() - lastSentAt;
      if (elapsed >= intervalMs) {
        clearScheduled();
        pending = null;
        lastSentAt = now();
        send(gesture);
        return;
      }

      pending = gesture;
      if (scheduled === null) {
        scheduled = schedule(flush, intervalMs - elapsed);
      }
    },
    end(gesture) {
      clearScheduled();
      pending = null;
      lastSentAt = now();
      send(gesture);
    },
    cancel() {
      clearScheduled();
      pending = null;
    },
  };
}
