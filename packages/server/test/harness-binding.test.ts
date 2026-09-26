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
  type AgentRun,
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
import type { ActionCtx, ServerPluginDef } from "../src/plugin-host.ts";
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

async function fixture(
  dependency?: ServerPluginDef,
  inputs?: string[],
  databasePath?: string,
  profileSchema: z.ZodType = z.strictObject({ label: z.string().min(1) }),
) {
  const declaredMachine: MachineHalf =
    inputs === undefined
      ? machine
      : {
          ...machine,
          operations: { [operationId]: { ...machine.operations[operationId]!, inputs } },
        };
  const runtime = new FakeRuntime();
  const clock = new FakeClock(runtime);
  const store =
    databasePath === undefined ? testStore() : new ServerStore(openDatabase(databasePath));
  const auth = new AuthService(store, "a".repeat(64), runtime);
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
  const launches: { run: AgentRun; target: HarnessTarget }[] = [];
  const definition: ServerPluginDef = {
    manifest: {
      id: pluginId,
      version: "1.0.0",
      title: "Test harness",
      description: "Binding boundary fixture",
      capabilities: ["machines:run", "jobs:read", "jobs:input"],
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
  const service = new JobService(store, auth, runtime);
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
  const channel = {
    machineId,
    protocolVersion: PROTOCOL_VERSION,
    terminalRestart: true,
    terminalHostId: "terminal-host",
    terminalExecution: "governed" as const,
    send(message: ServerToAgentMessage) {
      sent.push(message);
      if (message.type === "job_command") commands.push(message.command);
      if (message.type === "terminal_restart")
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
  const connect = (protocolVersion: number, ownerProtocolVersion: number) => {
    channel.protocolVersion = protocolVersion;
    const advertised = { ...owner, protocolVersion: ownerProtocolVersion };
    service.online(channel, advertised, "epoch");
    if (JOB_OWNER_PROTOCOL_COMPAT_VERSIONS.has(ownerProtocolVersion)) {
      const challenge = commands.at(-1);
      if (challenge?.type !== "owner_challenge") throw new Error("owner challenge missing");
      const proof = {
        nonce: challenge.nonce,
        serverEpoch: challenge.serverEpoch,
        machineId,
        owner: advertised,
      };
      service.event(channel, {
        type: "owner_proof",
        ...proof,
        signature: sign(null, Buffer.from(canonicalJobJson(proof)), pair.privateKey).toString(
          "base64",
        ),
      });
      service.event(channel, {
        type: "installed",
        pluginId,
        installationRevision: "r1",
        artifactSha256: hash,
      });
    }
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
    const peer = new SessionChannel(runtime.newId(), socket, actor, containerId, "c1");
    const request = {
      elementId: runtime.newId(),
      machineId,
      placement: "tile" as const,
      runtime: value,
    };
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
        store.getTerminal(candidate.ref.terminalId) === null,
    );
    if (tile?.dir !== null || tile.ref?.kind !== "terminal")
      throw new Error("pending terminal tile missing");
    broker.resize(peer, {
      type: "terminal_resize",
      terminalId: tile.ref.terminalId,
      cols: 80,
      rows: 24,
    });
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
    connect,
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
    await f.open({
      ...f.descriptor,
      installationRevision: "stale",
      session: { ...session, machineId: f.descriptor.machineId },
    });
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
    await f.open(a.runtime, f.auth.authenticate(other.token));
    await f.open({ ...a.runtime, input: { changed: true } });
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
    await f.open(unavailable.runtime);
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
    f.descriptor.inputs = [
      { name: "material", from: { jobId: "missing-producer", output: "material" } },
    ];
    const refused = await f.host.dispatch(f.root, "core.terminals.restart", {
      terminalId: create.terminalId,
    });
    expect(refused.ok).toBe(false);
    expect(f.sent.filter((message) => message.type === "terminal_restart")).toEqual([]);
    expect(f.store.getTerminal(create.terminalId)).toEqual(before);
    // A new harness launch may review a different descriptor; an old recipe does
    // not authorize a missing source, and a refusal does not strand the terminal.
    delete f.descriptor.inputs;
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
    const publicState = JSON.stringify([
      outcome,
      f.store.listTerminals(),
      f.store.db.query("SELECT payload FROM events").all(),
      replacement.request,
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
    await entered.promise;
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
      await entered.promise;
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
      await entered.promise;
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
