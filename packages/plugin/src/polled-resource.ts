/**
 * THE workspace poll: one timer, one request and one snapshot per RESOURCE, however many
 * components read it.
 *
 * The workspace index is HTTP, not a live channel: this tab learns that another tab created a
 * container, parked a terminal, or joined a room only by asking again. That is a ratified
 * wave-1 interim (the session socket already carries per-room fan-out; wave 2 turns every
 * caller of {@link usePolledResource} into a subscription and deletes the intervals). What is
 * NOT ratified, and is the defect this module exists to close, is polling the same door once
 * per COMPONENT: the shell and the index section each wanted the container index, the terminal
 * listing and the attendance roster, so one idle tab asked five doors 232 times a minute and
 * re-rendered the whole workspace on every answer — including the answers that had not changed.
 *
 * Three rules, all of them load-bearing:
 *
 * - ONE FEED PER RESOURCE. Subscribers naming the same `key` share a timer, an in-flight
 *   request and a published value. N readers cost one request, not N.
 * - CONTENT, NOT ARRIVAL. A response equal to the published one is dropped before it reaches
 *   any subscriber, so a steady workspace re-renders NOBODY on a tick. Equality is a structural
 *   digest by default, because a per-resource comparator is a per-resource chance to forget one.
 * - NOBODY POLLS A HIDDEN TAB. The timer stops with `document.hidden` and the feed refreshes
 *   once on the way back, so a backgrounded workspace costs zero requests instead of thirty a
 *   minute forever.
 *
 * The published value is read through `useSyncExternalStore`, so "unchanged" is not merely a
 * cheap re-render — it is no render at all.
 */

import { useCallback, useDebugValue, useEffect, useRef, useSyncExternalStore } from "react";
import type { Dispatch, SetStateAction } from "react";

/**
 * THE polled-resource vocabulary: one name per door the browser half asks on a timer.
 *
 * It is a table rather than string literals at the call sites for the reason every other
 * registry in this tree is: two components meaning the same resource must SPELL it the same,
 * or they get two feeds, two timers and two requests — which is precisely the defect these
 * names exist to make impossible to reintroduce quietly. The budget gate reads these same
 * names, so a resource that grows a second poller shows up as a rate, not as a mystery.
 */
export const INDEX_RESOURCE = "core.index.read";
export const TERMINALS_RESOURCE = "core.terminals.listAll";
export const CONTAINER_TERMINALS_RESOURCE = "core.terminals.listByContainer";
export const ATTENDANCE_RESOURCE = "attendance";
export const MACHINES_RESOURCE = "core.machines.list";

/** How the poll compares an incoming answer with the published one. */
export type PolledEquality<T> = (current: T, incoming: T) => boolean;

export interface PolledResourceOptions<T> {
  /**
   * THE resource being read — `core.index.read`, `core.terminals.listAll`, `attendance`. Every
   * subscriber naming it shares one poller, so this is a resource name and never a component
   * name: two components polling `"attendance"` under two keys is the defect, spelled quietly.
   */
  readonly key: string;
  /** The value before the first response settles; read once, like any `useState` seed. */
  readonly initial: T;
  /** While false this subscriber neither fetches nor keeps the feed's timer alive. */
  readonly enabled?: boolean;
  /**
   * Consulted when a response settles: true drops it. A held response is never queued — the
   * next tick asks again — so pausing costs one stale interval and never a burst on release.
   * ANY subscriber's hold holds the shared feed, because a response that would land mid-gesture
   * lands mid-gesture for everyone reading it.
   */
  readonly hold?: () => boolean;
  /**
   * Content comparison, when the default structural digest is wrong for a resource (a field
   * that moves every tick and means nothing, say). An equal response never reaches state.
   */
  readonly equal?: PolledEquality<T>;
  readonly onError?: (reason: unknown) => void;
  /**
   * Anything outside the fetch that makes the answer stale right now — a route id, a count a
   * placement just moved. It PARTITIONS the feed: two routes are two answers, never one answer
   * racing itself, and arriving at a new value fetches immediately.
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
 * Structural equality by digest.
 *
 * A digest rather than a deep walk because these payloads are wire JSON — a few hundred bytes,
 * arrays of flat records — and the comparison runs at most twice a second per resource. It is
 * ORDER-SENSITIVE over object keys, which is correct here: both sides come from the same
 * serializer on the same server, and a key order that genuinely moved would be a changed
 * answer. `undefined` never appears in a parsed response, so its erasure cannot hide a change.
 */
function digest(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "\u0000undefined";
  } catch {
    // Cyclic or non-serializable: refuse to claim equality rather than guess one.
    return `\u0000nondigestible:${String(Math.random())}`;
  }
}

