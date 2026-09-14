import "../src/shared-modules.ts";
import { afterEach, describe, expect, test } from "bun:test";
import {
  CreateRunCredentialResultSchema,
  RenewAgentRunResultSchema,
  PublicJobSchema,
  formatManifoldUri,
  type ActionOutcome,
  type CreateChildRunRequest,
  type CreateRunCredentialResult,
  type MachineHalf,
  type IsolateChildFrame,
  type IsolateHostFrame,
  type PluginManifest,
} from "@manifold/protocol";
import { attachServerGuest, defineServerAction } from "@manifold/plugin-kit/server";
import { z } from "zod";
import {
  buildIsolateDef,
  serveCtxCall,
  type IsolateDispatchOutcome,
} from "../src/isolate/proxy-def.ts";
import { AuthService, type AuthContext } from "../src/auth.ts";
import { JobService } from "../src/job-service.ts";
import { silentLogger } from "../src/log.ts";
import type { ActionCtx, ServerPluginDef } from "../src/plugin-host.ts";
import { RoomManager } from "../src/room.ts";
import { TRACE_ROW_TYPE, type ServerStore } from "../src/stores.ts";
import { TerminalBroker } from "../src/terminal-broker.ts";
import { FakeClock, FakeRuntime, testPluginHost, testStore, testTileTrees } from "./helpers.ts";
import { createExternalRun, type ExternalRunFixtureInput } from "./agent-fixtures.ts";

const stores = new Set<ServerStore>();
afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
});

const pluginId = "test.admission";
const operationId = `${pluginId}.run`;
const artifact = "a".repeat(64);
const machine: MachineHalf = {
  artifacts: {
    "linux-x64": {
      url: "https://example.invalid/admission",
      sha256: artifact,
      entrySha256: artifact,
      format: "raw",
      entry: ["admission"],
      maxBytes: 4096,
      maxExpandedBytes: 4096,
      maxMembers: 1,
    },
  },
  operations: {
    [operationId]: {
      argv: [{ input: "value" }],
      input: { value: { type: "string", required: true, maxLength: 32 } },
      runtimeTools: [],
      locations: [],
      outputs: [],
      network: "none",
      limits: { timeoutMs: 1000, memoryBytes: 1048576, processes: 1, outputBytes: 65536 },
      stdin: false,
    },
  },
  locations: {},
};
const machinePlugin: ServerPluginDef = {
  manifest: {
    id: pluginId,
    version: "1.0.0",
    title: "Admission fixture",
    description: "",
    capabilities: [],
    contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
    machine,
  },
  actions: [],
  handlers: {},
};
const child = {
  target: "manifold://",
  reach: "subtree",
  caps: ["containers:read"],
} as const;

function value(outcome: ActionOutcome): unknown {
  if (!outcome.ok) throw new Error(`fixture action refused: ${outcome.denial.message}`);
  return outcome.result;
}

