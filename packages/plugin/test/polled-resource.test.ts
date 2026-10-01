import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ManifoldRef } from "@manifold/protocol";
import type { FeedEvents, SessionStatus } from "../src/host.ts";
import {
  attachFeed,
  MACHINES_RESOURCE_OPTIONS,
  polledFeedReport,
  rebindFeed,
  resetPolledResources,
} from "../src/polled-resource.ts";

/**
 * THE WAVE-2 CLAIM, measured (ADR 0012): a synchronized, eligible feed reads ONCE and then
 * only when an event says the world moved. Until its ordering fence and catch-up complete,
 * or while its audience is ineligible, the shared fallback cadence keeps the snapshot fresh.
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

const globals = {
  setTimeout: (fn: () => void, ms: number) => clock.after(fn, ms, null),
  clearTimeout: (id: number | undefined) => clock.clear(id),
  setInterval: (fn: () => void, ms: number) => clock.after(fn, ms, ms),
  clearInterval: (id: number | undefined) => clock.clear(id),
  window: { localStorage: { getItem: (key: string): string | null => store[key] ?? null } },
  document: { hidden: false, addEventListener: (): void => undefined },
};
const originalGlobals = new Map(
  Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
);

/**
 * Lets every settled promise in the store's read chain land before an assertion reads it.
 * A microtask drain rather than a delay: the reads resolve immediately, and the only thing
 * being waited for is `then`/`catch`/`finally` running — no wall clock is involved anywhere
 * in this file, which is what the virtual clock above exists for.
 */
const flush = async (): Promise<void> => {
  for (let tick = 0; tick < 16; tick += 1) await Promise.resolve();
};

const INDEX_TOPIC: ManifoldRef = { kind: "plugin", pluginId: "core.index" };
const MACHINES_TOPIC: ManifoldRef = { kind: "plugin", pluginId: "core.machines" };

interface FakeSocket extends FeedEvents {
  /** Deliver one event to every standing subscription, as the SDK's router would. */
  fire(): void;
  moveTo(status: SessionStatus): void;
  changeAuthority(workspaceEvents: boolean): void;
  /** Each fence covers only the declarations that existed when it was requested. */
  readonly syncWatermarks: readonly number[];
  /** How many declarations this socket currently holds, and how many it ever held. */
  readonly standing: number;
  readonly declared: number;
  readonly released: number;
  readonly topics: readonly ManifoldRef[];
}

function fakeSocket(
  status: SessionStatus = "open",
  options: {
    readonly workspaceEvents?: boolean;
    readonly sync?: (watermark: number) => Promise<boolean>;
  } = {},
): FakeSocket {
  let current = status;
  let declared = 0;
  let released = 0;
  let workspaceEvents = options.workspaceEvents ?? true;
  const syncWatermarks: number[] = [];
  const authorityListeners = new Set<() => void>();
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
    get syncWatermarks() {
      return syncWatermarks;
    },
    workspaceEventsAvailable: () => workspaceEvents,
    onAuthorityChange(listener) {
      authorityListeners.add(listener);
      return () => authorityListeners.delete(listener);
    },
    syncSubscriptions() {
      syncWatermarks.push(declared);
      return options.sync?.(declared) ?? Promise.resolve(current === "open");
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
      for (const record of [...subscriptions]) {
        record.handler({
          type: "event",
          topic: INDEX_TOPIC,
          plugin: "core.index",
          kind: "container_created",
          at: 0,
          actor: null,
          payload: {},
        });
      }
    },
    moveTo(next) {
      current = next;
      for (const listener of [...listeners]) listener(next);
    },
    changeAuthority(available) {
      workspaceEvents = available;
      for (const listener of [...authorityListeners]) listener();
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
    readonly requiresWorkspaceEvents?: boolean;
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
    requiresWorkspaceEvents: options.requiresWorkspaceEvents ?? false,
  });
  return { release, reads: () => reads, notices: () => notices };
}

