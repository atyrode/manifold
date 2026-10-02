import { expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { defineAction, type JobSettledCtx } from "@manifold/plugin";
import {
  formatManifoldUri,
  hasCap,
  JOB_OWNER_PROTOCOL_VERSION,
  ManifoldRefSchema,
  type ActionOutcome,
  type ManifoldRef,
} from "@manifold/protocol";
import { z } from "zod";
import {
  canonicalJobJson,
  type JobCommand,
  type JobOwner,
  type MachineHalf,
  type SettledJob,
} from "@manifold/protocol";
import { AuthService, type AuthContext } from "../src/auth.ts";
import { serveCtxCall } from "../src/isolate/proxy-def.ts";
import { JobService } from "../src/job-service.ts";
import { silentLogger } from "../src/log.ts";
import type { ActionCtx, PluginHost, ServerPluginDef } from "../src/plugin-host.ts";
import { RoomManager } from "../src/room.ts";
import type { ServerStore } from "../src/stores.ts";
import { TerminalBroker } from "../src/terminal-broker.ts";
import { FakeClock, FakeRuntime, testPluginHost, testStore, testTileTrees } from "./helpers.ts";

/**
 * A GOVERNED DOOR HANDS ONE NAMED CONTAINER'S AUTHORITY TO THE WORK IT STARTS (ADR 0051, #883).
 *
 * `sample.drain` is Babel's shape: a governed door that posts a job and, when the job settles,
 * opens a sibling's session door from the wake. `sample.code` is Code's and OMP's shape: a
 * container-graded door whose caps are flat and whose handler asks the caller's caps and
 * `allows` at the container it is about to write. Every case asks the same two questions — did
 * the press admit, and what does the wake hold, at which container.
 */

const OWNER_KEY = "c".repeat(64);
const hash = "a".repeat(64);
const limits = { timeoutMs: 1000, memoryBytes: 1048576, processes: 1, outputBytes: 65536 };
const DRAIN = "sample.drain";
const CODE = "sample.code";
const OPERATION_ID = `${DRAIN}.run`;
const INDEX = "core.index";
/** The container the door names. */
const HOME = "home";
/** A container the presser may write, which the door never named. */
const OTHER = "other";
/** A container an administered deny withholds from the presser. */
const DENIED = "denied";
const SCHEDULE = {
  scheduleId: "drain-beat",
  revision: "r1",
  firstNominalAt: 1_000,
  intervalMs: 60_000,
  deadlineMs: 30_000,
  expiresAt: 9_000_000,
  offlinePolicy: "skip" as const,
};

const container = (containerId: string): Extract<ManifoldRef, { kind: "container" }> => ({
  kind: "container",
  containerId,
});
const ContainerRefSchema = ManifoldRefSchema.options[1];
const CreatedSchema = z.object({ container: z.object({ id: z.string() }) });
const ListedSchema = z.object({ containers: z.array(z.object({ id: z.string() })) });

function machineHalf(pluginId: string): MachineHalf {
  return {
    artifacts: {
      "linux-x64": {
        url: "https://example.invalid/worker",
        sha256: hash,
        entrySha256: hash,
        format: "raw",
        entry: ["worker"],
        maxBytes: 4096,
        maxExpandedBytes: 4096,
        maxMembers: 1,
      },
    },
    operations: {
      [`${pluginId}.run`]: {
        argv: [{ input: "value" }],
        input: { value: { type: "string", required: true, maxLength: 32 } },
        runtimeTools: [],
        locations: [],
        outputs: [],
        network: "none",
        limits,
        stdin: false,
      },
    },
    locations: {},
  };
}

type Wake = (ctx: JobSettledCtx, job: SettledJob) => Promise<void>;

const PressSchema = z.strictObject({
  operation: ManifoldRefSchema,
  profile: ManifoldRefSchema.optional(),
  jobId: z.string(),
  schedule: z.boolean().optional(),
});
type Press = z.infer<typeof PressSchema>;

async function post(ctx: ActionCtx, args: Press): Promise<{ refused: string } | object> {
  if (args.operation.kind !== "operation") return { refused: "an operation is required" };
  const request = {
    jobId: args.jobId,
    machineId: args.operation.machineId,
    operationId: args.operation.operationId,
    input: { value: "safe" },
    outputs: [],
  };
  if (args.schedule === true) await ctx.jobs.schedule({ ...SCHEDULE, ...request });
  else await ctx.jobs.execute(request);
  return {};
}

/** Babel's shape: one door naming a container, one naming none, and a wake that uses both. */
function drain(wake: { current: Wake }): ServerPluginDef {
  return {
    manifest: {
      id: DRAIN,
      version: "1.0.0",
      title: DRAIN,
      description: "Posts a governed job and opens a session from its wake.",
      capabilities: [
        "machines:read",
        "machines:run",
        "containers:read",
        "containers:write",
        "services:configure",
      ],
      dependencies: { [CODE]: { type: "required" }, [INDEX]: { type: "required" } },
      contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
      machine: machineHalf(DRAIN),
    },
    actions: [
      defineAction({
        name: "start",
        title: "Start, handing the profile's container to the run",
        caps: ["machines:run", "containers:write"],
        // Babel's drain lends its run the machine read a session posting makes; the service
        // configuration is lent only to a presser that holds it (the refresh regression).
        delegates: ["machines:read", "services:configure"],
        requirements: [
          { cap: "machines:run", target: ["operation"] },
          { cap: "containers:write", target: ["profile"] },
        ],
        input: PressSchema,
        result: z.strictObject({}),
      }),
      defineAction({
        name: "startRead",
        title: "Start, handing the profile's container to the run to read",
        caps: ["machines:run", "containers:read"],
        requirements: [
          { cap: "machines:run", target: ["operation"] },
          { cap: "containers:read", target: ["profile"] },
        ],
        input: PressSchema,
        result: z.strictObject({}),
      }),
      defineAction({
        name: "plain",
        title: "Start, naming no container",
        caps: ["machines:run"],
        requirements: [{ cap: "machines:run", target: ["operation"] }],
        input: PressSchema,
        result: z.strictObject({}),
      }),
    ],
    handlers: { start: post, startRead: post, plain: post },
    lifecycle: { onJobSettled: (ctx, job) => wake.current(ctx, job) },
  };
}

/** Code's and OMP's shape: flat caps, graded by the handler at the container it writes. */
function code(wake: { current: Wake }): ServerPluginDef {
  const Profile = z.strictObject({ profile: ContainerRefSchema });
  const Machine = z.strictObject({ machineId: z.string() });
  const Observe = z.strictObject({
    machineId: z.string(),
    profile: ContainerRefSchema,
    other: ContainerRefSchema,
  });
  return {
    manifest: {
      id: CODE,
      version: "1.0.0",
      title: CODE,
      description: "Starts a session in a container.",
      capabilities: [
        "machines:read",
        "machines:run",
        "jobs:read",
        "containers:write",
        "services:configure",
      ],
      dependencies: { [INDEX]: { type: "required" } },
      contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
      machine: machineHalf(CODE),
    },
    actions: [
      defineAction({
        name: "runSession",
        title: "Run a session",
        caps: ["containers:write"],
        scope: "container",
        input: Profile,
        result: z.strictObject({ containerId: z.string() }),
      }),
      defineAction({
        name: "probe",
        title: "Report what the caller holds",
        caps: ["containers:write"],
        scope: "container",
        input: z.strictObject({ at: z.array(z.string()) }),
        result: z.unknown(),
      }),
      defineAction({
        name: "post",
        title: "Post a run of this plugin's own, naming no container",
        caps: [],
        delegates: ["machines:run"],
        scope: "container",
        input: z.strictObject({ machineId: z.string(), jobId: z.string() }),
        result: z.strictObject({}),
      }),
      defineAction({
        name: "observe",
        title: "OMP's session preflight: the caller at the machine, then at the container",
        caps: ["containers:write"],
        delegates: ["machines:read", "machines:run", "jobs:read"],
        scope: "container",
        input: Observe,
        result: z.unknown(),
      }),
      defineAction({
        name: "configuration",
        title: "Read a machine's service configuration, a root-only native read",
        caps: ["containers:write"],
        delegates: ["services:configure"],
        scope: "container",
        input: Machine,
        result: z.strictObject({ read: z.boolean(), isRoot: z.boolean() }),
      }),
      defineAction({
        name: "write",
        title: "Write, graded at the target by admission",
        caps: ["containers:write"],
        requirements: [{ cap: "containers:write", target: ["profile"] }],
        input: Profile,
        result: z.strictObject({}),
      }),
    ],
    handlers: {
      runSession: async (ctx: ActionCtx, args: z.infer<typeof Profile>) =>
        ctx.outsideScope(args.profile.containerId) !== null ||
        !hasCap(ctx.auth.caps, "containers:write") ||
        !ctx.auth.allows("containers:write", args.profile)
          ? { refused: "scope_refused" }
          : { containerId: args.profile.containerId },
      probe: async (ctx: ActionCtx, args: { at: string[] }) => ({
        caps: [...ctx.auth.caps].sort(),
        isRoot: ctx.auth.isRoot,
        at: await Promise.all(
          args.at.map(async (containerId) => ({
            containerId,
            allows: ctx.auth.allows("containers:write", container(containerId)),
            // What a hardened guest's `auth.allows` frame is served (ADR 0016 §2).
            guest: await serveCtxCall("auth.allows", ["containers:write", container(containerId)], {
              kind: "dispatch",
              ctx,
            }),
            outside: ctx.outsideScope(containerId) !== null,
          })),
        ),
      }),
      write: async () => ({}),
      post: async (ctx: ActionCtx, args: { machineId: string; jobId: string }) => {
        await ctx.jobs.execute({
          jobId: args.jobId,
          machineId: args.machineId,
          operationId: `${CODE}.run`,
          input: { value: "safe" },
          outputs: [],
        });
        return {};
      },
      /*
        atyrode.omp's `observeNative` then `authorizeContainer`, as `runSession` and
        `reviewSession` reach them: `callerCapabilityRefusal` asks `hasCap(ctx.auth.caps, cap)`
        and `ctx.auth.allows(cap, ref)` at the MACHINE, the native describe runs on the door's
        bridge, and the same question is then asked at the container the session writes.
      */
      observe: async (ctx: ActionCtx, args: z.infer<typeof Observe>) => {
        const machine = { kind: "machine" as const, machineId: args.machineId };
        const refusal = (cap: "machines:run" | "containers:write", ref: ManifoldRef) =>
          hasCap(ctx.auth.caps, cap) && ctx.auth.allows(cap, ref)
            ? null
            : `caller_${cap.replace(":", "_")}_required`;
        const atMachine = refusal("machines:run", machine);
        if (atMachine !== null) return { refused: atMachine };
        const description = await ctx.jobs.describe({
          machineId: args.machineId,
          pluginId: ctx.pluginId,
        });
        if (
          ctx.outsideScope(args.profile.containerId) !== null ||
          refusal("containers:write", args.profile) !== null
        )
          return { refused: "scope_refused" };
        return {
          connected: description.connected,
          other: {
            allows: ctx.auth.allows("containers:write", args.other),
            outside: ctx.outsideScope(args.other.containerId) !== null,
          },
        };
      },
      configuration: async (ctx: ActionCtx, args: z.infer<typeof Machine>) => {
        let read = true;
        try {
          await ctx.services.readConfiguration(args);
        } catch {
          read = false;
        }
        return { read, isRoot: ctx.auth.isRoot };
      },
    },
    lifecycle: { onJobSettled: (ctx, job) => wake.current(ctx, job) },
  };
}

interface Fixture {
  readonly store: ServerStore;
  readonly runtime: FakeRuntime;
  readonly auth: AuthService;
  readonly root: AuthContext;
  readonly host: PluginHost;
  readonly service: JobService;
  readonly machineId: string;
  readonly channel: {
    machineId: string;
    send(message: { type: "job_command"; command: JobCommand }): boolean;
  };
  readonly owner: JobOwner;
  readonly wake: { current: Wake };
  readonly codeWake: { current: Wake };
  /** A fresh human operator holding the container caps everywhere but `DENIED`. */
  operator(name?: string): AuthContext;
  press(
    auth: AuthContext,
    door: "start" | "startRead" | "plain",
    args: Omit<Press, "operation">,
  ): Promise<ActionOutcome>;
  /** The job's owner reports it exited, which settles it and wakes its plugin. */
  settle(jobId: string): void;
}

async function fixture(): Promise<Fixture> {
  const runtime = new FakeRuntime();
  const clock = new FakeClock(runtime);
  const store = testStore();
  // Governed admission is the job service's decision, composed exactly as `main.ts` does.
  const auth = new AuthService(store, OWNER_KEY, runtime, {
    decide: (request) => service.decide(request),
  });
  const root = auth.authenticate(OWNER_KEY);
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
  const wake: { current: Wake } = { current: () => Promise.resolve() };
  const codeWake: { current: Wake } = { current: () => Promise.resolve() };
  const host = await testPluginHost(store, auth, rooms, broker, runtime, {
    settingsPlugins: [drain(wake), code(codeWake)],
  });
  const service: JobService = new JobService(store, auth, runtime);
  const machineId = auth.enrollMachine("worker", root).machine.id;
  const commands: JobCommand[] = [];
  const channel = {
    machineId,
    send: (message: { type: "job_command"; command: JobCommand }) => {
      commands.push(message.command);
      return true;
    },
  };
  const pair = generateKeyPairSync("ed25519");
  const owner: JobOwner = {
    protocolVersion: JOB_OWNER_PROTOCOL_VERSION,
    ownerId: "test-owner",
    publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    generation: 1,
    platforms: ["linux-x64"],
    inventoryDigest: "b".repeat(64),
  };
  host.setJobs(service);
  for (const pluginId of [DRAIN, CODE]) {
    service.install(root, {
      machineId,
      pluginId,
      installationRevision: "r1",
      artifactSha256: hash,
      machine: machineHalf(pluginId),
    });
    // `operations:invoke` is what lets the native schedule listing read the operation.
    for (const cap of ["machines:run", "operations:invoke"] as const)
      service.consent(root, {
        machineId,
        pluginId,
        installationRevision: "r1",
        artifactSha256: hash,
        node: formatManifoldUri({ kind: "operation", machineId, operationId: `${pluginId}.run` }),
        cap,
        enabled: true,
      });
  }
  service.online(channel, owner, "epoch");
  const challenge = commands.at(-1);
  if (challenge?.type !== "owner_challenge") throw new Error("owner challenge missing");
  const body = { nonce: challenge.nonce, serverEpoch: challenge.serverEpoch, machineId, owner };
  service.event(channel, {
    type: "owner_proof",
    ...body,
    signature: sign(null, Buffer.from(canonicalJobJson(body)), pair.privateKey).toString("base64"),
  });
  for (const pluginId of [DRAIN, CODE])
    service.event(channel, {
      type: "installed",
      pluginId,
      installationRevision: "r1",
      artifactSha256: hash,
    });
  return {
    store,
    runtime,
    auth,
    root,
    host,
    service,
    machineId,
    channel,
    owner,
    wake,
    codeWake,
    operator: (name = "operator") => {
      const minted = auth.mintToken(
        {
          principal: { name, kind: "human" },
          caps: ["machines:read", "machines:run", "containers:read", "containers:write"],
        },
        root,
      );
      auth.grant(
        {
          principal: { kind: "principal", id: minted.principal.id },
          node: formatManifoldUri(container(DENIED)),
          caps: ["containers:write"],
          effect: "deny",
          reach: "subtree",
        },
        root,
      );
      return auth.authenticate(minted.token);
    },
    press: (caller, door, args) =>
      host.dispatch(caller, `${DRAIN}.${door}`, {
        ...args,
        operation: { kind: "operation", machineId, operationId: OPERATION_ID },
      }),
    settle: (jobId) => {
      const job = service.jobs.get(jobId);
      if (job === null) throw new Error(`no job ${jobId}`);
      service.event(channel, {
        type: "result",
        result: {
          jobId,
          requestDigest: job.request.requestDigest,
          ownerId: owner.ownerId,
          ownerGeneration: owner.generation,
          state: "exited",
          exitCode: 0,
          reason: null,
          startedAt: 0,
          finishedAt: 9,
          usage: { elapsedMs: 1, memoryBytes: 1, processes: 1, outputBytes: 4 },
          limits,
          outputs: [],
        },
      });
    },
  };
}

type Called =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly refusal: string };

