import { expect, test } from "bun:test";
import { TerminalPoolResponseSchema, type SessionInfo, type TileLayout } from "@manifold/protocol";
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
  stopProcesses,
  terminalElement,
  waitForTerminalText,
  type TerminalCapture,
} from "./helpers.ts";

// The typed command never contains the sentinel literally (the format string hides it), so
// finding it in a REPLAYED SNAPSHOT after two placements proves the same PTY travelled.
const SENTINEL = "place-sentinel-19";
const SENTINEL_COMMAND = "printf 'place-sentinel-%s\\n' 19\n";

/** The leaf a session occupies; its id IS the session's placement inside a tiled container. */
function tileForSession(layout: TileLayout, sessionId: string): string | null {
  for (const node of Object.values(layout)) {
    const surface = node.surface;
    if (node.dir !== null || surface === null) continue;
    if (surface.kind === "terminal" && surface.sessionId === sessionId) return node.id;
  }
  return null;
}

/** Opens a real PTY and authors its canvas element, the way a canvas birth does. */
async function openPlaced(client: SessionClient, elementId: string): Promise<SessionInfo> {
  const session = await client.openTerminal({ elementId, cols: 80, rows: 24 });
  expect(session.status).toBe("running");
  client.transact((tx) => {
    tx.create(terminalElement(elementId, { sessionId: session.id, x: 200, y: 120 }));
  });
  await waitFor(() => client.elements.has(elementId), 10_000, 20);
  return session;
}

test("client.place() carries one real terminal from a canvas to the pool and into a composition", async () => {
  const servers: TestServer[] = [];
  const agents: TestAgent[] = [];
  const clients: SessionClient[] = [];
  const captures: TerminalCapture[] = [];
  try {
    const server = await startServer();
    servers.push(server);
    const pad = await createPad(server, "placement canvas");
    // A composition is the same object with the other discipline, so one endpoint places
    // into both — that is the whole point of the algebra.
    const composition = await createPad(server, "placement composition", "tiled");
    const enrolled = await enrollMachine(server, "placement-agent");
    const agent = await startAgent({
      serverUrl: server.url,
      machineToken: enrolled.machineToken,
      name: "placement-agent",
    });
    agents.push(agent);
    // Workspace-scoped: a placement crosses containers, so a pad-scoped grant cannot make
    // one — the endpoint refuses it with 403 before any legality question is asked.
    const owner = await mintToken(server, {
      principal: { kind: "human", name: "Placement Owner", color: "#3fa46b" },
      caps: ["pads:read", "pads:write", "scene:write", "terminal:spawn", "terminal:write"],
    });

    const canvas = await connect(server, { padId: pad.id, token: owner.token, reconnect: false });
    clients.push(canvas);
    const session = await openPlaced(canvas, "el-place-1");
    const capture = captureTerminal(canvas, session.id);
    captures.push(capture);
    canvas.attachTerminal(session.id);
    await waitFor(() => capture.snapshotSeq !== null, 10_000, 20);
    canvas.sendTerminalInput(session.id, SENTINEL_COMMAND);
    await waitForTerminalText(capture, SENTINEL, 10_000);

    // Placement 1: the element addresses ONE placement, and the pool is where a released
    // terminal rests. The server removes the element itself; no scene update is sent.
    const parked = await canvas.place(
      { kind: "element", padId: pad.id, elementId: "el-place-1" },
      { kind: "pool" },
    );
    if (!parked.ok) throw new Error(`park was refused: ${parked.denial.rule}`);
    expect(parked.result).toEqual({ op: "park" });
    await waitFor(() => !canvas.elements.has("el-place-1"), 10_000, 20);
    await waitFor(() => !canvas.sessions.has(session.id), 10_000, 20);
    const pool = await ownerFetch(server, "/api/terminals", {
      responseSchema: TerminalPoolResponseSchema,
    });
    expect(pool.terminals.map((entry) => entry.id)).toEqual([session.id]);

    // Placement 2: the same terminal, addressed by IDENTITY this time, into a tiled
    // container. The server writes the leaf and rebinds the session.
    const tiled = await canvas.place(
      { kind: "terminal", sessionId: session.id },
      { kind: "tile", padId: composition.id, targetTileId: null, edge: null },
    );
    if (!tiled.ok) throw new Error(`tile placement was refused: ${tiled.denial.rule}`);
    if (tiled.result.op !== "add_tile") throw new Error("expected an add_tile result");

    const inside = await connect(server, {
      padId: composition.id,
      token: owner.token,
      reconnect: false,
    });
    clients.push(inside);
    await waitFor(() => inside.sessions.get(session.id)?.padId === composition.id, 10_000, 20);
    await waitFor(() => inside.layout() !== null, 10_000, 20);
    const layout = inside.layout();
    if (layout === null) throw new Error("composition published no layout tree");
    expect(tileForSession(layout, session.id)).toBe(tiled.result.tileId);

    // Same PTY, two placements later: its pre-park screen replays inside the composition.
    const insideCapture = captureTerminal(inside, session.id);
    captures.push(insideCapture);
    inside.attachTerminal(session.id);
    await waitFor(() => insideCapture.snapshotSeq !== null, 10_000, 20);
    expect(insideCapture.pendingOutputCount).toBe(0);
    expect(insideCapture.snapshotText).toContain(SENTINEL);

    // A refusal is an ANSWER: the composition cannot hold itself, and the rule says so.
    const nested = await inside.place(
      { kind: "pad", padId: composition.id },
      { kind: "tile", padId: composition.id, targetTileId: null, edge: null },
    );
    expect(nested.ok).toBe(false);
    if (nested.ok) throw new Error("a composition tiled into itself must be refused");
    expect(nested.denial).toEqual({
      rule: "not_accepted",
      surface: { kind: "pad", padId: composition.id },
      container: { kind: "view", padId: composition.id },
    });
    // Nothing moved: a denial is judged before any write.
    expect(Object.values(inside.layout() ?? {}).filter((node) => node.dir === null)).toHaveLength(
      1,
    );
  } catch (error) {
    throw e2eFailure(error, [...servers, ...agents]);
  } finally {
    closeClients(clients);
    await stopProcesses([...servers, ...agents]);
  }
});
