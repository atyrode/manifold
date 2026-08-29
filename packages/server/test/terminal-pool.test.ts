import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PLACEMENT_DENIED_CODE,
  PlaceResponseSchema,
  ServerToAgentMessageSchema,
  type Pad,
  type SceneElement,
  type ServerToAgentMessage,
} from "@manifold/protocol";
import {
  DEFAULT_TERMINAL_HEIGHT,
  DEFAULT_TERMINAL_WIDTH,
  LOCAL_ORIGIN,
  readElement,
  readElements,
  writeElement,
} from "@manifold/scene";
import { AuthService, type AuthContext } from "../src/auth.ts";
import { loadConfig } from "../src/config.ts";
import { HttpApp } from "../src/http.ts";
import { silentLogger } from "../src/log.ts";
import { MachineGateway } from "../src/machine-ws.ts";
import { PlaceExecutor } from "../src/placement.ts";
import { RoomManager, type Room } from "../src/room.ts";
import { SessionPeer } from "../src/session-peer.ts";
import type { ServerStore } from "../src/stores.ts";
import { TerminalBroker, type MachineChannel } from "../src/terminal-broker.ts";
import {
  FakeClock,
  FakeRuntime,
  FakeSocket,
  parkSession,
  placeSession,
  testStore,
} from "./helpers.ts";

const OWNER_KEY = "e".repeat(64);
const temporaryDirectories: string[] = [];

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

function terminalElement(id: string, sessionId: string): SceneElement {
  return {
    id,
    type: "terminal",
    sessionId,
    x: 0,
    y: 0,
    width: DEFAULT_TERMINAL_WIDTH,
    height: DEFAULT_TERMINAL_HEIGHT,
    zIndex: 0,
  };
}

/** Complete park/bind unit under test: broker, room manager, and HTTP surface on one store. */
interface PoolFixture {
  runtime: FakeRuntime;
  clock: FakeClock;
  store: ServerStore;
  auth: AuthService;
  root: AuthContext;
  pad: Pad;
  rooms: RoomManager;
  broker: TerminalBroker;
  placement: PlaceExecutor;
  machine: FakeMachine;
  socket: FakeSocket;
  opener: SessionPeer;
  app: HttpApp;
}