async function fixture(settingsPlugins: readonly ServerPluginDef[] = []) {
  const runtime = new FakeRuntime();
  const store = testStore();
  stores.add(store);
  const auth = new AuthService(store, "j".repeat(64), runtime);
  const owner = auth.authenticate("j".repeat(64));
  const clock = new FakeClock(runtime);
  const rooms = new RoomManager(store, runtime, clock, silentLogger, testTileTrees);
  const broker = new TerminalBroker(
    store,
    auth,
    rooms,
    runtime,
    clock,
    silentLogger,
    () => "http://localhost:7777",
    testTileTrees,
  );
  const host = await testPluginHost(store, auth, rooms, broker, runtime, {
    settingsPlugins: [machinePlugin, ...settingsPlugins],
  });
  const jobs = new JobService(store, auth, runtime);
  host.setJobs(jobs);
  const machineId = auth.enrollMachine("admission machine", owner).machine.id;
  jobs.install(owner, {
    machineId,
    pluginId,
    installationRevision: "one",
    artifactSha256: artifact,
    machine,
  });
  const admitted = (created: CreateRunCredentialResult) => {
    const actor = auth.authenticate(created.credential.token);
    const challenge = auth.agentPolicyChallenge(actor);
    auth.acknowledgeAgentPolicy(
      {
        revision: challenge.revision,
        acknowledgements: challenge.required.map(({ id, digest }) => ({ id, digest })),
      },
      actor,
    );
    return { actor, created };
  };
  const newRun = (sponsor: AuthContext = owner, overrides: Partial<ExternalRunFixtureInput> = {}) =>
    admitted(
      createExternalRun(
        { auth, runtime, owner },
        {
          name: `admission ${runtime.newId()}`,
          purpose: "Read the assigned task.",
          target: "manifold://",
          reach: "subtree",
          caps: [
            "agents:delegate",
            "containers:read",
            "machines:run",
            "jobs:read",
            "operations:invoke",
          ],
          lifetimeMs: 600_000,
          ...overrides,
        },
        sponsor,
      ),
    );
  const newChildRun = (actor: AuthContext, overrides: Omit<CreateChildRunRequest, "runId">) => {
    if (actor.agentRunId === undefined) throw new Error("child fixture requires a parent run");
    return admitted(
      CreateRunCredentialResultSchema.parse(
        auth.createChildRun(
          {
            ...overrides,
            runId: actor.agentRunId,
          },
          actor,
        ),
      ),
    );
  };
  const { actor, created } = newRun();
  const request = {
    jobId: "admission-job",
    machineId,
    pluginId,
    operationId,
    input: { value: "safe" },
    outputs: [],
  };
  const schedule = {
    ...request,
    scheduleId: "admission-schedule",
    revision: "one",
    firstNominalAt: 1000,
    intervalMs: 60_000,
    deadlineMs: 30_000,
    expiresAt: 120_000,
    offlinePolicy: "skip",
  };
  const consent = (cap: "machines:run" | "jobs:read" | "operations:invoke", enabled = true) =>
    jobs.consent(owner, {
      machineId,
      pluginId,
      installationRevision: "one",
      artifactSha256: artifact,
      node: formatManifoldUri({ kind: "operation", machineId, operationId }),
      cap,
      enabled,
    });
  const trace = () => {
    const row = store.listEvents({ type: TRACE_ROW_TYPE, limit: 1 })[0];
    if (row === undefined) throw new Error("dispatch left no trace");
    return row;
  };
  return {
    runtime,
    store,
    auth,
    owner,
    host,
    jobs,
    actor,
    created,
    newRun,
    newChildRun,
    request,
    schedule,
    consent,
    trace,
  };
}