interface Subscriber {
  readonly intervalMs: number;
  readonly hold: () => boolean | undefined;
  readonly onError: (reason: unknown) => void;
  readonly notify: () => void;
}

interface Feed {
  /** The freshest published answer. Identity is stable while the CONTENT is unchanged. */
  value: unknown;
  /** Digest of `value`, so an unchanged answer costs one string compare and no re-render. */
  stamp: string;
  seeded: boolean;
  fetchFn: () => Promise<unknown>;
  equal: PolledEquality<never> | undefined;
  timer: number | null;
  /** Bumped when the feed is torn down, so a late response cannot revive a dead route. */
  generation: number;
  inFlight: boolean;
  subscribers: Set<Subscriber>;
}

const FEEDS = new Map<string, Feed>();

/** Every live feed re-arms behind ONE visibility listener rather than one per subscriber. */
let visibilityBound = false;

/** SSR-safe read of the one condition that stops every timer in this module. */
const isHidden = (): boolean => typeof document !== "undefined" && document.hidden;

function cadence(feed: Feed): number | null {
  let smallest: number | null = null;
  for (const subscriber of feed.subscribers) {
    if (smallest === null || subscriber.intervalMs < smallest) smallest = subscriber.intervalMs;
  }
  return smallest;
}

function arm(feed: Feed): void {
  if (feed.timer !== null) {
    window.clearInterval(feed.timer);
    feed.timer = null;
  }
  const intervalMs = cadence(feed);
  if (intervalMs === null || isHidden()) return;
  feed.timer = window.setInterval(() => {
    fetchOnce(feed);
  }, intervalMs);
}

function publish(feed: Feed, incoming: unknown): void {
  const equal = feed.equal as PolledEquality<unknown> | undefined;
  if (
    feed.seeded &&
    (equal === undefined ? digest(incoming) === feed.stamp : equal(feed.value, incoming))
  ) {
    return;
  }
  feed.value = incoming;
  feed.stamp = digest(incoming);
  feed.seeded = true;
  for (const subscriber of [...feed.subscribers]) subscriber.notify();
}

function fetchOnce(feed: Feed): void {
  if (feed.inFlight || feed.subscribers.size === 0) return;
  feed.inFlight = true;
  const issued = feed.generation;
  void feed
    .fetchFn()
    .then((incoming) => {
      if (issued !== feed.generation) return;
      for (const subscriber of feed.subscribers) {
        if (subscriber.hold() === true) return;
      }
      publish(feed, incoming);
    })
    .catch((reason: unknown) => {
      if (issued !== feed.generation) return;
      for (const subscriber of [...feed.subscribers]) subscriber.onError(reason);
    })
    .finally(() => {
      feed.inFlight = false;
    });
}

function bindVisibility(): void {
  if (visibilityBound || typeof document === "undefined") return;
  visibilityBound = true;
  document.addEventListener("visibilitychange", () => {
    for (const feed of FEEDS.values()) {
      arm(feed);
      // Coming back: the tab owes itself one answer immediately, not one interval from now.
      if (!isHidden()) fetchOnce(feed);
    }
  });
}

