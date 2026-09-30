import { afterEach, beforeEach, describe, expect, spyOn, test, vi } from "bun:test";
import type { HostServices, SessionHandle, StreamHandle } from "@manifold/plugin";
import { MACHINES_RESOURCE } from "@manifold/plugin/portable-hooks";
import type {
  MachineSummary,
  Principal,
  StreamServerMessage,
  UiNode,
  WebIsolateHostFrame,
} from "@manifold/protocol";
import {
  ActionOutcomeSchema,
  HARDENED_CONTRACT_VERSION,
  MachineSummarySchema,
  MachinesResponseSchema,
  WebIsolateHostFrameSchema,
} from "@manifold/protocol";
import { WORKER_GRACE_MS, WorkerHost, WorkerRegistry, type WorkerLike } from "./worker-host.ts";

/**
 * THE SUPERVISOR'S CONTRACT (ADR 0016 §1, §3): a worker announces what it serves, is told what is
 * mounted, answers with trees, reaches the host only by NAME through the panel's real host ref,
 * and a worker that breaks the protocol is a fault every instance sees — never a blank tile and
 * never a roster row.
 */

/** A `Worker` in memory: records what the page posts, and lets a test speak as the guest. */
class FakeWorker implements WorkerLike {
  readonly sent: unknown[] = [];
  terminated = false;
  cloneFailure = "DataCloneError";
  private readonly messageListeners: ((event: { readonly data: unknown }) => void)[] = [];
  private readonly errorListeners: ((event: { readonly message: string }) => void)[] = [];

  postMessage(message: unknown): void {
    if (typeof message === "object" && message !== null && "result" in message) {
      // The structured clone's own refusal, for a reply carrying something that is not data.
      if (typeof message.result === "function") throw new Error(this.cloneFailure);
    }
    this.sent.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  addEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void;
  addEventListener(type: "messageerror", listener: () => void): void;
  addEventListener(type: "error", listener: (event: { readonly message: string }) => void): void;
  addEventListener(type: string, listener: unknown): void {
    // The overloads above type each listener; the implementation only files it by kind.
    if (type === "message") {
      this.messageListeners.push(listener as (event: { readonly data: unknown }) => void);
    }
    if (type === "error") {
      this.errorListeners.push(listener as (event: { readonly message: string }) => void);
    }
  }

  /** The guest speaks. */
  emit(frame: unknown): void {
    for (const listener of this.messageListeners) listener({ data: frame });
  }

  /** The guest throws uncaught. */
  fail(message: string): void {
    for (const listener of this.errorListeners) listener({ message });
  }

  /** Every frame the page sent. The fake only ever receives host frames, so the read is typed. */
  frames(): readonly WebIsolateHostFrame[] {
    return this.sent as readonly WebIsolateHostFrame[];
  }
}

const VIEWER: Principal = { id: "p1", kind: "human", name: "Ada", color: "#ffffff" };

/** The doors a served call reaches, each recording the call and answering recognisably. */
interface FakeClient {
  readonly status: SessionHandle["status"];
  subscribe: SessionHandle["subscribe"];
  on: SessionHandle["on"];
  action(name: string, args: unknown): Promise<unknown>;
  place(ref: unknown, destination: unknown): Promise<unknown>;
  selfCaps(): readonly string[];
  machines(): Promise<unknown>;
  resolve(uri: string): Promise<unknown>;
  openTerminal(opts: { readonly elementId: string }): Promise<unknown>;
  sendTerminalInput(terminalId: string, data: string | Uint8Array): void;
  terminalsByContainer(): Promise<unknown>;
}

function fakeClient(calls: string[]): FakeClient {
  return {
    status: "open",
    subscribe: () => () => {},
    on: () => () => {},
    action: (name, args) => {
      calls.push(`action:${name}:${JSON.stringify(args)}`);
      return Promise.resolve({ ok: true, result: { done: name } });
    },
    place: (ref, destination) => {
      calls.push(`place:${JSON.stringify(ref)}:${JSON.stringify(destination)}`);
      return Promise.resolve({ ok: true, result: { placed: true } });
    },
    selfCaps: () => ["containers:read"],
    machines: () => Promise.resolve([{ id: "m1" }]),
    resolve: (uri) => {
      calls.push(`resolve:${uri}`);
      return Promise.resolve({ uri });
    },
    openTerminal: (opts) => {
      calls.push(`open:${opts.elementId}`);
      return Promise.resolve({ id: `t-${opts.elementId}` });
    },
    sendTerminalInput: (terminalId, data) => {
      calls.push(`input:${terminalId}:${String(data)}`);
    },
    terminalsByContainer: () => Promise.reject(new Error("no room joined")),
  };
}

/**
 * A host ref with exactly the members a served call reaches. The rest of `HostServices` is
 * chrome the supervisor never touches, which is what the cast records.
 */
function fakeHost(calls: string[], containerId: string | null = "c1", client = fakeClient(calls)) {
  const partial = {
    client,
    principal: VIEWER,
    token: "secret",
    containerId,
    authoring: null,
    topics: { index: [], terminals: [], attendance: [], machines: [] },
    navigate: (uri: string) => calls.push(`navigate:${uri}`),
  };
  return partial as unknown as HostServices;
}

/** Enough microtask turns for a served call to dispatch, settle and reply. */
async function flush(): Promise<void> {
  for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
}

function replyResult(worker: FakeWorker, id: string): unknown {
  const frame = worker.frames().find((frame) => frame.t === "reply" && frame.id === id);
  if (frame?.t !== "reply" || !frame.ok) throw new Error(`expected successful reply ${id}`);
  return frame.result;
}

interface Bench {
  readonly worker: FakeWorker;
  readonly host: WorkerHost;
  readonly calls: string[];
}

function bench(client?: FakeClient, portableWorker = false): Bench {
  const worker = new FakeWorker();
  const calls: string[] = [];
  const host = new WorkerHost({
    pluginId: "acme.notes",
    principal: VIEWER,
    caps: ["containers:read"],
    containerId: "c1",
    host: fakeHost(calls, "c1", client),
    portableWorker,
    workerFactory: () => worker,
  });
  host.start();
  return { worker, host, calls };
}

/** Faults are reported to the console as well; the tests read the panel-facing report. */
let consoleError: ReturnType<typeof spyOn> | null = null;
let documentDescriptor: PropertyDescriptor | undefined;
beforeEach(() => {
  // Agent graphics tests install a canvas-only DOM; this suite owns a browser event target.
  documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    writable: true,
    value: Object.assign(new EventTarget(), { hidden: false }),
  });
  consoleError = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  consoleError?.mockRestore();
  consoleError = null;
  vi.useRealTimers();
  if (documentDescriptor === undefined) Reflect.deleteProperty(globalThis, "document");
  else Object.defineProperty(globalThis, "document", documentDescriptor);
});