async function call(
  ctx: JobSettledCtx,
  action: string,
  input: unknown,
  plugin: string = CODE,
): Promise<Called> {
  try {
    return { ok: true, result: await ctx.actions.call({ plugin, action, input }) };
  } catch (error) {
    return { ok: false, refusal: error instanceof Error ? error.message : String(error) };
  }
}

/** Settle `jobId` and answer what its wake saw from `code`'s doors. */
async function wakeAnswers(
  f: Fixture,
  jobId: string,
  calls: readonly (readonly [string, unknown] | readonly [string, unknown, string])[],
  wake: { current: Wake } = f.wake,
): Promise<Called[]> {
  const answered = Promise.withResolvers<Called[]>();
  wake.current = async (ctx, job) => {
    if (job.jobId !== jobId) return;
    const answers: Called[] = [];
    for (const [action, input, plugin] of calls)
      answers.push(await call(ctx, action, input, plugin));
    answered.resolve(answers);
  };
  f.settle(jobId);
  return answered.promise;
}

const session = (containerId: string) =>
  ["runSession", { profile: container(containerId) }] as const;
const write = (containerId: string) => ["write", { profile: container(containerId) }] as const;

test("a governed door discharges a container target against its caller, and refuses what the caller lacks there", async () => {
  const f = await fixture();
  try {
    const operator = f.operator();
    // No native consent row exists for a container, and none is needed: the caller's own
    // authority there is the whole discharge (it was `explicit version-bound consent required`).
    expect(await f.press(operator, "start", { profile: container(HOME), jobId: "home" })).toEqual({
      ok: true,
      result: {},
    });
    expect(f.service.jobs.get("home")?.containerGrants).toEqual([
      { containerId: HOME, caps: ["containers:write"] },
    ]);
    expect(
      await f.press(operator, "start", { profile: container(DENIED), jobId: "denied" }),
    ).toEqual({
      ok: false,
      denial: { rule: "forbidden", message: "containers:write capability required at target" },
    });
    // A target that is no container names nothing to bind the authority to.
    expect(
      await f.press(operator, "start", {
        profile: { kind: "element", containerId: HOME, elementId: "note" },
        jobId: "element",
      }),
    ).toEqual({
      ok: false,
      denial: { rule: "invalid_args", message: "containers:write requires a container target" },
    });
    // A caller whose own ceiling never carried the cap is refused at the press too.
    const reader = f.auth.authenticate(
      f.auth.mintToken(
        { principal: { name: "reader", kind: "human" }, caps: ["machines:run", "containers:read"] },
        f.root,
      ).token,
    );
    expect(await f.press(reader, "start", { profile: container(HOME), jobId: "reader" })).toEqual({
      ok: false,
      denial: { rule: "forbidden", message: "containers:write capability required at target" },
    });
    expect(f.service.jobs.get("denied")).toBeNull();
    expect(f.service.jobs.get("element")).toBeNull();
    expect(f.service.jobs.get("reader")).toBeNull();
  } finally {
    f.store.close();
  }
});

