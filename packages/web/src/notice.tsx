import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  ControlIcon,
  NoticeContext,
  type NoticeApi,
  type NoticeLifetime,
  type NoticeOptions,
} from "@manifold/plugin/ui";

/**
 * The one notice ref, PROVIDER half. Before this module the app had four independent
 * notice mechanisms with three persistence models plus four failures that only reached the
 * console, so "did the user see it?" depended on which file the failure happened in.
 * Now every transient message in the application lands in one bottom-center stack,
 * above every renderer and outside the sidebar's collapse subtree.
 *
 * Two lifetimes, because notices genuinely come in two kinds:
 *  - `notice` — a refusal or an outcome the user just caused; it auto-fades and is
 *    announced politely (`role="status"`).
 *  - `sticky` — a failure that leaves the app in a degraded state (a dropped
 *    connection, a load that never arrived); it stays until dismissed or superseded
 *    and is announced assertively (`role="alert"`).
 *
 * `key` is what makes repeated failures readable: a poll that fails every 1.5s
 * replaces its own notice in place instead of building a wall of identical rows.
 *
 * THE OTHER HALF OF THIS DOOR IS `@manifold/plugin/ui`: the context object, `NoticeApi` and
 * `useNotice` live there, because a plugin may not import a floor module and every plugin
 * needs to be able to say "that was refused" into the same stack. This file supplies the
 * value; nothing here is re-exported, so there is exactly one place to import a notice from
 * whichever side of the boundary a caller sits on. The queue types below stay floor — nothing
 * outside the provider may see a row.
 */

export interface NoticeEntry {
  readonly id: string;
  readonly message: string;
  readonly lifetime: NoticeLifetime;
  readonly key: string | null;
  /** Fading out: still occupies its slot for the animation, but is inert. */
  readonly leaving: boolean;
}

/** Beyond this the stack stops being readable, so the oldest row gives way. */
export const MAX_VISIBLE_NOTICES = 4;
/** How long a `notice` sits before it starts fading. */
export const NOTICE_LIFETIME_MS = 5000;
/** Must match the `.notice--leaving` transition in styles.css. */
export const NOTICE_FADE_MS = 220;

/**
 * Which row gives way when the stack overflows, oldest-first within each tier:
 * already-fading rows first (they were leaving anyway), then plain notices, and only
 * when the whole stack is sticky does a sticky failure get pushed off. Without the
 * tiering a burst of drag refusals could silently evict a connection failure.
 */
export function evictionIndex(queue: readonly NoticeEntry[]): number {
  for (let index = queue.length - 1; index >= 0; index -= 1) {
    if (queue[index]?.leaving === true) return index;
  }
  for (let index = queue.length - 1; index >= 0; index -= 1) {
    if (queue[index]?.lifetime === "notice") return index;
  }
  return queue.length - 1;
}

/** Newest-first insert with key supersession and overflow eviction. */
export function pushNotice(
  queue: readonly NoticeEntry[],
  entry: NoticeEntry,
): readonly NoticeEntry[] {
  if (entry.key !== null) {
    const slot = queue.findIndex((candidate) => candidate.key === entry.key && !candidate.leaving);
    if (slot !== -1) {
      const superseded = [...queue];
      superseded[slot] = entry;
      return superseded;
    }
  }
  const next = [entry, ...queue];
  if (next.length <= MAX_VISIBLE_NOTICES) return next;
  const evicted = evictionIndex(next);
  return [...next.slice(0, evicted), ...next.slice(evicted + 1)];
}

/** Starts the fade of one row; unknown ids leave the queue untouched. */
export function markLeaving(queue: readonly NoticeEntry[], id: string): readonly NoticeEntry[] {
  let changed = false;
  const next = queue.map((entry) => {
    if (entry.id !== id || entry.leaving) return entry;
    changed = true;
    return { ...entry, leaving: true };
  });
  return changed ? next : queue;
}

/** Drops one row outright; unknown ids leave the queue untouched. */
export function removeNotice(queue: readonly NoticeEntry[], id: string): readonly NoticeEntry[] {
  const next = queue.filter((entry) => entry.id !== id);
  return next.length === queue.length ? queue : next;
}

let sequence = 0;

function nextNoticeId(): string {
  sequence += 1;
  return `notice-${sequence}`;
}

interface NoticeProviderProps {
  readonly children: ReactNode;
}

/** Hosts the one notice stack and hands every descendant the same `notify`. */
export function NoticeProvider({ children }: NoticeProviderProps): ReactElement {
  const [queue, setQueue] = useState<readonly NoticeEntry[]>([]);
  const timers = useRef<Set<number>>(new Set());

  useEffect(
    () => () => {
      for (const handle of timers.current) window.clearTimeout(handle);
      timers.current.clear();
    },
    [],
  );

  const later = useCallback((run: () => void, delayMs: number): void => {
    const handle = window.setTimeout(() => {
      timers.current.delete(handle);
      run();
    }, delayMs);
    timers.current.add(handle);
  }, []);

  /**
   * Retirement is by id, so a timer that outlives its row — superseded by key, or
   * dismissed by hand mid-fade — simply finds nothing and does nothing. That is why
   * no timer ever has to be cancelled.
   */
  const retire = useCallback(
    (id: string): void => {
      setQueue((current) => markLeaving(current, id));
      later(() => setQueue((current) => removeNotice(current, id)), NOTICE_FADE_MS);
    },
    [later],
  );

  const notify = useCallback(
    (message: string, options?: NoticeOptions): string => {
      const lifetime = options?.lifetime ?? "notice";
      const id = nextNoticeId();
      setQueue((current) =>
        pushNotice(current, {
          id,
          message,
          lifetime,
          key: options?.key ?? null,
          leaving: false,
        }),
      );
      if (lifetime === "notice") later(() => retire(id), NOTICE_LIFETIME_MS);
      return id;
    },
    [later, retire],
  );

  const api = useMemo<NoticeApi>(() => ({ notify, dismiss: retire }), [notify, retire]);

  return (
    <NoticeContext.Provider value={api}>
      {children}
      {/* Fixed, pointer-transparent, and outside every renderer: the layer never
          steals a canvas drag, and no collapse state can hide it. */}
      <div className="notice-layer">
        {queue.map((entry) => (
          <div
            key={entry.id}
            className={`notice notice--${entry.lifetime}${entry.leaving ? " notice--leaving" : ""}`}
            role={entry.lifetime === "sticky" ? "alert" : "status"}
          >
            <span className="notice-message">{entry.message}</span>
            <button
              className="notice-dismiss"
              type="button"
              aria-label="Dismiss notice"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => retire(entry.id)}
            >
              <ControlIcon kind="close" />
            </button>
          </div>
        ))}
      </div>
    </NoticeContext.Provider>
  );
}
