import { expect, test } from "bun:test";
import {
  ActionOutcomeSchema,
  ContainersResponseSchema,
  OkResponseSchema,
  PadsResponseSchema,
  PlaceRequestSchema,
  PlaceResponseSchema,
  TerminalsResponseSchema,
  censusSolo,
  type CensusItem,
  type ContainerCensus,
  type Pad,
  type PlaceRequest,
  type PlaceResponse,
  type TerminalSummary,
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
  attachedCapture,
  closeClients,
  e2eFailure,
  nextLayoutChange,
  openTerminalAt,
  portalElement,
  stopProcesses,
  waitForTerminalText,
  type TerminalCapture,
} from "./helpers.ts";

/**
 * The container lifecycle over REAL processes: every terminal is born into a composition of
 * its own, and these are the five rules that move it between compositions afterwards —
 * spawn, merge, extract, unplace, reap. Every assertion here reads durable HTTP state or a
 * live PTY, never an in-process fake, because the point is that the rules hold end to end.
 */

const JSON_HEADERS = { "content-type": "application/json" } as const;

/**
 * A sentinel the typed command never contains literally (the format string hides it), so
 * finding it in a REPLAYED SNAPSHOT proves real PTY output survived the placement rather
 * than being echoed back live.
 */
function sentinel(tag: string): { readonly text: string; readonly command: string } {
  return {
    text: `lifecycle-sentinel-${tag}`,
    command: `printf 'lifecycle-sentinel-%s\\n' ${tag}\n`,
  };
}

interface Workspace {
  readonly server: TestServer;
  readonly agent: TestAgent;
  readonly token: string;
  readonly pad: Pad;
}

/**
 * One real server + agent + canvas pad. The token is WORKSPACE-scoped on purpose: a terminal
 * lives in a composition the server mints as the PTY lands, so a pad-scoped grant could
 * never join the room that holds it.
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
  return { server, agent, token: owner.token, pad };
}

/**
 * The ONE placement call. Every gesture this file exercises — merge, extract, unplace — is
 * the same envelope with a different destination, and the returned `op` says which placement
 * the declarations chose, so each caller asserts the op it expected.
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

async function listTerminals(server: TestServer): Promise<readonly TerminalSummary[]> {
  const listing = await ownerFetch(server, "/api/terminals", {
    responseSchema: TerminalsResponseSchema,
  });
  return listing.terminals;
}

/** The whole containment graph: one census per container, which is the index's only input. */
async function listContainers(server: TestServer): Promise<readonly ContainerCensus[]> {
  const listing = await ownerFetch(server, "/api/containers", {
    responseSchema: ContainersResponseSchema,
  });
  return listing.containers;
}

async function censusOf(server: TestServer, padId: string): Promise<ContainerCensus> {
  const containers = await listContainers(server);
  const census = containers.find((candidate) => candidate.padId === padId);
  if (census === undefined) throw new Error(`no container census for ${padId}`);
  return census;
}

/** What a solo composition holds, stated the way the census states it. */
function soloTerminal(sessionId: string): CensusItem {
  return { kind: "terminal", containerId: null, sessionId };
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

/** Invokes one action over the real door and insists it succeeded. */
async function invokeAction(server: TestServer, name: string, args: unknown): Promise<void> {
  const outcome = await ownerFetch(server, `/api/actions/${name}`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(args),
    responseSchema: ActionOutcomeSchema,
  });
  if (!outcome.ok) throw new Error(`${name} refused: ${outcome.denial.message}`);
}

/** Renames a terminal so a merged composition's auto-name is exact rather than machine-derived. */
async function renameTerminal(server: TestServer, sessionId: string, name: string): Promise<void> {
  await invokeAction(server, "core.terminals.rename", { sessionId, name });
}

