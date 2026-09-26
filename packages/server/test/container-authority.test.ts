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
} from "../../protocol/src/jobs.ts";
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

function machineHalf(): MachineHalf {
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
      [OPERATION_ID]: {
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
      capabilities: ["machines:run", "containers:write"],
      dependencies: { [CODE]: { type: "required" } },
      contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
      machine: machineHalf(),
    },
    actions: [
      defineAction({
        name: "start",
        title: "Start, handing the profile's container to the run",
        caps: ["machines:run", "containers:write"],
        requirements: [
          { cap: "machines:run", target: ["operation"] },
          { cap: "containers:write", target: ["profile"] },
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
    handlers: { start: post, plain: post },
    lifecycle: { onJobSettled: (ctx, job) => wake.current(ctx, job) },
  };
}

/** Code's and OMP's shape: flat caps, graded by the handler at the container it writes. */
function code(): ServerPluginDef {
  const Profile = z.strictObject({ profile: ContainerRefSchema });
  return {
    manifest: {
      id: CODE,
      version: "1.0.0",
      title: CODE,
      description: "Starts a session in a container.",
      capabilities: ["containers:write"],
      contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
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
    },
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
  /** A fresh human operator holding `containers:write` everywhere but `DENIED`. */
  operator(name?: string): AuthContext;
  press(
    auth: AuthContext,
    door: "start" | "plain",
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
  const host = await testPluginHost(store, auth, rooms, broker, runtime, {
    settingsPlugins: [drain(wake), code()],
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
  service.install(root, {
    machineId,
    pluginId: DRAIN,
    installationRevision: "r1",
    artifactSha256: hash,
    machine: machineHalf(),
  });
  // `operations:invoke` is what lets the native schedule listing read the operation.
  for (const cap of ["machines:run", "operations:invoke"] as const)
    service.consent(root, {
      machineId,
      pluginId: DRAIN,
      installationRevision: "r1",
      artifactSha256: hash,
      node: formatManifoldUri({ kind: "operation", machineId, operationId: OPERATION_ID }),
      cap,
      enabled: true,
    });
  service.online(channel, owner, "epoch");
  const challenge = commands.at(-1);
  if (challenge?.type !== "owner_challenge") throw new Error("owner challenge missing");
  const body = { nonce: challenge.nonce, serverEpoch: challenge.serverEpoch, machineId, owner };
  service.event(channel, {
    type: "owner_proof",
    ...body,
    signature: sign(null, Buffer.from(canonicalJobJson(body)), pair.privateKey).toString("base64"),
  });
  service.event(channel, {
    type: "installed",
    pluginId: DRAIN,
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
    operator: (name = "operator") => {
      const minted = auth.mintToken(
        { principal: { name, kind: "human" }, caps: ["machines:run", "containers:write"] },
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

async function call(ctx: JobSettledCtx, action: string, input: unknown): Promise<Called> {
  try {
    return { ok: true, result: await ctx.actions.call({ plugin: CODE, action, input }) };
  } catch (error) {
    return { ok: false, refusal: error instanceof Error ? error.message : String(error) };
  }
}

/** Settle `jobId` and answer what its wake saw from `code`'s doors. */
async function wakeAnswers(
  f: Fixture,
  jobId: string,
  calls: readonly (readonly [string, unknown])[],
): Promise<Called[]> {
  const answered = Promise.withResolvers<Called[]>();
  f.wake.current = async (ctx, job) => {
    if (job.jobId !== jobId) return;
    const answers: Called[] = [];
    for (const [action, input] of calls) answers.push(await call(ctx, action, input));
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
      caps: ["machines:run"],
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
          caps: ["containers:write", "machines:run"],
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
    // The grant at the container is re-asked at use, so an administered deny written after the
    // press withdraws it from the run exactly as it does from the presser: the session door's
    // own rung now finds the cap held at no container at all.
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
    expect(await wakeAnswers(f, "denied", [session(HOME)])).toEqual([
      {
        ok: false,
        refusal: `capability: ${DRAIN} -> ${CODE}.runSession (containers:write capability required)`,
      },
    ]);
    f.auth.revokeGrant(deny.id, f.root);

    expect(
      (await f.press(operator, "start", { profile: container(HOME), jobId: "revoked" })).ok,
    ).toBe(true);
    const job = f.service.jobs.get("revoked")!;
    f.auth.revokePrincipal(operator.principal.id, f.root);
    // Nothing restores: not the reference, not the authority beside it.
    expect(f.auth.restoreCredential(job.request.credential, job.containerGrants)).toBeNull();
    const woken: string[] = [];
    f.wake.current = (_ctx, settled) => {
      woken.push(settled.jobId);
      return Promise.resolve();
    };
    f.settle("revoked");
    // A later wake of another presser proves the fan-out ran past the revoked one.
    const other = f.operator("second");
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
    expect(f.auth.restoreCredential(reference, undefined)).toEqual(plain);
    const grants = [{ containerId: HOME, caps: ["containers:write" as const] }];
    const carried = f.auth.restoreCredential(reference, grants)!;
    expect(carried.containerGrants).toEqual(grants);
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

    // A grant the token never carried, one that duplicates the flat ceiling, or a malformed one
    // restores nothing at all.
    const narrow = f.auth.authenticate(
      f.auth.mintToken(
        { principal: { name: "narrow", kind: "human" }, caps: ["machines:run"] },
        f.root,
      ).token,
    );
    expect(f.auth.restoreCredential(f.auth.credentialReference(narrow), grants)).toBeNull();
    expect(f.auth.restoreCredential(f.auth.credentialReference(operator), grants)).toBeNull();
    expect(
      f.auth.restoreCredential(reference, [{ containerId: "", caps: ["containers:write"] }]),
    ).toBeNull();

    // Confined work is never root, even when the owner key pressed.
    const ownerRun = f.auth.restoreCredential(
      f.auth.credentialReference({ ...f.root, caps: ["machines:run"] }),
      grants,
    )!;
    expect(f.auth.holdsRoot(f.root)).toBe(true);
    expect(f.auth.holdsRoot(ownerRun)).toBe(false);
  } finally {
    f.store.close();
  }
});