test("stream delivery is bounded for a stalled worker and releases the SDK subscription", async () => {
  let deliver: (message: StreamServerMessage) => void = () => {};
  let closed = 0;
  const handle: StreamHandle = {
    snapshot: null,
    cursor: undefined,
    status: "open",
    on: (listener) => {
      deliver = listener;
      return () => {
        deliver = () => {};
      };
    },
    close: () => {
      closed += 1;
    },
  };
  const { worker, host } = bench({ ...fakeClient([]), openStream: () => handle } as FakeClient);
  const unmount = host.mount(
    "i1",
    "notes",
    () => {},
    () => {},
  );
  worker.emit({ t: "ready", panels: ["notes"] });
  worker.emit({
    t: "call",
    id: "c1",
    method: "openStream",
    args: [
      "s1",
      { kind: "acme.notes.output", node: { kind: "container", containerId: "c1" } },
      "i1",
    ],
  });
  await flush();
  for (let seq = 1; seq <= 100; seq += 1) {
    deliver({ type: "stream_frame", subscriptionId: "wire1", epoch: "e1", seq, body: seq });
  }
  const notifications = worker.frames().filter((frame) => frame.t === "stream");
  expect(notifications).toHaveLength(65);
  expect(notifications.at(-1)).toMatchObject({
    t: "stream",
    id: "s1",
    message: { type: "stream_closed", reason: "slow_consumer" },
  });
  expect(closed).toBe(1);
  unmount();
  host.stop();
  expect(closed).toBe(1);
});

