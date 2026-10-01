import "../src/shared-modules.ts";
import { expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { defineAction } from "@manifold/plugin";
import {
  canonicalJobJson,
  CreateRunResultSchema,
  JOB_OWNER_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  JOB_OWNER_PROTOCOL_COMPAT_VERSIONS,
  LaunchRunResultSchema,
  ListHarnessesResultSchema,
  ListHarnessSessionsResultSchema,
  SessionRefSchema,
  ContainerTerminalsResponseSchema,
  TerminalsResponseSchema,
  type ActionOutcome,
  type AgentRunAuthority,
  type AuthorityScope,
  type Cap,
  type HarnessTarget,
  type JobCommand,
  type JobOwner,
  type MachineHalf,
  type ServerToAgentMessage,
  type TerminalRuntime,
} from "@manifold/protocol";
import { AuthService, type AuthContext } from "../src/auth.ts";
import { openDatabase } from "../src/db.ts";
import { ServerStore } from "../src/stores.ts";
import { JobService } from "../src/job-service.ts";
import { silentLogger } from "../src/log.ts";
import type { ActionCtx, PluginHost, ServerPluginDef } from "../src/plugin-host.ts";
import { RoomManager } from "../src/room.ts";
import { SessionChannel } from "../src/session-channel.ts";
import { TerminalBroker } from "../src/terminal-broker.ts";
import {
  FakeClock,
  FakeRuntime,
  FakeSocket,
  testPluginHost,
  testStore,
  testTileTrees,
} from "./helpers.ts";

const pluginId = "test.harness";
const operationId = `${pluginId}.run`;
const hash = "a".repeat(64);
const machine: MachineHalf = {
  artifacts: {
    "linux-x64": {
      url: "https://example.invalid/harness",
      sha256: hash,
      entrySha256: hash,
      format: "raw",
      entry: ["harness"],
      maxBytes: 4096,
      maxExpandedBytes: 4096,
      maxMembers: 1,
    },
  },
  operations: {
    [operationId]: {
      argv: [{ input: "mode" }],
      input: { mode: { type: "string", required: true, maxLength: 128 } },
      runtimeTools: [],
      locations: [],
      outputs: [],
      network: "none",
      limits: { timeoutMs: 60000, memoryBytes: 1048576, processes: 2, outputBytes: 65536 },
      stdin: true,
    },
  },
  locations: {},
};

function result(outcome: ActionOutcome): unknown {
  if (!outcome.ok)
    throw new Error(`action refused: ${outcome.denial.rule}: ${outcome.denial.message}`);
  return outcome.result;
}

async function admittedMessage<T>(
  message: Promise<T>,
  pending: Promise<ActionOutcome>,
  phase: string,
): Promise<T> {
  return Promise.race([
    message,
    pending.then((outcome) => {
      result(outcome);
      throw new Error(`action settled before ${phase}`);
    }),
  ]);
}

async function fixture(
  dependency?: ServerPluginDef,
  inputs?: string[],
  databasePath?: string,
  profileSchema: z.ZodType = z.strictObject({ label: z.string().min(1) }),
  baseMachine: MachineHalf = machine,
  extraHarnessCaps: Cap[] = [],
) {
  const declaredMachine: MachineHalf =
    inputs === undefined
      ? baseMachine
      : {
          ...baseMachine,
          operations: {
            ...baseMachine.operations,
            [operationId]: { ...baseMachine.operations[operationId]!, inputs },
          },
        };
  const runtime = new FakeRuntime();
  const clock = new FakeClock(runtime);
  const store =
    databasePath === undefined ? testStore() : new ServerStore(openDatabase(databasePath));
  const auth: AuthService = new AuthService(store, "a".repeat(64), runtime, {
    decide: (request) => service.decide(request),
  });
  const root = auth.authenticate("a".repeat(64));
  const machineId = auth.enrollMachine("harness owner", root).machine.id;
  const containerId = runtime.newId();
  store.createContainer({
    id: containerId,
    name: "Run",
    createdAt: runtime.now(),
    discipline: "composition",
  });
  const descriptor: TerminalRuntime = {
    machineId,
    pluginId,
    operationId,
    installationRevision: "r1",
    artifactSha256: hash,
    resourceBindingDigest: createHash("sha256").update("null").digest("hex"),
    input: { mode: "start" },
  };
  const launches: { run: AgentRunAuthority; target: HarnessTarget }[] = [];
  const definition: ServerPluginDef = {
    manifest: {
      id: pluginId,
      version: "1.0.0",
      title: "Test harness",
      description: "Binding boundary fixture",
      capabilities: ["machines:run", "jobs:read", "jobs:input", ...extraHarnessCaps],
      ...(dependency
        ? { dependencies: { [dependency.manifest.id]: { type: "required" as const } } }
        : {}),
      machine: declaredMachine,
      contributes: {
        panels: [],
        sections: [],
        elements: [],
        tools: [],
        events: [],
        harness: {
          id: "test-harness",
          title: "Test harness",
          profileSchema: { type: "object" },
          sessionRef: "typed",
        },
      },
    },
    actions: [],
    handlers: {},
    harness: {
      profileSchema,
      async launch(ctx, run, _agent, target) {
        launches.push({ run, target });
        if (ctx.pluginId !== pluginId) throw new Error("harness context identity mismatch");
        await ctx.storage.set("last-run", run.id);
        return {
          runtime:
            run.session === null
              ? descriptor
              : { ...descriptor, input: { mode: `resume:${run.session.sessionId}` } },
          session: run.session ?? { harness: "test-harness", machineId, sessionId: run.id },
          reviewDigest: hash,
        };
      },
      async sessions(ctx) {
        const id = await ctx.storage.get("last-run");
        return id ? [{ harness: "test-harness", machineId, sessionId: id }] : [];
      },
      async resolveSession(ctx, ref) {
        return (await ctx.storage.get("last-run")) === ref.sessionId ? ref : null;
      },
      async send(ctx, run, input) {
        const node = ctx.jobs.runTerminal(run.id);
        const job = ctx.jobs.status(node);
        if (job.nextInputSeq === null) throw new Error("input cursor unavailable");
        await ctx.jobs.input({
          node,
          requestId: ctx.newId(),
          seq: job.nextInputSeq,
          data: Buffer.from(input).toString("base64"),
          eof: false,
        });
      },
    },
  };
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
    settingsPlugins: dependency ? [definition, dependency] : [definition],
  });
  const service: JobService = new JobService(store, auth, runtime);
  host.setJobs(service);
  broker.setJobs(service);
  service.install(root, {
    machineId,
    pluginId,
    installationRevision: "r1",
    artifactSha256: hash,
    machine: declaredMachine,
  });
  service.consent(root, {
    machineId,
    pluginId,
    installationRevision: "r1",
    artifactSha256: hash,
    node: `manifold://machine/${machineId}/operation/${operationId}`,
    cap: "machines:run",
    enabled: true,
  });
  const commands: JobCommand[] = [];
  const sent: ServerToAgentMessage[] = [];
  const createWaiters = new Map<string, () => void>();
  const firstCreate = Promise.withResolvers<Extract<ServerToAgentMessage, { type: "create" }>>();
  const firstRestart =
    Promise.withResolvers<Extract<ServerToAgentMessage, { type: "terminal_restart" }>>();
  let acknowledgeRestarts = true;
  let channel = {
    machineId,
    protocolVersion: PROTOCOL_VERSION,
    terminalRestart: true,
    terminalHostId: "terminal-host",
    terminalExecution: "governed" as const,
    send(message: ServerToAgentMessage) {
      sent.push(message);
      if (message.type === "job_command") commands.push(message.command);
      if (message.type === "create") {
        firstCreate.resolve(message);
        createWaiters.get(message.terminalId)?.();
      }
      if (message.type === "terminal_restart") firstRestart.resolve(message);
      if (message.type === "terminal_restart" && acknowledgeRestarts)
        broker.onRestarted(machineId, {
          type: "terminal_restarted",
          terminalId: message.terminalId,
        });
      return true;
    },
  };
  const pair = generateKeyPairSync("ed25519");
  const owner: JobOwner = {
    protocolVersion: JOB_OWNER_PROTOCOL_VERSION,
    ownerId: "native-owner",
    terminalHostId: "terminal-host",
    publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    generation: 1,
    platforms: ["linux-x64"],
    inventoryDigest: "b".repeat(64),
  };
  const proveOwner = (
    target: JobService,
    protocolVersion = PROTOCOL_VERSION,
    ownerProtocolVersion = JOB_OWNER_PROTOCOL_VERSION,
  ) => {
    channel.protocolVersion = protocolVersion;
    const advertised = { ...owner, protocolVersion: ownerProtocolVersion };
    channel.terminalHostId = advertised.terminalHostId ?? "terminal-host";
    target.online(channel, advertised, "epoch");
    if (JOB_OWNER_PROTOCOL_COMPAT_VERSIONS.has(ownerProtocolVersion)) {
      const challenge = commands.at(-1);
      if (challenge?.type !== "owner_challenge") throw new Error("owner challenge missing");
      const proof = {
        nonce: challenge.nonce,
        serverEpoch: challenge.serverEpoch,
        machineId,
        owner: advertised,
      };
      target.event(channel, {
        type: "owner_proof",
        ...proof,
        signature: sign(null, Buffer.from(canonicalJobJson(proof)), pair.privateKey).toString(
          "base64",
        ),
      });
      target.event(channel, {
        type: "installed",
        pluginId,
        installationRevision: "r1",
        artifactSha256: hash,
      });
    }
  };
  const connect = (
    protocolVersion: number,
    ownerProtocolVersion: number,
    replaceTransport = false,
  ) => {
    if (replaceTransport) {
      service.offline(channel);
      channel = { ...channel };
    }
    proveOwner(service, protocolVersion, ownerProtocolVersion);
    // Match the hub's durable owner admission, not just the broker's live transport.
    store.touchMachine(machineId, "harness owner", runtime.now(), channel.terminalHostId);
    broker.setMachineOnline(channel);
  };
  connect(PROTOCOL_VERSION, JOB_OWNER_PROTOCOL_VERSION);
  const grant = {
    caps: ["containers:read"] as const,
    targets: ["manifold://"],
    reach: "subtree" as const,
    maxRunLifetimeMs: 60000,
    delegation: { maxDepth: 0, maxDescendants: 0 },
    expiresAt: runtime.now() + 600000,
  };
  const registered = await auth.registerAgent(
    {
      name: "Harness agent",
      purpose: "Inspect the launch boundary",
      harness: "test-harness",
      grant: { ...grant, caps: [...grant.caps] },
      context: { profile: { label: "reviewed" } },
    },
    root,
  );
  const create = async () =>
    CreateRunResultSchema.parse(
      result(
        await host.dispatch(root, "core.access.createRun", {
          agentId: registered.agent.agentId,
          target: { machineId, containerId },
        }),
      ),
    );
  const launch = async (runId: string) =>
    LaunchRunResultSchema.parse(
      result(await host.dispatch(root, "core.access.launchRun", { runId })),
    );
  const open = async (value: TerminalRuntime, actor: AuthContext = root) => {
    const socket = new FakeSocket();
    const finished = Promise.withResolvers<void>();
    const send = socket.send.bind(socket);
    socket.send = (data) => {
      const bytes = send(data);
      const frame: unknown = JSON.parse(data);
      if (
        frame !== null &&
        typeof frame === "object" &&
        "type" in frame &&
        (frame.type === "terminal_error" || frame.type === "error")
      )
        finished.resolve();
      return bytes;
    };
    const peer = new SessionChannel(runtime.newId(), socket, actor, containerId, "c1");
    const request = {
      elementId: runtime.newId(),
      machineId,
      placement: "tile" as const,
      runtime: value,
    };
    const previousTerminalIds = new Set<string>();
    for (const node of Object.values(rooms.get(containerId)?.tileLayout() ?? {})) {
      if (node.ref?.kind === "terminal") previousTerminalIds.add(node.ref.terminalId);
    }
    const admission = z
      .strictObject({ traceId: z.number() })
      .parse(
        result(await host.dispatch(actor, "core.terminals.open", { ...request, containerId })),
      );
    broker.open(peer, { type: "terminal_open", ...request }, admission.traceId);
    const tile = Object.values(rooms.get(containerId)?.tileLayout() ?? {}).find(
      (candidate) =>
        candidate.dir === null &&
        candidate.ref?.kind === "terminal" &&
        !previousTerminalIds.has(candidate.ref.terminalId) &&
        store.getTerminal(candidate.ref.terminalId) === null,
    );
    if (tile?.dir !== null || tile.ref?.kind !== "terminal")
      throw new Error("pending terminal tile missing");
    createWaiters.set(tile.ref.terminalId, finished.resolve);
    try {
      broker.resize(peer, {
        type: "terminal_resize",
        terminalId: tile.ref.terminalId,
        viewportId: "fixture",
        viewport: { cols: 80, rows: 24 },
      });
      await finished.promise;
    } finally {
      createWaiters.delete(tile.ref.terminalId);
    }
    return socket;
  };
  return {
    auth,
    root,
    host,
    broker,
    rooms,
    service,
    runtime,
    launches,
    store,
    clock,
    registered,
    descriptor,
    definition,
    create,
    launch,
    open,
    async openCreated(value: TerminalRuntime) {
      await open(value);
      const create = sent.findLast((message) => message.type === "create");
      if (!create) throw new Error("terminal create missing");
      broker.onCreated(machineId, create.terminalId);
      return create;
    },
    sent,
    commands,
    owner,
    containerId,
    firstCreate: firstCreate.promise,
    firstRestart: firstRestart.promise,
    holdRestartAcknowledgement() {
      acknowledgeRestarts = false;
    },
    replaceTransport: () => connect(PROTOCOL_VERSION, JOB_OWNER_PROTOCOL_VERSION, true),
    started(command: Extract<JobCommand, { type: "start" }>) {
      service.event(channel, {
        type: "state",
        jobId: command.request.jobId,
        requestDigest: command.request.requestDigest,
        ownerId: command.permit.ownerId,
        ownerGeneration: command.permit.ownerGeneration,
        state: "started",
      });
    },
    connect,
    proveOwner,
    channel: () => channel,
    duplicate: () =>
      testPluginHost(store, auth, rooms, broker, runtime, {
        settingsPlugins: [
          definition,
          { ...definition, manifest: { ...definition.manifest, id: "test.other-harness" } },
        ],
      }),
    close() {
      host.close();
      store.close();
    },
  };
}

