import { describe, expect, test } from "bun:test";
import {
  MAX_ISOLATE_EMITS,
  type IsolateChildFrame,
  type IsolateDispatchCtx,
  type IsolateHostFrame,
  type PluginManifest,
} from "@manifold/protocol";
import { z } from "zod";
import { HostCallError } from "../src/errors.ts";
import {
  attachServerGuest,
  defineServerAction,
  type GuestCtx,
  type ServerPluginDef,
} from "../src/server.ts";

/**
 * THE SERVER GUEST, DRIVEN BY A FAKE HOST over an in-memory transport: the same frames the
 * supervisor sends over ipc, the same answers it reads back, without a second process. What
 * these pin is the child's half of the seam — which rungs it grades, how its calls are
 * correlated to the dispatch they belong to, and that nothing leaves the child outside the
 * protocol's schema.
 */

const manifest: PluginManifest = {
  id: "acme.thing",
  version: "1.0.0",
  title: "Thing",
  description: "",
  capabilities: ["containers:read"],
  contributes: {
    panels: [],
    sections: [],
    elements: [],
    tools: [],
    events: [{ id: "thing_happened", title: "Thing happened" }],
  },
  entry: { server: true },
};

const principal = { id: "p1", kind: "human", name: "Ada", color: "#e03131" } as const;

const ctxOf = (overrides: Partial<IsolateDispatchCtx> = {}): IsolateDispatchCtx => ({
  principal,
  caps: ["containers:read"],
  isRoot: false,
  containerScope: null,
  now: 1_000,
  ...overrides,
});

const echo = defineServerAction({
  name: "echo",
  title: "Echo",
  caps: ["containers:read"],
  input: z.strictObject({ text: z.string().min(1) }),
  result: z.strictObject({ text: z.string() }),
});

interface FakeHost {
  send(frame: IsolateHostFrame): void;
  next(): Promise<IsolateChildFrame>;
  readonly sent: IsolateChildFrame[];
  readonly warnings: string[];
  exited(): number | null;
}

