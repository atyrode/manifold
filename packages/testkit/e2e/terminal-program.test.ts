import { expect, test } from "bun:test";
import type { TerminalProgram } from "@manifold/protocol";
import type { SessionClient } from "@manifold/sdk";
import {
  connect,
  createContainer,
  enrollMachine,
  listTerminals,
  mintToken,
  ownerAction,
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
 * A terminal born running a program (issue #192): the opener names an argv and an env, the
 * policy door `core.terminals.open` judges both before any machine hears of the frame, and the
 * PTY's first bytes are that program's — no login shell, no prompt, nothing typed. The ledger
 * is the record of what the door authorized. The inverses are proven too: a program the door
 * refuses never reaches a machine, and a program the machine cannot exec is refused by name at
 * the agent, so the opener learns the create failed rather than watching a shell garble it.
 */

/** xterm's serializer may wrap plain text in attribute resets; the words are what we assert. */
function visibleText(capture: TerminalCapture): string {
  // eslint-disable-next-line no-control-regex -- stripping terminal control sequences on purpose
  return (capture.snapshotText + capture.outputText).replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
}

/** One `core.terminals.open` row of the ledger, as this file asserts on it. */
interface OpenTrace {
  readonly outcome: string | null;
  readonly payload: string;
}

/**
 * Every `core.terminals.open` dispatch the ledger holds, newest first, read through the door
 * an operator reads it through (`core.events.list`, root only). The rows are narrowed by hand
 * rather than by the events plugin's schema because the testkit deliberately depends on no
 * plugin package: what this file needs of a row is its door, its outcome and its payload text.
 */
async function openTraces(server: TestServer): Promise<readonly OpenTrace[]> {
  const result = await ownerAction(server, "core.events.list", { kind: "trace", limit: 100 });
  if (result === null || typeof result !== "object" || !("events" in result)) {
    throw new Error("core.events.list answered without events");
  }
  const events: unknown = result.events;
  if (!Array.isArray(events)) throw new Error("core.events.list answered a non-array");
  const rows: OpenTrace[] = [];
  for (const event of events as readonly unknown[]) {
    if (event === null || typeof event !== "object") continue;
    const door: unknown = Reflect.get(event, "door");
    const outcome: unknown = Reflect.get(event, "outcome");
    const payload: unknown = Reflect.get(event, "payload");
    if (door !== "core.terminals.open" || typeof payload !== "string") continue;
    rows.push({ outcome: typeof outcome === "string" ? outcome : null, payload });
  }
  return rows;
}

/** Reads the program the ledger recorded for one dispatch: what the door was asked to allow. */
function recordedProgram(trace: OpenTrace): TerminalProgram | undefined {
  const payload: unknown = JSON.parse(trace.payload);
  if (payload === null || typeof payload !== "object") return undefined;
  const program: unknown = Reflect.get(payload, "program");
  if (program === null || typeof program !== "object") return undefined;
  const argv: unknown = Reflect.get(program, "argv");
  if (!Array.isArray(argv) || !argv.every((item) => typeof item === "string")) return undefined;
  const [first, ...rest] = argv as string[];
  if (first === undefined) return undefined;
  return { argv: [first, ...rest] };
}

test("a program named at open is judged at the door, then runs first under the opener's env and the minted MANIFOLD_* keys", async () => {
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

    const argv: TerminalProgram["argv"] = [
      "/bin/sh",
      "-c",
      // `exec cat` holds the PTY open on stdin once the line is printed, so the terminal is
      // observed RUNNING a program rather than already exited by the time the home joins.
      'printf "CMD_%s_OK in %s\\n" "$CODE_TEST" "$MANIFOLD_CONTAINER"; exec cat',
    ];
    const { terminal, homeClient: home } = await openTerminalAt(canvas, server, {
      elementId: "el-program",
      token: grant.token,
      program: { argv },
      env: { CODE_TEST: "launch-7" },
    });
    clients.push(home);
    expect(terminal.status).toBe("running");

    // THE DOOR SAW THE PROGRAM. The policy dispatch the gateway made for this frame is in the
    // ledger with the argv the machine was then asked to exec — one value, judged before the
    // create — and without the env: `env` never reaches the ledger, keys or values.
    const [dispatch] = await openTraces(server);
    if (dispatch === undefined) throw new Error("the ledger holds no core.terminals.open row");
    expect(dispatch.outcome).toBe("ok");
    expect(recordedProgram(dispatch)).toEqual({ argv });
    expect(dispatch.payload).not.toContain('"env"');
    expect(dispatch.payload).not.toContain("launch-7");

    const capture = await attachedCapture(home, terminal.id);
    captures.push(capture);
    await waitFor(() => visibleText(capture).includes("CMD_launch-7_OK"), 10_000, 20);
    const text = visibleText(capture).trimStart();
    // The program's own line is the FIRST visible thing: no prompt, no banner preceded it.
    expect(text.startsWith("CMD_launch-7_OK")).toBe(true);
    // The opener's env arrived, and so did the minted key beside it — the home this terminal
    // lives in, which is the composition the reply named.
    expect(text).toContain(`CMD_launch-7_OK in ${terminal.containerId}`);

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

test("a program the door refuses never reaches a machine, and the refusal names it", async () => {
  const servers: TestServer[] = [];
  const agents: TestAgent[] = [];
  const clients: SessionClient[] = [];
  try {
    const server = await startServer();
    servers.push(server);
    const container = await createContainer(server, "refused program");
    const enrolled = await enrollMachine(server, "refused-program-agent");
    const agent = await startAgent({
      serverUrl: server.url,
      machineToken: enrolled.machineToken,
      name: "refused-program-agent",
    });
    agents.push(agent);
    // A reader: `containers:read` joins the room, and `terminals:spawn` is exactly what the
    // door demands and this token lacks.
    const grant = await mintToken(server, {
      principal: { kind: "agent", name: "Reader", color: "#44703a" },
      caps: ["containers:read"],
    });
    const client = await connect(server, {
      containerId: container.id,
      token: grant.token,
      reconnect: false,
    });
    clients.push(client);
    const argv: TerminalProgram["argv"] = ["/bin/sh", "-c", "printf NEVER; exec cat"];

    // The refusal is the DOOR's, in the door's words, correlated on the opener's own ref —
    // the same denial the same token would hear over `POST /api/actions/core.terminals.open`.
    await expect(
      client.openTerminal({
        elementId: "el-refused-program",
        cols: 80,
        rows: 24,
        program: { argv },
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow("terminals:spawn capability required");

    // The ledger names the program the door refused (invariant 5): a policy that says no is
    // a fact about WHAT was asked, and what was asked is recorded.
    const [dispatch] = await openTraces(server);
    if (dispatch === undefined) throw new Error("the ledger holds no core.terminals.open row");
    expect(dispatch.outcome).toBe("forbidden");
    expect(recordedProgram(dispatch)).toEqual({ argv });

    // Nothing was born and nothing was asked of the machine: no row, and the agent's log —
    // which names every PTY it creates or fails to create — is silent.
    expect(await listTerminals(server)).toEqual([]);
    expect(
      agent.output.stdout.some(
        (line) => line.includes('"evt":"created"') || line.includes('"evt":"create_error"'),
      ),
    ).toBe(false);
  } catch (error) {
    throw e2eFailure(error, [...servers, ...agents]);
  } finally {
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
