import { expect, test } from "bun:test";
import {
  ExpandTerminalResponseSchema,
  OkResponseSchema,
  PadPresenceResponseSchema,
  PadResponseSchema,
  PadsResponseSchema,
  PlaceRequestSchema,
  PlaceResponseSchema,
  RenamePadRequestSchema,
  RenameTerminalRequestSchema,
  type Pad,
  type PlaceRequest,
  type PlaceResponse,
  type SessionInfo,
  type TileLayout,
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
  nextLayoutChange,
  stopProcesses,
  terminalElement,
  waitForTerminalText,
  type TerminalCapture,
} from "./helpers.ts";

// The typed command never contains the sentinel literally (the format string hides it), so
// finding it in a REPLAYED SNAPSHOT proves real PTY output survived the expand/dissolve
// round trip rather than being echoed back live.
const SENTINEL = "bubble-sentinel-77";
const SENTINEL_COMMAND = "printf 'bubble-sentinel-%s\\n' 77\n";
const JSON_HEADERS = { "content-type": "application/json" } as const;

interface Workspace {
  readonly server: TestServer;
  readonly token: string;
  readonly pad: Pad;
}

/**
 * One real server + agent + canvas pad. The token is WORKSPACE-scoped on purpose: a bubble
 * is a pad of its own, so a pad-scoped grant could never follow its occupant into the view.
 */
async function startWorkspace(
  label: string,
  servers: TestServer[],
  agents: TestAgent[],
): Promise<Workspace> {
  const server = await startServer();
  servers.push(server);
  const pad = await createPad(server, `${label} canvas`);
  const enrolled = await enrollMachine(server, `${label}-agent`);
  const agent = await startAgent({
    serverUrl: server.url,
    machineToken: enrolled.machineToken,
    name: `${label}-agent`,
  });
  agents.push(agent);
  const owner = await mintToken(server, {
    principal: { kind: "human", name: "Container Owner", color: "#3fa46b" },
    caps: ["pads:read", "pads:write", "scene:write", "terminal:spawn", "terminal:write"],
  });
  return { server, token: owner.token, pad };
}

/** Opens a real PTY and authors its canvas element at a known geometry the swaps must preserve. */
async function openPlaced(
  client: SessionClient,
  elementId: string,
  geometry: { readonly x: number; readonly y: number },
): Promise<SessionInfo> {
  const session = await client.openTerminal({ elementId, cols: 80, rows: 24 });
  expect(session.status).toBe("running");
  client.transact((tx) => {
    tx.create(terminalElement(elementId, { sessionId: session.id, ...geometry }));
  });
  await waitFor(() => client.elements.has(elementId), 10_000, 20);
  return session;
}

/** The leaf a session occupies; its id IS the session's placement inside a tiled container. */
function tileForSession(layout: TileLayout, sessionId: string): string | null {
  for (const node of Object.values(layout)) {
    const surface = node.surface;
    if (node.dir !== null || surface === null) continue;
    if (surface.kind === "terminal" && surface.sessionId === sessionId) return node.id;
  }
  return null;
}

/** Waits for the SDK's layout projection to publish exactly `count` leaves, then returns it. */
async function waitForTileCount(client: SessionClient, count: number): Promise<TileLayout> {
  await waitFor(
    () => {
      const layout = client.layout();
      if (layout === null) return false;
      return Object.values(layout).filter((node) => node.dir === null).length === count;
    },
    10_000,
    20,
  );
  const layout = client.layout();
  if (layout === null) throw new Error("tiled container published no layout tree");
  return layout;
}

/**
 * The ONE placement call. Every gesture this file exercises — park, tile, compose, extract —
 * is the same envelope with a different destination, and the returned `op` says which
 * placement the declarations chose, so each caller asserts the op it expected.
 */
async function place(server: TestServer, request: PlaceRequest): Promise<PlaceResponse> {
  return await ownerFetch(server, "/api/place", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(PlaceRequestSchema.parse(request)),
    responseSchema: PlaceResponseSchema,
  });
}

async function listPads(server: TestServer): Promise<readonly Pad[]> {
  const listing = await ownerFetch(server, "/api/pads", { responseSchema: PadsResponseSchema });
  return listing.pads;
}

async function occupiedPads(server: TestServer): Promise<readonly string[]> {
  const presence = await ownerFetch(server, "/api/pad-presence", {
    responseSchema: PadPresenceResponseSchema,
  });
  return presence.pads.map((pad) => pad.padId);
}

