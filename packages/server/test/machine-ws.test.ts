import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  DIAL_PING_INTERVAL_MS,
  JOB_OWNER_PROTOCOL_VERSION,
  MAX_JOB_INSTALL_FRAME_BYTES,
  MAX_SESSION_FRAME_BYTES,
  PROTOCOL_VERSION,
  ServerToAgentMessageSchema,
  canonicalJobJson,
  type JobOwner,
  type Container,
  type ServerToAgentMessage,
} from "@manifold/protocol";
import { AuthService } from "../src/auth.ts";
import { JobService } from "../src/job-service.ts";
import { silentLogger, type Logger } from "../src/log.ts";
import { LiveMachineChannel, MachineGateway, decideAdmission } from "../src/machine-ws.ts";
import { RoomManager } from "../src/room.ts";
import type { RawSocket } from "../src/session-channel.ts";
import { TerminalBroker } from "../src/terminal-broker.ts";
import { FakeClock, FakeRuntime, FakeSocket, testStore, testTileTrees } from "./helpers.ts";

class StatusSocket implements RawSocket {
  bufferedAmount = 0;
  readonly sent: string[] = [];
  closed: { code: number | undefined; reason: string | undefined } | null = null;

  constructor(private readonly status: number) {}

  send(data: string): number {
    this.sent.push(data);
    return this.status;
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }
}

function machineMessages(socket: FakeSocket): ServerToAgentMessage[] {
  return socket.sent.map((frame) => ServerToAgentMessageSchema.parse(JSON.parse(frame)));
}

class CaptureLogger implements Logger {
  readonly events: { evt: string; fields: Readonly<Record<string, unknown>> | undefined }[] = [];
  readonly warnings: { evt: string; fields: Readonly<Record<string, unknown>> | undefined }[] = [];

  info(evt: string, fields?: Readonly<Record<string, unknown>>): void {
    this.events.push({ evt, fields });
  }

  warn(evt: string, fields?: Readonly<Record<string, unknown>>): void {
    this.warnings.push({ evt, fields });
  }

  error(): void {}
}

describe("machine channel send status", () => {
  test("-1 is accepted as enqueued backpressure", () => {
    const socket = new StatusSocket(-1);
    const channel = new LiveMachineChannel(
      "machine",
      "principal",
      socket,
      null,
      null,
      PROTOCOL_VERSION,
    );

    expect(channel.send({ type: "kill", terminalId: "terminal" })).toBe(true);
    expect(socket.closed).toBeNull();
  });

  test("0 is reported as a dropped frame", () => {
    const socket = new StatusSocket(0);
    const channel = new LiveMachineChannel(
      "machine",
      "principal",
      socket,
      null,
      null,
      PROTOCOL_VERSION,
    );

    expect(channel.send({ type: "kill", terminalId: "terminal" })).toBe(false);
  });

  test("bundled worker frames cross the former 1 MiB ceiling without making queues unbounded", () => {
    const socket = new StatusSocket(-1);
    const channel = new LiveMachineChannel(
      "machine",
      "principal",
      socket,
      null,
      null,
      PROTOCOL_VERSION,
    );
    const bytes = Buffer.alloc(2 * 1024 * 1024, 0x80);
    const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    expect(
      channel.send({
        type: "job_command",
        command: {
          type: "install",
          pluginId: "fixture.worker",
          installationRevision: "r1",
          artifactSha256: sha256,
          artifact: { bundleFile: "worker", data: bytes.toString("base64") },
          machine: {
            artifacts: {
              "linux-x64": {
                bundleFile: "worker",
                sha256,
                entrySha256: sha256,
                format: "raw",
                entry: ["worker"],
                maxBytes: bytes.length,
                maxExpandedBytes: bytes.length,
                maxMembers: 1,
              },
            },
            locations: {},
            operations: {
              "fixture.worker.run": {
                argv: [],
                input: {},
                runtimeTools: [],
                locations: [],
                outputs: [],
                network: "none",
                stdin: false,
                limits: { timeoutMs: 1000, memoryBytes: 1048576, processes: 1, outputBytes: 4096 },
              },
            },
          },
        },
      }),
    ).toBe(true);
    socket.bufferedAmount = Buffer.byteLength(socket.sent[0]!);
    expect(channel.send({ type: "kill", terminalId: "terminal" })).toBe(true);
    expect(socket.closed).toBeNull();
    socket.bufferedAmount = 2 * MAX_JOB_INSTALL_FRAME_BYTES;
    expect(channel.send({ type: "kill", terminalId: "terminal" })).toBe(false);
    expect(socket.closed?.code).toBe(1013);

    const ordinary = new StatusSocket(-1);
    const terminalChannel = new LiveMachineChannel(
      "ordinary",
      "principal",
      ordinary,
      null,
      null,
      PROTOCOL_VERSION,
    );
    ordinary.bufferedAmount = MAX_SESSION_FRAME_BYTES;
    expect(terminalChannel.send({ type: "kill", terminalId: "terminal" })).toBe(false);
    expect(ordinary.closed?.code).toBe(1013);
  });
});