/**
 * Test seam and teardown: drops every feed. Exported because a feed outlives the component
 * that opened it by design, which in a test process means it outlives the test.
 */
export function resetPolledResources(): void {
  for (const feed of FEEDS.values()) {
    feed.generation += 1;
    if (feed.timer !== null) window.clearInterval(feed.timer);
    feed.timer = null;
    feed.subscribers.clear();
  }
  FEEDS.clear();
}

/** What the poll is doing right now, for the browser-half budget gate and for tests. */
export interface PolledFeedReport {
  readonly key: string;
  readonly subscribers: number;
  readonly intervalMs: number | null;
}

export function polledFeedReport(): readonly PolledFeedReport[] {
  return [...FEEDS.entries()].map(([key, feed]) => ({
    key,
    subscribers: feed.subscribers.size,
    intervalMs: cadence(feed),
  }));
}

/**
 * `fetchFn` identity no longer restarts anything — the FEED owns the timer — but it is still
 * read late, so it may be written inline. What partitions a feed is `key` plus `restartKey`.
 */
export function usePolledResource<T>(
  fetchFn: () => Promise<T>,
  intervalMs: number,
  options: PolledResourceOptions<T>,
): PolledResource<T> {
  const { key, initial, enabled = true, hold, equal, onError, restartKey = null } = options;
  const feedId = `${key}|${String(restartKey)}`;

  /** Read late, so a policy written inline per render never churns the shared feed. */
  const policy = useRef({ fetchFn, hold, equal, onError, initial });
  useEffect(() => {
    policy.current = { fetchFn, hold, equal, onError, initial };
  });

  const ensure = useCallback((): Feed => {
    let feed = FEEDS.get(feedId);
    if (feed === undefined) {
      feed = {
        value: policy.current.initial,
        stamp: "\u0000unseeded",
        seeded: false,
        fetchFn: () => policy.current.fetchFn(),
        equal: policy.current.equal as PolledEquality<never> | undefined,
        timer: null,
        generation: 0,
        inFlight: false,
        subscribers: new Set(),
      };
      FEEDS.set(feedId, feed);
    }
    return feed;
  }, [feedId]);

  const subscribe = useCallback(
    (notify: () => void): (() => void) => {
      if (!enabled) return () => undefined;
      bindVisibility();
      const feed = ensure();
      const subscriber: Subscriber = {
        intervalMs,
        hold: () => policy.current.hold?.(),
        onError: (reason) => policy.current.onError?.(reason),
        notify,
      };
      feed.subscribers.add(subscriber);
      arm(feed);
      // A joining subscriber inherits the published answer; only the FIRST one pays a request.
      if (!feed.seeded) fetchOnce(feed);
      return () => {
        feed.subscribers.delete(subscriber);
        if (feed.subscribers.size > 0) {
          arm(feed);
          return;
        }
        feed.generation += 1;
        if (feed.timer !== null) window.clearInterval(feed.timer);
        feed.timer = null;
        FEEDS.delete(feedId);
      };
    },
    [enabled, ensure, feedId, intervalMs],
  );

  const snapshot = useCallback((): T => {
    const feed = FEEDS.get(feedId);
    return feed === undefined || !feed.seeded ? policy.current.initial : (feed.value as T);
  }, [feedId]);

  const value = useSyncExternalStore(subscribe, snapshot, snapshot);
  useDebugValue(feedId);

  const setValue = useCallback<Dispatch<SetStateAction<T>>>(
    (update) => {
      const feed = ensure();
      const current = (feed.seeded ? feed.value : policy.current.initial) as T;
      const next = typeof update === "function" ? (update as (prev: T) => T)(current) : update;
      publish(feed, next);
    },
    [ensure],
  );

  const refresh = useCallback((): void => {
    fetchOnce(ensure());
  }, [ensure]);

  return { value, setValue, refresh };
}
