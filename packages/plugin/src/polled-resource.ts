/**
 * THE workspace feed: one subscription, one request and one snapshot per RESOURCE, however
 * many components read it.
 *
 * WAVE 2 (ADR 0012). The workspace index is no longer HTTP-on-a-timer: a feed names the
 * NODES its answer is news about (`topics`), subscribes to them on the session channel, and
 * re-reads only when a matching event says the world moved. A subscription is not a payload —
 * it says "something happened", and catch-up is reading state through the same door a fresh
 * client uses. A feed chooses its fetch and equality policy from a current subscriber;
 * a reader that changes resources cannot redirect requests still owed to the old one.
 *
 * The timer is the honest fallback: a feed polls while disconnected, event-ineligible or
 * waiting for its subscription ordering fence and catch-up read. An open socket alone is
 * not proof that this viewer receives the feed's events. Only a synchronized, eligible
 * subscription with an accepted catch-up read retires the shared cadence.
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
import type { FeedEvents, SessionStatus } from "./host.ts";

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
 * rate you cannot attribute is an anecdote: `timer` must stay at zero for synchronized,
 * eligible feeds, and the budget gate asserts exactly that (`__manifoldFeeds`).
 */
type ReadReason = "initial" | "event" | "timer" | "manual" | "resume";

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
  /** Accepted reads, including unchanged answers; lets a reader clear a transient error. */
  readonly onSuccess?: () => void;
  /**
   * Anything outside the fetch that makes the answer stale right now — a route id, a count a
   * placement just moved. It PARTITIONS the feed: two routes are two answers, never one answer
   * racing itself, and arriving at a new value fetches immediately.
   */
  readonly restartKey?: string | number | boolean | null;
  /**
   * THE NODES this answer is news about (ADR 0012). The feed declares them, synchronizes the
   * transport and reads a catch-up snapshot before switching to event-only refreshes. Until
   * then it keeps its fallback cadence. Omit topics and the feed always polls.
   */
  readonly topics?: readonly ManifoldRef[];
  /** The door {@link PolledResourceOptions.topics} are declared through; `host.client`. */
  readonly events?: FeedEvents;
  /** Workspace plugin feeds require the caller's explicit live workspace-event hint. */
  readonly requiresWorkspaceEvents?: boolean;
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
  /** The live reader owns its event door just as it owns its fetch callback. */
  readonly binding: Pick<FeedAttachment, "events" | "topics" | "requiresWorkspaceEvents">;
  /** Reading and comparison follow a live reader, never a departed first attachment. */
  readonly fetchFn: () => Promise<unknown>;
  readonly equal: PolledEquality<never> | undefined;
  readonly hold: () => boolean | undefined;
  readonly onError: (reason: unknown) => void;
  readonly onSuccess: (() => void) | undefined;
  readonly notify: () => void;
}

