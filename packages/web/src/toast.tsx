import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { ControlIcon } from "./icons.tsx";

/**
 * The one notice surface. Before this module the app had four independent notice
 * mechanisms with three persistence models plus four failures that only reached the
 * console, so "did the user see it?" depended on which file the failure happened in.
 * Now every transient message in the application lands in one bottom-center stack,
 * above every renderer and outside the sidebar's collapse subtree.
 *
 * Two lifetimes, because notices genuinely come in two kinds:
 *  - `toast` — a refusal or an outcome the user just caused; it auto-fades and is
 *    announced politely (`role="status"`).
 *  - `sticky` — a failure that leaves the app in a degraded state (a dropped
 *    connection, a load that never arrived); it stays until dismissed or superseded
 *    and is announced assertively (`role="alert"`).
 *
 * `key` is what makes repeated failures readable: a poll that fails every 1.5s
 * replaces its own notice in place instead of building a wall of identical rows.
 */

export type ToastLifetime = "toast" | "sticky";

export interface ToastOptions {
  /** Defaults to `"toast"`. */
  readonly lifetime?: ToastLifetime;
  /**
   * Supersession slot. A notice carrying a key that is already on screen REPLACES
   * that row where it stands rather than stacking below it; the fade timer restarts.
   */
  readonly key?: string;
}

export interface ToastEntry {
  readonly id: string;
  readonly message: string;
  readonly lifetime: ToastLifetime;
  readonly key: string | null;
  /** Fading out: still occupies its slot for the animation, but is inert. */
  readonly leaving: boolean;
}

export interface ToastApi {
  /** Shows a notice and returns its id. */
  readonly notify: (message: string, options?: ToastOptions) => string;
  /** Fades a notice out early; unknown ids are a no-op. */
  readonly dismiss: (id: string) => void;
}

/** Beyond this the stack stops being readable, so the oldest row gives way. */
export const MAX_VISIBLE_TOASTS = 4;
/** How long a `toast` sits before it starts fading. */
export const TOAST_LIFETIME_MS = 5000;
/** Must match the `.toast--leaving` transition in styles.css. */
export const TOAST_FADE_MS = 220;

/**
 * Which row gives way when the stack overflows, oldest-first within each tier:
 * already-fading rows first (they were leaving anyway), then plain toasts, and only
 * when the whole stack is sticky does a sticky failure get pushed off. Without the
 * tiering a burst of drag refusals could silently evict a connection failure.
 */
export function evictionIndex(queue: readonly ToastEntry[]): number {
  for (let index = queue.length - 1; index >= 0; index -= 1) {
    if (queue[index]?.leaving === true) return index;
  }
  for (let index = queue.length - 1; index >= 0; index -= 1) {
    if (queue[index]?.lifetime === "toast") return index;
  }
  return queue.length - 1;
}

/** Newest-first insert with key supersession and overflow eviction. */
export function pushToast(queue: readonly ToastEntry[], entry: ToastEntry): readonly ToastEntry[] {
  if (entry.key !== null) {
    const slot = queue.findIndex((candidate) => candidate.key === entry.key && !candidate.leaving);
    if (slot !== -1) {
      const superseded = [...queue];
      superseded[slot] = entry;
      return superseded;
    }
  }
  const next = [entry, ...queue];
  if (next.length <= MAX_VISIBLE_TOASTS) return next;
  const evicted = evictionIndex(next);
  return [...next.slice(0, evicted), ...next.slice(evicted + 1)];
}

/** Starts the fade of one row; unknown ids leave the queue untouched. */
export function markLeaving(queue: readonly ToastEntry[], id: string): readonly ToastEntry[] {
  let changed = false;
  const next = queue.map((entry) => {
    if (entry.id !== id || entry.leaving) return entry;
    changed = true;
    return { ...entry, leaving: true };
  });
  return changed ? next : queue;
}

/** Drops one row outright; unknown ids leave the queue untouched. */
export function removeToast(queue: readonly ToastEntry[], id: string): readonly ToastEntry[] {
  const next = queue.filter((entry) => entry.id !== id);
  return next.length === queue.length ? queue : next;
}

let sequence = 0;

function nextToastId(): string {
  sequence += 1;
  return `toast-${sequence}`;
}

const ToastContext = createContext<ToastApi | null>(null);

/**
 * Throws rather than degrading to a no-op: a notice nobody can see is exactly the
 * class of bug this module exists to end, so a missing provider must be loud.
 */
export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (api === null) throw new Error("useToast requires a <ToastProvider> ancestor");
  return api;
}

interface ToastProviderProps {
  readonly children: ReactNode;
}

/** Hosts the one notice stack and hands every descendant the same `notify`. */
export function ToastProvider({ children }: ToastProviderProps): ReactElement {
  const [queue, setQueue] = useState<readonly ToastEntry[]>([]);
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
      later(() => setQueue((current) => removeToast(current, id)), TOAST_FADE_MS);
    },
    [later],
  );

  const notify = useCallback(
    (message: string, options?: ToastOptions): string => {
      const lifetime = options?.lifetime ?? "toast";
      const id = nextToastId();
      setQueue((current) =>
        pushToast(current, {
          id,
          message,
          lifetime,
          key: options?.key ?? null,
          leaving: false,
        }),
      );
      if (lifetime === "toast") later(() => retire(id), TOAST_LIFETIME_MS);
      return id;
    },
    [later, retire],
  );

  const api = useMemo<ToastApi>(() => ({ notify, dismiss: retire }), [notify, retire]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      {/* Fixed, pointer-transparent, and outside every renderer: the layer never
          steals a canvas drag, and no collapse state can hide it. */}
      <div className="toast-layer">
        {queue.map((entry) => (
          <div
            key={entry.id}
            className={`toast toast--${entry.lifetime}${entry.leaving ? " toast--leaving" : ""}`}
            role={entry.lifetime === "sticky" ? "alert" : "status"}
          >
            <span className="toast-message">{entry.message}</span>
            <button
              className="toast-dismiss"
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
    </ToastContext.Provider>
  );
}
