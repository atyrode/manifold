/**
 * THE workspace feed: one subscription, one request and one snapshot per RESOURCE, however
 * many components read it.
 *
 * WAVE 2 (ADR 0012). The workspace index is no longer HTTP-on-a-timer: a feed names the
 * NODES its answer is news about (`topics`), subscribes to them on the session channel, and
 * re-reads only when a matching event says the world moved. A subscription is not a payload —
 * it says "something happened", and catch-up is reading state through the same door a fresh
 * client uses — so a feed still owns exactly one fetch function, and the call sites changed
 * their OPTIONS and nothing else.
 *
 * What is left of the timer is the honest fallback and only that: while the socket is DOWN
 * (or a feed has no topics at all, which is the workspace root before any room exists) the
 * cadence returns, because a client with no channel learns nothing by waiting. It never runs
 * beside a live subscription — the two are exclusive by construction in {@link arm}.
 *
 * The defect this module exists to close is unchanged and predates the event plane: polling —
 * now subscribing — the same door once per COMPONENT. The shell and the index section each
 * wanted the container index, the terminal listing and the attendance roster, so one idle tab
 * asked five doors 232 times a minute and re-rendered the whole workspace on every answer,
 * including the answers that had not changed.
 *
 * Four rules, all of them load-bearing:
 *
 * - ONE FEED PER RESOURCE. Subscribers naming the same `key` share a subscription, an
 *   in-flight request and a published value. N readers cost one request, not N.
 * - CONTENT, NOT ARRIVAL. A response equal to the published one is dropped before it reaches
 *   any subscriber, so a steady workspace re-renders NOBODY. Equality is a structural digest
 *   by default, because a per-resource comparator is a per-resource chance to forget one.
 * - ONE READ PER BURST. Five commits inside a settle window are one refetch, not five: the
 *   answer is a whole collection, so the second event through the door describes a read the
 *   first one has already earned.
 * - NOBODY POLLS A HIDDEN TAB. The fallback timer stops with `document.hidden` and the feed
 *   reads once on the way back. Subscriptions are NOT dropped when a tab hides — a socket
 *   already open costs nothing, and dropping them would trade zero requests for a resubscribe
 *   and a catch-up read on every tab switch.
 *
 * The published value is read through `useSyncExternalStore`, so "unchanged" is not merely a
 * cheap re-render — it is no render at all.
 */

import { useCallback, useDebugValue, useEffect, useRef, useSyncExternalStore } from "react";
import type { Dispatch, SetStateAction } from "react";
import { formatManifoldUri, type ManifoldRef } from "@manifold/protocol";
import { debugProbeEnabled } from "./debug-probe.ts";
import type { SessionStatus } from "./host.ts";

/**
 * THE feed vocabulary: one name per collection the browser half reads.
 *
 * It is a table rather than string literals at the call sites for the reason every other
 * registry in this tree is: two components meaning the same resource must SPELL it the same,
 * or they get two feeds, two subscriptions and two requests — which is precisely the defect
 * these names exist to make impossible to reintroduce quietly. The budget gate reads these
 * same names, so a resource that grows a second reader shows up as a rate, not as a mystery.
 */
export const INDEX_RESOURCE = "core.index.read";
export const TERMINALS_RESOURCE = "core.terminals.listAll";
export const CONTAINER_TERMINALS_RESOURCE = "core.terminals.listByContainer";
export const ATTENDANCE_RESOURCE = "attendance";
export const MACHINES_RESOURCE = "core.machines.list";

/**
 * THE fallback cadence, and the only reason a number like this still exists (ADR 0012, wave 2).
 *
 * Every feed names the collection nodes its answer is news about and refreshes on an event;
 * this is what happens while there is no session channel to carry one — a dropped socket, or
 * the workspace root of a brand-new workspace, which has no room and therefore nothing to
 * subscribe through. It is never a rate a live workspace pays.
 *
 * ONE default, deliberately, and one place to read it: a per-section constant is a per-section
 * chance to pick a different number for the same fallback, which is exactly what happened
 * before the shared feed (the attendance roster ran at 1.5s in the shell and 2s in the index —
 * two rates for one resource, chosen by nobody). A feed with a genuine reason to differ still
 * passes its own interval; nothing has one yet.
 */
