import { expect, test } from "bun:test";
import { OkResponseSchema, PadSessionsResponseSchema } from "@manifold/protocol";
import { tileIdForSurface } from "@manifold/scene";
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
  terminalElement,
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
    const pad = await createPad(server, "terminal");
    const enrolled = await enrollMachine(server, "terminal-agent");
    const agent = await startAgent({
      serverUrl: server.url,
      machineToken: enrolled.machineToken,
      name: "terminal-agent",
    });
    agents.push(agent);
    expect(agent.machineId).toBe(enrolled.machineId);

    const alice = await mintToken(server, {
      principal: { kind: "human", name: "Terminal Alice", color: "#aa3344" },
      caps: ["pads:read", "scene:write", "terminal:spawn", "terminal:write"],
      padId: pad.id,
    });
    const bob = await mintToken(server, {
      principal: { kind: "human", name: "Terminal Bob", color: "#3355cc" },
      caps: ["pads:read", "scene:write", "terminal:spawn", "terminal:write"],
      padId: pad.id,
    });
    const clientA = await connect(server, { padId: pad.id, token: alice.token });
    clients.push(clientA);
    if (clientA.self === null) throw new Error("terminal opener lacks self");

    const session = await clientA.openTerminal({
      elementId: "el-term-1",
      cols: 80,
      rows: 24,
    });
    expect(session.status).toBe("running");
    expect(session.controllerId).toBe(alice.principal.id);
    const inventory = await ownerFetch(server, "/api/pad-sessions", {
      responseSchema: PadSessionsResponseSchema,
    });
    const listedSession = inventory.sessions.find((candidate) => candidate.id === session.id);
    expect(listedSession).toMatchObject({
      id: session.id,
      padId: pad.id,
      machineId: enrolled.machineId,
      status: "running",
      exitCode: null,
    });
    expect(listedSession?.createdAt).toBeNumber();
    clientA.transact((tx) => {
      tx.create(terminalElement("el-term-1", { sessionId: session.id }));
    });

    const clientB = await connect(server, { padId: pad.id, token: bob.token });
    clients.push(clientB);
    if (clientB.self === null) throw new Error("terminal viewer lacks self");
    await waitFor(() => clientB.elements.has("el-term-1"), 10_000, 20);
    expect(clientB.sessions.get(session.id)?.status).toBe("running");

    const captureA = captureTerminal(clientA, session.id);
    const captureB = captureTerminal(clientB, session.id);
    captures.push(captureA, captureB);
    clientA.attachTerminal(session.id);
    clientB.attachTerminal(session.id);
    await waitFor(() => captureA.snapshotSeq !== null && captureB.snapshotSeq !== null, 10_000, 20);
    expect(captureA.pendingOutputCount).toBe(0);
    expect(captureB.pendingOutputCount).toBe(0);

    clientA.sendTerminalInput(session.id, "printf 'RT_%s\\n' ok\n");
    await Promise.all([
      waitForTerminalText(captureA, "RT_ok", 10_000),
      waitForTerminalText(captureB, "RT_ok", 10_000),
    ]);

    const viewers: SessionClient[] = [];
    const viewerCaptures: TerminalCapture[] = [];
    for (let index = 0; index < 10; index += 1) {
      const viewer = await connect(server, { padId: pad.id, token: bob.token });
      viewers.push(viewer);
      clients.push(viewer);
      const capture = captureTerminal(viewer, session.id);
      viewerCaptures.push(capture);
      captures.push(capture);
    }

    clientA.sendTerminalInput(session.id, COUNTER_COMMAND);
    await Promise.all(
      viewers.map(async (viewer, index) => {
        // This e2e deliberately needs real 5-50ms network staggering to race live PTY output
        // against snapshot handoff; fake timers cannot drive independent child processes.
        const delayMs = 5 + ((index * 29 + 17) % 46);
        await Bun.sleep(delayMs);
        viewer.attachTerminal(session.id);
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
    clientB.sendTerminalInput(session.id, "printf 'SHOULD_NOT_RUN\\n'\n");
    expect((await deniedB).code).toBe("not_controller");

    const controllerChanged = nextMessage(
      clientA,
      "session_event",
      5_000,
      (message) =>
        message.sessionId === session.id &&
        message.kind === "controller_changed" &&
        message.controllerId === bob.principal.id,
    );
    clientB.takeTerminal(session.id);
    const changed = await controllerChanged;
    expect(changed.controllerId).toBe(bob.principal.id);
    await waitFor(
      () => clientA.sessions.get(session.id)?.controllerId === bob.principal.id,
      5_000,
      20,
    ).catch((error: unknown) => {
      throw new Error("controller state did not converge after terminal_take", { cause: error });
    });

    const beforeControllerOutput = captureB.snapshotText.length + captureB.outputText.length;
    clientB.sendTerminalInput(session.id, "printf 'CTRL_B\\n'\n");
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
    clientA.sendTerminalInput(session.id, "printf 'OLD_CONTROLLER\\n'\n");
    expect((await deniedA).code).toBe("not_controller");

    const resized = nextMessage(
      clientA,
      "session_event",
      5_000,
      (message) =>
        message.sessionId === session.id &&
        message.kind === "resized" &&
        message.cols === 100 &&
        message.rows === 30,
    );
    clientB.resizeTerminal(session.id, 100, 30);
    await resized;
    const beforeResizeProbeOutput = captureA.snapshotText.length + captureA.outputText.length;
    clientB.sendTerminalInput(session.id, 'printf \'SIZE_%s_%s\\n\' "$LINES" "$COLUMNS"\n');
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

    const exited = nextMessage(
      clientA,
      "session_event",
      10_000,
      (message) => message.sessionId === session.id && message.kind === "exited",
    );
    clientB.killTerminal(session.id);
    const exitEvent = await exited;
    expect(exitEvent.kind).toBe("exited");
    await waitFor(
      () =>
        clientA.sessions.get(session.id)?.status === "exited" &&
        clientB.sessions.get(session.id)?.status === "exited",
      10_000,
      20,
    );
    expect(clientA.sessions.get(session.id)?.status).toBe("exited");
  } catch (error) {
    throw e2eFailure(error, [...servers, ...agents]);
  } finally {
    for (const capture of captures) capture.stop();
    closeClients(clients);
    await stopProcesses([...servers, ...agents]);
  }
}, 90_000);

