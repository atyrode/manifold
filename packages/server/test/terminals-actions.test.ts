import { describe, expect, test } from "bun:test";
import {
  PROTOCOL_VERSION,
  ServerToAgentMessageSchema,
  type ActionOutcome,
  type Cap,
  type Container,
  type ServerToAgentMessage,
  type TerminalProgram,
} from "@manifold/protocol";
import { AuthService, type AuthContext } from "../src/auth.ts";
import { silentLogger } from "../src/log.ts";
import { PlaceExecutor, assemblyPlacementVocabulary, assemblyItemNouns } from "../src/placement.ts";
import { OUTSIDE_SCOPE_REFUSAL, type PluginHost } from "../src/plugin-host.ts";
import { RoomManager } from "../src/room.ts";
import { SessionChannel } from "../src/session-channel.ts";
import { SessionGateway } from "../src/session-ws.ts";
import { TRACE_ROW_TYPE, type ServerStore, type StoredEvent } from "../src/stores.ts";
import { TerminalBroker, type MachineChannel } from "../src/terminal-broker.ts";
import {
  FakeClock,
  FakeRuntime,
  FakeSocket,
  testEventHub,
  testPluginHost,
  testStore,
  testTileTrees,
} from "./helpers.ts";

/**
 * THE TERMINAL DOORS, from both sides.
 *
 * Terminals are the case that decides whether the plane rule (D6) is real: the PTY, the
 * attach handshake and the byte frames are floor mechanism, while creation, naming and
 * killing are policy `core.terminals` owns. So every one of these cases asks a question
 * about POLICY, and asks it through the ladder — including the two the session channel used
 * to answer by itself, which is what the second describe block below is for. A refusal that
 * reads differently depending on whether it arrived over a socket or over HTTP would mean
 * there are still two doors, whatever the file layout says.
 */

const OWNER_KEY = "c".repeat(64);

class FakeMachine implements MachineChannel {
  readonly sent: ServerToAgentMessage[] = [];
  readonly protocolVersion = PROTOCOL_VERSION;

  constructor(readonly machineId: string) {}

  send(message: ServerToAgentMessage): boolean {
    this.sent.push(ServerToAgentMessageSchema.parse(message));
    return true;
  }

  clear(): void {
    this.sent.length = 0;
  }
}

interface TerminalsFixture {
  readonly runtime: FakeRuntime;
  readonly store: ServerStore;
  readonly auth: AuthService;
  readonly owner: AuthContext;
  readonly container: Container;
  readonly broker: TerminalBroker;
  readonly machine: FakeMachine;
  readonly host: PluginHost;
  readonly gateway: SessionGateway;
}

/**
 * A workspace with one composition container, one online machine, and the real assembly of
 * plugins the server registers. A composition because a terminal opened there is homed in the
 * container the opener is already looking at, which keeps the containment questions these
 * cases are about readable.
 */
async function fixture(): Promise<TerminalsFixture> {
  const runtime = new FakeRuntime();
  const clock = new FakeClock(runtime);
  const store = testStore();
  const auth = new AuthService(store, OWNER_KEY, runtime);
  const owner = auth.authenticate(OWNER_KEY);
  const container: Container = {
    id: runtime.newId(),
    name: "terminal composition",
    createdAt: runtime.now(),
    discipline: "composition",
  };
  store.createContainer(container);
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
  // A terminal is a FLOOR item kind, and nothing here places a contributed element, so the
  // executor needs no traits from the roster.
  broker.setPlacement(
    new PlaceExecutor(
      store,
      rooms,
      broker,
      runtime,
      assemblyPlacementVocabulary(() => []),
      assemblyItemNouns(() => []),
    ),
  );
  const enrollment = auth.enrollMachine("fake", owner);
  const machine = new FakeMachine(enrollment.machine.id);
  broker.setMachineOnline(machine);
  let host: PluginHost | null = null;
  const events = testEventHub(
    store,
    auth,
    broker,
    () => {
      if (host === null) throw new Error("the event plane read the assembly before the host");
      return host.assembly();
    },
    runtime,
  );
  host = await testPluginHost(store, auth, rooms, broker, runtime, {
    machines: { isOnline: () => true },
    events,
  });
  broker.setEvents(events);
  rooms.setEvents(events);
  const gateway = new SessionGateway(
    auth,
    rooms,
    broker,
    host,
    clock,
    silentLogger,
    runtime,
    events,
  );
  return { runtime, store, auth, owner, container, broker, machine, host, gateway };
}

