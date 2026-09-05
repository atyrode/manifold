import { describe, expect, test } from "bun:test";
import type { UiNode, WebIsolateHostFrame, WebIsolateWorkerFrame } from "@manifold/protocol";
import { z } from "zod";
import { HostCallError } from "../src/errors.ts";
import { ui } from "../src/ui.ts";
import {
  attachWebGuest,
  definePanel,
  type GuestHost,
  type PanelEvent,
  type WebPluginDef,
} from "../src/web.ts";

/**
 * THE WEB GUEST, DRIVEN BY A FAKE PAGE over an in-memory port: the same frames the panel host
 * posts to a Worker, the same trees and calls it reads back. What these pin is a panel's life
 * as a program — init, view, update, subscribe — and that a program's mistakes come back as
 * `fault` frames naming the panel, never as a broken worker.
 */

const principal = { id: "p1", kind: "human", name: "Ada", color: "#e03131" } as const;

interface FakePage {
  send(frame: WebIsolateHostFrame): void;
  next(): Promise<WebIsolateWorkerFrame>;
  readonly posted: WebIsolateWorkerFrame[];
  readonly warnings: string[];
}

function page(def: WebPluginDef): FakePage {
  const posted: WebIsolateWorkerFrame[] = [];
  const queue: WebIsolateWorkerFrame[] = [];
  const waiting: ((frame: WebIsolateWorkerFrame) => void)[] = [];
  const warnings: string[] = [];
  let listener: (data: unknown) => void = () => {};
  attachWebGuest(def, {
    post: (frame) => {
      posted.push(frame);
      const waiter = waiting.shift();
      if (waiter === undefined) queue.push(frame);
      else waiter(frame);
    },
    onMessage: (next) => {
      listener = next;
    },
    warn: (line) => {
      warnings.push(line);
    },
  });
  return {
    send: (frame) => listener(frame),
    next: () => {
      const queued = queue.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      const { promise, resolve } = Promise.withResolvers<WebIsolateWorkerFrame>();
      waiting.push(resolve);
      return promise;
    },
    posted,
    warnings,
  };
}

function init(fake: FakePage): void {
  fake.send({
    t: "init",
    pluginId: "acme.thing",
    principal,
    caps: ["containers:read"],
    containerId: "c1",
  });
}

const CountResult = z.object({ count: z.number() });

/** A panel that shows a count and bumps it through the door on every `bump` event. */
const counter = definePanel<{ count: number; viewer: string; denial: string | null }>({
  init: (host) => ({ count: 0, viewer: host.principal.name, denial: null }),
  view: (state) =>
    ui.box({ direction: "column" }, [
      ui.text(`${state.viewer}: ${String(state.count)}`),
      state.denial === null ? ui.divider() : ui.text(state.denial, { tone: "danger" }),
    ]),
  update: async (state, event, host) => {
    if (event.event !== "bump") return state;
    const outcome = await host.action("acme.thing.bump", { by: 1 });
    if (!outcome.ok) return { ...state, denial: outcome.denial.message };
    return { ...state, count: CountResult.parse(outcome.result).count, denial: null };
  },
});

describe("init and mount", () => {
  test("init answers ready with the panel ids; mount renders the program's first view", async () => {
    const fake = page({ id: "acme.thing", panels: { counter } });
    init(fake);
    expect(await fake.next()).toEqual({ t: "ready", panels: ["counter"] });
    fake.send({ t: "mount", instance: "i1", panel: "counter" });
    expect(await fake.next()).toEqual({
      t: "render",
      instance: "i1",
      tree: ui.box({ direction: "column" }, [ui.text("Ada: 0"), ui.divider()]),
    });
  });

  test("a mount before init, or of a panel the guest does not serve, is a fault", async () => {
    const fake = page({ id: "acme.thing", panels: { counter } });
    fake.send({ t: "mount", instance: "early", panel: "counter" });
    expect(await fake.next()).toEqual({
      t: "fault",
      instance: "early",
      error: "mount before init",
    });
    init(fake);
    await fake.next();
    fake.send({ t: "mount", instance: "i1", panel: "ghost" });
    expect(await fake.next()).toEqual({
      t: "fault",
      instance: "i1",
      error: 'no such panel "ghost"',
    });
  });

  test("panel ids outside the vocabulary fault at init instead of leaving as a bad frame", async () => {
    const fake = page({ id: "acme.thing", panels: { "Not Local": counter } });
    init(fake);
    expect(await fake.next()).toMatchObject({
      t: "fault",
      error: expect.stringContaining("panel ids are outside the vocabulary"),
    });
  });
});