test("the wake of a job from that dispatch holds the container's authority there and nowhere else", async () => {
  const f = await fixture();
  try {
    const operator = f.operator();
    expect((await f.press(operator, "start", { profile: container(HOME), jobId: "run" })).ok).toBe(
      true,
    );
    // The signed request the owner parses is unchanged: the authority rides beside it, and the
    // flat ceiling the run carries no longer holds the container cap anywhere.
    const job = f.service.jobs.get("run");
    expect(job?.request.credential).toEqual({
      ...f.auth.credentialReference(operator),
      caps: ["machines:read", "machines:run"],
    });
    const answers = await wakeAnswers(f, "run", [
      session(HOME),
      session(OTHER),
      write(HOME),
      write(OTHER),
      ["probe", { at: [HOME, OTHER] }],
    ]);
    expect(answers).toEqual([
      { ok: true, result: { containerId: HOME } },
      { ok: false, refusal: `refused: ${DRAIN} -> ${CODE}.runSession (scope_refused)` },
      { ok: true, result: {} },
      {
        ok: false,
        refusal: `capability: ${DRAIN} -> ${CODE}.write (containers:write capability required at target)`,
      },
      {
        ok: true,
        result: {
          caps: ["containers:write", "machines:read", "machines:run"],
          // Work bounded to a container is never workspace root, whoever pressed.
          isRoot: false,
          at: [
            { containerId: HOME, allows: true, guest: true, outside: false },
            { containerId: OTHER, allows: false, guest: false, outside: true },
          ],
        },
      },
    ]);
    // The next run the wake posts is the same lineage, and keeps the same bound authority.
    const posted = Promise.withResolvers<void>();
    f.wake.current = async (ctx, settled) => {
      if (settled.jobId !== "run-2") return;
      await ctx.jobs.execute({
        jobId: "run-3",
        machineId: settled.machineId,
        operationId: settled.operationId,
        input: { value: "safe" },
        outputs: [],
      });
      posted.resolve();
    };
    expect(
      (await f.press(operator, "start", { profile: container(HOME), jobId: "run-2" })).ok,
    ).toBe(true);
    f.settle("run-2");
    await posted.promise;
    expect(f.service.jobs.get("run-3")?.containerGrants).toEqual([
      { containerId: HOME, caps: ["containers:write"] },
    ]);
  } finally {
    f.store.close();
  }
});