test("an exited terminal rejects input, resize, take, and kill with conflict", async () => {
  const servers: TestServer[] = [];
  const agents: TestAgent[] = [];
  const clients: SessionClient[] = [];
  try {
    const server = await startServer();
    servers.push(server);
    const pad = await createPad(server, "exited terminal gates");
    const enrolled = await enrollMachine(server, "exited-terminal-agent");
    const agent = await startAgent({
      serverUrl: server.url,
      machineToken: enrolled.machineToken,
      name: "exited-terminal-agent",
    });
    agents.push(agent);
    const grant = await mintToken(server, {
      principal: { kind: "human", name: "Exited Controller", color: "#854d9e" },
      caps: ["pads:read", "terminal:spawn", "terminal:write"],
      padId: pad.id,
    });
    const client = await connect(server, { padId: pad.id, token: grant.token, reconnect: false });
    clients.push(client);
    const session = await client.openTerminal({
      elementId: "el-exited-gates",
      cols: 80,
      rows: 24,
    });
    const exited = nextMessage(
      client,
      "session_event",
      10_000,
      (message) => message.sessionId === session.id && message.kind === "exited",
    );
    client.killTerminal(session.id);
    expect((await exited).kind).toBe("exited");
    await waitFor(() => client.sessions.get(session.id)?.status === "exited", 10_000, 20);

    const inputConflict = nextMessage(
      client,
      "error",
      5_000,
      (message) =>
        message.code === "conflict" &&
        message.ref === session.id &&
        message.message === "session has exited",
    );
    client.sendTerminalInput(session.id, "printf 'AFTER_EXIT\\n'\n");
    expect((await inputConflict).code).toBe("conflict");

    const resizeConflict = nextMessage(
      client,
      "error",
      5_000,
      (message) =>
        message.code === "conflict" &&
        message.ref === session.id &&
        message.message === "session has exited",
    );
    client.resizeTerminal(session.id, 120, 40);
    expect((await resizeConflict).code).toBe("conflict");

    const takeConflict = nextMessage(
      client,
      "error",
      5_000,
      (message) =>
        message.code === "conflict" &&
        message.ref === session.id &&
        message.message === "session has exited",
    );
    client.takeTerminal(session.id);
    expect((await takeConflict).code).toBe("conflict");

    const killConflict = nextMessage(
      client,
      "error",
      5_000,
      (message) =>
        message.code === "conflict" &&
        message.ref === session.id &&
        message.message === "session has exited",
    );
    client.killTerminal(session.id);
    expect((await killConflict).code).toBe("conflict");
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
    const pad = await createPad(server, "multi-machine terminal");
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
      caps: ["pads:read", "terminal:spawn", "terminal:write"],
      padId: pad.id,
    });
    const client = await connect(server, { padId: pad.id, token: grant.token, reconnect: false });
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

    const session = await client.openTerminal({
      elementId: "el-explicit-machine",
      cols: 80,
      rows: 24,
      machineId: secondEnrollment.machineId,
    });
    expect(session.machineId).toBe(secondEnrollment.machineId);
    expect(session.status).toBe("running");

    const exited = nextMessage(
      client,
      "session_event",
      10_000,
      (message) => message.sessionId === session.id && message.kind === "exited",
    );
    client.killTerminal(session.id);
    expect((await exited).kind).toBe("exited");
    await waitFor(() => client.sessions.get(session.id)?.status === "exited", 10_000, 20);
  } catch (error) {
    throw e2eFailure(error, [...servers, ...agents]);
  } finally {
    closeClients(clients);
    await stopProcesses([...servers, ...agents]);
  }
}, 45_000);

