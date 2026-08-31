import { describe, expect, test } from "bun:test";
import {
  PROTOCOL_VERSION,
  ServerToAgentMessageSchema,
  type ActionOutcome,
  type Cap,
  type Pad,
  type ServerToAgentMessage,
} from "@manifold/protocol";
import { AuthService, type AuthContext } from "../src/auth.ts";
import { silentLogger } from "../src/log.ts";
import { PlaceExecutor, compositionElementTraits } from "../src/placement.ts";
import { OUTSIDE_SCOPE_REFUSAL, type PluginHost } from "../src/plugin-host.ts";
import { RoomManager } from "../src/room.ts";
import { SessionPeer } from "../src/session-peer.ts";
import { SessionGateway } from "../src/session-ws.ts";
import type { ServerStore } from "../src/stores.ts";
import { TerminalBroker, type MachineChannel } from "../src/terminal-broker.ts";
import { FakeClock, FakeRuntime, FakeSocket, testPluginHost, testStore } from "./helpers.ts";

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
  readonly pad: Pad;
  readonly broker: TerminalBroker;
  readonly machine: FakeMachine;
  readonly host: PluginHost;
  readonly gateway: SessionGateway;
}

/**
 * A workspace with one tiled composition, one online machine, and the real composition of
 * plugins the server registers. Tiled because a terminal opened there is homed in the
 * container the opener is already looking at, which keeps the containment questions these
 * cases are about readable.
 */
function fixture(): TerminalsFixture {
  const runtime = new FakeRuntime();
  const clock = new FakeClock(runtime);
  const store = testStore();
  const auth = new AuthService(store, OWNER_KEY, runtime);
  const owner = auth.authenticate(OWNER_KEY);
  const pad: Pad = {
    id: runtime.newId(),
    name: "terminal composition",
    createdAt: runtime.now(),
    layout: "tiled",
  };
  store.createPad(pad);
  const rooms = new RoomManager(store, runtime, clock, silentLogger);
  const broker = new TerminalBroker(
    store,
    auth,
    rooms,
    runtime,
    clock,
    silentLogger,
    () => "http://localhost:7777",
  );
  rooms.setSessionProvider((padId) => broker.listForPad(padId));
  rooms.setPendingOpenProvider((padId) => broker.hasPendingOpenForPad(padId));
  // A terminal is a FLOOR item kind, and nothing here places a contributed element, so the
  // executor needs no traits from the roster.
  broker.setPlacement(
    new PlaceExecutor(
      store,
      rooms,
      broker,
      runtime,
      compositionElementTraits(() => []),
    ),
  );
  const enrollment = auth.enrollMachine("fake", owner);
  const machine = new FakeMachine(enrollment.machine.id);
  broker.setMachineOnline(machine);
  const host = testPluginHost(store, auth, rooms, broker, runtime, {
    machines: { isOnline: () => true },
  });
  const gateway = new SessionGateway(auth, rooms, broker, host, clock, silentLogger, runtime);
  return { runtime, store, auth, owner, pad, broker, machine, host, gateway };
}