describe("declarations follow real first-party admission", () => {
  test("create target scope and delegated capability refusers precede a missing claim", async () => {
    const f = await fixture();
    const scoped = f.newRun(f.owner, { target: "manifold://container/inside" });
    expect(
      await f.host.dispatch(scoped.actor, "core.access.createChildRun", {
        ...child,
        runId: scoped.created.run.id,
      }),
    ).toEqual({
      ok: false,
      denial: { rule: "refused", message: "target_exceeds_grant" },
    });
    expect(
      await f.host.dispatch(f.actor, "core.access.createChildRun", {
        ...child,
        runId: f.created.run.id,
        caps: ["terminals:write"],
      }),
    ).toEqual({
      ok: false,
      denial: { rule: "refused", message: "cap_exceeds_grant" },
    });
    expect(f.store.listAgentRunTree(f.created.run.id).map((run) => run.id)).toEqual([
      f.created.run.id,
    ]);
  });

  test("renewal rejects an unrelated run before missing or invalid declarations", async () => {
    const f = await fixture();
    const unrelated = f.newRun();
    for (const options of [undefined, { agentJustification: " " }]) {
      expect(
        await f.host.dispatch(
          unrelated.actor,
          "core.access.renewAgentRun",
          {
            runId: f.created.run.id,
          },
          null,
          options,
        ),
      ).toEqual({
        ok: false,
        denial: { rule: "refused", message: "agent_unavailable" },
      });
      expect(f.trace().outcome).toBe("refused");
    }
    expect(f.store.getAgentRun(f.created.run.id)?.renewals).toBe(0);
  });

  test("renewal rechecks the sponsor's authority at the existing run target", async () => {
    const f = await fixture();
    const sponsored = f.newChildRun(f.actor, {
      target: "manifold://container/inside",
      caps: ["containers:read"],
      lifetimeMs: 60_000,
    });
    f.auth.grant(
      {
        principal: { kind: "principal", id: f.actor.principal.id },
        node: sponsored.created.run.target,
        caps: ["containers:read"],
        effect: "deny",
        reach: "subtree",
      },
      f.owner,
    );
    expect(
      await f.host.dispatch(sponsored.actor, "core.access.renewAgentRun", {
        runId: sponsored.created.run.id,
        lifetimeMs: 120_000,
      }),
    ).toEqual({
      ok: false,
      denial: { rule: "refused", message: "sponsor_authority_unavailable" },
    });
    expect(f.store.getAgentRun(sponsored.created.run.id)?.renewals).toBe(0);
  });

  test("admitted create and renewal reject declarations before creating or replacing credentials", async () => {
    const f = await fixture();
    expect(
      await f.host.dispatch(f.actor, "core.access.createChildRun", {
        ...child,
        runId: f.created.run.id,
      }),
    ).toMatchObject({
      ok: false,
      denial: { rule: "justification_required" },
    });
    expect(f.trace().outcome).toBe("justification_required");
    expect(f.store.listAgentRunTree(f.created.run.id).map((run) => run.id)).toEqual([
      f.created.run.id,
    ]);
    const sponsored = f.newChildRun(f.actor, { caps: ["containers:read"], lifetimeMs: 60_000 });
    const before = f.store.getAgentRun(sponsored.created.run.id);
    expect(
      await f.host.dispatch(
        sponsored.actor,
        "core.access.renewAgentRun",
        {
          runId: sponsored.created.run.id,
          lifetimeMs: 120_000,
        },
        null,
        { agentJustification: " " },
      ),
    ).toMatchObject({
      ok: false,
      denial: { rule: "invalid_justification" },
    });
    expect(f.trace().outcome).toBe("invalid_justification");
    expect(f.store.getAgentRun(sponsored.created.run.id)).toEqual(before);
    expect(f.auth.authenticate(sponsored.created.credential.token).agentRunId).toBe(
      sponsored.created.run.id,
    );
    const renewed = RenewAgentRunResultSchema.parse(
      value(
        await f.host.dispatch(
          sponsored.actor,
          "core.access.renewAgentRun",
          { runId: sponsored.created.run.id, lifetimeMs: 120_000 },
          null,
          { agentJustification: "Renew the bounded reading task." },
        ),
      ),
    );
    expect(renewed.run.renewals).toBe(1);
    expect(renewed.run.expiresAt).toBe(120_000);
  });

  test("invalid native operation and full operation input preserve their original refusal", async () => {
    const f = await fixture();
    for (const args of [
      { ...f.request, operationId: "test.admission.missing" },
      { ...f.request, input: { value: 42 } },
    ]) {
      expect(await f.host.dispatch(f.actor, "engine.jobs.execute", args)).toEqual({
        ok: false,
        denial: { rule: "refused", message: "forbidden: job request refused" },
      });
      expect(f.trace().outcome).toBe("refused");
    }
    expect(f.jobs.jobs.get(f.request.jobId)).toBeNull();
  });

  test("native actual admission denial is not replaced by a declaration refusal", async () => {
    const f = await fixture();
    const refused = PublicJobSchema.parse(
      value(await f.host.dispatch(f.actor, "engine.jobs.execute", f.request)),
    );
    expect(refused.state).toBe("refused");
    expect(f.jobs.jobs.get(f.request.jobId)?.state).toBe("refused");
    expect(await f.host.dispatch(f.actor, "engine.jobs.schedule", f.schedule)).toEqual({
      ok: false,
      denial: { rule: "refused", message: "forbidden: job request refused" },
    });
    expect(f.jobs.schedules(f.owner)).toEqual([]);
  });

  test("admitted native effects reject claims before jobs, decisions or schedules are written", async () => {
    const f = await fixture();
    f.consent("machines:run");
    const decisions = f.store.db
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM machine_job_decisions")
      .get()?.count;
    const revisions = f.store.db
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM machine_job_revisions")
      .get()?.count;
    for (const [door, args] of [
      ["engine.jobs.execute", f.request],
      ["engine.jobs.schedule", f.schedule],
    ] as const) {
      expect(await f.host.dispatch(f.actor, door, args)).toMatchObject({
        ok: false,
        denial: { rule: "justification_required" },
      });
      expect(f.trace()).toMatchObject({ door, outcome: "justification_required" });
      expect(
        await f.host.dispatch(f.actor, door, args, null, { agentJustification: " " }),
      ).toMatchObject({
        ok: false,
        denial: { rule: "invalid_justification" },
      });
    }
    expect(f.jobs.jobs.get(f.request.jobId)).toBeNull();
    expect(f.jobs.schedules(f.owner)).toEqual([]);
    expect(
      f.store.db
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM machine_job_decisions")
        .get()?.count,
    ).toBe(decisions);
    expect(
      f.store.db
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM machine_job_revisions")
        .get()?.count,
    ).toBe(revisions);
  });

  test("schedule expiry and immutable revision refusers still precede declaration enforcement", async () => {
    const f = await fixture();
    f.consent("machines:run");
    f.consent("operations:invoke");
    await expect(
      f.host.dispatch(f.actor, "engine.jobs.schedule", {
        ...f.schedule,
        firstNominalAt: f.schedule.expiresAt,
      }),
    ).rejects.toThrow("schedule-expiry-ceiling");
    expect(f.trace().outcome).toBe("failed");
    value(
      await f.host.dispatch(f.actor, "engine.jobs.schedule", f.schedule, null, {
        agentJustification: "Schedule bounded task work.",
      }),
    );
    expect(f.jobs.schedules(f.actor)[0]).toMatchObject({
      scheduleId: f.schedule.scheduleId,
      intervalMs: 60_000,
    });
    await expect(
      f.host.dispatch(f.actor, "engine.jobs.schedule", {
        ...f.schedule,
        intervalMs: 90_000,
      }),
    ).rejects.toThrow("schedule-revision-conflict");
    expect(f.jobs.schedules(f.actor)[0]?.intervalMs).toBe(60_000);
  });

  test("an authorized existing native job still requires the selected action declaration", async () => {
    const f = await fixture();
    value(await f.host.dispatch(f.actor, "engine.jobs.execute", f.request));
    f.consent("jobs:read");
    expect(await f.host.dispatch(f.actor, "engine.jobs.execute", f.request)).toMatchObject({
      ok: false,
      denial: { rule: "justification_required" },
    });
    expect(f.jobs.jobs.get(f.request.jobId)?.state).toBe("refused");
  });
});

