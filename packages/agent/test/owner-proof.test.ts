import { expect, spyOn, test } from "bun:test";
import { generateKeyPairSync, randomUUID, verify } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentMessageSchema,
  canonicalJobJson,
  type AgentMessage,
  type JobEvent,
} from "@manifold/protocol";
import { Agent } from "../src/agent.ts";
import { HeldDirectory } from "../src/job-files.ts";
import { JobJournal } from "../src/job-journal.ts";
import * as nativeRuntime from "../src/job-linux.ts";
import { listenJobOwner, unixJobOwnerDialer } from "../src/job-owner-link.ts";
import { MachineJobOwner } from "../src/job-owner.ts";
import { JobOutputStore } from "../src/job-outputs.ts";
import type { AgentLogRecord } from "../src/log.ts";
import { TerminalHost } from "../src/terminal-host.ts";
import { unixTerminalHostDialer } from "../src/terminal-host-link.ts";
import { listenTerminalHost } from "../src/terminal-host-listener.ts";

/**
 * Issue #1050: every hub connection ends with the native owner proved. The hub accepts an
 * `owner_proof` only when the identity it signs is byte-identical to the `jobOwner` that
 * connection's hello named, and drops any other in silence (server `JobService.event`). The
 * owner signs its CURRENT identity, whose `inventoryDigest` is its journal head, and a drain
 * latch moves that head without an owner event. These cases run the production split — a real
 * MachineJobOwner and TerminalHost behind their Unix sockets as one owner process, and a real
 * transport — against a hub that applies exactly that acceptance rule.
 */

const MACHINE_ID = "machine-1050";
const SERVER_EPOCH = "epoch-1050";
const ADMISSION_PUBLIC_KEY = generateKeyPairSync("ed25519")
  .publicKey.export({ type: "spki", format: "pem" })
  .toString();

type Hello = Extract<AgentMessage, { type: "hello" }>;
type OwnerProof = Extract<JobEvent, { type: "owner_proof" }>;

/** The hub's side of one machine socket; frames cross it a microtask later, as on a network. */
class HubSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  readyState: number = WebSocket.CONNECTING;
  readonly bufferedAmount = 0;
  onAgentMessage: (message: AgentMessage) => void = () => {};

  constructor() {
    queueMicrotask(() => {
      if (this.readyState !== WebSocket.CONNECTING) return;
      this.readyState = WebSocket.OPEN;
      this.onopen?.();
    });
  }

  /** The transport's `createSocket` seam is typed as WebSocket; this implements what it uses. */
  asWebSocket(): WebSocket {
    return this as unknown as WebSocket;
  }

  send(data: string): void {
    const message = AgentMessageSchema.parse(JSON.parse(data));
    queueMicrotask(() => {
      if (this.readyState === WebSocket.OPEN) this.onAgentMessage(message);
    });
  }

  deliver(message: Record<string, unknown>): void {
    queueMicrotask(() => {
      if (this.readyState === WebSocket.OPEN)
        this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
    });
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    queueMicrotask(() => this.onclose?.({ code, reason } as CloseEvent));
  }
}

interface HubConnection {
  readonly socket: HubSocket;
  hello: Hello | null;
  /** The outstanding `owner_challenge`, once sent. */
  nonce: string | null;
  proved: boolean;
}

/** The hub's handshake and owner-proof acceptance; natives are `connected` once proved. */
class Hub {
  readonly connections: HubConnection[] = [];
  private draining = false;
  private proofWaiters: Array<(connection: HubConnection) => void> = [];
  private answerWaiters: Array<() => void> = [];

  readonly createSocket = (): WebSocket => {
    const socket = new HubSocket();
    const connection: HubConnection = { socket, hello: null, nonce: null, proved: false };
    socket.onAgentMessage = (message) => this.receive(connection, message);
    this.connections.push(connection);
    return socket.asWebSocket();
  };

  /** Resolves with the next connection whose owner proof the hub accepts. */
  nextProof(): Promise<HubConnection> {
    const { promise, resolve } = Promise.withResolvers<HubConnection>();
    this.proofWaiters.push(resolve);
    return promise;
  }

