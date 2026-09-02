import { expect, test } from "bun:test";
import { tileIdForRef } from "@manifold/scene";
import type { SessionClient } from "@manifold/sdk";
import {
  connect,
  createContainer,
  deleteContainer,
  enrollMachine,
  listTerminalsByContainer,
  listTerminals,
  mintToken,
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
  openTerminalAt,
  stopProcesses,
  waitForTerminalText,
  type TerminalCapture,
} from "./helpers.ts";

const COUNTER_COMMAND =
  'i=1; while [ "$i" -le 400 ]; do printf \'N%s\\n\' "$i"; ' +
  'spin=0; while [ "$spin" -lt 2000 ]; do spin=$((spin + 1)); done; ' +
  "i=$((i + 1)); done\n";

test("terminal lifecycle enforces attach contiguity, controller authority, resize, and kill", async () => {
  const servers: TestServer[] = [];
  const agents: TestAgent[] = [];
  const clients: SessionClient[] = [];
  const captures: TerminalCapture[] = [];
  try {
    const server = await startServer();
    servers.push(server);
    const container = await createContainer(server, "terminal");
    const enrolled = await enrollMachine(server, "terminal-agent");
    const agent = await startAgent({
      serverUrl: server.url,
      machineToken: enrolled.machineToken,
      name: "terminal-agent",
    });
    agents.push(agent);
    expect(agent.machineId).toBe(enrolled.machineId);

    // Workspace-scoped grants: a terminal is born into a composition of its own, and driving
    // it means joining that composition — an id no container-scoped token could name.
    const alice = await mintToken(server, {
      principal: { kind: "human", name: "Terminal Alice", color: "#aa3344" },
      caps: ["containers:read", "scenes:write", "terminals:spawn", "terminals:write"],
    });
    const bob = await mintToken(server, {
      principal: { kind: "human", name: "Terminal Bob", color: "#3355cc" },
      caps: ["containers:read", "scenes:write", "terminals:spawn", "terminals:write"],
    });
    const canvas = await connect(server, { containerId: container.id, token: alice.token });
    clients.push(canvas);
    if (canvas.self === null) throw new Error("terminal opener lacks self");

    // The canvas owns the spawn gesture; the composition the server births owns the PTY, so
    // `clientA` and every viewer below are rooms of that composition.
    const { terminal, homeClient: clientA } = await openTerminalAt(canvas, server, {
      elementId: "el-term-1",
      token: alice.token,
      portalAt: { x: 120, y: 90 },
    });
    clients.push(clientA);
    expect(terminal.controllerId).toBe(alice.principal.id);
    expect(terminal.containerId).not.toBe(container.id);
    // What the canvas got is a REFERENCE to that composition, never the terminal itself.
    expect(canvas.elements.get("el-term-1")).toMatchObject({
      type: "portal",
      containerId: terminal.containerId,
      x: 120,
      y: 90,
    });
    const inventory = await listTerminalsByContainer(server);
    const listedTerminal = inventory.find((candidate) => candidate.id === terminal.id);
    expect(listedTerminal).toMatchObject({
      id: terminal.id,
      containerId: terminal.containerId,
      machineId: enrolled.machineId,
      status: "running",
      exitCode: null,
    });
    expect(listedTerminal?.createdAt).toBeNumber();

    const clientB = await connect(server, { containerId: terminal.containerId, token: bob.token });
    clients.push(clientB);
    if (clientB.self === null) throw new Error("terminal viewer lacks self");
    await waitFor(() => clientB.terminals.get(terminal.id)?.status === "running", 10_000, 20);

    const captureA = captureTerminal(clientA, terminal.id);
    const captureB = captureTerminal(clientB, terminal.id);
    captures.push(captureA, captureB);
    clientA.attachTerminal(terminal.id);
    clientB.attachTerminal(terminal.id);
    await waitFor(() => captureA.snapshotSeq !== null && captureB.snapshotSeq !== null, 10_000, 20);
    expect(captureA.pendingOutputCount).toBe(0);
    expect(captureB.pendingOutputCount).toBe(0);

    clientA.sendTerminalInput(terminal.id, "printf 'RT_%s\\n' ok\n");
    await Promise.all([
      waitForTerminalText(captureA, "RT_ok", 10_000),
      waitForTerminalText(captureB, "RT_ok", 10_000),
    ]);

    const viewers: SessionClient[] = [];
    const viewerCaptures: TerminalCapture[] = [];
    for (let index = 0; index < 10; index += 1) {
      const viewer = await connect(server, { containerId: terminal.containerId, token: bob.token });
      viewers.push(viewer);
      clients.push(viewer);
      const capture = captureTerminal(viewer, terminal.id);
      viewerCaptures.push(capture);
      captures.push(capture);
    }

    clientA.sendTerminalInput(terminal.id, COUNTER_COMMAND);
    await Promise.all(
      viewers.map(async (viewer, index) => {
        // This e2e deliberately needs real 5-50ms network staggering to race live PTY output
        // against snapshot handoff; fake timers cannot drive independent child processes.
        const delayMs = 5 + ((index * 29 + 17) % 46);
        await Bun.sleep(delayMs);
        viewer.attachTerminal(terminal.id);
      }),
    );
    await Promise.all(
      viewerCaptures.map((capture) => waitForTerminalText(capture, "N400", 15_000)),
    );

    for (const capture of viewerCaptures) {
      const snapshotSeq = capture.snapshotSeq;
      if (snapshotSeq === null) throw new Error("viewer never received terminal_snapshot");
      expect(capture.pendingOutputCount).toBe(0);
      expect(capture.outputSeqs.length).toBeGreaterThan(0);
      expect(capture.outputSeqs[0]).toBe(snapshotSeq + 1);
      for (let index = 1; index < capture.outputSeqs.length; index += 1) {
        const previous = capture.outputSeqs[index - 1];
        const current = capture.outputSeqs[index];
        if (previous === undefined || current === undefined) throw new Error("seq list changed");
        expect(current).toBe(previous + 1);
        expect(current).toBeGreaterThan(snapshotSeq);
      }
      // Serialized snapshots may encode line breaks as cursor movements (e.g. ESC[1B ESC[2D),
      // so marker coverage asserts presence with a digit-boundary guard, not CRLF framing —
      // ordering/loss are already proven above by the exact seq-contiguity assertions.
      const streamText = capture.snapshotText + capture.outputText;
      for (let marker = 1; marker <= 400; marker += 1) {
        expect(streamText).toMatch(new RegExp(`N${marker}(?!\\d)`));
      }
    }
    closeClients(viewers);

    const deniedB = nextMessage(
      clientB,
      "error",
      5_000,
      (message) => message.code === "not_controller",
    );
    clientB.sendTerminalInput(terminal.id, "printf 'SHOULD_NOT_RUN\\n'\n");
    expect((await deniedB).code).toBe("not_controller");

    const controllerChanged = nextMessage(
      clientA,
      "terminal_event",
      5_000,
      (message) =>
        message.terminalId === terminal.id &&
        message.kind === "controller_changed" &&
        message.controllerId === bob.principal.id,
    );
    clientB.takeTerminal(terminal.id);
    const changed = await controllerChanged;
    expect(changed.controllerId).toBe(bob.principal.id);
    await waitFor(
      () => clientA.terminals.get(terminal.id)?.controllerId === bob.principal.id,
      5_000,
      20,
    ).catch((error: unknown) => {
      throw new Error("controller state did not converge after terminal_take", { cause: error });
    });

    const beforeControllerOutput = captureB.snapshotText.length + captureB.outputText.length;
    clientB.sendTerminalInput(terminal.id, "printf 'CTRL_B\\n'\n");
    await waitFor(
      () =>
        (captureB.snapshotText + captureB.outputText)
          .slice(beforeControllerOutput)
          .includes("CTRL_B"),
      5_000,
      20,
    ).catch((error: unknown) => {
      throw new Error("new controller input produced no terminal output", { cause: error });
    });
    const deniedA = nextMessage(
      clientA,
      "error",
      5_000,
      (message) => message.code === "not_controller",
    );
    clientA.sendTerminalInput(terminal.id, "printf 'OLD_CONTROLLER\\n'\n");
    expect((await deniedA).code).toBe("not_controller");

    const resized = nextMessage(
      clientA,
      "terminal_event",
      5_000,
      (message) =>
        message.terminalId === terminal.id &&
        message.kind === "resized" &&
        message.cols === 100 &&
        message.rows === 30,
    );
    clientB.resizeTerminal(terminal.id, 100, 30);
    await resized;
    const beforeResizeProbeOutput = captureA.snapshotText.length + captureA.outputText.length;
    clientB.sendTerminalInput(terminal.id, 'printf \'SIZE_%s_%s\\n\' "$LINES" "$COLUMNS"\n');
    await waitFor(
      () =>
        (captureA.snapshotText + captureA.outputText)
          .slice(beforeResizeProbeOutput)
          .includes("SIZE_30_100"),
      5_000,
      20,
    ).catch((error: unknown) => {
      throw new Error("resized PTY did not report the requested geometry", { cause: error });
    });

    // A kill is DESTRUCTION, so the home hears a departure rather than an exit: the terminal
    // is gone, not dead, and every viewer drops the row at once instead of keeping a corpse.
    const departed = nextMessage(
      clientA,
      "terminal_event",
      10_000,
      (message) => message.terminalId === terminal.id && message.kind === "parked",
    );
    clientB.killTerminal(terminal.id);
    expect((await departed).kind).toBe("parked");
    await waitFor(
      () =>
        clientA.terminals.get(terminal.id) === undefined &&
        clientB.terminals.get(terminal.id) === undefined,
      10_000,
      20,
    );
    // The canvas's portal goes with it: a reference never outlives what it references.
    await waitFor(() => !canvas.elements.has("el-term-1"), 10_000, 20);
    expect(
      (await listTerminalsByContainer(server)).find((row) => row.id === terminal.id),
    ).toBeUndefined();
  } catch (error) {
    throw e2eFailure(error, [...servers, ...agents]);
  } finally {
    for (const capture of captures) capture.stop();
    closeClients(clients);
    await stopProcesses([...servers, ...agents]);
  }
}, 90_000);

