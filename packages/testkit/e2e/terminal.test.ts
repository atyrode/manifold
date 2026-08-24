import { expect, test } from "bun:test";
import type { SessionClient } from "@manifold/sdk";
import {
  connect,
  createPad,
  enrollMachine,
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
  sceneElement,
  stopProcesses,
  waitForTerminalText,
  type TerminalCapture,
} from "./helpers.ts";

const COUNTER_COMMAND =
  "for i in $(seq 1 400); do echo N$i; done | " +
  "while IFS= read -r line; do printf '%s\\n' \"$line\"; sleep 0.005; done\n";

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
    const terminalElementAck = nextMessage(clientA, "scene_ack", 10_000, (message) =>
      message.acceptedIds.includes("el-term-1"),
    );
    expect(
      clientA.updateScene([
        {
          ...sceneElement("el-term-1"),
          customData: { kind: "terminal", sessionId: session.id },
        },
      ]),
    ).not.toBeNull();
    await terminalElementAck;
    const clientB = await connect(server, { padId: pad.id, token: bob.token });
    clients.push(clientB);
    if (clientB.self === null) throw new Error("terminal viewer lacks self");
    expect(clientB.scene.has("el-term-1")).toBe(true);
    expect(clientB.sessions.get(session.id)?.status).toBe("running");

    const captureA = captureTerminal(clientA, session.id);
    const captureB = captureTerminal(clientB, session.id);
    captures.push(captureA, captureB);
    clientA.attachTerminal(session.id);
    clientB.attachTerminal(session.id);
    await waitFor(() => captureA.snapshotSeq !== null && captureB.snapshotSeq !== null, 10_000, 20);

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
    );

    const beforeControllerOutput = captureB.snapshotText.length + captureB.outputText.length;
    clientB.sendTerminalInput(session.id, "printf 'CTRL_B\\n'\n");
    await waitFor(
      () =>
        (captureB.snapshotText + captureB.outputText)
          .slice(beforeControllerOutput)
          .includes("CTRL_B"),
      5_000,
      20,
    );
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
    const beforeSttyOutput = captureA.snapshotText.length + captureA.outputText.length;
    clientB.sendTerminalInput(session.id, "stty size\n");
    await waitFor(
      () =>
        (captureA.snapshotText + captureA.outputText).slice(beforeSttyOutput).includes("30 100"),
      5_000,
      20,
    );

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