describe("machine hello reconciliation", () => {
  test("an empty inventory on a vacant seat retains the missing terminal until dismissal", () => {
    const runtime = new FakeRuntime();
    const clock = new FakeClock(runtime);
    const store = testStore();
    const auth = new AuthService(store, "c".repeat(64), runtime);
    const root = auth.authenticate("c".repeat(64));
    // A terminal's `containerId` names the composition it LIVES in, and only a composition
    // can home a terminal, so the durable fixture row needs a composition container.
    const container: Container = {
      id: runtime.newId(),
      name: "hello composition",
      createdAt: runtime.now(),
      discipline: "composition",
    };
    store.createContainer(container);
    const enrollment = auth.enrollMachine("agent", root);
    const sessionGrant = auth.mintSessionAgentToken(
      "missing-terminal",
      container.id,
      root.principal.id,
    );
    store.createTerminal({
      id: "missing-terminal",
      machineId: enrollment.machine.id,
      containerId: container.id,
      createdBy: root.principal.id,
      agentPrincipalId: sessionGrant.principal.id,
      createdAt: runtime.now(),
    });
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
    rooms.setTerminalProvider((containerId) => broker.listForContainer(containerId));
    rooms.setPendingOpenProvider((containerId) => broker.hasPendingOpenForContainer(containerId));
    const gateway = new MachineGateway(
      auth,
      store,
      broker,
      clock,
      silentLogger,
      "server-epoch",
      runtime,
    );
    const socket = new FakeSocket();
    gateway.open("connection", socket);

    gateway.message(
      "connection",
      JSON.stringify({
        type: "hello",
        token: enrollment.machineToken,
        name: "agent",
        agentVersion: "test",
        protocolVersion: PROTOCOL_VERSION,
        terminals: [],
      }),
    );

    expect(socket.closed).toBeNull();
    expect(gateway.isOnline(enrollment.machine.id)).toBe(true);
    expect(machineMessages(socket)).toMatchObject([{ type: "welcome" }]);
    expect(store.getTerminal("missing-terminal")).toMatchObject({
      status: "exited",
      exitCode: null,
    });
    expect(broker.listForContainer(container.id)[0]?.status).toBe("exited");
    expect(() => auth.authenticate(sessionGrant.token)).toThrow();
    expect(broker.killById("missing-terminal")).toBe("ok");
    expect(store.getTerminal("missing-terminal")).toBeNull();
    const retry = new FakeSocket();
    gateway.open("retry", retry);
    gateway.message(
      "retry",
      JSON.stringify({
        type: "hello",
        token: enrollment.machineToken,
        name: "agent",
        agentVersion: "test",
        protocolVersion: PROTOCOL_VERSION,
        terminals: [],
      }),
    );
    expect(retry.closed).toBeNull();
    expect(machineMessages(retry).map((message) => message.type)).toEqual(["welcome"]);
    expect(store.getMachine(enrollment.machine.id)?.lastRefusal).toBeNull();
    gateway.shutdown();
    store.close();
  });

  test("an advertised terminal that cannot be adopted is killed", () => {
    const runtime = new FakeRuntime();
    const clock = new FakeClock(runtime);
    const store = testStore();
    const auth = new AuthService(store, "d".repeat(64), runtime);
    const root = auth.authenticate("d".repeat(64));
    const enrollment = auth.enrollMachine("agent", root);
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
    const gateway = new MachineGateway(
      auth,
      store,
      broker,
      clock,
      silentLogger,
      "server-epoch",
      runtime,
    );
    const socket = new FakeSocket();
    gateway.open("connection", socket);

    gateway.message(
      "connection",
      JSON.stringify({
        type: "hello",
        token: enrollment.machineToken,
        name: "agent",
        agentVersion: "test",
        protocolVersion: PROTOCOL_VERSION,
        terminals: [{ terminalId: "unknown", cols: 80, rows: 24, alive: true, seq: 0 }],
      }),
    );

    expect(machineMessages(socket).map((message) => message.type)).toEqual(["welcome", "kill"]);
    gateway.shutdown();
    store.close();
  });

  test("a pre-reset hello is refused, so its durable terminal is neither adopted nor reaped", () => {
    // Refusal is decided at NEGOTIATION, ahead of reconciliation, which is what leaves the
    // advertised PTY's durable row untouched: the machine is expected to come back speaking a
    // version in the set and be reconciled then.
    const runtime = new FakeRuntime();
    const clock = new FakeClock(runtime);
    const store = testStore();
    const auth = new AuthService(store, "f".repeat(64), runtime);
    const root = auth.authenticate("f".repeat(64));
    const container: Container = {
      id: runtime.newId(),
      name: "pre-reset composition",
      createdAt: runtime.now(),
      discipline: "composition",
    };
    store.createContainer(container);
    const enrollment = auth.enrollMachine("agent", root);
    const sessionGrant = auth.mintSessionAgentToken(
      "pre-reset-terminal",
      container.id,
      root.principal.id,
    );
    store.createTerminal({
      id: "pre-reset-terminal",
      machineId: enrollment.machine.id,
      containerId: container.id,
      createdBy: root.principal.id,
      agentPrincipalId: sessionGrant.principal.id,
      createdAt: runtime.now(),
    });
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
    rooms.setTerminalProvider((containerId) => broker.listForContainer(containerId));
    rooms.setPendingOpenProvider((containerId) => broker.hasPendingOpenForContainer(containerId));
    const gateway = new MachineGateway(
      auth,
      store,
      broker,
      clock,
      silentLogger,
      "server-epoch",
      runtime,
    );
    const socket = new FakeSocket();
    gateway.open("connection", socket);

    gateway.message(
      "connection",
      JSON.stringify({
        type: "hello",
        token: enrollment.machineToken,
        name: "agent",
        agentVersion: "test-pre-reset",
        protocolVersion: 29,
        terminals: [
          { terminalId: "pre-reset-terminal", cols: 120, rows: 40, alive: true, seq: 42 },
        ],
      }),
    );

    // Not welcomed, and not killed either: a refused channel gets no frames at all.
    expect(socket.closed?.code).toBe(4409);
    expect(machineMessages(socket)).toEqual([]);
    // Neither half of reconciliation ran. The row is listed because it is DURABLE, but it is
    // listed exactly as the store held it: the advertised 120x40 never became live geometry,
    // and no absence marked the row exited.
    const listed = broker.listForContainer(container.id);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe("pre-reset-terminal");
    expect({ cols: listed[0]?.cols, rows: listed[0]?.rows }).toEqual({ cols: 80, rows: 24 });
    expect(store.getTerminal("pre-reset-terminal")?.status).toBe("running");
    gateway.shutdown();
    store.close();
  });

  test("rejects a newer-than-hub protocol version with 4409 and a structured log", () => {
    const runtime = new FakeRuntime();
    const clock = new FakeClock(runtime);
    const store = testStore();
    const auth = new AuthService(store, "a".repeat(64), runtime);
    const root = auth.authenticate("a".repeat(64));
    const enrollment = auth.enrollMachine("agent", root);
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
    const warned: Array<{ evt: string; fields: Record<string, unknown> | undefined }> = [];
    const logger: Logger = {
      info: () => {},
      warn: (evt, fields) => warned.push({ evt, fields }),
      error: () => {},
    };
    const gateway = new MachineGateway(auth, store, broker, clock, logger, "server-epoch", runtime);
    const socket = new FakeSocket();
    gateway.open("connection", socket);

    const unknown = new FakeSocket();
    gateway.open("unknown", unknown);
    gateway.message(
      "unknown",
      JSON.stringify({
        type: "hello",
        token: "not-an-enrolled-token",
        name: "unknown",
        agentVersion: "test-newer",
        protocolVersion: PROTOCOL_VERSION + 1,
        terminals: [],
      }),
    );
    expect(unknown.closed?.code).toBe(4409);
    expect(store.getMachine(enrollment.machine.id)?.lastRefusal).toBeNull();

    gateway.message(
      "connection",
      JSON.stringify({
        type: "hello",
        token: enrollment.machineToken,
        name: "agent",
        agentVersion: "test-newer",
        protocolVersion: PROTOCOL_VERSION + 1,
        terminals: [],
      }),
    );

    expect(socket.closed?.code).toBe(4409);
    expect(machineMessages(socket)).toEqual([]);
    const rejected = warned.find((w) => w.evt === "machine_version_rejected");
    expect(rejected?.fields?.agentProtocolVersion).toBe(PROTOCOL_VERSION + 1);
    expect(rejected?.fields?.serverProtocolVersion).toBe(PROTOCOL_VERSION);
    expect(store.getMachine(enrollment.machine.id)?.lastRefusal).toEqual({
      code: 4409,
      at: runtime.now(),
    });
    gateway.shutdown();
    store.close();
  });

  test("refuses a duplicate reported name without mutating either machine", () => {
    const runtime = new FakeRuntime();
    const clock = new FakeClock(runtime);
    const store = testStore();
    const auth = new AuthService(store, "n".repeat(64), runtime);
    const root = auth.authenticate("n".repeat(64));
    const incumbent = auth.enrollMachine("incumbent", root);
    const claimant = auth.enrollMachine("claimant", root);
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
    const logger = new CaptureLogger();
    const gateway = new MachineGateway(auth, store, broker, clock, logger, "server-epoch", runtime);
    const hello = (token: string, name: string) =>
      JSON.stringify({
        type: "hello",
        token,
        name,
        agentVersion: "test",
        protocolVersion: PROTOCOL_VERSION,
        terminals: [],
      });

    const incumbentSocket = new FakeSocket();
    gateway.open("incumbent", incumbentSocket);
    gateway.message("incumbent", hello(incumbent.machineToken, "shared-name"));
    const incumbentBefore = store.getMachine(incumbent.machine.id);
    const claimantBefore = store.getMachine(claimant.machine.id);
    if (claimantBefore === null) throw new Error("claimant machine missing");

    const claimantSocket = new FakeSocket();
    gateway.open("claimant", claimantSocket);
    gateway.message("claimant", hello(claimant.machineToken, "shared-name"));

    expect(claimantSocket.closed).toEqual({
      code: 4003,
      reason: "machine name already in use",
    });
    expect(machineMessages(claimantSocket)).toEqual([]);
    expect(store.getMachine(claimant.machine.id)).toEqual({
      ...claimantBefore,
      lastRefusal: { code: 4003, at: runtime.now() },
    });
    expect(store.getMachine(incumbent.machine.id)).toEqual(incumbentBefore);
    expect(gateway.isOnline(incumbent.machine.id)).toBe(true);
    expect(incumbentSocket.closed).toBeNull();
    expect(logger.warnings).toContainEqual({
      evt: "machine_name_conflict",
      fields: { machineId: claimant.machine.id, machineName: "shared-name" },
    });

    clock.advance(10_000);
    expect(claimantSocket.closed).toEqual({
      code: 4003,
      reason: "machine name already in use",
    });
    expect(logger.warnings.map((entry) => entry.evt)).not.toContain("machine_hello_timeout");
    gateway.shutdown();
    store.close();
  });

  test("damps repeated machine supersession while preserving the active fence", () => {
    const runtime = new FakeRuntime();
    const clock = new FakeClock(runtime);
    const store = testStore();
    const auth = new AuthService(store, "e".repeat(64), runtime);
    const root = auth.authenticate("e".repeat(64));
    const enrollment = auth.enrollMachine("agent", root);
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
    const logger = new CaptureLogger();
    const gateway = new MachineGateway(auth, store, broker, clock, logger, "server-epoch", runtime);
    const hello = JSON.stringify({
      type: "hello",
      token: enrollment.machineToken,
      name: "agent",
      agentVersion: "test",
      protocolVersion: PROTOCOL_VERSION,
      terminals: [],
    });
    const first = new FakeSocket();
    gateway.open("first", first);
    gateway.message("first", hello);
    const second = new FakeSocket();
    gateway.open("second", second);
    gateway.message("second", hello);

    expect(first.closed).toEqual({ code: 4001, reason: "superseded" });
    expect(logger.events).toEqual([
      {
        evt: "machine_superseded",
        fields: { machineId: enrollment.machine.id },
      },
    ]);

    const immediate = new FakeSocket();
    gateway.open("immediate", immediate);
    gateway.message("immediate", hello);

    expect(immediate.closed).toEqual({ code: 4003, reason: "supersession damped" });
    expect(second.closed).toBeNull();
    expect(machineMessages(immediate)).toEqual([]);

    clock.advance(5_000);
    const afterDamp = new FakeSocket();
    gateway.open("after-damp", afterDamp);
    gateway.message("after-damp", hello);

    expect(second.closed).toEqual({ code: 4001, reason: "superseded" });
    expect(afterDamp.closed).toBeNull();
    expect(logger.events).toEqual([
      {
        evt: "machine_superseded",
        fields: { machineId: enrollment.machine.id },
      },
      {
        evt: "machine_superseded",
        fields: { machineId: enrollment.machine.id },
      },
    ]);
    gateway.shutdown();
    store.close();
  });
});