/**
 * Waits until the server has processed a room's LAST leave. Presence drops the principal in
 * the very call that fires the room-empty hook, so its absence is the marker that the bubble
 * rule has already run — which is what lets a hardened view prove a NON-event.
 */
async function waitForRoomEmpty(server: TestServer, padId: string): Promise<void> {
  await waitFor(async () => !(await occupiedPads(server)).includes(padId), 10_000, 50);
}

test("a bubble carries its terminal into a view, replays its buffer, and pops back into the slot", async () => {
  const servers: TestServer[] = [];
  const agents: TestAgent[] = [];
  const clients: SessionClient[] = [];
  const captures: TerminalCapture[] = [];
  try {
    const { server, token, pad } = await startWorkspace("bubble", servers, agents);
    const canvas = await connect(server, { padId: pad.id, token, reconnect: false });
    clients.push(canvas);
    const session = await openPlaced(canvas, "el-bubble", { x: 320, y: 180 });

    const canvasCapture = captureTerminal(canvas, session.id);
    captures.push(canvasCapture);
    canvas.attachTerminal(session.id);
    await waitFor(() => canvasCapture.snapshotSeq !== null, 10_000, 20);
    canvas.sendTerminalInput(session.id, SENTINEL_COMMAND);
    await waitForTerminalText(canvasCapture, SENTINEL, 10_000);

    // Expand: a view is born around the terminal and starts life as a bubble.
    const expanded = await ownerFetch(server, `/api/terminals/${session.id}/expand`, {
      method: "POST",
      responseSchema: ExpandTerminalResponseSchema,
    });
    const born = await ownerFetch(server, `/api/pads/${expanded.viewId}`, {
      responseSchema: PadResponseSchema,
    });
    expect(born.pad).toMatchObject({ id: expanded.viewId, layout: "tiled", transient: true });

    // Transmutation in place: same element id, same geometry, now a live view widget.
    await waitFor(() => canvas.elements.get("el-bubble")?.type === "portal", 10_000, 20);
    const widget = canvas.elements.get("el-bubble");
    if (widget?.type !== "portal") throw new Error("expand left no portal on the origin canvas");
    expect(widget).toMatchObject({
      containerId: expanded.viewId,
      x: 320,
      y: 180,
      width: 720,
      height: 480,
    });

    // The expander follows its terminal into the view, where the pre-expand screen replays.
    const viewer = await connect(server, { padId: expanded.viewId, token, reconnect: false });
    clients.push(viewer);
    await waitFor(() => viewer.sessions.get(session.id)?.padId === expanded.viewId, 10_000, 20);
    const viewLayout = await waitForTileCount(viewer, 1);
    expect(tileForSession(viewLayout, session.id)).not.toBeNull();
    const viewCapture = captureTerminal(viewer, session.id);
    captures.push(viewCapture);
    viewer.attachTerminal(session.id);
    await waitFor(() => viewCapture.snapshotSeq !== null, 10_000, 20);
    // No gap: nothing may precede the snapshot, and the sentinel is IN the snapshot — so it
    // came from replayed screen state, not from a live write.
    expect(viewCapture.pendingOutputCount).toBe(0);
    expect(viewCapture.snapshotText).toContain(SENTINEL);
    expect(await occupiedPads(server)).toContain(expanded.viewId);

    // Shrink: the last occupant leaving pops the bubble and transmutes the widget back.
    viewer.close();
    await waitFor(() => canvas.elements.get("el-bubble")?.type === "terminal", 15_000, 20);
    const restored = canvas.elements.get("el-bubble");
    if (restored?.type !== "terminal") throw new Error("the popped bubble left no terminal");
    expect(restored).toMatchObject({
      sessionId: session.id,
      x: 320,
      y: 180,
      width: 720,
      height: 480,
    });
    await waitFor(() => canvas.sessions.get(session.id)?.padId === pad.id, 10_000, 20);

    // The transient row is gone: a dissolved bubble leaves no container behind.
    await waitFor(
      async () => (await listPads(server)).every((row) => row.id !== expanded.viewId),
      10_000,
      50,
    );
    expect((await listPads(server)).map((row) => row.id)).toEqual([pad.id]);

    // Round trip complete: a client that joins the canvas only AFTER the pop still gets the
    // pre-expand buffer, so the PTY survived both rebinds without a reset.
    const replay = await connect(server, { padId: pad.id, token, reconnect: false });
    clients.push(replay);
    await waitFor(() => replay.sessions.get(session.id)?.padId === pad.id, 10_000, 20);
    const replayCapture = captureTerminal(replay, session.id);
    captures.push(replayCapture);
    replay.attachTerminal(session.id);
    await waitFor(() => replayCapture.snapshotSeq !== null, 10_000, 20);
    expect(replayCapture.pendingOutputCount).toBe(0);
    expect(replayCapture.snapshotText).toContain(SENTINEL);
  } catch (error) {
    throw e2eFailure(error, [...servers, ...agents]);
  } finally {
    for (const capture of captures) capture.stop();
    closeClients(clients);
    await stopProcesses([...servers, ...agents]);
  }
}, 60_000);