describe("WorkerHost frames", () => {
  test("oversized host errors yield one valid reply and later calls continue", async () => {
    const client = fakeClient([]);
    client.terminalsByContainer = () => Promise.reject(new Error("x".repeat(4_096)));
    const { worker } = bench(client);
    worker.emit({ t: "ready", panels: ["main"] });
    const before = worker.frames().length;
    worker.emit({ t: "call", id: "oversized", method: "terminalsByContainer", args: [] });
    await flush();
    const replies = worker
      .frames()
      .slice(before)
      .filter((frame) => frame.t === "reply" && frame.id === "oversized");
    expect(replies).toHaveLength(1);
    expect(WebIsolateHostFrameSchema.safeParse(replies[0]).success).toBe(true);

    worker.emit({ t: "call", id: "later", method: "selfCaps", args: [] });
    await flush();
    expect(worker.frames().at(-1)).toEqual({
      t: "reply",
      id: "later",
      ok: true,
      result: ["containers:read"],
    });
  });

  test("a call is served from the NEWEST bound host ref", async () => {
    const { worker, host } = bench();
    const later: string[] = [];
    host.bind(fakeHost(later));
    worker.emit({ t: "ready", panels: ["main"] });
    worker.emit({ t: "call", id: "1", method: "navigate", args: ["/"] });
    await flush();
    expect(later).toEqual(["navigate:/"]);
  });

  test("a scoped fault reaches its instance; an unscoped one is the whole worker's", () => {
    const { worker, host } = bench();
    const faults: string[] = [];
    host.mount(
      "i1",
      "main",
      () => {},
      (error) => faults.push(`i1:${error}`),
    );
    host.mount(
      "i2",
      "main",
      () => {},
      (error) => faults.push(`i2:${error}`),
    );
    worker.emit({ t: "ready", panels: ["main"] });

    worker.emit({ t: "fault", instance: "i1", error: "update threw" });
    expect(faults).toEqual(["i1:update threw"]);
    expect(worker.terminated).toBe(false);

    worker.emit({ t: "fault", error: "init threw" });
    expect(faults).toEqual(["i1:update threw", "i1:init threw", "i2:init threw"]);
    expect(worker.terminated).toBe(true);
  });

  test("a malformed frame faults the whole worker: every instance, later mounts, stopped", () => {
    const { worker, host } = bench();
    const faults: string[] = [];
    host.mount(
      "i1",
      "main",
      () => {},
      (error) => faults.push(error),
    );
    worker.emit({ t: "ready", panels: ["main"] });

    worker.emit({ t: "render", instance: "i1", tree: { type: "marquee", text: "no" } });

    expect(faults).toHaveLength(1);
    expect(faults[0]).toStartWith("malformed frame from the worker: ");
    expect(worker.terminated).toBe(true);
    expect(consoleError).toHaveBeenCalledTimes(1);

    host.mount(
      "i2",
      "main",
      () => {},
      (error) => faults.push(error),
    );
    expect(faults).toHaveLength(2);
    expect(faults[1]).toBe(faults[0]);
    // The worker is gone: nothing else goes out, and the fault stays the one report.
    host.event("i1", "click");
    expect(worker.frames().at(-1)).toEqual({ t: "mount", instance: "i1", panel: "main" });
    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  test("an uncaught error in the worker is a worker-wide fault", () => {
    const { worker, host } = bench();
    const faults: string[] = [];
    host.mount(
      "i1",
      "main",
      () => {},
      (error) => faults.push(error),
    );
    worker.fail("boom");
    expect(faults).toEqual(["uncaught error in the worker: boom"]);
    expect(worker.terminated).toBe(true);
  });

  test("a module that fails to load is the same fault", async () => {
    const faults: string[] = [];
    const host = new WorkerHost({
      pluginId: "acme.notes",
      principal: VIEWER,
      caps: [],
      containerId: null,
      host: fakeHost([]),
      workerFactory: () => Promise.reject(new Error("web half fetch failed (404)")),
    });
    host.start();
    host.mount(
      "i1",
      "main",
      () => {},
      (error) => faults.push(error),
    );
    await flush();
    expect(faults).toEqual(["web half failed to load: web half fetch failed (404)"]);
  });

  test("unmount sends `unmount` exactly when `mount` went out; event carries the payload", () => {
    const { worker, host } = bench();
    const unmountEarly = host.mount(
      "i0",
      "main",
      () => {},
      () => {},
    );
    unmountEarly();
    worker.emit({ t: "ready", panels: ["main"] });
    expect(worker.frames().some((frame) => frame.t === "unmount")).toBe(false);

    const unmount = host.mount(
      "i1",
      "main",
      () => {},
      () => {},
    );
    host.event("i1", "save", { id: 7 });
    host.event("i1", "refresh");
    host.event("nobody", "save");
    unmount();
    unmount();
    host.event("i1", "save");

    expect(worker.frames().slice(1)).toEqual([
      { t: "mount", instance: "i1", panel: "main" },
      { t: "event", instance: "i1", event: "save", payload: { id: 7 } },
      { t: "event", instance: "i1", event: "refresh" },
      { t: "unmount", instance: "i1" },
    ]);
  });

  test("an unclonable result gets exactly one schema-valid refusal", async () => {
    const client = fakeClient([]);
    client.machines = () => Promise.resolve(() => "a function is not data");
    const { worker } = bench(client);
    worker.cloneFailure = "x".repeat(4_096);
    worker.emit({ t: "ready", panels: ["main"] });
    const before = worker.frames().length;
    worker.emit({ t: "call", id: "1", method: "machines", args: [] });
    await flush();
    const replies = worker
      .frames()
      .slice(before)
      .filter((frame) => frame.t === "reply" && frame.id === "1");
    expect(replies).toHaveLength(1);
    const parsed = WebIsolateHostFrameSchema.safeParse(replies[0]);
    expect(parsed.success).toBe(true);
    if (!parsed.success || parsed.data.t !== "reply" || parsed.data.ok) {
      throw new Error("expected a valid refusal reply");
    }
    expect(parsed.data.error).toStartWith("result not serialisable: ");
  });
});

describe("portable Worker compatibility", () => {
  // Contract 9's protocol-47 machine parser is strict and predates this optional field.
  const legacyMachines = MachinesResponseSchema.extend({
    machines: MachineSummarySchema.omit({ physicalCoreCount: true }).array(),
  });
  const live = Object.freeze({
    id: "live",
    name: "online host",
    online: true,
    physicalCoreCount: 6,
    terminalExecution: "unconfined" as const,
  });
  const offline = Object.freeze({
    id: "offline",
    name: "offline host",
    online: false,
    lastRefusal: Object.freeze({ code: 4409 as const, at: 123 }),
  });
  const machines = Object.freeze([live, offline]);
  const outcome = Object.freeze({ ok: true, result: Object.freeze({ machines }) });

  test("contract 9 mounts, reads strict old machines through both doors, and renders", async () => {
    const client = fakeClient([]);
    client.machines = async () => machines;
    const actionArgs = Object.freeze({});
    const actions: { name: string; args: unknown }[] = [];
    client.action = async (name, args) => {
      actions.push({ name, args });
      return outcome;
    };
    const { host, worker } = bench(client, true);
    const rendered: UiNode[] = [];
    const faults: string[] = [];
    host.mount(
      "i1",
      "main",
      (tree) => rendered.push(tree),
      (error) => faults.push(error),
    );
    // A portable call must continue using its mounted authority, not a newer global binding.
    host.bind(fakeHost([]));
    try {
      worker.emit({ t: "ready", hardenedContract: 9, panels: ["main"], sections: [] });
      expect(worker.frames().find((frame) => frame.t === "mount")).toMatchObject({
        instance: "i1",
        panel: "main",
        kind: "panel",
        context: {
          principal: VIEWER,
          caps: ["containers:read"],
          containerId: "c1",
          status: "open",
          hidden: false,
          canAuthor: false,
        },
      });
      worker.emit({ t: "call", id: "direct", instance: "i1", method: "machines", args: [] });
      worker.emit({
        t: "call",
        id: "action",
        instance: "i1",
        method: "action",
        args: [MACHINES_RESOURCE, actionArgs],
      });
      await flush();
      expect(legacyMachines.safeParse({ machines }).success).toBe(false);
      const direct = legacyMachines.parse({ machines: replyResult(worker, "direct") });
      const called = ActionOutcomeSchema.parse(replyResult(worker, "action"));
      if (!called.ok) throw new Error(called.denial.message);
      const throughAction = legacyMachines.parse(called.result);
      expect(direct).toEqual({
        machines: [
          { id: live.id, name: live.name, online: true, terminalExecution: "unconfined" },
          offline,
        ],
      });
      expect(throughAction).toEqual(direct);
      expect(actions).toEqual([{ name: MACHINES_RESOURCE, args: actionArgs }]);
      expect(actions[0]?.args).toBe(actionArgs);
      expect(live.physicalCoreCount).toBe(6);
      expect(outcome.result.machines).toBe(machines);

      host.update("i1", fakeHost([], "c2", client), { tab: "fleet" });
      expect(worker.frames().at(-1)).toMatchObject({
        t: "context",
        instance: "i1",
        context: { containerId: "c2", status: "open" },
        arg: { tab: "fleet" },
      });
      worker.emit({
        t: "render",
        instance: "i1",
        tree: {
          type: "text",
          text: throughAction.machines.map((machine) => machine.name).join(", "),
        },
      });
      expect(rendered).toEqual([{ type: "text", text: "online host, offline host" }]);
      expect(faults).toEqual([]);
      expect(worker.terminated).toBe(false);
    } finally {
      host.stop();
    }
  });

  test.each([10, 11, 12])(
    "contract %i retains current machine responses unchanged",
    async (contract) => {
      const client = fakeClient([]);
      client.machines = async () => machines;
      client.action = async () => outcome;
      const { host, worker } = bench(client, true);
      host.mount(
        "i1",
        "main",
        () => {},
        () => {},
      );
      try {
        worker.emit({ t: "ready", hardenedContract: contract, panels: ["main"] });
        worker.emit({ t: "call", id: "direct", instance: "i1", method: "machines", args: [] });
        worker.emit({
          t: "call",
          id: "action",
          instance: "i1",
          method: "action",
          args: [MACHINES_RESOURCE, {}],
        });
        await flush();
        const direct = replyResult(worker, "direct");
        const called = replyResult(worker, "action");
        expect(direct).toBe(machines);
        expect(called).toBe(outcome);
        expect(
          MachinesResponseSchema.parse({ machines: direct }).machines[0]?.physicalCoreCount,
        ).toBe(6);
        const parsed = ActionOutcomeSchema.parse(called);
        if (!parsed.ok) throw new Error(parsed.denial.message);
        expect(MachinesResponseSchema.parse(parsed.result).machines[0]?.physicalCoreCount).toBe(6);
      } finally {
        host.stop();
      }
    },
  );

  test.each([undefined, 8, HARDENED_CONTRACT_VERSION + 1])("portable contract %s cannot mount or call", async (contract) => {
    const { host, worker, calls } = bench(undefined, true);
    const faults: string[] = [];
    host.mount(
      "i1",
      "main",
      () => {},
      (error) => faults.push(error),
    );
    worker.emit({
      t: "ready",
      panels: ["main"],
      ...(contract === undefined ? {} : { hardenedContract: contract }),
    });
    worker.emit({
      t: "call",
      id: "after-fault",
      instance: "i1",
      method: "action",
      args: [MACHINES_RESOURCE, {}],
    });
    await flush();
    expect(faults).toHaveLength(1);
    expect(worker.terminated).toBe(true);
    expect(worker.frames().some((frame) => frame.t === "mount")).toBe(false);
    expect(calls).toEqual([]);
  });

  test("legacy projection preserves refusals and leaves unrelated or invalid results untouched", async () => {
    const client = fakeClient([]);
    let result: unknown;
    client.action = async () => result;
    const { host, worker } = bench(client, true);
    host.mount(
      "i1",
      "main",
      () => {},
      () => {},
    );
    try {
      worker.emit({ t: "ready", hardenedContract: 9, panels: ["main"] });
      const refusal = { ok: false, denial: { rule: "forbidden", message: "no machine grant" } };
      const invalidList = { ok: true, result: { machines: [{ ...live, online: "invalid" }] } };
      const invalidEnvelope = { ...outcome, extra: "not an action outcome" };
      for (const [id, name, value] of [
        ["refusal", MACHINES_RESOURCE, refusal],
        ["unrelated", "acme.inventory.read", outcome],
        ["invalid-list", MACHINES_RESOURCE, invalidList],
        ["invalid-envelope", MACHINES_RESOURCE, invalidEnvelope],
      ] as const) {
        result = value;
        worker.emit({ t: "call", id, instance: "i1", method: "action", args: [name, {}] });
        await flush();
        expect(replyResult(worker, id)).toBe(value);
      }
      const invalidMachines = [{ ...live, unexpected: true }];
      client.machines = async () => invalidMachines;
      worker.emit({
        t: "call",
        id: "invalid-direct",
        instance: "i1",
        method: "machines",
        args: [],
      });
      await flush();
      expect(replyResult(worker, "invalid-direct")).toBe(invalidMachines);
      client.machines = () => Promise.reject(new Error("machine read refused"));
      worker.emit({
        t: "call",
        id: "refused-direct",
        instance: "i1",
        method: "machines",
        args: [],
      });
      await flush();
      expect(worker.frames().at(-1)).toEqual({
        t: "reply",
        id: "refused-direct",
        ok: false,
        error: "machine read refused",
      });
    } finally {
      host.stop();
    }
  });
});

describe("WorkerRegistry", () => {
  test("one worker per (plugin, container), shared, stopped a grace after the last release", () => {
    vi.useFakeTimers();
    const made: FakeWorker[] = [];
    const registry = new WorkerRegistry({
      workerFactory: () => {
        const worker = new FakeWorker();
        made.push(worker);
        return worker;
      },
    });
    const host = fakeHost([]);

    const first = registry.acquire("acme.notes", host);
    const second = registry.acquire("acme.notes", host);
    const elsewhere = registry.acquire("acme.notes", fakeHost([], "c2"));
    const other = registry.acquire("acme.other", host);
    expect(second.worker).toBe(first.worker);
    expect(elsewhere.worker).not.toBe(first.worker);
    expect(other.worker).not.toBe(first.worker);
    expect(made).toHaveLength(3);

    first.release();
    vi.advanceTimersByTime(WORKER_GRACE_MS * 2);
    expect(made[0]?.terminated).toBe(false);

    second.release();
    second.release();
    vi.advanceTimersByTime(WORKER_GRACE_MS - 1);
    // Reclaimed inside the grace: the same worker, never stopped.
    const third = registry.acquire("acme.notes", host);
    vi.advanceTimersByTime(WORKER_GRACE_MS * 2);
    expect(third.worker).toBe(first.worker);
    expect(made[0]?.terminated).toBe(false);

    third.release();
    vi.advanceTimersByTime(WORKER_GRACE_MS - 1);
    expect(made[0]?.terminated).toBe(false);
    vi.advanceTimersByTime(1);
    expect(made[0]?.terminated).toBe(true);
    expect(made[1]?.terminated).toBe(false);

    // After the stop, a fresh mount gets a fresh worker.
    const fourth = registry.acquire("acme.notes", host);
    expect(fourth.worker).not.toBe(first.worker);
    expect(made).toHaveLength(4);
    registry.stopAll();
    expect(made.every((worker) => worker.terminated)).toBe(true);
  });
});

test("event invalidations are bounded, payload-free and owned by the mounted instance", async () => {
  const listeners = new Set<Parameters<SessionHandle["subscribe"]>[1]>();
  const client = fakeClient([]);
  client.subscribe = (_topics, listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const { worker, host } = bench(client);
  const unmount = host.mount(
    "i1",
    "main",
    () => {},
    () => {},
  );
  host.mount(
    "i2",
    "main",
    () => {},
    () => {},
  );
  worker.emit({ t: "ready", hardenedContract: 9, panels: ["main"] });
  try {
    worker.emit({
      t: "call",
      id: "join",
      instance: "i1",
      method: "subscribe",
      args: ["news", [{ kind: "plugin", pluginId: "core.index" }]],
    });
    await flush();
    const delivered = [...listeners];
    const fire = (): void => {
      for (const listener of delivered)
        listener({
          type: "event",
          topic: { kind: "plugin", pluginId: "core.index" },
          plugin: "core.index",
          kind: "changed",
          at: 0,
          actor: null,
          payload: { private: "must not cross the Worker boundary" },
        });
    };
    for (let count = 0; count < 100; count += 1) fire();
    const notifications = () => worker.frames().filter((frame) => frame.t === "notification");
    expect(notifications()).toEqual([{ t: "notification", id: "news" }]);

    worker.emit({ t: "call", id: "steal", instance: "i2", method: "ackEvent", args: ["news"] });
    worker.emit({
      t: "call",
      id: "close-other",
      instance: "i2",
      method: "unsubscribe",
      args: ["news"],
    });
    await flush();
    expect(worker.frames().filter((frame) => frame.t === "reply" && !frame.ok)).toHaveLength(2);
    expect(listeners.size).toBe(1);
    expect(notifications()).toHaveLength(1);
    worker.emit({ t: "call", id: "ack", instance: "i1", method: "ackEvent", args: ["news"] });
    await flush();
    expect(notifications()).toEqual([
      { t: "notification", id: "news" },
      { t: "notification", id: "news" },
    ]);
    unmount();
    fire();
    expect(listeners.size).toBe(0);
    expect(notifications()).toHaveLength(2);

    for (let index = 0; index <= 64; index += 1) {
      worker.emit({
        t: "call",
        id: `join-${index}`,
        instance: "i2",
        method: "subscribe",
        args: [`s-${index}`, [{ kind: "plugin", pluginId: "core.index" }]],
      });
    }
    await flush();
    expect(listeners.size).toBe(64);
    expect(
      worker.frames().find((frame) => frame.t === "reply" && frame.id === "join-64"),
    ).toMatchObject({ ok: false });
  } finally {
    host.stop();
  }
  expect(listeners.size).toBe(0);
});

test("terminal authoring cannot borrow another mount or survive authority loss during lookup", async () => {
  const machine: MachineSummary = {
    id: "m1",
    name: "host-resolved",
    online: true,
    terminalExecution: "unconfined",
  };
  let lookup = Promise.withResolvers<unknown>();
  const client = fakeClient([]);
  client.machines = () => lookup.promise;
  const { worker, host } = bench(client);
  const created: string[] = [];
  const allowed: HostServices = {
    ...fakeHost([], "c1", client),
    authoring: {
      createTerminal: async (target) => {
        created.push(target?.id ?? "default");
        return null;
      },
    },
  };
  const unmount = host.mount(
    "allowed",
    "fleet",
    () => {},
    () => {},
    {
      kind: "section",
      host: allowed,
    },
  );
  host.mount(
    "denied",
    "main",
    () => {},
    () => {},
    { host: fakeHost([], "c1", client) },
  );
  host.bind(allowed);
  worker.emit({ t: "ready", hardenedContract: 9, panels: ["main"], sections: ["fleet"] });
  const create = (id: string, instance: string, target: unknown): void =>
    worker.emit({ t: "call", id, instance, method: "createTerminal", args: [target, null] });
  try {
    create("cross-mount", "denied", null);
    create("revoked", "allowed", "m1");
    host.update("allowed", { ...allowed, authoring: null });
    lookup.resolve([machine]);
    await flush();
    expect(created).toEqual([]);
    expect(worker.frames().filter((frame) => frame.t === "reply" && !frame.ok)).toHaveLength(2);

    host.update("allowed", allowed);
    create("forged", "allowed", { ...machine, terminalExecution: "unconfined" });
    await flush();
    expect(created).toEqual([]);
    create("current", "allowed", "m1");
    await flush();
    expect(created).toEqual(["m1"]);

    lookup = Promise.withResolvers<unknown>();
    create("retired", "allowed", "m1");
    unmount();
    lookup.resolve([machine]);
    await flush();
    expect(created).toEqual(["m1"]);
    expect(worker.frames().some((frame) => frame.t === "reply" && frame.id === "retired")).toBe(
      false,
    );
    create("after-unmount", "allowed", null);
    await flush();
    expect(
      worker.frames().find((frame) => frame.t === "reply" && frame.id === "after-unmount"),
    ).toMatchObject({ ok: false });
    expect(created).toEqual(["m1"]);
  } finally {
    host.stop();
  }
});

test("element edits reject stale source snapshots, read-only and retired mounts", async () => {
  const { host, worker } = bench();
  const mountedHost = fakeHost([]);
  let writes = 0;
  const edit = {
    writable: true,
    patch: async () => {
      writes += 1;
    },
  };
  const oldElement = { id: "image", data: { source: "old", amount: 1 } };
  const element = { id: "image", data: { source: "current", amount: 1 } };
  const unmount = host.mount(
    "image",
    "picture",
    () => {},
    () => {},
    {
      kind: "element",
      host: mountedHost,
      element: oldElement,
      edit,
    },
  );
  host.mount(
    "panel",
    "main",
    () => {},
    () => {},
    { host: mountedHost },
  );
  worker.emit({ t: "ready", hardenedContract: 12, panels: ["main"], elements: ["picture"] });
  const send = (id: string, instance: string, expected = element.data): void => {
    worker.emit({
      t: "call",
      id,
      instance,
      method: "patchElement",
      args: [{ expected, patch: { amount: 2 } }],
    });
  };
  try {
    host.update("image", mountedHost, undefined, element, edit);
    send("stale", "image", oldElement.data);
    send("other-kind", "panel");
    await flush();
    expect(writes).toBe(0);
    send("current", "image");
    await flush();
    expect(writes).toBe(1);
    host.update("image", mountedHost, undefined, element, { ...edit, writable: false });
    send("read-only", "image");
    await flush();
    unmount();
    send("retired", "image");
    await flush();
    expect(writes).toBe(1);
    const refused = worker.frames().filter((frame) => frame.t === "reply" && !frame.ok);
    expect(refused.map((frame) => (frame.t === "reply" ? frame.id : ""))).toEqual([
      "stale",
      "other-kind",
      "read-only",
      "retired",
    ]);
  } finally {
    host.stop();
  }
});

test.each([9, 10, 11])(
  "an admitted contract-%i portable peer accepts strict mount and context updates",
  async (contract) => {
    const source = `
    import { z } from ${JSON.stringify(import.meta.resolve("zod"))};
    import { PanelArgSchema, WebHostContextSchema } from ${JSON.stringify(import.meta.resolve("@manifold/protocol"))};
    const context = WebHostContextSchema.pick({
      principal: true, caps: true, containerId: true, topics: true,
      status: true, hidden: true, canAuthor: true,
    });
    const mount = z.strictObject({
      t: z.literal("mount"), instance: z.string(), panel: z.string(),
      kind: z.enum(["panel", "section"]).optional(), context, arg: PanelArgSchema.optional(),
    });
    const update = z.strictObject({
      t: z.literal("context"), instance: z.string(), context, arg: PanelArgSchema.optional(),
    });
    self.onmessage = ({ data }) => {
      if (data.t === "init") {
        self.postMessage({ t: "ready", panels: ["main"], hardenedContract: ${contract} });
      } else if (data.t === "mount" || data.t === "context") {
        const parsed = (data.t === "mount" ? mount : update).safeParse(data);
        self.postMessage(parsed.success
          ? { t: "render", instance: data.instance, tree: { type: "text", text: parsed.data.context.status } }
          : { t: "fault", instance: data.instance, error: "legacy strict context rejected" });
      }
    };
  `;
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    const completed = Promise.withResolvers<void>();
    const painted: string[] = [];
    const timeout = setTimeout(() => completed.reject(new Error("legacy peer timed out")), 10_000);
    const host = new WorkerHost({
      pluginId: "acme.notes",
      principal: VIEWER,
      caps: [],
      containerId: "c1",
      host: fakeHost([]),
      portableWorker: true,
      workerFactory: () => new Worker(url, { type: "module" }),
    });
    try {
      host.start();
      host.mount(
        "legacy",
        "main",
        (tree) => {
          if (tree.type !== "text") return;
          painted.push(tree.text);
          if (painted.length === 1 && tree.text === "open") {
            host.update(
              "legacy",
              fakeHost([], "c1", { ...fakeClient([]), status: "reconnecting" }),
            );
          } else completed.resolve();
        },
        (error) => completed.reject(new Error(error)),
      );
      await completed.promise;
      expect(painted).toEqual(["open", "reconnecting"]);
    } finally {
      clearTimeout(timeout);
      host.stop();
      URL.revokeObjectURL(url);
    }
  },
  15_000,
);

test("an intake result cannot repeat, cross a credential change, or outlive its mount", () => {
  const { host, worker } = bench();
  const viewer = fakeHost([]);
  const accepted: string[] = [];
  const faulted: string[] = [];
  const mount = (instance: string): (() => void) =>
    host.mount(
      instance,
      "main",
      () => {},
      () => {
        faulted.push(instance);
      },
      {
        host: viewer,
        input: { value: { flow: "save" }, files: [] },
        onResult: () => {
          accepted.push(instance);
        },
      },
    );
  const send = (instance: string): void =>
    worker.emit({
      t: "panel_result",
      instance,
      result: { state: "accepted" },
    });
  try {
    mount("current");
    mount("changed");
    const retire = mount("retired");
    worker.emit({ t: "ready", hardenedContract: 12, panels: ["main"] });
    send("current");
    send("current");
    host.update("changed", { ...viewer, token: "replacement-credential" });
    send("changed");
    retire();
    send("retired");
    expect(accepted).toEqual(["current"]);
    expect(faulted).toEqual(["current", "changed"]);
  } finally {
    host.stop();
  }
});