export const FALLBACK_POLL_MS = 2_000;

/**
 * How long a burst of commits is allowed to coalesce into ONE read. Long enough that the
 * five events a multi-step gesture commits (create, place, rename) cost one request; short
 * enough that nobody watching two windows side by side can see the lag — the round trip it
 * precedes is itself longer than this.
 */
const EVENT_SETTLE_MS = 50;

/**
 * How long an owed read waits out a gesture. A drag holds every feed — an answer landing
 * mid-drag would move the rows under the pointer — and with no cadence behind an event the
 * read must be re-offered rather than dropped. Slower than the settle window because the
 * thing it is waiting for is a human finishing a movement, not a server finishing a commit.
 */
const HELD_RETRY_MS = 250;

/**
 * How long a hold may starve an owed read before it lands anyway. A hold is a claim that a
 * HUMAN is mid-gesture; no real gesture freezes an index for ten seconds, but a leaked hold
 * predicate (a drag state a foreign drop never cleared — it happened, gate-caught) would
 * otherwise starve a subscription-backed feed FOREVER, because no timer stands behind it.
 * One row-churn under a phantom pointer beats permanent staleness.
 */
const HELD_STARVATION_MS = 10_000;

/**
 * Why a read was issued. Kept per feed because the whole claim of this wave is a RATE, and a
 * rate you cannot attribute is an anecdote: `timer` must stay at zero while a socket is up,
 * and the budget gate asserts exactly that (`__manifoldFeeds`).
 */
type ReadReason = "initial" | "event" | "timer" | "manual" | "resume";

/**
 * The event-plane door a feed subscribes through — {@link SessionHandle} narrowed to the
 * three members this module uses, so a test may hand it a socket made of two closures and
 * the engine never imports the SDK.
 */
export interface FeedEvents {
  subscribe(topics: readonly ManifoldRef[], handler: (event: unknown) => void): () => void;
  readonly status: SessionStatus;
  on(event: "status", fn: (status: SessionStatus) => void): () => void;
}

/** How the feed compares an incoming answer with the published one. */
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
   * Consulted when a response settles: true drops it. ANY subscriber's hold holds the shared
   * feed, because a response that would land mid-gesture lands mid-gesture for everyone
   * reading it. A held EVENT refresh is not lost — with no timer behind it there would be no
   * next tick to ask again, so it is re-attempted until the gesture ends.
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
  /**
   * THE NODES this answer is news about (ADR 0012). Given them, the feed subscribes and the
   * timer is gone for as long as the socket is up: it reads once at mount, once more when the
   * channel goes live (the mount read predates the subscription, and that gap is real), and
   * afterwards only when a matching event arrives. Omit them and the feed polls, which is
   * what the workspace root — no room, therefore no channel — honestly still does.
   */
  readonly topics?: readonly ManifoldRef[];
  /** The door {@link PolledResourceOptions.topics} are declared through; `host.client`. */
  readonly events?: FeedEvents;
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
  /** The FALLBACK cadence's handle. Non-null only while no live subscription is standing. */
  timer: number | null;
  /** Bumped when the feed is torn down, so a late response cannot revive a dead route. */
  generation: number;
  inFlight: boolean;
  subscribers: Set<Subscriber>;
  /** The door this feed is subscribed through, and the nodes it named. */
  events: FeedEvents | null;
  topics: readonly ManifoldRef[];
  /** The topics joined as URIs: what a rebind compares, in one string compare. */
  topicKey: string;
  release: (() => void) | null;
  offStatus: (() => void) | null;
  /** Whether the channel was up at the last transition this feed heard. */
  live: boolean;
  /**
   * Whether the last read was ISSUED while live. False means the answer predates the
   * subscription that now stands, which is precisely the gap a catch-up read closes.
   */
  lastReadLive: boolean;
  /** The pending coalesced read; the burst rule lives in this one slot. */
  settle: number | null;
  /** When the current hold began; null while unheld. Feeds the starvation cap. */
  heldSince: number | null;
  reads: { initial: number; event: number; timer: number; manual: number; resume: number };
}

