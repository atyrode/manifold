import { expect, test } from "bun:test";
import {
  ActionOutcomeSchema,
  ContainersResponseSchema,
  OkResponseSchema,
  ContainerCensusResponseSchema,
  PlaceRequestSchema,
  PlaceResponseSchema,
  censusSolo,
  elementString,
  type CensusItem,
  type ContainerCensus,
  type Container,
  type PlaceRequest,
  type PlaceResponse,
  type TileLayout,
} from "@manifold/protocol";
import type { SessionClient } from "@manifold/sdk";
import {
  connect,
  createContainer,
  enrollMachine,
  listTerminals,
  mintToken,
  ownerAction,
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
  readonly container: Container;
}

/**
 * One real server + agent + canvas container. The token is WORKSPACE-scoped on purpose: a terminal
 * lives in a composition the server mints as the PTY lands, so a container-scoped grant could
 * never join the room that holds it.
 */
async function startWorkspace(
  label: string,
  servers: TestServer[],
  agents: TestAgent[],
): Promise<Workspace> {
  const server = await startServer();
  servers.push(server);
  const container = await createContainer(server, `${label} canvas`);
  const enrolled = await enrollMachine(server, `${label}-agent`);
  const agent = await startAgent({
    serverUrl: server.url,
    machineToken: enrolled.machineToken,
    name: `${label}-agent`,
  });
  agents.push(agent);
  const owner = await mintToken(server, {
    principal: { kind: "human", name: "Container Owner", color: "#3fa46b" },
    caps: [
      "containers:read",
      "containers:write",
      "scenes:write",
      "terminals:spawn",
      "terminals:write",
    ],
  });
  return { server, agent, token: owner.token, container };
}

/**
 * The ONE placement call. Every gesture this file exercises — merge, extract, unplace — is
 * the same envelope with a different destination dispatched through `core.space.place`, and
 * the returned `op` says which placement the declarations chose, so each caller asserts the
 * op it expected.
 */
async function place(server: TestServer, request: PlaceRequest): Promise<PlaceResponse> {
  return PlaceResponseSchema.parse(
    await ownerAction(server, "core.space.place", PlaceRequestSchema.parse(request)),
  );
}

async function listContainers(server: TestServer): Promise<readonly Container[]> {
  return ContainersResponseSchema.parse(await ownerAction(server, "core.index.listContainers", {}))
    .containers;
}

/** The whole containment graph: one census per container, which is the index's only input. */
async function containerCensuses(server: TestServer): Promise<readonly ContainerCensus[]> {
  const listing = await ownerFetch(server, "/api/containers", {
    responseSchema: ContainerCensusResponseSchema,
  });
  return listing.containers;
}

async function censusOf(server: TestServer, containerId: string): Promise<ContainerCensus> {
  const containers = await containerCensuses(server);
  const census = containers.find((candidate) => candidate.containerId === containerId);
  if (census === undefined) throw new Error(`no container census for ${containerId}`);
  return census;
}

/** What a solo composition holds, stated the way the census states it. */
function soloTerminal(terminalId: string): CensusItem {
  return { kind: "terminal", containerId: null, terminalId };
}

