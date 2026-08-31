import { beforeEach, describe, expect, test } from "bun:test";
import type { ManifoldRef } from "@manifold/protocol";
import type { SessionStatus } from "../src/host.ts";
import {
  attachFeed,
  polledFeedReport,
  rebindFeed,
  resetPolledResources,
  type FeedEvents,
} from "../src/polled-resource.ts";

/**
 * THE WAVE-2 CLAIM, measured (ADR 0012): a feed with a live socket reads ONCE and then only
 * when an event says the world moved, a burst of commits is one read, and the cadence exists
 * only while there is no channel to carry an event.
 *
 * The feed store is exercised through {@link attachFeed} rather than through React: the hook
 * adds ref discipline and nothing else, and what has to be defended here is a REQUEST RATE —
 * which is a property of the store, needs a clock nobody has to sleep on, and would otherwise
 * be untestable in a tree with no DOM test runner.
 */

interface Task {
  at: number;
  readonly every: number | null;
  readonly fn: () => void;
}

/** A clock the feeds' timers hang on, so a 60-second idle costs no wall time and no flake. */
class VirtualClock {
  private now = 0;
  private seq = 0;
  private readonly tasks = new Map<number, Task>();

  after(fn: () => void, ms: number, every: number | null): number {
    const id = (this.seq += 1);
    this.tasks.set(id, { at: this.now + ms, every, fn });
    return id;
  }

  clear(id: number | undefined): void {
    if (id !== undefined) this.tasks.delete(id);
  }

  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      let dueId: number | null = null;
      let due: Task | null = null;
      for (const [id, task] of this.tasks) {
        if (task.at > target) continue;
        if (due === null || task.at < due.at) {
          due = task;
          dueId = id;
        }
      }
      if (due === null || dueId === null) break;
      this.now = due.at;
      if (due.every === null) this.tasks.delete(dueId);
      else due.at = this.now + due.every;
      due.fn();
    }
    this.now = target;
  }

  reset(): void {
    this.tasks.clear();
    this.now = 0;
  }

  get pending(): number {
    return this.tasks.size;
  }
}

const clock = new VirtualClock();

const store: Record<string, string> = { "manifold:debug": "1" };

Object.defineProperty(globalThis, "window", {
  configurable: true,
  writable: true,
  value: {
    setTimeout: (fn: () => void, ms: number) => clock.after(fn, ms, null),
    clearTimeout: (id: number | undefined) => clock.clear(id),
    setInterval: (fn: () => void, ms: number) => clock.after(fn, ms, ms),
    clearInterval: (id: number | undefined) => clock.clear(id),
    localStorage: { getItem: (key: string): string | null => store[key] ?? null },
  },
});

Object.defineProperty(globalThis, "document", {
  configurable: true,
  writable: true,
  value: { hidden: false, addEventListener: (): void => undefined },
});

/**
 * Lets every settled promise in the store's read chain land before an assertion reads it.
 * A microtask drain rather than a delay: the reads resolve immediately, and the only thing
 * being waited for is `then`/`catch`/`finally` running — no wall clock is involved anywhere
 * in this file, which is what the virtual clock above exists for.
 */
const flush = async (): Promise<void> => {
  for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
};

const INDEX_TOPIC: ManifoldRef = { kind: "plugin", pluginId: "core.index" };
const MACHINES_TOPIC: ManifoldRef = { kind: "plugin", pluginId: "core.machines" };

interface FakeSocket extends FeedEvents {
  /** Deliver one event to every standing subscription, as the SDK's router would. */
  fire(): void;
  moveTo(status: SessionStatus): void;
  /** How many declarations this socket currently holds, and how many it ever held. */
  readonly standing: number;
  readonly declared: number;
  readonly released: number;
  readonly topics: readonly ManifoldRef[];
}