test("a confined wake still answers machine questions from its flat caps: OMP's session preflight passes at the named container", async () => {
  const f = await fixture();
  try {
    const operator = f.operator();
    expect((await f.press(operator, "start", { profile: container(HOME), jobId: "run" })).ok).toBe(
      true,
    );
    const observe = (profile: string) =>
      [
        "observe",
        { machineId: f.machineId, profile: container(profile), other: container(OTHER) },
      ] as const;
    expect(await wakeAnswers(f, "run", [observe(HOME), observe(OTHER)])).toEqual([
      // The machine question answers from the flat `machines:run` and the grant rows, as it
      // did before the door opened; only the container question is confined to HOME.
      { ok: true, result: { connected: true, other: { allows: false, outside: true } } },
      // The same preflight for another container passes the machine question and is refused
      // at the container one, as `authorizeContainer` refuses it.
      { ok: false, refusal: `refused: ${DRAIN} -> ${CODE}.observe (scope_refused)` },
    ]);
  } finally {
    f.store.close();
  }
});

test("every occurrence of a schedule the dispatch registers carries the same bound authority", async () => {
  const f = await fixture();
  try {
    const operator = f.operator();
    expect(
      (
        await f.press(operator, "start", {
          profile: container(HOME),
          jobId: "beat",
          schedule: true,
        })
      ).ok,
    ).toBe(true);
    expect(f.service.jobSchedules.listSchedules()[0]?.containerGrants).toEqual([
      { containerId: HOME, caps: ["containers:write"] },
    ]);
    // The public listing is the schedule's facts, never the hub's carried authority.
    const listed = await f.host.dispatch(f.root, "engine.jobs.schedules", {});
    expect(listed.ok).toBe(true);
    const schedules = listed.ok ? (listed.result as { scheduleId: string }[]) : [];
    expect(schedules.map((entry) => entry.scheduleId)).toEqual([SCHEDULE.scheduleId]);
    expect(schedules[0]).not.toHaveProperty("containerGrants");
    f.runtime.time = SCHEDULE.firstNominalAt;
    f.service.tick();
    const occurrence = f.service.jobs.active()[0];
    expect(occurrence?.request.jobId).toStartWith("schedule-");
    expect(occurrence?.containerGrants).toEqual([
      { containerId: HOME, caps: ["containers:write"] },
    ]);
    expect(
      await wakeAnswers(f, occurrence!.request.jobId, [session(HOME), session(OTHER)]),
    ).toEqual([
      { ok: true, result: { containerId: HOME } },
      { ok: false, refusal: `refused: ${DRAIN} -> ${CODE}.runSession (scope_refused)` },
    ]);
  } finally {
    f.store.close();
  }
});