/** A minted token, so authority is exercised through real attenuation. */
function context(base: TerminalsFixture, caps: readonly Cap[], containerId?: string): AuthContext {
  const grant = base.auth.mintToken(
    {
      principal: { name: "guest", kind: "human" },
      caps: [...caps],
      ...(containerId === undefined ? {} : { containerId }),
    },
    base.owner,
  );
  return base.auth.authenticate(grant.token);
}

/**
 * Births a live terminal through the floor's own path, deliberately NOT through the door
 * under test: a case about killing must not depend on creation having been allowed.
 */
function liveTerminal(base: TerminalsFixture, opener: AuthContext = base.owner): string {
  const channel = new SessionChannel(
    base.runtime.newId(),
    new FakeSocket(),
    opener,
    base.container.id,
    "c1",
  );
  base.broker.open(channel, {
    type: "terminal_open",
    elementId: `open-${base.machine.sent.length}`,
    cols: 80,
    rows: 24,
    placement: "tile",
  });
  const create = base.machine.sent.findLast((message) => message.type === "create");
  if (create === undefined || create.type !== "create") throw new Error("missing create request");
  base.broker.onCreated(base.machine.machineId, create.terminalId);
  base.machine.clear();
  return create.terminalId;
}

function denial(outcome: ActionOutcome): { rule: string; message: string } {
  if (outcome.ok) throw new Error("expected a denial");
  return outcome.denial;
}