interface Feed {
  /** The freshest published answer. Identity is stable while the CONTENT is unchanged. */
  value: unknown;
  /** Digest of `value`, so an unchanged answer costs one string compare and no re-render. */
  stamp: string;
  seeded: boolean;
  /** The FALLBACK cadence runs until an eligible subscription has synchronized and caught up. */
  timer: ReturnType<typeof globalThis.setInterval> | null;
  /** Bumped when the feed is torn down, so a late response cannot revive a dead route. */
  generation: number;
  inFlight: boolean;
  subscribers: Set<Subscriber>;
  /** The door this feed is subscribed through, and the nodes it named. */
  events: FeedEvents | null;
  topics: readonly ManifoldRef[];
  /** The topics joined as URIs: what a rebind compares, in one string compare. */
  topicKey: string;
  requiresWorkspaceEvents: boolean;
  /** Retires callbacks from replaced declarations, independently of transport transitions. */
  bindingGeneration: number;
  /** Retires synchronization and qualifying reads on rebind/status/authority changes. */
  authorityEpoch: number;
  syncPending: boolean;
  synchronized: boolean;
  caughtUp: boolean;
  release: (() => void) | null;
  offStatus: (() => void) | null;
  offAuthority: (() => void) | null;
  offVisibility: (() => void) | null;
  /** Whether the channel was up at the last transition this feed heard. */
  live: boolean;
  /** The pending coalesced read; the burst rule lives in this one slot. */
  settle: ReturnType<typeof globalThis.setTimeout> | null;
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

/** A Worker receives its page's visibility; ordinary browser feeds use the document. */
const isHidden = (feed: Feed): boolean =>
  feed.events?.hidden ?? (typeof document !== "undefined" && document.hidden);

function cadence(feed: Feed): number | null {
  let smallest: number | null = null;
  for (const subscriber of feed.subscribers) {
    if (smallest === null || subscriber.intervalMs < smallest) smallest = subscriber.intervalMs;
  }
  return smallest;
}

/** An open socket is usable only when this feed's explicit event audience is eligible. */
function eventEligible(feed: Feed): boolean {
  return (
    feed.release !== null &&
    feed.live &&
    (!feed.requiresWorkspaceEvents || feed.events?.workspaceEventsAvailable() === true)
  );
}

/** The ordering fence precedes the read that qualifies this binding for event-only mode. */
function subscriptionReady(feed: Feed): boolean {
  return feed.synchronized && eventEligible(feed);
}

function subscriptionBacked(feed: Feed): boolean {
  return subscriptionReady(feed) && feed.caughtUp;
}

function arm(feed: Feed): void {
  if (feed.timer !== null) {
    globalThis.clearInterval(feed.timer);
    feed.timer = null;
  }
  const intervalMs = cadence(feed);
  if (intervalMs === null || isHidden(feed) || subscriptionBacked(feed)) return;
  feed.timer = globalThis.setInterval(() => {
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
  feed.settle = globalThis.setTimeout(() => {
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
  const equal = feed.subscribers.values().next().value?.equal as
    PolledEquality<unknown> | undefined;
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
  const reader = feed.subscribers.values().next().value;
  if (reader === undefined) return;
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
  const issued = feed.generation;
  const authorityEpoch = feed.authorityEpoch;
  const qualifies = subscriptionReady(feed);
  void reader
    .fetchFn()
    .then((incoming) => {
      if (issued !== feed.generation) return;
      if (held(feed)) {
        if (reason !== "timer") scheduleRead(feed, reason, HELD_RETRY_MS);
        return;
      }
      publish(feed, incoming);
      for (const subscriber of feed.subscribers) subscriber.onSuccess?.();
      if (authorityEpoch === feed.authorityEpoch && qualifies && subscriptionReady(feed)) {
        feed.caughtUp = true;
        arm(feed);
      }
    })
    .catch((reason_: unknown) => {
      if (issued !== feed.generation) return;
      for (const subscriber of [...feed.subscribers]) subscriber.onError(reason_);
    })
    .finally(() => {
      if (issued !== feed.generation) return;
      feed.inFlight = false;
      // A pre-fence or retired-binding read cannot close the current subscription gap.
      // An already-owed event/held read covers it; failed qualifying reads retain polling.
      if (
        (!qualifies || authorityEpoch !== feed.authorityEpoch) &&
        subscriptionReady(feed) &&
        !feed.caughtUp &&
        feed.settle === null &&
        !isHidden(feed)
      ) {
        fetchOnce(feed, "resume");
      }
    });
}

/** Retire every asynchronous proof of the previous authority/transport binding. */
function retireSynchronization(feed: Feed): void {
  feed.authorityEpoch += 1;
  feed.syncPending = false;
  feed.synchronized = false;
  feed.caughtUp = false;
}

/**
 * One attempt per ordinary activation/transition, never a retry loop. The connection owns
 * the bounded wait and declaration watermark; this feed owns the subsequent qualifying read.
 */
function synchronize(feed: Feed): void {
  const events = feed.events;
  if (events === null || !eventEligible(feed) || feed.syncPending || feed.synchronized) return;
  const issued = feed.generation;
  const authorityEpoch = feed.authorityEpoch;
  feed.syncPending = true;
  const settle = (synced: boolean): void => {
    if (issued !== feed.generation || authorityEpoch !== feed.authorityEpoch) return;
    feed.syncPending = false;
    feed.synchronized = synced && eventEligible(feed);
    arm(feed);
    if (isHidden(feed) || feed.inFlight || feed.settle !== null) return;
    if (feed.synchronized) fetchOnce(feed, feed.seeded ? "resume" : "initial");
    else if (!feed.seeded) fetchOnce(feed, "initial");
  };
  void events.syncSubscriptions().then(settle, () => settle(false));
}

/**
 * Binds a feed to the event plane: one subscription and one set of transport/authority
 * listeners for the whole feed, whatever the number of readers.
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
  requiresWorkspaceEvents: boolean,
): void {
  if (
    feed.events === events &&
    feed.topicKey === topicKey &&
    feed.requiresWorkspaceEvents === requiresWorkspaceEvents
  ) {
    return;
  }
  feed.release?.();
  feed.offStatus?.();
  feed.offAuthority?.();
  feed.offVisibility?.();
  feed.release = null;
  feed.offStatus = null;
  feed.offAuthority = null;
  feed.offVisibility = null;
  feed.events = events;
  feed.topics = topics;
  feed.topicKey = topicKey;
  feed.requiresWorkspaceEvents = requiresWorkspaceEvents;
  feed.bindingGeneration += 1;
  const bindingGeneration = feed.bindingGeneration;
  retireSynchronization(feed);
  feed.live = false;
  feed.offVisibility =
    events?.onVisibilityChange?.(() => {
      if (bindingGeneration === feed.bindingGeneration) observeVisibility(feed);
    }) ?? null;
  if (events === null || topics.length === 0) {
    arm(feed);
    return;
  }
  feed.release = events.subscribe(topics, () => {
    if (bindingGeneration === feed.bindingGeneration) scheduleRead(feed, "event");
  });
  feed.offStatus = events.on("status", (status) => {
    if (bindingGeneration === feed.bindingGeneration) observeStatus(feed, status);
  });
  feed.offAuthority = events.onAuthorityChange(() => {
    if (bindingGeneration !== feed.bindingGeneration) return;
    retireSynchronization(feed);
    arm(feed);
    synchronize(feed);
  });
  feed.live = events.status === "open";
  arm(feed);
  synchronize(feed);
}

/**
 * The channel went up or down. Both retire the preceding ordering/catch-up proof. On return
 * a fresh transport fence and read close the gap; until then the fallback cadence remains.
 */
function observeStatus(feed: Feed, status: SessionStatus): void {
  const live = status === "open";
  if (live === feed.live) return;
  feed.live = live;
  retireSynchronization(feed);
  arm(feed);
  if (live) synchronize(feed);
}

function detach(feed: Feed): void {
  feed.release?.();
  feed.offStatus?.();
  feed.offAuthority?.();
  feed.offVisibility?.();
  feed.release = null;
  feed.offStatus = null;
  feed.offAuthority = null;
  feed.offVisibility = null;
  feed.bindingGeneration += 1;
  retireSynchronization(feed);
  if (feed.timer !== null) globalThis.clearInterval(feed.timer);
  feed.timer = null;
  if (feed.settle !== null) globalThis.clearTimeout(feed.settle);
  feed.settle = null;
}

function observeVisibility(feed: Feed): void {
  // Keep subscriptions while hidden; only the fallback cadence pauses.
  arm(feed);
  if (!isHidden(feed)) {
    synchronize(feed);
    if (!feed.syncPending) fetchOnce(feed, "resume");
  }
}

function bindVisibility(): void {
  if (visibilityBound || typeof document === "undefined") return;
  visibilityBound = true;
  document.addEventListener("visibilitychange", () => {
    for (const feed of FEEDS.values()) {
      if (feed.offVisibility !== null) continue;
      observeVisibility(feed);
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
  /** `events` iff the current eligible subscription has synchronized and caught up. */
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
 * behaviour (one synchronized read, a burst coalesced, and shared fallback while events
 * cannot yet keep the snapshot current) testable without a renderer.
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
  /** Successful accepted reads, independently of whether the value changed. */
  readonly onSuccess?: (() => void) | undefined;
  /** Called when the published answer CHANGES; never on an equal response. */
  readonly notify: () => void;
  readonly events?: FeedEvents | null | undefined;
  readonly topics?: readonly ManifoldRef[] | undefined;
  readonly requiresWorkspaceEvents?: boolean | undefined;
}

function ensureFeed(attachment: Pick<FeedAttachment, "feedId" | "initial">): Feed {
  let feed = FEEDS.get(attachment.feedId);
  if (feed === undefined) {
    feed = {
      value: attachment.initial,
      stamp: "\u0000unseeded",
      seeded: false,
      timer: null,
      generation: 0,
      inFlight: false,
      subscribers: new Set(),
      events: null,
      topics: NO_TOPICS,
      topicKey: "",
      requiresWorkspaceEvents: false,
      bindingGeneration: 0,
      authorityEpoch: 0,
      syncPending: false,
      synchronized: false,
      caughtUp: false,
      release: null,
      offStatus: null,
      offAuthority: null,
      offVisibility: null,
      live: false,
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
    binding: attachment,
    fetchFn: attachment.fetchFn,
    get equal() {
      return attachment.equal;
    },
    hold: () => attachment.hold?.(),
    onError: (reason) => attachment.onError?.(reason),
    onSuccess: attachment.onSuccess,
    notify: attachment.notify,
  };
  feed.subscribers.add(subscriber);
  const topics = attachment.topics ?? NO_TOPICS;
  bindEvents(
    feed,
    attachment.events ?? null,
    topics,
    topics.map(formatManifoldUri).join(" "),
    attachment.requiresWorkspaceEvents ?? false,
  );
  synchronize(feed);
  arm(feed);
  // A joining subscriber inherits the published answer; only the FIRST one pays a request.
  if (!feed.seeded && !feed.inFlight && !feed.syncPending) fetchOnce(feed, "initial");
  return () => {
    feed.subscribers.delete(subscriber);
    const survivor = feed.subscribers.values().next().value;
    if (survivor !== undefined) {
      const topics = survivor.binding.topics ?? NO_TOPICS;
      bindEvents(
        feed,
        survivor.binding.events ?? null,
        topics,
        topics.map(formatManifoldUri).join(" "),
        survivor.binding.requiresWorkspaceEvents ?? false,
      );
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
  requiresWorkspaceEvents = false,
): void {
  const feed = FEEDS.get(feedId);
  if (feed === undefined || feed.subscribers.size === 0) return;
  bindEvents(feed, events, topics, topicKey, requiresWorkspaceEvents);
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
    onSuccess,
    restartKey = null,
    topics = NO_TOPICS,
    events,
    requiresWorkspaceEvents = false,
  } = options;
  const feedId = `${key}|${String(restartKey)}`;
  /**
   * Topics are written inline at every call site (`[host.topics.index]`), so their ARRAY
   * identity changes each render while the addressing does not. The joined URIs are what a
   * rebind must actually key on — and they are the same strings the probe reports.
   */
  const topicKey = topics.map(formatManifoldUri).join(" ");

  /**
   * A subscription captures this committed policy OBJECT, not the ref that points at it.
   * Same-key commits update it in place for fresh inline callbacks; a new key replaces it,
   * leaving the departing subscription bound to its own key until React releases it.
   * Updating only in an effect also keeps abandoned renders out of live reads.
   */
  const policy = useRef({
    feedId,
    fetchFn,
    hold,
    equal,
    onError,
    onSuccess,
    initial,
    events,
    topics,
    requiresWorkspaceEvents,
  });
  useEffect(() => {
    const next = {
      feedId,
      fetchFn,
      hold,
      equal,
      onError,
      onSuccess,
      initial,
      events,
      topics,
      requiresWorkspaceEvents,
    };
    if (policy.current.feedId === feedId) Object.assign(policy.current, next);
    else policy.current = next;
  });

  const ensure = useCallback(
    (): Feed =>
      ensureFeed({
        feedId,
        initial: policy.current.initial,
      }),
    [feedId],
  );

  const subscribe = useCallback(
    (notify: () => void): (() => void) => {
      if (!enabled) return () => undefined;
      const current = policy.current;
      return attachFeed({
        feedId,
        intervalMs,
        initial: current.initial,
        fetchFn: () => current.fetchFn(),
        get equal() {
          return current.equal as PolledEquality<never> | undefined;
        },
        hold: () => current.hold?.(),
        onError: (reason) => current.onError?.(reason),
        onSuccess: () => current.onSuccess?.(),
        notify,
        get events() {
          return current.events ?? null;
        },
        get topics() {
          return current.topics;
        },
        get requiresWorkspaceEvents() {
          return current.requiresWorkspaceEvents;
        },
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
    rebindFeed(feedId, events ?? null, policy.current.topics, topicKey, requiresWorkspaceEvents);
  }, [enabled, events, feedId, topicKey, requiresWorkspaceEvents]);

  const snapshot = useCallback((): T => {
    const feed = FEEDS.get(feedId);
    return feed === undefined || !feed.seeded ? initial : (feed.value as T);
  }, [feedId, initial]);

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
