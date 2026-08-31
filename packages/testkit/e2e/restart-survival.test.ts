import { expect, test } from "bun:test";
import type { SessionClient } from "@manifold/sdk";
import {
  connect,
  createContainer,
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
  attachedCapture,
  captureTerminal,
  closeClients,
  e2eFailure,
  nextMessage,
  openTerminalAt,
  portalElement,
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
    const container = await createContainer(firstServer, "restart survival");
    const referenced = await createContainer(firstServer, "restart survival reference");
    const enrolled = await enrollMachine(firstServer, "survival-agent");
    const agent = await startAgent({
      serverUrl: firstServer.url,
      machineToken: enrolled.machineToken,
      name: "survival-agent",
    });
    agents.push(agent);
    // Workspace-scoped: the terminal is born into a composition of its own, whose id is
    // minted by the server, so a container-scoped grant could never join the room that holds it.
    const grant = await mintToken(firstServer, {
      principal: { kind: "human", name: "Restart User", color: "#5e48c7" },
      caps: ["containers:read", "scenes:write", "terminals:spawn", "terminals:write"],
    });
    const client = await connect(firstServer, { containerId: container.id, token: grant.token });
    clients.push(client);

    const firstSavedRev = client.rev + 1;
    const firstSaved = nextMessage(
      client,
      "saved",
      15_000,
      (message) => message.rev >= firstSavedRev,
    );
    client.transact((tx) => tx.create(portalElement("el-survive-scene", referenced.id)));
    await firstSaved;

    const secondSavedRev = client.rev + 1;
    const secondSaved = nextMessage(
      client,
      "saved",
      15_000,
      (message) => message.rev >= secondSavedRev,
    );
    const { terminal, homeClient } = await openTerminalAt(client, firstServer, {
      elementId: "el-survive-terminal",
      token: grant.token,
      portalAt: { x: 240, y: 160 },
    });
    clients.push(homeClient);
    await secondSaved;

    const beforeRestartScene = sortedScene(client);
    const capture = await attachedCapture(homeClient, terminal.id);
    captures.push(capture);
    homeClient.sendTerminalInput(terminal.id, "printf 'SURVIVE_1\\n'\n");
    await waitForTerminalText(capture, "SURVIVE_1", 10_000);
    const emitterTrigger = `${firstServer.dataDir}/emit-during-downtime`;
    const emitterDone = `${firstServer.dataDir}/emitter-finished`;
    const emitterCommand =
      "(armed=EMITTER_; printf '%s%s\\n' \"$armed\" ARMED; " +
      `while [ ! -f ${JSON.stringify(emitterTrigger)} ]; do sleep 0.05; done; ` +
      'i=1; while [ "$i" -le 4 ]; do printf \'DOWNTIME_%s\\n\' "$i"; ' +
      `i=$((i + 1)); sleep 0.2; done; printf done > ${JSON.stringify(emitterDone)}) &\n`;
    homeClient.sendTerminalInput(terminal.id, emitterCommand);
    await waitForTerminalText(capture, "EMITTER_ARMED", 10_000);
    const preRestartWatermark = capture.outputSeqs.at(-1) ?? capture.snapshotSeq;
    if (preRestartWatermark === null) throw new Error("terminal produced no pre-restart watermark");

    await firstServer.stop("SIGTERM");
    expect(agent.proc.exitCode).toBeNull();
    client.close();
    homeClient.close();
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
      containerId: container.id,
      token: grant.token,
      reconnect: false,
    });
    clients.push(afterRestart);
    expect(sortedScene(afterRestart)).toEqual(beforeRestartScene);
    // The terminal is state of the composition it LIVES in, so that is the room that reports
    // it — the canvas only ever held a portal onto that composition.
    const homeAfterRestart = await connect(restarted, {
      containerId: terminal.containerId,
      token: grant.token,
      reconnect: false,
    });
    clients.push(homeAfterRestart);
    const adopted = homeAfterRestart.terminals.get(terminal.id);
    expect(adopted).toBeDefined();
    expect(adopted?.status).toBe("running");
    expect(adopted?.containerId).toBe(terminal.containerId);

    const afterCapture = captureTerminal(homeAfterRestart, terminal.id);
    captures.push(afterCapture);
    homeAfterRestart.attachTerminal(terminal.id);
    await waitFor(() => afterCapture.snapshotSeq !== null, 10_000, 20);
    expect(afterCapture.snapshotSeq).toBeGreaterThanOrEqual(preRestartWatermark);
    expect(afterCapture.snapshotText).toContain("SURVIVE_1");
    expect(afterCapture.snapshotText).toContain("DOWNTIME_4");
    homeAfterRestart.sendTerminalInput(terminal.id, "printf 'SURVIVE_2\\n'\n");
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