test("splitting a bubble hardens it: the view and both tiles survive an empty room", async () => {
  const servers: TestServer[] = [];
  const agents: TestAgent[] = [];
  const clients: SessionClient[] = [];
  try {
    const { server, token, pad } = await startWorkspace("split", servers, agents);
    const canvas = await connect(server, { padId: pad.id, token, reconnect: false });
    clients.push(canvas);
    const resident = await openPlaced(canvas, "el-split-1", { x: 100, y: 120 });
    const guest = await openPlaced(canvas, "el-split-2", { x: 900, y: 120 });

    // A tile surface must be pooled or already in the container, so park the second PTY.
    await place(server, {
      surface: { kind: "element", padId: pad.id, elementId: "el-split-2" },
      destination: { kind: "pool" },
    });
    await waitFor(() => !canvas.elements.has("el-split-2"), 10_000, 20);

    const expanded = await ownerFetch(server, `/api/terminals/${resident.id}/expand`, {
      method: "POST",
      responseSchema: ExpandTerminalResponseSchema,
    });
    const viewer = await connect(server, { padId: expanded.viewId, token, reconnect: false });
    clients.push(viewer);
    await waitForTileCount(viewer, 1);

    const changed = nextLayoutChange(viewer);
    const added = await place(server, {
      surface: { kind: "terminal", sessionId: guest.id },
      destination: { kind: "tile", padId: expanded.viewId, targetTileId: null, edge: null },
    });
    if (added.op !== "add_tile") throw new Error(`expected add_tile, got ${added.op}`);
    // The structural write lands as a remote doc update, so every joined renderer re-reads.
    expect(await changed).toBe("remote");
    const split = await waitForTileCount(viewer, 2);
    expect(split[added.tileId]?.surface).toEqual({ kind: "terminal", sessionId: guest.id });
    expect(tileForSession(split, resident.id)).not.toBeNull();
    await waitFor(() => viewer.sessions.get(guest.id)?.padId === expanded.viewId, 10_000, 20);

    // A second leaf makes this a composition, not a bubble.
    const hardened = await ownerFetch(server, `/api/pads/${expanded.viewId}`, {
      responseSchema: PadResponseSchema,
    });
    expect(hardened.pad.transient).toBe(false);

    expect(await occupiedPads(server)).toContain(expanded.viewId);
    viewer.close();
    await waitForRoomEmpty(server, expanded.viewId);
    // The room-empty hook has run; a split view is not popped by it.
    expect((await listPads(server)).map((row) => row.id).sort()).toEqual(
      [pad.id, expanded.viewId].sort(),
    );
    // Both PTYs are still tiled inside it, and the widget still stands on the canvas.
    const rejoin = await connect(server, { padId: expanded.viewId, token, reconnect: false });
    clients.push(rejoin);
    const survived = await waitForTileCount(rejoin, 2);
    expect(tileForSession(survived, resident.id)).not.toBeNull();
    expect(tileForSession(survived, guest.id)).not.toBeNull();
    expect(canvas.elements.get("el-split-1")?.type).toBe("portal");
  } catch (error) {
    throw e2eFailure(error, [...servers, ...agents]);
  } finally {
    closeClients(clients);
    await stopProcesses([...servers, ...agents]);
  }
}, 60_000);