const FEEDS = new Map<string, Feed>();

/** One shared empty: a feed with no topics is the poll, and it should not allocate to say so. */
const NO_TOPICS: readonly ManifoldRef[] = [];

/** Every live feed re-arms behind ONE visibility listener rather than one per subscriber. */
let visibilityBound = false;

/** The feed probe is installed once per document, on the first feed that opens. */
let feedProbeBound = false;

/** SSR-safe read of the one condition that stops every timer in this module. */
const isHidden = (): boolean => typeof document !== "undefined" && document.hidden;

function cadence(feed: Feed): number | null {
  let smallest: number | null = null;
  for (const subscriber of feed.subscribers) {
    if (smallest === null || subscriber.intervalMs < smallest) smallest = subscriber.intervalMs;
  }
  return smallest;
}

/**
 * A subscription-backed feed on a live channel is the ONE state with no timer, and this is
 * where that exclusivity is enforced rather than promised: every path that could change
 * either half — a subscriber joining or leaving, a status transition, a tab hiding — re-arms
 * through here, so there is no arrangement of them that leaves a cadence running beside a
 * standing subscription.
 */
function subscriptionBacked(feed: Feed): boolean {
  return feed.release !== null && feed.live;
}

function arm(feed: Feed): void {
  if (feed.timer !== null) {
    window.clearInterval(feed.timer);
    feed.timer = null;
  }
  const intervalMs = cadence(feed);
  if (intervalMs === null || isHidden() || subscriptionBacked(feed)) return;
  feed.timer = window.setInterval(() => {
    fetchOnce(feed, "timer");
  }, intervalMs);
}

/** Whether any reader is mid-gesture, in which case an arriving answer must not land. */
function held(feed: Feed): boolean {
  for (const subscriber of feed.subscribers) {
    if (subscriber.hold() === true) {
      feed.heldSince ??= Date.now();
      if (Date.now() - feed.heldSince >= HELD_STARVATION_MS) return false;
      return true;
    }
  }
  feed.heldSince = null;
  return false;
}

/**
 * Coalesces a burst into one read. The second event through the door while a read is owed
 * describes a world that read will already report, so it costs nothing — which is what makes
 * a five-commit gesture one request instead of five.
 *
 * A gesture in progress does not cancel the read, it postpones it: without a timer behind it
 * there is no next tick to ask again, so the news would be lost until the next commit.
 */