describe("events and host calls", () => {
  test("an event folds through update, a host call round-trips, and the new view is posted", async () => {
    const fake = page({ id: "acme.thing", panels: { counter } });
    init(fake);
    await fake.next();
    fake.send({ t: "mount", instance: "i1", panel: "counter" });
    await fake.next();
    fake.send({ t: "event", instance: "i1", event: "bump" });
    const call = await fake.next();
    expect(call).toEqual({
      t: "call",
      id: "c1",
      method: "action",
      args: ["acme.thing.bump", { by: 1 }],
    });
    fake.send({ t: "reply", id: "c1", ok: true, result: { ok: true, result: { count: 3 } } });
    expect(await fake.next()).toEqual({
      t: "render",
      instance: "i1",
      tree: ui.box({ direction: "column" }, [ui.text("Ada: 3"), ui.divider()]),
    });
  });

  test("events fold in order even while an update is still awaiting the host", async () => {
    const fake = page({ id: "acme.thing", panels: { counter } });
    init(fake);
    await fake.next();
    fake.send({ t: "mount", instance: "i1", panel: "counter" });
    await fake.next();
    fake.send({ t: "event", instance: "i1", event: "bump" });
    fake.send({ t: "event", instance: "i1", event: "bump" });
    // Only one call has left: the second bump waits for the first update to settle.
    expect(await fake.next()).toMatchObject({ t: "call", id: "c1" });
    expect(fake.posted.filter((frame) => frame.t === "call")).toHaveLength(1);
    fake.send({ t: "reply", id: "c1", ok: true, result: { ok: true, result: { count: 1 } } });
    expect(await fake.next()).toMatchObject({
      t: "render",
      tree: { children: [ui.text("Ada: 1"), ui.divider()] },
    });
    expect(await fake.next()).toMatchObject({ t: "call", id: "c2" });
    fake.send({ t: "reply", id: "c2", ok: true, result: { ok: true, result: { count: 2 } } });
    expect(await fake.next()).toMatchObject({
      t: "render",
      tree: { children: [ui.text("Ada: 2"), ui.divider()] },
    });
  });

  test("a host reply of ok:false reaches the program as HostCallError with the host's sentence", async () => {
    const fake = page({
      id: "acme.thing",
      panels: {
        probe: definePanel<string>({
          init: () => "",
          view: (state) => ui.text(state),
          update: async (_state, _event, host) => {
            try {
              await host.navigate("manifold://container/c9");
              return "went";
            } catch (error) {
              return error instanceof HostCallError
                ? `${error.method}: ${error.detail}`
                : "wrong class";
            }
          },
        }),
      },
    });
    init(fake);
    await fake.next();
    fake.send({ t: "mount", instance: "i1", panel: "probe" });
    await fake.next();
    fake.send({ t: "event", instance: "i1", event: "go" });
    expect(await fake.next()).toMatchObject({ t: "call", id: "c1", method: "navigate" });
    fake.send({ t: "reply", id: "c1", ok: false, error: "no such container" });
    expect(await fake.next()).toEqual({
      t: "render",
      instance: "i1",
      tree: ui.text("navigate: no such container"),
    });
  });

  test("an event for an instance nobody mounted is ignored with a line", () => {
    const fake = page({ id: "acme.thing", panels: { counter } });
    init(fake);
    fake.send({ t: "event", instance: "nobody", event: "bump" });
    fake.send({ t: "bogus" } as unknown as WebIsolateHostFrame);
    expect(fake.warnings).toEqual([
      'event "bump" for unknown instance "nobody"; ignored',
      expect.stringContaining("unknown page frame ignored"),
    ]);
  });
});