/** The leaf a terminal occupies; its id IS the terminal's placement inside a composition. */
function tileForTerminal(layout: TileLayout, terminalId: string): string | null {
  for (const node of Object.values(layout)) {
    const ref = node.ref;
    if (node.dir !== null || ref === null) continue;
    if (ref.kind === "terminal" && ref.terminalId === terminalId) return node.id;
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
  if (layout === null) throw new Error("composition published no layout tree");
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
async function renameTerminal(server: TestServer, terminalId: string, name: string): Promise<void> {
  await invokeAction(server, "core.terminals.rename", { terminalId, name });
}

test("a terminal is born into a solo composition, and placing a portal onto it flips unplaced", async () => {
  const servers: TestServer[] = [];
  const agents: TestAgent[] = [];
  const clients: SessionClient[] = [];
  try {
    const { server, token, container } = await startWorkspace("solo", servers, agents);
    const canvas = await connect(server, { containerId: container.id, token, reconnect: false });
    clients.push(canvas);
    // No portal yet: the birth invariant is about the COMPOSITION, and authoring the canvas's
    // reference afterwards is what proves `unplaced` is derived rather than stored.
    const { terminal, homeClient } = await openTerminalAt(canvas, server, {
      elementId: "el-solo",
      token,
    });
    clients.push(homeClient);

    // The index knows exactly one terminal, and the composition it names lives beside the
    // canvas as a composition of its own.
    const terminals = await listTerminals(server);
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({
      id: terminal.id,
      homeId: terminal.containerId,
      status: "running",
      exitCode: null,
      unplaced: true,
    });
    const containers = await listContainers(server);
    expect(containers.map((row) => row.id).sort()).toEqual(
      [container.id, terminal.containerId].sort(),
    );
    expect(containers.find((row) => row.id === terminal.containerId)?.discipline).toBe(
      "composition",
    );

    // Solo means exactly one item, and that item IS the terminal.
    const home = await censusOf(server, terminal.containerId);
    expect(home.discipline).toBe("composition");
    expect(home.items).toEqual([soloTerminal(terminal.id)]);
    expect(censusSolo(home)).toEqual(soloTerminal(terminal.id));
    expect(home.references).toEqual([]);
    const born = await waitForTileCount(homeClient, 1);
    expect(tileForTerminal(born, terminal.id)).not.toBeNull();

    // Placing it is authoring a REFERENCE. Nothing about the terminal changes, and the index
    // re-derives `unplaced` from the containment graph on the very next read.
    canvas.transact((tx) => {
      tx.create(portalElement("el-solo", terminal.containerId, { x: 320, y: 180 }));
    });
    await waitFor(() => canvas.elements.has("el-solo"), 10_000, 20);
    await waitFor(
      async () => (await listTerminals(server)).every((terminal) => !terminal.unplaced),
      10_000,
      50,
    );
    const canvasCensus = await censusOf(server, container.id);
    expect(canvasCensus.discipline).toBe("canvas");
    expect(canvasCensus.references).toEqual([terminal.containerId]);
    // The composition still holds exactly what it held: a reference is not containment.
    expect((await censusOf(server, terminal.containerId)).items).toEqual([
      soloTerminal(terminal.id),
    ]);
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
    const { server, token, container } = await startWorkspace("merge", servers, agents);
    const canvas = await connect(server, { containerId: container.id, token, reconnect: false });
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
    expect(target.terminal.containerId).not.toBe(dragged.terminal.containerId);

    await renameTerminal(server, target.terminal.id, "alpha");
    await renameTerminal(server, dragged.terminal.id, "beta");
    await waitFor(
      () => dragged.homeClient.terminals.get(dragged.terminal.id)?.name === "beta",
      10_000,
      20,
    );

    // Real bytes into both PTYs, so the merge has something to lose.
    const alpha = sentinel("alpha");
    const beta = sentinel("beta");
    const targetCapture = await attachedCapture(target.homeClient, target.terminal.id);
    const draggedCapture = await attachedCapture(dragged.homeClient, dragged.terminal.id);
    captures.push(targetCapture, draggedCapture);
    target.homeClient.sendTerminalInput(target.terminal.id, alpha.command);
    dragged.homeClient.sendTerminalInput(dragged.terminal.id, beta.command);
    await Promise.all([
      waitForTerminalText(targetCapture, alpha.text, 10_000),
      waitForTerminalText(draggedCapture, beta.text, 10_000),
    ]);

    // One portal dropped on another: a composition is born absorbing BOTH items, and the
    // target's element becomes a reference to it in place.
    const composed = await place(server, {
      ref: { kind: "element", containerId: container.id, elementId: "el-dragged" },
      destination: {
        kind: "compose",
        containerId: container.id,
        targetElementId: "el-target",
        edge: "right",
      },
    });
    if (composed.op !== "compose") throw new Error(`expected compose, got ${composed.op}`);

    const merged = (await listContainers(server)).find((row) => row.id === composed.containerId);
    expect(merged).toMatchObject({
      id: composed.containerId,
      name: "alpha + beta",
      discipline: "composition",
    });
    // Both homes handed their occupant over and retired: neither row survives.
    await waitFor(
      async () => {
        const ids = (await listContainers(server)).map((row) => row.id);
        return (
          !ids.includes(target.terminal.containerId) && !ids.includes(dragged.terminal.containerId)
        );
      },
      10_000,
      50,
    );
    expect((await listContainers(server)).map((row) => row.id).sort()).toEqual(
      [container.id, composed.containerId].sort(),
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
      containerId: composed.containerId,
      x: 200,
      y: 150,
    });

    // The composition holds both terminals as leaves, and the index says both live there.
    const inside = await connect(server, {
      containerId: composed.containerId,
      token,
      reconnect: false,
    });
    clients.push(inside);
    const layout = await waitForTileCount(inside, 2);
    expect(tileForTerminal(layout, target.terminal.id)).not.toBeNull();
    expect(tileForTerminal(layout, dragged.terminal.id)).toBe(composed.tileId);
    await waitFor(
      async () =>
        (await listTerminals(server)).every((terminal) => terminal.homeId === composed.containerId),
      10_000,
      50,
    );
    // Containment, not tree order: the census reports the container's own order, and which
    // leaf a split put first is the layout's business rather than this rule's.
    const held = (await censusOf(server, composed.containerId)).items;
    expect(held).toHaveLength(2);
    expect(held).toContainEqual(soloTerminal(target.terminal.id));
    expect(held).toContainEqual(soloTerminal(dragged.terminal.id));

    // Both PTYs survived the merge: each pre-merge screen replays on attach to the survivor.
    const survivingTarget = await attachedCapture(inside, target.terminal.id);
    const survivingDragged = await attachedCapture(inside, dragged.terminal.id);
    captures.push(survivingTarget, survivingDragged);
    expect(survivingTarget.pendingOutputCount).toBe(0);
    expect(survivingDragged.pendingOutputCount).toBe(0);
    expect(survivingTarget.snapshotText).toContain(alpha.text);
    expect(survivingDragged.snapshotText).toContain(beta.text);

    // Compositions MERGE, never nest: one holding two items is nobody's item, and the rule
    // that refuses it says exactly that rather than throwing.
    const other = await createContainer(server, "merge refusal target", "composition");
    const nested = await canvas.place(
      { kind: "container", containerId: composed.containerId },
      { kind: "tile", containerId: other.id, targetTileId: null, edge: null },
    );
    expect(nested.ok).toBe(false);
    if (nested.ok) throw new Error("a two-item composition placed into another must be refused");
    expect(nested.denial).toEqual({
      rule: "not_solo",
      ref: { kind: "container", containerId: composed.containerId },
      container: { kind: "composition", containerId: other.id },
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
    const { server, token, container } = await startWorkspace("extract", servers, agents);
    const canvas = await connect(server, { containerId: container.id, token, reconnect: false });
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
    const guestCapture = await attachedCapture(guest.homeClient, guest.terminal.id);
    captures.push(guestCapture);
    guest.homeClient.sendTerminalInput(guest.terminal.id, mark.command);
    await waitForTerminalText(guestCapture, mark.text, 10_000);

    // A tile drop is the other spelling of the merge: the guest joins the resident's
    // composition and the home it emptied retires.
    const bornHome = guest.terminal.containerId;
    const changed = nextLayoutChange(resident.homeClient);
    const added = await place(server, {
      ref: { kind: "element", containerId: container.id, elementId: "el-guest" },
      destination: {
        kind: "tile",
        containerId: resident.terminal.containerId,
        targetTileId: null,
        edge: "right",
      },
    });
    if (added.op !== "add_tile") throw new Error(`expected add_tile, got ${added.op}`);
    // The structural write is server-authored, so a joined renderer observes it as a REMOTE
    // update and re-reads the tree rather than diffing ids it never wrote.
    expect(await changed).toBe("remote");
    const shared = await waitForTileCount(resident.homeClient, 2);
    expect(tileForTerminal(shared, guest.terminal.id)).toBe(added.tileId);
    await waitFor(
      async () => (await listContainers(server)).every((row) => row.id !== bornHome),
      10_000,
      50,
    );

    // Extraction: the leaf leaves a MULTI-tile composition, so its terminal is re-homed into
    // a composition that did not exist a moment ago, and the canvas gets a portal onto that.
    const extracted = await place(server, {
      ref: { kind: "tile", containerId: resident.terminal.containerId, tileId: added.tileId },
      destination: { kind: "canvas", containerId: container.id, x: 640, y: 700 },
    });
    if (extracted.op !== "extract") throw new Error(`expected extract, got ${extracted.op}`);
    await waitFor(() => canvas.elements.has(extracted.elementId), 10_000, 20);
    const authored = canvas.elements.get(extracted.elementId);
    if (authored?.type !== "portal") throw new Error("extract authored no portal element");
    expect(authored).toMatchObject({ x: 640, y: 700 });
    // The envelope carries the reference; `elementString` is how a reader that KNOWS the field
    // asks for it (ADR 0013 §16), and a null here would be a portal with no target at all.
    const newHome = elementString(authored, "containerId") ?? "";
    expect(newHome).not.toBe(resident.terminal.containerId);
    expect(newHome).not.toBe(bornHome);
    expect(newHome).not.toBe(container.id);

    expect(censusSolo(await censusOf(server, newHome))).toEqual(soloTerminal(guest.terminal.id));
    const indexed = (await listTerminals(server)).find(
      (terminal) => terminal.id === guest.terminal.id,
    );
    expect(indexed).toMatchObject({ homeId: newHome, status: "running", unplaced: false });
    // The source composition still holds the resident, so it was not emptied and stays.
    const remaining = await waitForTileCount(resident.homeClient, 1);
    expect(tileForTerminal(remaining, resident.terminal.id)).not.toBeNull();
    expect((await listContainers(server)).map((row) => row.id)).toContain(
      resident.terminal.containerId,
    );

    // Same PTY, two placements later: the pre-merge screen replays out of the new home.
    const rehomed = await connect(server, { containerId: newHome, token, reconnect: false });
    clients.push(rehomed);
    await waitFor(
      () => rehomed.terminals.get(guest.terminal.id)?.containerId === newHome,
      10_000,
      20,
    );
    const rehomedCapture = await attachedCapture(rehomed, guest.terminal.id);
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
    const { server, token, container } = await startWorkspace("unplace", servers, agents);
    const canvas = await connect(server, { containerId: container.id, token, reconnect: false });
    clients.push(canvas);
    const { terminal, homeClient } = await openTerminalAt(canvas, server, {
      elementId: "el-unplace",
      token,
      portalAt: { x: 260, y: 200 },
    });
    clients.push(homeClient);

    // A second reference to the same composition: naming the ITEM releases all of them, which
    // is what distinguishes an identity unplace from releasing one portal.
    canvas.transact((tx) => {
      tx.create(portalElement("el-mirror", terminal.containerId, { x: 900, y: 200 }));
    });
    await waitFor(() => canvas.elements.has("el-mirror"), 10_000, 20);

    const mark = sentinel("unplaced");
    const capture = await attachedCapture(homeClient, terminal.id);
    captures.push(capture);
    homeClient.sendTerminalInput(terminal.id, mark.command);
    await waitForTerminalText(capture, mark.text, 10_000);

    const released = await place(server, {
      ref: { kind: "terminal", terminalId: terminal.id },
      destination: { kind: "unplaced" },
    });
    expect(released).toEqual({ op: "unplace", removed: 2 });
    await waitFor(
      () => !canvas.elements.has("el-unplace") && !canvas.elements.has("el-mirror"),
      10_000,
      20,
    );
    expect((await censusOf(server, container.id)).references).toEqual([]);

    // THIS is the whole difference from the park it replaced: the terminal did not move, did
    // not die, and is still indexed — it is simply unreferenced.
    const indexed = (await listTerminals(server)).find((terminal) => terminal.id === terminal.id);
    expect(indexed).toMatchObject({
      id: terminal.id,
      homeId: terminal.containerId,
      status: "running",
      exitCode: null,
      unplaced: true,
    });
    expect(censusSolo(await censusOf(server, terminal.containerId))).toEqual(
      soloTerminal(terminal.id),
    );

    // A client that joins the home only AFTER the unplace still gets the pre-unplace screen.
    const rejoin = await connect(server, {
      containerId: terminal.containerId,
      token,
      reconnect: false,
    });
    clients.push(rejoin);
    await waitFor(() => rejoin.terminals.get(terminal.id)?.status === "running", 10_000, 20);
    const rejoinCapture = await attachedCapture(rejoin, terminal.id);
    captures.push(rejoinCapture);
    expect(rejoinCapture.pendingOutputCount).toBe(0);
    expect(rejoinCapture.snapshotText).toContain(mark.text);

    // Zero removed is a legal answer: it says "already unplaced" rather than failing.
    expect(
      await place(server, {
        ref: { kind: "terminal", terminalId: terminal.id },
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
    const { server, agent, token, container } = await startWorkspace("reap", servers, agents);
    const canvas = await connect(server, { containerId: container.id, token, reconnect: false });
    clients.push(canvas);
    const { terminal, homeClient } = await openTerminalAt(canvas, server, {
      elementId: "el-reap",
      token,
      portalAt: { x: 200, y: 200 },
    });
    clients.push(homeClient);
    const layout = await waitForTileCount(homeClient, 1);
    const leaf = tileForTerminal(layout, terminal.id);
    if (leaf === null) throw new Error("the newborn composition holds no terminal leaf");

    // Closing a terminal's only leaf closes the terminal: there is no pool to fall into, so
    // the operator who removed its last representation removed the terminal.
    const removed = await ownerFetch(
      server,
      `/api/containers/${terminal.containerId}/tiles/${leaf}`,
      {
        method: "DELETE",
        responseSchema: OkResponseSchema,
      },
    );
    expect(removed.ok).toBe(true);

    await waitFor(
      () =>
        agent.output.stdout.some(
          (line) =>
            line.includes('"evt":"exited"') &&
            line.includes(`"terminalId":${JSON.stringify(terminal.id)}`),
        ),
      15_000,
      50,
    );
    await waitFor(async () => (await listTerminals(server)).length === 0, 15_000, 100);
    // The composition it emptied retires with it, and the canvas's reference goes with that.
    await waitFor(
      async () => {
        const ids = (await listContainers(server)).map((row) => row.id);
        return ids.length === 1 && ids[0] === container.id;
      },
      10_000,
      50,
    );
    await waitFor(() => !canvas.elements.has("el-reap"), 10_000, 20);
    expect((await censusOf(server, container.id)).references).toEqual([]);
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
    const { server, agent, token, container } = await startWorkspace("kill", servers, agents);
    const canvas = await connect(server, { containerId: container.id, token, reconnect: false });
    clients.push(canvas);
    const { terminal, homeClient } = await openTerminalAt(canvas, server, {
      elementId: "el-kill",
      token,
      portalAt: { x: 200, y: 200 },
    });
    clients.push(homeClient);
    // A second portal onto the same terminal, because "gone" has to mean gone from every
    // canvas rather than from the one the killer happened to be looking at.
    canvas.transact((tx) => {
      tx.create(portalElement("el-kill-mirror", terminal.containerId, { x: 980, y: 200 }));
    });
    await waitFor(() => canvas.elements.has("el-kill-mirror"), 10_000, 20);

    // Prove the PTY is real and answering before it is destroyed.
    const mark = sentinel("killed");
    const capture = await attachedCapture(homeClient, terminal.id);
    captures.push(capture);
    homeClient.sendTerminalInput(terminal.id, mark.command);
    await waitForTerminalText(capture, mark.text, 10_000);

    await invokeAction(server, "core.terminals.kill", { terminalId: terminal.id });

    // The PTY really stopped: the agent, not the server, says so.
    await waitFor(
      () =>
        agent.output.stdout.some(
          (line) =>
            line.includes('"evt":"exited"') &&
            line.includes(`"terminalId":${JSON.stringify(terminal.id)}`),
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
    const containers = (await listContainers(server)).map((row) => row.id);
    expect(containers).toEqual([container.id]);
    // Both portals vanish through the document, which is how live viewers learn about it.
    await waitFor(
      () => !canvas.elements.has("el-kill") && !canvas.elements.has("el-kill-mirror"),
      10_000,
      20,
    );
    expect((await censusOf(server, container.id)).references).toEqual([]);
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
    const { server, token, container } = await startWorkspace("natural-exit", servers, agents);
    const canvas = await connect(server, { containerId: container.id, token, reconnect: false });
    clients.push(canvas);
    const { terminal, homeClient } = await openTerminalAt(canvas, server, {
      elementId: "el-exit",
      token,
      portalAt: { x: 240, y: 180 },
    });
    clients.push(homeClient);
    const mark = sentinel("alive");
    const capture = await attachedCapture(homeClient, terminal.id);
    captures.push(capture);
    homeClient.sendTerminalInput(terminal.id, mark.command);
    await waitForTerminalText(capture, mark.text, 10_000);

    // Nobody asked for this. The shell decides to stop, and it names its own code.
    homeClient.sendTerminalInput(terminal.id, "exit 7\n");
    await waitFor(() => homeClient.terminals.get(terminal.id)?.status === "exited", 15_000, 20);
    expect(homeClient.terminals.get(terminal.id)?.exitCode).toBe(7);

    // A dead terminal is information the operator may want, so nothing is deleted: the row
    // keeps the REAL code, its home keeps its leaf, and the canvas keeps its portal.
    const indexed = (await listTerminals(server)).find((terminal) => terminal.id === terminal.id);
    expect(indexed).toMatchObject({
      id: terminal.id,
      homeId: terminal.containerId,
      status: "exited",
      exitCode: 7,
      unplaced: false,
    });
    expect(censusSolo(await censusOf(server, terminal.containerId))).toEqual(
      soloTerminal(terminal.id),
    );
    expect(canvas.elements.has("el-exit")).toBe(true);
    expect((await censusOf(server, container.id)).references).toEqual([terminal.containerId]);
    // Rejoining the home still finds the exit on screen, which is the whole point of keeping it.
    const rejoin = await connect(server, {
      containerId: terminal.containerId,
      token,
      reconnect: false,
    });
    clients.push(rejoin);
    await waitFor(() => rejoin.terminals.get(terminal.id)?.status === "exited", 10_000, 20);
    expect(rejoin.terminals.get(terminal.id)?.exitCode).toBe(7);

    // And only a deliberate kill destroys it: the same terminal, dismissed, poofs like any
    // other — which is the contrast this test exists to draw.
    await invokeAction(server, "core.terminals.kill", { terminalId: terminal.id });
    await waitFor(async () => (await listTerminals(server)).length === 0, 15_000, 100);
    await waitFor(() => !canvas.elements.has("el-exit"), 10_000, 20);
    expect((await listContainers(server)).map((row) => row.id)).toEqual([container.id]);
  } catch (error) {
    throw e2eFailure(error, [...servers, ...agents]);
  } finally {
    for (const capture of captures) capture.stop();
    closeClients(clients);
    await stopProcesses([...servers, ...agents]);
  }
}, 90_000);