test("a door that names no container target lends no container authority", async () => {
  const f = await fixture();
  try {
    const operator = f.operator();
    expect((await f.press(operator, "plain", { jobId: "plain" })).ok).toBe(true);
    const job = f.service.jobs.get("plain");
    expect(job).not.toBeNull();
    expect(job).not.toHaveProperty("containerGrants");
    // Exactly today's answer: the job credential's ceiling is the door's own, so the session
    // door's caller check refuses at every container, the named one included.
    expect(await wakeAnswers(f, "plain", [session(HOME), session(OTHER)])).toEqual([
      { ok: false, refusal: `refused: ${DRAIN} -> ${CODE}.runSession (scope_refused)` },
      { ok: false, refusal: `refused: ${DRAIN} -> ${CODE}.runSession (scope_refused)` },
    ]);
  } finally {
    f.store.close();
  }
});

test("the carried authority follows the presser's lineage: a later deny or a revocation ends it", async () => {
  const f = await fixture();
  try {
    const operator = f.operator();
    expect(
      (await f.press(operator, "start", { profile: container(HOME), jobId: "denied" })).ok,
    ).toBe(true);
    // Continuous originating authority is checked before invoking the retained wake.
    const woken: string[] = [];
    const denyObserved = Promise.withResolvers<void>();
    f.wake.current = (_ctx, settled) => {
      woken.push(settled.jobId);
      if (settled.jobId === "after-deny") denyObserved.resolve();
      return Promise.resolve();
    };
    const deny = f.auth.grant(
      {
        principal: { kind: "principal", id: operator.principal.id },
        node: formatManifoldUri(container(HOME)),
        caps: ["containers:write"],
        effect: "deny",
        reach: "subtree",
      },
      f.root,
    );
    f.settle("denied");
    const other = f.operator("second");
    expect((await f.press(other, "plain", { jobId: "after-deny" })).ok).toBe(true);
    f.settle("after-deny");
    await denyObserved.promise;
    expect(woken).toEqual(["after-deny"]);
    f.auth.revokeGrant(deny.id, f.root);

    expect(
      (await f.press(operator, "start", { profile: container(HOME), jobId: "revoked" })).ok,
    ).toBe(true);
    const job = f.service.jobs.get("revoked")!;
    f.auth.revokePrincipal(operator.principal.id, f.root);
    // Nothing restores: not the reference, not the authority beside it.
    expect(
      f.auth.restoreCredential({
        ...job.request.credential,
        containerGrants: job.containerGrants!,
      }),
    ).toBeNull();
    woken.length = 0;
    f.settle("revoked");
    // A later wake of another presser proves the fan-out ran past the revoked one.
    expect((await f.press(other, "plain", { jobId: "after" })).ok).toBe(true);
    const after = Promise.withResolvers<void>();
    f.wake.current = (_ctx, settled) => {
      woken.push(settled.jobId);
      if (settled.jobId === "after") after.resolve();
      return Promise.resolve();
    };
    f.settle("after");
    await after.promise;
    expect(woken).toEqual(["after"]);
  } finally {
    f.store.close();
  }
});