test("a terminal is born into a solo composition, and placing a portal onto it flips unplaced", async () => {
  const servers: TestServer[] = [];
  const agents: TestAgent[] = [];
  const clients: SessionClient[] = [];
  try {
    const { server, token, pad } = await startWorkspace("solo", servers, agents);
    const canvas = await connect(server, { padId: pad.id, token, reconnect: false });
    clients.push(canvas);
    // No portal yet: the birth invariant is about the COMPOSITION, and authoring the canvas's
    // reference afterwards is what proves `unplaced` is derived rather than stored.
    const { session, homeClient } = await openTerminalAt(canvas, server, {
      elementId: "el-solo",
      token,
    });
    clients.push(homeClient);

    // The index knows exactly one terminal, and the composition it names lives beside the
    // canvas as a tiled container of its own.
    const terminals = await listTerminals(server);
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({
      id: session.id,
      homeId: session.padId,
      status: "running",
      exitCode: null,
      unplaced: true,
    });
    const pads = await listPads(server);
    expect(pads.map((row) => row.id).sort()).toEqual([pad.id, session.padId].sort());
    expect(pads.find((row) => row.id === session.padId)?.layout).toBe("tiled");

    // Solo means exactly one item, and that item IS the terminal.
    const home = await censusOf(server, session.padId);
    expect(home.layout).toBe("tiled");
    expect(home.items).toEqual([soloTerminal(session.id)]);
    expect(censusSolo(home)).toEqual(soloTerminal(session.id));
    expect(home.references).toEqual([]);
    const born = await waitForTileCount(homeClient, 1);
    expect(tileForSession(born, session.id)).not.toBeNull();

    // Placing it is authoring a REFERENCE. Nothing about the terminal changes, and the index
    // re-derives `unplaced` from the containment graph on the very next read.
    canvas.transact((tx) => {
      tx.create(portalElement("el-solo", session.padId, { x: 320, y: 180 }));
    });
    await waitFor(() => canvas.elements.has("el-solo"), 10_000, 20);
    await waitFor(
      async () => (await listTerminals(server)).every((terminal) => !terminal.unplaced),
      10_000,
      50,
    );
    const canvasCensus = await censusOf(server, pad.id);
    expect(canvasCensus.layout).toBe("canvas");
    expect(canvasCensus.references).toEqual([session.padId]);
    // The composition still holds exactly what it held: a reference is not containment.
    expect((await censusOf(server, session.padId)).items).toEqual([soloTerminal(session.id)]);
  } catch (error) {
    throw e2eFailure(error, [...servers, ...agents]);
  } finally {
    closeClients(clients);
    await stopProcesses([...servers, ...agents]);
  }
}, 60_000);

