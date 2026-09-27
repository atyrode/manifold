import { describe, expect, test } from "bun:test";
import {
  HARDENED_CONTRACT_VERSION,
  type MachineSummary,
  type UiNode,
  type WebHostContext,
  type WebIsolateHostFrame,
  type WebIsolateWorkerFrame,
} from "@manifold/protocol";
import type {
  AuthoringHandle,
  PortablePanelProps,
  PortableSectionProps,
  StreamHandle,
} from "@manifold/plugin";
import {
  Component,
  createElement,
  useEffect,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { attachWebGuest } from "../src/web-guest.ts";
import type { ReactWebPluginDef } from "../src/web.ts";

/**
 * THE WEB GUEST, DRIVEN BY A FAKE PAGE over an in-memory port: the frames the page posts to a
 * Worker, and the trees and calls it reads back. Components render the closed `manifold:*`
 * intrinsics directly — the contract `@manifold/ui/frames` emits — so what these pin is the
 * renderer and runtime themselves: retained React state across event round trips, props
 * refreshed by host context, owned calls and invalidations, and refusal of anything stale,
 * mistyped or outside the vocabulary.
 */

const principal = { id: "p1", kind: "human", name: "Ada", color: "#e03131" } as const;

function context(overrides: Partial<WebHostContext> = {}): WebHostContext {
  return {
    principal,
    caps: ["containers:read"],
    containerId: "c1",
    topics: { index: [], terminals: [], attendance: [], machines: [] },
    status: "open",
    hidden: false,
    canAuthor: false,
    ...overrides,
  };
}

/** One closed intrinsic, as the frame barrel emits it. */
function frame(kind: string, props: Record<string, unknown> = {}, ...children: ReactNode[]) {
  return createElement(`manifold:${kind}` as never, props as never, ...children);
}

interface FakePage {
  send(frame: WebIsolateHostFrame): void;
  next(): Promise<WebIsolateWorkerFrame>;
  readonly posted: WebIsolateWorkerFrame[];
  readonly warnings: string[];
}

function page(def: ReactWebPluginDef): FakePage {
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

async function mounted(
  def: ReactWebPluginDef,
  mount: Partial<Extract<WebIsolateHostFrame, { t: "mount" }>> = {},
): Promise<{ readonly fake: FakePage; readonly tree: UiNode }> {
  const fake = page(def);
  fake.send({ t: "init", pluginId: def.id, principal, caps: [], containerId: "c1" });
  await fake.next();
  fake.send({ t: "mount", instance: "i1", panel: "main", context: context(), ...mount });
  return { fake, tree: await rendered(fake) };
}

async function rendered(fake: FakePage): Promise<UiNode> {
  const next = await fake.next();
  if (next.t !== "render") throw new Error(`expected a render, got ${JSON.stringify(next)}`);
  return next.tree;
}

function nodes(tree: UiNode): UiNode[] {
  return tree.type === "box" ? [tree, ...tree.children.flatMap(nodes)] : [tree];
}

function eventOf(tree: UiNode, label: string): string {
  const control = nodes(tree).find((node) => "label" in node && node.label === label);
  if (control === undefined || !("event" in control)) throw new Error(`no control "${label}"`);
  return control.event;
}

function textsOf(tree: UiNode): string[] {
  return nodes(tree).flatMap((node) => ("text" in node ? [node.text] : []));
}

/** Holds a count across event round trips and bumps it through the owner's host call. */
function Counter({ host }: PortablePanelProps): ReactElement {
  const [count, setCount] = useState(0);
  const [denial, setDenial] = useState<string | null>(null);
  return frame(
    "box",
    { direction: "column" },
    frame("text", { text: `${host.principal.name}: ${String(count)}` }),
    frame("button", {
      label: "Bump",
      action: "example.thing.bump",
      onClick: () => {
        void host.client.action("example.thing.bump", { by: 1 }).then((outcome) => {
          if (outcome.ok) setCount((outcome.result as { count: number }).count);
          else setDenial(outcome.denial.message);
        });
      },
    }),
    denial === null ? null : frame("text", { text: denial, tone: "danger" }),
  );
}

describe("init and mount", () => {
  test("ready advertises panels, sections and the contract; mount paints the committed tree", async () => {
    const fake = page({
      id: "example.thing",
      panels: { main: Counter },
      sections: { side: () => frame("empty", { text: "side" }) },
    });
    fake.send({ t: "init", pluginId: "example.thing", principal, caps: [], containerId: "c1" });
    expect(await fake.next()).toEqual({
      t: "ready",
      panels: ["main"],
      sections: ["side"],
      hardenedContract: HARDENED_CONTRACT_VERSION,
    });
    fake.send({ t: "mount", instance: "i1", panel: "main", context: context() });
    expect(await rendered(fake)).toEqual({
      type: "box",
      key: expect.any(String),
      direction: "column",
      children: [
        { type: "text", key: expect.any(String), text: "Ada: 0" },
        {
          type: "button",
          key: expect.any(String),
          label: "Bump",
          action: "example.thing.bump",
          event: expect.any(String),
        },
      ],
    });
    fake.send({ t: "mount", instance: "s1", panel: "side", kind: "section", context: context() });
    expect(await fake.next()).toMatchObject({ t: "render", instance: "s1", tree: { text: "side" } });
  });

  test("a mount before init, of an unserved id, or without context faults naming it", async () => {
    const fake = page({ id: "example.thing", panels: { main: Counter } });
    fake.send({ t: "mount", instance: "early", panel: "main", context: context() });
    expect(await fake.next()).toEqual({ t: "fault", instance: "early", error: "mount before init" });
    fake.send({ t: "init", pluginId: "example.thing", principal, caps: [], containerId: "c1" });
    await fake.next();
    fake.send({ t: "mount", instance: "i1", panel: "toString", context: context() });
    expect(await fake.next()).toEqual({ t: "fault", instance: "i1", error: 'no such panel "toString"' });
    fake.send({ t: "mount", instance: "i2", panel: "main", kind: "section", context: context() });
    expect(await fake.next()).toEqual({ t: "fault", instance: "i2", error: 'no such section "main"' });
    fake.send({ t: "mount", instance: "i3", panel: "main" });
    expect(await fake.next()).toEqual({
      t: "fault",
      instance: "i3",
      error: 'panel "main" was mounted without its host context',
    });
  });

  test("a Worker started for another plugin faults instead of serving it", async () => {
    const fake = page({ id: "example.thing", panels: { main: Counter } });
    fake.send({ t: "init", pluginId: "example.other", principal, caps: [], containerId: "c1" });
    expect(await fake.next()).toMatchObject({ t: "fault", error: expect.stringContaining("example.other") });
  });
});

describe("events and owned calls", () => {
  test("state survives an event round trip and each host call carries its mounted owner", async () => {
    const { fake, tree } = await mounted({ id: "example.thing", panels: { main: Counter } });
    fake.send({ t: "event", instance: "i1", event: eventOf(tree, "Bump") });
    const call = await fake.next();
    expect(call).toMatchObject({
      t: "call",
      instance: "i1",
      method: "action",
      args: ["example.thing.bump", { by: 1 }],
    });
    if (call.t !== "call") throw new Error("expected a call");
    fake.send({ t: "reply", id: call.id, ok: true, result: { ok: true, result: { count: 3 } } });
    expect(textsOf(await rendered(fake))).toEqual(["Ada: 3"]);
  });

  test("two instances of one panel keep separate state and separate owners", async () => {
    const { fake, tree } = await mounted({ id: "example.thing", panels: { main: Counter } });
    fake.send({ t: "mount", instance: "i2", panel: "main", context: context() });
    const other = await rendered(fake);
    fake.send({ t: "event", instance: "i2", event: eventOf(other, "Bump") });
    const call = await fake.next();
    expect(call).toMatchObject({ t: "call", instance: "i2" });
    if (call.t !== "call") throw new Error("expected a call");
    fake.send({ t: "reply", id: call.id, ok: true, result: { ok: true, result: { count: 9 } } });
    expect(await fake.next()).toMatchObject({ t: "render", instance: "i2" });
    // The first instance's control still answers only for the first instance.
    fake.send({ t: "event", instance: "i1", event: eventOf(tree, "Bump") });
    expect(await fake.next()).toMatchObject({ t: "call", instance: "i1" });
  });

  test("scalar payloads are type-checked against the committed control", async () => {
    const seen: unknown[] = [];
    function Form(): ReactElement {
      const [pick, setPick] = useState<string | null>("a");
      return frame(
        "box",
        {},
        frame("input", { label: "Name", value: "", onChange: (value: string) => seen.push(value) }),
        frame("toggle", { label: "On", value: false, onChange: (value: boolean) => seen.push(value) }),
        frame("select", {
          label: "Pick",
          value: pick,
          options: [
            { value: "a", label: "A" },
            { value: "b", label: "B" },
          ],
          onChange: setPick,
        }),
        frame("button", { label: "Off", disabled: true, onClick: () => seen.push("clicked") }),
      );
    }
    const { fake, tree } = await mounted({ id: "example.thing", panels: { main: Form } });
    fake.send({ t: "event", instance: "i1", event: eventOf(tree, "Name"), payload: 42 });
    fake.send({ t: "event", instance: "i1", event: eventOf(tree, "On"), payload: "yes" });
    fake.send({ t: "event", instance: "i1", event: eventOf(tree, "Pick"), payload: "z" });
    fake.send({ t: "event", instance: "i1", event: eventOf(tree, "Off") });
    fake.send({ t: "event", instance: "i1", event: eventOf(tree, "Name"), payload: "Ada" });
    fake.send({ t: "event", instance: "i1", event: eventOf(tree, "On"), payload: true });
    fake.send({ t: "event", instance: "i1", event: eventOf(tree, "Pick"), payload: "b" });
    expect(seen).toEqual(["Ada", true]);
    expect(fake.warnings).toEqual([
      expect.stringContaining("input changes must be strings"),
      expect.stringContaining("toggle changes must be booleans"),
      expect.stringContaining("not one of the select's committed options"),
      expect.stringContaining("the control is disabled"),
    ]);
    const picked = nodes(await rendered(fake)).find((node) => node.type === "select");
    expect(picked).toMatchObject({ value: "b" });
  });

  test("a removed control's event is refused, and a returning control gets a new identity", async () => {
    function Toggleable(): ReactElement {
      const [shown, setShown] = useState(true);
      return frame(
        "box",
        {},
        frame("button", { label: "Flip", onClick: () => setShown((value) => !value) }),
        shown ? frame("button", { label: "Target", onClick: () => {} }) : null,
      );
    }
    const { fake, tree } = await mounted({ id: "example.thing", panels: { main: Toggleable } });
    const retired = eventOf(tree, "Target");
    fake.send({ t: "event", instance: "i1", event: eventOf(tree, "Flip") });
    const hidden = await rendered(fake);
    expect(nodes(hidden).some((node) => "label" in node && node.label === "Target")).toBe(false);
    fake.send({ t: "event", instance: "i1", event: retired });
    expect(fake.warnings).toEqual([expect.stringContaining("no committed control holds that event")]);
    fake.send({ t: "event", instance: "i1", event: eventOf(hidden, "Flip") });
    expect(eventOf(await rendered(fake), "Target")).not.toBe(retired);
  });

  test("keyed children keep their node identity when reordered", async () => {
    function Rows(): ReactElement {
      const [order, setOrder] = useState(["a", "b"]);
      return frame(
        "box",
        {},
        frame("button", { label: "Swap", onClick: () => setOrder((rows) => [...rows].reverse()) }),
        ...order.map((row) => frame("input", { key: row, label: row, value: row })),
      );
    }
    const { fake, tree } = await mounted({ id: "example.thing", panels: { main: Rows } });
    const keys = (root: UiNode) =>
      Object.fromEntries(
        nodes(root).flatMap((node) => (node.type === "input" ? [[node.label, node.key]] : [])),
      );
    const before = keys(tree);
    fake.send({ t: "event", instance: "i1", event: eventOf(tree, "Swap") });
    const after = await rendered(fake);
    expect(nodes(after).flatMap((node) => (node.type === "input" ? [node.label] : []))).toEqual([
      "b",
      "a",
    ]);
    expect(keys(after)).toEqual(before);
  });

  test("list rows dispatch to their own callback by key", async () => {
    const opened: string[] = [];
    const Listing = (): ReactElement =>
      frame("list", {
        items: [
          { key: "one", primary: "One", onClick: () => opened.push("one") },
          { key: "two", primary: "Two" },
        ],
      });
    const { fake, tree } = await mounted({ id: "example.thing", panels: { main: Listing } });
    if (tree.type !== "list") throw new Error("expected a list");
    expect(tree.items[1]).toEqual({ key: "two", primary: "Two" });
    fake.send({ t: "event", instance: "i1", event: tree.items[0]!.event! });
    expect(opened).toEqual(["one"]);
  });
});

describe("host context", () => {
  test("context refreshes props and caps without resetting state; status reaches listeners", async () => {
    const statuses: string[] = [];
    function Viewer({ host, arg }: PortablePanelProps): ReactElement {
      const [count, setCount] = useState(0);
      useEffect(() => host.client.on("status", (status) => statuses.push(status)), [host.client]);
      return frame(
        "box",
        {},
        frame("text", {
          text: `${String(count)} in ${host.containerId ?? "root"} for ${JSON.stringify(arg)} with ${host.client.selfCaps().join(",")}`,
        }),
        frame("button", { label: "More", onClick: () => setCount((value) => value + 1) }),
      );
    }
    const { fake, tree } = await mounted(
      { id: "example.thing", panels: { main: Viewer } },
      { arg: { record: "r1" } },
    );
    fake.send({ t: "event", instance: "i1", event: eventOf(tree, "More") });
    expect(textsOf(await rendered(fake))).toEqual(['1 in c1 for {"record":"r1"} with containers:read']);
    fake.send({
      t: "context",
      instance: "i1",
      context: context({ containerId: "c2", caps: [], status: "reconnecting" }),
      arg: { record: "r2" },
    });
    expect(textsOf(await rendered(fake))).toEqual(['1 in c2 for {"record":"r2"} with ']);
    expect(statuses).toEqual(["reconnecting"]);
  });

  test("authoring exists only while the mounted view can author and names the machine by id", async () => {
    const offered: (AuthoringHandle | null)[] = [];
    const granted = Promise.withResolvers<AuthoringHandle>();
    const Author = ({ host }: PortablePanelProps): ReactElement => {
      offered.push(host.authoring);
      if (host.authoring !== null) granted.resolve(host.authoring);
      return frame("empty", { text: "author" });
    };
    const { fake } = await mounted({ id: "example.thing", panels: { main: Author } });
    expect(offered).toEqual([null]);
    fake.send({ t: "context", instance: "i1", context: context({ canAuthor: true }) });
    const authoring = await granted.promise;
    const pending = authoring.createTerminal({ id: "m1" } as MachineSummary, undefined);
    expect(fake.posted.at(-1)).toMatchObject({
      t: "call",
      instance: "i1",
      method: "createTerminal",
      args: ["m1", null],
    });
    const call = fake.posted.at(-1);
    if (call?.t !== "call") throw new Error("expected a call");
    fake.send({ t: "reply", id: call.id, ok: true, result: null });
    expect(await pending).toBeNull();
  });
});

describe("resources and teardown", () => {
  test("invalidations reach the subscriber payload-free and are acknowledged once handled", async () => {
    let hits = 0;
    function Feed({ host }: PortablePanelProps): ReactElement {
      useEffect(
        () =>
          host.client.subscribe([{ kind: "container", containerId: "c1" }], () => {
            hits += 1;
          }),
        [host.client],
      );
      return frame("empty", { text: "feed" });
    }
    const { fake } = await mounted({ id: "example.thing", panels: { main: Feed } });
    const subscribe = await fake.next();
    expect(subscribe).toMatchObject({
      t: "call",
      instance: "i1",
      method: "subscribe",
      args: [expect.any(String), [{ kind: "container", containerId: "c1" }]],
    });
    if (subscribe.t !== "call") throw new Error("expected a call");
    const id = String(subscribe.args[0]);
    fake.send({ t: "reply", id: subscribe.id, ok: true, result: null });
    fake.send({ t: "notification", id });
    expect(hits).toBe(1);
    expect(await fake.next()).toMatchObject({ t: "call", method: "ackEvent", args: [id] });
  });

  test("unmount runs effect cleanup locally, refuses late calls and absorbs late replies", async () => {
    let stream: StreamHandle | undefined;
    let cleaned = 0;
    let late: Promise<unknown> | undefined;
    let client: PortablePanelProps["host"]["client"] | undefined;
    function Owner({ host }: PortablePanelProps): ReactElement {
      useEffect(() => {
        client = host.client;
        stream = host.client.openStream({
          kind: "example.thing.output",
          node: { kind: "container", containerId: "c1" },
        });
        late = host.client.machines();
        return () => {
          cleaned += 1;
          stream?.close();
        };
      }, [host.client]);
      return frame("empty", { text: "owner" });
    }
    const { fake } = await mounted({ id: "example.thing", panels: { main: Owner } });
    const open = await fake.next();
    const machines = await fake.next();
    expect(open).toMatchObject({ t: "call", instance: "i1", method: "openStream" });
    fake.send({ t: "unmount", instance: "i1" });
    expect(cleaned).toBe(1);
    expect(stream?.status).toBe("closed");
    await expect(late).rejects.toThrow('panel "main" is unmounted');
    await expect(client!.action("example.thing.bump", {})).rejects.toThrow("is unmounted");
    if (machines.t !== "call" || open.t !== "call") throw new Error("expected calls");
    fake.send({ t: "reply", id: machines.id, ok: true, result: [] });
    // The page released everything it owned: nothing more crosses, and nothing is a stray.
    expect(fake.posted.filter((frame) => frame.t === "call")).toHaveLength(2);
    expect(fake.warnings).toEqual([]);
  });

  test("a guest fault releases what the instance owned on the page before reporting", async () => {
    function Breaks(): ReactElement {
      const [broken, setBroken] = useState(false);
      if (broken) throw new Error("render broke");
      return frame("button", { label: "Break", onClick: () => setBroken(true) });
    }
    function Holder({ host }: PortablePanelProps): ReactElement {
      useEffect(() => {
        const handle = host.client.openStream({
          kind: "example.thing.output",
          node: { kind: "container", containerId: "c1" },
        });
        return () => handle.close();
      }, [host.client]);
      return createElement(Breaks);
    }
    const { fake, tree } = await mounted({ id: "example.thing", panels: { main: Holder } });
    const open = await fake.next();
    if (open.t !== "call") throw new Error("expected a call");
    fake.send({ t: "event", instance: "i1", event: eventOf(tree, "Break") });
    expect(await fake.next()).toMatchObject({
      t: "call",
      instance: "i1",
      method: "closeStream",
      args: [open.args[0]],
    });
    expect(await fake.next()).toEqual({
      t: "fault",
      instance: "i1",
      error: 'panel "main" failed: render broke',
    });
    // The page's frames for an instance it has not yet unmounted are expected, not strays;
    // the deferred teardown has run once this turn's queued work has.
    fake.send({ t: "event", instance: "i1", event: eventOf(tree, "Break") });
    fake.send({ t: "unmount", instance: "i1" });
    await Promise.resolve();
    expect(fake.warnings).toEqual([]);
    const closes = fake.posted.filter((frame) => frame.t === "call" && frame.method === "closeStream");
    expect(closes).toHaveLength(1);
  });

  test("an error boundary keeps its tree rendering instead of faulting the instance", async () => {
    class Boundary extends Component<{ readonly children?: ReactNode }, { failed: boolean }> {
      override state = { failed: false };
      static getDerivedStateFromError(): { failed: boolean } {
        return { failed: true };
      }
      override render(): ReactNode {
        return this.state.failed ? frame("text", { text: "recovered" }) : this.props.children;
      }
    }
    const Throws = (): ReactElement => {
      throw new Error("child broke");
    };
    const { fake, tree } = await mounted({
      id: "example.thing",
      panels: { main: () => createElement(Boundary, null, createElement(Throws)) },
    });
    expect(textsOf(tree)).toEqual(["recovered"]);
    expect(fake.posted.some((frame) => frame.t === "fault")).toBe(false);
  });
});

describe("refusals", () => {
  const faultOf = async (render: () => ReactNode): Promise<string> => {
    const fake = page({ id: "example.thing", panels: { main: () => render() as ReactElement } });
    fake.send({ t: "init", pluginId: "example.thing", principal, caps: [], containerId: "c1" });
    await fake.next();
    fake.send({ t: "mount", instance: "i1", panel: "main", context: context() });
    const next = await fake.next();
    if (next.t !== "fault") throw new Error(`expected a fault, got ${JSON.stringify(next)}`);
    return next.error;
  };

  test("DOM tags, raw text, undeclared props, refs and out-of-vocabulary values refuse by name", async () => {
    expect(await faultOf(() => createElement("div"))).toContain("<div> is not a frame component");
    expect(await faultOf(() => frame("box", {}, "loose text"))).toContain("raw text cannot render");
    expect(await faultOf(() => frame("text", { text: "x", className: "styled" }))).toContain(
      '<manifold:text> does not accept "className"',
    );
    expect(await faultOf(() => frame("text", { text: "x", ref: () => {} }))).toMatch(
      /does not accept "ref"|refs are not available/,
    );
    expect(await faultOf(() => frame("text", { text: "x", tone: "neon" }))).toContain(
      "rendered a tree outside the vocabulary",
    );
    expect(
      await faultOf(() =>
        frame("list", { items: [{ key: "a", primary: "A" }, { key: "a", primary: "B" }] }),
      ),
    ).toContain('item key "a" is not unique');
  });

  test("a section refuses a panel argument on its context", async () => {
    const Side = (_props: PortableSectionProps): ReactElement => frame("empty", { text: "side" });
    const { fake } = await mounted(
      { id: "example.thing", sections: { main: Side } },
      { kind: "section" },
    );
    fake.send({ t: "context", instance: "i1", context: context(), arg: { stray: true } });
    expect(await fake.next()).toEqual({
      t: "fault",
      instance: "i1",
      error: 'section "main" failed: a section takes no argument',
    });
  });
});
