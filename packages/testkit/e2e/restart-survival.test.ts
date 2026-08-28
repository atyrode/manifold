import { expect, test } from "bun:test";
import type { SessionClient } from "@manifold/sdk";
import {
  connect,
  createPad,
  enrollMachine,
  isMachineOnline,
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
  sortedScene,
  stopProcesses,
  waitForTerminalText,
  type TerminalCapture,
} from "./helpers.ts";

test("standalone agent and PTY survive a fixed-port server restart and are adopted", async () => {
  const servers: TestServer[] = [];
  const agents: TestAgent[] = [];
  const clients: SessionClient[] = [];
  const captures: TerminalCapture[] = [];
  try {
    const firstServer = await startServer();
    servers.push(firstServer);
    const pad = await createPad(firstServer, "restart survival");
    const enrolled = await enrollMachine(firstServer, "survival-agent");
    const agent = await startAgent({
      serverUrl: firstServer.url,
      machineToken: enrolled.machineToken,
      name: "survival-agent",
    });
    agents.push(agent);
    const grant = await mintToken(firstServer, {
      principal: { kind: "human", name: "Restart User", color: "#5e48c7" },
      caps: ["pads:read", "scene:write", "terminal:spawn", "terminal:write"],
      padId: pad.id,
    });
    const client = await connect(firstServer, { padId: pad.id, token: grant.token });
    clients.push(client);

    const firstSavedRev = client.rev + 1;
    const firstSaved = nextMessage(
      client,
      "saved",
      15_000,
      (message) => message.rev >= firstSavedRev,
    );
    expect(client.updateScene([sceneElement("el-survive-scene")])).not.toBeNull();
    await firstSaved;

    const session = await client.openTerminal({
      elementId: "el-survive-terminal",
      cols: 80,
      rows: 24,
    });
    const secondSavedRev = client.rev + 1;
    const secondSaved = nextMessage(
      client,
      "saved",
      15_000,
      (message) => message.rev >= secondSavedRev,
    );
    expect(
      client.updateScene([
        {
          ...sceneElement("el-survive-terminal"),
          sessionId: session.id,
        },
      ]),
    ).not.toBeNull();
    await secondSaved;

    const beforeRestartScene = sortedScene(client);
    const capture = captureTerminal(client, session.id);
    captures.push(capture);
    client.attachTerminal(session.id);
    await waitFor(() => capture.snapshotSeq, 10_000, 20);
    client.sendTerminalInput(session.id, "printf 'SURVIVE_1\\n'\n");
    await waitForTerminalText(capture, "SURVIVE_1", 10_000);
    const emitterTrigger = `${firstServer.dataDir}/emit-during-downtime`;
    const emitterDone = `${firstServer.dataDir}/emitter-finished`;
    const emitterCommand =
      "(armed=EMITTER_; printf '%s%s\\n' \"$armed\" ARMED; " +
      `while [ ! -f ${JSON.stringify(emitterTrigger)} ]; do sleep 0.05; done; ` +
      'i=1; while [ "$i" -le 4 ]; do printf \'DOWNTIME_%s\\n\' "$i"; ' +
      `i=$((i + 1)); sleep 0.2; done; printf done > ${JSON.stringify(emitterDone)}) &\n`;
    client.sendTerminalInput(session.id, emitterCommand);
    await waitForTerminalText(capture, "EMITTER_ARMED", 10_000);
    const preRestartWatermark = capture.outputSeqs.at(-1) ?? capture.snapshotSeq;
    if (preRestartWatermark === null) throw new Error("terminal produced no pre-restart watermark");

    await firstServer.stop("SIGTERM");
    expect(agent.proc.exitCode).toBeNull();
    client.close();
    await Bun.write(emitterTrigger, "emit");
    await waitFor(() => Bun.file(emitterDone).exists(), 3_000, 20);

    const restarted = await startServer({
      dataDir: firstServer.dataDir,
      port: firstServer.port,
      ownerKey: firstServer.ownerKey,
    });
    servers.push(restarted);
    await waitFor(async () => isMachineOnline(restarted, enrolled.machineId), 20_000, 100);

    const afterRestart = await connect(restarted, {
      padId: pad.id,
      token: grant.token,
      reconnect: false,
    });
    clients.push(afterRestart);
    expect(sortedScene(afterRestart)).toEqual(beforeRestartScene);
    const adopted = afterRestart.sessions.get(session.id);
    expect(adopted).toBeDefined();
    expect(adopted?.status).toBe("running");

    const afterCapture = captureTerminal(afterRestart, session.id);
    captures.push(afterCapture);
    afterRestart.attachTerminal(session.id);
    await waitFor(() => afterCapture.snapshotSeq !== null, 10_000, 20);
    expect(afterCapture.snapshotSeq).toBeGreaterThanOrEqual(preRestartWatermark);
    expect(afterCapture.snapshotText).toContain("SURVIVE_1");
    expect(afterCapture.snapshotText).toContain("DOWNTIME_4");
    afterRestart.sendTerminalInput(session.id, "printf 'SURVIVE_2\\n'\n");
    await waitForTerminalText(afterCapture, "SURVIVE_2", 10_000);
    expect(afterCapture.snapshotText + afterCapture.outputText).toContain("SURVIVE_2");
  } catch (error) {
    throw e2eFailure(error, [...servers, ...agents]);
  } finally {
    for (const capture of captures) capture.stop();
    closeClients(clients);
    await stopProcesses([...servers, ...agents]);
  }
}, 60_000);