test("composing two live terminals merges their homes into one named composition, PTYs intact", async () => {
  const servers: TestServer[] = [];
  const agents: TestAgent[] = [];
  const clients: SessionClient[] = [];
  const captures: TerminalCapture[] = [];
  try {
    const { server, token, pad } = await startWorkspace("merge", servers, agents);
    const canvas = await connect(server, { padId: pad.id, token, reconnect: false });
    clients.push(canvas);
    const target = await openTerminalAt(canvas, server, {
      elementId: "el-target",
      token,
      portalAt: { x: 200, y: 150 },
    });
    const dragged = await openTerminalAt(canvas, server, {
      elementId: "el-dragged",
      token,
      portalAt: { x: 980, y: 150 },
    });
    clients.push(target.homeClient, dragged.homeClient);
    expect(target.session.padId).not.toBe(dragged.session.padId);

    await renameTerminal(server, target.session.id, "alpha");
    await renameTerminal(server, dragged.session.id, "beta");
    await waitFor(
      () => dragged.homeClient.sessions.get(dragged.session.id)?.name === "beta",
      10_000,
      20,
    );

    // Real bytes into both PTYs, so the merge has something to lose.
    const alpha = sentinel("alpha");
    const beta = sentinel("beta");
    const targetCapture = await attachedCapture(target.homeClient, target.session.id);
    const draggedCapture = await attachedCapture(dragged.homeClient, dragged.session.id);
    captures.push(targetCapture, draggedCapture);
    target.homeClient.sendTerminalInput(target.session.id, alpha.command);
    dragged.homeClient.sendTerminalInput(dragged.session.id, beta.command);
    await Promise.all([
      waitForTerminalText(targetCapture, alpha.text, 10_000),
      waitForTerminalText(draggedCapture, beta.text, 10_000),
    ]);

    // One widget dropped on another: a composition is born absorbing BOTH items, and the
    // target's element becomes a reference to it in place.
    const composed = await place(server, {
      surface: { kind: "element", padId: pad.id, elementId: "el-dragged" },
      destination: { kind: "compose", padId: pad.id, targetElementId: "el-target", edge: "right" },
    });
    if (composed.op !== "compose") throw new Error(`expected compose, got ${composed.op}`);

    const merged = (await listPads(server)).find((row) => row.id === composed.viewId);
    expect(merged).toMatchObject({ id: composed.viewId, name: "alpha + beta", layout: "tiled" });
    // Both homes handed their occupant over and retired: neither row survives.
    await waitFor(
      async () => {
        const ids = (await listPads(server)).map((row) => row.id);
        return !ids.includes(target.session.padId) && !ids.includes(dragged.session.padId);
      },
      10_000,
      50,
    );
    expect((await listPads(server)).map((row) => row.id).sort()).toEqual(
      [pad.id, composed.viewId].sort(),
    );

    // The target's reference kept its id and its geometry; the dragged one was consumed.
    await waitFor(
      () =>
        canvas.elements.get("el-target")?.type === "portal" && !canvas.elements.has("el-dragged"),
      10_000,
      20,
    );
    expect(canvas.elements.get("el-target")).toMatchObject({
      type: "portal",
      containerId: composed.viewId,
      x: 200,
      y: 150,
    });

    // The composition holds both terminals as leaves, and the index says both live there.
    const inside = await connect(server, {
      padId: composed.viewId,
      token,
      reconnect: false,
    });
    clients.push(inside);
    const layout = await waitForTileCount(inside, 2);
    expect(tileForSession(layout, target.session.id)).not.toBeNull();
    expect(tileForSession(layout, dragged.session.id)).toBe(composed.tileId);
    await waitFor(
      async () =>
        (await listTerminals(server)).every((terminal) => terminal.homeId === composed.viewId),
      10_000,
      50,
    );
    // Containment, not tree order: the census reports the container's own order, and which
    // leaf a split put first is the layout's business rather than this rule's.
    const held = (await censusOf(server, composed.viewId)).items;
    expect(held).toHaveLength(2);
    expect(held).toContainEqual(soloTerminal(target.session.id));
    expect(held).toContainEqual(soloTerminal(dragged.session.id));

    // Both PTYs survived the merge: each pre-merge screen replays on attach to the survivor.
    const survivingTarget = await attachedCapture(inside, target.session.id);
    const survivingDragged = await attachedCapture(inside, dragged.session.id);
    captures.push(survivingTarget, survivingDragged);
    expect(survivingTarget.pendingOutputCount).toBe(0);
    expect(survivingDragged.pendingOutputCount).toBe(0);
    expect(survivingTarget.snapshotText).toContain(alpha.text);
    expect(survivingDragged.snapshotText).toContain(beta.text);

    // Compositions MERGE, never nest: one holding two items is nobody's item, and the rule
    // that refuses it says exactly that rather than throwing.
    const other = await createPad(server, "merge refusal target", "tiled");
    const nested = await canvas.place(
      { kind: "pad", padId: composed.viewId },
      { kind: "tile", padId: other.id, targetTileId: null, edge: null },
    );
    expect(nested.ok).toBe(false);
    if (nested.ok) throw new Error("a two-item composition tiled into another must be refused");
    expect(nested.denial).toEqual({
      rule: "not_solo",
      surface: { kind: "pad", padId: composed.viewId },
      container: { kind: "view", padId: other.id },
    });
  } catch (error) {
    throw e2eFailure(error, [...servers, ...agents]);
  } finally {
    for (const capture of captures) capture.stop();
    closeClients(clients);
    await stopProcesses([...servers, ...agents]);
  }
}, 90_000);