function poolFixture(): PoolFixture {
  const cwd = mkdtempSync(join(tmpdir(), "manifold-terminal-pool-test-"));
  temporaryDirectories.push(cwd);
  const config = loadConfig(
    {
      MANIFOLD_PORT: "0",
      MANIFOLD_DATA_DIR: "data",
      MANIFOLD_OWNER_KEY: OWNER_KEY,
      MANIFOLD_SPAWN_AGENT: "0",
    },
    cwd,
  );
  const runtime = new FakeRuntime();
  const clock = new FakeClock(runtime);
  const store = testStore();
  const auth = new AuthService(store, OWNER_KEY, runtime);
  const root = auth.authenticate(OWNER_KEY);
  const pad: Pad = {
    id: runtime.newId(),
    name: "pool pad",
    createdAt: runtime.now(),
    layout: "canvas",
    transient: false,
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
  const placement = new PlaceExecutor(store, rooms, broker, runtime);
  broker.setPlacement(placement);
  rooms.setEmptyHandler((padId) => placement.dissolveIfBubble(padId));
  const machines = new MachineGateway(
    auth,
    store,
    broker,
    clock,
    silentLogger,
    "server-epoch",
    runtime,
  );
  const enrollment = auth.enrollMachine("pool machine", root);
  const machine = new FakeMachine(enrollment.machine.id);
  broker.setMachineOnline(machine);
  const socket = new FakeSocket();
  const opener = new SessionPeer(runtime.newId(), socket, root, pad.id, "c1");
  const app = new HttpApp(
    config,
    store,
    auth,
    rooms,
    broker,
    placement,
    machines,
    runtime,
    silentLogger,
  );
  return {
    runtime,
    clock,
    store,
    auth,
    root,
    pad,
    rooms,
    broker,
    placement,
    machine,
    socket,
    opener,
    app,
  };
}

/** Opens one terminal and commits its create, returning the new session id. */
function openTerminal(fixture: PoolFixture, elementId: string): string {
  fixture.broker.open(fixture.opener, { type: "terminal_open", elementId, cols: 80, rows: 24 });
  const creates = fixture.machine.sent.filter((message) => message.type === "create");
  const create = creates.at(-1);
  if (create === undefined || create.type !== "create") throw new Error("missing create request");
  fixture.broker.onCreated(fixture.machine.machineId, create.sessionId);
  return create.sessionId;
}

/** Materializes the pad room with the opener joined so broadcasts are observable. */
function joinedRoom(fixture: PoolFixture): Room {
  const room = fixture.rooms.get(fixture.pad.id);
  if (room === null) throw new Error("missing room");
  room.join(fixture.opener);
  return room;
}

async function call(
  fixture: PoolFixture,
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; payload: unknown }> {
  const request = new Request(
    `http://localhost${path}`,
    body === undefined
      ? { method, headers: { authorization: `Bearer ${token}` } }
      : {
          method,
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const response = await fixture.app.fetch(request);
  return { status: response.status, payload: await response.json() };
}

function padScopedToken(fixture: PoolFixture): string {
  return fixture.auth.mintToken(
    {
      principal: { name: "pad guest", kind: "human" },
      caps: ["pads:read", "pads:write", "scene:write", "terminal:write"],
      padId: fixture.pad.id,
    },
    fixture.root,
  ).token;
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("TerminalBroker park", () => {
  test("parking the last element unbinds the session into the workspace pool", () => {
    const fixture = poolFixture();
    const sessionId = openTerminal(fixture, "terminal-1");
    const room = joinedRoom(fixture);
    writeElement(room.doc, terminalElement("terminal-1", sessionId), LOCAL_ORIGIN);
    fixture.socket.clear();

    expect(parkSession(fixture.placement, fixture.pad.id, "terminal-1")).toBe("ok");

    expect(readElements(room.doc).has("terminal-1")).toBe(false);
    expect(fixture.store.getSession(sessionId)?.padId).toBeNull();
    expect(fixture.store.listParkedSessions().map((session) => session.id)).toEqual([sessionId]);
    expect(fixture.broker.listForPad(fixture.pad.id)).toEqual([]);
    expect(
      fixture.socket
        .messages()
        .filter((message) => message.type === "session_event")
        .at(-1),
    ).toEqual({ type: "session_event", sessionId, kind: "parked" });
  });

  test("parking one of two copies removes only that element and stays bound", () => {
    const fixture = poolFixture();
    const sessionId = openTerminal(fixture, "terminal-1");
    const room = joinedRoom(fixture);
    writeElement(room.doc, terminalElement("terminal-1", sessionId), LOCAL_ORIGIN);
    writeElement(room.doc, terminalElement("terminal-2", sessionId), LOCAL_ORIGIN);
    fixture.socket.clear();

    expect(parkSession(fixture.placement, fixture.pad.id, "terminal-1")).toBe("ok");

    expect([...readElements(room.doc).keys()]).toEqual(["terminal-2"]);
    expect(fixture.store.getSession(sessionId)?.padId).toBe(fixture.pad.id);
    expect(fixture.store.listParkedSessions()).toEqual([]);
    expect(fixture.socket.messages().some((message) => message.type === "session_event")).toBe(
      false,
    );
  });

  test("parking an unknown session fails, and a vanished element is refused by rule", () => {
    const fixture = poolFixture();
    const sessionId = openTerminal(fixture, "terminal-1");
    const room = joinedRoom(fixture);
    writeElement(room.doc, terminalElement("terminal-1", sessionId), LOCAL_ORIGIN);

    // The old park resolved the container from the SESSION, so an unknown session id was
    // its not_found; the envelope addresses the ELEMENT, so that case is stated directly as
    // the placement it always was.
    const unknownSession = fixture.placement.place({
      surface: { kind: "terminal", sessionId: "missing-session" },
      destination: { kind: "pool" },
    });
    expect(unknownSession.status).toBe("failed");
    if (unknownSession.status === "failed") expect(unknownSession.failure).toBe("not_found");
    expect(parkSession(fixture.placement, fixture.pad.id, "terminal-1")).toBe("ok");
    // Parking again addresses an element that no longer exists: the lookup places nothing,
    // so the algebra refuses BY RULE where the old park answered a flat "not_found".
    expect(parkSession(fixture.placement, fixture.pad.id, "terminal-1")).toBe(
      "denied:unknown_surface",
    );
  });
});

describe("TerminalBroker bind", () => {
  test("binding authors the terminal element server-side and advertises the session", () => {
    const fixture = poolFixture();
    const sessionId = openTerminal(fixture, "terminal-1");
    const room = joinedRoom(fixture);
    writeElement(room.doc, terminalElement("terminal-1", sessionId), LOCAL_ORIGIN);
    parkSession(fixture.placement, fixture.pad.id, "terminal-1");
    fixture.socket.clear();

    const bound = placeSession(fixture.placement, sessionId, fixture.pad.id, "canvas", {
      x: 40,
      y: 60,
    });
    if (typeof bound === "string") throw new Error(`placement failed: ${bound}`);

    expect(readElement(room.doc, bound.placementId)).toEqual({
      id: bound.placementId,
      type: "terminal",
      sessionId,
      x: 40,
      y: 60,
      width: DEFAULT_TERMINAL_WIDTH,
      height: DEFAULT_TERMINAL_HEIGHT,
      zIndex: 0,
    });
    expect(fixture.store.getSession(sessionId)?.padId).toBe(fixture.pad.id);
    expect(fixture.store.listParkedSessions()).toEqual([]);
    expect(fixture.broker.listForPad(fixture.pad.id).map((session) => session.id)).toEqual([
      sessionId,
    ]);
    const advertised = fixture.socket
      .messages()
      .filter((message) => message.type === "terminal_opened")
      .at(-1);
    expect(advertised).toMatchObject({
      type: "terminal_opened",
      elementId: bound.placementId,
      session: { id: sessionId, padId: fixture.pad.id, status: "running" },
    });
  });

  test("binding without coordinates uses the default canvas placement", () => {
    const fixture = poolFixture();
    const sessionId = openTerminal(fixture, "terminal-1");
    const room = joinedRoom(fixture);
    writeElement(room.doc, terminalElement("terminal-1", sessionId), LOCAL_ORIGIN);
    parkSession(fixture.placement, fixture.pad.id, "terminal-1");

    const bound = placeSession(fixture.placement, sessionId, fixture.pad.id, "canvas");
    if (typeof bound === "string") throw new Error(`placement failed: ${bound}`);

    expect(readElement(room.doc, bound.placementId)).toMatchObject({ x: 160, y: 120 });
  });

  test("placing a bound terminal repositions it, and unknown ids are refused", () => {
    const fixture = poolFixture();
    const sessionId = openTerminal(fixture, "terminal-1");
    const room = joinedRoom(fixture);
    writeElement(room.doc, terminalElement("terminal-1", sessionId), LOCAL_ORIGIN);

    // Reposition-as-placement: a terminal already on this canvas MOVES, so the old
    // "already_bound" refusal has no successor — the same element is placed again.
    expect(placeSession(fixture.placement, sessionId, fixture.pad.id, "canvas")).toEqual({
      placementId: "terminal-1",
    });
    expect(placeSession(fixture.placement, "missing-session", fixture.pad.id, "canvas")).toBe(
      "not_found",
    );
    parkSession(fixture.placement, fixture.pad.id, "terminal-1");
    // An unknown container is a DENIAL naming the rule, never the old "pad_not_found".
    expect(placeSession(fixture.placement, sessionId, "missing-pad", "canvas")).toBe(
      "denied:unknown_container",
    );
  });
});

describe("TerminalBroker pool lifecycle", () => {
  test("killById terminates a parked session no pad room can reach", () => {
    const fixture = poolFixture();
    const sessionId = openTerminal(fixture, "terminal-1");
    const room = joinedRoom(fixture);
    writeElement(room.doc, terminalElement("terminal-1", sessionId), LOCAL_ORIGIN);
    parkSession(fixture.placement, fixture.pad.id, "terminal-1");
    fixture.machine.clear();

    expect(fixture.broker.killById(sessionId)).toBe("ok");

    expect(fixture.machine.sent).toEqual([{ type: "kill", sessionId }]);
    expect(fixture.broker.killById("missing-session")).toBe("not_found");
    fixture.broker.onExited(fixture.machine.machineId, sessionId, 0);
    expect(fixture.broker.killById(sessionId)).toBe("conflict");
  });

  test("a parked session exits without broadcasting to the pad it left", () => {
    const fixture = poolFixture();
    const sessionId = openTerminal(fixture, "terminal-1");
    const room = joinedRoom(fixture);
    writeElement(room.doc, terminalElement("terminal-1", sessionId), LOCAL_ORIGIN);
    parkSession(fixture.placement, fixture.pad.id, "terminal-1");
    fixture.socket.clear();

    fixture.broker.onExited(fixture.machine.machineId, sessionId, 3);

    expect(fixture.socket.messages().some((message) => message.type === "session_event")).toBe(
      false,
    );
    const stored = fixture.store.getSession(sessionId);
    expect(stored?.status).toBe("exited");
    expect(stored?.exitCode).toBe(3);
    expect(stored?.padId).toBeNull();
  });

  test("pruneExitedParked collects exited pool entries only", () => {
    const fixture = poolFixture();
    const parkedId = openTerminal(fixture, "terminal-1");
    const boundId = openTerminal(fixture, "terminal-2");
    const room = joinedRoom(fixture);
    writeElement(room.doc, terminalElement("terminal-1", parkedId), LOCAL_ORIGIN);
    writeElement(room.doc, terminalElement("terminal-2", boundId), LOCAL_ORIGIN);
    parkSession(fixture.placement, fixture.pad.id, "terminal-1");
    fixture.broker.onExited(fixture.machine.machineId, parkedId, 0);
    fixture.broker.onExited(fixture.machine.machineId, boundId, 0);

    fixture.broker.pruneExitedParked();

    expect(fixture.store.getSession(parkedId)).toBeNull();
    expect(fixture.store.getSession(boundId)?.status).toBe("exited");
    expect(fixture.broker.introspect().map((session) => session.id)).toEqual([boundId]);
  });

  test("a running parked session survives pruning", () => {
    const fixture = poolFixture();
    const sessionId = openTerminal(fixture, "terminal-1");
    const room = joinedRoom(fixture);
    writeElement(room.doc, terminalElement("terminal-1", sessionId), LOCAL_ORIGIN);
    parkSession(fixture.placement, fixture.pad.id, "terminal-1");

    fixture.broker.pruneExitedParked();

    expect(fixture.store.listParkedSessions().map((session) => session.id)).toEqual([sessionId]);
  });
});

describe("TerminalBroker rename", () => {
  test("renaming a bound session persists the name and publishes it to the room", () => {
    const fixture = poolFixture();
    const sessionId = openTerminal(fixture, "terminal-1");
    const room = joinedRoom(fixture);
    writeElement(room.doc, terminalElement("terminal-1", sessionId), LOCAL_ORIGIN);
    fixture.socket.clear();

    expect(fixture.broker.rename(sessionId, "build")).toBe("ok");

    expect(fixture.store.getSession(sessionId)?.name).toBe("build");
    expect(fixture.broker.listForPad(fixture.pad.id).map((session) => session.name)).toEqual([
      "build",
    ]);
    expect(
      fixture.socket
        .messages()
        .filter((message) => message.type === "session_event")
        .at(-1),
    ).toEqual({ type: "session_event", sessionId, kind: "renamed", name: "build" });
  });

  test("renaming a parked session persists without any room broadcast", () => {
    const fixture = poolFixture();
    const sessionId = openTerminal(fixture, "terminal-1");
    const room = joinedRoom(fixture);
    writeElement(room.doc, terminalElement("terminal-1", sessionId), LOCAL_ORIGIN);
    parkSession(fixture.placement, fixture.pad.id, "terminal-1");
    fixture.socket.clear();

    expect(fixture.broker.rename(sessionId, "notes")).toBe("ok");

    expect(fixture.store.getSession(sessionId)?.name).toBe("notes");
    expect(fixture.store.listParkedSessions().map((session) => session.name)).toEqual(["notes"]);
    expect(fixture.socket.messages().some((message) => message.type === "session_event")).toBe(
      false,
    );
  });

  test("renaming an unknown session reports not_found", () => {
    const fixture = poolFixture();

    expect(fixture.broker.rename("missing-session", "build")).toBe("not_found");
  });

  test("a rename survives into the session advert a rebind publishes", () => {
    const fixture = poolFixture();
    const sessionId = openTerminal(fixture, "terminal-1");
    const room = joinedRoom(fixture);
    writeElement(room.doc, terminalElement("terminal-1", sessionId), LOCAL_ORIGIN);
    parkSession(fixture.placement, fixture.pad.id, "terminal-1");
    fixture.broker.rename(sessionId, "build");
    fixture.socket.clear();

    const bound = placeSession(fixture.placement, sessionId, fixture.pad.id, "canvas");
    if (typeof bound === "string") throw new Error(`placement failed: ${bound}`);

    expect(
      fixture.socket
        .messages()
        .filter((message) => message.type === "terminal_opened")
        .at(-1),
    ).toMatchObject({ session: { id: sessionId, name: "build" } });
  });
});

describe("TerminalBroker pool ordering", () => {
  test("parking appends to the end of the pool", () => {
    const fixture = poolFixture();
    const first = openTerminal(fixture, "terminal-1");
    const second = openTerminal(fixture, "terminal-2");
    const third = openTerminal(fixture, "terminal-3");
    const room = joinedRoom(fixture);
    writeElement(room.doc, terminalElement("terminal-1", first), LOCAL_ORIGIN);
    writeElement(room.doc, terminalElement("terminal-2", second), LOCAL_ORIGIN);
    writeElement(room.doc, terminalElement("terminal-3", third), LOCAL_ORIGIN);

    parkSession(fixture.placement, fixture.pad.id, "terminal-2");
    parkSession(fixture.placement, fixture.pad.id, "terminal-3");
    parkSession(fixture.placement, fixture.pad.id, "terminal-1");

    expect(fixture.store.listParkedSessions().map((session) => session.sortOrder)).toEqual([
      0, 1, 2,
    ]);
    expect(fixture.store.listParkedSessions().map((session) => session.id)).toEqual([
      second,
      third,
      first,
    ]);
  });

  test("moving a pooled terminal rewrites contiguous positions", () => {
    const fixture = poolFixture();
    const first = openTerminal(fixture, "terminal-1");
    const second = openTerminal(fixture, "terminal-2");
    const third = openTerminal(fixture, "terminal-3");
    const room = joinedRoom(fixture);
    writeElement(room.doc, terminalElement("terminal-1", first), LOCAL_ORIGIN);
    writeElement(room.doc, terminalElement("terminal-2", second), LOCAL_ORIGIN);
    writeElement(room.doc, terminalElement("terminal-3", third), LOCAL_ORIGIN);
    parkSession(fixture.placement, fixture.pad.id, "terminal-1");
    parkSession(fixture.placement, fixture.pad.id, "terminal-2");
    parkSession(fixture.placement, fixture.pad.id, "terminal-3");

    expect(fixture.broker.movePooled(third, 0)).toBe("ok");

    expect(fixture.store.listParkedSessions().map((session) => session.id)).toEqual([
      third,
      first,
      second,
    ]);
    expect(fixture.store.listParkedSessions().map((session) => session.sortOrder)).toEqual([
      0, 1, 2,
    ]);

    // An index past the end clamps to the tail instead of leaving a sparse hole.
    expect(fixture.broker.movePooled(third, 99)).toBe("ok");
    expect(fixture.store.listParkedSessions().map((session) => session.id)).toEqual([
      first,
      second,
      third,
    ]);
    expect(fixture.store.listParkedSessions().map((session) => session.sortOrder)).toEqual([
      0, 1, 2,
    ]);
  });

  test("moving a bound or unknown terminal reports conflict and not_found", () => {
    const fixture = poolFixture();
    const sessionId = openTerminal(fixture, "terminal-1");
    const room = joinedRoom(fixture);
    writeElement(room.doc, terminalElement("terminal-1", sessionId), LOCAL_ORIGIN);

    expect(fixture.broker.movePooled(sessionId, 0)).toBe("conflict");
    expect(fixture.broker.movePooled("missing-session", 0)).toBe("not_found");
  });
});

describe("terminal pool HTTP routes", () => {
  test("a pad-scoped token cannot read the terminal pool", async () => {
    const fixture = poolFixture();

    const response = await call(fixture, "GET", "/api/terminals", padScopedToken(fixture));

    expect(response.status).toBe(403);
    expect(response.payload).toMatchObject({ error: { code: "forbidden" } });
  });

  test("a pad-scoped token cannot park, bind, or kill a terminal", async () => {
    const fixture = poolFixture();
    const sessionId = openTerminal(fixture, "terminal-1");
    const token = padScopedToken(fixture);

    const park = await call(fixture, "POST", "/api/place", token, {
      surface: { kind: "element", padId: fixture.pad.id, elementId: "terminal-1" },
      destination: { kind: "pool" },
    });
    const bind = await call(fixture, "POST", "/api/place", token, {
      surface: { kind: "terminal", sessionId },
      destination: { kind: "canvas", padId: fixture.pad.id, x: 0, y: 0 },
    });
    const kill = await call(fixture, "DELETE", `/api/terminals/${sessionId}`, token);

    expect([park.status, bind.status, kill.status]).toEqual([403, 403, 403]);
    expect(fixture.store.getSession(sessionId)?.padId).toBe(fixture.pad.id);
  });

  test("the pool lists parked sessions and prunes exited ones", async () => {
    const fixture = poolFixture();
    const runningId = openTerminal(fixture, "terminal-1");
    const exitedId = openTerminal(fixture, "terminal-2");
    const room = joinedRoom(fixture);
    writeElement(room.doc, terminalElement("terminal-1", runningId), LOCAL_ORIGIN);
    writeElement(room.doc, terminalElement("terminal-2", exitedId), LOCAL_ORIGIN);
    parkSession(fixture.placement, fixture.pad.id, "terminal-1");
    parkSession(fixture.placement, fixture.pad.id, "terminal-2");
    fixture.broker.onExited(fixture.machine.machineId, exitedId, 0);

    const response = await call(fixture, "GET", "/api/terminals", OWNER_KEY);

    expect(response.status).toBe(200);
    expect(response.payload).toEqual({
      terminals: [
        {
          id: runningId,
          machineId: fixture.machine.machineId,
          name: null,
          createdAt: 0,
          status: "running",
          exitCode: null,
          sortOrder: 0,
        },
      ],
    });
  });

  test("parking through HTTP removes the element and maps a missing terminal to 404", async () => {
    const fixture = poolFixture();
    const sessionId = openTerminal(fixture, "terminal-1");
    const room = joinedRoom(fixture);
    writeElement(room.doc, terminalElement("terminal-1", sessionId), LOCAL_ORIGIN);

    const parked = await call(fixture, "POST", "/api/place", OWNER_KEY, {
      surface: { kind: "element", padId: fixture.pad.id, elementId: "terminal-1" },
      destination: { kind: "pool" },
    });
    const missing = await call(fixture, "POST", "/api/place", OWNER_KEY, {
      surface: { kind: "terminal", sessionId: "missing-session" },
      destination: { kind: "pool" },
    });

    expect(parked.status).toBe(200);
    // The envelope answers with the op it executed where the park route answered `ok`.
    expect(parked.payload).toEqual({ op: "park" });
    expect(readElements(room.doc).size).toBe(0);
    expect(missing.status).toBe(404);
    expect(missing.payload).toMatchObject({ error: { code: "not_found" } });
  });

  test("binding through HTTP returns the server-authored element id", async () => {
    const fixture = poolFixture();
    const sessionId = openTerminal(fixture, "terminal-1");
    const room = joinedRoom(fixture);
    writeElement(room.doc, terminalElement("terminal-1", sessionId), LOCAL_ORIGIN);
    parkSession(fixture.placement, fixture.pad.id, "terminal-1");

    const response = await call(fixture, "POST", "/api/place", OWNER_KEY, {
      surface: { kind: "terminal", sessionId },
      destination: { kind: "canvas", padId: fixture.pad.id, x: 12, y: 34 },
    });

    expect(response.status).toBe(200);
    const payload = PlaceResponseSchema.parse(response.payload);
    if (payload.op !== "bind") throw new Error("bind response expected");
    expect(readElement(room.doc, payload.elementId)).toMatchObject({ sessionId, x: 12, y: 34 });
  });

  test("placing a bound terminal repositions it and an unknown container is a denial", async () => {
    const fixture = poolFixture();
    const sessionId = openTerminal(fixture, "terminal-1");
    const room = joinedRoom(fixture);
    writeElement(room.doc, terminalElement("terminal-1", sessionId), LOCAL_ORIGIN);

    const repositioned = await call(fixture, "POST", "/api/place", OWNER_KEY, {
      surface: { kind: "terminal", sessionId },
      destination: { kind: "canvas", padId: fixture.pad.id, x: 5, y: 6 },
    });

    // Reposition-as-placement: a terminal already on this canvas MOVES instead of being
    // refused, so the bind route's 409 for an already-bound terminal has no successor.
    expect(repositioned.status).toBe(200);
    expect(readElement(room.doc, "terminal-1")).toMatchObject({ x: 5, y: 6 });

    parkSession(fixture.placement, fixture.pad.id, "terminal-1");
    const missingPad = await call(fixture, "POST", "/api/place", OWNER_KEY, {
      surface: { kind: "terminal", sessionId },
      destination: { kind: "canvas", padId: "missing-pad", x: 0, y: 0 },
    });

    // An unknown container is a placement DENIAL carried as data, never the old 404.
    expect(missingPad.status).toBe(409);
    expect(missingPad.payload).toMatchObject({
      error: { code: PLACEMENT_DENIED_CODE, denial: { rule: "unknown_container" } },
    });
  });

  test("deleting a pooled terminal kills it once, then reports 409 and 404", async () => {
    const fixture = poolFixture();
    const sessionId = openTerminal(fixture, "terminal-1");
    const room = joinedRoom(fixture);
    writeElement(room.doc, terminalElement("terminal-1", sessionId), LOCAL_ORIGIN);
    parkSession(fixture.placement, fixture.pad.id, "terminal-1");
    fixture.machine.clear();

    const killed = await call(fixture, "DELETE", `/api/terminals/${sessionId}`, OWNER_KEY);
    fixture.broker.onExited(fixture.machine.machineId, sessionId, 0);
    const again = await call(fixture, "DELETE", `/api/terminals/${sessionId}`, OWNER_KEY);
    const missing = await call(fixture, "DELETE", "/api/terminals/missing", OWNER_KEY);

    expect(killed.status).toBe(200);
    expect(killed.payload).toEqual({ ok: true });
    expect(fixture.machine.sent).toEqual([{ type: "kill", sessionId }]);
    expect(again.status).toBe(409);
    expect(again.payload).toMatchObject({ error: { code: "conflict" } });
    expect(missing.status).toBe(404);
    expect(missing.payload).toMatchObject({ error: { code: "not_found" } });
  });

  test("the pad session listing omits parked sessions", async () => {
    const fixture = poolFixture();
    const parkedId = openTerminal(fixture, "terminal-1");
    const boundId = openTerminal(fixture, "terminal-2");
    const room = joinedRoom(fixture);
    writeElement(room.doc, terminalElement("terminal-1", parkedId), LOCAL_ORIGIN);
    writeElement(room.doc, terminalElement("terminal-2", boundId), LOCAL_ORIGIN);
    parkSession(fixture.placement, fixture.pad.id, "terminal-1");

    const response = await call(fixture, "GET", "/api/pad-sessions", OWNER_KEY);

    expect(response.status).toBe(200);
    expect(response.payload).toMatchObject({ sessions: [{ id: boundId, padId: fixture.pad.id }] });
  });

  test("renaming through HTTP trims the name and maps a missing terminal to 404", async () => {
    const fixture = poolFixture();
    const sessionId = openTerminal(fixture, "terminal-1");
    const room = joinedRoom(fixture);
    writeElement(room.doc, terminalElement("terminal-1", sessionId), LOCAL_ORIGIN);

    const renamed = await call(fixture, "PATCH", `/api/terminals/${sessionId}`, OWNER_KEY, {
      name: "  build  ",
    });
    const blank = await call(fixture, "PATCH", `/api/terminals/${sessionId}`, OWNER_KEY, {
      name: "   ",
    });
    const missing = await call(fixture, "PATCH", "/api/terminals/missing", OWNER_KEY, {
      name: "build",
    });

    expect(renamed.status).toBe(200);
    expect(renamed.payload).toEqual({ ok: true });
    expect(fixture.store.getSession(sessionId)?.name).toBe("build");
    expect(blank.status).toBe(400);
    expect(blank.payload).toMatchObject({ error: { code: "invalid" } });
    expect(missing.status).toBe(404);
    expect(missing.payload).toMatchObject({ error: { code: "not_found" } });
  });

  test("a pad-scoped token cannot rename or reorder terminals", async () => {
    const fixture = poolFixture();
    const sessionId = openTerminal(fixture, "terminal-1");
    const token = padScopedToken(fixture);

    const renamed = await call(fixture, "PATCH", `/api/terminals/${sessionId}`, token, {
      name: "build",
    });
    const moved = await call(fixture, "PUT", "/api/terminal-pool", token, { sessionId, index: 0 });

    expect([renamed.status, moved.status]).toEqual([403, 403]);
    expect(fixture.store.getSession(sessionId)?.name).toBeNull();
  });

  test("the pool response carries names and answers a move with the new order", async () => {
    const fixture = poolFixture();
    const first = openTerminal(fixture, "terminal-1");
    const second = openTerminal(fixture, "terminal-2");
    const room = joinedRoom(fixture);
    writeElement(room.doc, terminalElement("terminal-1", first), LOCAL_ORIGIN);
    writeElement(room.doc, terminalElement("terminal-2", second), LOCAL_ORIGIN);
    parkSession(fixture.placement, fixture.pad.id, "terminal-1");
    parkSession(fixture.placement, fixture.pad.id, "terminal-2");
    await call(fixture, "PATCH", `/api/terminals/${second}`, OWNER_KEY, { name: "notes" });

    const moved = await call(fixture, "PUT", "/api/terminal-pool", OWNER_KEY, {
      sessionId: second,
      index: 0,
    });
    const listed = await call(fixture, "GET", "/api/terminals", OWNER_KEY);

    expect(moved.status).toBe(200);
    expect(moved.payload).toMatchObject({
      terminals: [
        { id: second, name: "notes", sortOrder: 0 },
        { id: first, name: null, sortOrder: 1 },
      ],
    });
    expect(listed.payload).toEqual(moved.payload);
  });

  test("moving a bound terminal is a 409 and an unknown one a 404", async () => {
    const fixture = poolFixture();
    const sessionId = openTerminal(fixture, "terminal-1");
    const room = joinedRoom(fixture);
    writeElement(room.doc, terminalElement("terminal-1", sessionId), LOCAL_ORIGIN);

    const conflict = await call(fixture, "PUT", "/api/terminal-pool", OWNER_KEY, {
      sessionId,
      index: 0,
    });
    const missing = await call(fixture, "PUT", "/api/terminal-pool", OWNER_KEY, {
      sessionId: "missing-session",
      index: 0,
    });

    expect(conflict.status).toBe(409);
    expect(conflict.payload).toMatchObject({ error: { code: "conflict" } });
    expect(missing.status).toBe(404);
    expect(missing.payload).toMatchObject({ error: { code: "not_found" } });
  });
});