/** A minted token, so authority is exercised through real attenuation. */
function context(base: TerminalsFixture, caps: readonly Cap[], padId?: string): AuthContext {
  const grant = base.auth.mintToken(
    {
      principal: { name: "guest", kind: "human" },
      caps: [...caps],
      ...(padId === undefined ? {} : { padId }),
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
  const peer = new SessionPeer(base.runtime.newId(), new FakeSocket(), opener, base.pad.id, "c1");
  base.broker.open(peer, {
    type: "terminal_open",
    elementId: `open-${base.machine.sent.length}`,
    cols: 80,
    rows: 24,
    placement: "tile",
  });
  const create = base.machine.sent.findLast((message) => message.type === "create");
  if (create === undefined || create.type !== "create") throw new Error("missing create request");
  base.broker.onCreated(base.machine.machineId, create.sessionId);
  base.machine.clear();
  return create.sessionId;
}

function denial(outcome: ActionOutcome): { rule: string; message: string } {
  if (outcome.ok) throw new Error("expected a denial");
  return outcome.denial;
}

describe("core.terminals doors", () => {
  test("creation carries terminal:spawn, and an agent's own pad-scoped token holds it", async () => {
    const base = fixture();
    const args = { padId: base.pad.id, elementId: "el-1", cols: 80, rows: 24 };

    // The cap the broker used to demand for itself is now DECLARED, so the message a caller
    // gets is the ladder's and the authority is published in the roster.
    const unarmed = context(base, ["pads:read"]);
    expect(denial(await base.host.dispatch(unarmed, "core.terminals.open", args))).toEqual({
      rule: "forbidden",
      message: "terminal:spawn capability required",
    });

    // The whole reason `open` is `scope: "pad"`: the per-terminal agent identity is a
    // pad-scoped token carrying terminal:spawn, so a workspace-graded creation door would
    // have ended agents spawning terminals — which is A2's promise, not a nicety.
    const agentLike = context(base, ["pads:read", "terminal:spawn"], base.pad.id);
    expect(await base.host.dispatch(agentLike, "core.terminals.open", args)).toEqual({
      ok: true,
      result: {},
    });
  });

  test("a pad-scoped opener cannot have a terminal born in another container", async () => {
    const base = fixture();
    const elsewhere = base.runtime.newId();
    base.store.createPad({
      id: elsewhere,
      name: "somebody else's",
      createdAt: base.runtime.now(),
      layout: "tiled",
    });
    const scoped = context(base, ["pads:read", "terminal:spawn"], base.pad.id);

    // The scope rung proved the token's cap holds for ITS pad and nothing more; the pad in
    // the arguments is the handler's obligation, and this is that obligation firing.
    expect(
      denial(
        await base.host.dispatch(scoped, "core.terminals.open", {
          padId: elsewhere,
          elementId: "el-elsewhere",
          cols: 80,
          rows: 24,
        }),
      ),
    ).toEqual({ rule: "refused", message: OUTSIDE_SCOPE_REFUSAL });
  });

  test("a live terminal is killable by its controller, not by another writer", async () => {
    const base = fixture();
    const sessionId = liveTerminal(base);
    const other = context(base, ["pads:read", "terminal:write"], base.pad.id);

    // The opener holds the lease from the moment the PTY lands, so a second writer in the
    // same container is refused — claiming (`terminal_take`) comes before destroying.
    expect(denial(await base.host.dispatch(other, "core.terminals.kill", { sessionId }))).toEqual({
      rule: "refused",
      message: "controller lease or owner capability required",
    });
    expect(base.broker.liveSession(sessionId)).not.toBeNull();

    // The wildcard sweeps regardless: an owner clearing a terminal whose surface is already
    // gone must not have to win a lease first.
    expect(await base.host.dispatch(base.owner, "core.terminals.kill", { sessionId })).toEqual({
      ok: true,
      result: {},
    });
    expect(base.broker.liveSession(sessionId)).toBeNull();

    // Killing is idempotent by absence, which is what makes it safe to offer twice.
    expect(
      denial(await base.host.dispatch(base.owner, "core.terminals.kill", { sessionId })),
    ).toEqual({ rule: "refused", message: "terminal not found" });
  });

  test("a pad-scoped token cannot reach a terminal in another container", async () => {
    const base = fixture();
    const sessionId = liveTerminal(base);
    const elsewhere = base.runtime.newId();
    base.store.createPad({
      id: elsewhere,
      name: "another",
      createdAt: base.runtime.now(),
      layout: "tiled",
    });
    const scoped = context(base, ["pads:read", "terminal:write"], elsewhere);

    for (const [action, args] of [
      ["core.terminals.kill", { sessionId }],
      ["core.terminals.rename", { sessionId, name: "not yours" }],
    ] as const) {
      expect(denial(await base.host.dispatch(scoped, action, args))).toEqual({
        rule: "refused",
        message: OUTSIDE_SCOPE_REFUSAL,
      });
    }
    expect(base.broker.liveSession(sessionId)).not.toBeNull();
  });

  test("renaming trims, refuses an invisible name, and refuses a name for nothing", async () => {
    const base = fixture();
    const sessionId = liveTerminal(base);

    expect(
      denial(
        await base.host.dispatch(base.owner, "core.terminals.rename", { sessionId, name: " " }),
      ),
    ).toEqual({ rule: "refused", message: "name is empty" });
    expect(
      denial(
        await base.host.dispatch(base.owner, "core.terminals.rename", {
          sessionId: "no-such-session",
          name: "build",
        }),
      ),
    ).toEqual({ rule: "refused", message: "terminal not found" });

    expect(
      await base.host.dispatch(base.owner, "core.terminals.rename", {
        sessionId,
        name: "  build  ",
      }),
    ).toEqual({ ok: true, result: {} });
    expect(base.store.getSession(sessionId)?.name).toBe("build");
  });

  test("the index is a workspace read; the per-container listing is a pad read", async () => {
    const base = fixture();
    const sessionId = liveTerminal(base);
    const scoped = context(base, ["pads:read"], base.pad.id);

    const index = await base.host.dispatch(base.owner, "core.terminals.list", {});
    expect(index).toEqual({
      ok: true,
      result: {
        terminals: [
          {
            id: sessionId,
            machineId: base.machine.machineId,
            name: null,
            createdAt: base.store.getSession(sessionId)?.createdAt,
            status: "running",
            exitCode: null,
            homeId: base.pad.id,
            // Nothing points at the composition this terminal lives in, which is what
            // `unplaced` MEANS — derived from the containment graph, never stored.
            unplaced: true,
          },
        ],
      },
    });

    // The route this replaced refused a scoped token outright; the rung now says so in the
    // published vocabulary instead of in one route's prose.
    expect(denial(await base.host.dispatch(scoped, "core.terminals.list", {}))).toEqual({
      rule: "forbidden",
      message: "scoped tokens cannot invoke workspace actions",
    });

    // And the pad-graded read answers the same scoped token — with its own container's rows
    // and nothing else, exactly as the pad-sessions route filtered them.
    const own = await base.host.dispatch(scoped, "core.terminals.sessions", {});
    expect(own).toEqual({
      ok: true,
      result: {
        sessions: [
          {
            id: sessionId,
            padId: base.pad.id,
            machineId: base.machine.machineId,
            createdAt: base.store.getSession(sessionId)?.createdAt,
            status: "running",
            exitCode: null,
          },
        ],
      },
    });

    const elsewhere = base.runtime.newId();
    base.store.createPad({
      id: elsewhere,
      name: "another",
      createdAt: base.runtime.now(),
      layout: "tiled",
    });
    const stranger = context(base, ["pads:read"], elsewhere);
    expect(await base.host.dispatch(stranger, "core.terminals.sessions", {})).toEqual({
      ok: true,
      result: { sessions: [] },
    });
  });

  test("a disabled plugin refuses creation and naming, and still allows a kill", async () => {
    const base = fixture();
    const sessionId = liveTerminal(base);
    expect(await base.host.setEnabled("core.terminals", false, base.owner.principal.id)).toEqual({
      ok: true,
    });

    for (const [action, args] of [
      ["core.terminals.open", { padId: base.pad.id, elementId: "el-1", cols: 80, rows: 24 }],
      ["core.terminals.rename", { sessionId, name: "build" }],
      ["core.terminals.list", {}],
      ["core.terminals.sessions", {}],
    ] as const) {
      expect(denial(await base.host.dispatch(base.owner, action, args))).toEqual({
        rule: "plugin_disabled",
        message: 'plugin "core.terminals" is disabled',
      });
    }

    // D12, and the whole reason `cleanup` exists: an administrator turning terminals off
    // must never leave a running PTY nobody is allowed to remove.
    expect(await base.host.dispatch(base.owner, "core.terminals.kill", { sessionId })).toEqual({
      ok: true,
      result: {},
    });
    expect(base.broker.liveSession(sessionId)).toBeNull();
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
      padId: base.pad.id,
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

describe("session channel terminal verbs speak the ladder", () => {
  test("a refused creation answers with the ladder's own denial, on the same frame shape", async () => {
    const base = fixture();
    const guest = base.auth.mintToken(
      { principal: { name: "no spawner", kind: "human" }, caps: ["pads:read"] },
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
      { code: "forbidden", message: "terminal:spawn capability required", ref: "el-refused" },
    ]);
    expect(base.machine.sent).toEqual([]);
  });

  test("disabling terminals refuses new ones on the wire and still kills existing ones", async () => {
    const base = fixture();
    const sessionId = liveTerminal(base);
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

    base.gateway.message(id, JSON.stringify({ ch: "c1", type: "terminal_kill", sessionId }));
    await settled();

    expect(base.broker.liveSession(sessionId)).toBeNull();
  });

  test("an allowed creation still reaches the PTY, and a kill still destroys it", async () => {
    const base = fixture();
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
    base.broker.onCreated(base.machine.machineId, create.sessionId);
    expect(base.broker.liveSession(create.sessionId)).not.toBeNull();

    base.gateway.message(
      id,
      JSON.stringify({ ch: "c1", type: "terminal_kill", sessionId: create.sessionId }),
    );
    await settled();

    expect(base.broker.liveSession(create.sessionId)).toBeNull();
    expect(errors(socket)).toEqual([]);
  });

  test("a kill of somebody else's live terminal is refused with the door's reason", async () => {
    const base = fixture();
    const sessionId = liveTerminal(base);
    const guest = base.auth.mintToken(
      {
        principal: { name: "second writer", kind: "human" },
        caps: ["pads:read", "terminal:write"],
        padId: base.pad.id,
      },
      base.owner,
    );
    const { id, socket } = joinedSocket(base, guest.token);

    base.gateway.message(id, JSON.stringify({ ch: "c1", type: "terminal_kill", sessionId }));
    await settled();

    expect(errors(socket)).toEqual([
      {
        code: "conflict",
        message: "controller lease or owner capability required",
        ref: sessionId,
      },
    ]);
    expect(base.broker.liveSession(sessionId)).not.toBeNull();
  });
});