test("extracting a leaf re-homes its live terminal into a fresh solo composition", async () => {
  const servers: TestServer[] = [];
  const agents: TestAgent[] = [];
  const clients: SessionClient[] = [];
  const captures: TerminalCapture[] = [];
  try {
    const { server, token, pad } = await startWorkspace("extract", servers, agents);
    const canvas = await connect(server, { padId: pad.id, token, reconnect: false });
    clients.push(canvas);
    const resident = await openTerminalAt(canvas, server, {
      elementId: "el-resident",
      token,
      portalAt: { x: 120, y: 140 },
    });
    const guest = await openTerminalAt(canvas, server, {
      elementId: "el-guest",
      token,
      portalAt: { x: 900, y: 140 },
    });
    clients.push(resident.homeClient, guest.homeClient);

    const mark = sentinel("guest");
    const guestCapture = await attachedCapture(guest.homeClient, guest.session.id);
    captures.push(guestCapture);
    guest.homeClient.sendTerminalInput(guest.session.id, mark.command);
    await waitForTerminalText(guestCapture, mark.text, 10_000);

    // A tile drop is the other spelling of the merge: the guest joins the resident's
    // composition and the home it emptied retires.
    const bornHome = guest.session.padId;
    const changed = nextLayoutChange(resident.homeClient);
    const added = await place(server, {
      surface: { kind: "element", padId: pad.id, elementId: "el-guest" },
      destination: {
        kind: "tile",
        padId: resident.session.padId,
        targetTileId: null,
        edge: "right",
      },
    });
    if (added.op !== "add_tile") throw new Error(`expected add_tile, got ${added.op}`);
    // The structural write is server-authored, so a joined renderer observes it as a REMOTE
    // update and re-reads the tree rather than diffing ids it never wrote.
    expect(await changed).toBe("remote");
    const shared = await waitForTileCount(resident.homeClient, 2);
    expect(tileForSession(shared, guest.session.id)).toBe(added.tileId);
    await waitFor(
      async () => (await listPads(server)).every((row) => row.id !== bornHome),
      10_000,
      50,
    );

    // Extraction: the leaf leaves a MULTI-tile composition, so its terminal is re-homed into
    // a composition that did not exist a moment ago, and the canvas gets a portal onto that.
    const extracted = await place(server, {
      surface: { kind: "tile", containerId: resident.session.padId, tileId: added.tileId },
      destination: { kind: "canvas", padId: pad.id, x: 640, y: 700 },
    });
    if (extracted.op !== "extract") throw new Error(`expected extract, got ${extracted.op}`);
    await waitFor(() => canvas.elements.has(extracted.elementId), 10_000, 20);
    const authored = canvas.elements.get(extracted.elementId);
    if (authored?.type !== "portal") throw new Error("extract authored no portal element");
    expect(authored).toMatchObject({ x: 640, y: 700 });
    const newHome = authored.containerId;
    expect(newHome).not.toBe(resident.session.padId);
    expect(newHome).not.toBe(bornHome);
    expect(newHome).not.toBe(pad.id);

    expect(censusSolo(await censusOf(server, newHome))).toEqual(soloTerminal(guest.session.id));
    const indexed = (await listTerminals(server)).find(
      (terminal) => terminal.id === guest.session.id,
    );
    expect(indexed).toMatchObject({ homeId: newHome, status: "running", unplaced: false });
    // The source composition still holds the resident, so it was not emptied and stays.
    const remaining = await waitForTileCount(resident.homeClient, 1);
    expect(tileForSession(remaining, resident.session.id)).not.toBeNull();
    expect((await listPads(server)).map((row) => row.id)).toContain(resident.session.padId);

    // Same PTY, two placements later: the pre-merge screen replays out of the new home.
    const rehomed = await connect(server, { padId: newHome, token, reconnect: false });
    clients.push(rehomed);
    await waitFor(() => rehomed.sessions.get(guest.session.id)?.padId === newHome, 10_000, 20);
    const rehomedCapture = await attachedCapture(rehomed, guest.session.id);
    captures.push(rehomedCapture);
    expect(rehomedCapture.pendingOutputCount).toBe(0);
    expect(rehomedCapture.snapshotText).toContain(mark.text);
  } catch (error) {
    throw e2eFailure(error, [...servers, ...agents]);
  } finally {
    for (const capture of captures) capture.stop();
    closeClients(clients);
    await stopProcesses([...servers, ...agents]);
  }
}, 90_000);

