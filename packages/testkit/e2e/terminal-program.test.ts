import { expect, test } from "bun:test";
import type { SessionClient } from "@manifold/sdk";
import {
  connect,
  createContainer,
  enrollMachine,
  listTerminals,
  mintToken,
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
  nextMessage,
  openTerminalAt,
  stopProcesses,
  type TerminalCapture,
} from "./helpers.ts";

/**
 * A terminal born running a program (issue #192): the opener names an argv and an env, and
 * the PTY's first bytes are that program's — no login shell, no prompt, nothing typed. The
 * inverse is proven too: a program the machine cannot exec is refused by name at the agent,
 * and the opener learns the create failed rather than watching a shell garble it.
 */

/** xterm's serializer may wrap plain text in attribute resets; the words are what we assert. */
function visibleText(capture: TerminalCapture): string {
  // eslint-disable-next-line no-control-regex -- stripping terminal control sequences on purpose
  return (capture.snapshotText + capture.outputText).replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
}

test("a program named at open runs first, under the opener's env and the minted MANIFOLD_* keys", async () => {
  const servers: TestServer[] = [];
  const agents: TestAgent[] = [];
  const clients: SessionClient[] = [];
  const captures: TerminalCapture[] = [];
  try {
    const server = await startServer();
    servers.push(server);
    const container = await createContainer(server, "program launch");
    const enrolled = await enrollMachine(server, "program-agent");
    const agent = await startAgent({
      serverUrl: server.url,
      machineToken: enrolled.machineToken,
      name: "program-agent",
    });
    agents.push(agent);
    const grant = await mintToken(server, {
      principal: { kind: "agent", name: "Launcher", color: "#3a7d44" },
      caps: ["containers:read", "terminals:spawn", "terminals:write"],
    });
    const canvas = await connect(server, {
      containerId: container.id,
      token: grant.token,
      reconnect: false,
    });
    clients.push(canvas);

    const { terminal, homeClient: home } = await openTerminalAt(canvas, server, {
      elementId: "el-program",
      token: grant.token,
      // `exec cat` holds the PTY open on stdin once the line is printed, so the terminal is
      // observed RUNNING a program rather than already exited by the time the home joins.
      program: {
        argv: [
          "/bin/sh",
          "-c",
          'printf "CMD_%s_OK in %s\\n" "$CODE_TEST" "$MANIFOLD_CONTAINER"; exec cat',
        ],
      },
      env: { CODE_TEST: "x" },
    });
    clients.push(home);
    expect(terminal.status).toBe("running");

    const capture = await attachedCapture(home, terminal.id);
    captures.push(capture);
    await waitFor(() => visibleText(capture).includes("CMD_x_OK"), 10_000, 20);
    const text = visibleText(capture).trimStart();
    // The program's own line is the FIRST visible thing: no prompt, no banner preceded it.
    expect(text.startsWith("CMD_x_OK")).toBe(true);
    // The opener's env arrived, and so did the minted key beside it — the home this terminal
    // lives in, which is the composition the reply named.
    expect(text).toContain(`CMD_x_OK in ${terminal.containerId}`);

    // Everything else about the terminal is the ordinary lifecycle: a kill reaps it.
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
    for (const capture of captures) capture.stop();
    closeClients(clients);
    await stopProcesses([...servers, ...agents]);
  }
}, 45_000);

test("a program the machine cannot exec is a named create_error, and the opener is refused", async () => {
  const servers: TestServer[] = [];
  const agents: TestAgent[] = [];
  const clients: SessionClient[] = [];
  try {
    const server = await startServer();
    servers.push(server);
    const container = await createContainer(server, "missing program");
    const enrolled = await enrollMachine(server, "missing-program-agent");
    const agent = await startAgent({
      serverUrl: server.url,
      machineToken: enrolled.machineToken,
      name: "missing-program-agent",
    });
    agents.push(agent);
    const grant = await mintToken(server, {
      principal: { kind: "agent", name: "Launcher", color: "#7d3a44" },
      caps: ["containers:read", "terminals:spawn", "terminals:write"],
    });
    const client = await connect(server, {
      containerId: container.id,
      token: grant.token,
      reconnect: false,
    });
    clients.push(client);

    // The opener hears the create failed, correlated on its own ref. Agent diagnostics stay on
    // the machine channel and in the agent's log, which is where the program is named.
    const refused = nextMessage(
      client,
      "error",
      10_000,
      (message) =>
        message.code === "conflict" &&
        message.ref === "el-no-such-program" &&
        message.message === "terminal creation failed",
    );
    const opened = client
      .openTerminal({
        elementId: "el-no-such-program",
        cols: 80,
        rows: 24,
        program: { argv: ["/nonexistent/bin", "--flag"] },
        timeoutMs: 10_000,
      })
      .then(
        () => "opened" as const,
        () => "rejected" as const,
      );
    expect((await refused).code).toBe("conflict");
    expect(await opened).toBe("rejected");

    await waitFor(
      () =>
        agent.output.stdout.some(
          (line) =>
            line.includes('"evt":"create_error"') &&
            line.includes("program not found: /nonexistent/bin"),
        ),
      10_000,
      20,
    );
    // Nothing was born: no row, no home, no shell standing in for the program.
    expect(await listTerminals(server)).toEqual([]);
  } catch (error) {
    throw e2eFailure(error, [...servers, ...agents]);
  } finally {
    closeClients(clients);
    await stopProcesses([...servers, ...agents]);
  }
}, 45_000);