test("an exited terminal refuses to be driven, but dismissing it destroys it", async () => {
  const servers: TestServer[] = [];
  const agents: TestAgent[] = [];
  const clients: SessionClient[] = [];
  try {
    const server = await startServer();
    servers.push(server);
    const container = await createContainer(server, "exited terminal gates");
    const enrolled = await enrollMachine(server, "exited-terminal-agent");
    const agent = await startAgent({
      serverUrl: server.url,
      machineToken: enrolled.machineToken,
      name: "exited-terminal-agent",
    });
    agents.push(agent);
    const grant = await mintToken(server, {
      principal: { kind: "human", name: "Exited Controller", color: "#854d9e" },
      caps: ["containers:read", "terminals:spawn", "terminals:write"],
    });
    const canvas = await connect(server, {
      containerId: container.id,
      token: grant.token,
      reconnect: false,
    });
    clients.push(canvas);
    // No portal is authored — this grant holds no `scenes:write` — because the gates under
    // test are the terminal's own, and an exited terminal keeps its leaf and its home either
    // way: the exit stays visible where the terminal lives.
    const { terminal, homeClient: client } = await openTerminalAt(canvas, server, {
      elementId: "el-exited-gates",
      token: grant.token,
    });
    clients.push(client);
    // The PTY stops ON ITS OWN, which is the only way to REACH the exited state: asking for
    // it would destroy the terminal, and then there would be nothing left to gate.
    const exited = nextMessage(
      client,
      "terminal_event",
      10_000,
      (message) => message.terminalId === terminal.id && message.kind === "exited",
    );
    client.sendTerminalInput(terminal.id, "exit 3\n");
    const exitEvent = await exited;
    expect(exitEvent.kind).toBe("exited");
    if (exitEvent.kind !== "exited") throw new Error("unreachable");
    // The REAL code the shell named, carried end to end from the PTY.
    expect(exitEvent.exitCode).toBe(3);
    await waitFor(() => client.terminals.get(terminal.id)?.status === "exited", 10_000, 20);
    expect(client.terminals.get(terminal.id)?.exitCode).toBe(3);

    const inputConflict = nextMessage(
      client,
      "error",
      5_000,
      (message) =>
        message.code === "conflict" &&
        message.ref === terminal.id &&
        message.message === "terminal has exited",
    );
    client.sendTerminalInput(terminal.id, "printf 'AFTER_EXIT\\n'\n");
    expect((await inputConflict).code).toBe("conflict");

    const resizeConflict = nextMessage(
      client,
      "error",
      5_000,
      (message) =>
        message.code === "conflict" &&
        message.ref === terminal.id &&
        message.message === "terminal has exited",
    );
    client.resizeTerminal(terminal.id, 120, 40);
    expect((await resizeConflict).code).toBe("conflict");

    const takeConflict = nextMessage(
      client,
      "error",
      5_000,
      (message) =>
        message.code === "conflict" &&
        message.ref === terminal.id &&
        message.message === "terminal has exited",
    );
    client.takeTerminal(terminal.id);
    expect((await takeConflict).code).toBe("conflict");

    // Dismissing it is not a conflict. A lease is a claim on a LIVE PTY, so an exited
    // terminal has no controller to win, and clearing it is the same verb as killing a
    // running one: the home hears a departure and the terminal leaves the world.
    const departed = nextMessage(
      client,
      "terminal_event",
      10_000,
      (message) => message.terminalId === terminal.id && message.kind === "parked",
    );
    client.killTerminal(terminal.id);
    expect((await departed).kind).toBe("parked");
    await waitFor(() => client.terminals.get(terminal.id) === undefined, 10_000, 20);
    expect(await listTerminals(server)).toEqual([]);
  } catch (error) {
    throw e2eFailure(error, [...servers, ...agents]);
  } finally {
    closeClients(clients);
    await stopProcesses([...servers, ...agents]);
  }
}, 30_000);