test("unplacing a terminal removes every reference to it and leaves the PTY running", async () => {
  const servers: TestServer[] = [];
  const agents: TestAgent[] = [];
  const clients: SessionClient[] = [];
  const captures: TerminalCapture[] = [];
  try {
    const { server, token, pad } = await startWorkspace("unplace", servers, agents);
    const canvas = await connect(server, { padId: pad.id, token, reconnect: false });
    clients.push(canvas);
    const { session, homeClient } = await openTerminalAt(canvas, server, {
      elementId: "el-unplace",
      token,
      portalAt: { x: 260, y: 200 },
    });
    clients.push(homeClient);

    // A second reference to the same composition: naming the ITEM releases all of them, which
    // is what distinguishes an identity unplace from releasing one widget.
    canvas.transact((tx) => {
      tx.create(portalElement("el-mirror", session.padId, { x: 900, y: 200 }));
    });
    await waitFor(() => canvas.elements.has("el-mirror"), 10_000, 20);

    const mark = sentinel("unplaced");
    const capture = await attachedCapture(homeClient, session.id);
    captures.push(capture);
    homeClient.sendTerminalInput(session.id, mark.command);
    await waitForTerminalText(capture, mark.text, 10_000);

    const released = await place(server, {
      surface: { kind: "terminal", sessionId: session.id },
      destination: { kind: "unplaced" },
    });
    expect(released).toEqual({ op: "unplace", removed: 2 });
    await waitFor(
      () => !canvas.elements.has("el-unplace") && !canvas.elements.has("el-mirror"),
      10_000,
      20,
    );
    expect((await censusOf(server, pad.id)).references).toEqual([]);

    // THIS is the whole difference from the park it replaced: the terminal did not move, did
    // not die, and is still indexed — it is simply unreferenced.
    const indexed = (await listTerminals(server)).find((terminal) => terminal.id === session.id);
    expect(indexed).toMatchObject({
      id: session.id,
      homeId: session.padId,
      status: "running",
      exitCode: null,
      unplaced: true,
    });
    expect(censusSolo(await censusOf(server, session.padId))).toEqual(soloTerminal(session.id));

    // A client that joins the home only AFTER the unplace still gets the pre-unplace screen.
    const rejoin = await connect(server, { padId: session.padId, token, reconnect: false });
    clients.push(rejoin);
    await waitFor(() => rejoin.sessions.get(session.id)?.status === "running", 10_000, 20);
    const rejoinCapture = await attachedCapture(rejoin, session.id);
    captures.push(rejoinCapture);
    expect(rejoinCapture.pendingOutputCount).toBe(0);
    expect(rejoinCapture.snapshotText).toContain(mark.text);

    // Zero removed is a legal answer: it says "already unplaced" rather than failing.
    expect(
      await place(server, {
        surface: { kind: "terminal", sessionId: session.id },
        destination: { kind: "unplaced" },
      }),
    ).toEqual({ op: "unplace", removed: 0 });
  } catch (error) {
    throw e2eFailure(error, [...servers, ...agents]);
  } finally {
    for (const capture of captures) capture.stop();
    closeClients(clients);
    await stopProcesses([...servers, ...agents]);
  }
}, 60_000);

