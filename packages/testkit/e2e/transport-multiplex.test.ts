import { expect, test } from "bun:test";
import type { SessionClient } from "@manifold/sdk";
import {
  connect,
  createPad,
  enrollMachine,
  mintToken,
  startAgent,
  startServer,
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

/**
 * The v12 transport invariant, end to end over real processes: a tab holding several rooms
 * holds ONE TCP connection, and the rooms stream live PTY bytes on it independently.
 *
 * A terminal lives in a composition of its own, so a tab that spawned two terminals from two
 * canvases is holding FOUR rooms — which is exactly the arrangement the browser is in, and
 * exactly why the multiplex matters: it is one socket either way.
 */
test("the rooms of one tab share a single connection and stream PTYs independently", async () => {
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

    const canvasTerminal = await openTerminalAt(inCanvas, server, {
      elementId: "el-multiplex-canvas",
      token: operator.token,
      portalAt: { x: 40, y: 60 },
    });
    clients.push(canvasTerminal.homeClient);
    const otherTerminal = await openTerminalAt(inOther, server, {
      elementId: "el-multiplex-other",
      token: operator.token,
      portalAt: { x: 40, y: 60 },
    });
    clients.push(otherTerminal.homeClient);
    expect(canvasTerminal.session.id).not.toBe(otherTerminal.session.id);
    expect(canvasTerminal.session.padId).not.toBe(otherTerminal.session.padId);

    // Four rooms — two canvases and the two compositions their terminals were born into —
    // one socket, and a channel and an authoritative identity per room.
    const rooms = [inCanvas, inOther, canvasTerminal.homeClient, otherTerminal.homeClient];
    for (const room of rooms) expect(room.transportId).toBe(inCanvas.transportId);
    expect(new Set(rooms.map((room) => room.channelId)).size).toBe(rooms.length);
    expect(new Set(rooms.map((room) => room.epoch)).size).toBe(rooms.length);
    expect(new Set(rooms.map((room) => room.selfConnId)).size).toBe(rooms.length);

    const canvasCapture = await attachedCapture(
      canvasTerminal.homeClient,
      canvasTerminal.session.id,
      15_000,
    );
    const otherCapture = await attachedCapture(
      otherTerminal.homeClient,
      otherTerminal.session.id,
      15_000,
    );
    captures.push(canvasCapture, otherCapture);

    canvasTerminal.homeClient.sendTerminalInput(
      canvasTerminal.session.id,
      "printf 'MX_A_%s\\n' ok\n",
    );
    otherTerminal.homeClient.sendTerminalInput(
      otherTerminal.session.id,
      "printf 'MX_B_%s\\n' ok\n",
    );
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
    expect(canvasTerminal.homeClient.sessions.has(otherTerminal.session.id)).toBe(false);
    expect(otherTerminal.homeClient.sessions.has(canvasTerminal.session.id)).toBe(false);

    // Rooms leaving free only their channels: the rest keep streaming on the same socket.
    inCanvas.close();
    canvasTerminal.homeClient.close();
    otherTerminal.homeClient.sendTerminalInput(
      otherTerminal.session.id,
      "printf 'MX_B2_%s\\n' ok\n",
    );
    await waitForTerminalText(otherCapture, "MX_B2_ok", 15_000);
    expect(otherTerminal.homeClient.status).toBe("open");
    expect(inOther.status).toBe("open");
  } catch (error) {
    throw e2eFailure(error, [...servers, ...agents]);
  } finally {
    for (const capture of captures) capture.stop();
    closeClients(clients);
    await stopProcesses([...agents, ...servers]);
  }
}, 90_000);