function scheduleRead(feed: Feed, reason: ReadReason, delayMs = EVENT_SETTLE_MS): void {
  if (feed.settle !== null) return;
  const issued = feed.generation;
  feed.settle = window.setTimeout(() => {
    feed.settle = null;
    if (issued !== feed.generation || feed.subscribers.size === 0) return;
    if (held(feed)) {
      scheduleRead(feed, reason, HELD_RETRY_MS);
      return;
    }
    fetchOnce(feed, reason);
  }, delayMs);
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

function fetchOnce(feed: Feed, reason: ReadReason): void {
  if (feed.subscribers.size === 0) return;
  if (feed.inFlight) {
    /*
      A read already on the wire may have left before the commit this reason knows about, and
      a notification is not repeated. The timer's own tick is the one reason that may be
      dropped: another is a cadence away.
     */
    if (reason !== "timer") scheduleRead(feed, reason);
    return;
  }
  feed.inFlight = true;
  feed.reads[reason] += 1;
  feed.lastReadLive = subscriptionBacked(feed);
  const issued = feed.generation;
  void feed
    .fetchFn()
    .then((incoming) => {
      if (issued !== feed.generation) return;
      if (held(feed)) {
        if (reason !== "timer") scheduleRead(feed, reason, HELD_RETRY_MS);
        return;
      }
      publish(feed, incoming);
    })
    .catch((reason_: unknown) => {
      if (issued !== feed.generation) return;
      for (const subscriber of [...feed.subscribers]) subscriber.onError(reason_);
    })
    .finally(() => {
      feed.inFlight = false;
    });
}

/**
 * Binds a feed to the event plane: one subscription for the whole feed, whatever the number
 * of readers, and one status listener behind it.
 *
 * Rebinding matters as much as binding. The workspace's session handle is rebuilt when the
 * viewer navigates to another container, and the feed outlives that — so a feed holding a
 * subscription on a retired socket would fall silent while looking subscribed.
 */
function bindEvents(
  feed: Feed,
  events: FeedEvents | null,
  topics: readonly ManifoldRef[],
  topicKey: string,
): void {
  if (feed.events === events && feed.topicKey === topicKey) return;
  feed.release?.();
  feed.offStatus?.();
  feed.release = null;
  feed.offStatus = null;
  feed.events = events;
  feed.topics = topics;
  feed.topicKey = topicKey;
  feed.live = false;
  /*
    Whatever this feed holds was read through a channel that is no longer the one delivering
    its news, so the answer is owed a catch-up read: either the initial one its first
    subscriber is about to pay, or — if it is already seeded — the one below.
   */
  feed.lastReadLive = false;
  if (events === null || topics.length === 0) {
    arm(feed);
    return;
  }
  feed.release = events.subscribe(topics, () => {
    scheduleRead(feed, "event");
  });
  feed.offStatus = events.on("status", (status) => {
    observeStatus(feed, status);
  });
  // Seeded straight from the door rather than through `observeStatus`, so binding onto an
  // already-open channel is not mistaken for a transition and charged a second read.
  feed.live = events.status === "open";
  arm(feed);
  if (feed.live && feed.seeded) fetchOnce(feed, "resume");
}

/**
 * The channel went up or down. Going down re-arms the cadence, which is the whole of the
 * fallback; coming up kills it and pays the ONE read that a subscription cannot: whatever
 * happened while nobody was listening (ADR 0012 §5 — catch-up is reading state, never a
 * replayed backlog).
 */
function observeStatus(feed: Feed, status: SessionStatus): void {
  const live = status === "open";
  if (live === feed.live) return;
  feed.live = live;
  arm(feed);
  if (!live) {
    // From here the feed hears nothing, so whatever it holds is owed a catch-up on return —
    // however fresh a cadence read makes it look in the meantime.
    feed.lastReadLive = false;
    return;
  }
  if (!feed.lastReadLive) fetchOnce(feed, "resume");
}

function detach(feed: Feed): void {
  feed.release?.();
  feed.offStatus?.();
  feed.release = null;
  feed.offStatus = null;
  if (feed.timer !== null) window.clearInterval(feed.timer);
  feed.timer = null;
  if (feed.settle !== null) window.clearTimeout(feed.settle);
  feed.settle = null;
}

function bindVisibility(): void {
  if (visibilityBound || typeof document === "undefined") return;
  visibilityBound = true;
  document.addEventListener("visibilitychange", () => {
    for (const feed of FEEDS.values()) {
      // Subscriptions are NOT dropped for a hidden tab: an open socket costs nothing, and a
      // feed that unsubscribed would owe a resubscribe and a catch-up read per tab switch.
      arm(feed);
      // Coming back: the tab owes itself one answer immediately, not one interval from now.
      if (!isHidden()) fetchOnce(feed, "resume");
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
    detach(feed);
    feed.subscribers.clear();
  }
  FEEDS.clear();
}

/** What each feed is doing right now, for the browser-half budget gate and for tests. */
export interface PolledFeedReport {
  readonly key: string;
  readonly subscribers: number;
  /** `events` iff a subscription is standing on a live channel — the no-timer state. */
  readonly mode: "events" | "timer";
  readonly live: boolean;
  /** The subscribed nodes as `manifold://` URIs. */
  readonly topics: readonly string[];
  /** The ARMED cadence, or null when no timer is running at all. */
  readonly intervalMs: number | null;
  /** Cumulative reads by reason. `timer` at zero is this wave's whole claim. */
  readonly reads: {
    readonly initial: number;
    readonly event: number;
    readonly timer: number;
    readonly manual: number;
    readonly resume: number;
  };
}

export function polledFeedReport(): readonly PolledFeedReport[] {
  return [...FEEDS.entries()].map(([key, feed]) => ({
    key,
    subscribers: feed.subscribers.size,
    mode: subscriptionBacked(feed) ? "events" : "timer",
    live: feed.live,
    topics: feed.topics.map(formatManifoldUri),
    intervalMs: feed.timer === null ? null : cadence(feed),
    reads: { ...feed.reads },
  }));
}

/**
 * The one browser-observable seam onto the feeds, installed behind the same opt-in flag as
 * the canvas probe (`localStorage["manifold:debug"]`). It is separate from `window.__manifold`
 * deliberately: that probe is installed by a RENDERER and dies with the canvas mount, while
 * feeds are floor and outlive every view. The budget gate reads `reads.timer === 0` here to
 * prove a zero row is a subscription rather than a corpse.
 */
function installFeedProbe(): void {
  if (feedProbeBound || typeof window === "undefined" || !debugProbeEnabled()) return;
  feedProbeBound = true;
  window.__manifoldFeeds = polledFeedReport;
}

/**
 * WHAT ONE READER BRINGS to a shared feed. {@link usePolledResource} is the React adapter
 * over this and adds nothing but ref discipline — which is also what makes the feed's real
 * behaviour (one read, a burst coalesced, a cadence that only exists while the socket is
 * down) testable without a renderer.
 */
export interface FeedAttachment {
  /** `key|restartKey`: what partitions one resource's answers. */
  readonly feedId: string;
  /** The cadence this reader would accept as a FALLBACK; the smallest one wins. */
  readonly intervalMs: number;
  readonly initial: unknown;
  readonly fetchFn: () => Promise<unknown>;
  readonly equal?: PolledEquality<never> | undefined;
  readonly hold?: (() => boolean | undefined) | undefined;
  readonly onError?: ((reason: unknown) => void) | undefined;
  /** Called when the published answer CHANGES; never on an equal response. */
  readonly notify: () => void;
  readonly events?: FeedEvents | null | undefined;
  readonly topics?: readonly ManifoldRef[] | undefined;
}

function ensureFeed(attachment: FeedAttachment): Feed {
  let feed = FEEDS.get(attachment.feedId);
  if (feed === undefined) {
    feed = {
      value: attachment.initial,
      stamp: "\u0000unseeded",
      seeded: false,
      fetchFn: attachment.fetchFn,
      equal: attachment.equal,
      timer: null,
      generation: 0,
      inFlight: false,
      subscribers: new Set(),
      events: null,
      topics: NO_TOPICS,
      topicKey: "",
      release: null,
      offStatus: null,
      live: false,
      lastReadLive: false,
      settle: null,
      heldSince: null,
      reads: { initial: 0, event: 0, timer: 0, manual: 0, resume: 0 },
    };
    FEEDS.set(attachment.feedId, feed);
  }
  return feed;
}

/**
 * Joins a reader to its resource's feed and answers the release. The FIRST reader pays the
 * initial read and opens the subscription; every later one inherits both, which is the whole
 * of "N readers cost one request". The last one to leave takes the feed with it.
 */
export function attachFeed(attachment: FeedAttachment): () => void {
  bindVisibility();
  installFeedProbe();
  const feed = ensureFeed(attachment);
  const subscriber: Subscriber = {
    intervalMs: attachment.intervalMs,
    hold: () => attachment.hold?.(),
    onError: (reason) => attachment.onError?.(reason),
    notify: attachment.notify,
  };
  feed.subscribers.add(subscriber);
  const topics = attachment.topics ?? NO_TOPICS;
  bindEvents(feed, attachment.events ?? null, topics, topics.map(formatManifoldUri).join(" "));
  arm(feed);
  // A joining subscriber inherits the published answer; only the FIRST one pays a request.
  if (!feed.seeded) fetchOnce(feed, "initial");
  return () => {
    feed.subscribers.delete(subscriber);
    if (feed.subscribers.size > 0) {
      arm(feed);
      return;
    }
    feed.generation += 1;
    detach(feed);
    FEEDS.delete(attachment.feedId);
  };
}

/** Rebinds a live feed's event door; see {@link bindEvents} for why a rebind must exist. */
export function rebindFeed(
  feedId: string,
  events: FeedEvents | null,
  topics: readonly ManifoldRef[],
  topicKey: string,
): void {
  const feed = FEEDS.get(feedId);
  if (feed === undefined || feed.subscribers.size === 0) return;
  bindEvents(feed, events, topics, topicKey);
}

/**
 * `fetchFn` identity no longer restarts anything — the FEED owns the reading — but it is
 * still read late, so it may be written inline. What partitions a feed is `key` plus
 * `restartKey`; what decides whether it subscribes or polls is `topics` plus `events`.
 */
export function usePolledResource<T>(
  fetchFn: () => Promise<T>,
  intervalMs: number,
  options: PolledResourceOptions<T>,
): PolledResource<T> {
  const {
    key,
    initial,
    enabled = true,
    hold,
    equal,
    onError,
    restartKey = null,
    topics = NO_TOPICS,
    events,
  } = options;
  const feedId = `${key}|${String(restartKey)}`;
  /**
   * Topics are written inline at every call site (`[host.topics.index]`), so their ARRAY
   * identity changes each render while the addressing does not. The joined URIs are what a
   * rebind must actually key on — and they are the same strings the probe reports.
   */
  const topicKey = topics.map(formatManifoldUri).join(" ");

  /**
   * Read late, so a policy written inline per render never churns the shared feed — and the
   * same for the event door and its topics, which the store's `subscribe` must reach without
   * naming them as dependencies: one changed identity there and React would tear the feed
   * down and rebuild it on every parent render.
   */
  const policy = useRef({ fetchFn, hold, equal, onError, initial });
  const wiring = useRef({ events, topics, topicKey });
  useEffect(() => {
    policy.current = { fetchFn, hold, equal, onError, initial };
    wiring.current = { events, topics, topicKey };
  });

  const ensure = useCallback(
    (): Feed =>
      ensureFeed({
        feedId,
        intervalMs,
        initial: policy.current.initial,
        fetchFn: () => policy.current.fetchFn(),
        equal: policy.current.equal as PolledEquality<never> | undefined,
        notify: () => undefined,
      }),
    [feedId, intervalMs],
  );

  const subscribe = useCallback(
    (notify: () => void): (() => void) => {
      if (!enabled) return () => undefined;
      const { events: door, topics: nodes } = wiring.current;
      return attachFeed({
        feedId,
        intervalMs,
        initial: policy.current.initial,
        fetchFn: () => policy.current.fetchFn(),
        equal: policy.current.equal as PolledEquality<never> | undefined,
        hold: () => policy.current.hold?.(),
        onError: (reason) => policy.current.onError?.(reason),
        notify,
        events: door,
        topics: nodes,
      });
    },
    [enabled, feedId, intervalMs],
  );

  /**
   * The workspace's session handle is rebuilt when the viewer navigates to another container,
   * and a shared feed outlives that. Without this the feed would hold a subscription on a
   * retired socket: silent, and looking subscribed.
   */
  useEffect(() => {
    if (!enabled) return;
    rebindFeed(feedId, events ?? null, wiring.current.topics, topicKey);
  }, [enabled, events, feedId, topicKey]);

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
    fetchOnce(ensure(), "manual");
  }, [ensure]);

  return { value, setValue, refresh };
}