test("removing a terminal's last home leaf reaps the PTY and retires the composition", async () => {
  const servers: TestServer[] = [];
  const agents: TestAgent[] = [];
  const clients: SessionClient[] = [];
  try {
    const { server, agent, token, pad } = await startWorkspace("reap", servers, agents);
    const canvas = await connect(server, { padId: pad.id, token, reconnect: false });
    clients.push(canvas);
    const { session, homeClient } = await openTerminalAt(canvas, server, {
      elementId: "el-reap",
      token,
      portalAt: { x: 200, y: 200 },
    });
    clients.push(homeClient);
    const layout = await waitForTileCount(homeClient, 1);
    const leaf = tileForSession(layout, session.id);
    if (leaf === null) throw new Error("the newborn composition holds no terminal leaf");

    // Closing a terminal's only leaf closes the terminal: there is no pool to fall into, so
    // the operator who removed its last representation removed the terminal.
    const removed = await ownerFetch(server, `/api/pads/${session.padId}/tiles/${leaf}`, {
      method: "DELETE",
      responseSchema: OkResponseSchema,
    });
    expect(removed.ok).toBe(true);

    await waitFor(
      () =>
        agent.output.stdout.some(
          (line) =>
            line.includes('"evt":"exited"') &&
            line.includes(`"sessionId":${JSON.stringify(session.id)}`),
        ),
      15_000,
      50,
    );
    await waitFor(async () => (await listTerminals(server)).length === 0, 15_000, 100);
    // The composition it emptied retires with it, and the canvas's reference goes with that.
    await waitFor(
      async () => {
        const ids = (await listPads(server)).map((row) => row.id);
        return ids.length === 1 && ids[0] === pad.id;
      },
      10_000,
      50,
    );
    await waitFor(() => !canvas.elements.has("el-reap"), 10_000, 20);
    expect((await censusOf(server, pad.id)).references).toEqual([]);
    expect(agent.proc.exitCode).toBeNull();
  } catch (error) {
    throw e2eFailure(error, [...servers, ...agents]);
  } finally {
    closeClients(clients);
    await stopProcesses([...servers, ...agents]);
  }
}, 60_000);

test("killing a terminal by id removes it, its home, and every portal onto it", async () => {
  const servers: TestServer[] = [];
  const agents: TestAgent[] = [];
  const clients: SessionClient[] = [];
  const captures: TerminalCapture[] = [];
  try {
    const { server, agent, token, pad } = await startWorkspace("kill", servers, agents);
    const canvas = await connect(server, { padId: pad.id, token, reconnect: false });
    clients.push(canvas);
    const { session, homeClient } = await openTerminalAt(canvas, server, {
      elementId: "el-kill",
      token,
      portalAt: { x: 200, y: 200 },
    });
    clients.push(homeClient);
    // A second widget onto the same terminal, because "gone" has to mean gone from every
    // canvas rather than from the one the killer happened to be looking at.
    canvas.transact((tx) => {
      tx.create(portalElement("el-kill-mirror", session.padId, { x: 980, y: 200 }));
    });
    await waitFor(() => canvas.elements.has("el-kill-mirror"), 10_000, 20);

    // Prove the PTY is real and answering before it is destroyed.
    const mark = sentinel("killed");
    const capture = await attachedCapture(homeClient, session.id);
    captures.push(capture);
    homeClient.sendTerminalInput(session.id, mark.command);
    await waitForTerminalText(capture, mark.text, 10_000);

    await invokeAction(server, "core.terminals.kill", { sessionId: session.id });

    // The PTY really stopped: the agent, not the server, says so.
    await waitFor(
      () =>
        agent.output.stdout.some(
          (line) =>
            line.includes('"evt":"exited"') &&
            line.includes(`"sessionId":${JSON.stringify(session.id)}`),
        ),
      15_000,
      50,
    );
    // No exited row is left behind for anybody to dismiss — the index is simply empty. The
    // agent's own exit report has already been observed above, so the frame that could have
    // resurrected the terminal as a tombstone has been sent and cannot: the kill deleted the
    // row, and reporting an exit only ever UPDATES one.
    await waitFor(async () => (await listTerminals(server)).length === 0, 15_000, 100);
    // Its home was solo, so it went with it, and only the canvas remains.
    const pads = (await listPads(server)).map((row) => row.id);
    expect(pads).toEqual([pad.id]);
    // Both widgets vanish through the document, which is how live viewers learn about it.
    await waitFor(
      () => !canvas.elements.has("el-kill") && !canvas.elements.has("el-kill-mirror"),
      10_000,
      20,
    );
    expect((await censusOf(server, pad.id)).references).toEqual([]);
    expect(agent.proc.exitCode).toBeNull();
  } catch (error) {
    throw e2eFailure(error, [...servers, ...agents]);
  } finally {
    for (const capture of captures) capture.stop();
    closeClients(clients);
    await stopProcesses([...servers, ...agents]);
  }
}, 60_000);