function fakeSocket(status: SessionStatus = "open"): FakeSocket {
  let current = status;
  let declared = 0;
  let released = 0;
  const listeners = new Set<(next: SessionStatus) => void>();
  const subscriptions = new Set<{
    readonly topics: readonly ManifoldRef[];
    readonly handler: (event: unknown) => void;
  }>();
  return {
    get status() {
      return current;
    },
    get standing() {
      return subscriptions.size;
    },
    get declared() {
      return declared;
    },
    get released() {
      return released;
    },
    get topics() {
      return [...subscriptions].flatMap((record) => record.topics);
    },
    subscribe(topics, handler) {
      declared += 1;
      const record = { topics, handler };
      subscriptions.add(record);
      return () => {
        released += 1;
        subscriptions.delete(record);
      };
    },
    on(_event, fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    fire() {
      for (const record of [...subscriptions]) record.handler({ kind: "container_created" });
    },
    moveTo(next) {
      current = next;
      for (const listener of [...listeners]) listener(next);
    },
  };
}

interface Reader {
  readonly release: () => void;
  readonly reads: () => number;
  readonly notices: () => number;
}

/** One reader on the index feed, counting what it costs the network and what it re-renders. */
function reader(
  events: FeedEvents | null,
  options: {
    readonly topics?: readonly ManifoldRef[];
    readonly feedId?: string;
    readonly hold?: () => boolean;
    readonly answer?: (n: number) => unknown;
  } = {},
): Reader {
  let reads = 0;
  let notices = 0;
  const release = attachFeed({
    feedId: options.feedId ?? "core.index.read|null",
    intervalMs: 2_000,
    initial: null,
    fetchFn: () => {
      reads += 1;
      return Promise.resolve(options.answer === undefined ? { reads } : options.answer(reads));
    },
    notify: () => {
      notices += 1;
    },
    ...(options.hold === undefined ? {} : { hold: options.hold }),
    events,
    topics: options.topics ?? [INDEX_TOPIC],
  });
  return { release, reads: () => reads, notices: () => notices };
}

beforeEach(() => {
  resetPolledResources();
  clock.reset();
});

describe("a subscription-backed feed", () => {
  test("reads once on a live socket and then never on its own", async () => {
    const socket = fakeSocket("open");
    const index = reader(socket);
    await flush();

    expect(index.reads()).toBe(1);
    expect(socket.standing).toBe(1);
    expect(socket.topics).toEqual([INDEX_TOPIC]);

    // A full minute of a quiet workspace: the whole point of the wave.
    clock.advance(60_000);
    await flush();
    expect(index.reads()).toBe(1);

    const [row] = polledFeedReport();
    expect(row?.mode).toBe("events");
    expect(row?.live).toBe(true);
    expect(row?.intervalMs).toBeNull();
    expect(row?.topics).toEqual(["manifold://plugin/core.index"]);
    expect(row?.reads).toEqual({ initial: 1, event: 0, timer: 0, manual: 0, resume: 0 });
    index.release();
  });

  test("a matching event costs exactly one refetch", async () => {
    const socket = fakeSocket("open");
    const index = reader(socket);
    await flush();
    expect(index.reads()).toBe(1);

    socket.fire();
    // Nothing goes out inside the settle window: a burst has not been ruled out yet.
    expect(index.reads()).toBe(1);
    clock.advance(50);
    await flush();

    expect(index.reads()).toBe(2);
    expect(polledFeedReport()[0]?.reads.event).toBe(1);

    clock.advance(60_000);
    await flush();
    expect(index.reads()).toBe(2);
    index.release();
  });

  test("a burst of five commits is one read, not five", async () => {
    const socket = fakeSocket("open");
    const index = reader(socket);
    await flush();

    for (let i = 0; i < 5; i += 1) socket.fire();
    clock.advance(50);
    await flush();

    expect(index.reads()).toBe(2);
    expect(polledFeedReport()[0]?.reads.event).toBe(1);
    index.release();
  });

  test("an event during a gesture is postponed, never dropped", async () => {
    const socket = fakeSocket("open");
    let dragging = true;
    const index = reader(socket, { hold: () => dragging });
    await flush();
    expect(index.reads()).toBe(1);

    socket.fire();
    clock.advance(1_000);
    await flush();
    // Held: the rows must not move under the pointer, and with no cadence behind the event
    // dropping it would lose the change until the next commit.
    expect(index.reads()).toBe(1);

    dragging = false;
    clock.advance(250);
    await flush();
    expect(index.reads()).toBe(2);
    index.release();
  });

  test("an unchanged answer reaches nobody", async () => {
    const socket = fakeSocket("open");
    const index = reader(socket, { answer: () => ({ items: [] }) });
    await flush();
    expect(index.notices()).toBe(1);

    socket.fire();
    clock.advance(50);
    await flush();

    expect(index.reads()).toBe(2);
    expect(index.notices()).toBe(1);
    index.release();
  });

  test("two readers of one resource share one subscription and one request", async () => {
    const socket = fakeSocket("open");
    const shell = reader(socket);
    const section = reader(socket);
    await flush();

    expect(shell.reads() + section.reads()).toBe(1);
    expect(socket.declared).toBe(1);
    expect(polledFeedReport()).toHaveLength(1);
    expect(polledFeedReport()[0]?.subscribers).toBe(2);

    shell.release();
    // One reader leaving must not take the other's subscription with it.
    expect(socket.standing).toBe(1);
    section.release();
    expect(socket.standing).toBe(0);
    expect(polledFeedReport()).toHaveLength(0);
  });
});

describe("the fallback cadence", () => {
  test("resumes while the socket is down and stops again when it returns", async () => {
    const socket = fakeSocket("open");
    const index = reader(socket);
    await flush();
    expect(index.reads()).toBe(1);

    socket.moveTo("reconnecting");
    const down = polledFeedReport()[0];
    expect(down?.mode).toBe("timer");
    expect(down?.intervalMs).toBe(2_000);

    clock.advance(2_000);
    await flush();
    expect(index.reads()).toBe(2);
    clock.advance(2_000);
    await flush();
    expect(index.reads()).toBe(3);
    expect(polledFeedReport()[0]?.reads.timer).toBe(2);

    socket.moveTo("open");
    await flush();
    const up = polledFeedReport()[0];
    expect(up?.mode).toBe("events");
    expect(up?.intervalMs).toBeNull();
    expect(up?.reads.timer).toBe(2);
    index.release();
  });

  test("runs for a feed that declared no topics at all — the roomless workspace root", async () => {
    let reads = 0;
    const release = attachFeed({
      feedId: "core.index.read|null",
      intervalMs: 2_000,
      initial: null,
      fetchFn: () => {
        reads += 1;
        return Promise.resolve({ reads });
      },
      notify: () => undefined,
      events: null,
    });
    await flush();
    expect(reads).toBe(1);

    const [row] = polledFeedReport();
    expect(row?.mode).toBe("timer");
    expect(row?.topics).toEqual([]);

    clock.advance(2_000);
    await flush();
    expect(reads).toBe(2);
    release();
  });
});

describe("a socket that comes and goes", () => {
  test("reconnecting keeps the declaration and pays exactly one catch-up read", async () => {
    const socket = fakeSocket("connecting");
    const index = reader(socket);
    await flush();
    // The sidebar must not sit empty through the handshake, so the mount read goes out
    // before the channel is live — which is the gap the catch-up read below closes.
    expect(index.reads()).toBe(1);
    expect(socket.declared).toBe(1);

    socket.moveTo("open");
    await flush();
    expect(index.reads()).toBe(2);
    expect(polledFeedReport()[0]?.reads.resume).toBe(1);

    socket.moveTo("reconnecting");
    socket.moveTo("open");
    await flush();

    // The SDK re-declares its own subscriptions on the new socket, so the feed must NOT
    // subscribe again — but it does owe a read for the gap it was not listening through.
    expect(socket.declared).toBe(1);
    expect(socket.released).toBe(0);
    expect(socket.standing).toBe(1);
    expect(index.reads()).toBe(3);
    expect(polledFeedReport()[0]?.reads.resume).toBe(2);
    index.release();
  });

  test("a new session handle resubscribes, releases the old one, and refreshes", async () => {
    const first = fakeSocket("open");
    const index = reader(first);
    await flush();
    expect(index.reads()).toBe(1);

    // What navigating to another container does: the gate rebuilds its SessionClient while
    // the sidebar — and therefore the feed — stays mounted.
    const second = fakeSocket("open");
    rebindFeed("core.index.read|null", second, [INDEX_TOPIC], "manifold://plugin/core.index");
    await flush();

    expect(first.standing).toBe(0);
    expect(first.released).toBe(1);
    expect(second.standing).toBe(1);
    expect(index.reads()).toBe(2);
    expect(polledFeedReport()[0]?.reads.resume).toBe(1);
    index.release();
  });

  test("rebinding to the same door and topics changes nothing", async () => {
    const socket = fakeSocket("open");
    const index = reader(socket);
    await flush();

    rebindFeed("core.index.read|null", socket, [INDEX_TOPIC], "manifold://plugin/core.index");
    await flush();

    expect(socket.declared).toBe(1);
    expect(index.reads()).toBe(1);
    index.release();
  });

  test("changed topics are a new declaration", async () => {
    const socket = fakeSocket("open");
    const index = reader(socket);
    await flush();

    rebindFeed("core.index.read|null", socket, [MACHINES_TOPIC], "manifold://plugin/core.machines");
    await flush();

    expect(socket.declared).toBe(2);
    expect(socket.released).toBe(1);
    expect(socket.topics).toEqual([MACHINES_TOPIC]);
    expect(polledFeedReport()[0]?.topics).toEqual(["manifold://plugin/core.machines"]);
    index.release();
  });
});

describe("the feed probe", () => {
  test("publishes every live feed to the browser gate", async () => {
    const socket = fakeSocket("open");
    const index = reader(socket);
    const machines = reader(socket, {
      feedId: "core.machines.list|null",
      topics: [MACHINES_TOPIC],
    });
    await flush();

    const report = window.__manifoldFeeds?.() ?? [];
    expect(report.map((row) => row.key).sort()).toEqual([
      "core.index.read|null",
      "core.machines.list|null",
    ]);
    // The invariant the budget table is written against.
    for (const row of report) {
      expect(row.mode).toBe("events");
      expect(row.intervalMs).toBeNull();
      expect(row.reads.timer).toBe(0);
      expect(row.reads.initial).toBe(1);
      expect(row.topics).toHaveLength(1);
    }
    index.release();
    machines.release();
  });
});
