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
  stopProcesses,
  terminalElement,
  waitForTerminalText,
  type TerminalCapture,
} from "./helpers.ts";

/**
 * The v12 transport invariant, end to end over real processes: a tab holding two rooms
 * holds ONE TCP connection, and both rooms stream live PTY bytes on it independently.
 */
test("two rooms of one tab share a single connection and stream PTYs independently", async () => {
  const servers: TestServer[] = [];
  const agents: TestAgent[] = [];
  const clients: SessionClient[] = [];
  const captures: TerminalCapture[] = [];
  try {
    const server = await startServer();
    servers.push(server);
    const canvas = await createPad(server, "multiplex canvas");
    const other = await createPad(server, "multiplex other");
    const enrolled = await enrollMachine(server, "multiplex-agent");
    const agent = await startAgent({
      serverUrl: server.url,
      machineToken: enrolled.machineToken,
      name: "multiplex-agent",
    });
    agents.push(agent);

    // One token: one principal, one tab, both rooms — exactly what a canvas plus a portal
    // widget looks like in the browser. The pool keys by (url, token), so this is one socket.
    const operator = await mintToken(server, {
      principal: { kind: "human", name: "Multiplex Operator", color: "#4477dd" },
      caps: ["pads:read", "scene:write", "terminal:spawn", "terminal:write"],
    });

    const inCanvas = await connect(server, { padId: canvas.id, token: operator.token });
    clients.push(inCanvas);
    const inOther = await connect(server, { padId: other.id, token: operator.token });
    clients.push(inOther);

    expect(inCanvas.transportId).not.toBeNull();
    expect(inCanvas.transportId).toBe(inOther.transportId);
    expect(inCanvas.channelId).not.toBe(inOther.channelId);
    // Distinct rooms: each channel got its own epoch and its own authoritative identity.
    expect(inCanvas.epoch).not.toBe(inOther.epoch);
    expect(inCanvas.selfConnId).not.toBe(inOther.selfConnId);

    const canvasSession = await inCanvas.openTerminal({
      elementId: "el-multiplex-canvas",
      cols: 80,
      rows: 24,
    });
    inCanvas.transact((tx) => {
      tx.create(terminalElement("el-multiplex-canvas", { sessionId: canvasSession.id }));
    });
    const otherSession = await inOther.openTerminal({
      elementId: "el-multiplex-other",
      cols: 80,
      rows: 24,
    });
    inOther.transact((tx) => {
      tx.create(terminalElement("el-multiplex-other", { sessionId: otherSession.id }));
    });
    expect(canvasSession.id).not.toBe(otherSession.id);

    const canvasCapture = captureTerminal(inCanvas, canvasSession.id);
    const otherCapture = captureTerminal(inOther, otherSession.id);
    captures.push(canvasCapture, otherCapture);
    inCanvas.attachTerminal(canvasSession.id);
    inOther.attachTerminal(otherSession.id);
    await waitFor(
      () => canvasCapture.snapshotSeq !== null && otherCapture.snapshotSeq !== null,
      15_000,
      20,
    );

    inCanvas.sendTerminalInput(canvasSession.id, "printf 'MX_A_%s\\n' ok\n");
    inOther.sendTerminalInput(otherSession.id, "printf 'MX_B_%s\\n' ok\n");
    await Promise.all([
      waitForTerminalText(canvasCapture, "MX_A_ok", 15_000),
      waitForTerminalText(otherCapture, "MX_B_ok", 15_000),
    ]);

    // Two PTYs, one connection, and no bleed between the rooms it carries.
    expect(canvasCapture.outputText).not.toContain("MX_B_ok");
    expect(otherCapture.outputText).not.toContain("MX_A_ok");
    expect(inCanvas.elements.has("el-multiplex-canvas")).toBe(true);
    expect(inCanvas.elements.has("el-multiplex-other")).toBe(false);
    expect(inOther.elements.has("el-multiplex-other")).toBe(true);
    expect(inOther.elements.has("el-multiplex-canvas")).toBe(false);
    expect(inCanvas.sessions.has(otherSession.id)).toBe(false);
    expect(inOther.sessions.has(canvasSession.id)).toBe(false);

    // One room leaving frees only its channel: the other keeps streaming on the same socket.
    inCanvas.close();
    inOther.sendTerminalInput(otherSession.id, "printf 'MX_B2_%s\\n' ok\n");
    await waitForTerminalText(otherCapture, "MX_B2_ok", 15_000);
    expect(inOther.status).toBe("open");
  } catch (error) {
    throw e2eFailure(error, [...servers, ...agents]);
  } finally {
    for (const capture of captures) capture.stop();
    closeClients(clients);
    await stopProcesses([...agents, ...servers]);
  }
}, 90_000);
