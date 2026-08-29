import { expect, test } from "bun:test";
import {
  HttpErrorSchema,
  OkResponseSchema,
  PlaceRequestSchema,
  PlaceResponseSchema,
  TerminalPoolResponseSchema,
  type HttpError,
  type TerminalPoolEntry,
} from "@manifold/protocol";
import type { SessionClient } from "@manifold/sdk";
import {
  connect,
  createPad,
  enrollMachine,
  mintToken,
  ownerFetch,
  startAgent,
  startServer,
  waitFor,
  type TestAgent,
  type TestServer,
} from "../src/index.ts";
import {
  captureTerminal,
  closeClients,
  e2eFailure,
  nextMessage,
  stopProcesses,
  terminalElement,
  waitForTerminalText,
  type TerminalCapture,
} from "./helpers.ts";

// The typed command never contains the sentinel literally (the format string hides it),
// so finding it in a replayed buffer proves real PTY output survived park/bind.
const SENTINEL = "pool-sentinel-42";
const SENTINEL_COMMAND = "printf 'pool-sentinel-%s\\n' 42\n";
const JSON_HEADERS = { "content-type": "application/json" } as const;

interface ScopedResponse {
  readonly status: number;
  readonly body: HttpError;
}

/** Calls the JSON API with a non-owner bearer token so capability denials are observable. */
async function fetchAsPrincipal(
  server: TestServer,
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<ScopedResponse> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  headers.set("accept", "application/json");
  const signal = init.signal ?? AbortSignal.timeout(15_000);
  const response = await fetch(new URL(path, server.httpUrl), { ...init, headers, signal });
  const text = await response.text();
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch (error) {
    throw new Error(`HTTP ${response.status} returned non-JSON`, { cause: error });
  }
  return { status: response.status, body: HttpErrorSchema.parse(decoded) };
}

/** Lists the workspace terminal pool through the owner boundary. */
async function listPool(server: TestServer): Promise<readonly TerminalPoolEntry[]> {
  const listing = await ownerFetch(server, "/api/terminals", {
    responseSchema: TerminalPoolResponseSchema,
  });
  return listing.terminals;
}

/**
 * The retired verbs, over the ONE envelope. `POST /api/place` replaced bind, park, add-tile,
 * compose and extract; naming the two gestures this test is about keeps it readable while
 * proving the envelope covers both, and asserting the returned `op` is how the test states
 * WHICH placement the declarations chose for the pair it offered.
 */
async function park(server: TestServer, padId: string, elementId: string): Promise<string> {
  const placed = await ownerFetch(server, "/api/place", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(
      PlaceRequestSchema.parse({
        surface: { kind: "element", padId, elementId },
        destination: { kind: "pool" },
      }),
    ),
    responseSchema: PlaceResponseSchema,
  });
  return placed.op;
}

async function placeOnCanvas(
  server: TestServer,
  sessionId: string,
  padId: string,
  x: number,
  y: number,
): Promise<string> {
  const placed = await ownerFetch(server, "/api/place", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(
      PlaceRequestSchema.parse({
        surface: { kind: "terminal", sessionId },
        destination: { kind: "canvas", padId, x, y },
      }),
    ),
    responseSchema: PlaceResponseSchema,
  });
  if (placed.op !== "bind") throw new Error(`expected a bind, got ${placed.op}`);
  return placed.elementId;
}