test("deleting a pad with a running terminal kills its agent-owned PTY", async () => {
  const servers: TestServer[] = [];
  const agents: TestAgent[] = [];
  const clients: SessionClient[] = [];
  try {
    const server = await startServer();
    servers.push(server);
    const pad = await createPad(server, "delete running terminal");
    const enrolled = await enrollMachine(server, "delete-terminal-agent");
    const agent = await startAgent({
      serverUrl: server.url,
      machineToken: enrolled.machineToken,
      name: "delete-terminal-agent",
    });
    agents.push(agent);
    const grant = await mintToken(server, {
      principal: { kind: "human", name: "Pad Deleter", color: "#a04b39" },
      caps: ["pads:read", "terminal:spawn", "terminal:write"],
      padId: pad.id,
    });
    const client = await connect(server, { padId: pad.id, token: grant.token, reconnect: false });
    clients.push(client);
    const session = await client.openTerminal({
      elementId: "el-delete-running-terminal",
      cols: 80,
      rows: 24,
    });
    expect(session.status).toBe("running");

    const deleted = await ownerFetch(server, `/api/pads/${pad.id}`, {
      method: "DELETE",
      responseSchema: OkResponseSchema,
    });
    expect(deleted.ok).toBe(true);
    await waitFor(
      () =>
        agent.output.stdout.some(
          (line) =>
            line.includes('"evt":"exited"') &&
            line.includes(`"sessionId":${JSON.stringify(session.id)}`),
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
    const view = await createPad(server, "tiled view", "tiled");
    expect(view.layout).toBe("tiled");
    const enrolled = await enrollMachine(server, "tiled-open-agent");
    const agent = await startAgent({
      serverUrl: server.url,
      machineToken: enrolled.machineToken,
      name: "tiled-open-agent",
    });
    agents.push(agent);

    const grant = await mintToken(server, {
      principal: { kind: "human", name: "Tile Opener", color: "#557799" },
      caps: ["pads:read", "scene:write", "terminal:spawn", "terminal:write"],
      padId: view.id,
    });
    const client = await connect(server, { padId: view.id, token: grant.token });
    clients.push(client);
    if (client.self === null) throw new Error("terminal opener lacks self");

    // A view has no canvas to author an element on: the "+" hands placement to the
    // container, and the leaf the server wrote is read back out of the layout tree —
    // the session record carries no placement id to trust.
    const session = await client.openTerminal({
      elementId: "correlation-only",
      placement: "tile",
      cols: 80,
      rows: 24,
    });
    expect(session.status).toBe("running");
    expect(session.padId).toBe(view.id);
    expect(session.controllerId).toBe(grant.principal.id);

    const surface = { kind: "terminal" as const, sessionId: session.id };
    await waitFor(() => tileIdForSurface(client.layout(), surface) !== null, 10_000, 20);
    const tileId = tileIdForSurface(client.layout(), surface);
    // The opener never chose this id: the container did.
    expect(tileId).not.toBe("correlation-only");
    expect(client.layout()?.[tileId ?? ""]?.surface).toEqual(surface);

    const capture = captureTerminal(client, session.id);
    captures.push(capture);
    client.attachTerminal(session.id);
    await waitFor(() => capture.snapshotSeq !== null, 10_000, 20);
    client.sendTerminalInput(session.id, "printf 'TILE_%s\\n' ok\n");
    await waitForTerminalText(capture, "TILE_ok", 10_000);
  } catch (error) {
    throw e2eFailure(error, [...servers, ...agents]);
  } finally {
    closeClients(clients);
    await stopProcesses([...servers, ...agents]);
  }
}, 45_000);
