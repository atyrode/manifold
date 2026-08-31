import { expect, test } from "bun:test";
import {
  HttpErrorSchema,
  PlaceRequestSchema,
  type ActionOutcome,
  type HttpError,
  type TerminalSummary,
} from "@manifold/protocol";
import type { SessionClient } from "@manifold/sdk";
import {
  callAction,
  connect,
  createContainer,
  enrollMachine,
  listTerminals,
  mintToken,
  startAgent,
  startServer,
  waitFor,
  type TestAgent,
  type TestServer,
} from "../src/index.ts";
import { closeClients, e2eFailure, nextMessage, openTerminalAt, stopProcesses } from "./helpers.ts";

/**
 * THE terminal index, over real processes. There is no pool any more: every terminal lives
 * in a composition, so `core.terminals.listAll` lists them ALL — the ones a canvas references and
 * the ones nothing references — and `unplaced` is derived from the containment graph rather
 * than stored beside a sort order. Renaming and killing are the only verbs left on a row.
 */

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

async function terminalRow(
  server: TestServer,
  terminalId: string,
): Promise<TerminalSummary | undefined> {
  return (await listTerminals(server)).find((terminal) => terminal.id === terminalId);
}

/** Invokes one action as the owner, returning the outcome envelope verbatim. */
async function invokeAction(
  server: TestServer,
  name: string,
  args: unknown,
): Promise<ActionOutcome> {
  return await callAction(server, server.ownerKey, name, args);
}

test("the terminal index lists every terminal, placed or not, and renames and kills through it", async () => {
  const servers: TestServer[] = [];
  const agents: TestAgent[] = [];
  const clients: SessionClient[] = [];
  try {
    const server = await startServer();
    servers.push(server);
    const container = await createContainer(server, "terminal index canvas");
    const enrolled = await enrollMachine(server, "index-agent");
    const agent = await startAgent({
      serverUrl: server.url,
      machineToken: enrolled.machineToken,
      name: "index-agent",
    });
    agents.push(agent);

    // Workspace-scoped: the index and the placement endpoint both cross containers, so they
    // reject container-scoped grants outright — proven at the end of this test.
    const owner = await mintToken(server, {
      principal: { kind: "human", name: "Index Owner", color: "#3fa46b" },
      caps: [
        "containers:read",
        "containers:write",
        "scenes:write",
        "terminals:spawn",
        "terminals:write",
      ],
    });
    const canvas = await connect(server, {
      containerId: container.id,
      token: owner.token,
      reconnect: false,
    });
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
    expect(placed.terminal.containerId).not.toBe(loose.terminal.containerId);

    // Both terminals are indexed. The only difference between them is whether anything
    // references the composition each lives in.
    const listing = await listTerminals(server);
    expect(listing).toHaveLength(2);
    expect(listing.find((row) => row.id === placed.terminal.id)).toEqual({
      id: placed.terminal.id,
      machineId: enrolled.machineId,
      name: null,
      createdAt: expect.any(Number),
      status: "running",
      exitCode: null,
      homeId: placed.terminal.containerId,
      unplaced: false,
    });
    expect(listing.find((row) => row.id === loose.terminal.id)).toMatchObject({
      id: loose.terminal.id,
      homeId: loose.terminal.containerId,
      status: "running",
      unplaced: true,
    });

    // Rename: the label is TERMINAL state, not container state, so it publishes to every room
    // joined to the composition the terminal lives in and shows up on the row.
    const renamed = nextMessage(
      loose.homeClient,
      "terminal_event",
      10_000,
      (message) => message.terminalId === loose.terminal.id && message.kind === "renamed",
    );
    const renameOutcome = await invokeAction(server, "core.terminals.rename", {
      terminalId: loose.terminal.id,
      name: "build box",
    });
    expect(renameOutcome).toEqual({ ok: true, result: {} });
    expect((await renamed).name).toBe("build box");
    await waitFor(
      () => loose.homeClient.terminals.get(loose.terminal.id)?.name === "build box",
      10_000,
      20,
    );
    expect((await terminalRow(server, loose.terminal.id))?.name).toBe("build box");

    // Kill through the index: the PTY dies AND the row goes, because a kill is a request to
    // be rid of the terminal. The home hears a departure, never an exit.
    const departed = nextMessage(
      loose.homeClient,
      "terminal_event",
      15_000,
      (message) => message.terminalId === loose.terminal.id && message.kind === "parked",
    );
    const killed = await invokeAction(server, "core.terminals.kill", {
      terminalId: loose.terminal.id,
    });
    expect(killed).toEqual({ ok: true, result: {} });
    expect((await departed).kind).toBe("parked");
    await waitFor(
      async () => (await terminalRow(server, loose.terminal.id)) === undefined,
      15_000,
      100,
    );
    await waitFor(
      () =>
        agent.output.stdout.some(
          (line) =>
            line.includes('"evt":"exited"') &&
            line.includes(`"terminalId":${JSON.stringify(loose.terminal.id)}`),
        ),
      15_000,
      50,
    );
    // No exited row is left behind: the index simply has one terminal fewer, and its home
    // went with it because the terminal was the only thing living there.
    expect(await terminalRow(server, loose.terminal.id)).toBeUndefined();
    // The other terminal is untouched by its neighbour's death.
    expect((await terminalRow(server, placed.terminal.id))?.status).toBe("running");

    // Gone is gone: a second kill finds no terminal rather than a tombstone to conflict with.
    // The door answers 200 with the refusal as data — a denial is an answer, not a failure.
    expect(
      await invokeAction(server, "core.terminals.kill", { terminalId: loose.terminal.id }),
    ).toEqual({ ok: false, denial: { rule: "refused", message: "terminal not found" } });

    // Container-scoped tokens are refused before any ref lookup: reading the index or placing
    // anything crosses containers, and a token scoped to one container cannot authorize that.
    const scoped = await mintToken(server, {
      principal: { kind: "human", name: "Index Scoped", color: "#8a5cf6" },
      caps: [
        "containers:read",
        "containers:write",
        "scenes:write",
        "terminals:spawn",
        "terminals:write",
      ],
      containerId: container.id,
    });
    // The INDEX is workspace-grade, so the door refuses the scoped token as DATA; the census
    // is still a floor route, and it answers the same fact with a status.
    expect(await callAction(server, scoped.token, "core.terminals.listAll", {})).toEqual({
      ok: false,
      denial: { rule: "forbidden", message: "scoped tokens cannot invoke workspace actions" },
    });
    const census = await fetchAsPrincipal(server, scoped.token, "/api/containers");
    expect(census.status).toBe(403);
    expect(census.body.error.code).toBe("forbidden");
    // Placement went the same way as the index: a door, refusing a scoped caller as data.
    expect(
      await callAction(
        server,
        scoped.token,
        "core.space.place",
        PlaceRequestSchema.parse({
          ref: { kind: "terminal", terminalId: placed.terminal.id },
          destination: { kind: "unplaced" },
        }),
      ),
    ).toEqual({
      ok: false,
      denial: { rule: "forbidden", message: "scoped tokens cannot invoke workspace actions" },
    });
  } catch (error) {
    throw e2eFailure(error, [...servers, ...agents]);
  } finally {
    closeClients(clients);
    await stopProcesses([...servers, ...agents]);
  }
}, 60_000);