test("the terminal pool parks, rebinds, and kills a live session without losing its buffer", async () => {
  const servers: TestServer[] = [];
  const agents: TestAgent[] = [];
  const clients: SessionClient[] = [];
  const captures: TerminalCapture[] = [];
  try {
    const server = await startServer();
    servers.push(server);
    const pad = await createPad(server, "terminal pool");
    const enrolled = await enrollMachine(server, "pool-agent");
    const agent = await startAgent({
      serverUrl: server.url,
      machineToken: enrolled.machineToken,
      name: "pool-agent",
    });
    agents.push(agent);

    // Workspace-scoped (padId omitted): the pool routes reject pad-scoped tokens outright.
    const owner = await mintToken(server, {
      principal: { kind: "human", name: "Pool Owner", color: "#3fa46b" },
      caps: ["pads:read", "pads:write", "scene:write", "terminal:spawn", "terminal:write"],
    });
    const client = await connect(server, { padId: pad.id, token: owner.token, reconnect: false });
    clients.push(client);

    const session = await client.openTerminal({ elementId: "el-pool-1", cols: 80, rows: 24 });
    expect(session.status).toBe("running");
    expect(session.padId).toBe(pad.id);
    client.transact((tx) => {
      tx.create(terminalElement("el-pool-1", { sessionId: session.id }));
    });
    await waitFor(() => client.elements.has("el-pool-1"), 10_000, 20);

    const capture = captureTerminal(client, session.id);
    captures.push(capture);
    client.attachTerminal(session.id);
    await waitFor(() => capture.snapshotSeq !== null, 10_000, 20);
    client.sendTerminalInput(session.id, SENTINEL_COMMAND);
    await waitForTerminalText(capture, SENTINEL, 10_000);

    // Park: the server removes the element and unbinds the last reference.
    const parkedEvent = nextMessage(
      client,
      "session_event",
      10_000,
      (message) => message.sessionId === session.id && message.kind === "parked",
    );
    const parked = await park(server, pad.id, "el-pool-1");
    expect(parked).toBe("park");
    expect((await parkedEvent).kind).toBe("parked");
    await waitFor(() => !client.elements.has("el-pool-1"), 10_000, 20);
    await waitFor(() => !client.sessions.has(session.id), 10_000, 20);
    expect(client.sessions.has(session.id)).toBe(false);

    const pooled = await listPool(server);
    const listed = pooled.find((candidate) => candidate.id === session.id);
    expect(listed).toMatchObject({
      id: session.id,
      machineId: enrolled.machineId,
      status: "running",
      exitCode: null,
    });
    expect(listed?.createdAt).toBeNumber();

    // Rename: the name is session state, not pad state, so a parked terminal is
    // renameable and the pool listing carries the label.
    const renamed = await ownerFetch(server, `/api/terminals/${session.id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: "build box" }),
      responseSchema: OkResponseSchema,
    });
    expect(renamed.ok).toBe(true);
    expect((await listPool(server)).map((entry) => entry.name)).toEqual(["build box"]);

    // Order: parking appends, and a move rewrites the pool into contiguous positions.
    const second = await client.openTerminal({ elementId: "el-pool-2", cols: 80, rows: 24 });
    client.transact((tx) => {
      tx.create(terminalElement("el-pool-2", { sessionId: second.id }));
    });
    await waitFor(() => client.elements.has("el-pool-2"), 10_000, 20);
    await park(server, pad.id, "el-pool-2");
    await waitFor(async () => (await listPool(server)).length === 2, 10_000, 50);
    expect((await listPool(server)).map((entry) => entry.id)).toEqual([session.id, second.id]);

    const moved = await ownerFetch(server, "/api/terminal-pool", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ sessionId: second.id, index: 0 }),
      responseSchema: TerminalPoolResponseSchema,
    });
    expect(moved.terminals.map((entry) => entry.id)).toEqual([second.id, session.id]);
    expect(moved.terminals.map((entry) => entry.sortOrder)).toEqual([0, 1]);
    expect((await listPool(server)).map((entry) => entry.id)).toEqual([second.id, session.id]);

    // Back to a single pool entry so the kill/prune assertions below stay exact.
    await ownerFetch(server, `/api/terminals/${second.id}`, {
      method: "DELETE",
      responseSchema: OkResponseSchema,
    });
    await waitFor(async () => (await listPool(server)).length === 1, 15_000, 100);

    // Bind: a terminal placed on a CANVAS at a point. The server authors the element, so
    // the response carries the placement the caller renders.
    const boundElementId = await placeOnCanvas(server, session.id, pad.id, 240, 180);
    expect(boundElementId).not.toBe("el-pool-1");
    await waitFor(() => client.elements.has(boundElementId), 10_000, 20);
    const rebound = client.elements.get(boundElementId);
    if (rebound?.type !== "terminal") throw new Error("the placement authored no terminal element");
    expect(rebound.sessionId).toBe(session.id);
    expect(rebound.x).toBe(240);
    expect(rebound.y).toBe(180);
    await waitFor(() => client.sessions.get(session.id)?.status === "running", 10_000, 20);
    expect(client.sessions.get(session.id)?.padId).toBe(pad.id);
    // The name survives park/bind and travels inside the rebind's SessionInfo advert.
    expect(client.sessions.get(session.id)?.name).toBe("build box");

    // A bound rename publishes the new label to every joined client.
    const renamedEvent = nextMessage(
      client,
      "session_event",
      10_000,
      (message) => message.sessionId === session.id && message.kind === "renamed",
    );
    await ownerFetch(server, `/api/terminals/${session.id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: "build box 2" }),
      responseSchema: OkResponseSchema,
    });
    expect((await renamedEvent).name).toBe("build box 2");
    await waitFor(() => client.sessions.get(session.id)?.name === "build box 2", 10_000, 20);

    // No-gap invariant across park/bind: a client that attaches only after the rebind
    // must still receive the pre-park screen state, and no output may precede its snapshot.
    const replay = await connect(server, { padId: pad.id, token: owner.token, reconnect: false });
    clients.push(replay);
    await waitFor(() => replay.sessions.has(session.id), 10_000, 20);
    const replayCapture = captureTerminal(replay, session.id);
    captures.push(replayCapture);
    replay.attachTerminal(session.id);
    await waitFor(() => replayCapture.snapshotSeq !== null, 10_000, 20);
    expect(replayCapture.pendingOutputCount).toBe(0);
    // Nothing writes to the PTY after the rebind, so the snapshot is the only possible
    // source of the sentinel here.
    await waitForTerminalText(replayCapture, SENTINEL, 10_000);

    // Park again, then kill from the pool: the exited row is pruned on the next listing.
    const reparked = nextMessage(
      client,
      "session_event",
      10_000,
      (message) => message.sessionId === session.id && message.kind === "parked",
    );
    await park(server, pad.id, boundElementId);
    await reparked;
    await waitFor(() => !client.elements.has(boundElementId), 10_000, 20);
    await waitFor(async () => (await listPool(server)).length === 1, 10_000, 50);

    const killed = await ownerFetch(server, `/api/terminals/${session.id}`, {
      method: "DELETE",
      responseSchema: OkResponseSchema,
    });
    expect(killed.ok).toBe(true);
    await waitFor(
      () =>
        agent.output.stdout.some(
          (line) =>
            line.includes('"evt":"exited"') &&
            line.includes(`"sessionId":${JSON.stringify(session.id)}`),
        ),
      15_000,
      20,
    );
    await waitFor(async () => (await listPool(server)).length === 0, 15_000, 100);
    expect(await listPool(server)).toEqual([]);

    // Pad-scoped tokens are rejected before any surface lookup, so a dead id still proves
    // the scope gate rather than a 404.
    const scoped = await mintToken(server, {
      principal: { kind: "human", name: "Pool Scoped", color: "#8a5cf6" },
      caps: ["pads:read", "pads:write", "scene:write", "terminal:spawn", "terminal:write"],
      padId: pad.id,
    });
    const scopedList = await fetchAsPrincipal(server, scoped.token, "/api/terminals");
    expect(scopedList.status).toBe(403);
    expect(scopedList.body.error.code).toBe("forbidden");
    const scopedPark = await fetchAsPrincipal(server, scoped.token, "/api/place", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(
        PlaceRequestSchema.parse({
          surface: { kind: "element", padId: pad.id, elementId: "el-pool-1" },
          destination: { kind: "pool" },
        }),
      ),
    });
    expect(scopedPark.status).toBe(403);
    expect(scopedPark.body.error.code).toBe("forbidden");
  } catch (error) {
    throw e2eFailure(error, [...servers, ...agents]);
  } finally {
    for (const capture of captures) capture.stop();
    closeClients(clients);
    await stopProcesses([...servers, ...agents]);
  }
}, 60_000);