test("terminal_open rejects ambiguous machines and honors an explicit machineId", async () => {
  const servers: TestServer[] = [];
  const agents: TestAgent[] = [];
  const clients: SessionClient[] = [];
  try {
    const server = await startServer();
    servers.push(server);
    const container = await createContainer(server, "multi-machine terminal");
    const firstEnrollment = await enrollMachine(server, "terminal-machine-one");
    const secondEnrollment = await enrollMachine(server, "terminal-machine-two");
    const firstAgent = await startAgent({
      serverUrl: server.url,
      machineToken: firstEnrollment.machineToken,
      name: "terminal-machine-one",
    });
    agents.push(firstAgent);
    const secondAgent = await startAgent({
      serverUrl: server.url,
      machineToken: secondEnrollment.machineToken,
      name: "terminal-machine-two",
    });
    agents.push(secondAgent);
    expect(firstAgent.machineId).toBe(firstEnrollment.machineId);
    expect(secondAgent.machineId).toBe(secondEnrollment.machineId);

    const grant = await mintToken(server, {
      principal: { kind: "human", name: "Machine Picker", color: "#287c69" },
      caps: ["containers:read", "terminals:spawn", "terminals:write"],
    });
    const client = await connect(server, {
      containerId: container.id,
      token: grant.token,
      reconnect: false,
    });
    clients.push(client);

    const ambiguousError = nextMessage(
      client,
      "error",
      5_000,
      (message) =>
        message.code === "no_machine" &&
        message.ref === "el-ambiguous-machine" &&
        message.message === "no unambiguous online machine",
    );
    const ambiguousOpen = client
      .openTerminal({
        elementId: "el-ambiguous-machine",
        cols: 80,
        rows: 24,
        timeoutMs: 5_000,
      })
      .then(
        () => "opened" as const,
        () => "rejected" as const,
      );
    expect((await ambiguousError).code).toBe("no_machine");
    expect(await ambiguousOpen).toBe("rejected");

    const { terminal, homeClient: home } = await openTerminalAt(client, server, {
      elementId: "el-explicit-machine",
      token: grant.token,
      machineId: secondEnrollment.machineId,
    });
    clients.push(home);
    expect(terminal.machineId).toBe(secondEnrollment.machineId);

    // Killing it destroys it, so the home hears a departure and the row disappears.
    const departed = nextMessage(
      home,
      "terminal_event",
      10_000,
      (message) => message.terminalId === terminal.id && message.kind === "parked",
    );
    home.killTerminal(terminal.id);
    expect((await departed).kind).toBe("parked");
    await waitFor(() => home.terminals.get(terminal.id) === undefined, 10_000, 20);
  } catch (error) {
    throw e2eFailure(error, [...servers, ...agents]);
  } finally {
    closeClients(clients);
    await stopProcesses([...servers, ...agents]);
  }
}, 45_000);