  /** Resolves once the host next answers a drain, by which point the owner's latch is set. */
  nextDrainAnswer(): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    this.answerWaiters.push(resolve);
    return promise;
  }

  /** `MachineGateway.drain`: the broker latches the host, then the owner is told directly. */
  drain(draining: boolean): Promise<void> {
    this.draining = draining;
    const answered = this.nextDrainAnswer();
    const { socket } = this.connections.at(-1)!;
    socket.deliver({ type: "drain", requestId: randomUUID(), draining });
    socket.deliver({ type: "job_command", command: { type: "drain", draining } });
    return answered;
  }

  private receive(connection: HubConnection, message: AgentMessage): void {
    const { socket } = connection;
    switch (message.type) {
      case "hello":
        connection.hello = message;
        socket.deliver({ type: "welcome", machineId: MACHINE_ID, serverEpoch: SERVER_EPOCH });
        // `TerminalBroker.setMachineOnline` re-latches the persisted drain on every hello.
        socket.deliver({ type: "drain", requestId: randomUUID(), draining: this.draining });
        return;
      case "drain_status":
        for (const resolve of this.answerWaiters.splice(0)) resolve();
        // `JobService.online` challenges right behind that drain, and the two reach the owner
        // process on different sockets. Challenging once the host has answered fixes the
        // interleaving the incident showed: the drain lands before the challenge.
        if (connection.hello?.jobOwner && connection.nonce === null) {
          connection.nonce = randomUUID();
          socket.deliver({
            type: "job_command",
            command: {
              type: "owner_challenge",
              nonce: connection.nonce,
              serverEpoch: SERVER_EPOCH,
              machineId: MACHINE_ID,
              admissionPublicKey: ADMISSION_PUBLIC_KEY,
            },
          });
        }
        return;
      case "job_event":
        if (message.event.type === "owner_proof") this.prove(connection, message.event);
        return;
      default:
        return;
    }
  }

  /** `JobService.event`'s `owner_proof` acceptance: anything else is dropped without a word. */
  private prove(connection: HubConnection, proof: OwnerProof): void {
    const owner = connection.hello?.jobOwner;
    if (
      !owner ||
      connection.proved ||
      proof.nonce !== connection.nonce ||
      proof.serverEpoch !== SERVER_EPOCH ||
      proof.machineId !== MACHINE_ID ||
      canonicalJobJson(proof.owner) !== canonicalJobJson(owner)
    )
      return;
    const unsigned = {
      nonce: proof.nonce,
      serverEpoch: proof.serverEpoch,
      machineId: proof.machineId,
      owner: proof.owner,
    };
    if (
      !verify(
        null,
        Buffer.from(canonicalJobJson(unsigned)),
        owner.publicKey,
        Buffer.from(proof.signature, "base64"),
      )
    )
      return;
    connection.proved = true;
    for (const resolve of this.proofWaiters.splice(0)) resolve(connection);
  }
}

/**
 * One native machine's retained state, and its owner process as `main.ts --terminal-host` runs
 * it: a MachineJobOwner and the TerminalHost bound to it, each on its own private Unix socket.
 * No workload is launched, so startup recovery is the only native-runtime step stubbed.
 */