test("restoring never widens: a credential without grants restores as it always did, and grants are held to the token", async () => {
  const f = await fixture();
  try {
    const operator = f.operator();
    const reference = f.auth.credentialReference({ ...operator, caps: ["machines:run"] });
    const plain = f.auth.restoreCredential(reference);
    expect(plain).not.toBeNull();
    expect(plain).not.toHaveProperty("containerGrants");
    const grants = [{ containerId: HOME, caps: ["containers:write" as const] }];
    const carried = f.auth.restoreCredential({ ...reference, containerGrants: grants })!;
    expect(carried.containerGrants).toEqual(grants);
    // An empty list is confinement too: it carries no container authority anywhere.
    const empty = f.auth.restoreCredential({ ...reference, containerGrants: [] })!;
    const at = (context: AuthContext, node: string): boolean =>
      f.auth.effectiveCaps(context, node).has("containers:write");
    const nodes = [
      formatManifoldUri(container(HOME)),
      formatManifoldUri({ kind: "element", containerId: HOME, elementId: "note" }),
      formatManifoldUri(container(OTHER)),
      "manifold://",
    ];
    // Without grants the evaluator answers from the rows alone, as before this change.
    expect(nodes.map((node) => at(plain!, node))).toEqual([true, true, true, true]);
    expect(nodes.map((node) => at(carried, node))).toEqual([true, true, false, false]);
    expect(nodes.map((node) => at(empty, node))).toEqual([false, false, false, false]);

    // Every refresh keeps the confinement: the lineage carries it, so a consumer that
    // round-trips `credentialReference` through `restoreCredential` answers as confined.
    for (const context of [carried, empty]) {
      const refreshed = f.auth.restoreCredential(f.auth.credentialReference(context))!;
      expect(refreshed.containerGrants).toEqual(context.containerGrants);
      expect(nodes.map((node) => at(refreshed, node))).toEqual(
        nodes.map((node) => at(context, node)),
      );
    }

    // A grant the token never carried, one that duplicates the flat ceiling, or a malformed one
    // restores nothing at all.
    const narrow = f.auth.authenticate(
      f.auth.mintToken(
        { principal: { name: "narrow", kind: "human" }, caps: ["machines:run"] },
        f.root,
      ).token,
    );
    expect(
      f.auth.restoreCredential({ ...f.auth.credentialReference(narrow), containerGrants: grants }),
    ).toBeNull();
    expect(
      f.auth.restoreCredential({
        ...f.auth.credentialReference(operator),
        containerGrants: grants,
      }),
    ).toBeNull();
    expect(
      f.auth.restoreCredential({
        ...reference,
        containerGrants: [{ containerId: "", caps: ["containers:write"] }],
      }),
    ).toBeNull();

    // Confined work is never root, even when the owner key pressed, and no refresh restores it.
    const ownerRun = f.auth.restoreCredential({
      ...f.auth.credentialReference({ ...f.root, caps: ["machines:run"] }),
      containerGrants: [],
    })!;
    expect(f.auth.holdsRoot(f.root)).toBe(true);
    expect(f.auth.holdsRoot(ownerRun)).toBe(false);
    expect(f.auth.holdsRoot(f.auth.restoreCredential(f.auth.credentialReference(ownerRun))!)).toBe(
      false,
    );
  } finally {
    f.store.close();
  }
});