test("deleting the composition a terminal lives in kills its agent-owned PTY", async () => {
  const servers: TestServer[] = [];
  const agents: TestAgent[] = [];
  const clients: SessionClient[] = [];
  try {
    const server = await startServer();
    servers.push(server);
    const container = await createContainer(server, "delete running terminal");
    const enrolled = await enrollMachine(server, "delete-terminal-agent");
    const agent = await startAgent({
      serverUrl: server.url,
      machineToken: enrolled.machineToken,
      name: "delete-terminal-agent",
    });
    agents.push(agent);
    const grant = await mintToken(server, {
      principal: { kind: "human", name: "Container Deleter", color: "#a04b39" },
      caps: ["containers:read", "terminals:spawn", "terminals:write"],
    });
    const client = await connect(server, {
      containerId: container.id,
      token: grant.token,
      reconnect: false,
    });
    clients.push(client);
    const terminal = await client.openTerminal({
      elementId: "el-delete-running-terminal",
      cols: 80,
      rows: 24,
    });
    expect(terminal.status).toBe("running");
    // The terminal lives in the composition born with it, not on the canvas that spawned it,
    // so THAT is the container whose deletion reaps the PTY.
    expect(terminal.containerId).not.toBe(container.id);

    await deleteContainer(server, terminal.containerId);
    await waitFor(
      () =>
        agent.output.stdout.some(
          (line) =>
            line.includes('"evt":"exited"') &&
            line.includes(`"terminalId":${JSON.stringify(terminal.id)}`),
        ),
      10_000,
      20,
    );
    expect(agent.proc.exitCode).toBeNull();
  } catch (error) {
    throw e2eFailure(error, [...servers, ...agents]);
  } finally {
    closeClients(clients);
    await stopProcesses([...servers, ...agents]);
  }
}, 45_000);