describe("core.terminals doors", () => {
  test("creation carries terminals:spawn, and an agent's own container-scoped token holds it", async () => {
    const base = await fixture();
    const args = { containerId: base.container.id, elementId: "el-1", cols: 80, rows: 24 };

    // The cap the broker used to demand for itself is now DECLARED, so the message a caller
    // gets is the ladder's and the authority is published in the roster.
    const unarmed = context(base, ["containers:read"]);
    expect(denial(await base.host.dispatch(unarmed, "core.terminals.open", args))).toEqual({
      rule: "forbidden",
      message: "terminals:spawn capability required",
    });

    // The whole reason `open` is `scope: "container"`: the per-terminal agent identity is a
    // container-scoped token carrying terminals:spawn, so a workspace-graded creation door
    // would have ended agents spawning terminals — which is A2's promise, not a nicety.
    const agentLike = context(base, ["containers:read", "terminals:spawn"], base.container.id);
    expect(await base.host.dispatch(agentLike, "core.terminals.open", args)).toEqual({
      ok: true,
      result: {},
    });
  });

  test("a container-scoped opener cannot have a terminal born in another container", async () => {
    const base = await fixture();
    const elsewhere = base.runtime.newId();
    base.store.createContainer({
      id: elsewhere,
      name: "somebody else's",
      createdAt: base.runtime.now(),
      discipline: "composition",
    });
    const scoped = context(base, ["containers:read", "terminals:spawn"], base.container.id);

    // The scope rung proved the token's cap holds for ITS container and nothing more; the
    // container in the arguments is the handler's obligation, and this is that obligation
    // firing.
    expect(
      denial(
        await base.host.dispatch(scoped, "core.terminals.open", {
          containerId: elsewhere,
          elementId: "el-elsewhere",
          cols: 80,
          rows: 24,
        }),
      ),
    ).toEqual({ rule: "refused", message: OUTSIDE_SCOPE_REFUSAL });
  });

  test("a live terminal is killable by its controller, not by another writer", async () => {
    const base = await fixture();
    const terminalId = liveTerminal(base);
    const other = context(base, ["containers:read", "terminals:write"], base.container.id);

    // The opener holds the lease from the moment the PTY lands, so a second writer in the
    // same container is refused — claiming (`terminal_take`) comes before destroying.
    expect(denial(await base.host.dispatch(other, "core.terminals.kill", { terminalId }))).toEqual({
      rule: "refused",
      message: "controller lease or owner capability required",
    });
    expect(base.broker.liveTerminal(terminalId)).not.toBeNull();

    // The wildcard sweeps regardless: an owner clearing a terminal nothing points at any
    // more must not have to win a lease first.
    expect(await base.host.dispatch(base.owner, "core.terminals.kill", { terminalId })).toEqual({
      ok: true,
      result: {},
    });
    expect(base.broker.liveTerminal(terminalId)).toBeNull();

    // Killing is idempotent by absence, which is what makes it safe to offer twice.
    expect(
      denial(await base.host.dispatch(base.owner, "core.terminals.kill", { terminalId })),
    ).toEqual({ rule: "refused", message: "terminal not found" });
  });

  test("taking the lease is a door: caps, scope, and an exited terminal has nothing to take", async () => {
    const base = await fixture();
    const terminalId = liveTerminal(base);
    const opener = base.owner.principal.id;

    // Rung 1. The broker used to demand this cap for itself and phrase its own refusal; the
    // wording is unchanged and the authority is now published in the roster.
    const reader = context(base, ["containers:read"], base.container.id);
    expect(denial(await base.host.dispatch(reader, "core.terminals.take", { terminalId }))).toEqual(
      { rule: "forbidden", message: "terminals:write capability required" },
    );

    // Rung 3's handler obligation: `scope: "container"` proves the cap at the caller's OWN
    // container, and the terminal named in the arguments lives somewhere else.
    const elsewhere = base.runtime.newId();
    base.store.createContainer({
      id: elsewhere,
      name: "another",
      createdAt: base.runtime.now(),
      discipline: "composition",
    });
    const stranger = context(base, ["containers:read", "terminals:write"], elsewhere);
    expect(
      denial(await base.host.dispatch(stranger, "core.terminals.take", { terminalId })),
    ).toEqual({ rule: "refused", message: OUTSIDE_SCOPE_REFUSAL });

    expect(
      denial(await base.host.dispatch(base.owner, "core.terminals.take", { terminalId: "ghost" })),
    ).toEqual({ rule: "refused", message: "terminal not found" });

    // THE INCUMBENT LEASE IS NOT A RULE HERE, and that is the point of the verb: `kill`
    // refuses a running terminal held by somebody else precisely because this door exists to
    // claim it first, so a take that respected the holder would close the only way out.
    const other = context(base, ["containers:read", "terminals:write"], base.container.id);
    expect(await base.host.dispatch(other, "core.terminals.take", { terminalId })).toEqual({
      ok: true,
      result: {},
    });
    // The door answered POLICY; the transfer is the channel's, exactly as `open` births no
    // PTY. An HTTP dispatch holds no channel, so the lease has not moved.
    expect(base.broker.liveTerminal(terminalId)?.controllerId).toBe(opener);

    // An exited terminal has no lease to take, and the refusal says so rather than saying
    // "not found": the row is still there, and a client that cannot tell those apart cannot
    // tell the operator what happened.
    base.broker.onExited(base.machine.machineId, terminalId, 0);
    expect(
      denial(await base.host.dispatch(base.owner, "core.terminals.take", { terminalId })),
    ).toEqual({ rule: "refused", message: "terminal has exited" });
  });

  test("a container-scoped token cannot reach a terminal in another container", async () => {
    const base = await fixture();
    const terminalId = liveTerminal(base);
    const elsewhere = base.runtime.newId();
    base.store.createContainer({
      id: elsewhere,
      name: "another",
      createdAt: base.runtime.now(),
      discipline: "composition",
    });
    const scoped = context(base, ["containers:read", "terminals:write"], elsewhere);

    for (const [action, args] of [
      ["core.terminals.kill", { terminalId }],
      ["core.terminals.rename", { terminalId, name: "not yours" }],
    ] as const) {
      expect(denial(await base.host.dispatch(scoped, action, args))).toEqual({
        rule: "refused",
        message: OUTSIDE_SCOPE_REFUSAL,
      });
    }
    expect(base.broker.liveTerminal(terminalId)).not.toBeNull();
  });

  test("renaming trims, refuses an invisible name, and refuses a name for nothing", async () => {
    const base = await fixture();
    const terminalId = liveTerminal(base);

    expect(
      denial(
        await base.host.dispatch(base.owner, "core.terminals.rename", { terminalId, name: " " }),
      ),
    ).toEqual({ rule: "refused", message: "name is empty" });
    expect(
      denial(
        await base.host.dispatch(base.owner, "core.terminals.rename", {
          terminalId: "no-such-terminal",
          name: "build",
        }),
      ),
    ).toEqual({ rule: "refused", message: "terminal not found" });

    expect(
      await base.host.dispatch(base.owner, "core.terminals.rename", {
        terminalId,
        name: "  build  ",
      }),
    ).toEqual({ ok: true, result: {} });
    expect(base.store.getTerminal(terminalId)?.name).toBe("build");
  });

  test("the index is a workspace read; the per-container listing is a container read", async () => {
    const base = await fixture();
    const terminalId = liveTerminal(base);
    const scoped = context(base, ["containers:read"], base.container.id);

    const index = await base.host.dispatch(base.owner, "core.terminals.listAll", {});
    expect(index).toEqual({
      ok: true,
      result: {
        terminals: [
          {
            id: terminalId,
            machineId: base.machine.machineId,
            name: null,
            createdAt: base.store.getTerminal(terminalId)?.createdAt,
            status: "running",
            exitCode: null,
            homeId: base.container.id,
            // Nothing points at the composition this terminal lives in, which is what
            // `unplaced` MEANS — derived from the containment graph, never stored.
            unplaced: true,
          },
        ],
      },
    });

    // The route this replaced refused a scoped token outright; the rung now says so in the
    // published vocabulary instead of in one route's prose.
    expect(denial(await base.host.dispatch(scoped, "core.terminals.listAll", {}))).toEqual({
      rule: "forbidden",
      message: "scoped tokens cannot invoke workspace actions",
    });

    // And the container-graded read answers the same scoped token — with its own container's
    // rows and nothing else, exactly as the container-terminals route filtered them.
    const own = await base.host.dispatch(scoped, "core.terminals.listByContainer", {});
    expect(own).toEqual({
      ok: true,
      result: {
        terminals: [
          {
            id: terminalId,
            containerId: base.container.id,
            machineId: base.machine.machineId,
            createdAt: base.store.getTerminal(terminalId)?.createdAt,
            status: "running",
            exitCode: null,
          },
        ],
      },
    });

    const elsewhere = base.runtime.newId();
    base.store.createContainer({
      id: elsewhere,
      name: "another",
      createdAt: base.runtime.now(),
      discipline: "composition",
    });
    const stranger = context(base, ["containers:read"], elsewhere);
    expect(await base.host.dispatch(stranger, "core.terminals.listByContainer", {})).toEqual({
      ok: true,
      result: { terminals: [] },
    });
  });

  test("a disabled plugin refuses creation, naming and taking, and still allows a kill", async () => {
    const base = await fixture();
    const terminalId = liveTerminal(base);
    expect(await base.host.setEnabled("core.terminals", false, base.owner.principal.id)).toEqual({
      ok: true,
    });

    for (const [action, args] of [
      [
        "core.terminals.open",
        { containerId: base.container.id, elementId: "el-1", cols: 80, rows: 24 },
      ],
      ["core.terminals.rename", { terminalId, name: "build" }],
      // `take` is NOT `cleanup`: claiming control of a live PTY from whoever is typing in it
      // is administration, and widening the carve-out to cover it would make a disabled
      // plugin more capable than the rule the disable suspends.
      ["core.terminals.take", { terminalId }],
      ["core.terminals.listAll", {}],
      ["core.terminals.listByContainer", {}],
    ] as const) {
      expect(denial(await base.host.dispatch(base.owner, action, args))).toEqual({
        rule: "plugin_disabled",
        message: 'plugin "core.terminals" is disabled',
      });
    }

    // D12, and the whole reason `cleanup` exists: an administrator turning terminals off
    // must never leave a running PTY nobody is allowed to remove.
    expect(await base.host.dispatch(base.owner, "core.terminals.kill", { terminalId })).toEqual({
      ok: true,
      result: {},
    });
    expect(base.broker.liveTerminal(terminalId)).toBeNull();
  });
});