test("a door naming no container, opened by confined work, lends its run no container authority", async () => {
  const f = await fixture();
  try {
    const operator = f.operator();
    expect((await f.press(operator, "start", { profile: container(HOME), jobId: "run" })).ok).toBe(
      true,
    );
    // The wake opens a sibling's door that names no container and posts a run of its own.
    expect(
      await wakeAnswers(f, "run", [["post", { machineId: f.machineId, jobId: "code-run" }]]),
    ).toEqual([{ ok: true, result: {} }]);
    // That run is confined and carries nothing: an empty list, not the unconfined lineage.
    const posted = f.service.jobs.get("code-run");
    expect(posted?.request.credential.caps).toEqual(["machines:run"]);
    expect(posted?.containerGrants).toEqual([]);
    // Its own wake is refused at a workspace door the presser could open directly.
    expect(
      await wakeAnswers(
        f,
        "code-run",
        [["createContainer", { name: "escape" }, INDEX]],
        f.codeWake,
      ),
    ).toEqual([
      {
        ok: false,
        refusal: `capability: ${CODE} -> ${INDEX}.createContainer (containers:write capability required)`,
      },
    ]);
    expect(f.store.listContainers().map((entry) => entry.name)).not.toContain("escape");
  } finally {
    f.store.close();
  }
});