describe("faults", () => {
  test("a tree outside the vocabulary, a throwing view and a throwing update each fault naming the panel", async () => {
    const fake = page({
      id: "acme.thing",
      panels: {
        bad: definePanel<string>({
          init: () => "tree",
          view: (state) => {
            if (state === "throw") throw new Error("view broke");
            // A stray DOM-shaped node: not a kind the vocabulary has.
            return state === "tree"
              ? ({ type: "div", text: "x" } as unknown as UiNode)
              : ui.text("fine");
          },
          update: (_state, event) => {
            if (event.event === "explode") throw new Error("update broke");
            return String(event.payload);
          },
        }),
      },
    });
    init(fake);
    await fake.next();
    fake.send({ t: "mount", instance: "i1", panel: "bad" });
    expect(await fake.next()).toMatchObject({
      t: "fault",
      instance: "i1",
      error: expect.stringContaining('panel "bad" rendered a tree outside the vocabulary'),
    });
    fake.send({ t: "event", instance: "i1", event: "set", payload: "throw" });
    expect(await fake.next()).toEqual({
      t: "fault",
      instance: "i1",
      error: 'panel "bad" failed to render: view broke',
    });
    fake.send({ t: "event", instance: "i1", event: "explode" });
    expect(await fake.next()).toEqual({
      t: "fault",
      instance: "i1",
      error: 'panel "bad" failed on "explode": update broke',
    });
    fake.send({ t: "event", instance: "i1", event: "set", payload: "ok" });
    expect(await fake.next()).toEqual({ t: "render", instance: "i1", tree: ui.text("fine") });
  });

  test("a program that fails to start faults and is not mounted", async () => {
    const fake = page({
      id: "acme.thing",
      panels: {
        broken: definePanel<never>({
          init: () => {
            throw new Error("no state for you");
          },
          view: () => ui.divider(),
          update: (state) => state,
        }),
      },
    });
    init(fake);
    await fake.next();
    fake.send({ t: "mount", instance: "i1", panel: "broken" });
    expect(await fake.next()).toEqual({
      t: "fault",
      instance: "i1",
      error: 'panel "broken" failed to start: no state for you',
    });
    fake.send({ t: "event", instance: "i1", event: "any" });
    expect(fake.warnings).toEqual(['event "any" for unknown instance "i1"; ignored']);
  });
});

describe("subscribe and unmount", () => {
  test("subscribe drives updates until unmount stops it", async () => {
    let emitTick: ((event: PanelEvent) => void) | null = null;
    let stopped = 0;
    let seen: GuestHost | null = null;
    const fake = page({
      id: "acme.thing",
      panels: {
        ticker: definePanel<number>({
          init: () => 0,
          view: (ticks) => ui.badge(String(ticks)),
          update: (ticks, event) => (event.event === "tick" ? ticks + 1 : ticks),
          subscribe: (host, emit) => {
            seen = host;
            emitTick = emit;
            return () => {
              stopped += 1;
            };
          },
        }),
      },
    });
    init(fake);
    await fake.next();
    fake.send({ t: "mount", instance: "i1", panel: "ticker" });
    expect(await fake.next()).toMatchObject({ t: "render", tree: ui.badge("0") });
    expect(seen).toMatchObject({ containerId: "c1", caps: ["containers:read"] });
    if (emitTick === null) throw new Error("subscribe never ran");
    const tick: (event: PanelEvent) => void = emitTick;
    tick({ event: "tick" });
    expect(await fake.next()).toMatchObject({ t: "render", tree: ui.badge("1") });
    fake.send({ t: "unmount", instance: "i1" });
    expect(stopped).toBe(1);
    tick({ event: "tick" });
    fake.send({ t: "unmount", instance: "i1" });
    await Promise.resolve();
    expect(fake.posted.filter((frame) => frame.t === "render")).toHaveLength(2);
    expect(stopped).toBe(1);
  });
});