test("the Machines + on a view births a terminal the server places as a tile, and it streams", async () => {
  const servers: TestServer[] = [];
  const agents: TestAgent[] = [];
  const clients: SessionClient[] = [];
  const captures: TerminalCapture[] = [];
  try {
    const server = await startServer();
    servers.push(server);
    const view = await createContainer(server, "composition", "composition");
    expect(view.discipline).toBe("composition");
    const enrolled = await enrollMachine(server, "composition-open-agent");
    const agent = await startAgent({
      serverUrl: server.url,
      machineToken: enrolled.machineToken,
      name: "composition-open-agent",
    });
    agents.push(agent);

    const grant = await mintToken(server, {
      principal: { kind: "human", name: "Tile Opener", color: "#557799" },
      caps: ["containers:read", "scenes:write", "terminals:spawn", "terminals:write"],
      containerId: view.id,
    });
    const client = await connect(server, { containerId: view.id, token: grant.token });
    clients.push(client);
    if (client.self === null) throw new Error("terminal opener lacks self");

    // A view has no canvas to author an element on: the "+" hands placement to the
    // container, and the leaf the server wrote is read back out of the layout tree —
    // the terminal record carries no placement id to trust.
    const terminal = await client.openTerminal({
      elementId: "correlation-only",
      placement: "tile",
      cols: 80,
      rows: 24,
    });
    expect(terminal.status).toBe("running");
    expect(terminal.containerId).toBe(view.id);
    expect(terminal.controllerId).toBe(grant.principal.id);

    const ref = { kind: "terminal" as const, terminalId: terminal.id };
    await waitFor(() => tileIdForRef(client.layout(), ref) !== null, 10_000, 20);
    const tileId = tileIdForRef(client.layout(), ref);
    // The opener never chose this id: the container did.
    expect(tileId).not.toBe("correlation-only");
    expect(client.layout()?.[tileId ?? ""]?.ref).toEqual(ref);

    const capture = captureTerminal(client, terminal.id);
    captures.push(capture);
    client.attachTerminal(terminal.id);
    await waitFor(() => capture.snapshotSeq !== null, 10_000, 20);
    client.sendTerminalInput(terminal.id, "printf 'TILE_%s\\n' ok\n");
    await waitForTerminalText(capture, "TILE_ok", 10_000);
  } catch (error) {
    throw e2eFailure(error, [...servers, ...agents]);
  } finally {
    closeClients(clients);
    await stopProcesses([...servers, ...agents]);
  }
}, 45_000);