function host(def: ServerPluginDef): FakeHost {
  const sent: IsolateChildFrame[] = [];
  const queue: IsolateChildFrame[] = [];
  const waiting: ((frame: IsolateChildFrame) => void)[] = [];
  const warnings: string[] = [];
  let listener: (frame: unknown) => void = () => {};
  let exited: number | null = null;
  attachServerGuest(def, {
    send: (frame) => {
      sent.push(frame);
      const waiter = waiting.shift();
      if (waiter === undefined) queue.push(frame);
      else waiter(frame);
    },
    onMessage: (next) => {
      listener = next;
    },
    exit: (code) => {
      exited = code;
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
      const { promise, resolve } = Promise.withResolvers<IsolateChildFrame>();
      waiting.push(resolve);
      return promise;
    },
    sent,
    warnings,
    exited: () => exited,
  };
}

/** Answers the child's next `call` with `result`, returning the call frame it answered. */
async function serve(
  fake: FakeHost,
  result: unknown,
): Promise<Extract<IsolateChildFrame, { t: "call" }>> {
  const frame = await fake.next();
  if (frame.t !== "call") throw new Error(`expected a call, got ${frame.t}`);
  fake.send({ t: "reply", id: frame.id, ok: true, result });
  return frame;
}

function load(fake: FakeHost, pluginId = manifest.id): void {
  fake.send({ t: "load", pluginId, manifest, dir: "/nowhere" });
}

describe("load", () => {
  test("answers loaded with fully qualified summaries, JSON schemas and the hook flags", async () => {
    const fake = host({
      manifest,
      actions: [echo, { ...echo, name: "sweep", cleanup: true, scope: "container" }],
      handlers: { echo: async () => ({ text: "" }), sweep: async () => ({ text: "" }) },
      lifecycle: { onEnable: () => {} },
    });
    load(fake);
    const loaded = await fake.next();
    expect(loaded.t).toBe("loaded");
    if (loaded.t !== "loaded") return;
    expect(loaded.actions.map((action) => action.name)).toEqual([
      "acme.thing.echo",
      "acme.thing.sweep",
    ]);
    expect(loaded.actions[0]).toMatchObject({ scope: "workspace", caps: ["containers:read"] });
    expect(loaded.actions[0]).not.toHaveProperty("cleanup");
    expect(loaded.actions[1]).toMatchObject({ scope: "container", cleanup: true });
    // The JSON Schema is generated from the enforcing zod schema, never written twice.
    expect(loaded.actions[0]?.input).toMatchObject({
      type: "object",
      properties: { text: { type: "string", minLength: 1 } },
    });
    expect(loaded.hooks).toEqual({ onEnable: true, onDisable: false, onAssemblyChanged: false });
  });

  test("refuses to load under another id or with an action nobody handles", async () => {
    const wrongId = host({ manifest, actions: [echo], handlers: { echo: async () => ({}) } });
    load(wrongId, "acme.other");
    expect(await wrongId.next()).toEqual({
      t: "load_failed",
      error: 'loaded as "acme.other" but the manifest declares "acme.thing"',
    });

    const unhandled = host({ manifest, actions: [echo], handlers: {} });
    load(unhandled);
    expect(await unhandled.next()).toEqual({
      t: "load_failed",
      error: 'action "echo" has no handler',
    });

    const orphan = host({
      manifest,
      actions: [echo],
      handlers: { echo: async () => ({}), ghost: async () => ({}) },
    });
    load(orphan);
    expect(await orphan.next()).toEqual({
      t: "load_failed",
      error: 'handler "ghost" has no declared action',
    });
  });
});

describe("dispatch", () => {
  test("serves the ctx over calls correlated to the dispatch, stages emits, answers ok", async () => {
    const fake = host({
      manifest,
      actions: [echo],
      handlers: {
        async echo(ctx: GuestCtx, args: { text: string }) {
          expect(ctx.principal).toEqual(principal);
          expect(ctx.now()).toBe(1_000);
          expect(ctx.auth.caps).toEqual(["containers:read"]);
          const previous = await ctx.storage.get("last");
          await ctx.storage.set("last", args.text);
          const id = await ctx.newId();
          const may = await ctx.auth.allows("containers:write", "c1");
          const online = await ctx.machines.isOnline("m1");
          ctx.emit({ kind: "plugin", pluginId: ctx.pluginId }, "thing_happened", { id });
          return { text: `${previous ?? "-"}:${args.text}:${String(may)}:${String(online)}` };
        },
      },
    });
    load(fake);
    await fake.next();
    fake.send({ t: "dispatch", id: "r7", action: "echo", args: { text: "hi" }, ctx: ctxOf() });
    expect(await serve(fake, "old")).toMatchObject({ id: "r7:1", method: "storage.get", args: ["last"] });
    expect(await serve(fake, null)).toMatchObject({ id: "r7:2", method: "storage.set", args: ["last", "hi"] });
    expect(await serve(fake, "id-9")).toMatchObject({ id: "r7:3", method: "newId", args: [] });
    expect(await serve(fake, true)).toMatchObject({
      id: "r7:4",
      method: "auth.allows",
      args: ["containers:write", "c1"],
    });
    expect(await serve(fake, false)).toMatchObject({ id: "r7:5", method: "machines.isOnline" });
    expect(await fake.next()).toEqual({
      t: "dispatched",
      id: "r7",
      outcome: {
        ok: true,
        result: { text: "old:hi:true:false" },
        emits: [
          {
            ref: { kind: "plugin", pluginId: "acme.thing" },
            kind: "thing_happened",
            payload: { id: "id-9" },
          },
        ],
      },
    });
  });

  test("two dispatches in flight keep their own calls apart", async () => {
    const fake = host({
      manifest,
      actions: [echo],
      handlers: {
        async echo(ctx: GuestCtx, args: { text: string }) {
          return { text: `${args.text}=${(await ctx.storage.get(args.text)) ?? "?"}` };
        },
      },
    });
    load(fake);
    await fake.next();
    fake.send({ t: "dispatch", id: "a", action: "echo", args: { text: "one" }, ctx: ctxOf() });
    fake.send({ t: "dispatch", id: "b", action: "echo", args: { text: "two" }, ctx: ctxOf() });
    const first = await fake.next();
    const second = await fake.next();
    expect([first, second].map((frame) => (frame.t === "call" ? frame.id : frame.t))).toEqual([
      "a:1",
      "b:1",
    ]);
    // Answer the later one first: each outcome must follow its own reply, not arrival order.
    fake.send({ t: "reply", id: "b:1", ok: true, result: "2" });
    expect(await fake.next()).toMatchObject({ id: "b", outcome: { ok: true, result: { text: "two=2" } } });
    fake.send({ t: "reply", id: "a:1", ok: true, result: "1" });
    expect(await fake.next()).toMatchObject({ id: "a", outcome: { ok: true, result: { text: "one=1" } } });
  });

  test("grades invalid_args against the action's own schema, in the engine's wording", async () => {
    const fake = host({ manifest, actions: [echo], handlers: { echo: async () => ({ text: "" }) } });
    load(fake);
    await fake.next();
    fake.send({ t: "dispatch", id: "r1", action: "echo", args: { text: "" }, ctx: ctxOf() });
    expect(await fake.next()).toEqual({
      t: "dispatched",
      id: "r1",
      outcome: { ok: false, rule: "invalid_args", message: "text Too small: expected string to have >=1 characters" },
    });
  });

  test("a { refused } answer, a thrown error and an unserved slice are all the refused rung", async () => {
    const fake = host({
      manifest,
      actions: [echo],
      handlers: {
        async echo(ctx: GuestCtx, args: { text: string }) {
          if (args.text === "no") return { refused: "not today" };
          if (args.text === "boom") throw new Error("kaboom");
          // A first-party habit an isolated plugin cannot keep: the slice is not served.
          return { text: String(Reflect.get(ctx, "rooms")) };
        },
      },
    });
    load(fake);
    await fake.next();
    for (const [text, message] of [
      ["no", "not today"],
      ["boom", "kaboom"],
      ["rooms", "rooms is not served to an isolated plugin"],
    ] as const) {
      fake.send({ t: "dispatch", id: text, action: "echo", args: { text }, ctx: ctxOf() });
      expect(await fake.next()).toEqual({
        t: "dispatched",
        id: text,
        outcome: { ok: false, rule: "refused", message },
      });
    }
    expect(fake.warnings).toEqual([
      'action "echo" failed: kaboom',
      'action "echo" failed: rooms is not served to an isolated plugin',
    ]);
  });

  test("a host reply of ok:false rejects the call with the host's own sentence", async () => {
    const fake = host({
      manifest,
      actions: [echo],
      handlers: {
        async echo(ctx: GuestCtx) {
          try {
            await ctx.host.enabled("core.notes");
          } catch (error) {
            if (error instanceof HostCallError) return { refused: `${error.method} said: ${error.detail}` };
          }
          return { text: "unreachable" };
        },
      },
    });
    load(fake);
    await fake.next();
    fake.send({ t: "dispatch", id: "r1", action: "echo", args: { text: "x" }, ctx: ctxOf() });
    const call = await fake.next();
    fake.send({ t: "reply", id: "r1:1", ok: false, error: "slice_unavailable: host.enabled" });
    expect(call).toMatchObject({ t: "call", method: "host.enabled" });
    expect(await fake.next()).toMatchObject({
      outcome: { ok: false, rule: "refused", message: "host.enabled said: slice_unavailable: host.enabled" },
    });
  });

  test("storage refuses a reserved key and an oversize value before any call leaves", async () => {
    const fake = host({
      manifest,
      actions: [echo],
      handlers: {
        async echo(ctx: GuestCtx, args: { text: string }) {
          if (args.text === "key") await ctx.storage.get("$version");
          else await ctx.storage.set("big", "x".repeat(64 * 1024 + 1));
          return { text: "unreachable" };
        },
      },
    });
    load(fake);
    await fake.next();
    fake.send({ t: "dispatch", id: "k", action: "echo", args: { text: "key" }, ctx: ctxOf() });
    expect(await fake.next()).toMatchObject({
      id: "k",
      outcome: { ok: false, rule: "refused", message: expect.stringContaining("reserved") },
    });
    fake.send({ t: "dispatch", id: "v", action: "echo", args: { text: "value" }, ctx: ctxOf() });
    expect(await fake.next()).toMatchObject({
      id: "v",
      outcome: { ok: false, rule: "refused", message: expect.stringContaining("65537 bytes") },
    });
    expect(fake.sent.filter((frame) => frame.t === "call")).toHaveLength(0);
  });

  test("emissions are checked as they are staged, and bounded", async () => {
    const fake = host({
      manifest,
      actions: [echo],
      handlers: {
        async echo(ctx: GuestCtx, args: { text: string }) {
          if (args.text === "kind") ctx.emit({ kind: "plugin", pluginId: "acme.thing" }, "Not A Kind");
          else {
            for (let index = 0; index <= MAX_ISOLATE_EMITS; index++) {
              ctx.emit({ kind: "plugin", pluginId: "acme.thing" }, "thing_happened");
            }
          }
          return { text: "unreachable" };
        },
      },
    });
    load(fake);
    await fake.next();
    fake.send({ t: "dispatch", id: "k", action: "echo", args: { text: "kind" }, ctx: ctxOf() });
    expect(await fake.next()).toMatchObject({
      outcome: { ok: false, rule: "refused", message: expect.stringContaining("emit refused: kind") },
    });
    fake.send({ t: "dispatch", id: "n", action: "echo", args: { text: "many" }, ctx: ctxOf() });
    expect(await fake.next()).toMatchObject({
      outcome: { ok: false, rule: "refused", message: `a dispatch may stage at most ${String(MAX_ISOLATE_EMITS)} emissions` },
    });
  });

  test("a result outside its published schema is refused rather than sent", async () => {
    const fake = host({
      manifest,
      actions: [echo],
      handlers: { echo: async () => ({ text: 42 }) },
    });
    load(fake);
    await fake.next();
    fake.send({ t: "dispatch", id: "r1", action: "echo", args: { text: "x" }, ctx: ctxOf() });
    expect(await fake.next()).toMatchObject({
      outcome: { ok: false, rule: "refused", message: expect.stringContaining("result outside its schema") },
    });
  });
});

describe("hooks, shutdown and stray frames", () => {
  test("a hook runs against storage under its own id; a hook that emits fails by name", async () => {
    const fake = host({
      manifest,
      actions: [],
      handlers: {},
      lifecycle: {
        onEnable: async (ctx) => {
          await ctx.storage.set("enabled", "1");
        },
        onDisable: (ctx) => {
          ctx.emit({ kind: "plugin", pluginId: "acme.thing" }, "thing_happened");
        },
        onAssemblyChanged: (_ctx, delta) => {
          if (delta.enabled[0] !== "core.notes") throw new Error("wrong delta");
        },
      },
    });
    load(fake);
    await fake.next();
    fake.send({ t: "hook", id: "h1", hook: "onEnable" });
    expect(await serve(fake, null)).toMatchObject({ id: "h1:1", method: "storage.set" });
    expect(await fake.next()).toEqual({ t: "hooked", id: "h1", ok: true });
    fake.send({ t: "hook", id: "h2", hook: "onDisable" });
    expect(await fake.next()).toEqual({
      t: "hooked",
      id: "h2",
      ok: false,
      error: "emit is not served to an isolated plugin",
    });
    fake.send({ t: "hook", id: "h3", hook: "onAssemblyChanged", delta: { enabled: ["core.notes"], disabled: [] } });
    expect(await fake.next()).toEqual({ t: "hooked", id: "h3", ok: true });
  });

  test("shutdown exits 0; an unknown frame and a reply for nobody are ignored with a line", () => {
    const fake = host({ manifest, actions: [], handlers: {} });
    fake.send({ t: "bogus" } as unknown as IsolateHostFrame);
    fake.send({ t: "reply", id: "nobody", ok: true, result: null });
    expect(fake.exited()).toBeNull();
    fake.send({ t: "shutdown" });
    expect(fake.exited()).toBe(0);
    expect(fake.warnings).toEqual([
      expect.stringContaining("unknown host frame ignored"),
      'reply for unknown call "nobody"; ignored',
    ]);
    expect(fake.sent).toEqual([]);
  });
});