async function transformingGuest() {
  const counts = { refinements: 0, transforms: 0, effects: 0 };
  const manifest: PluginManifest = {
    id: "test.prepared",
    version: "1.0.0",
    title: "Prepared guest",
    description: "",
    capabilities: ["containers:read"],
    contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
  };
  const action = defineServerAction({
    name: "write",
    title: "Write",
    caps: ["containers:read"],
    scope: "container",
    requirements: [{ cap: "containers:read", target: ["node"] }],
    agentJustification: "required",
    input: z.strictObject({
      value: z
        .string()
        .refine((text) => {
          counts.refinements++;
          return /^\d+$/.test(text);
        })
        .transform((text) => {
          counts.transforms++;
          return BigInt(text) + 1n;
        }),
      node: z.string().transform((containerId) => ({ kind: "container" as const, containerId })),
    }),
    result: z.strictObject({ value: z.string() }),
  });
  let receive: (frame: unknown) => void = () => {
    throw new Error("guest not attached");
  };
  const loaded = Promise.withResolvers<Extract<IsolateChildFrame, { t: "loaded" }>>();
  const pending = new Map<
    string,
    {
      ctx: ActionCtx;
      admitted: boolean;
      resolve(value: IsolateDispatchOutcome): void;
      reject(error: unknown): void;
    }
  >();
  attachServerGuest(
    {
      manifest,
      actions: [action],
      handlers: {
        write: async (ctx, args: z.output<typeof action.input>) => {
          counts.effects++;
          await ctx.storage.set("last", String(args.value));
          return { value: String(args.value) };
        },
      },
    },
    {
      onMessage: (listener) => {
        receive = listener;
      },
      exit: () => {
        throw new Error("unexpected guest exit");
      },
      warn: () => {
        throw new Error("unexpected guest warning");
      },
      send: (frame) => {
        if (frame.t === "loaded") loaded.resolve(frame);
        else if (frame.t === "load_failed") loaded.reject(new Error(frame.error));
        else if (frame.t === "prepared") {
          const dispatch = pending.get(frame.id);
          if (dispatch === undefined) throw new Error("no prepared dispatch");
          try {
            if (dispatch.ctx.admitPrepared === undefined)
              throw new Error("no admission continuation");
            dispatch.ctx.admitPrepared(frame.targets);
            dispatch.admitted = true;
            receive({ t: "admitted", id: frame.id, allowed: true } satisfies IsolateHostFrame);
          } catch (error) {
            dispatch.reject(error);
            receive({ t: "admitted", id: frame.id, allowed: false } satisfies IsolateHostFrame);
          }
        } else if (frame.t === "dispatched") {
          pending.get(frame.id)?.resolve(frame.outcome);
        } else if (frame.t === "call") {
          const dispatch = pending.get(frame.id.slice(0, frame.id.lastIndexOf(":")));
          if (dispatch?.admitted !== true) throw new Error("effect attempted before admission");
          void serveCtxCall(frame.method, frame.args, { kind: "dispatch", ctx: dispatch.ctx }).then(
            (result) => receive({ t: "reply", id: frame.id, ok: true, result }),
            (error: unknown) => dispatch.reject(error),
          );
        }
      },
    },
  );
  receive({
    t: "load",
    pluginId: manifest.id,
    manifest,
    dir: "/unused",
  } satisfies IsolateHostFrame);
  const { def } = buildIsolateDef(manifest, await loaded.promise, {
    dispatch: (name, args, ctx) => {
      const completion = Promise.withResolvers<IsolateDispatchOutcome>();
      const id = String(ctx.traceId);
      pending.set(id, {
        ctx,
        admitted: false,
        resolve: completion.resolve,
        reject: completion.reject,
      });
      receive({
        t: "dispatch",
        id,
        action: name,
        args,
        ctx: {
          traceId: ctx.traceId,
          principal: ctx.principal,
          caps: [...ctx.auth.caps],
          isRoot: ctx.auth.isRoot,
          containerScope: ctx.containerScope,
          now: ctx.now(),
        },
      } satisfies IsolateHostFrame);
      return completion.promise.finally(() => {
        pending.delete(id);
      });
    },
    hook: async () => {
      throw new Error("no guest lifecycle hook");
    },
    settled: async () => {
      throw new Error("no guest settled hook");
    },
    migrate: async () => {
      throw new Error("no guest migration");
    },
  });
  return { def, counts };
}

