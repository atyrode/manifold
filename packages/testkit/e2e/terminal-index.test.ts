import { expect, test } from "bun:test";
import {
  HttpErrorSchema,
  OkResponseSchema,
  PlaceRequestSchema,
  RenameTerminalRequestSchema,
  TerminalsResponseSchema,
  type HttpError,
  type TerminalSummary,
} from "@manifold/protocol";
import type { SessionClient } from "@manifold/sdk";
import {
  HttpResponseError,
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
import { closeClients, e2eFailure, nextMessage, openTerminalAt, stopProcesses } from "./helpers.ts";

/**
 * THE terminal index, over real processes. There is no pool any more: every terminal lives
 * in a composition, so `GET /api/terminals` lists them ALL — the ones a canvas references and
 * the ones nothing references — and `unplaced` is derived from the containment graph rather
 * than stored beside a sort order. Renaming and killing are the only verbs left on a row.
 */

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

async function listTerminals(server: TestServer): Promise<readonly TerminalSummary[]> {
  const listing = await ownerFetch(server, "/api/terminals", {
    responseSchema: TerminalsResponseSchema,
  });
  return listing.terminals;
}

async function terminalRow(
  server: TestServer,
  sessionId: string,
): Promise<TerminalSummary | undefined> {
  return (await listTerminals(server)).find((terminal) => terminal.id === sessionId);
}

test("the terminal index lists every terminal, placed or not, and renames and kills through it", async () => {
  const servers: TestServer[] = [];
  const agents: TestAgent[] = [];
  const clients: SessionClient[] = [];
  try {
    const server = await startServer();
    servers.push(server);
    const pad = await createPad(server, "terminal index canvas");
    const enrolled = await enrollMachine(server, "index-agent");
    const agent = await startAgent({
      serverUrl: server.url,
      machineToken: enrolled.machineToken,
      name: "index-agent",
    });
    agents.push(agent);

    // Workspace-scoped: the index and the placement endpoint both cross containers, so they
    // reject pad-scoped grants outright — proven at the end of this test.
    const owner = await mintToken(server, {
      principal: { kind: "human", name: "Index Owner", color: "#3fa46b" },
      caps: ["pads:read", "pads:write", "scene:write", "terminal:spawn", "terminal:write"],
    });
    const canvas = await connect(server, { padId: pad.id, token: owner.token, reconnect: false });
    clients.push(canvas);

    const placed = await openTerminalAt(canvas, server, {
      elementId: "el-indexed-placed",
      token: owner.token,
      portalAt: { x: 200, y: 160 },
    });
    const loose = await openTerminalAt(canvas, server, {
      elementId: "el-indexed-loose",
      token: owner.token,
    });
    clients.push(placed.homeClient, loose.homeClient);
    expect(placed.session.padId).not.toBe(loose.session.padId);

    // Both terminals are indexed. The only difference between them is whether anything
    // references the composition each lives in.
    const listing = await listTerminals(server);
    expect(listing).toHaveLength(2);
    expect(listing.find((row) => row.id === placed.session.id)).toEqual({
      id: placed.session.id,
      machineId: enrolled.machineId,
      name: null,
      createdAt: expect.any(Number),
      status: "running",
      exitCode: null,
      homeId: placed.session.padId,
      unplaced: false,
    });
    expect(listing.find((row) => row.id === loose.session.id)).toMatchObject({
      id: loose.session.id,
      homeId: loose.session.padId,
      status: "running",
      unplaced: true,
    });

    // Rename: the label is SESSION state, not container state, so it publishes to every room
    // joined to the composition the terminal lives in and shows up on the row.
    const renamed = nextMessage(
      loose.homeClient,
      "session_event",
      10_000,
      (message) => message.sessionId === loose.session.id && message.kind === "renamed",
    );
    await ownerFetch(server, `/api/terminals/${loose.session.id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify(RenameTerminalRequestSchema.parse({ name: "build box" })),
      responseSchema: OkResponseSchema,
    });
    expect((await renamed).name).toBe("build box");
    await waitFor(
      () => loose.homeClient.sessions.get(loose.session.id)?.name === "build box",
      10_000,
      20,
    );
    expect((await terminalRow(server, loose.session.id))?.name).toBe("build box");

    // Kill through the index: the PTY dies, and the row STAYS — its home still holds a leaf
    // for it, and an exit is meant to remain visible where the terminal lived.
    const exited = nextMessage(
      loose.homeClient,
      "session_event",
      15_000,
      (message) => message.sessionId === loose.session.id && message.kind === "exited",
    );
    const killed = await ownerFetch(server, `/api/terminals/${loose.session.id}`, {
      method: "DELETE",
      responseSchema: OkResponseSchema,
    });
    expect(killed.ok).toBe(true);
    expect((await exited).kind).toBe("exited");
    await waitFor(
      async () => (await terminalRow(server, loose.session.id))?.status === "exited",
      15_000,
      100,
    );
    expect(await terminalRow(server, loose.session.id)).toMatchObject({
      id: loose.session.id,
      name: "build box",
      status: "exited",
      homeId: loose.session.padId,
      unplaced: true,
    });
    await waitFor(
      () =>
        agent.output.stdout.some(
          (line) =>
            line.includes('"evt":"exited"') &&
            line.includes(`"sessionId":${JSON.stringify(loose.session.id)}`),
        ),
      15_000,
      50,
    );
    // The other terminal is untouched by its neighbour's death.
    expect((await terminalRow(server, placed.session.id))?.status).toBe("running");

    // Killing an already-exited terminal is a named conflict, never a silent success.
    const secondKill = await ownerFetch(server, `/api/terminals/${loose.session.id}`, {
      method: "DELETE",
      responseSchema: OkResponseSchema,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    if (!(secondKill instanceof HttpResponseError)) {
      throw new Error("killing an exited terminal must fail with a protocol error");
    }
    expect(secondKill.code).toBe("conflict");

    // Pad-scoped tokens are refused before any surface lookup: reading the index or placing
    // anything crosses containers, and a token scoped to one container cannot authorize that.
    const scoped = await mintToken(server, {
      principal: { kind: "human", name: "Index Scoped", color: "#8a5cf6" },
      caps: ["pads:read", "pads:write", "scene:write", "terminal:spawn", "terminal:write"],
      padId: pad.id,
    });
    for (const path of ["/api/terminals", "/api/containers"]) {
      const refused = await fetchAsPrincipal(server, scoped.token, path);
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe("forbidden");
    }
    const scopedPlace = await fetchAsPrincipal(server, scoped.token, "/api/place", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(
        PlaceRequestSchema.parse({
          surface: { kind: "terminal", sessionId: placed.session.id },
          destination: { kind: "unplaced" },
        }),
      ),
    });
    expect(scopedPlace.status).toBe(403);
    expect(scopedPlace.body.error.code).toBe("forbidden");
  } catch (error) {
    throw e2eFailure(error, [...servers, ...agents]);
  } finally {
    closeClients(clients);
    await stopProcesses([...servers, ...agents]);
  }
}, 60_000);
