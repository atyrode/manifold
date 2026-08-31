import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

/**
 * The workspace index is HTTP, not a live channel: this tab learns that another tab created a
 * container, parked a terminal, or joined a room only by asking again. Five surfaces did that
 * with five hand-rolled effects, each re-deriving the same four concerns — fetch once
 * immediately, then on an interval; drop a response that a token or route change superseded;
 * hold a response that would land mid-gesture; and leave state untouched when the answer did
 * not change. This is that one poll.
 *
 * EVENTUAL FIX: a workspace event channel. The session socket already carries per-room fan-out;
 * once the server pushes container/session/presence changes over it, every caller of this hook
 * becomes a subscription and the intervals go away. The hook is deliberately shaped like a
 * subscription (value + local writes + explicit refresh) so that swap stays mechanical.
 */
export interface PolledResourceOptions<T> {
  /** The value before the first response settles; read once, like any `useState` seed. */
  readonly initial: T;
  /** While false nothing is fetched and no timer runs; flipping it true fetches at once. */
  readonly enabled?: boolean;
  /**
   * Consulted when a response settles: true drops it. A held response is never queued — the
   * next tick asks again — so pausing costs one stale interval and never a burst on release.
   */
  readonly hold?: () => boolean;
  /**
   * Content comparison. An equal response never reaches state, so an unchanged workspace
   * re-renders nobody: without this a 2s poll would rebuild every subscriber on every tick.
   */
  readonly equal?: (current: T, incoming: T) => boolean;
  readonly onError?: (reason: unknown) => void;
  /**
   * Anything outside the fetch that should make the answer stale right now — a route id, a
   * count a placement just moved. Changing it restarts the poll, immediate first fetch included.
   */
  readonly restartKey?: string | number | boolean | null;
}

export interface PolledResource<T> {
  readonly value: T;
  /** Local writes: an optimistic move, or a mutation's own response, ahead of the next tick. */
  readonly setValue: Dispatch<SetStateAction<T>>;
  /** Ask now, for a mutation whose effect the caller should not wait an interval to see. */
  readonly refresh: () => void;
}

/**
 * `fetchFn` identity is the restart signal for everything the fetch itself closes over (the
 * bearer token, an id): pass a `useCallback`. The policy callbacks are read late, so they may
 * be written inline without churning the timer.
 */
export function usePolledResource<T>(
  fetchFn: () => Promise<T>,
  intervalMs: number,
  options: PolledResourceOptions<T>,
): PolledResource<T> {
  const { initial, enabled = true, hold, equal, onError, restartKey = null } = options;
  const [value, setValue] = useState<T>(initial);

  const policy = useRef({ hold, equal, onError });
  // Declared before the poll effect, so it has already published this render's callbacks by the
  // time an immediate first fetch can settle.
  useEffect(() => {
    policy.current = { hold, equal, onError };
  });

  /**
   * Bumped whenever the poll restarts or unmounts. A response issued before the bump belongs to
   * a superseded fetch — an old token, a route the viewer already left — and is dropped rather
   * than allowed to overwrite the current answer.
   */
  const generation = useRef(0);

  const refresh = useCallback((): void => {
    const issued = generation.current;
    void fetchFn()
      .then((incoming) => {
        if (issued !== generation.current) return;
        if (policy.current.hold?.() === true) return;
        setValue((current) =>
          policy.current.equal?.(current, incoming) === true ? current : incoming,
        );
      })
      .catch((reason: unknown) => {
        if (issued !== generation.current) return;
        policy.current.onError?.(reason);
      });
  }, [fetchFn]);

  useEffect(() => {
    if (!enabled) return;
    refresh();
    const timer = window.setInterval(refresh, intervalMs);
    return () => {
      generation.current += 1;
      window.clearInterval(timer);
    };
  }, [enabled, intervalMs, refresh, restartKey]);

  return { value, setValue, refresh };
}