/**
 * Yields the event loop once. A client frame is HANDLED synchronously, but a frame whose
 * policy is a door's answer resolves through the dispatch promise the frame handler
 * deliberately does not return — there is no signal on the socket to await, because the
 * whole point is that the socket learns the answer later. This is a tick yield rather than
 * a duration: nothing here waits on wall-clock time.
 */
async function settled(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

function joinedSocket(base: TerminalsFixture, token: string): { id: string; socket: FakeSocket } {
  const id = base.runtime.newId();
  const socket = new FakeSocket();
  base.gateway.open(id, socket);
  base.gateway.message(
    id,
    JSON.stringify({
      ch: "c1",
      type: "join",
      containerId: base.container.id,
      token,
      protocolVersion: PROTOCOL_VERSION,
    }),
  );
  socket.clear();
  return { id, socket };
}

function errors(socket: FakeSocket): { code: string; message?: string; ref?: string }[] {
  return socket
    .frames()
    .flatMap((frame) => (frame.type === "error" ? [frame] : []))
    .map((frame) => ({
      code: frame.code,
      ...(frame.message === undefined ? {} : { message: frame.message }),
      ...(frame.ref === undefined ? {} : { ref: frame.ref }),
    }));
}

/** The newest `core.terminals.open` row of the ledger: what the door was asked, and its answer. */
function newestOpenTrace(base: TerminalsFixture): StoredEvent {
  const row = base.store
    .listEvents({ type: TRACE_ROW_TYPE, limit: 100 })
    .find((event) => event.door === "core.terminals.open");
  if (row === undefined) throw new Error("the ledger recorded no core.terminals.open dispatch");
  return row;
}

describe("session channel terminal verbs speak the ladder", () => {
  test("a refused creation answers with the ladder's own denial, on the same frame shape", async () => {
    const base = await fixture();
    const guest = base.auth.mintToken(
      { principal: { name: "no spawner", kind: "human" }, caps: ["containers:read"] },
      base.owner,
    );
    const { id, socket } = joinedSocket(base, guest.token);

    base.gateway.message(
      id,
      JSON.stringify({
        ch: "c1",
        type: "terminal_open",
        elementId: "el-refused",
        cols: 80,
        rows: 24,
      }),
    );
    await settled();

    // Same frame, same `ref` correlation the SDK's `openTerminal` rejects on — and the
    // message is now the door's, not this transport's invention.
    expect(errors(socket)).toEqual([
      { code: "forbidden", message: "terminals:spawn capability required", ref: "el-refused" },
    ]);
    expect(base.machine.sent).toEqual([]);
  });

  test("disabling terminals refuses new ones on the wire and still kills existing ones", async () => {
    const base = await fixture();
    const terminalId = liveTerminal(base);
    const { id, socket } = joinedSocket(base, OWNER_KEY);
    expect(await base.host.setEnabled("core.terminals", false, base.owner.principal.id)).toEqual({
      ok: true,
    });

    base.gateway.message(
      id,
      JSON.stringify({
        ch: "c1",
        type: "terminal_open",
        elementId: "el-disabled",
        cols: 80,
        rows: 24,
      }),
    );
    await settled();

    // The gateway holds no opinion about terminals any more: the refusal is rung 2 of the
    // ladder, phrased by the engine, and the transport only carried it back.
    expect(errors(socket)).toEqual([
      { code: "forbidden", message: 'plugin "core.terminals" is disabled', ref: "el-disabled" },
    ]);
    expect(base.machine.sent).toEqual([]);

    base.gateway.message(id, JSON.stringify({ ch: "c1", type: "terminal_kill", terminalId }));
    await settled();

    expect(base.broker.liveTerminal(terminalId)).toBeNull();
  });

  test("an allowed creation still reaches the PTY, and a kill still destroys it", async () => {
    const base = await fixture();
    const { id, socket } = joinedSocket(base, OWNER_KEY);

    // `placement: "tile"` because the container is a composition: placement DISCIPLINE is
    // the placement algebra's floor rule, and it still runs after the policy door allows.
    base.gateway.message(
      id,
      JSON.stringify({
        ch: "c1",
        type: "terminal_open",
        elementId: "el-ok",
        cols: 80,
        rows: 24,
        placement: "tile",
      }),
    );
    await settled();

    const create = base.machine.sent.find((message) => message.type === "create");
    if (create === undefined || create.type !== "create") throw new Error("missing create request");
    expect(errors(socket)).toEqual([]);
    base.broker.onCreated(base.machine.machineId, create.terminalId);
    expect(base.broker.liveTerminal(create.terminalId)).not.toBeNull();

    base.gateway.message(
      id,
      JSON.stringify({ ch: "c1", type: "terminal_kill", terminalId: create.terminalId }),
    );
    await settled();

    expect(base.broker.liveTerminal(create.terminalId)).toBeNull();
    expect(errors(socket)).toEqual([]);
  });

  test("the program and env a frame names are judged at the door, and the ledger records the program", async () => {
    const base = fixture();
    const { id, socket } = joinedSocket(base, OWNER_KEY);
    const argv: TerminalProgram["argv"] = ["/bin/sh", "-c", "printf CMD_OK; exec cat"];

    base.gateway.message(
      id,
      JSON.stringify({
        ch: "c1",
        type: "terminal_open",
        elementId: "el-program",
        cols: 80,
        rows: 24,
        placement: "tile",
        program: { argv },
        env: { CODE_TEST: "launch-7" },
      }),
    );
    await settled();

    // One value, read once: what the door was asked about is what rides to the machine.
    expect(errors(socket)).toEqual([]);
    const create = base.machine.sent.find((message) => message.type === "create");
    if (create === undefined || create.type !== "create") throw new Error("missing create request");
    expect(create.program).toEqual({ argv });
    expect(create.env.CODE_TEST).toBe("launch-7");

    // The trace is the durable record of the program (invariant 5). The env never reaches
    // the ledger: `env` is a redacted field name, so neither its keys nor its values persist.
    const trace = newestOpenTrace(base);
    expect(trace.outcome).toBe("ok");
    expect(JSON.parse(trace.payload)).toEqual({
      containerId: base.container.id,
      elementId: "el-program",
      cols: 80,
      rows: 24,
      placement: "tile",
      program: { argv },
    });
    expect(trace.payload).not.toContain("launch-7");
  });

  test("a program the door refuses never reaches the machine, and the refusal names it", async () => {
    const base = fixture();
    const guest = base.auth.mintToken(
      { principal: { name: "no spawner", kind: "human" }, caps: ["containers:read"] },
      base.owner,
    );
    const { id, socket } = joinedSocket(base, guest.token);
    const argv: TerminalProgram["argv"] = ["/usr/bin/env", "true"];

    base.gateway.message(
      id,
      JSON.stringify({
        ch: "c1",
        type: "terminal_open",
        elementId: "el-refused-program",
        cols: 80,
        rows: 24,
        placement: "tile",
        program: { argv },
      }),
    );
    await settled();

    expect(errors(socket)).toEqual([
      {
        code: "forbidden",
        message: "terminals:spawn capability required",
        ref: "el-refused-program",
      },
    ]);
    // Denied BEFORE anything was minted or sent: no create, no pending open, no principal.
    expect(base.machine.sent).toEqual([]);
    expect(base.broker.hasPendingOpenForContainer(base.container.id)).toBe(false);
    const trace = newestOpenTrace(base);
    expect(trace.outcome).toBe("forbidden");
    expect(JSON.parse(trace.payload)).toMatchObject({ program: { argv } });
  });

  test("a kill of somebody else's live terminal is refused with the door's reason", async () => {
    const base = await fixture();
    const terminalId = liveTerminal(base);
    const guest = base.auth.mintToken(
      {
        principal: { name: "second writer", kind: "human" },
        caps: ["containers:read", "terminals:write"],
        containerId: base.container.id,
      },
      base.owner,
    );
    const { id, socket } = joinedSocket(base, guest.token);

    base.gateway.message(id, JSON.stringify({ ch: "c1", type: "terminal_kill", terminalId }));
    await settled();

    expect(errors(socket)).toEqual([
      {
        code: "conflict",
        message: "controller lease or owner capability required",
        ref: terminalId,
      },
    ]);
    expect(base.broker.liveTerminal(terminalId)).not.toBeNull();
  });

  test("a take asks the door first, and the lease moves only once it allows", async () => {
    const base = await fixture();
    const terminalId = liveTerminal(base);
    const opener = base.owner.principal.id;
    expect(base.broker.liveTerminal(terminalId)?.controllerId).toBe(opener);

    // A reader on the same channel. The broker used to answer this itself; now the refusal
    // travels the same road every other denial does, and the lease is untouched.
    const reader = base.auth.mintToken(
      {
        principal: { name: "watcher", kind: "human" },
        caps: ["containers:read"],
        containerId: base.container.id,
      },
      base.owner,
    );
    const refused = joinedSocket(base, reader.token);
    base.gateway.message(
      refused.id,
      JSON.stringify({ ch: "c1", type: "terminal_take", terminalId }),
    );
    await settled();

    expect(errors(refused.socket)).toEqual([
      { code: "forbidden", message: "terminals:write capability required", ref: terminalId },
    ]);
    expect(base.broker.liveTerminal(terminalId)?.controllerId).toBe(opener);

    // And a writer's take still lands, because the TRANSFER stayed on the channel: this is
    // `open`'s shape, so the socket that asked is the one that ends up holding the lease.
    const writer = base.auth.mintToken(
      {
        principal: { name: "second writer", kind: "human" },
        caps: ["containers:read", "terminals:write"],
        containerId: base.container.id,
      },
      base.owner,
    );
    const allowed = joinedSocket(base, writer.token);
    base.gateway.message(
      allowed.id,
      JSON.stringify({ ch: "c1", type: "terminal_take", terminalId }),
    );
    await settled();

    expect(errors(allowed.socket)).toEqual([]);
    expect(base.broker.liveTerminal(terminalId)?.controllerId).toBe(writer.principal.id);
  });
});