function nativeMachine(hub: Hub, records: AgentLogRecord[]) {
  const root = mkdtempSync(join(tmpdir(), "agent-owner-proof-"));
  const run = join(root, "run");
  mkdirSync(run, { mode: 0o700 });
  const ownerSocket = join(run, "owner.sock");
  const hostSocket = join(run, "host.sock");
  const state = HeldDirectory.openAbsolute(root, { private: true });
  const cache = state.openChild("cache", { create: true });
  const managedState = state.openChild("locations", { create: true });
  const outputDirectory = state.openChild("outputs", { create: true });
  const delegatedCgroup = state.openChild("cgroup", { create: true });
  const held = [state, cache, managedState, outputDirectory, delegatedCgroup];
  const outputs = JobOutputStore.open(outputDirectory);
  const recover = spyOn(nativeRuntime, "recoverLinuxJobs").mockResolvedValue(undefined);
  const dialOwner = unixJobOwnerDialer(ownerSocket);
  let ownerLinked = Promise.withResolvers<void>();
  return {
    transport: new Agent({
      serverUrl: "http://hub.invalid",
      machineToken: "machine-token",
      machineName: "owner-proof",
      dialTerminalHost: unixTerminalHostDialer(hostSocket),
      dialJobOwner: async (handlers) => {
        const link = await dialOwner(handlers);
        ownerLinked.resolve();
        return link;
      },
      backoff: { baseMs: 5, capMs: 20 },
      createSocket: hub.createSocket,
      sink: (record) => records.push(record),
    }),
    /**
     * Starts the owner process, serving the owner socket and then the host socket as `main.ts`
     * does. `first` holds the other socket back until the transport has used that one: the owner
     * seat taken again, so the next hello names the owner (the incident's order); or the host's
     * answer to the drain of a hello that could not name it.
     */
    async start(first?: "owner" | "host") {
      const journal = new JobJournal(state.openChild("journal", { create: true }));
      let owner: MachineJobOwner;
      try {
        owner = await MachineJobOwner.open({
          machineId: MACHINE_ID,
          admissionPublicKey: ADMISSION_PUBLIC_KEY,
          journal,
          cache,
          managedState,
          outputs,
          delegatedCgroup,
          protectedDirectories: [state],
          bubblewrapFd: -1,
          anchors: {},
          runtimeTools: {},
          artifactAuthority: { origins: [], maxRedirects: 0, timeoutMs: 1000 },
        });
      } catch (error) {
        journal.close();
        throw error;
      }
      const host = new TerminalHost({ jobOwner: owner, sink: () => {} });
      ownerLinked = Promise.withResolvers<void>();
      const answered = hub.nextDrainAnswer();
      const listeners: Array<{ stop(): void }> = [];
      if (first === "host") {
        listeners.push(await listenTerminalHost(host, hostSocket, () => {}));
        await answered;
        listeners.push(await listenJobOwner(owner, ownerSocket));
      } else {
        listeners.push(await listenJobOwner(owner, ownerSocket));
        if (first === "owner") await ownerLinked.promise;
        listeners.push(await listenTerminalHost(host, hostSocket, () => {}));
      }
      return {
        owner,
        /** The owner process's SIGTERM path: host, owner, then both sockets. */
        async stop(): Promise<void> {
          await host.shutdown();
          await owner.shutdown();
          for (const listener of listeners) listener.stop();
        },
      };
    },
    release(): void {
      outputs.close();
      for (const directory of held.reverse()) directory.close();
      recover.mockRestore();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const unprovedRecords = (records: AgentLogRecord[]) =>
  records.filter((record) => record.evt === "job_owner_unproved");

for (const first of ["owner", "host"] as const) {
  test.skipIf(process.platform !== "linux")(
    `an owner restarted under a running transport is proved again when its ${first} socket returns first`,
    async () => {
      const hub = new Hub();
      const records: AgentLogRecord[] = [];
      const machine = nativeMachine(hub, records);
      let ownerProcess = await machine.start();
      try {
        const initialProof = hub.nextProof();
        await machine.transport.connect();
        await initialProof;
        expect(unprovedRecords(records)).toEqual([]);

        // A graceful stop latches `drain: true` into the journal, so the restarted owner reopens
        // drained, and the hub's hello-time `drain: false` moves its journal head again.
        const reproof = hub.nextProof();
        await ownerProcess.stop();
        ownerProcess = await machine.start(first);
        const proved = await reproof;

        expect(canonicalJobJson(proved.hello?.jobOwner)).toBe(
          canonicalJobJson(ownerProcess.owner.identity),
        );
        const replaced = hub.connections.findLast((connection) =>
          first === "owner"
            ? connection.nonce !== null && !connection.proved
            : connection.hello !== null && connection.hello.jobOwner === undefined,
        );
        // Exactly one more hello replaces the one the hub could not prove.
        expect(hub.connections.indexOf(proved)).toBe(hub.connections.indexOf(replaced!) + 1);
        if (first === "owner") {
          // That hello named the owner before the drain moved it: the proof is of another identity.
          expect(unprovedRecords(records)).toEqual([
            expect.objectContaining({ level: "warn", changed: ["inventoryDigest"] }),
          ]);
        } else {
          // That hello named no owner, because the seat was not yet held when it went out.
          expect(unprovedRecords(records)).toEqual([]);
          expect(records).toContainEqual(
            expect.objectContaining({
              evt: "disconnected",
              code: 4011,
              reason: "job owner available",
            }),
          );
        }
      } finally {
        await machine.transport.shutdown();
        await ownerProcess.stop();
        machine.release();
      }
    },
    20000,
  );
}

test.skipIf(process.platform !== "linux")(
  "a hub liveness timeout reconnect proves an owner whose identity moved without an event",
  async () => {
    const hub = new Hub();
    const records: AgentLogRecord[] = [];
    const machine = nativeMachine(hub, records);
    const ownerProcess = await machine.start();
    try {
      const initialProof = hub.nextProof();
      await machine.transport.connect();
      const first = await initialProof;

      // An operator drain moves the owner's journal head and emits no owner event, so the
      // transport still holds the identity it proved with.
      const proved = ownerProcess.owner.identity.inventoryDigest;
      await hub.drain(true);
      expect(ownerProcess.owner.identity.inventoryDigest).not.toBe(proved);

      const reproof = hub.nextProof();
      first.socket.close(4008, "liveness timeout");
      const second = await reproof;

      expect(hub.connections.indexOf(second)).toBe(hub.connections.indexOf(first) + 2);
      expect(second.hello?.jobOwner?.inventoryDigest).toBe(
        ownerProcess.owner.identity.inventoryDigest,
      );
      expect(records).toContainEqual(
        expect.objectContaining({ evt: "disconnected", code: 4008, reason: "liveness timeout" }),
      );
      expect(unprovedRecords(records)).toEqual([
        expect.objectContaining({ changed: ["inventoryDigest"] }),
      ]);
    } finally {
      await machine.transport.shutdown();
      await ownerProcess.stop();
      machine.release();
    }
  },
  20000,
);