test("admitted session correlation survives lifecycle and disk reopen without widening read authority", async () => {
  const dir = mkdtempSync(join(tmpdir(), "manifold-terminal-session-"));
  const path = join(dir, "manifold.db");
  const f = await fixture(undefined, undefined, path);
  let closed = false;
  try {
    const session = {
      harness: "test-harness",
      machineId: f.descriptor.machineId,
      sessionId: "saved-session",
    };
    const socket = await f.open({ ...f.descriptor, session });
    const create = f.sent.findLast((message) => message.type === "create");
    if (!create) throw new Error("terminal create missing");
    expect(f.store.getTerminal(create.terminalId)).toBeNull();
    f.broker.onCreated(f.descriptor.machineId, create.terminalId);
    const terminal = f.store.getTerminal(create.terminalId)!;
    expect(socket.messages()).toContainEqual(
      expect.objectContaining({
        type: "terminal_opened",
        terminal: expect.objectContaining({ session }),
      }),
    );
    expect(
      TerminalsResponseSchema.parse(
        result(await f.host.dispatch(f.root, "core.terminals.listAll", {})),
      ).terminals,
    ).toContainEqual(expect.objectContaining({ id: terminal.id, session }));
    const visible = f.auth.mintToken(
      {
        principal: { kind: "human", name: "Home reader" },
        caps: ["containers:read"],
        containerId: terminal.containerId,
      },
      f.root,
    );
    const reader = f.auth.authenticate(visible.token);
    expect(
      ContainerTerminalsResponseSchema.parse(
        result(await f.host.dispatch(reader, "core.terminals.listByContainer", {})),
      ).terminals,
    ).toContainEqual(expect.objectContaining({ id: terminal.id, session }));
    expect((await f.host.dispatch(reader, "core.terminals.listAll", {})).ok).toBe(false);
    expect(
      (await f.host.dispatch(reader, "core.terminals.restart", { terminalId: terminal.id })).ok,
    ).toBe(false);
    const otherHome = f.runtime.newId();
    f.store.createContainer({
      id: otherHome,
      name: "Other home",
      createdAt: f.runtime.now(),
      discipline: "composition",
    });
    const foreign = f.auth.mintToken(
      {
        principal: { kind: "human", name: "Other reader" },
        caps: ["containers:read"],
        containerId: otherHome,
      },
      f.root,
    );
    expect(
      ContainerTerminalsResponseSchema.parse(
        result(
          await f.host.dispatch(
            f.auth.authenticate(foreign.token),
            "core.terminals.listByContainer",
            {},
          ),
        ),
      ).terminals,
    ).toEqual([]);
    expect(
      result(await f.host.dispatch(f.root, "core.terminals.restart", { terminalId: terminal.id })),
    ).toEqual({});
    expect(f.broker.listForContainer(terminal.containerId)[0]?.session).toEqual(session);
    expect(
      f.broker.adoptTerminal(session.machineId, {
        terminalId: terminal.id,
        alive: true,
        cols: 90,
        rows: 30,
        seq: 0,
      }),
    ).toBe(true);
    f.broker.onExited(session.machineId, terminal.id, 1);
    f.store.updateTerminalName(terminal.id, "Renamed");
    f.store.updateTerminalContainer(terminal.id, otherHome);
    expect(f.store.getTerminal(terminal.id)).toMatchObject({ session, status: "exited" });
    f.close();
    closed = true;
    const reopened = new ServerStore(openDatabase(path));
    try {
      const auth = new AuthService(reopened, "a".repeat(64), f.runtime);
      const rooms = new RoomManager(reopened, f.runtime, f.clock, silentLogger, testTileTrees);
      const broker = new TerminalBroker(
        reopened,
        auth,
        rooms,
        f.runtime,
        f.clock,
        silentLogger,
        () => "http://localhost:7777",
        testTileTrees,
      );
      expect(reopened.getTerminal(terminal.id)).toMatchObject({
        session,
        containerId: otherHome,
        name: "Renamed",
        status: "exited",
      });
      expect(broker.listForContainer(otherHome)).toContainEqual(
        expect.objectContaining({
          id: terminal.id,
          session,
          status: "exited",
        }),
      );
      reopened.deleteTerminal(terminal.id);
      expect(reopened.getTerminal(terminal.id)).toBeNull();
    } finally {
      reopened.close();
    }
  } finally {
    if (!closed) f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cross-machine session references and refused native admission leave no correlated terminal", async () => {
  const f = await fixture();
  try {
    const session = {
      harness: "test-harness",
      machineId: "another-machine",
      sessionId: "saved-session",
    };
    const denied = await f.host.dispatch(f.root, "core.terminals.open", {
      containerId: f.store.listContainers()[0]!.id,
      elementId: "bad-session",
      placement: "tile",
      runtime: { ...f.descriptor, session },
    });
    expect(denied.ok).toBe(false);
    expect(() =>
      f.service.admitTerminal(
        f.root,
        { ...f.descriptor, session },
        f.descriptor.machineId,
        { terminalId: "not-created", terminalHostId: "terminal-host", containerId: "home" },
        1,
      ),
    ).toThrow("terminal_runtime_session_destination_changed");
    await expect(
      f.open({
        ...f.descriptor,
        installationRevision: "stale",
        session: { ...session, machineId: f.descriptor.machineId },
      }),
    ).rejects.toThrow();
    expect(f.sent.filter((message) => message.type === "create")).toEqual([]);
    expect(f.store.listTerminals()).toEqual([]);
  } finally {
    f.close();
  }
});

test("browser descriptors bind distinct runs without returning or journaling their credential", async () => {
  const f = await fixture();
  try {
    const first = await f.create();
    const second = await f.create();
    expect(first.credential).toBeUndefined();
    const a = await f.launch(first.run.id);
    const b = await f.launch(second.run.id);
    expect(a.runtime.launchBinding).not.toBe(b.runtime.launchBinding);
    expect(a.runtime.input).toEqual({ mode: "start" });
    const other = f.auth.mintToken(
      {
        principal: { name: "Another opener", kind: "human" },
        caps: ["containers:read", "terminals:spawn"],
      },
      f.root,
    );
    await expect(f.open(a.runtime, f.auth.authenticate(other.token))).rejects.toThrow();
    await expect(f.open({ ...a.runtime, input: { changed: true } })).rejects.toThrow();
    expect(f.sent.filter((message) => message.type === "create")).toEqual([]);
    await f.open(a.runtime);
    const firstCreate = f.sent.find((message) => message.type === "create");
    if (firstCreate?.type !== "create" || !firstCreate.runtime?.privateEnv)
      throw new Error("native run launch missing");
    const token = firstCreate.runtime.privateEnv.MANIFOLD_RUN_TOKEN;
    expect(f.auth.authenticate(token).agentRunId).toBe(first.run.id);
    expect(firstCreate.runtime.request.terminal?.runId).toBe(first.run.id);
    expect(firstCreate.env).toEqual({});
    expect(JSON.stringify([first, a, firstCreate.runtime.request])).not.toContain(token);
    await f.open(a.runtime);
    expect(f.sent.filter((message) => message.type === "create")).toHaveLength(1);
    await f.open(b.runtime);
    const creates = f.sent.filter((message) => message.type === "create");
    expect(creates).toHaveLength(2);
    expect(creates[1]?.runtime?.privateEnv?.MANIFOLD_RUN_ID).toBe(second.run.id);
    expect(creates[1]?.runtime?.privateEnv?.MANIFOLD_RUN_TOKEN).not.toBe(token);
    expect(f.auth.agentRunPolicyState(f.auth.authenticate(token))).toBe("pending_policy");
  } finally {
    f.close();
  }
});

test("harness launch bindings reject input removal and unavailable sources never reach native creation", async () => {
  const f = await fixture(undefined, ["material"]);
  try {
    f.descriptor.inputs = [
      { name: "material", from: { jobId: "missing-producer", output: "material" } },
    ];
    const { run } = await f.create();
    const launched = await f.launch(run.id);
    // Removing the unavailable source would make this runtime admissible, but it is
    // not the descriptor the harness bound. Refusal must precede native creation.
    await f.open({ ...launched.runtime, inputs: [] });
    expect(f.sent.filter((message) => message.type === "create")).toEqual([]);
    // The unmodified descriptor is bound correctly, but its source is unavailable.
    const unavailable = await f.launch((await f.create()).run.id);
    await expect(f.open(unavailable.runtime)).rejects.toThrow();
    expect(f.sent.filter((message) => message.type === "create")).toEqual([]);
    delete f.descriptor.inputs;
    const plain = await f.create();
    const withoutInputs = await f.launch(plain.run.id);
    const created = await f.openCreated(withoutInputs.runtime);
    expect(f.auth.authenticate(created.runtime!.privateEnv!.MANIFOLD_RUN_TOKEN).agentRunId).toBe(
      plain.run.id,
    );
  } finally {
    f.close();
  }
});

test("harness restart refuses a freshly bound unavailable input without replacing the running terminal", async () => {
  const f = await fixture(undefined, ["material"]);
  try {
    const { run } = await f.create();
    const launched = await f.launch(run.id);
    const create = await f.openCreated(launched.runtime);
    const before = f.store.getTerminal(create.terminalId);
    const layout = f.rooms.get(before!.containerId)!.tileLayout();
    const jobs = f.store.db.query("SELECT job_id FROM machine_jobs ORDER BY job_id").all();
    const liveRunTokens = () =>
      f.store
        .listTokensForAgentRun(run.id)
        .filter((token) => token.revokedAt === null)
        .map((token) => token.id)
        .sort();
    const originalTokens = liveRunTokens();
    const incumbentToken = create.runtime!.privateEnv!.MANIFOLD_RUN_TOKEN;
    f.descriptor.inputs = [
      { name: "material", from: { jobId: "missing-producer", output: "material" } },
    ];
    const refused = await f.host.dispatch(f.root, "core.terminals.restart", {
      terminalId: create.terminalId,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("unavailable input admitted");
    expect(refused.denial.message).toContain("input_source_unavailable:material");
    expect(f.sent.filter((message) => message.type === "terminal_restart")).toEqual([]);
    expect(f.store.getTerminal(create.terminalId)).toEqual(before);
    expect(f.rooms.get(before!.containerId)!.tileLayout()).toEqual(layout);
    expect(f.store.db.query("SELECT job_id FROM machine_jobs ORDER BY job_id").all()).toEqual(jobs);
    expect(f.sent.filter((message) => message.type === "kill")).toEqual([]);
    expect(liveRunTokens()).toEqual(originalTokens);
    expect(f.auth.authenticate(incumbentToken).agentRunId).toBe(run.id);
    // A new harness launch may review a different descriptor; an old recipe does
    // not authorize a missing source, and a refusal does not strand the terminal.
    delete f.descriptor.inputs;
    const original = { ...f.descriptor };
    for (const changed of [
      { machineId: "forged-destination" },
      { operationId: `${operationId}.forged` },
      { installationRevision: "changed-revision" },
      { artifactSha256: "b".repeat(64) },
      { resourceBindingDigest: "c".repeat(64) },
      { session: { ...launched.session, sessionId: "changed-session" } },
    ]) {
      Object.assign(f.descriptor, changed);
      const outcome = await f.host.dispatch(f.root, "core.terminals.restart", {
        terminalId: create.terminalId,
      });
      expect(outcome.ok).toBe(false);
      expect(f.sent.filter((message) => message.type === "terminal_restart")).toEqual([]);
      expect(f.sent.filter((message) => message.type === "kill")).toEqual([]);
      expect(f.store.getTerminal(create.terminalId)).toEqual(before);
      expect(f.rooms.get(before!.containerId)!.tileLayout()).toEqual(layout);
      expect(f.store.db.query("SELECT job_id FROM machine_jobs ORDER BY job_id").all()).toEqual(
        jobs,
      );
      expect(liveRunTokens()).toEqual(originalTokens);
      expect(f.auth.authenticate(incumbentToken).agentRunId).toBe(run.id);
      Object.assign(f.descriptor, original);
      delete f.descriptor.session;
    }
    // A retained signed admission is still known native authority when its generic recipe
    // is absent. Home control alone must refuse before harness/private credential effects.
    f.store.db.query("UPDATE terminals SET launch_recipe=NULL WHERE id=?").run(create.terminalId);
    const retained = f.store.getTerminal(create.terminalId);
    const homeOnly = f.auth.mintToken(
      {
        principal: { name: "Home controller", kind: "human" },
        caps: ["terminals:write"],
        containerId: before!.containerId,
      },
      f.root,
    );
    const launchesBefore = f.launches.length;
    const unavailable = await f.host.dispatch(
      f.auth.authenticate(homeOnly.token),
      "core.terminals.restart",
      { terminalId: create.terminalId },
    );
    if (unavailable.ok) throw new Error("home control admitted native relaunch");
    expect(unavailable.denial.message).toContain("machines:run capability required");
    expect(f.launches).toHaveLength(launchesBefore);
    expect(liveRunTokens()).toEqual(originalTokens);
    expect(f.store.getTerminal(create.terminalId)).toEqual(retained);
    expect(f.store.db.query("SELECT job_id FROM machine_jobs ORDER BY job_id").all()).toEqual(jobs);
    expect(
      result(
        await f.host.dispatch(f.root, "core.terminals.restart", {
          terminalId: create.terminalId,
        }),
      ),
    ).toEqual({});
    expect(f.sent.filter((message) => message.type === "terminal_restart")).toHaveLength(1);
  } finally {
    f.close();
  }
});

test("run terminal restart relaunches its harness session with fresh private signed admission in place", async () => {
  const f = await fixture();
  try {
    const { run } = await f.create();
    const launched = await f.launch(run.id);
    const create = await f.openCreated(launched.runtime);
    const terminalId = create.terminalId;
    f.broker.rename(terminalId, "retained run");
    const before = f.store.getTerminal(terminalId)!;
    const layout = f.rooms.get(before.containerId)!.tileLayout();
    expect(before.runId).toBe(run.id);
    const oldToken = create.runtime!.privateEnv!.MANIFOLD_RUN_TOKEN;
    const outcome = await f.host.dispatch(f.root, "core.terminals.restart", { terminalId });
    expect(result(outcome)).toEqual({});
    expect(
      f.launches.map(({ run: launch, target }) => ({
        runId: launch.id,
        session: launch.session,
        target,
      })),
    ).toEqual([
      {
        runId: run.id,
        session: null,
        target: { machineId: before.machineId, containerId: before.containerId },
      },
      {
        runId: run.id,
        session: launched.session,
        target: { machineId: before.machineId, containerId: before.containerId },
      },
    ]);
    const command = f.sent.find((message) => message.type === "terminal_restart");
    if (!command?.create?.runtime?.privateEnv) throw new Error("private restart missing");
    const replacement = command.create.runtime;
    const token = replacement.privateEnv!.MANIFOLD_RUN_TOKEN;
    expect(token).not.toBe(oldToken);
    expect(f.auth.authenticate(token).agentRunId).toBe(run.id);
    expect(replacement.request.input).toEqual({ mode: `resume:${launched.session.sessionId}` });
    expect(replacement.request.terminal).toEqual(create.runtime!.request.terminal);
    expect(replacement.request.jobId).not.toBe(create.runtime!.request.jobId);
    expect(replacement.permit).not.toEqual(create.runtime!.permit);
    expect(command.create.env).toEqual({});
    expect(f.sent.filter((message) => message.type === "create")).toHaveLength(1);
    expect(
      f.sent.filter(
        (message) => message.type === "job_command" && message.command.type === "start",
      ),
    ).toEqual([]);
    expect(f.store.getTerminal(terminalId)).toEqual(before);
    expect(f.rooms.get(before.containerId)!.tileLayout()).toEqual(layout);
    expect(f.store.getAgentRun(run.id)).toMatchObject({
      session: launched.session,
      expiresAt: run.expiresAt,
      renewals: 0,
    });
    const initialSnapshot = f.service.jobs.get(create.runtime!.request.jobId)!.authoritySnapshot!;
    const replacementSnapshot = f.service.jobs.get(replacement.request.jobId)!.authoritySnapshot!;
    expect(replacementSnapshot.native).toMatchObject({
      machineId: before.machineId,
      containerId: before.containerId,
      pluginId,
      operationId,
      installationRevision: f.descriptor.installationRevision,
      artifactSha256: f.descriptor.artifactSha256,
      resourceBindingDigest: f.descriptor.resourceBindingDigest,
      ownerId: f.owner.ownerId,
      ownerGeneration: f.owner.generation,
      terminalHostId: f.owner.terminalHostId,
    });
    expect(replacementSnapshot.native!.runtimeDigest).not.toBe(
      initialSnapshot.native!.runtimeDigest,
    );
    expect(replacementSnapshot.action).toMatchObject({
      actionName: "core.terminals.restart",
      nativeDemand: [replacementSnapshot.native],
      requirements: [
        { cap: "terminals:write", ref: { kind: "container", containerId: before.containerId } },
        ...initialSnapshot.native!.requirements,
        ...replacementSnapshot.native!.requirements,
      ],
    });
    expect(replacementSnapshot.action!.originalArgsDigest).toBe(
      createHash("sha256").update(canonicalJobJson({ terminalId })).digest("hex"),
    );
    expect(replacementSnapshot.actionCredential).toMatchObject(f.auth.credentialReference(f.root));
    const publicState = JSON.stringify([
      outcome,
      f.store.listTerminals(),
      f.store.db.query("SELECT payload FROM events").all(),
      replacement.request,
      replacementSnapshot,
    ]);
    expect(publicState).not.toContain(token);
    expect(publicState).not.toContain(oldToken);
    // A relaunch descriptor belongs to this terminal, not another terminal_open.
    const relaunch = await f.launch(run.id);
    await f.open(relaunch.runtime);
    expect(f.sent.filter((message) => message.type === "create")).toHaveLength(1);
    await f.open(launched.runtime);
    expect(f.sent.filter((message) => message.type === "create")).toHaveLength(1);
  } finally {
    f.close();
  }
});

test("retained run bindings relaunch without a generic recipe and reject forged restart descriptors", async () => {
  const f = await fixture();
  try {
    const { run } = await f.create();
    const launched = await f.launch(run.id);
    const create = await f.openCreated(launched.runtime);
    f.store.db.query("UPDATE terminals SET launch_recipe=NULL WHERE id=?").run(create.terminalId);
    expect(
      result(
        await f.host.dispatch(f.root, "core.terminals.restart", {
          terminalId: create.terminalId,
        }),
      ),
    ).toEqual({});
    const restart = f.sent.find((message) => message.type === "terminal_restart");
    expect(restart?.noRecipe).toBeUndefined();
    expect(restart?.create?.runtime?.request.input).toEqual({
      mode: `resume:${launched.session.sessionId}`,
    });
    expect(restart?.create?.runtime?.privateEnv?.MANIFOLD_RUN_ID).toBe(run.id);
    const traceId = f.store.appendTrace({
      actor: f.root.principal.id,
      authority: "root",
      door: "core.terminals.restart",
      containerId: null,
      session: null,
      ts: f.runtime.now(),
      outcome: null,
      targets: [],
      payload: { terminalId: create.terminalId },
    });
    expect(() =>
      f.service.admitTerminal(
        f.root,
        { ...f.descriptor, launchBinding: "caller-forged", input: { mode: "replacement" } },
        f.descriptor.machineId,
        create.runtime!.request.terminal!,
        traceId,
      ),
    ).toThrow("run_launch_binding_required");
  } finally {
    f.close();
  }
});

test("plain governed restart uses its exact recipe without invoking a harness", async () => {
  const f = await fixture();
  try {
    const create = await f.openCreated(f.descriptor);
    expect(
      result(
        await f.host.dispatch(f.root, "core.terminals.restart", {
          terminalId: create.terminalId,
        }),
      ),
    ).toEqual({});
    expect(f.launches).toEqual([]);
    const restart = f.sent.find((message) => message.type === "terminal_restart");
    expect(restart?.create?.runtime?.request.input).toEqual(create.runtime!.request.input);
    expect(restart?.create?.runtime?.request.jobId).not.toBe(create.runtime!.request.jobId);
    expect(restart?.create?.runtime?.privateEnv).toBeUndefined();
    expect(f.store.getTerminal(create.terminalId)?.runId).toBeUndefined();
  } finally {
    f.close();
  }
});

test("run restart refuses a changed session and a disabled harness without replacement admission", async () => {
  const f = await fixture();
  try {
    const { run } = await f.create();
    const launched = await f.launch(run.id);
    const create = await f.openCreated(launched.runtime);
    const harness = f.definition.harness!;
    const launch = harness.launch;
    harness.launch = async (...args) => {
      const prepared = await launch(...args);
      return { ...prepared, session: { ...prepared.session, sessionId: "another-session" } };
    };
    const tokens = f.store.listTokensForAgentRun(run.id);
    expect(
      (
        await f.host.dispatch(f.root, "core.terminals.restart", {
          terminalId: create.terminalId,
        })
      ).ok,
    ).toBe(false);
    expect(f.store.listTokensForAgentRun(run.id)).toEqual(tokens);
    expect(f.store.getAgentRun(run.id)?.session).toEqual(launched.session);
    result(
      await f.host.dispatch(f.root, "engine.plugins.setEnabled", { id: pluginId, enabled: false }),
    );
    expect(
      (
        await f.host.dispatch(f.root, "core.terminals.restart", {
          terminalId: create.terminalId,
        })
      ).ok,
    ).toBe(false);
    expect(f.launches).toHaveLength(2);
    expect(f.sent.filter((message) => message.type === "terminal_restart")).toEqual([]);
    expect(f.store.getTerminal(create.terminalId)?.status).toBe("running");
  } finally {
    f.close();
  }
});

test("an awaited harness launch holds the restart guard and rechecks home authority", async () => {
  const f = await fixture();
  try {
    const grant = f.auth.mintToken(
      {
        principal: { name: "restart administrator", kind: "human" },
        caps: ["*"],
      },
      f.root,
    );
    const actor = f.auth.authenticate(grant.token);
    const { run } = await f.create();
    const create = await f.openCreated((await f.launch(run.id)).runtime);
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const harness = f.definition.harness!;
    const launch = harness.launch;
    harness.launch = async (...args) => {
      entered.resolve();
      await gate.promise;
      return launch(...args);
    };
    const pending = f.host.dispatch(actor, "core.terminals.restart", {
      terminalId: create.terminalId,
    });
    await admittedMessage(entered.promise, pending, "harness restart launch");
    f.broker.onRestarted(f.descriptor.machineId, {
      type: "terminal_restarted",
      terminalId: create.terminalId,
      cwd: "/stale-ack",
    });
    f.broker.onRestartError(f.descriptor.machineId, create.terminalId, "stale-refusal");
    expect(f.store.getTerminal(create.terminalId)?.cwd).toBeUndefined();
    expect(
      await f.host.dispatch(actor, "core.terminals.restart", {
        terminalId: create.terminalId,
      }),
    ).toMatchObject({ ok: false, denial: { message: "restart_pending" } });
    f.auth.grant(
      {
        principal: { kind: "principal", id: actor.principal.id },
        node: `manifold://container/${f.store.getTerminal(create.terminalId)!.containerId}`,
        caps: ["terminals:write"],
        effect: "deny",
        reach: "node",
      },
      f.root,
    );
    gate.resolve();
    expect((await pending).ok).toBe(false);
    expect(f.sent.filter((message) => message.type === "terminal_restart")).toEqual([]);
  } finally {
    f.close();
  }
});

interface HarnessEffectFixture {
  descriptor: TerminalRuntime;
  runtime: FakeRuntime;
}

function harnessJob(f: HarnessEffectFixture, jobId: string) {
  return {
    jobId,
    machineId: f.descriptor.machineId,
    operationId,
    installationRevision: "r1",
    artifactSha256: hash,
    input: { mode: "harness-effect" },
    outputs: [],
  };
}

function harnessSchedule(f: HarnessEffectFixture, scheduleId: string) {
  return {
    ...harnessJob(f, `template-${scheduleId}`),
    scheduleId,
    revision: "one",
    firstNominalAt: f.runtime.now() + 1000,
    intervalMs: 60_000,
    deadlineMs: 30_000,
    expiresAt: f.runtime.now() + 60_000,
    offlinePolicy: "coalesce-one" as const,
  };
}

test.each(["live", "home-write", "action-binding", "harness-binding", "retired"] as const)(
  "a late harness restart keeps its originating authority for every effect (%s)",
  async (change) => {
    const f = await fixture(undefined, undefined, undefined, undefined, undefined, [
      "services:configure",
    ]);
    const gate = Promise.withResolvers<void>();
    const action = f.host.assembly().actions.get("core.terminals.restart")!.def;
    const originalInput = action.input;
    let retiring: Promise<ActionOutcome> | undefined;
    try {
      const actor = f.auth.authenticate(
        f.auth.mintToken(
          { principal: { name: "harness restart administrator", kind: "human" }, caps: ["*"] },
          f.root,
        ).token,
      );
      const { run } = await f.create();
      const create = await f.openCreated((await f.launch(run.id)).runtime);
      const incumbentToken = create.runtime!.privateEnv!.MANIFOLD_RUN_TOKEN;
      const before = f.store.getTerminal(create.terminalId);
      const jobsBefore = f.store.db.query("SELECT job_id FROM machine_jobs ORDER BY job_id").all();
      const entered = Promise.withResolvers<void>();
      let retained: ActionCtx | undefined;
      let effects: PromiseSettledResult<unknown>[] = [];
      const harness = f.definition.harness!;
      const launch = harness.launch;
      harness.launch = async (ctx, ...args) => {
        retained = ctx;
        entered.resolve();
        await gate.promise;
        effects = await Promise.allSettled([
          Promise.resolve().then(() => ctx.storage.set("harness-effect", change)),
          Promise.resolve().then(() => ctx.jobs.execute(harnessJob(f, "harness-effect"))),
          Promise.resolve().then(() => ctx.jobs.schedule(harnessSchedule(f, "harness-effect"))),
          Promise.resolve().then(() =>
            ctx.services.configureConfiguration({
              machineId: f.descriptor.machineId,
              expectedRevision: null,
              policies: [],
            }),
          ),
        ]);
        return launch(ctx, ...args);
      };
      const pending = f.host.dispatch(actor, "core.terminals.restart", {
        terminalId: create.terminalId,
      });
      await admittedMessage(entered.promise, pending, "captured harness restart");
      switch (change) {
        case "home-write":
          f.auth.grant(
            {
              principal: { kind: "principal", id: actor.principal.id },
              node: `manifold://container/${f.containerId}`,
              caps: ["terminals:write"],
              reach: "node",
              effect: "deny",
            },
            f.root,
          );
          // Native permission survives; it must not replace the originating home requirement.
          expect(
            f.auth.allowsNode(actor, "machines:run",
              `manifold://machine/${f.descriptor.machineId}/operation/${operationId}`),
          ).toBe(true);
          break;
        case "action-binding":
          Reflect.set(action, "input", z.strictObject({}));
          break;
        case "harness-binding":
          harness.launch = launch;
          break;
        case "retired": {
          const disabled = Promise.withResolvers<void>();
          const disablePlugin = f.service.disablePlugin.bind(f.service);
          f.service.disablePlugin = (id) => {
            disablePlugin(id);
            if (id === pluginId) disabled.resolve();
          };
          retiring = f.host.dispatch(f.root, "engine.plugins.setEnabled", {
            id: pluginId, enabled: false,
          });
          await admittedMessage(disabled.promise, retiring, "harness disable committed");
          break;
        }
      }
      gate.resolve();
      const outcome = await pending;
      if (retiring !== undefined) {
        result(await retiring);
        result(await f.host.dispatch(f.root, "engine.plugins.setEnabled", {
          id: pluginId, enabled: true,
        }));
      }
      if (change === "live") {
        expect(outcome).toMatchObject({ ok: true });
        expect(effects.map((effect) => effect.status)).toEqual([
          "fulfilled", "fulfilled", "fulfilled", "fulfilled",
        ]);
        expect(await f.store.pluginStorage(pluginId).get("harness-effect")).toBe("live");
        expect(f.service.jobs.get("harness-effect")?.state).toBe("start-committed");
        expect(f.service.jobSchedules.listSchedules().map((entry) => entry.scheduleId)).toEqual([
          "harness-effect",
        ]);
        expect(f.service.readServiceConfiguration(f.root, {
          machineId: f.descriptor.machineId,
        }).configuration.revision).not.toBeNull();
      } else {
        expect(outcome).toMatchObject({ ok: false });
        expect(effects.map((effect) => effect.status)).toEqual([
          "rejected", "rejected", "rejected", "rejected",
        ]);
        expect(await f.store.pluginStorage(pluginId).get("harness-effect")).toBeNull();
        expect(f.store.db.query("SELECT job_id FROM machine_jobs ORDER BY job_id").all()).toEqual(jobsBefore);
        expect(f.service.jobSchedules.listSchedules()).toEqual([]);
        expect(f.service.readServiceConfiguration(f.root, {
          machineId: f.descriptor.machineId,
        }).configuration.revision).toBeNull();
        expect(f.sent.filter((message) => message.type === "terminal_restart")).toEqual([]);
        expect(f.store.getTerminal(create.terminalId)).toEqual(before);
        expect(f.sent.filter((message) => message.type === "kill")).toEqual([]);
        expect(f.auth.authenticate(incumbentToken).agentRunId).toBe(run.id);
      }
      if (retained === undefined) throw new Error("harness context was not captured");
      await expect(retained.storage.set("after-return", "forbidden")).rejects.toThrow();
      expect(() => retained!.jobs.execute(harnessJob(f, "after-return"))).toThrow();
      expect(() => retained!.jobs.schedule(harnessSchedule(f, "after-return"))).toThrow();
      expect(() => retained!.services.configureConfiguration({
        machineId: f.descriptor.machineId,
        expectedRevision: f.service.readServiceConfiguration(f.root, {
          machineId: f.descriptor.machineId,
        }).configuration.revision,
        policies: [],
      })).toThrow();
      expect(f.service.jobs.get("after-return")).toBeNull();
    } finally {
      gate.resolve();
      Reflect.set(action, "input", originalInput);
      f.close();
    }
  },
);

test.each(["fresh", "recovered"] as const)(
  "harness native effects and schedules retain the original action credential on %s restore",
  async (recovery) => {
    const dir = mkdtempSync(join(tmpdir(), "manifold-harness-effect-custody-"));
    const path = join(dir, "hub.sqlite");
    const f = await fixture(undefined, undefined, path);
    let closed = false;
    let recoveredStore: ServerStore | undefined;
    let recoveredHost: PluginHost | undefined;
    try {
      const actor = f.auth.authenticate(
        f.auth.mintToken(
          { principal: { name: "durable harness administrator", kind: "human" }, caps: ["*"] },
          f.root,
        ).token,
      );
      const { run } = await f.create();
      const create = await f.openCreated((await f.launch(run.id)).runtime);
      const harness = f.definition.harness!;
      const launch = harness.launch;
      harness.launch = async (ctx, ...args) => {
        ctx.jobs.execute(harnessJob(f, "durable-harness"));
        ctx.jobs.schedule(harnessSchedule(f, "durable-harness"));
        return launch(ctx, ...args);
      };
      expect(result(await f.host.dispatch(actor, "core.terminals.restart", {
        terminalId: create.terminalId,
      }))).toEqual({});
      const native = f.service.jobs.get("durable-harness")!;
      const schedule = f.service.jobSchedules.listSchedules()[0]!;
      for (const snapshot of [native.authoritySnapshot, schedule.authoritySnapshot]) {
        expect(snapshot?.actionCredential).toEqual(f.auth.credentialReference(actor));
        expect(snapshot?.credential.caps).toContain("machines:run");
        expect(snapshot?.credential.caps).not.toContain("terminals:write");
        expect(snapshot?.action).toMatchObject({
          actionName: "core.terminals.restart",
          originalArgsDigest: createHash("sha256")
            .update(canonicalJobJson({ terminalId: create.terminalId })).digest("hex"),
          requirements: [
            { cap: "terminals:write", ref: { kind: "container", containerId: f.containerId } },
            { cap: "machines:run",
              node: `manifold://machine/${f.descriptor.machineId}/operation/${operationId}`,
              reach: "node" },
          ],
        });
      }
      const start = f.commands.find((command) =>
        command.type === "start" && command.request.jobId === native.request.jobId);
      if (start?.type !== "start") throw new Error("harness native effect was not admitted");
      f.started(start);
      let service = f.service;
      let auth = f.auth;
      let root = f.root;
      if (recovery === "recovered") {
        f.close();
        closed = true;
        recoveredStore = new ServerStore(openDatabase(path));
        const store = recoveredStore;
        auth = new AuthService(store, "a".repeat(64), f.runtime, {
          decide: (request) => service.decide(request),
        });
        root = auth.authenticate("a".repeat(64));
        const rooms = new RoomManager(store, f.runtime, f.clock, silentLogger, testTileTrees);
        const broker = new TerminalBroker(store, auth, rooms, f.runtime, f.clock, silentLogger,
          () => "http://localhost:7777", testTileTrees);
        recoveredHost = await testPluginHost(store, auth, rooms, broker, f.runtime, {
          settingsPlugins: [f.definition],
        });
        service = new JobService(store, auth, f.runtime);
        recoveredHost.setJobs(service);
        broker.setJobs(service);
        f.proveOwner(service);
      }
      service.tick();
      expect(service.jobs.get(native.request.jobId)?.request).toEqual(native.request);
      expect(service.jobs.cancellation(native.request.jobId)).toBeNull();
      const incumbentCancellation = service.jobs.cancellation(create.runtime!.request.jobId);
      auth.grant({
        principal: { kind: "principal", id: actor.principal.id },
        node: `manifold://container/${f.containerId}`,
        caps: ["terminals:write"],
        reach: "node",
        effect: "deny",
      }, root);
      expect(auth.allowsNode(auth.restoreCredential(f.auth.credentialReference(actor))!,
        "machines:run", `manifold://machine/${f.descriptor.machineId}/operation/${operationId}`)).toBe(true);
      f.runtime.time = schedule.firstNominalAt;
      service.tick();
      expect(service.jobs.cancellation(native.request.jobId)?.mode).toBe("cancel");
      expect(service.jobSchedules.listSchedules()).toEqual([]);
      const occurrenceId = `schedule-${createHash("sha256")
        .update(canonicalJobJson([schedule.scheduleId, schedule.revision, schedule.firstNominalAt]))
        .digest("hex")}`;
      expect(service.jobs.get(occurrenceId)).toBeNull();
      expect(service.jobSchedules.getOccurrence(occurrenceId)).toBeNull();
      expect(f.commands.filter((command) =>
        command.type === "start" && command.request.jobId === occurrenceId)).toEqual([]);
      expect(service.jobs.cancellation(create.runtime!.request.jobId)).toEqual(incumbentCancellation);
    } finally {
      recoveredHost?.close();
      recoveredStore?.close();
      if (!closed) f.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test.each(["unchanged", "implementation", "profile", "manifest"] as const)(
  "cold harness restoration conjunctively pins server binding while retaining native artifact (%s)",
  async (change) => {
    const dir = mkdtempSync(join(tmpdir(), "manifold-cold-harness-binding-"));
    const path = join(dir, "hub.sqlite");
    const f = await fixture(undefined, undefined, path);
    let closed = false;
    let recoveredStore: ServerStore | undefined;
    let recoveredHost: PluginHost | undefined;
    try {
      // This fixture bypasses MachineGateway; persist the same admitted owner fact.
      const machineId = f.descriptor.machineId;
      f.store.touchMachine(
        machineId,
        f.store.getMachine(machineId)!.name,
        f.runtime.now(),
        f.owner.terminalHostId ?? null,
      );
      const harness = f.definition.harness!;
      const launch = harness.launch;
      harness.launch = async (ctx, run, agent, target) => {
        if (run.session !== null) {
          ctx.jobs.execute(harnessJob(f, "cold-harness"));
          ctx.jobs.schedule(harnessSchedule(f, "cold-harness"));
        }
        return launch.call(harness, ctx, run, agent, target);
      };
      const { run } = await f.create();
      const create = await f.openCreated((await f.launch(run.id)).runtime);
      expect(result(await f.host.dispatch(f.root, "core.terminals.restart", {
        terminalId: create.terminalId,
      }))).toEqual({});
      const bound = f.service.jobs.get("cold-harness")!;
      const schedule = f.service.jobSchedules.listSchedules()[0]!;
      const independent = f.service.execute(f.root, pluginId, "independent", {
        ...harnessJob(f, "independent"),
      });
      for (const job of [bound, independent]) {
        const start = f.commands.find((command) =>
          command.type === "start" && command.request.jobId === job.request.jobId);
        if (start?.type !== "start") throw new Error("native effect was not admitted");
        f.started(start);
      }
      const originalAction = bound.authoritySnapshot!.action!;
      expect(originalAction.actionName).toBe("core.terminals.restart");
      expect(originalAction.requirements[0]).toEqual({
        cap: "terminals:write",
        ref: { kind: "container", containerId: f.containerId },
      });
      let restoredDefinition: ServerPluginDef = {
        ...f.definition,
        harness: { ...harness },
      };
      if (change === "implementation") {
        const previous = restoredDefinition.harness!.launch;
        restoredDefinition.harness!.launch = async (ctx, currentRun, agent, target) => ({
          ...await previous(ctx, currentRun, agent, target),
          reviewDigest: "b".repeat(64),
        });
      } else if (change === "profile") {
        restoredDefinition = {
          ...restoredDefinition,
          harness: {
            ...restoredDefinition.harness!,
            profileSchema: z.strictObject({
              label: z.string().min(1),
              reviewedMode: z.literal("interactive").optional(),
            }),
          },
        };
      } else if (change === "manifest") {
        restoredDefinition = {
          ...restoredDefinition,
          manifest: { ...restoredDefinition.manifest, version: "2.0.0" },
        };
      }
      f.close();
      closed = true;
      recoveredStore = new ServerStore(openDatabase(path));
      const store = recoveredStore;
      let service: JobService;
      const auth = new AuthService(store, "a".repeat(64), f.runtime, {
        decide: (request) => service.decide(request),
      });
      const rooms = new RoomManager(store, f.runtime, f.clock, silentLogger, testTileTrees);
      const broker = new TerminalBroker(store, auth, rooms, f.runtime, f.clock, silentLogger,
        () => "http://localhost:7777", testTileTrees);
      recoveredHost = await testPluginHost(store, auth, rooms, broker, f.runtime, {
        settingsPlugins: [restoredDefinition],
      });
      service = new JobService(store, auth, f.runtime);
      recoveredHost.setJobs(service);
      broker.setJobs(service);
      f.proveOwner(service);
      expect(service.jobs.installation(machineId, pluginId)).toMatchObject({
        revision: "r1",
        artifact: hash,
        enabled: true,
      });
      f.runtime.time = schedule.firstNominalAt;
      service.tick();
      expect(service.jobs.get(bound.request.jobId)?.request).toEqual(bound.request);
      expect(service.jobs.get(bound.request.jobId)?.authoritySnapshot?.action).toEqual(originalAction);
      expect(service.jobs.cancellation(independent.request.jobId)).toBeNull();
      expect(service.jobs.get(independent.request.jobId)?.state).toBe("started");
      const occurrenceId = `schedule-${createHash("sha256")
        .update(canonicalJobJson([schedule.scheduleId, schedule.revision, schedule.firstNominalAt]))
        .digest("hex")}`;
      if (change === "unchanged") {
        expect(service.jobs.cancellation(bound.request.jobId)).toBeNull();
        expect(service.jobs.get(occurrenceId)?.state).toBe("start-committed");
        expect(service.jobSchedules.getOccurrence(occurrenceId)?.state).toBe("admitted");
        expect(f.commands.filter((command) =>
          command.type === "start" && command.request.jobId === occurrenceId)).toHaveLength(1);
      } else {
        expect(service.jobs.cancellation(bound.request.jobId)?.mode).toBe("cancel");
        expect(service.jobs.get(occurrenceId)).toBeNull();
        expect(service.jobSchedules.getOccurrence(occurrenceId)).toBeNull();
        expect(service.jobSchedules.listSchedules()).toEqual([]);
        expect(f.commands.filter((command) =>
          command.type === "start" && command.request.jobId === occurrenceId)).toEqual([]);
      }
    } finally {
      recoveredHost?.close();
      recoveredStore?.close();
      if (!closed) f.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("restart transport capability cannot override the negotiated protocol floor", async () => {
  const f = await fixture();
  try {
    const { run } = await f.create();
    const create = await f.openCreated((await f.launch(run.id)).runtime);
    f.connect(32, JOB_OWNER_PROTOCOL_VERSION);
    expect(
      await f.host.dispatch(f.root, "core.terminals.restart", {
        terminalId: create.terminalId,
      }),
    ).toMatchObject({ ok: false, denial: { message: "unsupported" } });
    expect(f.launches).toHaveLength(1);
    expect(f.sent.filter((message) => message.type === "terminal_restart")).toEqual([]);
  } finally {
    f.close();
  }
});

test("expired launch bindings cannot reach native admission", async () => {
  const f = await fixture();
  try {
    const created = await f.create();
    const launch = await f.launch(created.run.id);
    f.clock.advance(60001);
    await f.open(launch.runtime);
    expect(f.sent.filter((message) => message.type === "create")).toEqual([]);
  } finally {
    f.close();
  }
});

test("live harness inventory owns profile validation and loses execution on disable", async () => {
  const f = await fixture();
  try {
    const inventory = ListHarnessesResultSchema.parse(
      result(await f.host.dispatch(f.root, "core.access.listHarnesses", {})),
    );
    expect(inventory.harnesses.map((harness) => harness.id)).toContain("test-harness");
    await expect(
      f.auth.registerAgent(
        {
          name: "Invalid",
          purpose: "Bad profile",
          harness: "test-harness",
          grant: f.registered.agent.grant,
          context: { profile: { label: 7 } },
        },
        f.root,
      ),
    ).rejects.toThrow("harness profile invalid");
    const created = await f.create();
    result(
      await f.host.dispatch(f.root, "engine.plugins.setEnabled", { id: pluginId, enabled: false }),
    );
    expect(
      (await f.host.dispatch(f.root, "core.access.launchRun", { runId: created.run.id })).ok,
    ).toBe(false);
    const disabled = ListHarnessesResultSchema.parse(
      result(await f.host.dispatch(f.root, "core.access.listHarnesses", {})),
    );
    expect(disabled.harnesses.map((harness) => harness.id)).not.toContain("test-harness");
  } finally {
    f.close();
  }
});

test.each(["profile_changed", "run_revoked"] as const)(
  "awaited profile validation fences a %s launch before invoking the harness",
  async (change) => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let validatingLaunch = false;
    const f = await fixture(
      undefined,
      undefined,
      undefined,
      z.strictObject({ label: z.string().min(1) }).refine(async () => {
        if (validatingLaunch) {
          entered.resolve();
          await release.promise;
        }
        return true;
      }),
    );
    let pending: Promise<ActionOutcome> | undefined;
    try {
      const created = await f.create();
      validatingLaunch = true;
      pending = f.host.dispatch(f.root, "core.access.launchRun", { runId: created.run.id });
      await admittedMessage(entered.promise, pending, "harness profile validation");
      validatingLaunch = false;
      if (change === "profile_changed")
        await f.auth.updateAgent(
          {
            agentId: created.run.agentId,
            context: { profile: { label: "changed while launch validation waited" } },
          },
          f.root,
        );
      else f.auth.disableAgent({ agentId: created.run.agentId }, f.root);
      release.resolve();
      expect((await pending).ok).toBe(false);
      expect(f.launches).toEqual([]);
      expect(f.store.getAgentRun(created.run.id)?.session).toBeNull();
    } finally {
      release.resolve();
      await pending;
      f.close();
    }
  },
);

test("harness session inventory bounds retained transcripts and reports truncation at the limit", async () => {
  const f = await fixture();
  try {
    const harness = f.definition.harness;
    if (!harness) throw new Error("fixture harness missing");
    const sessions = Array.from({ length: 101 }, (_, index) => ({
      harness: "test-harness",
      machineId: f.descriptor.machineId,
      sessionId: `retained-${index}`,
    }));
    harness.sessions = async () => sessions;
    const request = { harness: "test-harness", target: { machineId: f.descriptor.machineId } };
    const truncated = ListHarnessSessionsResultSchema.parse(
      result(await f.host.dispatch(f.root, "core.access.listHarnessSessions", request)),
    );
    expect(truncated).toEqual({ sessions: sessions.slice(0, 100), truncated: true });

    sessions.pop();
    const complete = ListHarnessSessionsResultSchema.parse(
      result(await f.host.dispatch(f.root, "core.access.listHarnessSessions", request)),
    );
    expect(complete).toEqual({ sessions, truncated: false });
  } finally {
    f.close();
  }
});

test("duplicate non-core harnesses are held without shadowing a live runtime", async () => {
  const f = await fixture();
  try {
    const host = await f.duplicate();
    try {
      for (const id of [pluginId, "test.other-harness"]) {
        const row = host.roster().find((entry) => entry.manifest.id === id);
        if (row?.held === undefined) throw new Error("expected the duplicate harness to be held");
        expect(row?.enabled).toBe(false);
        expect(row?.held?.reason).toContain('duplicate harness "test-harness"');
        expect(await host.setEnabled(id, true, f.root.principal.id)).toEqual({
          refused: row.held.reason,
        });
      }
      const inventory = ListHarnessesResultSchema.parse(
        result(await host.dispatch(f.root, "core.access.listHarnesses", {})),
      );
      expect(inventory.harnesses.map((harness) => harness.id)).not.toContain("test-harness");
    } finally {
      host.close();
    }
  } finally {
    f.close();
  }
});

test("private launches refuse v34 owners before disclosure but v35 owners consume the same binding", async () => {
  const f = await fixture();
  try {
    const pending = await f.create();
    const bound = await f.launch(pending.run.id);
    const unlaunched = await f.create();
    for (const [transport, owner] of [
      [31, JOB_OWNER_PROTOCOL_VERSION],
      [32, 34],
    ] as const) {
      f.connect(transport, owner);
      const refused = await f.host.dispatch(f.root, "core.access.launchRun", {
        runId: unlaunched.run.id,
      });
      expect(refused).toMatchObject({
        ok: false,
        denial: { message: "run_launch_protocol_unsupported" },
      });
      const socket = await f.open(bound.runtime);
      expect(socket.messages()).toContainEqual(
        expect.objectContaining({
          type: "error",
          code: "forbidden",
          message: "run_launch_protocol_unsupported",
        }),
      );
      expect(f.sent.filter((message) => message.type === "create")).toEqual([]);
    }
    // Compatibility refusal does not consume an otherwise valid one-use launch binding.
    f.connect(32, 35);
    await f.open(bound.runtime);
    const create = f.sent.find((message) => message.type === "create");
    expect(create?.runtime?.privateEnv?.MANIFOLD_RUN_ID).toBe(pending.run.id);
    const current = await f.launch(unlaunched.run.id);
    expect(current.runtime.launchBinding).not.toBe(bound.runtime.launchBinding);
  } finally {
    f.close();
  }
});

test("harness dependency calls retain the owning plugin and the incoming call chain", async () => {
  const catalog = "test.harness-catalog";
  const inventory = z.strictObject({ sessions: SessionRefSchema.array() });
  let returnToAccess = false;
  const dependency: ServerPluginDef = {
    manifest: {
      id: catalog,
      version: "1.0.0",
      title: "Harness catalog",
      description: "Resolves retained harness conversations",
      capabilities: [],
      dependencies: { "core.access": { type: "required" } },
      contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
    },
    actions: [
      defineAction({
        name: "sessions",
        title: "Resolve conversations",
        caps: [],
        input: z.strictObject({ machineId: z.string() }),
        result: inventory,
      }),
    ],
    handlers: {
      async sessions(ctx: ActionCtx, input: { machineId: string }) {
        if (returnToAccess) {
          // A lost incoming frame must fail the assertion, not recurse without a bound.
          returnToAccess = false;
          return ctx.actions.call({
            plugin: "core.access",
            action: "listHarnessSessions",
            input: { harness: "test-harness", target: input },
          });
        }
        return {
          sessions: [
            { harness: "test-harness", machineId: input.machineId, sessionId: "retained" },
          ],
        };
      },
    },
  };
  const f = await fixture(dependency);
  try {
    f.definition.harness!.sessions = async (ctx, target) =>
      inventory.parse(
        await ctx.actions.call({ plugin: catalog, action: "sessions", input: target }),
      ).sessions;
    const request = { harness: "test-harness", target: { machineId: f.descriptor.machineId } };
    const listed = ListHarnessSessionsResultSchema.parse(
      result(await f.host.dispatch(f.root, "core.access.listHarnessSessions", request)),
    );
    expect(listed.sessions).toEqual([
      { harness: "test-harness", machineId: f.descriptor.machineId, sessionId: "retained" },
    ]);
    returnToAccess = true;
    expect(await f.host.dispatch(f.root, "core.access.listHarnessSessions", request)).toMatchObject(
      {
        ok: false,
        denial: { rule: "refused", message: expect.stringContaining("dispatch_cycle:") },
      },
    );
  } finally {
    f.close();
  }
});

test("a harness is host-entered even when a plugin opened the access door", async () => {
  const asker = "test.harness-asker";
  const seen: { at: string; callerPlugin: string | null }[] = [];
  let onward = true;
  const dependency: ServerPluginDef = {
    manifest: {
      id: asker,
      version: "1.0.0",
      title: "Harness asker",
      description: "Opens the access door as a plugin",
      capabilities: [],
      dependencies: { "core.access": { type: "required" } },
      contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
    },
    actions: [
      defineAction({
        name: "ask",
        title: "Ask for sessions",
        caps: [],
        input: z.strictObject({ machineId: z.string() }),
        result: z.unknown(),
      }),
      defineAction({
        name: "record",
        title: "Record caller",
        caps: [],
        input: z.strictObject({}),
        result: z.strictObject({}),
      }),
    ],
    handlers: {
      ask: async (ctx: ActionCtx, target: { machineId: string }) =>
        ctx.actions.call({
          plugin: "core.access",
          action: "listHarnessSessions",
          input: { harness: "test-harness", target },
        }),
      record: async (ctx: ActionCtx) => {
        seen.push({ at: "record", callerPlugin: ctx.callerPlugin });
        return {};
      },
    },
  };
  const f = await fixture(dependency);
  try {
    f.definition.harness!.sessions = async (ctx) => {
      seen.push({ at: "harness", callerPlugin: ctx.callerPlugin });
      if (onward) await ctx.actions.call({ plugin: asker, action: "record", input: {} });
      return [];
    };
    const target = { machineId: f.descriptor.machineId };
    expect(
      await f.host.dispatch(f.root, "core.access.listHarnessSessions", {
        harness: "test-harness",
        target,
      }),
    ).toMatchObject({ ok: true });
    // The asker is already on this trace, so the harness makes no onward call here.
    onward = false;
    expect(await f.host.dispatch(f.root, `${asker}.ask`, target)).toMatchObject({ ok: true });
    expect(seen).toEqual([
      { at: "harness", callerPlugin: null },
      { at: "record", callerPlugin: pluginId },
      { at: "harness", callerPlugin: null },
    ]);
  } finally {
    f.close();
  }
});

test.each(["draining", "disabled", "withdrawn"] as const)(
  "a %s launch cannot admit a late run restart",
  async (change) => {
    const f = await fixture();
    const gate = Promise.withResolvers<void>();
    try {
      const { run } = await f.create();
      const create = await f.openCreated((await f.launch(run.id)).runtime);
      const entered = Promise.withResolvers<void>();
      const harness = f.definition.harness!;
      const launch = harness.launch;
      harness.launch = async (...args) => {
        entered.resolve();
        await gate.promise;
        return launch(...args);
      };
      const pending = f.host.dispatch(f.root, "core.terminals.restart", {
        terminalId: create.terminalId,
      });
      await admittedMessage(entered.promise, pending, "harness restart launch");
      let drain: Promise<unknown> | undefined;
      switch (change) {
        case "draining":
          drain = f.broker.drain(f.descriptor.machineId, true);
          break;
        case "disabled":
          result(
            await f.host.dispatch(f.root, "engine.plugins.setEnabled", {
              id: pluginId,
              enabled: false,
            }),
          );
          break;
        case "withdrawn":
          f.auth.disableAgent({ agentId: run.agentId }, f.root);
          break;
      }
      gate.resolve();
      expect((await pending).ok).toBe(false);
      expect(f.sent.filter((message) => message.type === "terminal_restart")).toEqual([]);
      f.clock.advance(10_000);
      await drain;
    } finally {
      gate.resolve();
      f.close();
    }
  },
);

interface GovernedTerminalFixture {
  auth: AuthService;
  root: AuthContext;
  host: PluginHost;
  broker: TerminalBroker;
  runtime: FakeRuntime;
  descriptor: TerminalRuntime;
  containerId: string;
  firstCreate: Promise<Extract<ServerToAgentMessage, { type: "create" }>>;
  sent: ServerToAgentMessage[];
  owner: JobOwner;
  openCreated(value: TerminalRuntime): Promise<Extract<ServerToAgentMessage, { type: "create" }>>;
}

function governedTerminalScope(f: GovernedTerminalFixture): AuthorityScope {
  return [
    {
      target: "manifold://",
      reach: "subtree",
      caps: [
        "containers:read",
        "containers:write",
        "scenes:write",
        "terminals:spawn",
        "terminals:write",
      ],
    },
    {
      target: `manifold://machine/${f.descriptor.machineId}/operation/${f.descriptor.operationId}`,
      reach: "node",
      caps: ["machines:run"],
    },
  ];
}

async function governedCreated(
  f: GovernedTerminalFixture,
  actor: AuthContext = f.root,
  legacy = false,
) {
  if (legacy) return f.openCreated(f.descriptor);
  const pending = f.host.dispatch(actor, "core.terminals.create", {
    containerId: f.containerId,
    elementId: f.runtime.newId(),
    machineId: f.descriptor.machineId,
    placement: "tile",
    cols: 80,
    rows: 24,
    runtime: f.descriptor,
  });
  const create = await admittedMessage(f.firstCreate, pending, "governed terminal create");
  f.broker.onCreated(f.descriptor.machineId, create.terminalId);
  result(await pending);
  return create;
}

async function admissionDrain(f: GovernedTerminalFixture, terminalId: string) {
  const pending = f.broker.drain(f.descriptor.machineId, true);
  const drain = f.sent.findLast((message) => message.type === "drain");
  if (!drain) throw new Error("drain request missing");
  f.broker.onDrainStatus(f.descriptor.machineId, {
    type: "drain_status",
    requestId: drain.requestId,
    terminalHostId: f.owner.terminalHostId!,
    draining: true,
    terminalIds: [terminalId],
  });
  expect(await pending).toMatchObject({ ok: true, status: { terminalIds: [terminalId] } });
}

test.each(["legacy birth", "prepared birth", "restart"] as const)(
  "committed governed %s survives retained-owner transport replacement and admission drain",
  async (phase) => {
    const f = await fixture();
    try {
      const create = await governedCreated(f, f.root, phase === "legacy birth");
      if (!create.runtime) throw new Error("governed create missing");
      let command = create.runtime;
      f.started(command);
      if (phase === "restart") {
        const pending = f.host.dispatch(f.root, "core.terminals.restart", {
          terminalId: create.terminalId,
        });
        const restart = await admittedMessage(f.firstRestart, pending, "governed terminal restart");
        result(await pending);
        if (!restart.create?.runtime) throw new Error("governed restart missing");
        command = restart.create.runtime;
        f.started(command);
      }
      const jobId = command.request.jobId;
      expect(f.service.jobs.get(jobId)?.state).toBe("started");
      f.replaceTransport();
      f.service.tick();
      expect(f.service.jobs.cancellation(jobId)).toBeNull();
      expect(
        f.commands.filter((entry) => entry.type === "cancel" && entry.jobId === jobId),
      ).toEqual([]);
      await admissionDrain(f, create.terminalId);
      f.service.tick();
      expect(f.service.jobs.get(jobId)?.state).toBe("started");
      expect(f.service.jobs.cancellation(jobId)).toBeNull();
      expect(
        f.commands.filter((entry) => entry.type === "cancel" && entry.jobId === jobId),
      ).toEqual([]);
      expect(f.store.getTerminal(create.terminalId)?.status).toBe("running");
      expect(await f.broker.restartById(create.terminalId, f.root.principal.id)).toBe(
        "machine_draining",
      );
    } finally {
      f.close();
    }
  },
);

test.each(["deny", "transport", "owner", "drain"] as const)(
  "pending governed birth refuses a late %s change and cleans only its owned effect",
  async (change) => {
    const f = await fixture();
    try {
      const minted = f.auth.mintTokenV2(
        {
          principal: { name: "pending opener", kind: "human" },
          scope: governedTerminalScope(f),
          containerId: f.containerId,
          expiresAt: f.runtime.now() + 60_000,
        },
        f.root,
      );
      const actor = f.auth.authenticate(minted.token);
      const pending = f.host.dispatch(actor, "core.terminals.create", {
        containerId: f.containerId,
        elementId: f.runtime.newId(),
        machineId: f.descriptor.machineId,
        placement: "tile",
        cols: 80,
        rows: 24,
        runtime: f.descriptor,
      });
      const create = await admittedMessage(f.firstCreate, pending, "pending governed create");
      if (!create.runtime) throw new Error("governed create missing");
      if (change === "deny") {
        f.auth.grant(
          {
            principal: { kind: "principal", id: actor.principal.id },
            node: `manifold://container/${f.containerId}`,
            caps: ["terminals:spawn"],
            effect: "deny",
            reach: "node",
          },
          f.root,
        );
      } else if (change === "drain") {
        await admissionDrain(f, create.terminalId);
      } else {
        if (change === "owner") {
          f.owner.generation++;
          f.owner.terminalHostId = "replacement-terminal-host";
        }
        f.replaceTransport();
      }
      f.broker.onCreated(f.descriptor.machineId, create.terminalId);
      expect((await pending).ok).toBe(false);
      expect(f.store.getTerminal(create.terminalId)).toBeNull();
      expect(
        Object.values(f.rooms.get(f.containerId)?.tileLayout() ?? {}).some(
          (tile) => tile.ref?.kind === "terminal" && tile.ref.terminalId === create.terminalId,
        ),
      ).toBe(false);
      const kills = f.sent.filter(
        (entry) => entry.type === "kill" && entry.terminalId === create.terminalId,
      );
      if (change === "owner") expect(kills).toEqual([]);
      else {
        expect(kills).toEqual([{ type: "kill", terminalId: create.terminalId }]);
        expect(f.service.jobs.cancellation(create.runtime.request.jobId)?.mode).toBe("cancel");
      }
    } finally {
      f.close();
    }
  },
);

test.each(["deny", "transport", "owner", "drain"] as const)(
  "pending governed restart refuses a late %s change without publishing success",
  async (change) => {
    const f = await fixture();
    try {
      const minted = f.auth.mintTokenV2(
        {
          principal: { name: "pending restarter", kind: "human" },
          scope: governedTerminalScope(f),
          containerId: f.containerId,
          expiresAt: f.runtime.now() + 60_000,
        },
        f.root,
      );
      const actor = f.auth.authenticate(minted.token);
      const create = await governedCreated(f, actor);
      f.holdRestartAcknowledgement();
      const pending = f.host.dispatch(actor, "core.terminals.restart", {
        terminalId: create.terminalId,
      });
      const restart = await admittedMessage(f.firstRestart, pending, "pending governed restart");
      if (!restart.create?.runtime) throw new Error("governed restart missing");
      if (change === "deny") {
        f.auth.grant(
          {
            principal: { kind: "principal", id: actor.principal.id },
            node: `manifold://container/${f.containerId}`,
            caps: ["terminals:write"],
            effect: "deny",
            reach: "node",
          },
          f.root,
        );
      } else if (change === "drain") {
        await admissionDrain(f, create.terminalId);
      } else {
        if (change === "owner") {
          f.owner.generation++;
          f.owner.terminalHostId = "replacement-terminal-host";
        }
        f.replaceTransport();
      }
      f.broker.onRestarted(f.descriptor.machineId, {
        type: "terminal_restarted",
        terminalId: create.terminalId,
      });
      expect((await pending).ok).toBe(false);
      expect(f.store.getTerminal(create.terminalId)?.status).toBe("running");
      expect(
        f.store.db.query("SELECT id FROM events WHERE type='terminal_restarted'").all(),
      ).toEqual([]);
      if (change !== "owner")
        expect(f.service.jobs.cancellation(restart.create.runtime.request.jobId)?.mode).toBe(
          "cancel",
        );
      else
        expect(
          f.sent.filter((entry) => entry.type === "kill" && entry.terminalId === create.terminalId),
        ).toEqual([]);
    } finally {
      f.close();
    }
  },
);

async function continuingGovernedRun(f: GovernedTerminalFixture, scope: AuthorityScope) {
  const minted = f.auth.mintTokenV2(
    {
      principal: { name: "terminal sponsor", kind: "human" },
      scope: scope.map((entry) => ({
        ...entry,
        caps: [...entry.caps, "agents:delegate"],
      })),
      containerId: f.containerId,
      expiresAt: f.runtime.now() + 120_000,
    },
    f.root,
  );
  const sponsor = f.auth.authenticate(minted.token);
  const registered = await f.auth.registerAgentV2(
    {
      name: "continuing native opener",
      purpose: "Retain only the sponsored composition and native operation",
      harness: "test-harness",
      context: { profile: { label: "reviewed" } },
      grant: {
        scope,
        maxRunLifetimeMs: 60_000,
        delegation: { maxDepth: 0, maxDescendants: 0 },
        expiresAt: f.runtime.now() + 120_000,
      },
    },
    sponsor,
  );
  if (registered.credential === undefined) throw new Error("fixture Agent must be new");
  const created = f.auth.createRunV2(
    {
      agentId: registered.agent.agentId,
      target: { containerId: f.containerId, machineId: f.descriptor.machineId },
      lifetimeMs: 60_000,
    },
    f.auth.authenticate(registered.credential.token),
  );
  if (created.credential === undefined) throw new Error("fixture Run must have custody");
  const issued = f.auth.authenticate(created.credential.token);
  const challenge = f.auth.agentPolicyChallenge(issued);
  f.auth.acknowledgeAgentPolicyV2(
    {
      revision: challenge.revision,
      acknowledgements: challenge.required.map(({ id, digest }) => ({ id, digest })),
    },
    issued,
  );
  const actor = f.auth.restoreCredential(f.auth.credentialReference(issued));
  if (actor === null) throw new Error("fixture Run credential must restore");
  expect(registered.agent.sponsorPrincipalId).toBe(sponsor.principal.id);
  expect(actor.agentRunId).toBe(created.run.id);
  expect(actor.containerScope).toBe(f.containerId);
  expect(actor.authorityScope).toEqual(created.run.scope);
  expect(created.run.scope).toEqual(registered.agent.grant.scope);
  return { actor, sponsor };
}

test.each(["deny", "expiry", "sponsor", "action", "installation", "owner", "consent"] as const)(
  "committed governed effects still cancel on continuing %s authority withdrawal",
  async (change) => {
    const f = await fixture();
    const action = f.host.assembly().actions.get("core.terminals.create")!.def;
    const originalInput = action.input;
    try {
      const scope = governedTerminalScope(f).map((entry) => ({
        ...entry,
        target:
          entry.target === "manifold://" ? `manifold://container/${f.containerId}` : entry.target,
      }));
      const sponsored = change === "sponsor" ? await continuingGovernedRun(f, scope) : undefined;
      const actor =
        sponsored?.actor ??
        f.auth.authenticate(
          f.auth.mintTokenV2(
            {
              principal: { name: "continuing opener", kind: "human" },
              scope,
              containerId: f.containerId,
              expiresAt: f.runtime.now() + 30_000,
            },
            f.root,
          ).token,
        );
      const create = await governedCreated(f, actor);
      if (!create.runtime) throw new Error("governed create missing");
      f.started(create.runtime);
      f.replaceTransport();
      f.service.tick();
      expect(f.service.jobs.cancellation(create.runtime.request.jobId)).toBeNull();
      switch (change) {
        case "deny":
          f.auth.grant(
            {
              principal: { kind: "principal", id: actor.principal.id },
              node: `manifold://container/${f.containerId}`,
              caps: ["terminals:spawn"],
              effect: "deny",
              reach: "node",
            },
            f.root,
          );
          break;
        case "expiry":
          f.clock.advance(30_001);
          break;
        case "sponsor":
          if (sponsored === undefined) throw new Error("fixture sponsor missing");
          f.auth.revokePrincipal(sponsored.sponsor.principal.id, f.root);
          expect(f.auth.allowsNode(actor, "terminals:spawn", scope[0]!.target)).toBe(false);
          expect(f.auth.allowsNode(actor, "machines:run", scope[1]!.target)).toBe(false);
          break;
        case "action":
          Reflect.set(action, "input", z.strictObject({}));
          break;
        case "installation":
          expect(() =>
            f.service.install(f.root, {
              machineId: f.descriptor.machineId,
              pluginId,
              installationRevision: "r2",
              artifactSha256: hash,
              machine,
            }),
          ).toThrow("active_installation");
          f.service.tick();
          expect(f.service.jobs.get(create.runtime.request.jobId)?.state).toBe("started");
          expect(f.service.jobs.cancellation(create.runtime.request.jobId)).toBeNull();
          expect(f.service.jobs.installation(f.descriptor.machineId, pluginId)).toMatchObject({
            revision: "r1",
            artifact: hash,
            enabled: true,
          });
          expect(
            f.commands.filter(
              (entry) => entry.type === "install" && entry.installationRevision === "r2",
            ),
          ).toEqual([]);
          result(
            await f.host.dispatch(f.root, "engine.plugins.setEnabled", {
              id: pluginId,
              enabled: false,
            }),
          );
          expect(f.service.jobs.installation(f.descriptor.machineId, pluginId)).toMatchObject({
            revision: "r1",
            artifact: hash,
            enabled: false,
          });
          expect(f.commands).toContainEqual(
            expect.objectContaining({
              type: "install",
              action: "disable",
              pluginId,
              installationRevision: "r1",
              artifactSha256: hash,
            }),
          );
          expect(f.service.jobs.cancellation(create.runtime.request.jobId)).toEqual({
            mode: "cancel",
            reason: "plugin_disabled",
          });
          expect(
            (
              await f.host.dispatch(actor, "core.terminals.create", {
                containerId: f.containerId,
                elementId: f.runtime.newId(),
                machineId: f.descriptor.machineId,
                placement: "tile",
                cols: 80,
                rows: 24,
                runtime: f.descriptor,
              })
            ).ok,
          ).toBe(false);
          expect(f.sent.filter((entry) => entry.type === "create")).toEqual([create]);
          break;
        case "owner":
          f.owner.terminalHostId = "replacement-terminal-host";
          f.replaceTransport();
          break;
        case "consent":
          f.service.consent(f.root, {
            machineId: f.descriptor.machineId,
            pluginId,
            installationRevision: "r1",
            artifactSha256: hash,
            node: `manifold://machine/${f.descriptor.machineId}/operation/${operationId}`,
            cap: "machines:run",
            enabled: false,
          });
          break;
      }
      f.service.tick();
      expect(f.service.jobs.cancellation(create.runtime.request.jobId)?.mode).toBe("cancel");
      if (change !== "owner")
        expect(
          f.commands.some(
            (entry) => entry.type === "cancel" && entry.jobId === create.runtime!.request.jobId,
          ),
        ).toBe(true);
    } finally {
      Reflect.set(action, "input", originalInput);
      f.close();
    }
  },
);

test.each(["fresh", "recovered"] as const)(
  "%s governed terminal cancels only its bound effect when source-input consent is withdrawn",
  async (recovery) => {
    const dir = mkdtempSync(join(tmpdir(), "manifold-native-source-consent-"));
    const path = join(dir, "manifold.db");
    const producerId = `${pluginId}.produce`;
    const locationId = `${pluginId}.sealed`;
    const producing: MachineHalf = {
      ...machine,
      locations: {
        [locationId]: {
          anchor: "runtime",
          components: ["sealed"],
          revision: "1",
          kind: "directory",
        },
      },
      operations: {
        ...machine.operations,
        [producerId]: {
          ...machine.operations[operationId]!,
          stdin: false,
          locations: [{ locationId, access: "write" }],
          outputs: ["material"],
        },
      },
    };
    const f = await fixture(undefined, ["material"], path, undefined, producing);
    let closed = false;
    let recoveredStore: ServerStore | undefined;
    let recoveredHost: PluginHost | undefined;
    try {
      const machineId = f.descriptor.machineId;
      for (const [node, cap] of [
        [`manifold://machine/${machineId}/operation/${producerId}`, "machines:run"],
        [`manifold://machine/${machineId}/operation/${producerId}`, "jobs:read"],
        [`manifold://machine/${machineId}/location/${locationId}`, "locations:write"],
      ] as const)
        f.service.consent(f.root, {
          machineId,
          pluginId,
          installationRevision: "r1",
          artifactSha256: hash,
          node,
          cap,
          enabled: true,
        });
      const producer = f.service.execute(f.root, pluginId, "trace-produce", {
        jobId: "producer",
        machineId,
        operationId: producerId,
        input: { mode: "produce" },
        outputs: [{ name: "material", locationId, components: ["material"] }],
      });
      f.service.event(f.channel(), {
        type: "result",
        result: {
          jobId: producer.request.jobId,
          requestDigest: producer.request.requestDigest,
          ownerId: f.owner.ownerId,
          ownerGeneration: f.owner.generation,
          state: "exited",
          exitCode: 0,
          reason: null,
          startedAt: 0,
          finishedAt: f.runtime.now(),
          usage: { elapsedMs: 1, memoryBytes: 1, processes: 1, outputBytes: 2048 },
          limits: producer.request.limits,
          outputs: [
            { outputId: "sealed-material", name: "material", sha256: hash, bytes: 2048, files: 1 },
          ],
        },
      });
      f.descriptor.inputs = [
        { name: "material", from: { jobId: producer.request.jobId, output: "material" } },
      ];
      const scope: AuthorityScope = [
        ...governedTerminalScope(f).map((entry) => ({
          ...entry,
          target:
            entry.target === "manifold://" ? `manifold://container/${f.containerId}` : entry.target,
        })),
        {
          target: `manifold://machine/${machineId}/operation/${producerId}/job/${producer.request.jobId}`,
          reach: "node",
          caps: ["jobs:read"],
        },
      ];
      const actor = f.auth.authenticate(
        f.auth.mintTokenV2(
          {
            principal: { name: "bound-input opener", kind: "human" },
            scope,
            containerId: f.containerId,
            expiresAt: f.runtime.now() + 60_000,
          },
          f.root,
        ).token,
      );
      const create = await governedCreated(f, actor);
      if (!create.runtime) throw new Error("bound-input terminal missing native admission");
      f.started(create.runtime);
      const boundId = create.runtime.request.jobId;
      const unrelated = f.service.execute(f.root, pluginId, "trace-unrelated", {
        jobId: "unrelated",
        machineId,
        operationId,
        input: { mode: "independent" },
        outputs: [],
      });
      const unrelatedStart = f.commands.findLast(
        (command) => command.type === "start" && command.request.jobId === unrelated.request.jobId,
      );
      if (unrelatedStart?.type !== "start") throw new Error("unrelated effect not admitted");
      f.started(unrelatedStart);
      const signedRequest = create.runtime.request;
      let service = f.service;
      let root = f.root;
      let store = f.store;
      service.offline(f.channel());
      if (recovery === "recovered") {
        f.close();
        closed = true;
        recoveredStore = new ServerStore(openDatabase(path));
        store = recoveredStore;
        const auth = new AuthService(store, "a".repeat(64), f.runtime, {
          decide: (request) => service.decide(request),
        });
        root = auth.authenticate("a".repeat(64));
        const rooms = new RoomManager(store, f.runtime, f.clock, silentLogger, testTileTrees);
        const broker = new TerminalBroker(
          store,
          auth,
          rooms,
          f.runtime,
          f.clock,
          silentLogger,
          () => "http://localhost:7777",
          testTileTrees,
        );
        recoveredHost = await testPluginHost(store, auth, rooms, broker, f.runtime, {
          settingsPlugins: [f.definition],
        });
        service = new JobService(store, auth, f.runtime);
        recoveredHost.setJobs(service);
        broker.setJobs(service);
      }
      service.tick();
      expect(service.jobs.get(boundId)?.request).toEqual(signedRequest);
      expect(service.jobs.get(boundId)?.state).toBe("started");
      expect(service.jobs.cancellation(boundId)).toBeNull();
      expect(service.jobs.get(unrelated.request.jobId)?.state).toBe("started");
      expect(service.jobs.cancellation(unrelated.request.jobId)).toBeNull();
      // Loss of transport/readiness is not withdrawal of an acknowledged owner's authority.
      expect(store.getTerminal(create.terminalId)?.status).toBe("running");
      service.consent(root, {
        machineId,
        pluginId,
        installationRevision: "r1",
        artifactSha256: hash,
        node: `manifold://machine/${machineId}/operation/${producerId}`,
        cap: "jobs:read",
        enabled: false,
      });
      service.tick();
      expect(service.jobs.cancellation(boundId)?.mode).toBe("cancel");
      expect(service.jobs.cancellation(unrelated.request.jobId)).toBeNull();
      expect(service.jobs.get(unrelated.request.jobId)?.state).toBe("started");
      expect(service.jobs.cancellation(producer.request.jobId)).toBeNull();
      expect(service.jobs.get(producer.request.jobId)?.result?.outputs).toEqual([
        { outputId: "sealed-material", name: "material", sha256: hash, bytes: 2048, files: 1 },
      ]);
      f.proveOwner(service);
      expect(
        new Set(
          f.commands.filter((command) => command.type === "cancel").map((command) => command.jobId),
        ),
      ).toEqual(new Set([boundId]));
      expect(f.sent.filter((message) => message.type === "kill")).toEqual([]);
      expect(f.sent.filter((message) => message.type === "create")).toEqual([create]);
    } finally {
      recoveredHost?.close();
      recoveredStore?.close();
      if (!closed) f.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
