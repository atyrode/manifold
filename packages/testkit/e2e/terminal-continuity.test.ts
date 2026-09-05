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
  openTerminalAt,
  stopProcesses,
  waitForTerminalText,
  type TerminalCapture,
} from "./helpers.ts";

/**
 * Issue #278: hub availability is not terminal continuity. A machine's transport is the
 * replaceable half; the shells live with the terminal host. This is the incident of
 * 2026-09-05 replayed against the split — a transport killed hard mid-output, then a
 * successor with the same token — and the contract it must now hold: same terminal id, same
 * shell PROCESS, every byte produced while no transport existed rendered in the successor's
 * snapshot, and live I/O afterwards through the same no-gap attach handoff.
 */
test("a workload survives a transport crash and replacement with the same process and no lost output", async () => {
  const servers: TestServer[] = [];
  const agents: TestAgent[] = [];
  const clients: SessionClient[] = [];
  const captures: TerminalCapture[] = [];
  try {
    const server = await startServer();
    servers.push(server);
    const container = await createContainer(server, "transport continuity");
    const enrolled = await enrollMachine(server, "continuity-agent");
    const agent = await startAgent({
      serverUrl: server.url,
      machineToken: enrolled.machineToken,
      name: "continuity-agent",
    });
    agents.push(agent);
    const grant = await mintToken(server, {
      principal: { kind: "human", name: "Continuity User", color: "#5e48c7" },
      caps: ["containers:read", "scenes:write", "terminals:spawn", "terminals:write"],
    });
    const client = await connect(server, { containerId: container.id, token: grant.token });
    clients.push(client);
    const { terminal, homeClient } = await openTerminalAt(client, server, {
      elementId: "el-continuity-terminal",
      token: grant.token,
    });
    clients.push(homeClient);

    const capture = await attachedCapture(homeClient, terminal.id);
    captures.push(capture);
    homeClient.sendTerminalInput(terminal.id, "printf 'SHELL_PID_%s_END\\n' \"$$\"\n");
    await waitForTerminalText(capture, "_END", 10_000);
    const pidBefore = /SHELL_PID_(\d+)_END/.exec(capture.snapshotText + capture.outputText)?.[1];
    expect(pidBefore).toBeDefined();

    // A background emitter prints only after the transport is gone, so its bytes reach the
    // host with NO transport attached — the case the ring and mirror exist for.
    const emitterTrigger = `${server.dataDir}/emit-during-transport-outage`;
    const emitterDone = `${server.dataDir}/emitter-finished`;
    const emitterCommand =
      "(printf 'EMITTER_ARMED\\n'; " +
      `while [ ! -f ${JSON.stringify(emitterTrigger)} ]; do sleep 0.05; done; ` +
      'i=1; while [ "$i" -le 4 ]; do printf \'OUTAGE_%s\\n\' "$i"; ' +
      `i=$((i + 1)); sleep 0.1; done; printf done > ${JSON.stringify(emitterDone)}) &\n`;
    homeClient.sendTerminalInput(terminal.id, emitterCommand);
    await waitForTerminalText(capture, "EMITTER_ARMED", 10_000);
    const preCrashWatermark = capture.outputSeqs.at(-1) ?? capture.snapshotSeq;
    if (preCrashWatermark === null) throw new Error("terminal produced no pre-crash watermark");

    // SIGKILL: no shutdown path runs in the transport. The host is untouched by definition.
    const hostPid = agent.host.pid;
    agent.proc.kill("SIGKILL");
    await agent.proc.exited;
    await Bun.write(emitterTrigger, "emit");
    await waitFor(() => Bun.file(emitterDone).exists(), 5_000, 20);
    await agent.restartTransport();
    expect(agent.host.pid).toBe(hostPid);
    expect(agent.host.exitCode).toBeNull();
    await waitFor(async () => isMachineOnline(server, enrolled.machineId), 20_000, 100);

    // The successor advertised the SAME terminal, and the hub kept it running — never exited.
    const homeAfter = await connect(server, {
      containerId: terminal.containerId,
      token: grant.token,
      reconnect: false,
    });
    clients.push(homeAfter);
    const adopted = homeAfter.terminals.get(terminal.id);
    expect(adopted?.status).toBe("running");

    const afterCapture = captureTerminal(homeAfter, terminal.id);
    captures.push(afterCapture);
    homeAfter.attachTerminal(terminal.id);
    await waitFor(() => afterCapture.snapshotSeq !== null, 10_000, 20);
    // The no-gap invariant across the seam: the snapshot's watermark covers everything the
    // old transport streamed AND everything emitted while none existed.
    expect(afterCapture.snapshotSeq).toBeGreaterThanOrEqual(preCrashWatermark);
    expect(afterCapture.snapshotText).toContain(`SHELL_PID_${pidBefore}_END`);
    expect(afterCapture.snapshotText).toContain("OUTAGE_4");

    homeAfter.sendTerminalInput(terminal.id, "printf 'AGAIN_%s_END\\n' \"$$\"\n");
    await waitForTerminalText(afterCapture, `AGAIN_${pidBefore}_END`, 10_000);
    expect(afterCapture.outputSeqs.every((seq) => seq > (afterCapture.snapshotSeq ?? 0))).toBe(
      true,
    );
  } catch (error) {
    throw e2eFailure(error, [...servers, ...agents]);
  } finally {
    for (const capture of captures) capture.stop();
    closeClients(clients);
    await stopProcesses([...servers, ...agents]);
  }
}, 60_000);

