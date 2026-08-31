import { expect, test } from "bun:test";
import type { TileLayout } from "@manifold/protocol";
import type { SessionClient } from "@manifold/sdk";
import {
  connect,
  createPad,
  enrollMachine,
  listPads,
  listTerminals,
  mintToken,
  startAgent,
  startServer,
  waitFor,
  type TestAgent,
  type TestServer,
} from "../src/index.ts";
import {
  attachedCapture,
  closeClients,
  e2eFailure,
  openTerminalAt,
  stopProcesses,
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

test("client.place() unplaces one real terminal and then merges it into a composition", async () => {
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
    const { session, homeClient } = await openTerminalAt(canvas, server, {
      elementId: "el-place-1",
      token: owner.token,
      portalAt: { x: 200, y: 120 },
    });
    clients.push(homeClient);
    const bornHome = session.padId;
    const capture = await attachedCapture(homeClient, session.id);
    captures.push(capture);
    homeClient.sendTerminalInput(session.id, SENTINEL_COMMAND);
    await waitForTerminalText(capture, SENTINEL, 10_000);

    // Placement 1: the element addresses ONE reference to the terminal. Unplacing removes
    // that reference and leaves the terminal where it lives — there is nowhere else to be,
    // which is the whole difference from the park this replaced.
    const unplaced = await canvas.place(
      { kind: "element", padId: pad.id, elementId: "el-place-1" },
      { kind: "unplaced" },
    );
    if (!unplaced.ok) throw new Error(`unplace was refused: ${unplaced.denial.rule}`);
    expect(unplaced.result).toEqual({ op: "unplace", removed: 1 });
    await waitFor(() => !canvas.elements.has("el-place-1"), 10_000, 20);
    expect(await listTerminals(server)).toEqual([
      {
        id: session.id,
        machineId: enrolled.machineId,
        name: null,
        createdAt: expect.any(Number),
        status: "running",
        exitCode: null,
        homeId: bornHome,
        unplaced: true,
      },
    ]);
    // Unreferenced is not dead: the room it lives in still holds it, running.
    expect(homeClient.sessions.get(session.id)?.status).toBe("running");

    // Placement 2: the same terminal, addressed by IDENTITY this time, into a tiled
    // container. That is a MERGE — the leaf moves across and the emptied home retires.
    const merged = await canvas.place(
      { kind: "terminal", sessionId: session.id },
      { kind: "tile", padId: composition.id, targetTileId: null, edge: null },
    );
    if (!merged.ok) throw new Error(`tile placement was refused: ${merged.denial.rule}`);
    if (merged.result.op !== "add_tile")
      throw new Error(`expected add_tile, got ${merged.result.op}`);

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
    expect(tileForSession(layout, session.id)).toBe(merged.result.tileId);
    // The composition the terminal was born into held nothing else, so it is gone.
    await waitFor(
      async () => {
        const pads = await listPads(server);
        return pads.every((row) => row.id !== bornHome);
      },
      10_000,
      50,
    );

    // Same PTY, two placements later: its pre-unplace screen replays inside the composition.
    const insideCapture = await attachedCapture(inside, session.id);
    captures.push(insideCapture);
    expect(insideCapture.pendingOutputCount).toBe(0);
    expect(insideCapture.snapshotText).toContain(SENTINEL);

    // A refusal is an ANSWER, not an exception: a container never embeds itself, however the
    // drop addresses it, and the caller renders the RULE that refused.
    const selfEmbed = await canvas.place(
      { kind: "pad", padId: pad.id },
      { kind: "canvas", padId: pad.id, x: 40, y: 40 },
    );
    expect(selfEmbed.ok).toBe(false);
    if (selfEmbed.ok) throw new Error("a canvas placed on itself must be refused");
    expect(selfEmbed.denial).toEqual({
      rule: "self_embed",
      surface: { kind: "pad", padId: pad.id },
      container: { kind: "canvas", padId: pad.id },
    });
    // Nothing moved: a denial is judged before any write.
    expect(canvas.elements.size).toBe(0);
  } catch (error) {
    throw e2eFailure(error, [...servers, ...agents]);
  } finally {
    for (const capture of captures) capture.stop();
    closeClients(clients);
    await stopProcesses([...servers, ...agents]);
  }
}, 60_000);