describe("machine liveness heartbeat", () => {
  function fixture(ownerKey: string) {
    const runtime = new FakeRuntime();
    const clock = new FakeClock(runtime);
    const store = testStore();
    const auth = new AuthService(store, ownerKey, runtime);
    const root = auth.authenticate(ownerKey);
    const enrollment = auth.enrollMachine("agent", root);
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
    const gateway = new MachineGateway(
      auth,
      store,
      broker,
      clock,
      silentLogger,
      "server-epoch",
      runtime,
    );
    const socket = new FakeSocket();
    gateway.open("connection", socket);
    gateway.message(
      "connection",
      JSON.stringify({
        type: "hello",
        token: enrollment.machineToken,
        name: "agent",
        agentVersion: "test",
        protocolVersion: PROTOCOL_VERSION,
        terminals: [],
      }),
    );
    return { clock, store, gateway, socket, machineId: enrollment.machine.id };
  }

  test("a ponging machine stays online across many intervals", () => {
    const value = fixture("1".repeat(64));

    for (let round = 0; round < 3; round++) {
      value.clock.advance(DIAL_PING_INTERVAL_MS);
      const pings = machineMessages(value.socket).filter((m) => m.type === "ping");
      expect(pings).toHaveLength(round + 1);
      value.gateway.message("connection", JSON.stringify({ type: "pong" }));
    }

    expect(value.socket.closed).toBeNull();
    expect(value.gateway.isOnline(value.machineId)).toBe(true);
    value.gateway.shutdown();
    value.store.close();
  });

  test("an unanswered ping closes the socket within two intervals", () => {
    const value = fixture("2".repeat(64));

    value.clock.advance(DIAL_PING_INTERVAL_MS); // ping sent
    expect(value.socket.closed).toBeNull();
    value.clock.advance(DIAL_PING_INTERVAL_MS); // still unanswered -> close

    expect(value.socket.closed?.code).toBe(4008);
    expect(value.socket.closed?.reason).toBe("liveness timeout");
    // The transport close event then reaches the gateway, taking the machine offline.
    value.gateway.close("connection");
    expect(value.gateway.isOnline(value.machineId)).toBe(false);
    value.gateway.shutdown();
    value.store.close();
  });

  test("closing a connection disarms its ping timer", () => {
    const value = fixture("3".repeat(64));

    expect(value.clock.pendingJobs).toBeGreaterThan(0);
    value.gateway.close("connection");
    expect(value.clock.pendingJobs).toBe(0);
    value.gateway.shutdown();
    value.store.close();
  });
});