describe("guest parsing before declarations", () => {
  test("real refinements reject before a missing claim, and transformed values stay in the guest exactly once", async () => {
    const guest = await transformingGuest();
    const f = await fixture([guest.def]);
    expect(
      await f.host.dispatch(f.actor, "test.prepared.write", {
        value: "not-a-number",
        node: "inside",
      }),
    ).toMatchObject({ ok: false, denial: { rule: "invalid_args" } });
    expect(f.trace().outcome).toBe("invalid_args");
    expect(guest.counts).toEqual({ refinements: 1, transforms: 0, effects: 0 });
    expect(
      await f.host.dispatch(f.actor, "test.prepared.write", {
        value: "4",
        node: "inside",
      }),
    ).toMatchObject({ ok: false, denial: { rule: "justification_required" } });
    expect(guest.counts).toEqual({ refinements: 2, transforms: 1, effects: 0 });
    expect(await f.store.pluginStorage("test.prepared").get("last")).toBeNull();
    expect(
      await f.host.dispatch(
        f.actor,
        "test.prepared.write",
        {
          value: "4",
          node: "inside",
        },
        null,
        { agentJustification: "Write the bounded result." },
      ),
    ).toEqual({
      ok: true,
      result: { value: "5" },
    });
    expect(guest.counts).toEqual({ refinements: 3, transforms: 2, effects: 1 });
    expect(await f.store.pluginStorage("test.prepared").get("last")).toBe("5");
    expect(JSON.parse(f.trace().payload).agentDeclaration).toBe("Write the bounded result.");
  });

  test("authority checks use the real transformed reference and outrank invalid claims", async () => {
    const guest = await transformingGuest();
    const f = await fixture([guest.def]);
    const scoped = f.newRun(f.owner, { target: "manifold://container/inside" });
    expect(
      await f.host.dispatch(
        scoped.actor,
        "test.prepared.write",
        {
          value: "4",
          node: "outside",
        },
        null,
        { agentJustification: " " },
      ),
    ).toEqual({
      ok: false,
      denial: { rule: "forbidden", message: "containers:read capability required at target" },
    });
    expect(guest.counts).toEqual({ refinements: 1, transforms: 1, effects: 0 });
    expect(await f.store.pluginStorage("test.prepared").get("last")).toBeNull();
    expect(f.trace().outcome).toBe("forbidden");
  });
});