test("a transport stopped by SIGTERM ends no terminal; a stopped host does", async () => {
  const servers: TestServer[] = [];
  const agents: TestAgent[] = [];
  const clients: SessionClient[] = [];
  try {
    const server = await startServer();
    servers.push(server);
    const container = await createContainer(server, "transport lifetimes");
    const enrolled = await enrollMachine(server, "lifetimes-agent");
    const agent = await startAgent({
      serverUrl: server.url,
      machineToken: enrolled.machineToken,
      name: "lifetimes-agent",
    });
    agents.push(agent);
    const grant = await mintToken(server, {
      principal: { kind: "human", name: "Lifetimes User", color: "#5e48c7" },
      caps: ["containers:read", "scenes:write", "terminals:spawn", "terminals:write"],
    });
    const client = await connect(server, { containerId: container.id, token: grant.token });
    clients.push(client);
    const { terminal, homeClient } = await openTerminalAt(client, server, {
      elementId: "el-lifetimes-terminal",
      token: grant.token,
    });
    clients.push(homeClient);

    // The routine activation path: SIGTERM the transport, replace it. Nothing exits.
    await agent.restartTransport("SIGTERM");
    await waitFor(async () => isMachineOnline(server, enrolled.machineId), 20_000, 100);
    expect(homeClient.terminals.get(terminal.id)?.status).toBe("running");
    expect(
      agent.output.stdout.some(
        (line) =>
          line.includes('"evt":"exited"') &&
          line.includes(`"terminalId":${JSON.stringify(terminal.id)}`),
      ),
    ).toBe(false);

    // The DELIBERATE destructive stop is the host's, and only the host's: its SIGTERM kills
    // the shell with grace, the transport reports the exit, and the hub records it.
    agent.host.kill("SIGTERM");
    await agent.host.exited;
    await waitFor(() => homeClient.terminals.get(terminal.id)?.status === "exited", 15_000, 50);
  } catch (error) {
    throw e2eFailure(error, [...servers, ...agents]);
  } finally {
    closeClients(clients);
    await stopProcesses([...servers, ...agents]);
  }
}, 60_000);

test("drain accounts for racing births and stays closed across transport replacement until cancelled", async () => {
  const servers: TestServer[] = [];
  const agents: TestAgent[] = [];
  const clients: SessionClient[] = [];
  try {
    const server = await startServer();
    servers.push(server);
    const container = await createContainer(server, "drain race");
    const enrolled = await enrollMachine(server, "drain-agent");
    const agent = await startAgent({
      serverUrl: server.url,
      machineToken: enrolled.machineToken,
      name: "drain-agent",
    });
    agents.push(agent);
    const grant = await mintToken(server, {
      principal: { kind: "human", name: "Maintenance User", color: "#5e48c7" },
      caps: [
        "containers:read",
        "scenes:write",
        "terminals:spawn",
        "terminals:write",
        "machines:mint",
      ],
    });
    const client = await connect(server, { containerId: container.id, token: grant.token });
    clients.push(client);
    const { terminal, homeClient } = await openTerminalAt(client, server, {
      elementId: "before-drain",
      token: grant.token,
    });
    clients.push(homeClient);
    const refusals = new Map<string, string>();
    client.on("error", (message) => {
      if (message.ref !== undefined) refusals.set(message.ref, message.code);
    });
    const open = (elementId: string) =>
      client.openTerminal({ elementId, machineId: enrolled.machineId, cols: 80, rows: 24 });

    // The HTTP action and WS births race at the real hub, then cross the real local socket.
    // Either ordering is legal, but every successful birth must be in the owner's answer.
    const attemptIds = Array.from({ length: 8 }, (_, index) => `racing-birth-${index}`);
    const pending = Promise.allSettled(attemptIds.map(open));
    const drained = await client.drainMachine(enrolled.machineId, true);
    if (!drained.ok) throw new Error(`drain refused: ${drained.denial.message}`);
    const results = await pending;
    const expectedIds = [terminal.id];
    for (const [index, result] of results.entries()) {
      if (result.status === "fulfilled") expectedIds.push(result.value.id);
      else expect(refusals.get(attemptIds[index]!)).toBe("conflict");
    }
    expect(drained.result.draining).toBe(true);
    expect([...drained.result.terminalIds].sort()).toEqual(expectedIds.sort());
    expect(homeClient.terminals.get(terminal.id)?.status).toBe("running");

    const afterDrain = await Promise.allSettled([open("after-drain")]);
    expect(afterDrain[0]?.status).toBe("rejected");
    expect(refusals.get("after-drain")).toBe("conflict");
    await agent.restartTransport();
    await waitFor(async () => isMachineOnline(server, enrolled.machineId), 20_000, 100);
    const afterRestart = await Promise.allSettled([open("after-restart")]);
    expect(afterRestart[0]?.status).toBe("rejected");
    expect(refusals.get("after-restart")).toBe("conflict");

    const cancelled = await client.drainMachine(enrolled.machineId, false);
    if (!cancelled.ok) throw new Error(`cancel refused: ${cancelled.denial.message}`);
    expect(cancelled.result.terminalHostId).toBe(drained.result.terminalHostId);
    expect([...cancelled.result.terminalIds].sort()).toEqual(expectedIds);
    const reopened = await open("after-cancel");
    expect(reopened.status).toBe("running");
    expect(homeClient.terminals.get(terminal.id)?.status).toBe("running");
  } catch (error) {
    throw e2eFailure(error, [...servers, ...agents]);
  } finally {
    closeClients(clients);
    await stopProcesses([...servers, ...agents]);
  }
}, 60_000);
