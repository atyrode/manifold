import { afterEach, beforeEach, describe, expect, spyOn, test, vi } from "bun:test";
import type { HostServices } from "@manifold/plugin";
import type { Principal, UiNode, WebIsolateHostFrame } from "@manifold/protocol";
import {
  WORKER_GRACE_MS,
  WorkerHost,
  WorkerRegistry,
  webModulePath,
  type WorkerLike,
} from "./worker-host.ts";

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
  private readonly messageListeners: ((event: { readonly data: unknown }) => void)[] = [];
  private readonly errorListeners: ((event: { readonly message: string }) => void)[] = [];

  postMessage(message: unknown): void {
    if (typeof message === "object" && message !== null && "result" in message) {
      // The structured clone's own refusal, for a reply carrying something that is not data.
      if (typeof message.result === "function") throw new Error("DataCloneError");
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

const VIEWER: Principal = { id: "p1", kind: "human", name: "Ada", color: "#fff" };

/** The doors a served call reaches, each recording the call and answering recognisably. */
interface FakeClient {
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
    navigate: (uri: string) => calls.push(`navigate:${uri}`),
  };
  return partial as unknown as HostServices;
}

/** Enough microtask turns for a served call to dispatch, settle and reply. */
async function flush(): Promise<void> {
  for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
}

const TREE: UiNode = { type: "text", text: "hello" };

interface Bench {
  readonly worker: FakeWorker;
  readonly host: WorkerHost;
  readonly calls: string[];
}

function bench(client?: FakeClient): Bench {
  const worker = new FakeWorker();
  const calls: string[] = [];
  const host = new WorkerHost({
    pluginId: "acme.notes",
    principal: VIEWER,
    caps: ["containers:read"],
    containerId: "c1",
    host: fakeHost(calls, "c1", client),
    workerFactory: () => worker,
  });
  host.start();
  return { worker, host, calls };
}

/** Faults are reported to the console as well; the tests read the panel-facing report. */
let consoleError: ReturnType<typeof spyOn> | null = null;
beforeEach(() => {
  consoleError = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  consoleError?.mockRestore();
  consoleError = null;
  vi.useRealTimers();
});

describe("WorkerHost frames", () => {
  test("start spawns the module from the instance's route and sends init with the viewer", () => {
    const urls: string[] = [];
    const worker = new FakeWorker();
    const host = new WorkerHost({
      pluginId: "acme.notes",
      principal: VIEWER,
      caps: ["containers:read"],
      containerId: "c1",
      host: fakeHost([]),
      workerFactory: (url) => {
        urls.push(url);
        return worker;
      },
    });
    host.start();
    expect(urls).toEqual(["/api/plugins/acme.notes/web.js"]);
    expect(webModulePath("acme/notes")).toBe("/api/plugins/acme%2Fnotes/web.js");
    expect(worker.frames()).toEqual([
      {
        t: "init",
        pluginId: "acme.notes",
        principal: VIEWER,
        caps: ["containers:read"],
        containerId: "c1",
      },
    ]);
  });

  test("ready registers the served panels: mounted instances get `mount`, others fault", () => {
    const { worker, host } = bench();
    const faults: string[] = [];
    host.mount("i1", "main", () => {}, (error) => faults.push(error));
    host.mount("i2", "extra", () => {}, (error) => faults.push(error));
    expect(worker.frames()).toHaveLength(1);

    worker.emit({ t: "ready", panels: ["main"] });

    expect(worker.frames().slice(1)).toEqual([{ t: "mount", instance: "i1", panel: "main" }]);
    expect(faults).toEqual([
      'panel "extra" is declared by acme.notes but its web half serves no program for it',
    ]);

    // A mount after ready is announced at once.
    host.mount("i3", "main", () => {}, () => {});
    expect(worker.frames().at(-1)).toEqual({ t: "mount", instance: "i3", panel: "main" });
  });

  test("render reaches the instance it names and nobody else", () => {
    const { worker, host } = bench();
    const seen: string[] = [];
    host.mount("i1", "main", (tree) => seen.push(`i1:${JSON.stringify(tree)}`), () => {});
    host.mount("i2", "main", (tree) => seen.push(`i2:${JSON.stringify(tree)}`), () => {});
    worker.emit({ t: "ready", panels: ["main"] });

    worker.emit({ t: "render", instance: "i2", tree: TREE });
    worker.emit({ t: "render", instance: "gone", tree: TREE });

    expect(seen).toEqual([`i2:${JSON.stringify(TREE)}`]);
  });

  test("call is served from the host ref and replied, ok or refused, by id", async () => {
    const { worker, host, calls } = bench();
    host.mount("i1", "main", () => {}, () => {});
    worker.emit({ t: "ready", panels: ["main"] });
    const before = worker.frames().length;

    worker.emit({ t: "call", id: "1", method: "action", args: ["core.notes.add", { text: "x" }] });
    worker.emit({ t: "call", id: "2", method: "navigate", args: ["manifold://c/c1"] });
    worker.emit({ t: "call", id: "3", method: "selfCaps", args: [] });
    worker.emit({ t: "call", id: "4", method: "terminalsByContainer", args: [] });
    worker.emit({ t: "call", id: "5", method: "openTerminal", args: ["not an object"] });
    worker.emit({ t: "call", id: "6", method: "resolve", args: [42] });
    worker.emit({ t: "call", id: "7", method: "sendTerminalInput", args: ["t1", "ls\n"] });
    worker.emit({ t: "call", id: "8", method: "untold", args: [] });
    await flush();

    expect(calls).toEqual([
      'action:core.notes.add:{"text":"x"}',
      "navigate:manifold://c/c1",
      "input:t1:ls\n",
    ]);
    const replies = new Map(
      worker
        .frames()
        .slice(before)
        .map((frame) => [frame.t === "reply" ? frame.id : "", frame]),
    );
    expect(replies.get("1")).toEqual({
      t: "reply",
      id: "1",
      ok: true,
      result: { ok: true, result: { done: "core.notes.add" } },
    });
    expect(replies.get("2")).toEqual({ t: "reply", id: "2", ok: true, result: null });
    expect(replies.get("3")).toEqual({
      t: "reply",
      id: "3",
      ok: true,
      result: ["containers:read"],
    });
    expect(replies.get("4")).toEqual({ t: "reply", id: "4", ok: false, error: "no room joined" });
    expect(replies.get("5")).toEqual({
      t: "reply",
      id: "5",
      ok: false,
      error: "openTerminal: argument 0 must be an object",
    });
    expect(replies.get("6")).toEqual({
      t: "reply",
      id: "6",
      ok: false,
      error: "resolve: argument 0 must be a string",
    });
    expect(replies.get("7")).toEqual({ t: "reply", id: "7", ok: true, result: null });
    expect(replies.get("8")).toEqual({
      t: "reply",
      id: "8",
      ok: false,
      error: "slice_unavailable: untold",
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
    host.mount("i1", "main", () => {}, (error) => faults.push(`i1:${error}`));
    host.mount("i2", "main", () => {}, (error) => faults.push(`i2:${error}`));
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
    host.mount("i1", "main", () => {}, (error) => faults.push(error));
    worker.emit({ t: "ready", panels: ["main"] });

    worker.emit({ t: "render", instance: "i1", tree: { type: "marquee", text: "no" } });

    expect(faults).toHaveLength(1);
    expect(faults[0]).toStartWith("malformed frame from the worker: ");
    expect(worker.terminated).toBe(true);
    expect(consoleError).toHaveBeenCalledTimes(1);

    host.mount("i2", "main", () => {}, (error) => faults.push(error));
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
    host.mount("i1", "main", () => {}, (error) => faults.push(error));
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
    host.mount("i1", "main", () => {}, (error) => faults.push(error));
    await flush();
    expect(faults).toEqual(["web half failed to load: web half fetch failed (404)"]);
  });

  test("unmount sends `unmount` exactly when `mount` went out; event carries the payload", () => {
    const { worker, host } = bench();
    const unmountEarly = host.mount("i0", "main", () => {}, () => {});
    unmountEarly();
    worker.emit({ t: "ready", panels: ["main"] });
    expect(worker.frames().some((frame) => frame.t === "unmount")).toBe(false);

    const unmount = host.mount("i1", "main", () => {}, () => {});
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

  test("a result the worker cannot receive is a refusal naming it", async () => {
    const client = fakeClient([]);
    client.machines = () => Promise.resolve(() => "a function is not data");
    const { worker } = bench(client);
    worker.emit({ t: "ready", panels: ["main"] });
    worker.emit({ t: "call", id: "1", method: "machines", args: [] });
    await flush();
    expect(worker.frames().at(-1)).toEqual({
      t: "reply",
      id: "1",
      ok: false,
      error: "result not serialisable: DataCloneError",
    });
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