test("a terminal that exits on its own keeps its real code, its home and its portals", async () => {
  const servers: TestServer[] = [];
  const agents: TestAgent[] = [];
  const clients: SessionClient[] = [];
  const captures: TerminalCapture[] = [];
  try {
    const { server, token, pad } = await startWorkspace("natural-exit", servers, agents);
    const canvas = await connect(server, { padId: pad.id, token, reconnect: false });
    clients.push(canvas);
    const { session, homeClient } = await openTerminalAt(canvas, server, {
      elementId: "el-exit",
      token,
      portalAt: { x: 240, y: 180 },
    });
    clients.push(homeClient);
    const mark = sentinel("alive");
    const capture = await attachedCapture(homeClient, session.id);
    captures.push(capture);
    homeClient.sendTerminalInput(session.id, mark.command);
    await waitForTerminalText(capture, mark.text, 10_000);

    // Nobody asked for this. The shell decides to stop, and it names its own code.
    homeClient.sendTerminalInput(session.id, "exit 7\n");
    await waitFor(() => homeClient.sessions.get(session.id)?.status === "exited", 15_000, 20);
    expect(homeClient.sessions.get(session.id)?.exitCode).toBe(7);

    // A dead terminal is information the operator may want, so nothing is deleted: the row
    // keeps the REAL code, its home keeps its leaf, and the canvas keeps its widget.
    const indexed = (await listTerminals(server)).find((terminal) => terminal.id === session.id);
    expect(indexed).toMatchObject({
      id: session.id,
      homeId: session.padId,
      status: "exited",
      exitCode: 7,
      unplaced: false,
    });
    expect(censusSolo(await censusOf(server, session.padId))).toEqual(soloTerminal(session.id));
    expect(canvas.elements.has("el-exit")).toBe(true);
    expect((await censusOf(server, pad.id)).references).toEqual([session.padId]);
    // Rejoining the home still finds the exit on screen, which is the whole point of keeping it.
    const rejoin = await connect(server, { padId: session.padId, token, reconnect: false });
    clients.push(rejoin);
    await waitFor(() => rejoin.sessions.get(session.id)?.status === "exited", 10_000, 20);
    expect(rejoin.sessions.get(session.id)?.exitCode).toBe(7);

    // And only a deliberate kill destroys it: the same terminal, dismissed, poofs like any
    // other — which is the contrast this test exists to draw.
    await invokeAction(server, "core.terminals.kill", { sessionId: session.id });
    await waitFor(async () => (await listTerminals(server)).length === 0, 15_000, 100);
    await waitFor(() => !canvas.elements.has("el-exit"), 10_000, 20);
    expect((await listPads(server)).map((row) => row.id)).toEqual([pad.id]);
  } catch (error) {
    throw e2eFailure(error, [...servers, ...agents]);
  } finally {
    for (const capture of captures) capture.stop();
    closeClients(clients);
    await stopProcesses([...servers, ...agents]);
  }
}, 90_000);