test("a refresh keeps the confinement: a root-only native read refuses work the owner pressed", async () => {
  const f = await fixture();
  try {
    // The door is reachable: the owner opening it directly reads the configuration.
    expect(
      await f.host.dispatch(f.root, `${CODE}.configuration`, { machineId: f.machineId }),
    ).toEqual({ ok: true, result: { read: true, isRoot: true } });
    expect((await f.press(f.root, "start", { profile: container(HOME), jobId: "owned" })).ok).toBe(
      true,
    );
    // Work the owner pressed through a door naming a container is confined to it, and the
    // native read — which refreshes its caller's credential before asking for root — sees the
    // same confined credential the handler does.
    expect(await wakeAnswers(f, "owned", [["configuration", { machineId: f.machineId }]])).toEqual([
      { ok: true, result: { read: false, isRoot: false } },
    ]);
  } finally {
    f.store.close();
  }
});

test("a carried read scopes the dispatch it opens: the index lists and reads the named container alone", async () => {
  const f = await fixture();
  try {
    const created = async (name: string): Promise<string> => {
      const outcome = await f.host.dispatch(f.root, `${INDEX}.createContainer`, { name });
      if (!outcome.ok) throw new Error(outcome.denial.message);
      return CreatedSchema.parse(outcome.result).container.id;
    };
    const home = await created("home");
    const other = await created("other");
    const operator = f.operator();
    expect(
      (await f.press(operator, "startRead", { profile: container(home), jobId: "read" })).ok,
    ).toBe(true);
    const answers = await wakeAnswers(f, "read", [
      ["listContainers", {}, INDEX],
      ["read", {}, INDEX],
      ["readContainer", { containerId: other }, INDEX],
      ["readContainer", { containerId: home }, INDEX],
    ]);
    const [listed, tree, outside, inside] = answers;
    expect(listed?.ok).toBe(true);
    expect(
      ListedSchema.parse(listed?.ok ? listed.result : null).containers.map((entry) => entry.id),
    ).toEqual([home]);
    expect(tree?.ok).toBe(true);
    expect(JSON.stringify(tree)).toContain(home);
    expect(JSON.stringify(tree)).not.toContain(other);
    expect(outside).toEqual({
      ok: false,
      refusal: `refused: ${DRAIN} -> ${INDEX}.readContainer (outside this token's container)`,
    });
    expect(inside?.ok).toBe(true);
  } finally {
    f.store.close();
  }
});