/**
 * ADMISSION (#278). A machine token authenticates a machine; it does not prove the process
 * presenting it owns the machine's PTYs. These cases pin the verdict table — who supersedes
 * whom, what is believed — and the one property the incident demands: there is no path from
 * an empty same-token newcomer to a destroyed terminal.
 */
describe("machine admission and terminal continuity", () => {
  function fixture(
    ownerKey: string,
    runningTerminals: readonly string[],
    ownerHostId: string | null = null,
  ) {
    const runtime = new FakeRuntime();
    const clock = new FakeClock(runtime);
    const store = testStore();
    const auth = new AuthService(store, ownerKey, runtime);
    const root = auth.authenticate(ownerKey);
    const container: Container = {
      id: runtime.newId(),
      name: "continuity composition",
      createdAt: runtime.now(),
      discipline: "composition",
    };
    store.createContainer(container);
    const enrollment = auth.enrollMachine("agent", root);
    if (ownerHostId !== null) {
      store.touchMachine(enrollment.machine.id, "agent", runtime.now(), ownerHostId);
    }
    const terminalTokens = new Map<string, string>();
    for (const terminalId of runningTerminals) {
      const grant = auth.mintSessionAgentToken(terminalId, container.id, root.principal.id);
      terminalTokens.set(terminalId, grant.token);
      store.createTerminal({
        id: terminalId,
        machineId: enrollment.machine.id,
        containerId: container.id,
        createdBy: root.principal.id,
        agentPrincipalId: grant.principal.id,
        createdAt: runtime.now(),
      });
    }
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
    rooms.setTerminalProvider((containerId) => broker.listForContainer(containerId));
    rooms.setPendingOpenProvider((containerId) => broker.hasPendingOpenForContainer(containerId));
    const logger = new CaptureLogger();
    const gateway = new MachineGateway(auth, store, broker, clock, logger, "server-epoch", runtime);
    const hello = (
      id: string,
      options: {
        terminalHostId?: string;
        protocolVersion?: number;
        jobOwner?: JobOwner;
        alive?: readonly string[];
        exited?: readonly string[];
      } = {},
    ): FakeSocket => {
      const socket = new FakeSocket();
      gateway.open(id, socket);
      gateway.message(
        id,
        JSON.stringify({
          type: "hello",
          token: enrollment.machineToken,
          name: "agent",
          agentVersion: "test",
          protocolVersion: options.protocolVersion ?? PROTOCOL_VERSION,
          terminals: [
            ...(options.alive ?? []).map((terminalId) => ({
              terminalId,
              cols: 80,
              rows: 24,
              alive: true,
              seq: 0,
            })),
            ...(options.exited ?? []).map((terminalId) => ({
              terminalId,
              cols: 80,
              rows: 24,
              alive: false,
              seq: 0,
              exitCode: 0,
            })),
          ],
          ...(options.terminalHostId === undefined
            ? {}
            : { terminalHostId: options.terminalHostId }),
          ...(options.jobOwner === undefined ? {} : { jobOwner: options.jobOwner }),
        }),
      );
      return socket;
    };
    const status = (terminalId: string) => store.getTerminal(terminalId)?.status ?? "gone";
    return {
      clock,
      store,
      auth,
      root,
      terminalTokens,
      rooms,
      runtime,
      broker,
      gateway,
      logger,
      machineId: enrollment.machine.id,
      hello,
      status,
    };
  }

  test("owner refusal diagnostics survive absent job authority without exposing free text", () => {
    const fix = fixture("d".repeat(64), []);
    fix.gateway.setJobs(new JobService(fix.store, fix.auth, fix.runtime));
    fix.hello("refusal-source");
    try {
      for (const event of [
        { type: "refusal", jobId: "job-123", reason: "resource_bindings_mismatch" },
        { type: "refusal", jobId: "private /path", reason: "Bearer private-value" },
      ]) {
        fix.gateway.message("refusal-source", JSON.stringify({ type: "job_event", event }));
      }
      expect(fix.logger.warnings.filter((row) => row.evt === "machine_job_refusal")).toEqual([
        {
          evt: "machine_job_refusal",
          fields: {
            machineId: fix.machineId,
            jobId: "job-123",
            reason: "resource_bindings_mismatch",
          },
        },
        {
          evt: "machine_job_refusal",
          fields: { machineId: fix.machineId, jobId: "[redacted]", reason: "[redacted]" },
        },
      ]);
    } finally {
      fix.gateway.shutdown();
      fix.store.close();
    }
  });

  test("pre-cutover transports cannot advertise ownership or adopt durable terminals", () => {
    const fix = fixture("9".repeat(64), ["t1"]);
    const jobs = new JobService(fix.store, fix.auth, fix.runtime);
    fix.gateway.setJobs(jobs);
    const socket = fix.hello("pre-job-owner", {
      protocolVersion: 29,
      alive: ["t1"],
      jobOwner: {
        protocolVersion: JOB_OWNER_PROTOCOL_VERSION,
        ownerId: "job-owner",
        publicKey: "untrusted-owner-key",
        generation: 1,
        platforms: ["linux-x64"],
        inventoryDigest: "a".repeat(64),
      },
    });
    expect(socket.closed).toEqual({ code: 4409, reason: "protocol version mismatch" });
    expect(machineMessages(socket)).toEqual([]);
    expect(fix.gateway.isOnline(fix.machineId)).toBe(false);
    expect(fix.status("t1")).toBe("running");
    expect(
      jobs.describe(fix.root, { machineId: fix.machineId, pluginId: "sample.worker" }).connected,
    ).toBe(false);
    fix.gateway.shutdown();
    fix.store.close();
  });

  test("an incompatible native owner keeps terminal continuity and maintenance without job authority", async () => {
    const fix = fixture("c".repeat(64), ["t1"], "retained-host");
    const jobs = new JobService(fix.store, fix.auth, fix.runtime);
    fix.gateway.setJobs(jobs);
    const keys = generateKeyPairSync("ed25519");
    const owner: JobOwner = {
      protocolVersion: JOB_OWNER_PROTOCOL_VERSION + 1,
      ownerId: "retained-owner",
      publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      generation: 1,
      platforms: ["linux-x64"],
      inventoryDigest: "a".repeat(64),
      terminalHostId: "retained-host",
    };
    const socket = fix.hello("retained", {
      terminalHostId: "retained-host",
      alive: ["t1"],
      jobOwner: owner,
    });
    try {
      expect(socket.closed).toBeNull();
      expect(fix.gateway.isOnline(fix.machineId)).toBe(true);
      expect(fix.status("t1")).toBe("running");
      for (const frame of machineMessages(socket)) {
        if (frame.type !== "job_command" || frame.command.type !== "owner_challenge") continue;
        const proof = {
          nonce: frame.command.nonce,
          serverEpoch: frame.command.serverEpoch,
          machineId: fix.machineId,
          owner,
        };
        fix.gateway.message(
          "retained",
          JSON.stringify({
            type: "job_event",
            event: {
              type: "owner_proof",
              ...proof,
              signature: sign(null, Buffer.from(canonicalJobJson(proof)), keys.privateKey).toString(
                "base64",
              ),
            },
          }),
        );
      }
      expect(
        jobs.describe(fix.root, { machineId: fix.machineId, pluginId: "sample.worker" }).connected,
      ).toBe(false);
      const draining = fix.gateway.drain(fix.machineId, true);
      const request = machineMessages(socket).findLast(
        (frame) => frame.type === "drain" && frame.draining,
      );
      if (request?.type !== "drain") throw new Error("drain request missing");
      fix.gateway.message(
        "retained",
        JSON.stringify({
          type: "drain_status",
          requestId: request.requestId,
          terminalHostId: "retained-host",
          draining: true,
          terminalIds: ["t1"],
        }),
      );
      expect(await draining).toEqual({
        ok: true,
        status: { terminalHostId: "retained-host", draining: true, terminalIds: ["t1"] },
      });
      expect(socket.closed).toBeNull();
      expect(fix.status("t1")).toBe("running");
    } finally {
      fix.gateway.shutdown();
      fix.store.close();
    }
  });

  test("owner RPC is proved on the current transport; an ownerless replacement fences its authority", () => {
    const fix = fixture("b".repeat(64), []);
    const jobs = new JobService(fix.store, fix.auth, fix.runtime);
    fix.gateway.setJobs(jobs);
    const keys = generateKeyPairSync("ed25519");
    const owner: JobOwner = {
      protocolVersion: JOB_OWNER_PROTOCOL_VERSION,
      ownerId: "job-owner",
      publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      generation: 1,
      platforms: ["linux-x64"],
      inventoryDigest: "a".repeat(64),
    };
    const socket = fix.hello("job-owner", {
      protocolVersion: PROTOCOL_VERSION,
      jobOwner: owner,
    });
    const challenge = machineMessages(socket).find((frame) => frame.type === "job_command");
    if (challenge?.type !== "job_command" || challenge.command.type !== "owner_challenge") {
      throw new Error("owner challenge missing");
    }
    const proof = {
      nonce: challenge.command.nonce,
      serverEpoch: challenge.command.serverEpoch,
      machineId: fix.machineId,
      owner,
    };
    fix.gateway.message(
      "job-owner",
      JSON.stringify({
        type: "job_event",
        event: {
          type: "owner_proof",
          ...proof,
          signature: sign(null, Buffer.from(canonicalJobJson(proof)), keys.privateKey).toString(
            "base64",
          ),
        },
      }),
    );
    expect(socket.closed).toBeNull();
    expect(
      jobs.describe(fix.root, { machineId: fix.machineId, pluginId: "sample.worker" }),
    ).toMatchObject({
      connected: true,
      platforms: ["linux-x64"],
    });
    const replacement = fix.hello("ownerless-replacement");
    expect(replacement.closed).toBeNull();
    expect(socket.closed?.code).toBe(4001);
    expect(machineMessages(replacement).map((frame) => frame.type)).toEqual(["welcome"]);
    // No close callback from the superseded socket has run: admission itself fences jobs.
    expect(
      jobs.describe(fix.root, { machineId: fix.machineId, pluginId: "sample.worker" }),
    ).toMatchObject({
      connected: false,
      platforms: [],
    });
    fix.gateway.shutdown();
    fix.store.close();
  });

  test("the verdict table", () => {
    const both = new Set(["t1", "t2"]);
    const rows = ["t1", "t2"];
    // Nothing to continue: any owner takes the seat, superseding a live one.
    expect(
      decideAdmission({
        incumbent: { terminalHostId: "host-A" },
        persistedOwner: "host-A",
        newcomerOwner: "host-B",
        durableRunning: [],
        advertised: new Set(),
      }),
    ).toEqual({ verdict: "admit", supersedes: true });
    expect(
      decideAdmission({
        incumbent: null,
        persistedOwner: "host-A",
        newcomerOwner: null,
        durableRunning: [],
        advertised: new Set(),
      }),
    ).toEqual({ verdict: "admit", supersedes: false });
    // The owner, live or on record, is proof whatever its inventory says.
    expect(
      decideAdmission({
        incumbent: { terminalHostId: "host-A" },
        persistedOwner: "host-A",
        newcomerOwner: "host-A",
        durableRunning: rows,
        advertised: new Set(),
      }),
    ).toEqual({ verdict: "admit", supersedes: true });
    expect(
      decideAdmission({
        incumbent: null,
        persistedOwner: "host-A",
        newcomerOwner: "host-A",
        durableRunning: rows,
        advertised: new Set(),
      }),
    ).toEqual({ verdict: "admit", supersedes: false });
    // A different owner may take a vacant seat, but cannot displace an active incumbent.
    for (const incumbent of [{ terminalHostId: "host-A" }, null]) {
      expect(
        decideAdmission({
          incumbent,
          persistedOwner: "host-A",
          newcomerOwner: "host-B",
          durableRunning: rows,
          advertised: both,
        }).verdict,
      ).toBe(incumbent === null ? "admit" : "refuse");
      // Mixed ownership, both directions.
      expect(
        decideAdmission({
          incumbent,
          persistedOwner: "host-A",
          newcomerOwner: null,
          durableRunning: rows,
          advertised: both,
        }).verdict,
      ).toBe(incumbent === null ? "admit" : "refuse");
      expect(
        decideAdmission({
          incumbent: incumbent === null ? null : { terminalHostId: null },
          persistedOwner: null,
          newcomerOwner: "host-B",
          durableRunning: rows,
          advertised: both,
        }).verdict,
      ).toBe(incumbent === null ? "admit" : "refuse");
    }
    // A live legacy incumbent still requires complete inventory proof.
    expect(
      decideAdmission({
        incumbent: { terminalHostId: null },
        persistedOwner: null,
        newcomerOwner: null,
        durableRunning: rows,
        advertised: both,
      }),
    ).toEqual({ verdict: "admit", supersedes: true });
    expect(
      decideAdmission({
        incumbent: { terminalHostId: null },
        persistedOwner: null,
        newcomerOwner: null,
        durableRunning: rows,
        advertised: new Set(["t1"]),
      }).verdict,
    ).toBe("refuse");
    expect(
      decideAdmission({
        incumbent: { terminalHostId: null },
        persistedOwner: null,
        newcomerOwner: null,
        durableRunning: rows,
        advertised: new Set(),
      }).verdict,
    ).toBe("refuse");
  });

  test("an empty same-token claimant cannot supersede a live owner or touch its terminals", () => {
    const fix = fixture("4".repeat(64), ["t1", "t2"], "host-A");
    const owner = fix.hello("owner", { terminalHostId: "host-A", alive: ["t1", "t2"] });
    expect(owner.closed).toBeNull();
    expect(fix.status("t1")).toBe("running");

    const impostor = fix.hello("impostor", { terminalHostId: "host-B" });
    expect(impostor.closed?.code).toBe(4003);
    expect(machineMessages(impostor)).toEqual([]);
    const legacy = fix.hello("legacy");
    expect(legacy.closed?.code).toBe(4003);
    expect(machineMessages(legacy)).toEqual([]);

    // The owner never heard a thing: no supersession, no kill, no exit.
    expect(owner.closed).toBeNull();
    expect(machineMessages(owner).filter((message) => message.type === "kill")).toEqual([]);
    expect(fix.status("t1")).toBe("running");
    expect(fix.status("t2")).toBe("running");
    expect(fix.logger.events.map((event) => event.evt)).not.toContain("machine_superseded");
    // Refusal is at negotiation: the refused sockets were never fenced, so their close is a no-op.
    fix.gateway.close("impostor");
    fix.gateway.close("legacy");
    expect(fix.gateway.isOnline(fix.machineId)).toBe(true);
    fix.gateway.shutdown();
    fix.store.close();
  });

  test("the same owner behind a new transport supersedes and is believed", () => {
    const fix = fixture("5".repeat(64), ["t1", "t2"], "host-A");
    const first = fix.hello("first", { terminalHostId: "host-A", alive: ["t1", "t2"] });
    // Transport restart: same owner, t2 has since exited and is no longer advertised.
    const second = fix.hello("second", { terminalHostId: "host-A", alive: ["t1"] });

    expect(first.closed).toEqual({ code: 4001, reason: "superseded" });
    expect(second.closed).toBeNull();
    expect(fix.status("t1")).toBe("running");
    expect(fix.status("t2")).toBe("exited");
    expect(fix.store.getMachine(fix.machineId)?.ownerHostId).toBe("host-A");
    fix.gateway.shutdown();
    fix.store.close();
  });

  test("replacement owner takes a vacant seat without removing the lost terminals or their home", () => {
    const fix = fixture("6".repeat(64), ["t1", "t2"], "host-A");
    const row = fix.store.getTerminal("t1");
    if (!row) throw new Error("missing fixture terminal");
    const room = fix.rooms.get(row.containerId);
    room?.placeTerminalTile("t1", null, null);
    const owner = fix.hello("owner", { terminalHostId: "host-A", alive: ["t1", "t2"] });
    owner.close(4010, "terminal host connection lost");
    fix.gateway.close("owner");
    // Transport loss alone is not evidence the process died.
    expect(fix.status("t1")).toBe("running");
    expect(fix.store.getMachine(fix.machineId)?.ownerHostId).toBe("host-A");
    expect(fix.auth.authenticate(fix.terminalTokens.get("t1")!).principal.id).toBe(
      row.agentPrincipalId!,
    );
    const replacement = fix.hello("replacement", { terminalHostId: "host-B" });
    expect(replacement.closed).toBeNull();
    expect(fix.gateway.isOnline(fix.machineId)).toBe(true);
    expect(fix.store.getTerminal("t1")).toMatchObject({
      id: "t1",
      containerId: row.containerId,
      status: "exited",
      exitCode: null,
    });
    expect(fix.status("t2")).toBe("exited");
    expect(() => fix.auth.authenticate(fix.terminalTokens.get("t1")!)).toThrow();
    expect(room?.homesTerminal("t1")).toBe(true);
    expect(fix.store.getMachine(fix.machineId)?.ownerHostId).toBe("host-B");
    fix.gateway.shutdown();
    fix.store.close();
  });

  test("an explicit 4010 IPC seat disconnect re-adopts the same owner's live terminals", () => {
    const fix = fixture("d".repeat(64), ["t1", "t2"], "host-A");
    try {
      const row = fix.store.getTerminal("t1")!;
      const room = fix.rooms.get(row.containerId)!;
      room.placeTerminalTile("t1", null, null);
      const old = fix.hello("old", { terminalHostId: "host-A", alive: ["t1", "t2"] });
      const current = fix.hello("current", { terminalHostId: "host-A", alive: ["t1", "t2"] });
      old.close(4010, "terminal host connection lost");
      fix.gateway.close("old");
      expect(fix.gateway.isOnline(fix.machineId)).toBe(true);
      expect(fix.status("t1")).toBe("running");

      // The IPC writer may drop a seat under backpressure while every PTY stays alive.
      current.close(4010, "terminal host connection lost");
      fix.gateway.close("current");
      expect(fix.gateway.isOnline(fix.machineId)).toBe(false);
      expect(fix.store.getMachine(fix.machineId)?.ownerHostId).toBe("host-A");
      const disconnected = ["t1", "t2"].map((id) => fix.store.getTerminal(id));

      const recovered = fix.hello("recovered", {
        terminalHostId: "host-A",
        alive: ["t1", "t2"],
      });
      expect(recovered.closed).toBeNull();
      expect(machineMessages(recovered).filter((message) => message.type === "kill")).toEqual([]);
      expect(fix.gateway.isOnline(fix.machineId)).toBe(true);
      for (const terminal of disconnected) {
        expect(terminal?.status).toBe("running");
        expect(fix.store.getTerminal(terminal!.id)).toEqual(terminal);
        expect(fix.auth.authenticate(fix.terminalTokens.get(terminal!.id)!).principal.id).toBe(
          terminal!.agentPrincipalId!,
        );
      }
      expect(fix.broker.listForContainer(row.containerId)).toMatchObject([
        { id: "t1", status: "running" },
        { id: "t2", status: "running" },
      ]);
      expect(room.homesTerminal("t1")).toBe(true);
      expect(fix.store.getContainer(row.containerId)).not.toBeNull();
    } finally {
      fix.gateway.shutdown();
      fix.store.close();
    }
  });

  test("a vacant unnamed seat retains missing terminals while adopting surviving inventory", () => {
    const fix = fixture("7".repeat(64), ["t1", "t2"]);
    const partial = fix.hello("partial", { alive: ["t1"] });
    expect(partial.closed).toBeNull();
    expect(fix.status("t1")).toBe("running");
    expect(fix.status("t2")).toBe("exited");
    // A stray PTY the owner advertises alongside is its own, and is killed like before.
    const stray = fix.hello("stray", { alive: ["t1", "stray"] });
    expect(stray.closed).toBeNull();
    expect(machineMessages(stray)).toContainEqual({ type: "kill", terminalId: "stray" });
    fix.gateway.shutdown();
    fix.store.close();
  });

  /**
   * THE REPOSITORY ROUND TRIP (#529). One question, one answer, and three ways there is
   * nobody to answer — each of which must be a refusal that says which, never a fabricated
   * observation and never a hang.
   */
  describe("repository facts", () => {
    const WORK = "/home/operator/work";
    const answered = {
      path: WORK,
      identity: "/home/operator/work/.git",
      remote: "github.com/atyrode/manifold",
      reason: "repository",
      observedAt: 12,
    } as const;

    test("asks the connected agent once and resolves with what it answered", async () => {
      const fix = fixture("r".repeat(64), []);
      const socket = fix.hello("agent", { terminalHostId: "host-A" });
      const pending = fix.gateway.repository(fix.machineId, WORK);

      const query = machineMessages(socket).find((frame) => frame.type === "repository_query");
      expect(query).toMatchObject({ type: "repository_query", path: WORK });
      fix.gateway.message(
        "agent",
        JSON.stringify({
          type: "repository_fact",
          requestId: query?.type === "repository_query" ? query.requestId : "",
          fact: answered,
        }),
      );

      expect(await pending).toEqual({ ok: true, fact: answered });
      fix.gateway.shutdown();
      fix.store.close();
    });

    test("an agent too old to parse the frame is refused by name, never waited out", async () => {
      const fix = fixture("s".repeat(64), []);
      const socket = fix.hello("legacy", { protocolVersion: 30, terminalHostId: "host-A" });

      const outcome = await fix.gateway.repository(fix.machineId, WORK);

      expect(outcome).toEqual({
        ok: false,
        reason: "machine agent is too old to answer repository facts",
      });
      // The wire an older agent sees stays byte-identical: nothing was sent to it.
      expect(machineMessages(socket).some((frame) => frame.type === "repository_query")).toBe(
        false,
      );
      fix.gateway.shutdown();
      fix.store.close();
    });

    test("an unenrolled id, a machine with no transport, and one that goes quiet each say so", async () => {
      const fix = fixture("t".repeat(64), []);
      // A plugin reaches this mechanism directly, so an id the hub never enrolled must not
      // come back as an outage on a machine that may well be connected (#724).
      expect(await fix.gateway.repository("not-enrolled", WORK)).toEqual({
        ok: false,
        reason: "machine is not enrolled here: it cannot be asked",
      });
      expect(await fix.gateway.repository(fix.machineId, WORK)).toEqual({
        ok: false,
        reason: "machine has no live transport: it cannot be asked",
      });

      fix.hello("silent", { terminalHostId: "host-A" });
      const pending = fix.gateway.repository(fix.machineId, WORK);
      fix.clock.advance(3_000);

      expect(await pending).toEqual({
        ok: false,
        reason: "machine agent did not answer in time",
      });
      fix.gateway.shutdown();
      fix.store.close();
    });

    test("a transport that drops mid-question fails its waiter closed", async () => {
      const fix = fixture("u".repeat(64), []);
      fix.hello("dropping", { terminalHostId: "host-A" });
      const pending = fix.gateway.repository(fix.machineId, WORK);

      fix.gateway.close("dropping");

      expect(await pending).toEqual({
        ok: false,
        reason: "machine disconnected before answering",
      });
      fix.gateway.shutdown();
      fix.store.close();
    });

    test("an answer nobody is waiting for is dropped rather than believed", async () => {
      const fix = fixture("v".repeat(64), []);
      fix.hello("late", { terminalHostId: "host-A" });

      fix.gateway.message(
        "late",
        JSON.stringify({ type: "repository_fact", requestId: "expired", fact: answered }),
      );

      expect(fix.logger.events.map((event) => event.evt)).toContain("machine_repository_unmatched");
      fix.gateway.shutdown();
      fix.store.close();
    });
  });
});