test("renaming a bubble claims it: the view and its widget survive an empty room", async () => {
  const servers: TestServer[] = [];
  const agents: TestAgent[] = [];
  const clients: SessionClient[] = [];
  try {
    const { server, token, pad } = await startWorkspace("claim", servers, agents);
    const canvas = await connect(server, { padId: pad.id, token, reconnect: false });
    clients.push(canvas);
    const session = await openPlaced(canvas, "el-claim", { x: 260, y: 340 });

    const expanded = await ownerFetch(server, `/api/terminals/${session.id}/expand`, {
      method: "POST",
      responseSchema: ExpandTerminalResponseSchema,
    });
    const viewer = await connect(server, { padId: expanded.viewId, token, reconnect: false });
    clients.push(viewer);
    await waitForTileCount(viewer, 1);

    // Naming a container claims it: hardened, and the return address is given up.
    const renamed = await ownerFetch(server, `/api/pads/${expanded.viewId}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify(RenamePadRequestSchema.parse({ name: "claimed view" })),
      responseSchema: PadResponseSchema,
    });
    expect(renamed.pad).toMatchObject({
      id: expanded.viewId,
      name: "claimed view",
      layout: "tiled",
      transient: false,
    });

    expect(await occupiedPads(server)).toContain(expanded.viewId);
    viewer.close();
    await waitForRoomEmpty(server, expanded.viewId);
    // The hook has run and a claimed single-tile view is untouched by it.
    const listed = await listPads(server);
    expect(listed.find((row) => row.id === expanded.viewId)).toMatchObject({
      name: "claimed view",
      transient: false,
    });
    // The widget stays a portal: nothing transmuted back onto the canvas.
    expect(canvas.elements.get("el-claim")?.type).toBe("portal");
    await waitFor(() => canvas.sessions.get(session.id) === undefined, 10_000, 20);

    const rejoin = await connect(server, { padId: expanded.viewId, token, reconnect: false });
    clients.push(rejoin);
    const survived = await waitForTileCount(rejoin, 1);
    expect(tileForSession(survived, session.id)).not.toBeNull();
    expect(rejoin.sessions.get(session.id)?.padId).toBe(expanded.viewId);
  } catch (error) {
    throw e2eFailure(error, [...servers, ...agents]);
  } finally {
    closeClients(clients);
    await stopProcesses([...servers, ...agents]);
  }
}, 60_000);

test("composing two canvas terminals births a named view that survives extracting a tile", async () => {
  const servers: TestServer[] = [];
  const agents: TestAgent[] = [];
  const clients: SessionClient[] = [];
  try {
    const { server, token, pad } = await startWorkspace("compose", servers, agents);
    const canvas = await connect(server, { padId: pad.id, token, reconnect: false });
    clients.push(canvas);
    const target = await openPlaced(canvas, "el-target", { x: 200, y: 150 });
    const dragged = await openPlaced(canvas, "el-dragged", { x: 980, y: 150 });

    // Named sessions make the composed view's auto-name exact rather than machine-derived.
    for (const [sessionId, name] of [
      [target.id, "alpha"],
      [dragged.id, "beta"],
    ] as const) {
      await ownerFetch(server, `/api/terminals/${sessionId}`, {
        method: "PATCH",
        headers: JSON_HEADERS,
        body: JSON.stringify(RenameTerminalRequestSchema.parse({ name })),
        responseSchema: OkResponseSchema,
      });
    }
    await waitFor(() => canvas.sessions.get(dragged.id)?.name === "beta", 10_000, 20);

    // Drop one terminal on the other: the target becomes the widget, both become tiles.
    const composed = await place(server, {
      surface: { kind: "terminal", sessionId: dragged.id },
      destination: { kind: "compose", padId: pad.id, targetElementId: "el-target", edge: "right" },
    });
    if (composed.op !== "compose") throw new Error(`expected compose, got ${composed.op}`);
    const view = await ownerFetch(server, `/api/pads/${composed.viewId}`, {
      responseSchema: PadResponseSchema,
    });
    // Composition IS the hardening moment: durable from birth, named after both surfaces.
    expect(view.pad).toMatchObject({
      id: composed.viewId,
      name: "alpha + beta",
      layout: "tiled",
      transient: false,
    });

    await waitFor(() => canvas.elements.get("el-target")?.type === "portal", 10_000, 20);
    const widget = canvas.elements.get("el-target");
    if (widget?.type !== "portal") throw new Error("compose left no portal on the canvas");
    expect(widget).toMatchObject({
      containerId: composed.viewId,
      x: 200,
      y: 150,
      width: 720,
      height: 480,
    });
    // The dragged terminal left the canvas for the view.
    await waitFor(() => !canvas.elements.has("el-dragged"), 10_000, 20);

    const viewer = await connect(server, { padId: composed.viewId, token, reconnect: false });
    clients.push(viewer);
    const layout = await waitForTileCount(viewer, 2);
    expect(tileForSession(layout, target.id)).not.toBeNull();
    const draggedTile = tileForSession(layout, dragged.id);
    if (draggedTile === null) throw new Error("compose placed no tile for the dragged terminal");
    await waitFor(
      () =>
        viewer.sessions.get(target.id)?.padId === composed.viewId &&
        viewer.sessions.get(dragged.id)?.padId === composed.viewId,
      10_000,
      20,
    );

    // Decomposition: pull one tile back onto the canvas the widget lives on. An occupant is
    // joined, so the bubble rule cannot pop the leftover single-tile view. The destination is
    // NAMED now — the retired route derived it from the view's stored return address.
    const extracted = await place(server, {
      surface: { kind: "tile", containerId: composed.viewId, tileId: draggedTile },
      destination: { kind: "canvas", padId: pad.id, x: 640, y: 700 },
    });
    if (extracted.op !== "extract") throw new Error(`expected extract, got ${extracted.op}`);
    await waitFor(() => canvas.elements.has(extracted.elementId), 10_000, 20);
    const plain = canvas.elements.get(extracted.elementId);
    if (plain?.type !== "terminal") throw new Error("extract authored no terminal element");
    expect(plain).toMatchObject({ sessionId: dragged.id, x: 640, y: 700 });
    await waitFor(() => canvas.sessions.get(dragged.id)?.padId === pad.id, 10_000, 20);

    // The view persists with the remaining tile, and its row is still listed.
    const remaining = await waitForTileCount(viewer, 1);
    expect(tileForSession(remaining, target.id)).not.toBeNull();
    expect((await listPads(server)).map((row) => row.id)).toContain(composed.viewId);
    expect(canvas.elements.get("el-target")?.type).toBe("portal");
  } catch (error) {
    throw e2eFailure(error, [...servers, ...agents]);
  } finally {
    closeClients(clients);
    await stopProcesses([...servers, ...agents]);
  }
}, 60_000);

test("a bubble pops while a spectator watches it, and the watcher is fenced not stranded", async () => {
  const servers: TestServer[] = [];
  const agents: TestAgent[] = [];
  const clients: SessionClient[] = [];
  try {
    const { server, token, pad } = await startWorkspace("spectator", servers, agents);
    const canvas = await connect(server, { padId: pad.id, token, reconnect: false });
    clients.push(canvas);
    const session = await openPlaced(canvas, "el-watched", { x: 260, y: 140 });

    const expanded = await ownerFetch(server, `/api/terminals/${session.id}/expand`, {
      method: "POST",
      responseSchema: ExpandTerminalResponseSchema,
    });
    await waitFor(() => canvas.elements.get("el-watched")?.type === "portal", 10_000, 20);

    // The collaborator's canvas paints a live view widget, which opens a REAL room socket
    // into the bubble. It watches: it reads the layout tree like anyone else...
    const watcher = await connect(server, {
      padId: expanded.viewId,
      token,
      reconnect: false,
      spectator: true,
    });
    clients.push(watcher);
    expect(tileForSession(await waitForTileCount(watcher, 1), session.id)).not.toBeNull();
    // ...but it occupies nothing, so the widget shows no phantom avatar and the newborn
    // bubble is not held open by somebody merely looking at it.
    expect(await occupiedPads(server)).not.toContain(expanded.viewId);

    const viewer = await connect(server, { padId: expanded.viewId, token, reconnect: false });
    clients.push(viewer);
    await waitForTileCount(viewer, 1);
    expect(await occupiedPads(server)).toContain(expanded.viewId);

    // The one real occupant leaves. Before the spectator distinction this was the deadlock:
    // the watcher's socket kept the room non-empty, so the bubble could never pop.
    viewer.close();
    await waitFor(() => canvas.elements.get("el-watched")?.type === "terminal", 15_000, 20);
    expect(canvas.elements.get("el-watched")).toMatchObject({
      sessionId: session.id,
      x: 260,
      y: 140,
    });
    await waitFor(
      async () => (await listPads(server)).every((row) => row.id !== expanded.viewId),
      10_000,
      50,
    );

    // The watched container is gone, so its watcher is fenced with the pad-deleted close
    // rather than left reading a dead room: a terminal close, no redial, no throw.
    await waitFor(() => watcher.status === "closed", 10_000, 20);
    // It read the pop as it happened: the session left the container before the fence.
    expect(watcher.sessions.has(session.id)).toBe(false);
    expect(watcher.layout()).not.toBeNull();
  } catch (error) {
    throw e2eFailure(error, [...servers, ...agents]);
  } finally {
    closeClients(clients);
    await stopProcesses([...servers, ...agents]);
  }
}, 60_000);
