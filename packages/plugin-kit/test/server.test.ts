import { describe, expect, test } from "bun:test";
import { AsyncResource } from "node:async_hooks";
import {
  MAX_ISOLATE_EMITS,
  HARDENED_CONTRACT_VERSION,
  type Agent,
  type AgentRun,
  type SessionRef,
  type ActionResultProjection,
  type IsolateChildFrame,
  type IsolateDispatchCtx,
  type IsolateHostFrame,
  type PluginManifest,
} from "@manifold/protocol";
import { z } from "zod";
import { ActionCallError, HostCallError } from "../src/errors.ts";
import {
  attachServerGuest,
  defineServerAction,
  type GuestCtx,
  type GuestDatabase,
  type GuestStreamProducer,
  type ServerPluginDef,
  type ServerMigration,
} from "../src/server.ts";

/**
 * THE SERVER GUEST, DRIVEN BY A FAKE HOST over an in-memory transport: the same frames the
 * supervisor sends over ipc, the same answers it reads back, without a second process. What
 * these pin is the child's half of the seam — which rungs it grades, how its calls are
 * correlated to the dispatch they belong to, and that nothing leaves the child outside the
 * protocol's schema.
 */

const manifest: PluginManifest = {
  id: "example.thing",
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
  traceId: 1,
  callerPlugin: null,
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
      if (frame.t === "prepared") {
        listener({ t: "admitted", id: frame.id, allowed: true });
        return;
      }
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

describe("isolated harness", () => {
  const session: SessionRef = { harness: "test", machineId: "m1", sessionId: "s1" };
  const run: AgentRun = {
    id: "r1",
    agentId: "a1",
    session,
    activity: "idle",
    principal: { ...principal, kind: "agent" },
    rootRunId: "r1",
    parentRunId: null,
    authorizedByPrincipalId: principal.id,
    authorizationPath: "principal",
    authorizationCredential: {
      tokenId: null,
      grantId: null,
      caps: ["scenes:write"],
      containerScope: null,
    },
    purpose: "test",
    target: "manifold://",
    reach: "subtree",
    caps: ["scenes:write"],
    createdAt: 1,
    expiresAt: 1000,
    renewals: 0,
    maxDepth: 0,
    maxDescendants: 0,
    depth: 0,
    cleanupOwnerPrincipalId: principal.id,
    state: "active",
    policyRevision: "a".repeat(64),
    cleanup: { revokedCredentials: 0, revokedGrants: 0 },
  };
  const agent: Agent = {
    agentId: "a1",
    principalId: principal.id,
    sponsorPrincipalId: "sponsor",
    name: "Test",
    purpose: "test",
    harness: "test",
    grant: {
      caps: ["scenes:write"],
      targets: ["manifold://"],
      reach: "subtree",
      maxRunLifetimeMs: 60000,
      delegation: { maxDepth: 0, maxDescendants: 0 },
      expiresAt: 1000,
    },
    context: { profile: "allowed" },
    state: "idle",
    activeRuns: 0,
    createdAt: 1,
    updatedAt: 1,
  };

  function harnessDef(profileSchema: z.ZodType): ServerPluginDef {
    return {
      manifest: {
        ...manifest,
        contributes: {
          ...manifest.contributes,
          harness: {
            id: "test",
            title: "Test",
            profileSchema: z.toJSONSchema(profileSchema, { io: "input" }),
            sessionRef: "typed",
          },
        },
      },
      actions: [],
      handlers: {},
      harness: {
        profileSchema,
        launch: async () => {
          throw new Error("not exercised");
        },
        sessions: async () => [session],
        resolveSession: async (_ctx, ref) => ref,
        send: async () => {
          throw new Error("not exercised");
        },
      },
    };
  }

  async function loadHarness(def: ServerPluginDef): Promise<FakeHost> {
    const fake = host(def);
    fake.send({
      t: "load",
      pluginId: manifest.id,
      manifest: def.manifest,
      dir: "/nowhere",
      hardenedContract: HARDENED_CONTRACT_VERSION,
    });
    const frame = await fake.next();
    if (frame.t !== "loaded") throw new Error(`expected loaded, got ${frame.t}`);
    return fake;
  }

  test("the original async profile refinement decides validity", async () => {
    const schema = z.string().refine(async (value) => {
      await Promise.resolve();
      return value === "allowed";
    }, "not allowed");
    const fake = await loadHarness(harnessDef(schema));
    for (const [profile, valid] of [
      ["denied", false],
      ["allowed", true],
    ] as const) {
      fake.send({ t: "harness", id: profile, request: { method: "validateProfile", profile } });
      const frame = await fake.next();
      expect(frame).toMatchObject(
        valid
          ? { t: "harnessed", id: profile, outcome: { ok: true, result: null, emits: [] } }
          : { t: "harnessed", id: profile, outcome: { ok: false, rule: "invalid_args" } },
      );
    }
  });

  test.each(["storage", "auth", "actions", "jobs", "emit"])(
    "profile refinements cannot reuse captured %s authority, even when they swallow the refusal",
    async (slice) => {
      let captured: GuestCtx | undefined;
      const schema = z.string().superRefine(async () => {
        if (captured === undefined) throw new Error("missing captured context");
        try {
          switch (slice) {
            case "storage":
              await captured.storage.set("leak", "bad");
              break;
            case "auth":
              await captured.auth.allows("scenes:write");
              break;
            case "actions":
              await captured.actions.call({ plugin: manifest.id, action: "echo", input: {} });
              break;
            case "jobs":
              await captured.jobs.describe({ machineId: "m1", pluginId: "p1" });
              break;
            case "emit":
              captured.emit({ kind: "plugin", pluginId: manifest.id }, "thing_happened");
              break;
          }
        } catch {
          // A validator swallowing its attempted side effect must still be refused.
        }
      });
      const def = harnessDef(schema);
      if (def.harness === undefined) throw new Error("missing harness");
      const fake = await loadHarness({
        ...def,
        harness: {
          ...def.harness,
          sessions: async (ctx) => {
            captured = ctx;
            return [session];
          },
        },
      });
      fake.send({
        t: "harness",
        id: "capture",
        request: { method: "sessions", target: { machineId: "m1" } },
        ctx: ctxOf(),
      });
      expect(await fake.next()).toMatchObject({ t: "harnessed", outcome: { ok: true } });
      fake.send({
        t: "harness",
        id: "profile",
        request: { method: "validateProfile", profile: "allowed" },
      });
      expect(await fake.next()).toMatchObject({
        t: "harnessed",
        outcome: { ok: false, rule: "refused" },
      });
      expect(fake.sent.some((frame) => frame.t === "call")).toBe(false);
    },
  );

  test.each(["storage", "emit"])(
    "profile validation blocks captured live %s authority in a pre-existing async resource",
    async (slice) => {
      const resource = new AsyncResource("outside-profile-validation");
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let captured: GuestCtx | undefined;
      const schema = z.string().superRefine(async () => {
        await resource.runInAsyncScope(async () => {
          if (captured === undefined) throw new Error("missing captured context");
          try {
            if (slice === "storage") await captured.storage.set("leak", "bad");
            else captured.emit({ kind: "plugin", pluginId: manifest.id }, "thing_happened");
          } catch {
            // A swallowed attempt must still invalidate the profile.
          }
        });
      });
      const def = harnessDef(schema);
      if (def.harness === undefined) throw new Error("missing harness");
      const fake = await loadHarness({
        ...def,
        harness: {
          ...def.harness,
          sessions: async (ctx) => {
            captured = ctx;
            entered.resolve();
            await release.promise;
            return [session];
          },
        },
      });
      fake.send({
        t: "harness",
        id: "capture",
        request: { method: "sessions", target: { machineId: "m1" } },
        ctx: ctxOf(),
      });
      await entered.promise;
      fake.send({
        t: "harness",
        id: "profile",
        request: { method: "validateProfile", profile: "allowed" },
      });
      const validation = (async () => {
        try {
          let frame = await fake.next();
          // Answer a leaked call so the pre-fix regression fails instead of hanging.
          while (frame.t === "call") {
            fake.send({ t: "reply", id: frame.id, ok: true, result: null });
            frame = await fake.next();
          }
          return frame;
        } finally {
          release.resolve();
          resource.emitDestroy();
        }
      })();
      const capturedResult = validation.then(() => fake.next());
      const results = await Promise.allSettled([validation, capturedResult]);
      expect(results).toMatchObject([
        {
          status: "fulfilled",
          value: { t: "harnessed", id: "profile", outcome: { ok: false, rule: "refused" } },
        },
        {
          status: "fulfilled",
          value: { t: "harnessed", id: "capture", outcome: { ok: true, emits: [] } },
        },
      ]);
      expect(fake.sent.filter((frame) => frame.t === "call")).toEqual([]);
    },
  );

  test("overlapping validation is refused without clearing the first validation's guard", async () => {
    const resource = new AsyncResource("outside-profile-validation");
    const entered = Promise.withResolvers<void>();
    const validating = Promise.withResolvers<void>();
    const releaseValidation = Promise.withResolvers<void>();
    const releaseCapture = Promise.withResolvers<void>();
    let captured: GuestCtx | undefined;
    const schema = z.string().superRefine(async (profile) => {
      if (profile !== "first") return;
      validating.resolve();
      await releaseValidation.promise;
      resource.runInAsyncScope(() => {
        if (captured === undefined) throw new Error("missing captured context");
        try {
          captured.emit({ kind: "plugin", pluginId: manifest.id }, "thing_happened");
        } catch {
          // The first phase must retain its violation even after refusing the second.
        }
      });
    });
    const def = harnessDef(schema);
    if (def.harness === undefined) throw new Error("missing harness");
    const fake = await loadHarness({
      ...def,
      harness: {
        ...def.harness,
        sessions: async (ctx) => {
          captured = ctx;
          entered.resolve();
          await releaseCapture.promise;
          return [session];
        },
      },
    });
    fake.send({
      t: "harness",
      id: "capture",
      request: { method: "sessions", target: { machineId: "m1" } },
      ctx: ctxOf(),
    });
    await entered.promise;
    fake.send({
      t: "harness",
      id: "first",
      request: { method: "validateProfile", profile: "first" },
    });
    await validating.promise;
    fake.send({
      t: "harness",
      id: "second",
      request: { method: "validateProfile", profile: "second" },
    });
    const second = await fake.next();
    releaseValidation.resolve();
    const first = await fake.next();
    releaseCapture.resolve();
    const capture = await fake.next();
    resource.emitDestroy();
    expect(second).toMatchObject({
      t: "harnessed",
      id: "second",
      outcome: { ok: false, rule: "refused" },
    });
    expect(first).toMatchObject({
      t: "harnessed",
      id: "first",
      outcome: { ok: false, rule: "refused" },
    });
    expect(capture).toMatchObject({
      t: "harnessed",
      id: "capture",
      outcome: { ok: true, emits: [] },
    });
    fake.send({
      t: "harness",
      id: "after",
      request: { method: "validateProfile", profile: "after" },
    });
    expect(await fake.next()).toMatchObject({
      t: "harnessed",
      id: "after",
      outcome: { ok: true },
    });
  });

  test("harness launch and send share correlated host calls, and resolve checks its result", async () => {
    const def = harnessDef(z.string());
    if (def.harness === undefined) throw new Error("missing harness");
    const fake = await loadHarness({
      ...def,
      harness: {
        ...def.harness,
        launch: async (ctx, _run, _agent, target) => {
          await ctx.storage.set("launcher", ctx.auth.principal.id);
          ctx.emit({ kind: "plugin", pluginId: manifest.id }, "thing_happened");
          return {
            runtime: {
              machineId: target.machineId,
              pluginId: "test.runtime",
              operationId: "launch",
              installationRevision: "revision",
              artifactSha256: "a".repeat(64),
              resourceBindingDigest: "b".repeat(64),
              input: {},
            },
            session,
            reviewDigest: "a".repeat(64),
          };
        },
        send: async (ctx, receivedRun, input) => {
          await ctx.storage.set(receivedRun.id, input);
        },
        resolveSession: async () => null,
      },
    });
    fake.send({
      t: "harness",
      id: "launch",
      request: { method: "launch", run, agent, target: { machineId: "m1" } },
      ctx: ctxOf(),
    });
    expect(await serve(fake, null)).toMatchObject({
      id: "launch:1",
      method: "storage.set",
      args: ["launcher", principal.id],
    });
    expect(await fake.next()).toMatchObject({
      t: "harnessed",
      id: "launch",
      outcome: {
        ok: true,
        result: { session, reviewDigest: "a".repeat(64) },
        emits: [
          { ref: { kind: "plugin", pluginId: manifest.id }, kind: "thing_happened", payload: {} },
        ],
      },
    });
    fake.send({
      t: "harness",
      id: "send",
      request: { method: "send", run, input: "hello" },
      ctx: ctxOf(),
    });
    expect(await serve(fake, null)).toMatchObject({ id: "send:1", args: ["r1", "hello"] });
    expect(await fake.next()).toMatchObject({
      t: "harnessed",
      id: "send",
      outcome: { ok: true, result: null, emits: [] },
    });
    fake.send({
      t: "harness",
      id: "resolve",
      request: { method: "resolveSession", ref: session },
      ctx: ctxOf(),
    });
    expect(await fake.next()).toMatchObject({
      t: "harnessed",
      outcome: { ok: true, result: null },
    });
  });

  test("session inventory preserves truncation without an unbounded response", async () => {
    const sessions = Array.from({ length: 102 }, (_, index) => ({
      ...session,
      sessionId: `session-${String(index)}`,
    }));
    const def = harnessDef(z.string());
    if (def.harness === undefined) throw new Error("missing harness");
    const fake = await loadHarness({
      ...def,
      harness: { ...def.harness, sessions: async () => sessions },
    });
    fake.send({
      t: "harness",
      id: "truncated",
      request: { method: "sessions", target: { machineId: "m1" } },
      ctx: ctxOf(),
    });
    expect(await fake.next()).toMatchObject({
      t: "harnessed",
      outcome: { ok: true, result: sessions.slice(0, 101) },
    });
    sessions.splice(100);
    fake.send({
      t: "harness",
      id: "complete",
      request: { method: "sessions", target: { machineId: "m1" } },
      ctx: ctxOf(),
    });
    expect(await fake.next()).toMatchObject({
      t: "harnessed",
      outcome: { ok: true, result: sessions },
    });
  });

  test("loading refuses missing, incomplete, or mismatched declared harnesses", async () => {
    const def = harnessDef(z.string());
    const withoutHarness: ServerPluginDef = { manifest: def.manifest, actions: [], handlers: {} };
    for (const candidate of [
      withoutHarness,
      {
        ...def,
        harness: { profileSchema: z.string() } as unknown as NonNullable<
          ServerPluginDef["harness"]
        >,
      },
      {
        ...def,
        manifest: {
          ...def.manifest,
          contributes: {
            ...def.manifest.contributes,
            harness: {
              id: "test",
              title: "Test",
              profileSchema: { type: "number" },
              sessionRef: "typed" as const,
            },
          },
        },
      },
    ]) {
      const fake = host(candidate);
      fake.send({
        t: "load",
        pluginId: manifest.id,
        manifest: candidate.manifest,
        dir: "/nowhere",
      });
      expect(await fake.next()).toMatchObject({ t: "load_failed" });
    }
  });
});
test("a retained producer works after dispatch while other captured authority expires", async () => {
  let captured: GuestCtx | undefined;
  let producer: GuestStreamProducer | undefined;
  const fake = host({
    manifest,
    actions: [echo],
    handlers: {
      echo: async (ctx) => {
        captured = ctx;
        producer = await ctx.streams.open("example.thing.output", {
          kind: "container",
          containerId: "c1",
        });
        return { text: "started" };
      },
    },
  });
  load(fake);
  await fake.next();
  fake.send({ t: "dispatch", id: "d1", action: "echo", args: { text: "start" }, ctx: ctxOf() });
  await serve(fake, { id: "p1", epoch: "e1" });
  expect(await fake.next()).toMatchObject({ t: "dispatched", outcome: { ok: true } });
  if (producer === undefined || captured === undefined)
    throw new Error("handler did not retain its producer");
  await expect(captured.storage.get("x")).rejects.toThrow("already answered");
  await expect(
    captured.jobs.describe({ machineId: "machine", pluginId: "plugin" }),
  ).rejects.toThrow("already answered");
  await expect(captured.services.describe({ machineId: "machine" })).rejects.toThrow(
    "already answered",
  );
  await expect(captured.services.readConfiguration({ machineId: "machine" })).rejects.toThrow(
    "already answered",
  );
  await expect(
    captured.services.configureConfiguration({
      machineId: "machine",
      expectedRevision: null,
      policies: [],
    }),
  ).rejects.toThrow("already answered");
  await expect(
    captured.services.read({
      machineId: "machine",
      serviceId: "service",
      revision: "revision",
      policySha256: "a".repeat(64),
      operationId: "read",
      input: {},
    }),
  ).rejects.toThrow("already answered");
  await expect(
    captured.services.invoke({
      machineId: "machine",
      serviceId: "service",
      revision: "revision",
      policySha256: "a".repeat(64),
      operationId: "write",
      input: {},
    }),
  ).rejects.toThrow("already answered");
  const publishing = producer.publish({ line: "after return" });
  const publication = await serve(fake, null);
  expect(publication).toMatchObject({
    method: "streams.publish",
    args: ["p1", { line: "after return" }],
  });
  await publishing;
  const closing = producer.close();
  await serve(fake, null);
  await closing;
  await expect(producer.publish({ line: "too late" })).rejects.toThrow("closed");
});

describe("load", () => {
  test("publishes bounded result declarations and refuses invalid or lifecycle declarations", async () => {
    const policy: ActionResultProjection = {
      kind: "projected-json",
      fields: [["text"]],
      maxArrayItems: 4,
      maxResultBytes: 256,
    };
    const valid = host({
      manifest,
      actions: [{ ...echo, resultProjection: policy }],
      handlers: { echo: async () => ({ text: "public" }) },
    });
    load(valid);
    expect(await valid.next()).toMatchObject({
      t: "loaded",
      actions: [{ resultProjection: policy }],
    });
    for (const action of [
      { ...echo, resultProjection: { ...policy, maxResultBytes: 1_048_577 } },
      { ...echo, runAccess: "policy" as const, resultProjection: policy },
    ]) {
      const invalid = host({ manifest, actions: [action], handlers: { echo: async () => ({}) } });
      load(invalid);
      expect(await invalid.next()).toMatchObject({ t: "load_failed" });
    }
  });

  test("answers loaded with fully qualified summaries, JSON schemas and the hook flags", async () => {
    const fake = host({
      manifest,
      actions: [
        echo,
        { ...echo, name: "sweep", cleanup: true, runAccess: "teardown", scope: "container" },
      ],
      handlers: { echo: async () => ({ text: "" }), sweep: async () => ({ text: "" }) },
      lifecycle: { onEnable: () => {} },
    });
    load(fake);
    const loaded = await fake.next();
    expect(loaded.t).toBe("loaded");
    if (loaded.t !== "loaded") return;
    expect(loaded.actions.map((action) => action.name)).toEqual([
      "example.thing.echo",
      "example.thing.sweep",
    ]);
    expect(loaded.actions[0]).toMatchObject({ scope: "workspace", caps: ["containers:read"] });
    expect(loaded.actions[0]).not.toHaveProperty("cleanup");
    expect(loaded.actions[1]).toMatchObject({
      scope: "container",
      cleanup: true,
      runAccess: "teardown",
    });
    // The JSON Schema is generated from the enforcing zod schema, never written twice.
    expect(loaded.actions[0]?.input).toMatchObject({
      type: "object",
      properties: { text: { type: "string", minLength: 1 } },
    });
    expect(loaded.hooks).toEqual({
      onEnable: true,
      onDisable: false,
      onAssemblyChanged: false,
      onJobSettled: false,
    });
  });

  test("refuses to load under another id or with an action nobody handles", async () => {
    const wrongId = host({ manifest, actions: [echo], handlers: { echo: async () => ({}) } });
    load(wrongId, "acme.other");
    expect(await wrongId.next()).toEqual({
      t: "load_failed",
      error: 'loaded as "acme.other" but the manifest declares "example.thing"',
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
  test("reads only the carried immediate caller, never the request body", async () => {
    const identify = defineServerAction({
      name: "identify",
      title: "Identify caller",
      caps: [],
      input: z.looseObject({}),
      result: z.strictObject({ callerPlugin: z.string().nullable() }),
    });
    const fake = host({
      manifest,
      actions: [identify],
      handlers: {
        identify: async (ctx: GuestCtx) => ({ callerPlugin: ctx.callerPlugin }),
      },
    });
    fake.send({
      t: "load",
      pluginId: manifest.id,
      manifest,
      dir: "/nowhere",
      hardenedContract: HARDENED_CONTRACT_VERSION,
    });
    await fake.next();
    fake.send({
      t: "dispatch",
      id: "direct",
      action: "identify",
      args: { callerPlugin: "test.forged" },
      ctx: ctxOf(),
    });
    expect(await fake.next()).toMatchObject({
      t: "dispatched",
      id: "direct",
      outcome: { ok: true, result: { callerPlugin: null } },
    });
    fake.send({
      t: "dispatch",
      id: "sibling",
      action: "identify",
      args: { callerPlugin: "test.forged" },
      ctx: ctxOf({ callerPlugin: "test.middle" }),
    });
    expect(await fake.next()).toMatchObject({
      t: "dispatched",
      id: "sibling",
      outcome: { ok: true, result: { callerPlugin: "test.middle" } },
    });
    const missing = ctxOf();
    delete missing.callerPlugin;
    fake.send({
      t: "dispatch",
      id: "missing",
      action: "identify",
      args: { callerPlugin: "test.forged" },
      ctx: missing,
    });
    expect(await fake.next()).toMatchObject({
      t: "dispatched",
      id: "missing",
      outcome: { ok: false, rule: "refused", message: expect.stringContaining("callerPlugin") },
    });
  });

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
          const may = await ctx.auth.allows("containers:write", {
            kind: "container",
            containerId: "c1",
          });
          const online = await ctx.machines.isOnline("m1");
          // The fleet read reaches the SAME door an in-realm handler opens (#529): one
          // query object out, the host's outcome back — never a fact the guest invented.
          const repository = await ctx.machines.repository({ machineId: "m1", path: "/srv/w" });
          ctx.emit({ kind: "plugin", pluginId: ctx.pluginId }, "thing_happened", { id });
          return {
            text: `${previous ?? "-"}:${args.text}:${String(may)}:${String(online)}:${
              repository.ok ? repository.fact.reason : repository.reason
            }`,
          };
        },
      },
    });
    load(fake);
    await fake.next();
    fake.send({ t: "dispatch", id: "r7", action: "echo", args: { text: "hi" }, ctx: ctxOf() });
    expect(await serve(fake, "old")).toMatchObject({
      id: "r7:1",
      method: "storage.get",
      args: ["last"],
    });
    expect(await serve(fake, null)).toMatchObject({
      id: "r7:2",
      method: "storage.set",
      args: ["last", "hi"],
    });
    expect(await serve(fake, "id-9")).toMatchObject({ id: "r7:3", method: "newId", args: [] });
    expect(await serve(fake, true)).toMatchObject({
      id: "r7:4",
      method: "auth.allows",
      args: ["containers:write", { kind: "container", containerId: "c1" }],
    });
    expect(await serve(fake, false)).toMatchObject({ id: "r7:5", method: "machines.isOnline" });
    expect(await serve(fake, { ok: false, reason: "machine is offline" })).toMatchObject({
      id: "r7:6",
      method: "machines.repository",
      args: [{ machineId: "m1", path: "/srv/w" }],
    });
    expect(await fake.next()).toEqual({
      t: "dispatched",
      id: "r7",
      outcome: {
        ok: true,
        result: { text: "old:hi:true:false:machine is offline" },
        emits: [
          {
            ref: { kind: "plugin", pluginId: "example.thing" },
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
    expect(await fake.next()).toMatchObject({
      id: "b",
      outcome: { ok: true, result: { text: "two=2" } },
    });
    fake.send({ t: "reply", id: "a:1", ok: true, result: "1" });
    expect(await fake.next()).toMatchObject({
      id: "a",
      outcome: { ok: true, result: { text: "one=1" } },
    });
  });

  test("grades invalid_args against the action's own schema, in the engine's wording", async () => {
    const fake = host({
      manifest,
      actions: [echo],
      handlers: { echo: async () => ({ text: "" }) },
    });
    load(fake);
    await fake.next();
    fake.send({ t: "dispatch", id: "r1", action: "echo", args: { text: "" }, ctx: ctxOf() });
    expect(await fake.next()).toEqual({
      t: "dispatched",
      id: "r1",
      outcome: {
        ok: false,
        rule: "invalid_args",
        message: "text Too small: expected string to have >=1 characters",
      },
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
            if (error instanceof HostCallError)
              return { refused: `${error.method} said: ${error.detail}` };
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
      outcome: {
        ok: false,
        rule: "refused",
        message: "host.enabled said: slice_unavailable: host.enabled",
      },
    });
  });

  test("a sibling call is one frame, and its refusal keeps the host's class at the front", async () => {
    const fake = host({
      manifest,
      actions: [echo],
      handlers: {
        async echo(ctx: GuestCtx, args: { text: string }) {
          const asked = ctx.actions.call({
            plugin: "example.other",
            action: "run",
            input: { text: args.text },
          });
          // "raw" leaves the rejection uncaught on purpose: a hardened caller's dispatch must
          // then refuse with the host's sentence verbatim, exactly as an in-realm caller's does.
          if (args.text === "raw") return { text: String((await asked) as string) };
          try {
            return { text: String((await asked) as string) };
          } catch (error) {
            if (error instanceof ActionCallError) return { refused: `caught ${error.message}` };
            throw error;
          }
        },
      },
    });
    load(fake);
    await fake.next();

    fake.send({ t: "dispatch", id: "c1", action: "echo", args: { text: "hi" }, ctx: ctxOf() });
    const call = await fake.next();
    expect(call).toMatchObject({
      t: "call",
      method: "actions.call",
      args: [{ plugin: "example.other", action: "run", input: { text: "hi" } }],
    });
    fake.send({ t: "reply", id: "c1:1", ok: true, result: "answered" });
    expect(await fake.next()).toMatchObject({
      outcome: { ok: true, result: { text: "answered" } },
    });

    const refusal = "undeclared_dependency: example.thing -> example.other";
    fake.send({ t: "dispatch", id: "c2", action: "echo", args: { text: "hi" }, ctx: ctxOf() });
    await fake.next();
    fake.send({ t: "reply", id: "c2:1", ok: false, error: refusal });
    expect(await fake.next()).toMatchObject({
      outcome: { ok: false, rule: "refused", message: `caught ${refusal}` },
    });

    fake.send({ t: "dispatch", id: "c3", action: "echo", args: { text: "raw" }, ctx: ctxOf() });
    await fake.next();
    fake.send({ t: "reply", id: "c3:1", ok: false, error: refusal });
    expect(await fake.next()).toMatchObject({
      outcome: { ok: false, rule: "refused", message: refusal },
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

  test("compare-and-set rejects invalid keys and both oversize operands in the guest", async () => {
    const fake = host({
      manifest,
      actions: [echo],
      handlers: {
        async echo(ctx: GuestCtx, args: { text: string }) {
          const oversize = "é".repeat(32 * 1024 + 1);
          const operation =
            args.text === "reserved"
              ? ctx.storage.compareAndSet("$version", null, "9.9")
              : args.text === "malformed"
                ? ctx.storage.compareAndSet("bad key", null, "value")
                : args.text === "expected"
                  ? ctx.storage.compareAndSet("choice", oversize, "value")
                  : ctx.storage.compareAndSet("choice", null, oversize);
          // An invalid call must return its promise before the rejection is observed.
          return {
            text: await operation.then(
              () => "accepted",
              () => "rejected",
            ),
          };
        },
      },
    });
    load(fake);
    await fake.next();
    for (const text of ["reserved", "malformed", "expected", "replacement"]) {
      fake.send({ t: "dispatch", id: text, action: "echo", args: { text }, ctx: ctxOf() });
      expect(await fake.next()).toMatchObject({
        id: text,
        outcome: { ok: true, result: { text: "rejected" } },
      });
    }
    expect(fake.sent.filter((frame) => frame.t === "call")).toHaveLength(0);
  });

  test("emissions are checked as they are staged, and bounded", async () => {
    const fake = host({
      manifest,
      actions: [echo],
      handlers: {
        async echo(ctx: GuestCtx, args: { text: string }) {
          if (args.text === "kind")
            ctx.emit({ kind: "plugin", pluginId: "example.thing" }, "Not A Kind");
          else {
            for (let index = 0; index <= MAX_ISOLATE_EMITS; index++) {
              ctx.emit({ kind: "plugin", pluginId: "example.thing" }, "thing_happened");
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
      outcome: {
        ok: false,
        rule: "refused",
        message: expect.stringContaining("emit refused: kind"),
      },
    });
    fake.send({ t: "dispatch", id: "n", action: "echo", args: { text: "many" }, ctx: ctxOf() });
    expect(await fake.next()).toMatchObject({
      outcome: {
        ok: false,
        rule: "refused",
        message: `a dispatch may stage at most ${String(MAX_ISOLATE_EMITS)} emissions`,
      },
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
      outcome: {
        ok: false,
        rule: "refused",
        message: expect.stringContaining("result outside its schema"),
      },
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
          ctx.emit({ kind: "plugin", pluginId: "example.thing" }, "thing_happened");
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
    fake.send({
      t: "hook",
      id: "h3",
      hook: "onAssemblyChanged",
      delta: { enabled: ["core.notes"], disabled: [] },
    });
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

test("guest service invocation preserves a native refusal across the correlated host call", async () => {
  const args = {
    machineId: "machine",
    serviceId: "inventory",
    revision: "r1",
    policySha256: "a".repeat(64),
    operationId: "update",
    input: { enabled: true },
  };
  const fake = host({
    manifest,
    actions: [echo],
    handlers: {
      echo: async (ctx) => {
        const reply = await ctx.services.invoke(args);
        return { text: reply.ok ? "updated" : reply.refusal };
      },
    },
  });
  load(fake);
  await fake.next();
  fake.send({ t: "dispatch", id: "d1", action: "echo", args: { text: "update" }, ctx: ctxOf() });
  const frame = await serve(fake, {
    type: "service_result",
    requestId: "invocation",
    ok: false,
    refusal: "service_upstream_refused",
  });
  expect(frame).toMatchObject({ method: "services.invoke", args: [args] });
  expect(await fake.next()).toMatchObject({
    t: "dispatched",
    outcome: { ok: true, result: { text: "service_upstream_refused" } },
  });
});

test("guest job discovery cannot hide a host authority refusal", async () => {
  const fake = host({
    manifest,
    actions: [echo],
    handlers: {
      echo: async (ctx) => {
        await ctx.jobs.describe({
          machineId: "machine",
          pluginId: "worker",
          installationRevision: "r1",
        });
        return { text: "unexpected access" };
      },
    },
  });
  load(fake);
  await fake.next();
  fake.send({ t: "dispatch", id: "d1", action: "echo", args: { text: "describe" }, ctx: ctxOf() });
  const frame = await fake.next();
  if (frame.t !== "call") throw new Error("missing discovery call");
  expect(frame).toMatchObject({
    method: "jobs.describe",
    args: [{ machineId: "machine", pluginId: "worker", installationRevision: "r1" }],
  });
  fake.send({ t: "reply", id: frame.id, ok: false, error: "governed_authority_refused" });
  expect(await fake.next()).toMatchObject({ t: "dispatched", outcome: { ok: false } });
});

describe("named storage migrations", () => {
  // Mixed-arity rows: without the row type, `descriptors` widens to a union whose narrowest
  // branch has neither `name` nor `to`, and the spread below stops being a `ServerMigration`.
  test.each<{ name: string; to: { major: number; minor: number } }[]>([
    [{ name: "", to: { major: 2, minor: 0 } }],
    [{ name: "bad name", to: { major: 2, minor: 0 } }],
    [{ name: "invalid", to: { major: -1, minor: 0 } }],
    [{ name: "fractional", to: { major: 1, minor: 0.5 } }],
    [{ name: "future", to: { major: 3, minor: 0 } }],
    [
      { name: "duplicate", to: { major: 1, minor: 0 } },
      { name: "duplicate", to: { major: 2, minor: 0 } },
    ],
  ])("refuses malformed or ambiguous migration metadata: %j", async (...descriptors) => {
    const versioned = { ...manifest, dataVersion: { major: 2, minor: 0 } };
    const fake = host({
      manifest: versioned,
      actions: [],
      handlers: {},
      migrations: descriptors.map(
        (descriptor) =>
          ({
            ...descriptor,
            migrate: () => {
              throw new Error("must not run during load");
            },
          }) as ServerMigration,
      ),
    });
    fake.send({ t: "load", pluginId: manifest.id, manifest: versioned, dir: "/unused" });
    expect(await fake.next()).toMatchObject({ t: "load_failed" });
  });

  test("requires a declared data version and refuses unknown names or mismatched targets", async () => {
    let invocations = 0;
    const migration = {
      name: "widen",
      to: { major: 2, minor: 0 },
      migrate: () => {
        invocations += 1;
      },
    };
    const missing = host({ manifest, actions: [], handlers: {}, migrations: [migration] });
    load(missing);
    expect(await missing.next()).toMatchObject({ t: "load_failed" });
    const versioned = { ...manifest, dataVersion: { major: 2, minor: 0 } };
    const fake = host({ manifest: versioned, actions: [], handlers: {}, migrations: [migration] });
    fake.send({ t: "load", pluginId: manifest.id, manifest: versioned, dir: "/unused" });
    expect(await fake.next()).toMatchObject({
      t: "loaded",
      migrations: [{ name: "widen", to: { major: 2, minor: 0 } }],
    });
    for (const descriptor of [
      { name: "unknown", to: { major: 2, minor: 0 } },
      { name: "widen", to: { major: 1, minor: 0 } },
    ]) {
      fake.send({ t: "migrate", id: descriptor.name, migration: descriptor });
      expect(await fake.next()).toMatchObject({
        t: "migrated",
        outcome: { ok: false },
      });
    }
    expect(invocations).toBe(0);
  });

  test.each([false, true])(
    "migration database authority follows the loaded candidate: %s",
    async (declared) => {
      let captured: GuestDatabase | undefined;
      const versioned = { ...manifest, dataVersion: { major: 2, minor: 0 } };
      const fake = host({
        manifest: { ...versioned, ...(!declared ? { database: {} } : {}) },
        actions: [],
        handlers: {},
        migrations: [
          {
            name: "rows",
            to: { major: 2, minor: 0 },
            migrate: async (_storage, database) => {
              captured = database;
              if (database !== undefined) await database.run("CREATE TABLE rows(value TEXT)");
            },
          },
        ],
      });
      fake.send({
        t: "load",
        pluginId: manifest.id,
        manifest: { ...versioned, ...(declared ? { database: {} } : {}) },
        dir: "/unused",
      });
      await fake.next();
      fake.send({
        t: "migrate",
        id: "migration",
        migration: { name: "rows", to: { major: 2, minor: 0 } },
      });
      if (declared)
        await serve(fake, {
          changes: 0,
          lastInsertRowid: { "$manifold.sql": "bigint", value: "0" },
        });
      expect(await fake.next()).toMatchObject({ t: "migrated", outcome: { ok: true } });
      expect(captured !== undefined).toBe(declared);
      if (captured !== undefined) {
        const frames = fake.sent.length;
        await expect(captured.run("DROP TABLE rows")).rejects.toThrow();
        expect(fake.sent.length).toBe(frames);
      }
    },
  );
});