beforeEach(() => {
  resetPolledResources();
  clock.reset();
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
});

afterEach(() => {
  resetPolledResources();
  for (const [key, descriptor] of originalGlobals) {
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, key);
    else Object.defineProperty(globalThis, key, descriptor);
  }
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

  test("a retaining feed recovers every reader without republishing unchanged data", async () => {
    const socket = fakeSocket("open");
    const failures = new Set<string>();
    let failing = false;
    let reads = 0;
    let notices = 0;
    const attach = (id: string) =>
      attachFeed({
        feedId: "core.index.read|null",
        intervalMs: 2_000,
        initial: null,
        fetchFn: async () => {
          reads += 1;
          if (failing) throw new Error("temporary read failure");
          return { items: [{ id: "container" }] };
        },
        notify: () => {
          notices += 1;
        },
        onError: () => {
          failures.add(id);
        },
        onSuccess: () => {
          failures.delete(id);
        },
        events: socket,
        topics: [INDEX_TOPIC],
      });
    const releaseFirst = attach("first");
    const releaseSecond = attach("second");
    await flush();
    expect(notices).toBe(2);

    failing = true;
    socket.fire();
    clock.advance(50);
    await flush();
    expect(failures).toEqual(new Set(["first", "second"]));
    expect(notices).toBe(2);
    expect(polledFeedReport()[0]?.mode).toBe("events");

    failing = false;
    socket.fire();
    clock.advance(50);
    await flush();
    expect(failures.size).toBe(0);
    expect(notices).toBe(2);
    expect(reads).toBe(3);
    releaseFirst();
    releaseSecond();
  });

  test("a held successful response does not report recovery before acceptance", async () => {
    const socket = fakeSocket("open");
    let holding = true;
    let recovered = false;
    const release = attachFeed({
      feedId: "core.machines.list|null",
      intervalMs: 2_000,
      initial: null,
      fetchFn: async () => [],
      hold: () => holding,
      onSuccess: () => {
        recovered = true;
      },
      notify: () => undefined,
      events: socket,
      topics: [MACHINES_TOPIC],
    });
    await flush();
    expect(recovered).toBe(false);
    holding = false;
    clock.advance(250);
    await flush();
    expect(recovered).toBe(true);
    release();
  });

  test("a detached generation cannot report recovery to a replacement reader", async () => {
    const oldRead = Promise.withResolvers<unknown>();
    const currentRead = Promise.withResolvers<unknown>();
    const recovered: string[] = [];
    const attach = (id: string, response: Promise<unknown>) =>
      attachFeed({
        feedId: "core.machines.list|null",
        intervalMs: 2_000,
        initial: null,
        fetchFn: () => response,
        onSuccess: () => {
          recovered.push(id);
        },
        notify: () => undefined,
      });
    const releaseOld = attach("old", oldRead.promise);
    releaseOld();
    const releaseCurrent = attach("current", currentRead.promise);
    oldRead.resolve([]);
    await flush();
    expect(recovered).toEqual([]);
    currentRead.resolve([]);
    await flush();
    expect(recovered).toEqual(["current"]);
    releaseCurrent();
  });

  test("two readers of one resource share one subscription and one request", async () => {
    const socket = fakeSocket("open");
    const shell = reader(socket);
    const section = reader(socket);
    await flush();
    clock.advance(50);
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

  test("retiring the bound mount keeps the surviving mount subscribed without polling", async () => {
    const survivingDoor = fakeSocket("open");
    const retiringDoor = fakeSocket("open");
    const survivor = reader(survivingDoor);
    const retiring = reader(retiringDoor);
    await flush();

    retiring.release();
    retiringDoor.moveTo("closed");
    await flush();
    const before = survivor.reads();
    survivingDoor.fire();
    clock.advance(50);
    await flush();
    expect(survivor.reads()).toBe(before + 1);

    retiringDoor.fire();
    clock.advance(10_000);
    await flush();
    expect(survivor.reads()).toBe(before + 1);
    survivor.release();
    expect(survivingDoor.standing).toBe(0);
    expect(retiringDoor.standing).toBe(0);
    expect(clock.pending).toBe(0);
  });
});

describe("event eligibility and subscription ordering", () => {
  test("an open scoped viewer keeps one shared poller and publishes unseen fleet changes", async () => {
    const socket = fakeSocket("open", { workspaceEvents: false });
    let revoked = false;
    const options = {
      feedId: "core.machines.list|null",
      topics: [MACHINES_TOPIC],
      requiresWorkspaceEvents: true,
      answer: () => ({ machines: [{ id: "offline", online: false, revoked }] }),
    };
    const machines = reader(socket, options);
    const canvas = reader(socket, options);
    await flush();
    expect(machines.reads() + canvas.reads()).toBe(1);
    expect(machines.notices()).toBe(1);
    expect(canvas.notices()).toBe(1);

    // No event can reach this audience, even though the socket remains open.
    revoked = true;
    clock.advance(2_000);
    await flush();
    expect(machines.reads() + canvas.reads()).toBe(2);
    expect(machines.notices()).toBe(2);
    expect(canvas.notices()).toBe(2);
    expect(polledFeedReport()[0]).toMatchObject({
      live: true,
      mode: "timer",
      intervalMs: 2_000,
    });
    expect(socket.syncWatermarks).toEqual([]);
    machines.release();
    canvas.release();
  });

  test("even a non-workspace feed waits for synchronization and accepted catch-up", async () => {
    const fence = Promise.withResolvers<boolean>();
    const snapshot = Promise.withResolvers<unknown>();
    const socket = fakeSocket("open", {
      workspaceEvents: false,
      sync: () => fence.promise,
    });
    const index = reader(socket, { answer: () => snapshot.promise });
    await flush();
    expect(index.reads()).toBe(0);
    expect(socket.syncWatermarks).toEqual([1]);
    expect(polledFeedReport()[0]?.intervalMs).toBe(2_000);

    fence.resolve(true);
    await flush();
    expect(index.reads()).toBe(1);
    expect(polledFeedReport()[0]?.mode).toBe("timer");
    snapshot.resolve({ revision: "after-subscription-admission" });
    await flush();
    expect(index.notices()).toBe(1);
    expect(polledFeedReport()[0]?.mode).toBe("events");
    clock.advance(60_000);
    await flush();
    expect(index.reads()).toBe(1);
    expect(polledFeedReport()[0]?.reads.timer).toBe(0);
    index.release();
  });

  test("a fallback read before the fence cannot retire polling or replace post-fence catch-up", async () => {
    const fence = Promise.withResolvers<boolean>();
    const socket = fakeSocket("open", { sync: () => fence.promise });
    let revision = 1;
    const index = reader(socket, { answer: () => ({ revision }) });
    clock.advance(2_000);
    await flush();
    expect(index.reads()).toBe(1);
    expect(polledFeedReport()[0]?.mode).toBe("timer");

    // A commit in the subscription-admission gap must be read AFTER the fence, not lost.
    revision = 2;
    fence.resolve(true);
    await flush();
    expect(index.reads()).toBe(2);
    expect(index.notices()).toBe(2);
    expect(polledFeedReport()[0]?.mode).toBe("events");
    clock.advance(60_000);
    await flush();
    expect(index.reads()).toBe(2);
    index.release();
  });

  test("a new feed interest cannot borrow a fence requested before its declaration", async () => {
    const firstFence = Promise.withResolvers<boolean>();
    const laterFence = Promise.withResolvers<boolean>();
    const socket = fakeSocket("open", {
      sync: (watermark) => (watermark === 1 ? firstFence.promise : laterFence.promise),
    });
    const index = reader(socket);
    let revoked = false;
    const machines = reader(socket, {
      feedId: "core.machines.list|null",
      topics: [MACHINES_TOPIC],
      requiresWorkspaceEvents: true,
      answer: () => ({ revoked }),
    });
    expect(socket.syncWatermarks).toEqual([1, 2]);
    firstFence.resolve(true);
    await flush();
    expect(index.reads()).toBe(1);
    expect(machines.reads()).toBe(0);
    expect(polledFeedReport().find((row) => row.key === "core.machines.list|null")?.mode).toBe(
      "timer",
    );

    revoked = true;
    laterFence.resolve(true);
    await flush();
    expect(machines.reads()).toBe(1);
    expect(machines.notices()).toBe(1);
    expect(polledFeedReport().find((row) => row.key === "core.machines.list|null")?.mode).toBe(
      "events",
    );
    clock.advance(60_000);
    await flush();
    expect(index.reads()).toBe(1);
    expect(machines.reads()).toBe(1);
    index.release();
    machines.release();
  });

  test("authority loss retires a pending fence and gain earns a fresh catch-up", async () => {
    const obsoleteFence = Promise.withResolvers<boolean>();
    const currentFence = Promise.withResolvers<boolean>();
    let attempts = 0;
    const socket = fakeSocket("open", {
      workspaceEvents: false,
      sync: () => (++attempts === 1 ? obsoleteFence.promise : currentFence.promise),
    });
    let revision = 1;
    const machines = reader(socket, {
      requiresWorkspaceEvents: true,
      answer: () => ({ revision }),
    });
    await flush();
    socket.changeAuthority(true);
    socket.changeAuthority(false);
    obsoleteFence.resolve(true);
    await flush();
    expect(machines.reads()).toBe(1);
    expect(polledFeedReport()[0]?.mode).toBe("timer");

    revision = 2;
    clock.advance(2_000);
    await flush();
    expect(machines.notices()).toBe(2);
    socket.changeAuthority(true);
    revision = 3;
    currentFence.resolve(true);
    await flush();
    expect(socket.syncWatermarks).toEqual([1, 1]);
    expect(machines.reads()).toBe(3);
    expect(machines.notices()).toBe(3);
    expect(polledFeedReport()[0]?.mode).toBe("events");
    machines.release();
  });

  test("a read admitted before authority loss cannot qualify the regained event binding", async () => {
    const oldSnapshot = Promise.withResolvers<unknown>();
    const currentSnapshot = Promise.withResolvers<unknown>();
    const socket = fakeSocket("open");
    const machines = reader(socket, {
      requiresWorkspaceEvents: true,
      answer: (n) => (n === 1 ? oldSnapshot.promise : currentSnapshot.promise),
    });
    await flush();
    expect(machines.reads()).toBe(1);
    socket.changeAuthority(false);
    socket.changeAuthority(true);
    await flush();
    oldSnapshot.resolve({ revision: "before-loss" });
    await flush();
    expect(machines.reads()).toBe(2);
    expect(polledFeedReport()[0]?.mode).toBe("timer");
    currentSnapshot.resolve({ revision: "after-gain" });
    await flush();
    expect(machines.notices()).toBe(2);
    expect(polledFeedReport()[0]?.mode).toBe("events");
    machines.release();
  });

  test("rebinding topics on the same door discards the previous declaration's pending fence", async () => {
    const oldFence = Promise.withResolvers<boolean>();
    const currentFence = Promise.withResolvers<boolean>();
    const socket = fakeSocket("open", {
      sync: (watermark) => (watermark === 1 ? oldFence.promise : currentFence.promise),
    });
    const index = reader(socket);
    rebindFeed("core.index.read|null", socket, [MACHINES_TOPIC], "manifold://plugin/core.machines");
    oldFence.resolve(true);
    await flush();
    expect(index.reads()).toBe(0);
    expect(polledFeedReport()[0]?.mode).toBe("timer");
    currentFence.resolve(true);
    await flush();
    expect(index.reads()).toBe(1);
    expect(polledFeedReport()[0]?.mode).toBe("events");
    expect(socket.syncWatermarks).toEqual([1, 2]);
    index.release();
  });

  test("the workspace-event requirement participates in rebinding without changing resource identity", async () => {
    const socket = fakeSocket("open", { workspaceEvents: false });
    let revision = 1;
    const index = reader(socket, { answer: () => ({ revision }) });
    await flush();
    expect(polledFeedReport()[0]?.mode).toBe("events");
    rebindFeed("core.index.read|null", socket, [INDEX_TOPIC], "manifold://plugin/core.index", true);
    revision = 2;
    clock.advance(2_000);
    await flush();
    expect(index.notices()).toBe(2);
    expect(polledFeedReport()[0]?.mode).toBe("timer");

    rebindFeed(
      "core.index.read|null",
      socket,
      [INDEX_TOPIC],
      "manifold://plugin/core.index",
      false,
    );
    await flush();
    expect(index.reads()).toBe(3);
    expect(polledFeedReport()[0]?.mode).toBe("events");
    index.release();
  });

  test.each(["timeout", "transport failure"] as const)(
    "%s retains polling without retrying the fence until a normal authority transition",
    async (failure) => {
      let attempts = 0;
      const socket = fakeSocket("open", {
        sync: () => {
          attempts += 1;
          if (attempts > 1) return Promise.resolve(true);
          return failure === "timeout"
            ? Promise.resolve(false)
            : Promise.reject(new Error(failure));
        },
      });
      const index = reader(socket);
      await flush();
      expect(index.reads()).toBe(1);
      for (let tick = 0; tick < 3; tick += 1) {
        clock.advance(2_000);
        await flush();
      }
      socket.fire();
      clock.advance(50);
      await flush();
      expect(index.reads()).toBe(5);
      expect(attempts).toBe(1);
      expect(polledFeedReport()[0]?.mode).toBe("timer");

      socket.changeAuthority(true);
      await flush();
      expect(attempts).toBe(2);
      expect(index.reads()).toBe(6);
      expect(polledFeedReport()[0]?.mode).toBe("events");
      clock.advance(60_000);
      await flush();
      expect(index.reads()).toBe(6);
      index.release();
    },
  );

  test("a new subscriber activation refreshes a failed fence without multiplying readers", async () => {
    let attempts = 0;
    const socket = fakeSocket("open", { sync: async () => ++attempts > 1 });
    const first = reader(socket);
    await flush();
    expect(polledFeedReport()[0]?.mode).toBe("timer");
    const second = reader(socket);
    await flush();
    expect(first.reads() + second.reads()).toBe(2);
    expect(polledFeedReport()[0]?.mode).toBe("events");
    clock.advance(60_000);
    await flush();
    expect(first.reads() + second.reads()).toBe(2);
    first.release();
    second.release();
  });

  test("a failed qualifying read retains polling and recovers without an immediate retry loop", async () => {
    const socket = fakeSocket("open");
    const index = reader(socket, {
      answer: (n) => (n === 1 ? Promise.reject(new Error("read failed")) : { revision: n }),
    });
    await flush();
    expect(index.reads()).toBe(1);
    expect(index.notices()).toBe(0);
    expect(polledFeedReport()[0]?.mode).toBe("timer");
    clock.advance(2_000);
    await flush();
    expect(index.reads()).toBe(2);
    expect(index.notices()).toBe(1);
    expect(socket.syncWatermarks).toEqual([1]);
    expect(polledFeedReport()[0]?.mode).toBe("events");
    index.release();
  });

  test("a failed nullable snapshot resumes polling until a fresh eligible catch-up succeeds", async () => {
    const socket = fakeSocket("open");
    const refusal = new Error("plugin_disabled");
    const callbacks: string[] = [];
    let reads = 0;
    let response: Promise<unknown> = Promise.resolve([{ id: "machine", online: false }]);
    const release = attachFeed({
      ...MACHINES_RESOURCE_OPTIONS,
      feedId: `${MACHINES_RESOURCE_OPTIONS.key}|null`,
      intervalMs: 2_000,
      fetchFn: () => {
        reads += 1;
        return response;
      },
      // Error invalidation cannot be suppressed by the resource's content comparator.
      equal: () => true,
      notify: () => {
        callbacks.push("published");
      },
      onError: (reason) => {
        expect(reason).toBe(refusal);
        expect(polledFeedReport()[0]?.mode).toBe("timer");
        callbacks.push("refused");
      },
      onSuccess: () => {
        callbacks.push("accepted");
      },
      events: socket,
      topics: [MACHINES_TOPIC],
    });
    await flush();
    expect(callbacks).toEqual(["published", "accepted"]);
    expect(polledFeedReport()[0]?.mode).toBe("events");

    response = Promise.reject(refusal);
    socket.fire();
    clock.advance(50);
    await flush();
    expect(callbacks).toEqual(["published", "accepted", "published", "refused"]);
    expect(reads).toBe(2);
    expect(polledFeedReport()[0]?.intervalMs).toBe(2_000);
    clock.advance(2_000);
    await flush();
    expect(reads).toBe(3);
    // Repeated refusals remain visible, but UNKNOWN is only published once.
    expect(callbacks).toEqual(["published", "accepted", "published", "refused", "refused"]);

    const oldCatchUp = Promise.withResolvers<unknown>();
    response = oldCatchUp.promise;
    clock.advance(2_000);
    socket.changeAuthority(false);
    oldCatchUp.resolve([{ id: "machine", online: true }]);
    await flush();
    expect(reads).toBe(4);
    expect(polledFeedReport()[0]?.mode).toBe("timer");

    const catchUp = Promise.withResolvers<unknown>();
    response = catchUp.promise;
    socket.changeAuthority(true);
    await flush();
    expect(reads).toBe(5);
    expect(polledFeedReport()[0]?.mode).toBe("timer");
    catchUp.resolve([{ id: "machine", online: true }]);
    await flush();
    expect(polledFeedReport()[0]?.mode).toBe("events");
    expect(polledFeedReport()[0]?.intervalMs).toBeNull();
    clock.advance(60_000);
    await flush();
    expect(reads).toBe(5);
    release();
  });

  test("an event during the qualifying read still queues the newer snapshot", async () => {
    const snapshot = Promise.withResolvers<unknown>();
    const socket = fakeSocket("open");
    const index = reader(socket, {
      answer: (n) => (n === 1 ? snapshot.promise : { revision: 2 }),
    });
    await flush();
    socket.fire();
    clock.advance(50);
    await flush();
    snapshot.resolve({ revision: 1 });
    await flush();
    clock.advance(50);
    await flush();
    expect(index.reads()).toBe(2);
    expect(index.notices()).toBe(2);
    expect(polledFeedReport()[0]?.reads.event).toBe(1);
    clock.advance(60_000);
    await flush();
    expect(index.reads()).toBe(2);
    index.release();
  });

  test("retiring a pending event mount restores the survivor's ineligible polling policy", async () => {
    const survivingDoor = fakeSocket("open", { workspaceEvents: false });
    const obsoleteFence = Promise.withResolvers<boolean>();
    const retiringDoor = fakeSocket("open", { sync: () => obsoleteFence.promise });
    const survivor = reader(survivingDoor, { requiresWorkspaceEvents: true });
    await flush();
    const retiring = reader(retiringDoor);
    retiring.release();
    obsoleteFence.resolve(true);
    await flush();
    expect(polledFeedReport()[0]?.mode).toBe("timer");
    clock.advance(2_000);
    await flush();
    expect(survivor.reads()).toBe(2);
    expect(survivor.notices()).toBe(2);
    expect(survivingDoor.syncWatermarks).toEqual([]);
    survivor.release();
    expect(clock.pending).toBe(0);
  });

  test("a retired feed's pending fence cannot issue reads for a replacement generation", async () => {
    const oldFence = Promise.withResolvers<boolean>();
    const currentFence = Promise.withResolvers<boolean>();
    const old = reader(fakeSocket("open", { sync: () => oldFence.promise }));
    old.release();
    const current = reader(fakeSocket("open", { sync: () => currentFence.promise }));
    oldFence.resolve(true);
    await flush();
    expect(old.reads()).toBe(0);
    expect(current.reads()).toBe(0);
    expect(current.notices()).toBe(0);
    currentFence.resolve(true);
    await flush();
    expect(current.reads()).toBe(1);
    expect(current.notices()).toBe(1);
    current.release();
    expect(clock.pending).toBe(0);
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
  test.each([null, "connecting", "open"] as const)(
    "joining a quiet live door closes the %s initial-request gap at settlement",
    async (status) => {
      const snapshot = Promise.withResolvers<unknown>();
      const first = reader(status === null ? null : fakeSocket(status), {
        answer: (n) => (n === 1 ? snapshot.promise : { revision: 2 }),
      });
      await flush();
      const live = fakeSocket("open");
      const second = reader(live);
      const third = reader(live);
      expect(first.reads() + second.reads() + third.reads()).toBe(1);

      snapshot.resolve({ revision: 1 });
      await flush();
      // No clock advancement or event: settlement itself must earn the post-binding read.
      expect(first.reads() + second.reads() + third.reads()).toBe(2);
      expect(first.notices()).toBe(2);
      expect(second.notices()).toBe(2);
      expect(third.notices()).toBe(2);
      first.release();
      second.release();
      third.release();
    },
  );

  test("a live rebind during acceptance is caught up after the accepting request settles", async () => {
    const next = fakeSocket("open");
    let reads = 0;
    const release = attachFeed({
      feedId: "core.index.read|null",
      intervalMs: 2_000,
      initial: null,
      events: fakeSocket("open"),
      topics: [INDEX_TOPIC],
      fetchFn: async () => ({ revision: ++reads }),
      notify: () => undefined,
      onSuccess: () => {
        rebindFeed("core.index.read|null", next, [INDEX_TOPIC], "manifold://plugin/core.index");
      },
    });
    await flush();
    expect(reads).toBe(2);
    release();
  });

  test("a discarded initial binding cannot drain a replacement generation's catch-up", async () => {
    const oldSnapshot = Promise.withResolvers<unknown>();
    const old = reader(fakeSocket("connecting"), { answer: () => oldSnapshot.promise });
    const oldJoin = reader(fakeSocket("open"));
    old.release();
    oldJoin.release();

    const currentSnapshot = Promise.withResolvers<unknown>();
    const current = reader(fakeSocket("connecting"), {
      answer: (n) => (n === 1 ? currentSnapshot.promise : { revision: 2 }),
    });
    const currentJoin = reader(fakeSocket("open"));
    oldSnapshot.resolve({ revision: "obsolete" });
    await flush();
    expect(old.reads() + oldJoin.reads()).toBe(1);
    expect(current.reads() + currentJoin.reads()).toBe(1);
    expect(current.notices()).toBe(0);
    expect(currentJoin.notices()).toBe(0);

    currentSnapshot.resolve({ revision: 1 });
    await flush();
    expect(current.reads() + currentJoin.reads()).toBe(2);
    expect(current.notices()).toBe(2);
    expect(currentJoin.notices()).toBe(2);
    current.release();
    currentJoin.release();
  });

  test("an opening channel catches up after its pending connecting snapshot settles", async () => {
    const socket = fakeSocket("connecting");
    const snapshot = Promise.withResolvers<unknown>();
    const index = reader(socket, {
      answer: (n) => (n === 1 ? snapshot.promise : { revision: 2 }),
    });
    socket.moveTo("open");
    expect(index.reads()).toBe(1);
    snapshot.resolve({ revision: 1 });
    await flush();
    expect(index.reads()).toBe(2);
    expect(index.notices()).toBe(2);
    index.release();
  });

  test("an already-queued event covers a pending binding catch-up without a duplicate read", async () => {
    const snapshot = Promise.withResolvers<unknown>();
    const first = reader(fakeSocket("open"), {
      answer: (n) => (n === 1 ? snapshot.promise : { revision: 2 }),
    });
    await flush();
    const live = fakeSocket("open");
    const second = reader(live);
    live.fire();
    snapshot.resolve({ revision: 1 });
    await flush();
    clock.advance(50);
    await flush();
    clock.advance(50);
    await flush();
    expect(first.reads() + second.reads()).toBe(2);
    expect(first.notices()).toBe(2);
    expect(second.notices()).toBe(2);
    first.release();
    second.release();
  });

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

test("a Worker feed pauses on host visibility and releases the old visibility binding", async () => {
  Reflect.deleteProperty(globalThis, "window");
  Reflect.deleteProperty(globalThis, "document");
  let hidden = true;
  const visibility = new Set<() => void>();
  const socket = fakeSocket("reconnecting");
  const door: FeedEvents = {
    subscribe: (topics, listener) => socket.subscribe(topics, listener),
    get status() {
      return socket.status;
    },
    on: (event, listener) => socket.on(event, listener),
    workspaceEventsAvailable: () => socket.workspaceEventsAvailable(),
    onAuthorityChange: (listener) => socket.onAuthorityChange(listener),
    syncSubscriptions: () => socket.syncSubscriptions(),
    get hidden() {
      return hidden;
    },
    onVisibilityChange(listener) {
      visibility.add(listener);
      return () => visibility.delete(listener);
    },
  };
  // No topics still needs visibility: this is a pure fallback poll, without any DOM.
  const index = reader(door, { topics: [] });
  await flush();
  clock.advance(10_000);
  await flush();
  expect(index.reads()).toBe(1);
  hidden = false;
  for (const listener of visibility) listener();
  await flush();
  expect(index.reads()).toBe(2);
  clock.advance(2_000);
  await flush();
  expect(index.reads()).toBe(3);

  rebindFeed("core.index.read|null", socket, [INDEX_TOPIC], "manifold://plugin/core.index");
  expect(visibility.size).toBe(0);
  socket.moveTo("open");
  await flush();
  expect(index.reads()).toBe(4);
  clock.advance(10_000);
  await flush();
  expect(index.reads()).toBe(4);
  index.release();
  expect(clock.pending).toBe(0);
  expect(socket.standing).toBe(0);
});

test("an open ineligible Worker feed suspends fallback while hidden and catches up on activation", async () => {
  let hidden = true;
  let revision = 1;
  const visibility = new Set<() => void>();
  const socket = fakeSocket("open", { workspaceEvents: false });
  const door: FeedEvents = {
    subscribe: (topics, listener) => socket.subscribe(topics, listener),
    get status() {
      return socket.status;
    },
    on: (event, listener) => socket.on(event, listener),
    workspaceEventsAvailable: () => socket.workspaceEventsAvailable(),
    onAuthorityChange: (listener) => socket.onAuthorityChange(listener),
    syncSubscriptions: () => socket.syncSubscriptions(),
    get hidden() {
      return hidden;
    },
    onVisibilityChange(listener) {
      visibility.add(listener);
      return () => visibility.delete(listener);
    },
  };
  const machines = reader(door, {
    requiresWorkspaceEvents: true,
    answer: () => ({ revision }),
  });
  await flush();
  revision = 2;
  clock.advance(60_000);
  await flush();
  expect(machines.reads()).toBe(1);
  expect(polledFeedReport()[0]?.intervalMs).toBeNull();

  hidden = false;
  for (const listener of visibility) listener();
  await flush();
  expect(machines.notices()).toBe(2);
  expect(polledFeedReport()[0]?.intervalMs).toBe(2_000);
  revision = 3;
  clock.advance(2_000);
  await flush();
  expect(machines.notices()).toBe(3);
  machines.release();
  expect(visibility.size).toBe(0);
  expect(clock.pending).toBe(0);
});
